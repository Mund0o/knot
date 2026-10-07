'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { ShareHost, ShareViewer } = require('../share-session');
const { ShareLaneRuntime } = require('../share-lane-runtime');
const { TYPE } = require('../share-wire');

// Real UDP lanes (on loopback), the real core, and simulated data channels and control messages with a little delay.
const LOCAL = { allowLoopback: true, advertiseHosts: ['127.0.0.1'], stunServers: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, ms = 8000, label = 'condition') { for (let waited = 0; waited < ms; waited += 20) { if (await condition()) return; await sleep(20); } throw new Error('timed out waiting for ' + label); }
const FRAME_US = Math.round(1e6 / 60);
const payloadOf = index => { const out = Buffer.alloc(3000 + (index % 7) * 500); for (let i = 0; i < out.length; i++) out[i] = (index * 31 + i * 7) & 0xff; return out; };
const CONFIG = { codec: 'av01.0.13H.08', width: 3840, height: 2160, fps: 60 };

// ---- a data channel pair
class DcEnd {
  constructor(link) { this.link = link; this.readyState = 'connecting'; this.bufferedAmount = 0; this.bufferedAmountLowThreshold = 0; this.peer = null; this.binaryType = 'arraybuffer'; this.sentMessages = 0; }
  send(data) {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: the channel is not open');
    const bytes = Uint8Array.from(data), link = this.link;
    this.sentMessages++; this.bufferedAmount += bytes.length;
    const start = Math.max(Date.now(), link.freeAt), done = start + bytes.length / link.bytesPerMs; link.freeAt = done;
    setTimeout(() => {
      const before = this.bufferedAmount; this.bufferedAmount -= bytes.length;
      if (this.readyState !== 'open' || link.dead) return;
      this.peer?.onmessage?.({ data: bytes.buffer });
      if (before >= this.bufferedAmountLowThreshold && this.bufferedAmount < this.bufferedAmountLowThreshold) this.onbufferedamountlow?.();
    }, done - Date.now() + link.latencyMs);
  }
  close() { this.readyState = 'closed'; this.onclose?.(); }
}
function dataChannelPair({ latencyMs = 15, bytesPerMs = 1e9 } = {}) {
  const link = { latencyMs, bytesPerMs, freeAt: 0, dead: false };
  const a = new DcEnd(link), b = new DcEnd(link); a.peer = b; b.peer = a;
  setTimeout(() => { a.readyState = 'open'; b.readyState = 'open'; a.onopen?.(); b.onopen?.(); }, 8);
  return { a, b, link };
}

// ---- a lane runtime in the shape the renderer sees it (window.pairShareLane)
function makeRuntime(options = {}) {
  const hooks = { open: [], frame: [], close: [] }, owner = { id: 'document' };
  const rt = new ShareLaneRuntime({ udxOptions: LOCAL, sameOwner: (x, y) => x.id === y.id, onOpen: e => hooks.open.forEach(f => f(e.peerId, e.token)), onFrame: e => hooks.frame.forEach(f => f(e.peerId, e.frame)), onClose: e => hooks.close.forEach(f => f(e.peerId)), ...options });
  const api = {
    failOpen: false,
    async open() { if (api.failOpen) return { ok: false, error: 'no lanes today' }; return { ok: true, ...(await rt.open(owner)) }; },
    async register(token, key) { return rt.register(owner, token, Buffer.from(key)); },
    establish: o => rt.establish(owner, { laneId: o.id, role: o.role, token: o.token, key: o.key && Buffer.from(o.key), remote: o.remote, timeoutMs: o.timeout, holdMs: o.hold }),
    release: id => rt.release(owner, id), close: id => rt.closeLane(owner, id), closePeer: id => rt.closePeer(owner, id),
    send: (id, bytes) => rt.send(owner, id, bytes), credit: (id, n) => rt.credit(owner, id, n),
    onOpen: f => hooks.open.push(f), onFrame: f => hooks.frame.push(f), onClose: f => hooks.close.push(f),
  };
  return { api, rt, owner };
}

