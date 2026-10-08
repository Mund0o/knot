'use strict';

// The screen-share bridge between the page and the main process: what the preload lets through, and what main does with it.
//   * preload.js is run in a sandbox like the real one, and malformed requests must stop there, before any IPC;
//   * main.js's share section is cut out and run twice (a sharer's main process and a viewer's), with the real UDP lane runtime
//     between them over loopback, so a record really crosses: page -> IPC -> lane -> lane -> IPC -> page.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { ShareLaneRuntime } = require('../share-lane-runtime');

const root = path.join(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rejects = async (promise, pattern) => { let error = null; try { await promise; } catch (value) { error = value; } assert(error, 'expected a rejection'); assert(pattern.test(String(error.message || error)), 'unexpected rejection: ' + (error.message || error)); };

// ------------------------------------------------------------------------------------------------------------------ preload
function loadPreload() {
  const exposed = {}, sent = [], invoked = [], events = new EventEmitter(), documentId = 'ab'.repeat(16);
  const ipcRenderer = {
    send: (channel, ...args) => sent.push([channel, ...args]),
    invoke: (channel, ...args) => { invoked.push([channel, ...args]); return Promise.resolve({ ok: true }); },
    on: (channel, listener) => events.on(channel, listener), removeListener: (channel, listener) => events.removeListener(channel, listener),
  };
  const context = vm.createContext({
    ArrayBuffer, Buffer, Number, Promise, Uint8Array, console, process: { env: { KNOT_APP_VERSION: 'test' }, platform: 'linux' },
    crypto: { getRandomValues(value) { value.set(Buffer.from(documentId, 'hex').subarray(0, value.byteLength)); return value; } },
    require(id) { if (id === 'electron') return { contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } }, ipcRenderer }; throw new Error('unexpected preload dependency: ' + id); },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), context, { filename: 'preload.js' });
  return { exposed, sent, invoked, events, documentId };
}

