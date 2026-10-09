'use strict';

const assert = require('assert');
const { Playout } = require('../share-playout');

// A tiny simulated viewer: pictures arrive at times the test chooses (already decoded), the display refreshes every 1000/hz ms.
// Every picture ends up either shown or in the dropped list; nothing disappears.
function run({ fps = 60, hz = 60, seconds = 10, arrival = i => i * (1000 / fps) + 40, options = {}, heartbeats = () => false, beatEveryMs = 100, until = null }) {
  const playout = new Playout(options);
  const frames = Array.from({ length: Math.floor(seconds * fps) }, (_, i) => ({ i, pts: Math.round(i * 1e6 / fps), at: arrival(i) })).filter(f => f.at !== null);
  const beats = [];
  for (let t = 0; t < seconds * 1000; t += beatEveryMs) { const at = heartbeats(t); if (at !== false && at !== null) beats.push({ pts: t * 1000, at }); }
  const shown = [], dropped = [], states = [];
  let nextFrame = 0, nextBeat = 0;
  const end = until ?? seconds * 1000 + 30000;
  for (let now = 0; now <= end; now += 1000 / hz) {
    while (nextFrame < frames.length && frames[nextFrame].at <= now) { const f = frames[nextFrame++]; playout.addFrame(f.pts, f); if (nextFrame === frames.length) playout.finish(); }
    while (nextBeat < beats.length && beats[nextBeat].at <= now) playout.noteSource(beats[nextBeat++].pts);
    const result = playout.tick(now, { pending: 0 });
    if (result.present) shown.push({ frame: result.present, at: now });
    dropped.push(...result.dropped);
    states.push({ at: now, state: result.state, rate: result.rate, depthMs: result.depthMs, delayMs: result.delayMs });
  }
  assert.strictEqual(shown.length + dropped.length, frames.length, 'every picture is either shown or counted as skipped');
  return { playout, shown, dropped, states, frames };
}

{
  // A clean link: every picture is shown, once, in order, a steady distance behind its arrival, at exactly 1x.
  const r = run({});
  assert.strictEqual(r.shown.length, r.frames.length, 'every picture shown');
  assert.strictEqual(r.dropped.length, 0);
  assert.deepStrictEqual(r.shown.map(s => s.frame.i), r.frames.map(f => f.i), 'in order, none repeated');
  const lag = r.shown.slice(60).map(s => s.at - s.frame.pts / 1000);
  assert(Math.max(...lag) - Math.min(...lag) < 20, 'the delay between capture and display must be steady, varied by ' + (Math.max(...lag) - Math.min(...lag)));
  assert(r.states.every(s => s.rate === 1), 'a link that is on time is never sped up');
  assert.strictEqual(r.playout.stalls, 0);
  console.log('PASS a clean link shows every picture once, in order, at a steady delay and exactly 1x');
}

{
  // Joining in the middle of a group: pictures since the last key arrive in one burst. The viewer starts at the live edge, a
  // delay behind the newest, and from there shows every picture.
  const r = run({ seconds: 8, arrival: i => i < 126 ? 2140 : i * (1000 / 60) + 40 });
  assert.strictEqual(r.playout.stalls, 0);
  assert(r.playout.skippedAtStart > 90, 'the past is not shown, skipped ' + r.playout.skippedAtStart);
  const first = r.shown[0];
  const expectedStart = 125 - new Playout().delayMs / (1000 / 60);
  assert(Math.abs(first.frame.i - expectedStart) <= 6, 'it should start about one delay behind the newest, at picture ' + Math.round(expectedStart) + ', started at ' + first.frame.i);
  assert(r.shown.every((s, i, all) => i === 0 || s.frame.i === all[i - 1].frame.i + 1), 'from there on every picture is shown, consecutively');
  assert.strictEqual(r.playout.skipped, 0);
  assert.strictEqual(r.playout.jumps, 0);
  assert(r.states.every(s => s.rate === 1));
  console.log(`PASS a viewer who joins late starts at the live edge (skipped ${r.playout.skippedAtStart} old pictures) and then shows every picture`);
}

{
  // A jittery link: now and then a hiccup of 200-500 ms holds up everything behind it, then the lag drains at real time. The
  // first hiccups longer than the 250 ms starting delay stall it and teach it a bigger delay; after that there are no more.
  let seed = 5; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
  let lag = 0; const late = Array.from({ length: 2400 }, (_, i) => { lag = Math.max(0, lag - 1000 / 60); if (rnd() < 0.012) lag += 200 + rnd() * 300; return i * (1000 / 60) + 40 + lag; });
  const r = run({ seconds: 40, arrival: i => late[i] });
  assert(r.playout.stalls >= 1, 'a link this uneven must stall at first');
  const laterBuffering = r.states.filter(s => s.at > 25000 && s.state === 'buffering').length;
  assert.strictEqual(laterBuffering, 0, 'after it adapted it should not stall again, still buffering for ' + laterBuffering + ' refreshes');
  assert(r.playout.delayMs > 300, 'the delay should have grown past the longest hiccups, was ' + r.playout.delayMs);
  assert.strictEqual(r.playout.jumps, 0);
  assert(r.dropped.length <= r.frames.length * 0.03, 'a handful of skips while it settles at most, got ' + r.dropped.length);
  console.log(`PASS a jittery link teaches a bigger delay (${Math.round(r.playout.delayMs)} ms after ${r.playout.stalls} stall(s)); ${r.dropped.length} of ${r.frames.length} pictures skipped`);
}

