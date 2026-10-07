'use strict';

// The share modules are plain scripts in the page, with no require() and no module. Every other test loads them through require, which
// hides a module that reaches for a global it was never handed. This loads them the way index.html does (same order, a bare window), and
// then runs a real share through the loaded copies.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
const shareScripts = scripts.filter(name => /^share-/.test(name));
assert(shareScripts.length >= 7, 'index.html does not load the share modules: ' + shareScripts.join(', '));
const order = ['share-wire.js', 'share-core.js', 'share-playout.js', 'share-player.js', 'share-encoder.js', 'share-session.js', 'share-controller.js'];
assert.deepStrictEqual(shareScripts, order, 'share modules are loaded in an order that cannot work');
assert(scripts.indexOf('share-controller.js') < scripts.indexOf('app.js'), 'the controller must load before app.js');

// A window and nothing else: no require, no module, no process.
const window = { crypto: require('crypto').webcrypto, setTimeout, clearTimeout, setInterval, clearInterval, performance, console, Uint8Array, ArrayBuffer, DataView, Promise, Map, Set, WeakMap, JSON, Math, Date, Error, Array, Object, Number, String, Symbol };
window.window = window;
const context = vm.createContext(window);
for (const name of order) vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context, { filename: name });
for (const key of ['KnotShareWire', 'KnotShareCore', 'KnotSharePlayout', 'KnotSharePlayer', 'KnotShareEncoder', 'KnotShareSession', 'KnotShareController']) assert(window[key] && typeof window[key] === 'object', key + ' was not installed by its script');

// The checks below use the loaded copies only.
const C = window.KnotShareController;
assert.strictEqual(typeof C.createShareSender, 'function'); assert.strictEqual(typeof C.createShareWatcher, 'function');
assert(/^[0-9a-f]{24}$/.test(C.newShareId()), 'share ids are drawn from the page\'s crypto');

(async () => {
  const log = [], received = [];
  let sender, watcher;
  const player = { configure(config) { log.push('configure ' + config.codec); }, push(record) { received.push(record); }, skip() {}, setActive() {}, read: () => ({ painted: 0, lastPacketAt: 0, lastLiveAt: 0 }), stats: () => ({ delayMs: 250 }), destroy() {} };
  const Player = { createSharePlayer: () => player };
  const handlers = {};
  const recorder = { onConfig: cb => (handlers.config = cb, () => {}), onFrame: cb => (handlers.frame = cb, () => {}), onError: () => () => {}, onEnd: () => () => {}, start: async () => ({ width: 1280, height: 720, fps: 60, bitrateKbps: 8000, encoder: 'test' }), stop: async () => {} };
  const channels = {};
  sender = C.createShareSender({
    source: C.recorderSource(recorder, {}),
    sendControl: (id, message) => setTimeout(() => watcher.onControl(JSON.parse(JSON.stringify(message))), 1),
    openDataChannel: () => {
      const a = { readyState: 'open', bufferedAmount: 0, send(data) { const bytes = Uint8Array.from(data); setTimeout(() => b.onmessage?.({ data: bytes.buffer }), 1); }, close() {} };
      const b = { binaryType: 'arraybuffer', close() {} };
      channels.b = b; setTimeout(() => watcher.attachDataChannel(b), 1); return a;
    },
    log: line => log.push(line),
  });
  watcher = C.createShareWatcher({ shareId: sender.shareId, surface: {}, Player, sendControl: message => setTimeout(() => sender.onControl('v', JSON.parse(JSON.stringify(message))), 1) });
  await sender.start();
  handlers.config({ codec: 'av01.0.08M.08', width: 1280, height: 720, fps: 60 });
  watcher.watch();
  for (let waited = 0; !sender.hasViewers() && waited < 2000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  assert(sender.hasViewers(), 'the viewer never reached the sharer');
  handlers.frame({ key: true, pts: 0, data: Uint8Array.of(1, 2, 3, 4) });
  handlers.frame({ key: false, pts: 16667, data: Uint8Array.of(5, 6, 7) });
  for (let waited = 0; received.filter(r => r.type === 2).length < 2 && waited < 3000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepStrictEqual(received.filter(r => r.type === 2).map(r => Array.from(r.payload)), [[1, 2, 3, 4], [5, 6, 7]], 'pictures did not cross: ' + JSON.stringify(log));
  watcher.stop({ notify: false }); await sender.stop({ drainMs: 0 });
  console.log('PASS the share modules load as plain scripts in index.html order and carry a picture through the loaded copies');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