async function preloadChecks() {
  const { exposed, sent, invoked, events, documentId } = loadPreload();
  const lane = exposed.pairShareLane, capture = exposed.pairShareCapture;
  assert(lane && capture, 'the share bridges were not exposed');
  for (const name of ['open', 'register', 'establish', 'release', 'close', 'closePeer', 'send', 'credit', 'onOpen', 'onFrame', 'onClose']) assert.strictEqual(typeof lane[name], 'function', 'pairShareLane.' + name);
  for (const name of ['info', 'start', 'stop', 'onConfig', 'onFrame', 'onError', 'onEnd']) assert.strictEqual(typeof capture[name], 'function', 'pairShareCapture.' + name);
  sent.length = 0;

  // What must never reach IPC.
  const laneId = 'a'.repeat(24), peerId = 'b'.repeat(24), token = 'T'.repeat(48);
  assert.strictEqual(await lane.register('short', new Uint8Array(32)), false);
  assert.strictEqual(await lane.register(token, new Uint8Array(31)), false);
  assert.strictEqual(await lane.release('nope'), false);
  assert.strictEqual(lane.close('nope'), false);
  assert.strictEqual(lane.closePeer(laneId + 'x'), false);
  assert.strictEqual(lane.credit(peerId, 0), false);
  assert.strictEqual(lane.credit(peerId, 8 * 1024 * 1024 + 1), false);
  assert.strictEqual(lane.credit('x', 5), false);
  await rejects(lane.send('x', new Uint8Array(4)), /Invalid share frame/);
  await rejects(lane.send(peerId, new Uint8Array(0)), /Invalid share frame/);
  await rejects(lane.send(peerId, new Uint8Array(8 * 1024 * 1024 + 1)), /Invalid share frame/);
  await rejects(lane.send(peerId, 'text'), /Invalid share frame/);
  const remote = { streamId: 5, endpoints: [{ ip: '198.51.100.7', port: 40001, kind: 'srflx' }] };
  await rejects(lane.establish({ id: 'bad', role: 'accept', token, remote }), /Invalid share lane request/);
  await rejects(lane.establish({ id: laneId, role: 'sideways', token, remote }), /Invalid share lane request/);
  await rejects(lane.establish({ id: laneId, role: 'connect', token, remote }), /Invalid share lane request/);                         // connect needs a key
  await rejects(lane.establish({ id: laneId, role: 'accept', token, remote: { streamId: 5, endpoints: [{ ip: '10.0.0.1', port: 80 }] } }), /Invalid share lane request/);  // privileged port
  await rejects(lane.establish({ id: laneId, role: 'accept', token, remote: { streamId: 5, endpoints: [{ ip: 'example.com', port: 4000 }] } }), /Invalid share lane request/);
  assert.strictEqual(invoked.length, 0, 'an invalid request crossed the bridge: ' + JSON.stringify(invoked));
  assert.strictEqual(sent.length, 0);

  // What must reach IPC, carrying this document's id.
  await lane.open(); assert.deepStrictEqual(invoked.shift(), ['pair:shareLaneOpen', documentId]);
  await lane.send(peerId, new Uint8Array(10)); assert.deepStrictEqual(invoked.shift().slice(0, 3), ['pair:shareLaneSend', documentId, peerId]);
  await lane.establish({ id: laneId, role: 'connect', token, key: new Uint8Array(32), remote, timeout: 7000, hold: 0 });
  const call = invoked.shift(); assert.deepStrictEqual([call[0], call[1], call[2], call[3], call[4]], ['pair:shareLaneEstablish', documentId, laneId, 'connect', token]); assert.strictEqual(call[6].streamId, 5); assert.strictEqual(call[7], 7000);
  assert.strictEqual(lane.credit(peerId, 1000), true); assert.deepStrictEqual(sent.shift(), ['pair:shareLaneCredit', documentId, peerId, 1000]);
  assert.strictEqual(lane.closePeer(peerId), true); assert.deepStrictEqual(sent.shift(), ['pair:shareLaneClosePeer', documentId, peerId]);
  await capture.start({ fps: 30, width: 1920, height: 1080 }); assert.deepStrictEqual(invoked.shift(), ['pair:shareCaptureStart', documentId, { fps: 30, width: 1920, height: 1080 }]);

  // The GPU decoder bridge: sizes, ids and pictures are checked here, and only the four numbers of a request go on.
  const decode = exposed.pairShareDecode;
  assert(decode, 'the GPU decoder bridge was not exposed');
  for (const name of ['info', 'open', 'push', 'close', 'onFrame', 'onError', 'onEnd']) assert.strictEqual(typeof decode[name], 'function', 'pairShareDecode.' + name);
  sent.length = 0; invoked.length = 0;
  for (const bad of [undefined, null, {}, { width: 1920, height: 1080, outWidth: 960 }, { width: 1920, height: 1080, outWidth: '960', outHeight: 540 }, { width: 100, height: 1080, outWidth: 100, outHeight: 540 }, { width: 99999, height: 1080, outWidth: 960, outHeight: 540 }, { width: 1920.5, height: 1080, outWidth: 960, outHeight: 540 }]) {
    assert.deepStrictEqual(plain(await decode.open(bad)), { ok: false, error: 'invalid decoder request' });
  }
  assert.strictEqual(decode.push(0, 1, new Uint8Array(4)), false); assert.strictEqual(decode.push('1', 1, new Uint8Array(4)), false); assert.strictEqual(decode.push(1.5, 1, new Uint8Array(4)), false);
  assert.strictEqual(decode.push(1, -1, new Uint8Array(4)), false); assert.strictEqual(decode.push(1, NaN, new Uint8Array(4)), false); assert.strictEqual(decode.push(1, 1, new Uint8Array(0)), false);
  assert.strictEqual(decode.push(1, 1, new Uint8Array(8 * 1024 * 1024 + 1)), false); assert.strictEqual(decode.push(1, 1, 'text'), false);
  assert.strictEqual(decode.close(0), false); assert.strictEqual(decode.close('3'), false);
  assert.strictEqual(invoked.length + sent.length, 0, 'an invalid decoder request crossed the bridge: ' + JSON.stringify([...invoked, ...sent]));
  await decode.info(); assert.deepStrictEqual(invoked.shift(), ['pair:shareDecodeInfo', documentId]);
  await decode.open({ width: 1920, height: 1080, outWidth: 960, outHeight: 540, command: 'rm -rf /' });
  assert.deepStrictEqual(plain(invoked.shift()), ['pair:shareDecodeOpen', documentId, { width: 1920, height: 1080, outWidth: 960, outHeight: 540 }]);
  const picture = new Uint8Array(10);
  assert.strictEqual(decode.push(3, 1234, picture), true); assert.deepStrictEqual(sent.shift(), ['pair:shareDecodePush', documentId, 3, 1234, picture]);
  assert.strictEqual(decode.close(3), true); assert.deepStrictEqual(sent.shift(), ['pair:shareDecodeClose', documentId, 3]);
  const decoded = { frames: [], errors: [], ends: [] };
  decode.onFrame((id, meta, bytes) => decoded.frames.push([id, meta.width, meta.height, bytes.length])); decode.onError((id, message) => decoded.errors.push([id, message])); decode.onEnd(id => decoded.ends.push(id));
  const meta = { pts: 5, width: 128, height: 128 }, nv12 = new Uint8Array(128 * 128 * 3 / 2), foreign = 'cd'.repeat(16);
  events.emit('pair:shareDecodeFrame', {}, documentId, 3, meta, nv12);                                      // good
  events.emit('pair:shareDecodeFrame', {}, foreign, 3, meta, nv12);                                         // another document
  events.emit('pair:shareDecodeFrame', {}, documentId, 0, meta, nv12);                                      // not an id
  events.emit('pair:shareDecodeFrame', {}, documentId, 3, meta, new Uint8Array(100));                       // a picture of the wrong size for its header
  events.emit('pair:shareDecodeFrame', {}, documentId, 3, { pts: 5, width: 64, height: 64 }, new Uint8Array(64 * 64 * 3 / 2));   // below the decoder's limits
  events.emit('pair:shareDecodeFrame', {}, documentId, 3, { pts: 'x', width: 128, height: 128 }, nv12);
  events.emit('pair:shareDecodeError', {}, documentId, 3, 'the GPU is busy'); events.emit('pair:shareDecodeError', {}, documentId, 3, { message: 'x' }); events.emit('pair:shareDecodeError', {}, foreign, 3, 'no');
  events.emit('pair:shareDecodeEnd', {}, documentId, 3); events.emit('pair:shareDecodeEnd', {}, foreign, 3);
  assert.deepStrictEqual(decoded, { frames: [[3, 128, 128, 128 * 128 * 3 / 2]], errors: [[3, 'the GPU is busy']], ends: [3] });

  // Events: only from this document, only well-formed.
  const got = { open: [], frame: [], close: [], config: [], picture: [], end: 0 };
  lane.onOpen((id, t) => got.open.push([id, t])); lane.onFrame((id, bytes) => got.frame.push([id, bytes.length])); lane.onClose(id => got.close.push(id));
  capture.onConfig(c => got.config.push(c)); capture.onFrame(f => got.picture.push(f)); capture.onEnd(() => got.end++);
  const other = 'cd'.repeat(16);
  events.emit('pair:shareLaneOpen', {}, other, peerId, token);                  // another document's event
  events.emit('pair:shareLaneOpen', {}, documentId, 'short', token);            // not a peer id
  events.emit('pair:shareLaneOpen', {}, documentId, peerId, token);
  events.emit('pair:shareLaneFrame', {}, documentId, peerId, new Uint8Array(0));
  events.emit('pair:shareLaneFrame', {}, documentId, peerId, new Uint8Array(33));
  events.emit('pair:shareLaneClose', {}, documentId, peerId);
  events.emit('pair:shareCaptureConfig', {}, documentId, { codec: 'av01.0.13H.08', width: 3840, height: 2160 });
  events.emit('pair:shareCaptureConfig', {}, documentId, { codec: 5 });
  events.emit('pair:shareCaptureFrame', {}, documentId, { key: true, pts: 0, data: new Uint8Array(9) });
  events.emit('pair:shareCaptureFrame', {}, documentId, { key: 'yes', pts: 0, data: new Uint8Array(9) });
  events.emit('pair:shareCaptureFrame', {}, other, { key: true, pts: 0, data: new Uint8Array(9) });
  events.emit('pair:shareCaptureEnd', {}, documentId);
  assert.deepStrictEqual(got.open, [[peerId, token]]); assert.deepStrictEqual(got.frame, [[peerId, 33]]); assert.deepStrictEqual(got.close, [peerId]);
  assert.strictEqual(got.config.length, 1); assert.strictEqual(got.picture.length, 1); assert.strictEqual(got.end, 1);
  console.log('PASS preload: malformed requests stop at the bridge, good ones carry this document\'s id, foreign or malformed events are ignored');
}