{
  // The link dies for 3 s: the last picture stays, the viewer is told it is buffering, then it resumes in order. A lag this size is played
  // through gently, not jumped over.
  const r = run({ seconds: 12, arrival: i => { const natural = i * (1000 / 60) + 40; return natural >= 4000 && natural < 7000 ? 7000 + (natural - 4000) * 0.02 : natural; } });
  const buffering = r.states.filter(s => s.at > 4000 && s.at < 7000 && s.state === 'buffering');
  assert(buffering.length > 60, 'viewer should report buffering during the outage');
  assert.strictEqual(r.states.find(s => s.at > 9000).state, 'playing', 'and be playing again afterwards');
  assert.strictEqual(r.playout.stalls, 1);
  assert.strictEqual(r.playout.jumps, 0, 'a 3 s lag is played through');
  assert(r.states.some(s => s.at > 7000 && s.rate > 1 && s.rate <= 1.15), 'it recovers lag with a gentle speed-up');
  assert(r.shown.every((s, index, all) => index === 0 || s.frame.i > all[index - 1].frame.i), 'order kept');
  assert(r.dropped.length < r.frames.length * 0.1, 'only the speed-up skips pictures: ' + r.dropped.length);
  console.log(`PASS an outage shows buffering over the last picture and resumes in order (${r.dropped.length} pictures skipped by the gentle catch-up)`);
}

{
  // A very long outage: the lag is too large to play through, so the viewer jumps to the live edge, and says so.
  const r = run({ seconds: 20, arrival: i => { const natural = i * (1000 / 60) + 40; return natural >= 4000 && natural < 11000 ? 11000 + (natural - 4000) * 0.02 : natural; } });
  assert.strictEqual(r.playout.jumps, 1);
  const after = r.states.find(s => s.at > 14000);
  assert(after.depthMs < r.playout.delayMs + 300, 'after the jump it is back at the live edge, depth ' + after.depthMs.toFixed(0));
  console.log('PASS a lag too large to play through is jumped, once, and counted');
}

{
  // A still screen: no pictures for a long time, but the sharer's heartbeats keep arriving (one whenever 100 ms pass with nothing else sent,
  // comfortably inside the playout delay). That is not a stall.
  const r = run({ seconds: 20, arrival: i => { const natural = i * (1000 / 60) + 40; return natural < 3000 || natural > 15000 ? natural : null; }, heartbeats: t => t + 40 });
  assert.strictEqual(r.playout.stalls, 0, 'heartbeats must keep a still screen from looking like a dead link');
  assert(!r.states.some(s => s.at > 4000 && s.at < 15000 && s.state === 'buffering'));
  console.log('PASS a still screen is not mistaken for a stall while heartbeats arrive');
}

{
  // Heartbeats must come well inside the delay: a beat every 500 ms against a 250 ms buffer lets it drain between beats.
  const r = run({ seconds: 20, beatEveryMs: 500, arrival: i => { const natural = i * (1000 / 60) + 40; return natural < 3000 || natural > 15000 ? natural : null; }, heartbeats: t => t + 40 });
  assert(r.playout.stalls > 0, 'sparse heartbeats cannot hold a still screen; this is why the sender beats every 100 ms');
  console.log('PASS (documents the rule) heartbeats slower than the delay do not hold a still screen');
}

{
  // The same still screen with no heartbeats is indistinguishable from a dead link, and is reported as such.
  const r = run({ seconds: 20, arrival: i => { const natural = i * (1000 / 60) + 40; return natural < 3000 || natural > 15000 ? natural : null; } });
  assert(r.states.some(s => s.at > 4000 && s.at < 15000 && s.state === 'buffering'));
  console.log('PASS without heartbeats silence is reported as buffering');
}

{
  // A 120 fps source on a 60 Hz display: only the newest due picture is drawn at each refresh, and the rest are counted, not hidden.
  const r = run({ fps: 120, hz: 60, seconds: 6 });
  assert(r.playout.skipped > 0 && r.dropped.length === r.playout.skipped);
  assert(Math.abs(r.shown.length - 6 * 60) < 12, 'about one picture per refresh, got ' + r.shown.length);
  console.log('PASS a stream faster than the display is drawn at the display rate and the difference is counted');
}

{
  // A 144 Hz display loses nothing from a 60 fps stream.
  const r = run({ fps: 60, hz: 144, seconds: 6 });
  assert.strictEqual(r.dropped.length, 0);
  assert.strictEqual(r.shown.length, r.frames.length);
  console.log('PASS a faster display shows every picture of a slower stream');
}

