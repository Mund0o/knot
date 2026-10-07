const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = mainSource.indexOf('const WRITE_HIGH_WATER =');
const end = mainSource.indexOf('// --- Settings persistence', start);
assert(start >= 0 && end > start, 'could not locate main file-transfer IPC section');
const source = mainSource.slice(start, end);

const handlers = new Map();
const listeners = new Map();
const ipcMain = {
  handle(channel, handler) { handlers.set(channel, handler); },
  on(channel, handler) { listeners.set(channel, handler); },
};
const mainFrame = { url: 'file:///app/index.html' };
const webContents = {
  id: 7,
  mainFrame,
  isDestroyed: () => false,
  send() {},
};
const mainWin = { isDestroyed: () => false, webContents };
const event = { sender: webContents, senderFrame: mainFrame };

let manager;
let openImpl = async () => true;
let closeAllImpl = async () => {};
class FakeSaveStreamManager {
  constructor() { manager = this;this.streams = new Map();this.cancelled = [];this.opened = []; }
  get size() { return this.streams.size; }
  has(id) { return this.streams.has(id); }
  async open(id, target, options) {
    this.streams.set(id, { id, target, options });this.opened.push(id);
    try { return await openImpl(id, target, options); }
    catch (error) { this.streams.delete(id);throw error; }
  }
  async write() { return true; }
  async finish(id) { this.streams.delete(id);return true; }
  async cancel(id) { this.cancelled.push(id);this.streams.delete(id);return true; }
  async closeAll() { return closeAllImpl(); }
}

let dialogImpl = async () => ({ canceled: false, filePath: '/tmp/incoming.bin' });
let connectImpl = async () => { throw new Error('not configured'); };
const directHosts = [];
class FakeDirectFileHost {
  constructor(port) { this.port = port;this.registered = [];this.accepted = [];directHosts.push(this); }
  async listen() {}
  close() { this.closedHost = true; }
  register(token, key, onPeer) { this.registered.push({ token, key: Buffer.from(key), onPeer }); }
  acceptStream(socket) { this.accepted.push(socket); }
}
// A lane manager that never touches a socket: it hands out ids and records what was asked of it.
class FakeUdxLanes {
  constructor() { this.lanes = new Map();this.counter = 0;this.closed = [];this.released = [];this.requests = [];this.establishImpl = async () => ({ destroy() { this.destroyed = true; } }); }
  async open() { const id = (++this.counter).toString(16).padStart(24, '0');this.lanes.set(id, true);return { id, streamId: 100 + this.counter, endpoints: [{ ip: '198.51.100.7', port: 40001, kind: 'srflx' }] }; }
  establish(id, options) { this.requests.push({ id, options });return this.establishImpl(id, options); }
  release(id) { this.released.push(id);return true; }
  close(id) { this.closed.push(id);return this.lanes.delete(id); }
  closeAll() { for (const id of [...this.lanes.keys()]) this.close(id); }
}

const context = vm.createContext({
  ArrayBuffer,
  Buffer,
  DirectFileHost: FakeDirectFileHost,
  MAX_FILE_SIZE: 200 * 1024 ** 3,
  MAX_IPC_CHUNK: 8 * 1024 * 1024,
  PAIR_RENDERER_URL: mainFrame.url,
  UdxLanes: FakeUdxLanes,
  SaveStreamManager: FakeSaveStreamManager,
  Uint8Array,
  connectDirectFile: (...args) => connectImpl(...args),
  crypto: require('crypto'),
  dialog: { showSaveDialog: (...args) => dialogImpl(...args) },
  ipcMain,
  isPairRenderer: value => value.sender === webContents && value.senderFrame === mainFrame && mainFrame.url === 'file:///app/index.html',
  mainWin,
  nativeScreenService: { stopAsync: async () => {} },
  nodeNet: require('net'),
  safeSuggestedFileName: value => String(value),
  stopLinuxShareAudio: async () => {},
  stopNativeCapture: () => {},
  validIpcBinary: (value, maxBytes = 8 * 1024 * 1024) => {
    const validType = Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
    return validType && Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= maxBytes;
  },
  validBridgeDocumentId: value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : '',
});
vm.runInContext(source, context, { filename: 'main-file-transfer-ipc.js' });