// ------------------------------------------------------------------------------------------------------------------ main
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const slice = (from, to) => { const a = mainSource.indexOf(from), b = mainSource.indexOf(to, a); assert(a >= 0 && b > a, 'could not locate ' + from); return mainSource.slice(a, b); };
const LOCAL = { allowLoopback: true, advertiseHosts: ['127.0.0.1'], stunServers: [] };
const bridgeSource = slice('let activeBridgeOwner = null;', 'function validSaveId(')
  + slice('function directKey(', '\n') + '\n'
  + slice('// Screen shares (share-session.js).', 'let lanHouse = null');

class FakeDecodeRuntime {
  constructor(options) { this.options = options; this.opens = []; this.pushes = []; this.closes = []; this.closedAll = 0; FakeDecodeRuntime.all.push(this); }
  async availability() { return { available: true, reason: '', gpu: 'fake GPU av1 128x128..8192x8192', helper: '/secret/path/knot-nvdec' }; }
  async open(owner, options) { this.opens.push([owner, options]); if (options.width < 0) throw new Error('boom'); return { id: this.opens.length, outWidth: options.outWidth, outHeight: options.outHeight }; }
  push(owner, id, pts, data) { this.pushes.push([owner, id, pts, data.byteLength]); return true; }
  async close(owner, id) { this.closes.push([owner, id]); return true; }
  async closeAll() { this.closedAll++; }
}
FakeDecodeRuntime.all = [];

