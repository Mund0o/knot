'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { ShareLaneRuntime } = require('../share-lane-runtime');

// Two runtimes in one process stand in for the sharer's and the viewer's main processes; the UDP between them is real
// (loopback), and so are the token, the proofs and the AES-GCM framing.
const LOCAL = { allowLoopback: true, advertiseHosts: ['127.0.0.1'], stunServers: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hex = bytes => crypto.randomBytes(bytes).toString('hex');

function runtime(label, options = {}) {
  const events = { open: [], frames: [], close: [] };
  const rt = new ShareLaneRuntime({
    udxOptions: LOCAL, sameOwner: (a, b) => a.id === b.id,
    onOpen: event => events.open.push(event), onFrame: event => events.frames.push(event), onClose: event => events.close.push(event), ...options,
  });
  return { rt, events, label };
}

async function connectPair({ key = crypto.randomBytes(32), viewerKey = key, maxPeers = 16 } = {}) {
  const sharer = runtime('sharer', { maxPeers }), viewer = runtime('viewer', { maxPeers });
  const ownerS = { id: 'sharer-doc' }, ownerV = { id: 'viewer-doc' };
  const laneS = await sharer.rt.open(ownerS), laneV = await viewer.rt.open(ownerV);
  const token = hex(24);                                               // the same shape the app uses: 48 hex characters
  assert(viewer.rt.register(ownerV, token, Buffer.from(viewerKey)));
  const accepting = viewer.rt.establish(ownerV, { laneId: laneV.id, role: 'accept', token, remote: laneS, timeoutMs: 6000, holdMs: 0 });
  const connecting = sharer.rt.establish(ownerS, { laneId: laneS.id, role: 'connect', token, key: Buffer.from(key), remote: laneV, timeoutMs: 6000, holdMs: 0 });
  const [peerS] = await Promise.all([connecting, accepting]);
  for (let waited = 0; !viewer.events.open.length && waited < 3000; waited += 20) await sleep(20);
  return { sharer, viewer, ownerS, ownerV, laneS, laneV, peerS, peerV: viewer.events.open[0]?.peerId, token };
}

(async () => {
  // 1. A real connection carries bytes both ways, intact and in order, with backpressure.
  {
    const p = await connectPair();
    assert(p.peerS && p.peerV, 'both sides must end up with a peer');
    assert.strictEqual(p.viewer.events.open[0].token, p.token);
    const sent = crypto.randomBytes(24 * 1024 * 1024), pieces = [];
    for (let at = 0; at < sent.length; at += 1024 * 1024) pieces.push(new Uint8Array(sent.subarray(at, at + 1024 * 1024)));
    const started = Date.now();
    for (const piece of pieces) await p.sharer.rt.send(p.ownerS, p.peerS, piece);
    for (let waited = 0; waited < 20000; waited += 20) { const got = p.viewer.events.frames.reduce((n, e) => n + e.frame.length, 0); if (got >= sent.length) break; await sleep(20); }
    const received = Buffer.concat(p.viewer.events.frames.map(e => Buffer.from(e.frame)));
    assert.strictEqual(received.length, sent.length);
    assert(received.equals(sent), 'bytes arrived changed');
    p.viewer.rt.credit(p.ownerV, p.peerV, received.length);
    // and back: the viewer's small acknowledgements reach the sharer
    for (let i = 0; i < 20; i++) await p.viewer.rt.send(p.ownerV, p.peerV, Buffer.from('ack' + i));
    for (let waited = 0; p.sharer.events.frames.length < 20 && waited < 3000; waited += 20) await sleep(20);
    assert.deepStrictEqual(p.sharer.events.frames.map(e => Buffer.from(e.frame).toString()), Array.from({ length: 20 }, (_, i) => 'ack' + i));
    // the stream's own numbers, as the share log records them
    const stats = p.sharer.rt.stats();
    assert.strictEqual(stats.length, 1, 'one lane, one line of numbers');
    for (const key of ['cwnd', 'rttMs', 'inflight', 'retransmits', 'fastRecoveries', 'timeouts', 'bandwidthMbps']) assert(Number.isFinite(stats[0][key]) && stats[0][key] >= 0, `lane stat ${key} is ${stats[0][key]}`);
    assert(stats[0].cwnd > 0 && stats[0].bandwidthMbps >= 0 && /^[0-9a-f]{6}$/.test(stats[0].id), 'lane stats are not sensible: ' + JSON.stringify(stats[0]));
    console.log(`PASS 24 MiB crossed a real UDP lane intact and in order (${Math.round(24 * 8 / ((Date.now() - started) / 1000))} Mbit/s on loopback), acknowledgements came back`);
    p.sharer.rt.close(); p.viewer.rt.close();
  }

  // 2. The wrong key never produces a connection, on either side.
  {
    const sharer = runtime('sharer'), viewer = runtime('viewer');
    const ownerS = { id: 's' }, ownerV = { id: 'v' };
    const laneS = await sharer.rt.open(ownerS), laneV = await viewer.rt.open(ownerV), token = hex(24);
    viewer.rt.register(ownerV, token, crypto.randomBytes(32));
    const accepting = viewer.rt.establish(ownerV, { laneId: laneV.id, role: 'accept', token, remote: laneS, timeoutMs: 4000, holdMs: 0 }).catch(() => 'refused');
    await assert.rejects(sharer.rt.establish(ownerS, { laneId: laneS.id, role: 'connect', token, key: crypto.randomBytes(32), remote: laneV, timeoutMs: 4000, holdMs: 0 }), /authentication failed|timed out|closed|reset/);
    await accepting; await sleep(200);
    assert.strictEqual(viewer.events.open.length, 0, 'a peer with the wrong key must never be opened');
    assert.strictEqual(sharer.rt.peers.size, 0);
    sharer.rt.close(); viewer.rt.close();
    console.log('PASS a lane with the wrong key never connects');
  }

  // 3. One document cannot use, close or read another's lanes.
  {
    const p = await connectPair(), intruder = { id: 'someone-else' };
    await assert.rejects(p.sharer.rt.send(intruder, p.peerS, Buffer.from('x')), /unknown share lane/);
    p.sharer.rt.closePeer(intruder, p.peerS);
    assert(p.sharer.rt.peers.has(p.peerS), 'a foreign document must not be able to close a peer');
    assert.strictEqual(p.sharer.rt.closeLane(intruder, p.laneS.id), false);
    await assert.rejects(p.sharer.rt.establish(intruder, { laneId: p.laneS.id, role: 'connect', token: hex(24), key: crypto.randomBytes(32), remote: p.laneV }), /invalid share lane request/);
    p.sharer.rt.credit(intruder, p.peerS, 1000);
    assert.strictEqual(p.sharer.rt.release(intruder, p.laneS.id), false);
    p.sharer.rt.close(); p.viewer.rt.close();
    console.log('PASS another document cannot touch a share lane');
  }

  // 4. Closing an owner closes its peers on both ends, and the viewer is told.
  {
    const p = await connectPair();
    p.sharer.rt.closeOwner(p.ownerS);
    for (let waited = 0; !p.viewer.events.close.length && waited < 5000; waited += 20) await sleep(20);
    assert.strictEqual(p.sharer.events.close.length, 1);
    assert.strictEqual(p.viewer.events.close.length, 1, 'the far end must notice the lane is gone');
    assert.strictEqual(p.sharer.rt.peers.size, 0);
    p.sharer.rt.close(); p.viewer.rt.close();
    console.log('PASS closing a document closes its lanes and the far end hears about it');
  }

  // 5. The number of lanes is bounded.
  {
    const p = await connectPair({ maxPeers: 1 });
    const extra = await p.sharer.rt.open(p.ownerS).catch(error => error);
    assert(extra instanceof Error && /too many/.test(extra.message), 'a second lane over the limit must be refused: ' + (extra?.message || 'it was allowed'));
    p.sharer.rt.close(); p.viewer.rt.close();
    console.log('PASS the number of lanes is limited');
  }

  // 6. A frame larger than the transport allows is refused up front rather than killing the lane.
  {
    const p = await connectPair();
    await assert.rejects(p.sharer.rt.send(p.ownerS, p.peerS, new Uint8Array(8 * 1024 * 1024 + 1)), /invalid share frame/);
    await assert.rejects(p.sharer.rt.send(p.ownerS, p.peerS, new Uint8Array(0)), /invalid share frame/);
    await p.sharer.rt.send(p.ownerS, p.peerS, Buffer.from('still works'));
    for (let waited = 0; !p.viewer.events.frames.length && waited < 3000; waited += 20) await sleep(20);
    assert.strictEqual(Buffer.from(p.viewer.events.frames[0].frame).toString(), 'still works');
    p.sharer.rt.close(); p.viewer.rt.close();
    console.log('PASS an oversized frame is refused and the lane carries on');
  }

  console.log('ALL SHARE LANE CHECKS PASSED');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
