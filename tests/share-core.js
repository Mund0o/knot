'use strict';

const assert = require('assert');
const { MAGIC, HEADER, TYPE, FLAG, encodeRecord, RecordParser } = require('../share-wire');
const { ShareSender, ShareReceiver } = require('../share-core');

// ---------------------------------------------------------------------------------------------- wire format
function bytesOf(seq, size) { const out = new Uint8Array(size); for (let i = 0; i < size; i++) out[i] = (seq * 31 + i * 7) & 0xff; return out; }
function sameBytes(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }

{
  const record = { type: TYPE.VIDEO, flags: FLAG.KEY, config: 3, seq: 70000, pts: 1234567.5, payload: bytesOf(5, 1000) };
  const wire = encodeRecord(record);
  assert.strictEqual(wire.length, HEADER + 1000);
  assert.strictEqual(wire[0], MAGIC);
  const parsed = new RecordParser().push(wire);
  assert.strictEqual(parsed.length, 1);
  assert.deepStrictEqual({ type: parsed[0].type, config: parsed[0].config, seq: parsed[0].seq, pts: parsed[0].pts, key: parsed[0].key }, { type: TYPE.VIDEO, config: 3, seq: 70000, pts: 1234567.5, key: true });
  assert(sameBytes(parsed[0].payload, record.payload));
  console.log('PASS a record survives encode and parse unchanged');
}

{
  // Every way of cutting a byte stream into pieces gives the same records, down to one byte at a time.
  const records = []; for (let i = 0; i < 40; i++) records.push({ type: TYPE.VIDEO, flags: i % 7 === 0 ? FLAG.KEY : 0, seq: i, pts: i * 16666.7, payload: bytesOf(i, i === 0 ? 0 : (i * 977) % 5000) });
  const whole = Buffer.concat(records.map(r => Buffer.from(encodeRecord(r))));
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
  for (const mode of ['byte', 'random', 'big', 'header-split']) {
    const parser = new RecordParser(), got = [];
    for (let at = 0; at < whole.length;) {
      const size = mode === 'byte' ? 1 : mode === 'big' ? 100000 : mode === 'header-split' ? (at % 2 ? 19 : 3) : 1 + Math.floor(rnd() * 3000);
      got.push(...parser.push(new Uint8Array(whole.subarray(at, at + size)))); at += size;
    }
    assert.strictEqual(got.length, records.length, mode);
    got.forEach((record, i) => { assert.strictEqual(record.seq, i); assert(sameBytes(record.payload, records[i].payload), mode + ' payload ' + i); });
    assert.strictEqual(parser.buffered, 0);
  }
  console.log('PASS records come out the same however the bytes are cut up');
}

{
  const good = encodeRecord({ type: TYPE.VIDEO, seq: 1, payload: bytesOf(1, 10) });
  const badMagic = Uint8Array.from(good); badMagic[0] = 0;
  assert.throws(() => new RecordParser().push(badMagic), /bad magic/);
  const badType = Uint8Array.from(good); badType[1] = 99;
  assert.throws(() => new RecordParser().push(badType), /unknown record type/);
  const huge = Uint8Array.from(good); new DataView(huge.buffer).setUint32(4, 0xffffffff);
  assert.throws(() => new RecordParser().push(huge), /too large/);
  assert.throws(() => encodeRecord({ type: 77, seq: 1 }), /unknown record type/);
  assert.throws(() => encodeRecord({ type: TYPE.VIDEO, seq: -1 }), /seq/);
  console.log('PASS a corrupt stream is refused, not guessed at');
}

// ---------------------------------------------------------------------------------------------- simulated world
class World {
  constructor(seed = 1) { this.time = 0; this.queue = []; this.seq = 0; this.rng = seed >>> 0 || 1; }
  random() { this.rng = (this.rng * 1664525 + 1013904223) >>> 0; return this.rng / 0x100000000; }
  now() { return this.time; }
  at(delay, fn) { const item = { at: this.time + Math.max(0, delay), fn, id: ++this.seq, live: true }; this.queue.push(item); return item; }
  advance(ms) {
    const until = this.time + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0]; if (!next || next.at > until) break;
      this.queue.shift(); this.time = next.at; if (next.live) next.fn();
    }
    this.time = until;
  }
}