class FakeCapture extends EventEmitter {
  constructor() { super(); this.started = null; this.stopped = 0; FakeCapture.all.push(this); }
  async info() { return { supported: true, vendor: 'test' }; }
  async start(options) { if (FakeCapture.failWith) throw new Error(FakeCapture.failWith); this.started = options; return { width: 1920, height: 1080, fps: 60, bitrateKbps: 8000, encoder: 'fake', source: 'test' }; }
  async stop() { this.stopped++; this.emit('end'); }
}
FakeCapture.all = [];

function mainProcess(label, url = 'file:///app/index.html') {
  const handlers = new Map(), listeners = new Map(), sends = [];
  const mainFrame = { url };
  const webContents = { id: label === 'sharer' ? 7 : 8, mainFrame, isDestroyed: () => false, send: (channel, ...args) => sends.push([channel, ...args]) };
  const mainWin = { isDestroyed: () => false, webContents };
  const context = vm.createContext({
    Buffer, Uint8Array, ArrayBuffer, Number, Promise, console, setTimeout, clearTimeout,
    ipcMain: { handle: (c, h) => handlers.set(c, h), on: (c, h) => listeners.set(c, h) },
    mainWin, PAIR_RENDERER_URL: url, MAX_IPC_CHUNK: 8 * 1024 * 1024, TEST_RIG: false,
    isPairRenderer: event => event.sender === webContents && event.senderFrame === mainFrame,
    validBridgeDocumentId: value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : '',
    validIpcBinary: (value, max = 8 * 1024 * 1024) => (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) && value.byteLength > 0 && value.byteLength <= max,
    ShareLaneRuntime: class extends ShareLaneRuntime { constructor(options) { super({ ...options, udxOptions: LOCAL }); } },
    GsrCapture: FakeCapture, ShareDecodeRuntime: FakeDecodeRuntime, selectedPrimaryGpu: null, process: { env: {} },
    pendingSource: null, pendingSources: [1, 2, 3], nativeScreenService: { stopAsync: async () => {} },
    stopLinuxShareAudio: async () => {}, stopNativeCapture: () => {}, closeDirectFileRuntime: async () => {}, closeAllSaveStreams: async () => {}, closeLanHouse: async () => {},
  });
  vm.runInContext(bridgeSource, context, { filename: 'main-share-bridge.js' });
  const event = { sender: webContents, senderFrame: mainFrame };
  const documentId = (label === 'sharer' ? '11' : '22').repeat(16);
  listeners.get('pair:bridgeReady')(event, documentId);
  const call = (channel, ...args) => (handlers.get(channel) || listeners.get(channel))(event, documentId, ...args);
  return { handlers, listeners, sends, event, documentId, call, context, webContents, take: channel => sends.filter(s => s[0] === channel) };
}

