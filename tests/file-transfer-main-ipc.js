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
class FakeDirectFileHost {
  constructor(port) { this.port = port; }
  async listen() {}
  close() {}
  register() {}
}

const context = vm.createContext({
  ArrayBuffer,
  Buffer,
  DirectFileHost: FakeDirectFileHost,
  MAX_FILE_SIZE: 200 * 1024 ** 3,
  MAX_IPC_CHUNK: 8 * 1024 * 1024,
  PAIR_RENDERER_URL: mainFrame.url,
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
  console.log('file-transfer main IPC lifecycle tests passed');
})().catch(error => { console.error(error);process.exitCode = 1; });
