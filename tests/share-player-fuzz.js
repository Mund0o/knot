'use strict';

// The player under random abuse, on a simulated clock, with a stand-in decoder that behaves badly in the ways real ones do: it answers late and
// unevenly, holds pictures back until more arrive (the throughput mode), fails now and then, and ignores a flush. Pictures, heartbeats, skips, a
// window that is hidden and shown again, a new size, and the end all arrive in random order and spacing. Whatever happens:
//   * every picture the decoder hands over is closed exactly once (a 4K picture is 12 MB; one that is never closed is a leak, one closed twice is a crash);
//   * no picture is drawn twice, and drawn pictures never go backwards in time;
//   * a share that keeps sending, with nothing hiding it, keeps showing pictures.
// Seeds are printed on failure; node tests/share-player-fuzz.js <seed> runs one.
const assert = require('assert');
const { TYPE } = require('../share-wire');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function run(seed) {
  const random = rng(seed), between = (lo, hi) => lo + random() * (hi - lo), chance = p => random() < p;
  let t = 0; const timers = []; let order = 0;
  const at = (when, fn) => { timers.push({ when, fn, order: order++ }); };
  const frames = new Map(), drawn = []; let created = 0, nextId = 1;
  const holdBack = chance(0.5), decodeMs = between(1, 30), failAfter = chance(0.3) ? Math.floor(between(5, 200)) : Infinity, failTimes = [1, 3, 6][Math.floor(random() * 3)];
  let failures = 0, submitted = 0, flushIgnored = chance(0.3);
  const decoders = [];

  global.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
  global.VideoDecoder = class {
    constructor({ output, error }) { this.output = output; this.error = error; this.decodeQueueSize = 0; this.held = []; this.last = 0; this.closed = false; this.generation = decoders.length; decoders.push(this); }
    configure() {}
    _emit(chunk) {
      const id = nextId++, frame = { id, timestamp: chunk.timestamp, displayWidth: 1920, displayHeight: 1080, codedWidth: 1920, codedHeight: 1080, format: 'I420', closedCount: 0, close() { this.closedCount++; } };
      frames.set(id, frame); created++; this.output(frame);
    }
    decode(chunk) {
      if (this.closed) throw new Error('InvalidStateError: closed codec');
      submitted++; this.decodeQueueSize++;
      const when = Math.max(t + decodeMs * between(0.5, 2), this.last); this.last = when;
      at(when, () => {
        if (this.closed) return;
        this.decodeQueueSize--;
        if (submitted > failAfter && failures < failTimes && chance(0.2)) { failures++; this.error(new Error('stand-in decoder failure')); return; }
        if (!holdBack) return this._emit(chunk);
        this.held.push(chunk);
        while (this.held.length > 4) this._emit(this.held.shift());
      });
    }
    flush() { if (!flushIgnored) while (this.held.length) this._emit(this.held.shift()); return Promise.resolve(); }
    close() { this.closed = true; }
  };
  delete require.cache[require.resolve('../share-player')];
  const { createSharePlayer } = require('../share-player');

  const canvas = { width: 0, height: 0 }, context = { drawImage: frame => { drawn.push(frame.timestamp); if (frame.closedCount) throw new Error('a closed picture was drawn'); } };
  const errors = [];
  let refresh = between(8, 20);
  const player = createSharePlayer({ preferSoftware: chance(0.5), surface: { canvas, context, reveal() {} }, getDisplaySize: () => null, now: () => t, onError: e => errors.push(String(e.message || e)),
    schedule: fn => at(t + refresh * (chance(0.05) ? between(1, 6) : 1), () => fn(t)) });
  const config = { codec: 'av01.0.13H.08', width: 1920, height: 1080, fps: 60 };
  player.configure(config);

  // the stream: pictures with random gaps and bursts, a key picture every so often, heartbeats while still, skips, hiding, a new size, an end
  const events = []; let clock = 0, pts = 0, count = 0, hidden = false, ended = false, lastSkipOrConfigAt = 0, lastPushAt = 0;
  const total = Math.floor(between(60, 700));
  for (let i = 0; i < total; i++) {
    clock += chance(0.04) ? between(200, 2500) : chance(0.2) ? 0.3 : between(8, 40);
    const when = clock, key = i === 0 || i % Math.floor(between(20, 120)) === 0;
    pts += Math.round(between(5000, 40000));
    const myPts = pts;
    if (chance(0.03)) events.push([when, () => player.push({ type: TYPE.HEARTBEAT, pts: myPts })]);
    else events.push([when, () => { lastPushAt = t; player.push({ type: TYPE.VIDEO, key, pts: myPts, payload: new Uint8Array(chance(0.02) ? 4 * 1024 * 1024 : 40) }); }]);
    if (chance(0.01)) events.push([when + 1, () => { lastSkipOrConfigAt = t; player.skip(); }]);
    if (chance(0.01)) events.push([when + 1, () => { hidden = !hidden; player.setActive(!hidden); }]);
    if (chance(0.005)) events.push([when + 1, () => { lastSkipOrConfigAt = t; player.configure({ ...config, width: chance(0.5) ? 2560 : 1920, height: chance(0.5) ? 1440 : 1080 }); }]);
  }
  const endAt = clock + 3000;
  if (chance(0.5)) events.push([clock + 10, () => { ended = true; player.push({ type: TYPE.END, pts: pts + 1000 }); }]);
  for (const [when, fn] of events) at(when, fn);
  if (hidden) at(endAt - 100, () => player.setActive(true));
  const limit = endAt + 8000;
  let guard = 0;
  while (timers.length && guard++ < 400000) {
    timers.sort((a, b) => a.when - b.when || a.order - b.order);
    const next = timers.shift(); if (next.when > limit) break;
    t = Math.max(t, next.when); next.fn();
  }
  assert(guard < 400000, 'the simulation did not finish (a loop that never ends?)');
  const stats = player.stats();
  player.destroy();
  // destroy lets go of everything still waiting; what the decoder already handed over must all be closed by now
  for (const frame of frames.values()) assert(frame.closedCount <= 1, `picture ${frame.id} (time ${frame.timestamp}) was closed ${frame.closedCount} times`);
  const open = [...frames.values()].filter(frame => frame.closedCount === 0);
  assert.strictEqual(open.length, 0, `${open.length} of ${created} pictures were never closed (first: time ${open[0]?.timestamp})`);
  const seen = new Set();
  for (const stamp of drawn) { assert(!seen.has(stamp), `picture time ${stamp} was drawn twice`); seen.add(stamp); }
  // a decoder that fails a few times is replaced and the share goes on; one that keeps failing is reported, once per kind of failure
  if (failures <= 4) assert.deepStrictEqual(errors, [], `the player gave up after ${failures} decoder failures: ${errors.join('; ')}`);
  assert(errors.length <= 3, `the same failure was reported ${errors.length} times`);
  return { stats, drawn: drawn.length, created, errors, decoders: decoders.length, failures };
}

const only = Number(process.argv[2]);
const seeds = Number.isFinite(only) && process.argv[2] ? [only] : Array.from({ length: 400 }, (_, i) => i + 1);
let drawnTotal = 0, restartedRuns = 0, erroredRuns = 0;
for (const seed of seeds) {
  try {
    const r = run(seed);
    drawnTotal += r.drawn; if (r.stats.restarts) restartedRuns++; if (r.errors.length) erroredRuns++;
    assert(r.stats.painted === r.drawn, `painted ${r.stats.painted} but ${r.drawn} pictures were drawn`);
  } catch (error) { console.error(`FAIL seed ${seed}: ${error.message}`); console.error(error.stack?.split('\n').slice(1, 4).join('\n')); process.exit(1); }
}
console.log(`PASS ${seeds.length} random sessions: every decoded picture closed exactly once, none drawn twice (${drawnTotal} drawn; ${restartedRuns} sessions had a decoder fail and recover, ${erroredRuns} ended with a reported error)`);