// A lane: bytes written to it arrive later, in order, in pieces of random size, at no more than `bytesPerMs`.
class SimLane {
  constructor(world, receiver, laneId, { latencyMs = 40, bytesPerMs = 1e9, highWater = 256 * 1024, dropRecord = null } = {}) {
    Object.assign(this, { world, receiver, laneId, latencyMs, bytesPerMs, highWater, dropRecord });
    this.queued = 0; this.wireFreeAt = 0; this.dead = false; this.sender = null; this.viewerId = null; this.blocked = false; this.written = 0;
  }
  attachTo(sender, viewerId, kind) { this.sender = sender; this.viewerId = viewerId; sender.attachLane(viewerId, this.laneId, { kind, write: bytes => this.write(bytes), close: () => { this.dead = true; } }); }
  write(bytes) {
    if (this.dead) throw new Error('lane is closed');
    this.written += bytes.length;
    if (this.dropRecord && this.dropRecord(bytes)) return true;          // lost without a trace (a bug in a lane, or a reset mid-flight)
    const start = Math.max(this.world.time, this.wireFreeAt), done = start + bytes.length / this.bytesPerMs;
    this.wireFreeAt = done; this.queued += bytes.length;
    this.world.at(done + this.latencyMs - this.world.time, () => {
      this.queued -= bytes.length;
      if (this.dead) return;                                              // a lane that died takes whatever was in flight with it
      for (let at = 0; at < bytes.length;) { const size = 1 + Math.floor(this.world.random() * 20000); this.receiver.pushBytes(this.laneId, bytes.subarray(at, at + size)); at += size; }
      if (this.blocked && this.queued < this.highWater / 2) { this.blocked = false; this.sender?.laneWritable(this.viewerId, this.laneId); }
    });
    if (this.queued >= this.highWater) { this.blocked = true; return false; }
    return true;
  }
  kill() { if (this.dead) return; this.dead = true; this.sender?.removeLane(this.viewerId, this.laneId); this.receiver.removeLane(this.laneId); }
}

// One sharer, one viewer, the control messages between them delayed by `controlMs`.
function session(world, { fps = 60, keyEvery = 30, frameBytes = 4000, keyBytes = 20000, controlMs = 30, senderOptions = {}, receiverOptions = {} } = {}) {
  const events = [], delivered = [], gaps = [], stuck = [];
  const sender = new ShareSender({ now: () => world.now(), emit: event => { events.push(event); if (event.type === 'gap') world.at(controlMs, () => receiver.skipTo(event.to + 1)); }, ...senderOptions });
  const receiver = new ShareReceiver({ now: () => world.now(), onRecord: record => delivered.push(record), onGap: gap => gaps.push(gap), onStuck: expected => { stuck.push(expected); world.at(controlMs, () => sender.onResend('v')); }, ...receiverOptions });
  sender.setConfig({ codec: 'av01.0.13H.08', width: 3840, height: 2160 });
  let frame = 0;
  const produce = () => {
    const key = frame % keyEvery === 0;
    sender.pushFrame({ key, pts: frame * (1e6 / fps), data: bytesOf(frame, key ? keyBytes : frameBytes) });
    frame++;
  };
  const join = () => { const offer = sender.addViewer('v'); receiver.start(offer.startSeq); return offer; };
  // The viewer acknowledges what it has, tells the sharer when it is stuck.
  const ackTimer = () => { world.at(100, () => { const seq = receiver.ackSeq; world.at(controlMs, () => sender.onAck('v', seq)); receiver.tick(); sender.tick(); ackTimer(); }); };
  ackTimer();
  const runFor = (ms) => { for (let spent = 0; spent < ms; spent += 1000 / fps) { produce(); world.advance(1000 / fps); } };
  return { sender, receiver, events, delivered, gaps, stuck, produce, join, runFor, get frames() { return frame; } };
}

