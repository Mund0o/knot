'use strict';

const assert = require('assert');
const { CallControl, BEAT_MS, TTL_MS, END_GUARD_MS } = require('../call-control');

// A fake clock and a fake network between two people, so every ordering of messages can be replayed.
class World {
  constructor(seed = 1) { this.time = 0; this.queue = []; this.seq = 0; this.rng = seed; this.cut = new Set(); }
  random() { this.rng = (this.rng * 1664525 + 1013904223) >>> 0; return this.rng / 0x100000000; }
  now() { return this.time; }
  setTimer(fn, ms) { const item = { at: this.time + ms, fn, id: ++this.seq }; this.queue.push(item); return item; }
  clearTimer(item) { const index = this.queue.indexOf(item); if (index >= 0) this.queue.splice(index, 1); }
  // Delivers a message later, never out of order for the same sender (the Worker keeps each socket's order).
  deliver(fromKey, fn, delay) { const last = (this.lastAt ||= {})[fromKey] || 0; const at = Math.max(last, this.time + delay); this.lastAt[fromKey] = at; this.queue.push({ at, fn, id: ++this.seq }); }
  advance(ms) {
    const until = this.time + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0]; if (!next || next.at > until) break;
      this.queue.shift(); this.time = next.at; next.fn();
    }
    this.time = until;
  }
}

function person(world, id, sessionName, events) {
  const control = new CallControl({
    now: () => world.now(), setTimer: (fn, ms) => world.setTimer(fn, ms), clearTimer: item => world.clearTimer(item),
    newSession: () => sessionName, publish: (peer, active, session) => { control.sent.push([active, session]); if (control.link) control.link(peer, active, session); return !control.offline; },
    onChange: event => events.push(event.type),
  });
  control.sent = []; control.offline = false;
  return control;
}

function pair(world, delay = () => 30) {
  const eventsA = [], eventsB = [];
  const a = person(world, 'a', 'aaaa01', eventsA), b = person(world, 'b', 'bbbb02', eventsB);
  a.link = (_peer, active, session) => world.deliver('a', () => b.receive('a', active, session), delay());
  b.link = (_peer, active, session) => world.deliver('b', () => a.receive('b', active, session), delay());
  return { a, b, eventsA, eventsB };
}

// ---- starting, beating, leaving
{
  const world = new World(), { a, b, eventsB } = pair(world);
  assert.strictEqual(a.press('b'), 'started');
  assert.deepStrictEqual(a.sent[0], [true, 'aaaa01']);
  assert.strictEqual(a.press('b'), 'ignored'); assert.ok(a.inCall, 'a second click right after starting hung up');
  world.advance(100);
  assert.ok(b.remoteActive('a') && eventsB.includes('ring-in'), 'the friend was not told about the call');
  assert.deepStrictEqual(b.view('a'), { state: 'incoming', button: 'join' });
  assert.deepStrictEqual(a.view('b'), { state: 'calling', button: 'end' });
  world.advance(BEAT_MS * 3 + 100);
  assert.ok(a.sent.filter(entry => entry[0]).length >= 4, 'presence was not repeated while in the call');
  assert.ok(b.remoteActive('a'), 'a repeated presence line expired');
  assert.strictEqual(a.press('b'), 'left'); assert.ok(!a.inCall);
  assert.deepStrictEqual(a.sent.at(-1), [false, 'aaaa01']);
  world.advance(100);
  assert.ok(!b.remoteActive('a') && eventsB.includes('ring-ended'), 'the ring did not stop when the caller hung up');
  console.log('PASS start, repeat presence, double-click guard, hang up');
}

// ---- joining the friend's call adopts their session
{
  const world = new World(), { a, b, eventsA } = pair(world);
  a.press('b'); world.advance(100);
  assert.strictEqual(b.press('a'), 'joined');
  assert.deepStrictEqual(b.sent[0], [true, 'aaaa01'], 'the joiner did not use the caller\'s session');
  world.advance(100);
  assert.ok(eventsA.includes('friend-joined')); assert.deepStrictEqual(a.view('b', 'live'), { state: 'live', button: 'end' });
  assert.deepStrictEqual(a.view('b', 'connecting'), { state: 'connecting', button: 'end' });
  b.press('a'); world.advance(END_GUARD_MS + 10); b.press('a'); world.advance(100);
  assert.deepStrictEqual(a.view('b'), { state: 'waiting', button: 'end' }, 'after the friend left the caller should be waiting, not ringing');
  console.log('PASS joining adopts the session; leaving shows waiting');
}

