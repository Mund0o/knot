const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const exposed = {};
const sent = [];
const invoked = [];
const events = new EventEmitter();
const documentId = 'ab'.repeat(16);
const ipcRenderer = {
  send(channel, ...args) { sent.push([channel, ...args]); },
  invoke(channel, ...args) { invoked.push([channel, ...args]);return Promise.resolve({ ok: true }); },
  on(channel, listener) { events.on(channel, listener); },
  removeListener(channel, listener) { events.removeListener(channel, listener); },
};
const context = vm.createContext({
  ArrayBuffer,
  Buffer,
  Number,
  Promise,
  Uint8Array,
  console,
  process: { env: { KNOT_APP_VERSION: 'test' }, platform: 'linux' },
  crypto: {
    getRandomValues(value) {
      value.set(Buffer.from(documentId, 'hex').subarray(0, value.byteLength));
      return value;
    },
  },
  require(id) {
    if (id === 'electron') return { contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } }, ipcRenderer };
    throw new Error(`unexpected preload dependency: ${id}`);
  },
});
vm.runInContext(source, context, { filename: 'preload.js' });

async function rejects(promise, pattern) {
  let error = null;
  try { await promise; } catch (value) { error = value; }
  assert(error, 'expected promise to reject');
  assert(pattern.test(String(error.message || error)), `unexpected rejection: ${error.message || error}`);
}