function assertExact(delivered, from, to, label) {
  assert(delivered.length, label + ': nothing delivered');
  assert.strictEqual(delivered[0].seq, from, label + ': first seq');
  delivered.forEach((record, i) => {
    assert.strictEqual(record.seq, from + i, label + ': seq ' + i);
    if (record.type === TYPE.VIDEO) assert(sameBytes(record.payload, bytesOf(record.seq, record.key ? 20000 : 4000)), label + ': payload of ' + record.seq);
  });
  assert.strictEqual(delivered.at(-1).seq, to, label + ': last seq');
}

// ---------------------------------------------------------------------------------------------- scenarios
{
  const world = new World(11), s = session(world);
  s.join();
  new SimLane(world, s.receiver, 'dc', { latencyMs: 40 }).attachTo(s.sender, 'v', 'dc');
  s.runFor(5000); s.sender.end(); world.advance(3000);
  assertExact(s.delivered, 0, s.frames, 'single lane');
  assert.strictEqual(s.delivered.at(-1).type, TYPE.END);
  assert.strictEqual(s.gaps.length, 0);
  console.log('PASS one lane delivers every picture, whole, in order, then the end');
}

{
  // The link carries less than the sharer produces: the viewer falls behind, nothing is thinned, memory follows the acknowledgements.
  const world = new World(12), s = session(world, { senderOptions: { maxBacklogMs: 120000 } });
  s.join();
  const produced = 4000 * 59 + 20000 * 2;                                   // bytes per second the source makes
  new SimLane(world, s.receiver, 'dc', { latencyMs: 40, bytesPerMs: produced / 1000 * 0.8 }).attachTo(s.sender, 'v', 'dc');
  s.runFor(10000);
  const peak = s.sender.stats().behind ?? s.sender.stats().viewers[0].behind;
  assert(peak > 60, 'the viewer should be well behind, was ' + peak);
  assert(s.delivered.length < s.frames, 'not everything can have arrived yet');
  s.sender.end(); world.advance(120000);
  assertExact(s.delivered, 0, s.frames, 'slow link');
  assert.strictEqual(s.gaps.length, 0, 'a slow link must not cause a gap');
  assert(s.sender.stats().records <= 1, 'the sharer frees everything once it is acknowledged: ' + s.sender.stats().records);
  console.log('PASS a link slower than the source delays the viewer but costs it nothing');
}

{
  const world = new World(13), s = session(world);
  for (let i = 0; i < 100; i++) s.produce();                                // keys at 0, 30, 60, 90
  const offer = s.join();
  assert.strictEqual(offer.startSeq, 90);
  assert.strictEqual(offer.configVersion, 0);
  new SimLane(world, s.receiver, 'dc').attachTo(s.sender, 'v', 'dc');
  s.runFor(2000); s.sender.end(); world.advance(2000);
  assert(s.delivered[0].key, 'a viewer must start on a key picture');
  assertExact(s.delivered, 90, s.frames, 'late join');
  console.log('PASS a viewer who joins halfway starts at the latest key picture and then catches up');
}

{
  // Starts on the data channel, moves to the UDP lane when it is ready, loses the UDP lane with data in flight, and ends on the data channel.
  const world = new World(14), s = session(world);
  s.join();
  new SimLane(world, s.receiver, 'dc', { latencyMs: 60, bytesPerMs: 400 }).attachTo(s.sender, 'v', 'dc');
  s.runFor(3000);
  const udp = new SimLane(world, s.receiver, 'udx', { latencyMs: 30 }); udp.attachTo(s.sender, 'v', 'udx');
  assert.strictEqual(s.sender.stats().viewers[0].lane, 'udx');
  s.runFor(4000);
  udp.kill();                                                                // everything it had not delivered is gone
  assert.strictEqual(s.sender.stats().viewers[0].lane, 'dc');
  s.runFor(4000); s.sender.end(); world.advance(30000);
  assertExact(s.delivered, 0, s.frames, 'lane switch');
  assert(s.receiver.duplicates > 0, 'the switch resends what was unconfirmed, and the viewer must have dropped those copies');
  assert.strictEqual(s.gaps.length, 0);
  assert.strictEqual(s.stuck.length, 0, 'a lane switch must resend what was unconfirmed by itself; the viewer should never have had to ask (asked at ' + s.stuck + ')');
  console.log('PASS switching lanes and losing one with data in flight loses nothing');
}