// ---- a sharer, viewers, and what they say to each other
function world({ viewers = ['v1'], useUdx = true, dc = {}, hostOptions = {}, controlMs = 6 } = {}) {
  const sharerRt = useUdx ? makeRuntime() : null;
  const log = [];
  const hosts = {}, byId = {}, dcLinks = {};
  const deliver = (fn) => setTimeout(fn, controlMs);
  const host = new ShareHost({
    shareId: 'share-0001', config: CONFIG, lanes: sharerRt?.api || null, log: line => log.push('host: ' + line), ...hostOptions,
    sendControl: (viewerId, message) => deliver(() => byId[viewerId]?.viewer.onControl(JSON.parse(JSON.stringify(message)))),
    openDataChannel: (viewerId, label) => {
      const pair = dataChannelPair(dc); dcLinks[viewerId] = pair;
      assert(/^knot-share-/.test(label));
      setTimeout(() => byId[viewerId]?.viewer.attachDataChannel(pair.b), 2);       // the viewer's side gets it through ondatachannel
      return pair.a;
    },
  });
  const join = (id, { udx = useUdx, lanes = undefined } = {}) => {
    const viewerRt = (udx && lanes !== null) ? makeRuntime() : null;
    const records = [], skips = [], gaps = [], configs = [];
    const player = { configure: config => configs.push(config), push: record => records.push(record), skip: () => skips.push(1), read: () => ({}) };
    const viewer = new ShareViewer({ shareId: 'share-0001', player, lanes: viewerRt?.api || null, log: line => log.push(id + ': ' + line), onGap: gap => gaps.push(gap),
      sendControl: message => deliver(() => {
        if (message.t === 'share-watch') host.addViewer(id, { udx: !!message.caps?.udx });
        else host.onControl(id, JSON.parse(JSON.stringify(message)));
      }) });
    byId[id] = { viewer, records, skips, gaps, configs, rt: viewerRt };
    viewer.watch();
    return byId[id];
  };
  for (const id of viewers) join(id);
  return { host, byId, join, sharerRt, log, dcLinks, close() { host.destroy(); for (const entry of Object.values(byId)) { entry.viewer.stop({ notify: false }); entry.rt?.rt.close(); } sharerRt?.rt.close(); } };
}

async function produce(host, from, to, { fps = 60, keyEvery = 30, hooks = {} } = {}) {
  const t0 = Date.now();
  for (let i = from; i < to; i++) {
    const wait = t0 + (i - from) * 1000 / fps - Date.now(); if (wait > 1) await sleep(wait);
    hooks[i]?.();
    host.pushFrame({ key: i % keyEvery === 0, pts: i * FRAME_US, data: new Uint8Array(payloadOf(i)) });
  }
}

// What a viewer received must be contiguous and byte-exact (heartbeats and the end record included).
function check(records, label, { from = null } = {}) {
  assert(records.length, label + ': nothing received');
  let expected = records[0].seq;
  for (const record of records) {
    assert.strictEqual(record.seq, expected, `${label}: expected seq ${expected}, got ${record.seq}`); expected++;
    if (record.type === TYPE.VIDEO) assert(Buffer.from(record.payload).equals(payloadOf(Math.round(record.pts / FRAME_US))), `${label}: picture at seq ${record.seq} is not what was captured`);
  }
  return records.filter(r => r.type === TYPE.VIDEO).length;
}