(async () => {
  assert.deepStrictEqual(sent.shift(), ['pair:bridgeReady', documentId], 'preload did not register its document generation first');
  const direct = exposed.pairDirectFile;
  const save = exposed.pairSave;
  const history=exposed.pairHistory,metrics=exposed.pairMetrics;
  assert(direct && save && history && metrics, 'file/history/metrics bridges were not exposed');

  invoked.length=0;
  assert.strictEqual((await history.append('../owner','dm:bad',{text:'secret'})).added,0,'invalid history scope reached IPC');
  assert.strictEqual(invoked.length,0);
  const owner='1'.repeat(32),peer='2'.repeat(32),conversation='dm:'+peer;
  await history.append(owner,conversation,{text:'local encrypted entry'});assert.deepStrictEqual(invoked.shift().slice(0,3),['pair:historyAppend',owner,conversation]);
  await history.list(owner,conversation,{before:-4,limit:9999,ignored:'private'});const historyList=invoked.shift();assert.deepStrictEqual(historyList.slice(0,3),['pair:historyList',owner,conversation]);assert.deepStrictEqual(Object.keys(historyList[3]),['before','limit']);assert.strictEqual(historyList[3].before,null);assert.strictEqual(historyList[3].limit,200);
  const sentBeforeMetrics=sent.length;metrics.record('screen.rtt_ms',42,{codec:'av1'});metrics.record('screen.rtt_ms',NaN);assert.strictEqual(sent.length,sentBeforeMetrics+1);assert.deepStrictEqual(sent.at(-1),['pair:metricRecord','screen.rtt_ms',42,{codec:'av1'}]);

  assert.strictEqual((await direct.listen(80)).ok, false, 'privileged listener port reached IPC');
  assert.strictEqual(await direct.register('x'.repeat(32), new Uint8Array(31)), false, 'short key reached IPC');
  await rejects(direct.connect('host.example', 8787, 'a'.repeat(32), new Uint8Array(32)), /Invalid direct-file connection/);
  await rejects(direct.connect('127.0.0.1', 8787, 'short', new Uint8Array(32)), /Invalid direct-file connection/);
  assert.strictEqual(invoked.length, 0, 'invalid direct-file arguments crossed the context bridge');

  await direct.connect('2001:db8::1', 8787, 'a'.repeat(48), new Uint8Array(32), { timeout: 999999, ignored: 'x'.repeat(1000) });
  const connectCall = invoked.shift();
  assert.deepStrictEqual(connectCall.slice(0, 5), ['pair:directFileConnect', documentId, '2001:db8::1', 8787, 'a'.repeat(48)]);
  assert.strictEqual(connectCall[5].byteLength, 32);
  // The bridge creates a small allowlisted options object rather than cloning
  // arbitrary renderer-owned properties into main.
  assert.strictEqual(connectCall[6].timeout, 10000);
  assert.deepStrictEqual(Object.keys(connectCall[6]), ['timeout']);
  assert.strictEqual(invoked.length, 0);

  invoked.length = 0;
  await direct.send('c'.repeat(32), new Uint8Array([1, 2, 3]));
  assert.strictEqual(invoked[0][0], 'pair:directFileSend');
  assert.strictEqual(invoked[0][1], documentId);
  assert.deepStrictEqual([...invoked[0][3]], [1, 2, 3]);
  await rejects(direct.send('../bad', new Uint8Array([1])), /Invalid direct-file frame/);
  await rejects(direct.send('c'.repeat(32), new Uint8Array(8 * 1024 * 1024 + 1)), /Invalid direct-file frame/);

  assert.strictEqual(direct.ack('c'.repeat(32), 3), true);
  assert.deepStrictEqual(sent.pop(), ['pair:directFileAck', documentId, 'c'.repeat(32), 3]);
  assert.strictEqual(direct.ack('c'.repeat(32), 0), false);
  assert.strictEqual(direct.close('not-an-id'), false);

  let opened = 0, framed = 0, closed = 0;
  direct.onOpen(() => opened++);direct.onFrame(() => framed++);direct.onClose(() => closed++);
  events.emit('pair:directFileOpen', {}, 'ff'.repeat(16), 'd'.repeat(32), 'e'.repeat(48));
  events.emit('pair:directFileOpen', {}, documentId, 'bad', 'e'.repeat(48));
  events.emit('pair:directFileOpen', {}, documentId, 'd'.repeat(32), 'e'.repeat(48));
  events.emit('pair:directFileFrame', {}, documentId, 'd'.repeat(32), new Uint8Array(0));
  events.emit('pair:directFileFrame', {}, documentId, 'd'.repeat(32), new Uint8Array([1]));
  events.emit('pair:directFileClose', {}, documentId, 'bad');
  events.emit('pair:directFileClose', {}, documentId, 'd'.repeat(32));
  assert.deepStrictEqual([opened, framed, closed], [1, 1, 1], 'stale or malformed native events reached renderer callbacks');

  // The UDP lane bridge validates everything before it reaches the main process.
  const udx = exposed.pairUdxLane;
  assert(udx, 'the UDP lane bridge was not exposed');
  const laneId = 'a1'.repeat(12), udxToken = 't'.repeat(48), udxKey = new Uint8Array(32).fill(5);
  const remote = { streamId: 77, endpoints: [{ ip: '203.0.113.9', port: 41000, kind: 'srflx' }, { ip: '192.168.1.5', port: 41000, kind: 'host', extra: 'dropped' }] };
  invoked.length = 0;
  await udx.open();
  assert.deepStrictEqual(invoked.pop(), ['pair:udxOpen', documentId]);
  assert.strictEqual(await udx.register('bad', udxKey), false);
  assert.strictEqual(await udx.register(udxToken, new Uint8Array(8)), false);
  assert.strictEqual(invoked.length, 0, 'an invalid registration reached the main process');
  await udx.register(udxToken, udxKey);
  assert.strictEqual(invoked.at(-1)[0], 'pair:udxRegister');
  const badEstablish = [
    undefined, null, {}, { id: 'x', role: 'connect', token: udxToken, key: udxKey, remote },
    { id: laneId, role: 'sideways', token: udxToken, key: udxKey, remote },
    { id: laneId, role: 'connect', token: 'short', key: udxKey, remote },
    { id: laneId, role: 'connect', token: udxToken, key: new Uint8Array(8), remote },
    { id: laneId, role: 'connect', token: udxToken, key: udxKey },
    { id: laneId, role: 'connect', token: udxToken, key: udxKey, remote: { streamId: 0, endpoints: remote.endpoints } },
    { id: laneId, role: 'connect', token: udxToken, key: udxKey, remote: { streamId: 77, endpoints: [] } },
    { id: laneId, role: 'connect', token: udxToken, key: udxKey, remote: { streamId: 77, endpoints: new Array(17).fill(remote.endpoints[0]) } },
    { id: laneId, role: 'connect', token: udxToken, key: udxKey, remote: { streamId: 77, endpoints: [{ ip: 'example.com', port: 41000 }] } },
    { id: laneId, role: 'connect', token: udxToken, key: udxKey, remote: { streamId: 77, endpoints: [{ ip: '203.0.113.9', port: 80 }] } },
    { id: laneId, role: 'connect', token: udxToken, key: udxKey, remote: { streamId: 77, endpoints: [{ ip: '203.0.113.9', port: '41000' }] } },
  ];
  const before = invoked.length;
  for (const bad of badEstablish) await rejects(udx.establish(bad), /Invalid UDP lane request/);
  assert.strictEqual(invoked.length, before, 'an invalid establish reached the main process');
  await udx.establish({ id: laneId, role: 'connect', token: udxToken, key: udxKey, remote, timeout: 8000, hold: 0 });
  const udxConnectCall = invoked.at(-1);
  assert.deepStrictEqual(udxConnectCall.slice(0, 5), ['pair:udxEstablish', documentId, laneId, 'connect', udxToken]);
  assert.strictEqual(udxConnectCall[5].byteLength, 32, 'the session key was not forwarded for the connecting side');
  assert.strictEqual(udxConnectCall[6].streamId, 77);
  assert.deepStrictEqual(udxConnectCall[6].endpoints.map(item => Object.keys(item).sort().join()), ['ip,kind,port', 'ip,kind,port'], 'extra endpoint fields were forwarded');
  assert.deepStrictEqual(udxConnectCall.slice(7), [8000, 0]);
  await udx.establish({ id: laneId, role: 'accept', token: udxToken, key: udxKey, remote, timeout: 12000, hold: 30000 });
  assert.strictEqual(invoked.at(-1)[5], null, 'the accepting side forwarded the session key');
  assert.strictEqual(await udx.release('nope'), false);
  await udx.release(laneId);
  assert.deepStrictEqual(invoked.at(-1), ['pair:udxRelease', documentId, laneId]);
  assert.strictEqual(udx.close('nope'), false);
  assert.strictEqual(udx.close(laneId), true);
  assert.deepStrictEqual(sent.pop(), ['pair:udxClose', documentId, laneId]);

  await save.start(7, 'safe.bin', 3);
  assert.deepStrictEqual(invoked.at(-1).slice(0, 5), ['pair:saveStart', documentId, 7, 'safe.bin', 3]);
  console.log('file-transfer preload IPC validation tests passed');
})().catch(error => { console.error(error);process.exitCode = 1; });