{
  // A record vanishes inside a lane that stays open. The viewer notices it is stuck and asks again.
  const world = new World(15), s = session(world, { receiverOptions: { stuckMs: 800 } });
  s.join();
  let dropped = false;
  new SimLane(world, s.receiver, 'dc', { dropRecord: bytes => { const seq = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8); if (seq === 70 && !dropped) { dropped = true; return true; } return false; } }).attachTo(s.sender, 'v', 'dc');
  s.runFor(6000); s.sender.end(); world.advance(15000);
  assert(dropped);
  assertExact(s.delivered, 0, s.frames, 'lost record');
  console.log('PASS a record lost inside an open lane is asked for again and recovered');
}

{
  // The viewer is hopelessly behind: it is moved to the live picture, told exactly what it missed, and then receives everything after.
  const world = new World(16), s = session(world, { senderOptions: { maxBacklogMs: 3000 } });
  s.join();
  new SimLane(world, s.receiver, 'dc', { latencyMs: 40, bytesPerMs: 100 }).attachTo(s.sender, 'v', 'dc');      // ~0.8 Mbit/s against ~2.5 Mbit/s produced
  s.runFor(12000);
  const gap = s.events.find(event => event.type === 'gap');
  assert(gap, 'a viewer 12 s behind a 3 s limit must have been moved up');
  assert.strictEqual(gap.reason, 'behind');
  assert(s.gaps.length >= 1, 'the viewer must have been told');
  // Everything the viewer delivered is contiguous except across the announced gaps, and it resumes on a key picture.
  let previous = null;
  for (const record of s.delivered) {
    if (previous !== null && record.seq !== previous + 1) {
      const covered = s.gaps.some(g => g.from <= previous + 1 && g.to >= record.seq - 1);
      assert(covered, `a hole between ${previous} and ${record.seq} that no gap announced`);
      assert(record.key, 'after a gap the viewer must resume on a key picture, got seq ' + record.seq);
    }
    previous = record.seq;
  }
  console.log('PASS a viewer too far behind is moved to a key picture and told what it missed');
}

{
  const world = new World(17), s = session(world, { senderOptions: { maxLogBytes: 3 * 1024 * 1024, maxBacklogMs: 600000 } });
  s.join();
  new SimLane(world, s.receiver, 'dc', { latencyMs: 40, bytesPerMs: 50 }).attachTo(s.sender, 'v', 'dc');
  s.runFor(30000);
  assert(s.events.some(event => event.type === 'gap' && event.reason === 'memory'), 'running out of memory must move the viewer up');
  assert(s.sender.stats().logBytes <= 3 * 1024 * 1024 * 1.2, 'the sharer must stay near its memory limit, at ' + s.sender.stats().logBytes);
  console.log('PASS memory stays bounded by moving a stalled viewer up, never by thinning pictures');
}

{
  const world = new World(18), s = session(world);
  s.join();
  const lane = new SimLane(world, s.receiver, 'dc'); lane.attachTo(s.sender, 'v', 'dc');
  s.runFor(2000);
  world.advance(40000);                                                      // the viewer's acknowledgements stop
  s.receiver.removeLane('dc');
  const silent = new World(19), t = session(silent, { senderOptions: { viewerTimeoutMs: 5000 } });
  t.join(); new SimLane(silent, t.receiver, 'dc', { latencyMs: 40 }).attachTo(t.sender, 'v', 'dc');
  t.sender.onAck = () => {};                                                 // a viewer that never answers
  t.runFor(8000);
  assert(t.events.some(event => event.type === 'viewer-timeout' && event.viewerId === 'v'));
  console.log('PASS a viewer that stops answering is reported');
}