{
  // A delay built up by a rough patch must not outlive it by minutes, and must not come down while the link keeps using it.
  const FPS = 60;
  // 40 s of overload (pictures arrive at 70% of real time, the sender moves the viewer up every ~8 s), then a perfect link: it used to take 232 s to get back under 250 ms
  const overload = new Playout(); let produced = 0, nextArrive = 0, peak = 0, back = -1;
  for (let now = 0; now < 600 * 1000; now += 1000 / 120) {
    const slow = now < 40000, live = Math.floor(now * FPS / 1000);
    while (nextArrive <= now) {
      if (slow) { if (produced < live - 8 * FPS) produced = live - 1; if (produced < live) { overload.addFrame(Math.round(produced * 1e6 / FPS), {}); produced++; } nextArrive += 1000 / (FPS * 0.7); }
      else { if (produced < live) { overload.addFrame(Math.round(produced * 1e6 / FPS), {}); produced++; } else produced = live; nextArrive += 1000 / FPS; }
    }
    overload.tick(now); peak = Math.max(peak, overload.delayMs); if (now > 40000 && back < 0 && overload.delayMs < 250) back = (now - 40000) / 1000;
  }
  assert(peak > 3000, 'the overload never built up a delay (peak ' + Math.round(peak) + ' ms)');
  assert(back > 0 && back < 70, `the delay took ${Math.round(back)} s to come back under 250 ms on a perfect link (a minute is plenty)`);
  // a link that keeps breaking up keeps its delay: random outages of 0.3-1.4 s about every 8 s for 10 minutes stall about once or twice a minute, as they always did
  const stalls = [1, 2, 3].map(seed => {
    let a = seed; const rnd = () => (a = (a * 1664525 + 1013904223) >>> 0) / 4294967296;
    const outages = []; for (let t = 5000; t < 600000; t += 3000 + rnd() * 10000) outages.push([t, t + 300 + rnd() * 1100]);
    const p = new Playout(); let made = 0, next = 0, held = [];
    for (let now = 0; now < 600000; now += 1000 / 120) {
      const live = Math.floor(now * FPS / 1000), down = outages.some(([x, y]) => now >= x && now < y);
      while (next <= now) { if (made < live) { const f = { pts: Math.round(made * 1e6 / FPS) }; made++; if (down) held.push(f); else { while (held.length) { const h = held.shift(); p.addFrame(h.pts, h); } p.addFrame(f.pts, f); } } next += 1000 / FPS; }
      p.tick(now);
    }
    return p.stalls / 10;
  });
  assert(stalls.every(perMinute => perMinute <= 2.2), 'a link that keeps breaking up stalled ' + stalls.join(', ') + ' times a minute (it was 1.7 to 2.2 before the delay came down faster)');
  console.log(`PASS a delay built up by overload (${Math.round(peak)} ms) is back under 250 ms ${Math.round(back)} s after the link recovers, and a link that keeps breaking up stalls ${stalls.join(', ')} times a minute`);
}

{
  // The delay creeps back down once the link has stayed calm for a while, but not below the floor, and costs few pictures.
  const p = new Playout({ startDelayMs: 1200, minDelayMs: 150, settleMs: 5000 });
  for (let now = 0, i = 0; now < 120000; now += 1000 / 60) {
    p.addFrame(Math.round(i * 1e6 / 60), { i }); i++;
    p.tick(now);
  }
  assert(p.delayMs < 1200 && p.delayMs >= 150, 'delay should have relaxed, is ' + p.delayMs);
  // Every millisecond of latency given back is a millisecond of pictures not shown: 1050 ms at 60 fps is about 63 pictures, over two minutes.
  assert(p.skipped <= Math.ceil((1200 - p.delayMs) * 60 / 1000) + 5, 'relaxing the delay should cost only what it gives back, skipped ' + p.skipped);
  console.log(`PASS the delay relaxes when the link stays calm (to ${Math.round(p.delayMs)} ms, ${p.skipped} pictures skipped over two minutes)`);
}

{
  // The clock waits for a decoder that is behind instead of racing past pictures that are about to come out. The newest picture is
  // far ahead, so a clock that ran anyway would visibly move.
  const p = new Playout({ startDelayMs: 100 });
  p.addFrame(0, 'first'); p.noteSource(600000);
  let t = 0; assert.strictEqual(p.tick(t).present, 'first');
  p.noteSource(3000000);
  t += 20; p.tick(t, { pending: 5 });
  const playhead = p.playhead;
  for (let i = 0; i < 30; i++) { t += 16.7; const result = p.tick(t, { pending: 5 }); assert.strictEqual(result.present, null); }
  assert.strictEqual(p.playhead, playhead, 'the clock must not advance while the decoder still owes pictures');
  assert.strictEqual(p.stalls, 0, 'a slow decoder is not a link stall');
  p.addFrame(Math.round(playhead) + 5000, 'next');
  t += 16.7; assert.strictEqual(p.tick(t, { pending: 0 }).present, 'next', 'and it resumes once the picture comes out');
  console.log('PASS the clock holds while the decoder catches up');
}

console.log('ALL SHARE PLAYOUT CHECKS PASSED');