async function mainChecks() {
  const sharer = mainProcess('sharer'), viewer = mainProcess('viewer');

  // Other documents and other frames get nothing.
  const stranger = { sender: sharer.webContents, senderFrame: { url: 'https://evil.example/' } };
  assert.deepStrictEqual(plain(await sharer.handlers.get('pair:shareLaneOpen')(stranger, sharer.documentId)), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(plain(await sharer.handlers.get('pair:shareLaneOpen')(sharer.event, 'ff'.repeat(16))), { ok: false, error: 'unauthorized' });
  assert.strictEqual(sharer.handlers.get('pair:shareLaneRegister')(stranger, sharer.documentId, 'T'.repeat(48), Buffer.alloc(32)), false);
  await rejects(sharer.handlers.get('pair:shareLaneSend')(stranger, sharer.documentId, 'b'.repeat(24), Buffer.alloc(4)), /not available/);
  assert.deepStrictEqual(plain(await sharer.handlers.get('pair:shareCaptureStart')(stranger, sharer.documentId, {})), { error: 'unauthorized' });
  assert.deepStrictEqual(plain(await sharer.handlers.get('pair:shareCaptureInfo')(stranger, sharer.documentId)), { supported: false });

  // A lane between the two, using the handlers exactly as the preload would call them.
  const laneS = await sharer.call('pair:shareLaneOpen'), laneV = await viewer.call('pair:shareLaneOpen');
  assert(laneS.ok && laneV.ok && /^[a-f0-9]{24}$/.test(laneS.id));
  const token = crypto.randomBytes(24).toString('hex'), key = crypto.randomBytes(32);
  assert.strictEqual(await viewer.call('pair:shareLaneRegister', token, key), true);
  assert.strictEqual(await viewer.call('pair:shareLaneRegister', 'short', key), false);
  // A lane that belongs to the other document cannot be driven from this one.
  await rejects(viewer.call('pair:shareLaneEstablish', laneS.id, 'accept', token, null, { streamId: laneS.streamId, endpoints: laneS.endpoints }, 4000, 0), /invalid share lane request/);
  const accepting = viewer.call('pair:shareLaneEstablish', laneV.id, 'accept', token, null, { streamId: laneS.streamId, endpoints: laneS.endpoints }, 6000, 0);
  await rejects(sharer.call('pair:shareLaneEstablish', laneS.id, 'connect', token, Buffer.alloc(5), { streamId: laneV.streamId, endpoints: laneV.endpoints }, 6000, 0), /invalid share lane credentials/);
  const peerS = await sharer.call('pair:shareLaneEstablish', laneS.id, 'connect', token, key, { streamId: laneV.streamId, endpoints: laneV.endpoints }, 6000, 0);
  await accepting;
  for (let waited = 0; !viewer.take('pair:shareLaneOpen').length && waited < 3000; waited += 20) await sleep(20);
  const opened = viewer.take('pair:shareLaneOpen');
  assert.strictEqual(opened.length, 1, 'the viewer page was not told about the new lane');
  assert.deepStrictEqual([opened[0][1], opened[0][3]], [viewer.documentId, token]);
  const peerV = opened[0][2];
  assert(/^[a-f0-9]{24}$/.test(peerS) && /^[a-f0-9]{24}$/.test(peerV));

  // Bytes cross, intact, in order, to the right page.
  const sent = crypto.randomBytes(3 * 1024 * 1024);
  for (let at = 0; at < sent.length; at += 1024 * 1024) await sharer.call('pair:shareLaneSend', peerS, new Uint8Array(sent.subarray(at, at + 1024 * 1024)));
  for (let waited = 0; Buffer.concat(viewer.take('pair:shareLaneFrame').map(s => Buffer.from(s[3]))).length < sent.length && waited < 10000; waited += 20) await sleep(20);
  const frames = viewer.take('pair:shareLaneFrame');
  assert(frames.every(s => s[1] === viewer.documentId && s[2] === peerV));
  assert(Buffer.concat(frames.map(s => Buffer.from(s[3]))).equals(sent), 'bytes arrived changed');
  assert.strictEqual(sharer.take('pair:shareLaneFrame').length, 0, 'the sharer page was handed the viewer\'s bytes');
  viewer.call('pair:shareLaneCredit', peerV, sent.length); viewer.call('pair:shareLaneCredit', peerV, -5); viewer.call('pair:shareLaneCredit', peerV, 99 * 1024 * 1024);
  await rejects(sharer.call('pair:shareLaneSend', peerS, Buffer.alloc(0)), /invalid share frame/);
  await rejects(viewer.call('pair:shareLaneSend', peerS, Buffer.alloc(3)), /unknown share lane/);              // not this document's peer

  // Closing: the other page hears about it.
  sharer.call('pair:shareLaneClosePeer', peerS);
  for (let waited = 0; !viewer.take('pair:shareLaneClose').length && waited < 4000; waited += 20) await sleep(20);
  assert.deepStrictEqual(viewer.take('pair:shareLaneClose').map(s => s[2]), [peerV]);

  // The GPU decoder: only the owning page can ask about it, open one, feed it or close it; what comes back reaches only that page; it ends with the page.
  assert.deepStrictEqual(plain(await sharer.handlers.get('pair:shareDecodeInfo')(stranger, sharer.documentId)), { available: false, reason: 'unauthorized' });
  assert.deepStrictEqual(plain(await sharer.handlers.get('pair:shareDecodeOpen')(stranger, sharer.documentId, { width: 1920, height: 1080, outWidth: 960, outHeight: 540 })), { ok: false, error: 'unauthorized' });
  assert.strictEqual(FakeDecodeRuntime.all.length, 0, 'a stranger started the GPU decoder runtime');
  const info = await sharer.call('pair:shareDecodeInfo');
  assert.deepStrictEqual(plain(info), { available: true, reason: '', gpu: 'fake GPU av1 128x128..8192x8192' }, 'the page must not be told where the helper program is');
  const decoder = FakeDecodeRuntime.all.at(-1);
  const decoderOpened = await sharer.call('pair:shareDecodeOpen', { width: 1920, height: 1080, outWidth: 960, outHeight: 540, extra: 'ignored' });
  assert.deepStrictEqual(plain(decoderOpened), { ok: true, id: 1, outWidth: 960, outHeight: 540 });
  assert.deepStrictEqual(plain(decoder.opens[0][1]), { width: 1920, height: 1080, outWidth: 960, outHeight: 540 });
  assert.deepStrictEqual(plain(await sharer.call('pair:shareDecodeOpen', { width: -1, height: 1, outWidth: 1, outHeight: 1 })), { ok: false, error: 'boom' });
  assert.deepStrictEqual(plain(await sharer.call('pair:shareDecodeOpen', null)), { ok: false, error: 'unauthorized' });
  sharer.call('pair:shareDecodePush', 1, 100, new Uint8Array(20)); sharer.call('pair:shareDecodePush', 1.5, 100, new Uint8Array(20)); sharer.call('pair:shareDecodePush', 1, NaN, new Uint8Array(20));
  sharer.call('pair:shareDecodePush', 1, 100, 'text'); sharer.call('pair:shareDecodePush', 1, 100, new Uint8Array(8 * 1024 * 1024 + 1));
  sharer.listeners.get('pair:shareDecodePush')(stranger, sharer.documentId, 1, 100, new Uint8Array(20));
  assert.deepStrictEqual(decoder.pushes.map(p => p.slice(1)), [[1, 100, 20]], 'only the one valid push from the owner may reach the decoder');
  sharer.listeners.get('pair:shareDecodeClose')(stranger, sharer.documentId, 1); assert.strictEqual(decoder.closes.length, 0);
  sharer.call('pair:shareDecodeClose', 1); await sleep(10); assert.strictEqual(decoder.closes.length, 1);
  decoder.options.onFrame({ owner: decoder.opens[0][0], id: 1, picture: { pts: 7, width: 960, height: 540, data: Buffer.alloc(960 * 540 * 3 / 2) } });
  decoder.options.onError({ owner: decoder.opens[0][0], id: 1, error: new Error('the GPU is busy') });
  decoder.options.onEnd({ owner: decoder.opens[0][0], id: 1 });
  assert.deepStrictEqual(sharer.take('pair:shareDecodeFrame').map(m => [m[1], m[2], plain(m[3]), m[4].length]), [[sharer.documentId, 1, { pts: 7, width: 960, height: 540 }, 960 * 540 * 3 / 2]]);
  assert.deepStrictEqual(sharer.take('pair:shareDecodeError').map(m => [m[1], m[2], m[3]]), [[sharer.documentId, 1, 'the GPU is busy']]);
  assert.strictEqual(sharer.take('pair:shareDecodeEnd').length, 1);
  assert.strictEqual(viewer.take('pair:shareDecodeFrame').length, 0, 'the other page was handed the pictures');

  // The recorder: started for the document that asked, events reach only that page, stopped with it.
  const started = await sharer.call('pair:shareCaptureStart', { fps: 30 });
  assert.strictEqual(started.width, 1920);
  const capture = FakeCapture.all.at(-1);
  assert.deepStrictEqual(plain(capture.started), { fps: 30 });
  assert.deepStrictEqual([...sharer.context.pendingSources], [], 'the picker thumbnails were kept');
  capture.emit('config', { codec: 'av01.0.13H.08', width: 3840, height: 2160 });
  capture.emit('frame', { key: true, pts: 0, data: Buffer.alloc(7) });
  capture.emit('error', new Error('boom'));
  assert.deepStrictEqual(sharer.take('pair:shareCaptureConfig').map(s => s[1]), [sharer.documentId]);
  assert.strictEqual(sharer.take('pair:shareCaptureFrame').length, 1);
  assert.deepStrictEqual(sharer.take('pair:shareCaptureError').map(s => s[2]), ['boom']);
  assert.strictEqual(viewer.take('pair:shareCaptureConfig').length, 0);
  await sharer.call('pair:shareCaptureStart', { fps: 60 });                       // a second start replaces the first
  assert.strictEqual(capture.stopped, 1, 'the previous recorder was left running');
  FakeCapture.failWith = 'no recorder here';
  const failed = await sharer.call('pair:shareCaptureStart', {});
  assert.deepStrictEqual(plain(failed), { error: 'no recorder here' }); FakeCapture.failWith = '';
  assert.strictEqual(FakeCapture.all.at(-1).stopped, 1, 'a recorder that failed to start was not stopped');
  const live = FakeCapture.all.at(-3);
  await sharer.call('pair:shareCaptureStart', { fps: 60 });
  const running = FakeCapture.all.at(-1);
  // The page navigates away: its recorder and lanes go with it.
  sharer.listeners.get('pair:bridgeReady')(sharer.event, 'ee'.repeat(16));
  for (let waited = 0; !running.stopped && waited < 2000; waited += 10) await sleep(10);
  assert.strictEqual(running.stopped, 1, 'the recorder outlived its page');
  assert.strictEqual(decoder.closedAll, 1, 'the GPU decoders outlived their page');
  assert(live);
  await rejects(sharer.handlers.get('pair:shareLaneSend')(sharer.event, sharer.documentId, peerS, Buffer.alloc(3)), /not available|unknown/);
  console.log('PASS main: only the owning page can open, send, close or record; a record crossed two main processes over a real UDP lane; closing and navigation clean up');
  viewer.context.closeShareRuntime?.();
}

(async () => { await preloadChecks(); await mainChecks(); process.exit(0); })().catch(error => { console.error(error); process.exit(1); });