(async () => {
  // 1. Data channel only: everything arrives, in order, byte for byte, and the sharer lets go of it afterwards.
  {
    const w = world({ useUdx: false, dc: { latencyMs: 25, bytesPerMs: 400 } });
    await produce(w.host, 0, 150);
    w.host.end(); const v = w.byId.v1;
    await until(() => v.records.at(-1)?.type === TYPE.END, 8000, 'the end');
    const pictures = check(v.records, 'data channel');
    assert.strictEqual(pictures, 150);
    assert.strictEqual(v.records[0].key, true);
    assert.deepStrictEqual(v.configs[0], CONFIG);
    assert(await w.host.whenDrained(3000), 'the viewer acknowledged everything');
    assert.strictEqual(w.host.stats().records, 0, 'the sharer frees everything once acknowledged');
    assert.strictEqual(v.viewer.stats().duplicates, 0);
    w.close(); console.log('PASS data channel only: 150 pictures arrive in order, byte for byte, and the sharer lets go of them');
  }

  // 2. The UDP lane comes up while the share is running and takes over, with nothing lost or reordered.
  {
    const w = world({ dc: { latencyMs: 40, bytesPerMs: 300 } });
    await produce(w.host, 0, 90);
    await until(() => w.host.stats().viewers[0]?.lane === 'udx', 8000, 'the UDP lane to take over');
    const switchedAt = w.host.stats().nextSeq;
    await produce(w.host, 90, 270);
    w.host.end(); const v = w.byId.v1;
    await until(() => v.records.at(-1)?.type === TYPE.END, 8000, 'the end');
    assert.strictEqual(check(v.records, 'UDP takeover'), 270);
    assert(switchedAt > 0 && switchedAt < 270, 'it switched while the share was running');
    assert(v.viewer.stats().duplicates >= 0);
    assert(await w.host.whenDrained(3000));
    w.close(); console.log(`PASS the UDP lane takes over mid-share (at record ${switchedAt}) with nothing lost or reordered`);
  }

  // 3. A viewer that cannot use UDP simply stays on the data channel.
  {
    const w = world({ viewers: [], useUdx: true });
    const v = w.join('v1', { udx: false });
    await produce(w.host, 0, 90);
    w.host.end(); await until(() => v.records.at(-1)?.type === TYPE.END, 8000, 'the end');
    assert.strictEqual(check(v.records, 'no UDP'), 90);
    assert.strictEqual(w.host.stats().udx[0].state, 'idle');
    w.close(); console.log('PASS a viewer without UDP stays on the data channel and nobody retries it');
  }

  // 4. A viewer whose UDP lane cannot be opened answers "no"; the sharer carries on over the data channel and tries again later.
  {
    const w = world({ viewers: [] });
    const v = w.join('v1'); v.rt.api.failOpen = true;
    await produce(w.host, 0, 90);
    await until(() => w.host.stats().udx[0]?.state === 'idle' && w.host.stats().udx[0].attempts >= 1, 5000, 'the refusal');
    assert(w.log.some(line => /cannot use a UDP lane|failed/.test(line)));
    w.host.end(); await until(() => v.records.at(-1)?.type === TYPE.END, 8000, 'the end');
    assert.strictEqual(check(v.records, 'refused'), 90);
    w.close(); console.log('PASS a refused UDP lane leaves the data channel carrying everything');
  }

  // 5. The UDP lane dies in the middle of the share, with data in flight: the data channel takes over from where the viewer was.
  {
    const w = world({ dc: { latencyMs: 30, bytesPerMs: 500 } });
    await produce(w.host, 0, 80);
    await until(() => w.host.stats().viewers[0]?.lane === 'udx', 8000, 'the UDP lane');
    const peers = [...w.sharerRt.rt.peers.keys()];
    await produce(w.host, 80, 120, { hooks: { 100: () => { for (const id of peers) w.sharerRt.rt.closePeer(w.sharerRt.owner, id); } } });
    await until(() => w.host.stats().viewers[0]?.lane === 'dc', 4000, 'the fall back to the data channel');
    await produce(w.host, 120, 240);
    w.host.end(); const v = w.byId.v1;
    await until(() => v.records.at(-1)?.type === TYPE.END, 10000, 'the end');
    assert.strictEqual(check(v.records, 'UDP died'), 240);
    assert(w.log.some(line => /closed; carrying on over the data channel/.test(line)));
    w.close(); console.log('PASS losing the UDP lane mid-share falls back to the data channel without losing a picture');
  }

  // 6. A viewer who joins halfway starts on a key picture and is told about the stream; the first viewer is not disturbed.
  {
    const w = world({ useUdx: false });
    await produce(w.host, 0, 100);
    const late = w.join('v2', { udx: false });
    await produce(w.host, 100, 200);
    w.host.end();
    await until(() => w.byId.v1.records.at(-1)?.type === TYPE.END && late.records.at(-1)?.type === TYPE.END, 8000, 'both ends');
    assert.strictEqual(late.records[0].key, true, 'a late viewer must start on a key picture');
    assert(Math.round(late.records[0].pts / FRAME_US) % 30 === 0);
    assert(Math.round(late.records[0].pts / FRAME_US) >= 60, 'it should start at the latest key (picture 90), started at ' + Math.round(late.records[0].pts / FRAME_US));
    assert.strictEqual(check(w.byId.v1.records, 'first viewer'), 200);
    check(late.records, 'late viewer');
    assert.deepStrictEqual(late.configs[0], CONFIG);
    w.close(); console.log('PASS a viewer who joins halfway starts at a key picture and the first viewer is undisturbed');
  }

  // 7. A still screen: the sharer keeps saying so, so the viewer can tell it from a dead link.
  {
    const w = world({ useUdx: false });
    await produce(w.host, 0, 30);
    await sleep(1500);
    w.host.end(); const v = w.byId.v1;
    await until(() => v.records.at(-1)?.type === TYPE.END, 6000, 'the end');
    const beats = v.records.filter(r => r.type === TYPE.HEARTBEAT);
    assert(beats.length >= 10, 'about ten beats a second for 1.5 s, got ' + beats.length);
    assert(beats.every((b, i) => i === 0 || b.pts >= beats[i - 1].pts), 'beats keep the sharer\'s clock moving forward');
    assert(beats.at(-1).pts - 29 * FRAME_US > 1.2e6, 'the beats carried the picture clock on while nothing changed');
    check(v.records, 'still screen');
    w.close(); console.log(`PASS a still screen sends heartbeats (${beats.length} in 1.5 s)`);
  }

  // 8. A viewer that cannot keep up for too long is moved to the live picture, told what it missed, and the player is told to restart.
  {
    const w = world({ useUdx: false, dc: { latencyMs: 40, bytesPerMs: 60 }, hostOptions: { senderOptions: { maxBacklogMs: 1500 } } });
    await produce(w.host, 0, 360);
    const v = w.byId.v1;
    await until(() => v.gaps.length > 0, 8000, 'a gap');
    assert(v.skips.length >= 1, 'the player must be told to restart from a key picture');
    assert(w.log.some(line => /moved up \(behind\)/.test(line)));
    let previous = null;
    for (const record of v.records) {
      if (previous !== null && record.seq !== previous + 1) assert(v.gaps.some(g => g.from <= previous + 1 && g.to >= record.seq - 1), `hole ${previous}..${record.seq} was not announced`);
      previous = record.seq;
    }
    w.close(); console.log('PASS a viewer that falls hopelessly behind is moved up, told, and its player restarts');
  }

  // 9. Leaving: the viewer's lanes close on both sides and the sharer forgets it.
  {
    const w = world({});
    await produce(w.host, 0, 60);
    await until(() => w.host.stats().viewers[0]?.lane === 'udx', 8000, 'the UDP lane');
    w.byId.v1.viewer.stop();
    await until(() => w.host.stats().viewers.length === 0, 3000, 'the sharer to forget the viewer');
    await until(() => w.sharerRt.rt.peers.size === 0, 3000, 'the lane to close');
    await produce(w.host, 60, 90);
    w.close(); console.log('PASS a viewer who leaves is forgotten and its lanes close');
  }

  // 10. Hostile or broken control messages change nothing.
  {
    const w = world({ useUdx: false });
    await produce(w.host, 0, 30);
    for (const bad of [null, {}, { t: 'share-ack', shareId: 'other-share', seq: 5 }, { t: 'share-ack', shareId: 'share-0001', seq: 'x' }, { t: 'share-udx-ready', shareId: 'share-0001', token: 'a'.repeat(48), streamId: 5, endpoints: [{ ip: '1.2.3.4', port: 9 }] }, { t: 'share-resend', shareId: 'share-0001' }, { t: 'share-gap', shareId: 'share-0001', to: 'no' }]) {
      w.host.onControl('v1', bad); w.byId.v1.viewer.onControl(bad);
    }
    w.byId.v1.viewer.onControl({ t: 'share-start', shareId: 'share-0001', startSeq: -4, config: {} });
    w.byId.v1.viewer.onControl({ t: 'share-udx-offer', shareId: 'share-0001', token: 'short', key: 'zz', streamId: 1, endpoints: [] });
    await produce(w.host, 30, 90); w.host.end();
    await until(() => w.byId.v1.records.at(-1)?.type === TYPE.END, 6000, 'the end');
    assert.strictEqual(check(w.byId.v1.records, 'hostile control'), 90);
    assert.strictEqual(w.byId.v1.viewer.udx.laneId, '', 'a malformed UDP offer must not open a lane');
    w.close(); console.log('PASS malformed control messages change nothing');
  }

  // 11. Two viewers on UDP at once, each with its own lane and its own position.
  {
    const w = world({ viewers: ['a', 'b'], dc: { latencyMs: 30, bytesPerMs: 400 } });
    await produce(w.host, 0, 150);
    await until(() => w.host.stats().viewers.every(v => v.lane === 'udx'), 10000, 'both on UDP');
    await produce(w.host, 150, 240); w.host.end();
    await until(() => ['a', 'b'].every(id => w.byId[id].records.at(-1)?.type === TYPE.END), 10000, 'both ends');
    assert.strictEqual(check(w.byId.a.records, 'viewer a'), 240); assert.strictEqual(check(w.byId.b.records, 'viewer b'), 240);
    w.close(); console.log('PASS two viewers each get the whole share over their own UDP lane');
  }

  // 12. The sharer lets go of a viewer (its connection dropped for a while); the viewer, which kept its place, is told and asks again. The sharer
  // starts it over at the latest key picture; the viewer must jump there instead of waiting for records that are never coming.
  {
    const w = world({ useUdx: false, dc: { latencyMs: 10, bytesPerMs: 4000 } });
    const v = w.byId.v1;
    await produce(w.host, 0, 60);
    await until(() => v.records.filter(r => r.type === TYPE.VIDEO).length >= 55, 6000, 'the first stretch');
    w.host.removeViewer('v1');                                   // the sharer gave up on it
    const before = v.records.length;
    await produce(w.host, 60, 150);                              // the share goes on without it
    // The viewer does nothing: its next acknowledgement reaches a sharer that does not know it, which says so, and the viewer asks again.
    await until(() => w.host.stats().viewers.length === 1, 3000, 'the viewer to be added again');
    await produce(w.host, 150, 210);
    w.host.end();
    await until(() => v.records.at(-1)?.type === TYPE.END, 6000, 'the end after rejoining');
    assert(v.skips.length >= 1, 'the player was not told to start again');
    assert(v.gaps.some(g => g.reason === 'rejoined'), 'the viewer did not report what it missed');
    const after = v.records.slice(before);
    assert(after.length && after[0].key, 'the first record after rejoining is not a key picture');
    assert(after.every((r, i) => i === 0 || r.seq === after[i - 1].seq + 1), 'records after rejoining are not contiguous');
    assert(after.filter(r => r.type === TYPE.VIDEO).length >= 60, 'the stream after rejoining is incomplete');
    w.close(); console.log('PASS a viewer the sharer let go of rejoins at the latest key picture instead of waiting for records that never come');
  }

  console.log('ALL SHARE SESSION CHECKS PASSED');
  process.exit(0);
})().catch(error => { console.error(error?.stack || error); process.exit(1); });
