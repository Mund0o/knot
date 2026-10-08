'use strict';

// The player on a simulated clock with a stand-in decoder, so timing problems can be reproduced exactly instead of by luck. A quiet screen
// (pictures further apart than the player's look-ahead window) with a decoder that is slow to answer at first used to leave the playout
// buffering for good: the clock waited for a decoded picture, and the player decoded nothing that was not close to the clock.
const assert = require('assert');
const { TYPE } = require('../share-wire');

function simulate({ startupMs, intervalMs, count, heartbeatMs = 0, decodeMs = 3 }) {
  let t = 0; const timers = [];
  const at = (when, fn) => { timers.push({ when, fn, order: timers.length }); };
  global.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
  global.VideoDecoder = class {
    constructor({ output }) { this.output = output; this.decodeQueueSize = 0; this.readyAt = t + startupMs; this.last = 0; }
    configure() {}
    decode(chunk) {
      this.decodeQueueSize++;
      const when = Math.max(t + decodeMs, this.readyAt, this.last); this.last = when;      // in order, and nothing before the decoder is ready
      at(when, () => { this.decodeQueueSize--; this.output({ timestamp: chunk.timestamp, displayWidth: 1920, displayHeight: 1080, codedWidth: 1920, codedHeight: 1080, close() {} }); });
    }
    flush() { return Promise.resolve(); } close() {}
  };
  delete require.cache[require.resolve('../share-player')];
  const { createSharePlayer } = require('../share-player');
  const player = createSharePlayer({ preferSoftware: true, surface: null, getDisplaySize: () => null, now: () => t, schedule: fn => at(t + 16, () => fn(t)) });
  player.configure({ codec: 'av01.0.13H.08', width: 1920, height: 1080, fps: 60 });
  const end = count * intervalMs + 3000;
  for (let i = 0; i < count; i++) at(i * intervalMs, () => player.push({ type: TYPE.VIDEO, key: i === 0, pts: i * intervalMs * 1000, payload: new Uint8Array(8) }));
  if (heartbeatMs) for (let when = heartbeatMs; when < end; when += heartbeatMs) at(when, () => player.push({ type: TYPE.HEARTBEAT, pts: when * 1000 }));
  while (timers.length) {
    timers.sort((a, b) => a.when - b.when || a.order - b.order);
    const next = timers.shift(); if (next.when > end) break;
    t = Math.max(t, next.when); next.fn();
  }
  const stats = player.stats(); player.destroy();
  return stats;
}

// A quiet screen, no heartbeats, decoder slow to start: every picture still comes out, after the ones that were already in the past.
for (const startupMs of [0, 150, 300, 450, 600, 900, 1200]) {
  for (const intervalMs of [170, 200, 250, 400]) {
    const s = simulate({ startupMs, intervalMs, count: 24 });
    assert(s.painted + s.skippedAtStart >= 24 - 1 && s.painted >= 12, `startup ${startupMs} ms, pictures ${intervalMs} ms apart: only ${s.painted} of 24 shown (${s.skippedAtStart} skipped at the start, ${s.queued} still waiting to be decoded, ${s.decodedWaiting} decoded and waiting, state ${s.buffering ? 'buffering' : 'playing'})`);
    assert.strictEqual(s.queued, 0, `startup ${startupMs} ms, pictures ${intervalMs} ms apart: ${s.queued} pictures were never decoded`);
  }
}
console.log('PASS a quiet screen is shown to its last picture however slow the decoder is to start');

{
  const s = simulate({ startupMs: 0, intervalMs: 16.7, count: 300 });
  assert(s.painted >= 290, 'a steady 60 a second stream must be shown, got ' + s.painted);
  assert(s.stalls <= 1, "a steady stream stalled " + s.stalls + " times");
  console.log(`PASS a steady 60 a second stream is shown (${s.painted} of 300)`);
}
{
  const s = simulate({ startupMs: 600, intervalMs: 200, count: 24, heartbeatMs: 100 });
  assert(s.painted >= 20, 'with heartbeats a quiet screen must also be shown, got ' + s.painted);
  console.log(`PASS the same with heartbeats arriving (${s.painted} of 24)`);
}
console.log('ALL SHARE PLAYER CLOCK CHECKS PASSED');