const documentOne = '11'.repeat(16);
const documentTwo = '22'.repeat(16);
const documentThree = '33'.repeat(16);
const documentFour = '44'.repeat(16);
const ready = documentId => listeners.get('pair:bridgeReady')(event, documentId);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes;reject = no; });
  return { promise, resolve, reject };
}

(async () => {
  ready(documentOne);

  // A reload while the native Save dialog is open must invalidate the old
  // document before it can reserve or open a destination.
  const dialog = deferred();
  dialogImpl = () => dialog.promise;
  const beforeOpen = handlers.get('pair:saveStart')(event, documentOne, 1, 'one.bin', 3);
  await Promise.resolve();
  ready(documentTwo);
  dialog.resolve({ canceled: false, filePath: '/tmp/one.bin' });
  assert.strictEqual((await beforeOpen).ok, false);
  assert.deepStrictEqual(manager.opened, [], 'stale Save dialog result opened a destination');

  // Second-guess the other side of the race too: if ownership changes while
  // open() is yielding, the completed open is cancelled before an owner record
  // can make it writable.
  const opening = deferred();
  dialogImpl = async () => ({ canceled: false, filePath: '/tmp/two.bin' });
  openImpl = () => opening.promise;
  closeAllImpl = async () => {}; // simulate cleanup taking/missing this exact interleaving
  const duringOpen = handlers.get('pair:saveStart')(event, documentTwo, 2, 'two.bin', 3);
  while (!manager.opened.includes(2)) await Promise.resolve();
  ready(documentThree);
  opening.resolve(true);
  assert.strictEqual((await duringOpen).ok, false);
  assert(manager.cancelled.includes(2), 'stale destination was not cancelled after open');

  // Outbound TCP authentication can outlive a reload. Even when the frame URL
  // is identical, its old document generation and native-runtime epoch must
  // prevent the late socket from being attached to the new renderer.
  const connecting = deferred();
  const peer = { closed: false, close() { this.closed = true; } };
  connectImpl = () => connecting.promise;
  const token = 'a'.repeat(48);
  const connect = handlers.get('pair:directFileConnect')(event, documentThree, '127.0.0.1', 8787, token, Buffer.alloc(32, 1), { timeout: 2000 });
  await Promise.resolve();
  ready(documentFour);
  connecting.resolve(peer);
  await assert.rejects(connect, /document changed/);
  assert.strictEqual(peer.closed, true, 'late stale TCP peer was left open');

  assert.strictEqual((await handlers.get('pair:directFileReset')(event, documentThree)), false, 'dead preload retained reset authority');

  // Preserve the exact byteOffset/byteLength of DataView IPC frames. Node's
  // Buffer.from(DataView) otherwise produces an empty buffer even though the
  // renderer supplied a valid non-empty frame.
  const openEvents = [];
  webContents.send = (...args) => openEvents.push(args);
  let sentBytes = null;
  const livePeer = {
    closed: false,
    close() { this.closed = true; },
    async sendAsync(value) { sentBytes = Buffer.from(value); },
  };
  connectImpl = async () => livePeer;
  const liveId = await handlers.get('pair:directFileConnect')(event, documentFour, '127.0.0.1', 8787, 'b'.repeat(48), Buffer.alloc(32, 2), { timeout: 2000 });
  assert(openEvents.some(args => args[0] === 'pair:directFileOpen' && args[2] === liveId), 'attached peer ID was not announced');
  const backing = Uint8Array.from([99, 1, 2, 88]);
  await handlers.get('pair:directFileSend')(event, documentFour, liveId, new DataView(backing.buffer, 1, 2));
  assert.deepStrictEqual([...sentBytes], [1, 2], 'DataView byte range was emptied or widened in main IPC');
  listeners.get('pair:directFileClose')(event, documentFour, liveId);
  assert.strictEqual(livePeer.closed, true, 'owned direct peer did not close');

  // If the initial opaque peer-ID event cannot reach the renderer, attaching
  // the peer is useless and must not leave a hidden native socket in the map.
  const undeliverablePeer = { closed: false, close() { this.closed = true; } };
  connectImpl = async () => undeliverablePeer;
  webContents.send = () => { throw new Error('renderer IPC is closed'); };
  await assert.rejects(
    handlers.get('pair:directFileConnect')(event, documentFour, '127.0.0.1', 8787, 'c'.repeat(48), Buffer.alloc(32, 3), { timeout: 2000 }),
    /renderer IPC is closed/
  );
  assert.strictEqual(undeliverablePeer.closed, true, 'failed peer-open delivery leaked a native socket');

  // The UDP lane bridge: a lane belongs to the document that opened it, the roles do what they say,
  // and a lane that fails to connect is released rather than left holding a socket.
  {
    const documentFive = '55'.repeat(16), documentSix = '66'.repeat(16);
    ready(documentFive);
    const lanes = vm.runInContext('udxLanes', context);
    const events = [];webContents.send = (...args) => events.push(args);
    const refused = await handlers.get('pair:udxOpen')(event, documentOne);
    assert(refused.ok === false && refused.error === 'unauthorized', 'a stale document opened a UDP lane');
    const opened = await handlers.get('pair:udxOpen')(event, documentFive);
    assert(opened.ok && /^[a-f0-9]{24}$/.test(opened.id) && Number.isInteger(opened.streamId) && opened.endpoints.length === 1, 'opening a UDP lane returned the wrong shape');

    const tokenUdx = 'e'.repeat(48);
    assert.strictEqual(await handlers.get('pair:udxRegister')(event, documentFive, 'bad', Buffer.alloc(32, 4)), false, 'a malformed token was registered');
    assert.strictEqual(await handlers.get('pair:udxRegister')(event, documentFive, tokenUdx, Buffer.alloc(8, 4)), false, 'a short key was registered');
    assert.strictEqual(await handlers.get('pair:udxRegister')(event, documentOne, tokenUdx, Buffer.alloc(32, 4)), false, 'a stale document registered a token');
    assert.strictEqual(await handlers.get('pair:udxRegister')(event, documentFive, tokenUdx, Buffer.alloc(32, 4)), true);
    const udxHost = directHosts.at(-1);
    assert.strictEqual(udxHost.port, 0, 'the UDP lane host must never listen on a port');
    assert.strictEqual(udxHost.registered.length, 1);

    // another document cannot use this document's lane
    await assert.rejects(handlers.get('pair:udxEstablish')(event, documentOne, opened.id, 'accept', tokenUdx, null, { streamId: 5, endpoints: [{ ip: '203.0.113.9', port: 41000 }] }), /invalid UDP lane request/);
    assert.strictEqual(await handlers.get('pair:udxRelease')(event, documentOne, opened.id), false, 'a stale document released a lane');
    listeners.get('pair:udxClose')(event, documentOne, opened.id);
    assert(!lanes.closed.includes(opened.id), 'a stale document closed a lane');
    await assert.rejects(handlers.get('pair:udxEstablish')(event, documentFive, opened.id, 'sideways', tokenUdx, null, { streamId: 5, endpoints: [] }), /invalid UDP lane request/);
    await assert.rejects(handlers.get('pair:udxEstablish')(event, documentFive, opened.id, 'connect', tokenUdx, Buffer.alloc(8), { streamId: 5, endpoints: [] }), /invalid direct-file credentials/);

    // accepting side: the punched stream goes to the host, the peer arrives later through the registered token
    const acceptedSocket = { destroyed: false, destroy() { this.destroyed = true; } };
    lanes.establishImpl = async () => acceptedSocket;
    assert.strictEqual(await handlers.get('pair:udxEstablish')(event, documentFive, opened.id, 'accept', tokenUdx, null, { streamId: 5, endpoints: new Array(40).fill({ ip: '203.0.113.9', port: 41000 }) }, 5000, 30000), true);
    assert.strictEqual(udxHost.accepted[0], acceptedSocket, 'the accepted stream did not reach the authenticating host');
    const asked = lanes.requests.at(-1);
    assert(asked.options.remote.endpoints.length <= 16 && asked.options.holdMs === 30000 && asked.options.timeoutMs === 5000 && asked.options.token === tokenUdx, 'the establish request was not bounded and forwarded');
    const arrivedPeer = { closed: false, close() { this.closed = true; } };
    udxHost.registered[0].onPeer(arrivedPeer, { token: tokenUdx });
    assert(events.some(args => args[0] === 'pair:directFileOpen' && args[3] === tokenUdx), 'an authenticated UDP peer was not announced to the renderer');

    // connecting side: the same handshake as every direct lane, over the punched stream
    const second = await handlers.get('pair:udxOpen')(event, documentFive);
    const connectedSocket = { destroy() {} }, clientPeer = { closed: false, close() { this.closed = true; } };
    let handshake = null;
    lanes.establishImpl = async () => connectedSocket;
    connectImpl = async (host, port, token, key, options) => { handshake = { host, port, token, key: Buffer.from(key), socket: options.socket };return clientPeer; };
    const peerId = await handlers.get('pair:udxEstablish')(event, documentFive, second.id, 'connect', 'f'.repeat(48), Buffer.alloc(32, 6), { streamId: 9, endpoints: [{ ip: '203.0.113.10', port: 41001 }] }, 4000, 0);
    assert(/^[a-f0-9]{32}$/.test(peerId), 'connect did not return an opaque peer id');
    assert(handshake.socket === connectedSocket && handshake.host === null && handshake.token === 'f'.repeat(48), 'the handshake did not run over the punched stream');
    assert(events.some(args => args[0] === 'pair:directFileOpen' && args[2] === peerId), 'the connected peer was not announced');
    assert.strictEqual(lanes.requests.at(-1).options.holdMs, 0, 'a zero hold was lost');

    // a lane that fails to connect is released and the failure reaches the caller
    const third = await handlers.get('pair:udxOpen')(event, documentFive);
    lanes.establishImpl = async () => { throw new Error('UDP hole punching timed out'); };
    await assert.rejects(handlers.get('pair:udxEstablish')(event, documentFive, third.id, 'accept', 'a1'.repeat(24), null, { streamId: 5, endpoints: [{ ip: '203.0.113.9', port: 41000 }] }), /timed out/);
    assert(lanes.closed.includes(third.id), 'a lane that failed to connect was left open');
    // a connect that cannot authenticate closes the lane too
    const fourth = await handlers.get('pair:udxOpen')(event, documentFive);
    lanes.establishImpl = async () => ({ destroy() {} });
    connectImpl = async () => { throw new Error('direct-file authentication failed'); };
    await assert.rejects(handlers.get('pair:udxEstablish')(event, documentFive, fourth.id, 'connect', 'b2'.repeat(24), Buffer.alloc(32, 7), { streamId: 5, endpoints: [{ ip: '203.0.113.9', port: 41000 }] }), /authentication failed/);
    assert(lanes.closed.includes(fourth.id), 'a lane that failed to authenticate was left open');

    // release and close are for the owner
    const fifth = await handlers.get('pair:udxOpen')(event, documentFive);
    assert.strictEqual(await handlers.get('pair:udxRelease')(event, documentFive, fifth.id), true);
    assert(lanes.released.includes(fifth.id));
    listeners.get('pair:udxClose')(event, documentFive, fifth.id);
    assert(lanes.closed.includes(fifth.id), 'the owner could not close its lane');

    // resetting the file runtime closes every lane and the token host
    const sixth = await handlers.get('pair:udxOpen')(event, documentFive);
    assert.strictEqual(await handlers.get('pair:directFileReset')(event, documentFive), true);
    assert(lanes.closed.includes(sixth.id) && udxHost.closedHost === true, 'resetting the runtime left a UDP lane or its host open');
    // documents that never opened a lane cannot see another document's lanes
    ready(documentSix);
    const stranger = await handlers.get('pair:udxOpen')(event, documentSix);
    assert(stranger.ok, 'a new document could not open its own lane');
    webContents.send = () => {};
  }
  console.log('file-transfer main IPC lifecycle tests passed');
})().catch(error => { console.error(error);process.exitCode = 1; });