// ---- both press at once, under many network timings, always ends up as one call
{
  let merged = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const world = new World(seed); const delay = () => 5 + world.random() * 300;
    const { a, b, eventsA, eventsB } = pair(world, delay);
    const gap = world.random() * 400;
    a.press('b'); world.advance(gap); b.press('a');
    world.advance(5000);
    assert.ok(a.inCall && b.inCall, `seed ${seed}: someone fell out of the call`);
    assert.strictEqual(a.session, b.session, `seed ${seed}: sessions never merged (${a.session} vs ${b.session})`);
    assert.strictEqual(a.session, 'aaaa01', `seed ${seed}: the lower session did not win`);
    assert.ok(a.friendJoined && b.friendJoined, `seed ${seed}: they do not see each other`);
    assert.ok(!eventsA.includes('friend-left') && !eventsB.includes('friend-left'), `seed ${seed}: a phantom leave`);
    if (eventsB.includes('merged')) merged++;
  }
  assert.ok(merged > 0, 'the merge path was never exercised');
  console.log(`PASS simultaneous presses merge into one call in 400 randomised runs (${merged} needed a merge)`);
}

// ---- presence expires if it stops, and any sign of life refreshes it
{
  const world = new World(), { a, b, eventsB } = pair(world);
  a.press('b'); world.advance(50); a.close(); a.clearTimer = () => {}; // the caller's app dies: no more beats
  a.link = null; for (const item of world.queue.filter(entry => entry.fn.name === 'beat')) world.clearTimer(item);
  world.advance(TTL_MS - 2000); assert.ok(b.remoteActive('a'), 'the ring ended too early');
  b.touch('a'); world.advance(TTL_MS - 2000); assert.ok(b.remoteActive('a'), 'a sign of life did not extend the ring');
  world.advance(3000); assert.ok(!b.remoteActive('a') && eventsB.includes('ring-ended'), 'a dead caller kept ringing forever');
  console.log('PASS presence expires without beats and is refreshed by activity');
}

// ---- a "left" for an older session cannot end a newer one
{
  const world = new World(), { b, eventsB } = pair(world);
  b.receive('a', true, 'new-session'); b.receive('a', false, 'old-session');
  assert.ok(b.remoteActive('a'), 'a stale hang-up ended the new call'); assert.ok(!eventsB.includes('ring-ended'));
  b.receive('a', false, 'new-session'); assert.ok(!b.remoteActive('a'));
  console.log('PASS a stale hang-up is ignored');
}

// ---- restart: a fresh app learns of the call from the next beat and one press joins it
{
  const world = new World(), { a, b } = pair(world);
  a.press('b'); world.advance(100); b.press('a'); world.advance(100);
  // b restarts: a brand new control, knows nothing
  const fresh = person(world, 'b', 'bbbb09', []); fresh.link = (_peer, active, session) => world.deliver('b2', () => a.receive('b', active, session), 30);
  b.close(); a.link = (_peer, active, session) => world.deliver('a2', () => fresh.receive('a', active, session), 30);
  assert.deepStrictEqual(fresh.view('a'), { state: 'idle', button: 'start' });
  world.advance(BEAT_MS + 100);
  assert.deepStrictEqual(fresh.view('a'), { state: 'incoming', button: 'join' }, 'a restarted app never heard about the call in progress');
  assert.strictEqual(fresh.press('a'), 'joined'); assert.strictEqual(fresh.session, 'aaaa01');
  console.log('PASS a restarted app hears the call on the next beat and one press rejoins it');
}

// ---- a presence line that could not be sent is retried
{
  const world = new World(), { a, b } = pair(world);
  a.offline = true; a.press('b'); assert.ok(a.unsent, 'a failed publish was not remembered');
  a.offline = false; a.republish(); world.advance(100);
  assert.ok(!a.unsent && b.remoteActive('a'), 'republishing did not reach the friend');
  console.log('PASS an unsent presence line is repeated when the directory is back');
}

// ---- other people: busy with someone else, nobody selected
{
  const world = new World(), { a } = pair(world);
  a.press('b'); assert.strictEqual(a.press('c'), 'busy'); assert.deepStrictEqual(a.view('c'), { state: 'busy', button: 'start', other: 'b' });
  assert.strictEqual(a.press(''), 'nobody');
  console.log('PASS pressing for someone else while busy, or for nobody, is refused plainly');
}

console.log('ALL CALL CONTROL CHECKS PASSED');