{
  // Many random worlds: lanes appear and die, links vary, pieces are cut at random. Whatever happens, the viewer sees the
  // sharer's pictures in order and byte for byte, and only a declared gap can explain a missing one.
  let withGaps = 0, withSwitch = 0;
  for (let run = 1; run <= 120; run++) {
    const world = new World(1000 + run), s = session(world, { keyEvery: 20 + Math.floor(world.random() * 40), senderOptions: { maxBacklogMs: 1500 + Math.floor(world.random() * 20000) }, receiverOptions: { stuckMs: 600 + Math.floor(world.random() * 1500) } });
    const pre = Math.floor(world.random() * 80); for (let i = 0; i < pre; i++) s.produce();
    s.join();
    const lanes = [];
    const open = (id, kind) => { const lane = new SimLane(world, s.receiver, id + lanes.length, { latencyMs: 20 + world.random() * 200, bytesPerMs: 40 + world.random() * 3000, highWater: 64 * 1024 + world.random() * 400000 }); lane.attachTo(s.sender, 'v', kind); lanes.push(lane); return lane; };
    open('dc', 'dc');
    const total = 6000 + Math.floor(world.random() * 8000);
    for (let spent = 0; spent < total; spent += 50) {
      s.runFor(50);
      const roll = world.random();
      if (roll < 0.01) { open('udx', 'udx'); withSwitch++; }
      else if (roll < 0.02) { const live = lanes.filter(l => !l.dead); if (live.length > 1) live[Math.floor(world.random() * live.length)].kill(); }
    }
    if (!lanes.some(l => !l.dead)) open('dc', 'dc');
    s.sender.end(); world.advance(600000);
    // invariants
    let previous = null, lastSeq = -1;
    for (const record of s.delivered) {
      assert(record.seq > lastSeq, `run ${run}: seq went backwards`); lastSeq = record.seq;
      if (record.type === TYPE.VIDEO) assert(sameBytes(record.payload, bytesOf(record.seq, record.key ? 20000 : 4000)), `run ${run}: payload of ${record.seq} differs`);
      if (previous !== null && record.seq !== previous + 1) assert(s.gaps.some(g => g.from <= previous + 1 && g.to >= record.seq - 1), `run ${run}: hole ${previous}..${record.seq} with no gap`);
      previous = record.seq;
    }
    if (s.gaps.length) withGaps++;
    assert.strictEqual(s.delivered.at(-1)?.type, TYPE.END, `run ${run}: the share never reached its end (last seq ${s.delivered.at(-1)?.seq}, expected ${s.sender.nextSeq - 1}, pending ${s.receiver.pending.size})`);
  }
  console.log(`PASS 120 random worlds: pictures arrive in order and intact, holes only where declared (${withGaps} runs had a declared gap, ${withSwitch} lane switches)`);
}

{
  const world = new World(21), s = session(world);
  s.join();
  new SimLane(world, s.receiver, 'dc').attachTo(s.sender, 'v', 'dc');
  s.produce(); world.advance(50);
  const beat = s.sender.heartbeat(123456), after = s.sender.heartbeat(123789);
  s.produce(); s.sender.end(); world.advance(2000);
  assert.deepStrictEqual(s.delivered.map(r => r.type), [TYPE.VIDEO, TYPE.HEARTBEAT, TYPE.HEARTBEAT, TYPE.VIDEO, TYPE.END]);
  assert.strictEqual(s.delivered[1].pts, 123456);
  assert(beat >= 0 && after === beat + 1);
  assert.strictEqual(new ShareSender().heartbeat(1), -1, 'nothing to say before the first picture');
  console.log('PASS a still screen is told apart from a dead link by numbered heartbeats');
}

console.log('ALL SHARE CORE CHECKS PASSED');
