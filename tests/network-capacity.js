'use strict';

const assert = require('assert');
const {
  mbpsFrom, effectiveUploadCapMbps, voiceBitrateBps, preferAudioRed,
  recommendShareBudgetMbps, autoShareCeilingMbps, encoderShareCapMbps,
  viewerReceiveCapMbps, minViewerReceiveCapMbps, normalizeNetBudget,
  nextShareBudgetMbps, shouldAdoptShareBudget, abortCapacityProbe,
  cachedCapacityFresh, shouldStopProbe, CACHE_MS, PROBE_VERSION,
  MAX_NATIVE_SHARE_MBPS, MAX_HARDWARE_WEBRTC_SHARE_MBPS, MAX_SLIDER_MBPS,
  PROBE_WINDOW_MS, PROBE_MIN_BYTES, PROBE_MAX_BYTES,
} = require('../network-capacity');

assert.ok(Math.abs(mbpsFrom(1_000_000, 800) - 10) < 0.01);
assert.strictEqual(effectiveUploadCapMbps(NaN, Infinity), Infinity);
assert.ok(Math.abs(effectiveUploadCapMbps(20, Infinity) - 14.5) < 0.01);
assert.ok(effectiveUploadCapMbps(40, 10) < effectiveUploadCapMbps(40, Infinity), 'live uplink must be allowed to tighten the probe');

assert.strictEqual(voiceBitrateBps({ relay: true }), 24000);
assert.strictEqual(voiceBitrateBps({ uploadMbps: 4 }), 48000);
assert.strictEqual(voiceBitrateBps({ uploadMbps: 12 }), 64000);
assert.strictEqual(voiceBitrateBps({ uploadMbps: 40 }), 96000);

assert.strictEqual(preferAudioRed(4), false);
assert.strictEqual(preferAudioRed(20), true);
assert.strictEqual(preferAudioRed(undefined), true);

assert.strictEqual(autoShareCeilingMbps(undefined, { slider: 20 }), 20);
assert.strictEqual(autoShareCeilingMbps(8, { slider: 20 }), Math.min(20, effectiveUploadCapMbps(8, Infinity)));
assert.ok(autoShareCeilingMbps(80, { slider: 20 }) > 20, 'fast uploads must raise the auto ceiling');
assert.ok(autoShareCeilingMbps(80, { slider: 20 }) > 40, 'fast uploads must be allowed past the old 40 Mbps cap');
assert.ok(autoShareCeilingMbps(2000, { slider: 20 }) <= MAX_NATIVE_SHARE_MBPS, 'gigabit uplinks must still stop at the GPU encoder ceiling');
assert.ok(autoShareCeilingMbps(2000, { slider: 20 }) >= 100, 'gigabit uplinks must be allowed a very high native budget');
assert.ok(autoShareCeilingMbps(80, { explicit: true, slider: 12 }) <= 12, 'an explicit slider must remain a ceiling');
assert.ok(recommendShareBudgetMbps(6, 40) < 8, 'slow uploads must not keep a 40 Mbps share budget');

assert.ok(encoderShareCapMbps({ native: true, width: 3840, height: 2160, fps: 60 }) <= MAX_NATIVE_SHARE_MBPS);
assert.ok(encoderShareCapMbps({ native: true, width: 3840, height: 2160, fps: 60 }) >= 200, '4K60 native AV1 must be allowed a high-bitrate GPU budget on fast links');
assert.ok(encoderShareCapMbps({ native: true, width: 1920, height: 1080, fps: 60 }) < encoderShareCapMbps({ native: true, width: 3840, height: 2160, fps: 60 }), '1080p must not inherit the 4K encoder ceiling');
assert.ok(encoderShareCapMbps({ hardware: true, width: 3840, height: 2160, fps: 60 }) <= MAX_HARDWARE_WEBRTC_SHARE_MBPS);
assert.ok(encoderShareCapMbps({ hardware: true, width: 3840, height: 2160, fps: 60 }) < encoderShareCapMbps({ native: true, width: 3840, height: 2160, fps: 60 }), 'WebRTC hardware must stay below native GPU AV1');

assert.ok(Math.abs(viewerReceiveCapMbps(50) - 37) < 0.01, 'a 50 Mbps viewer must be derated before it becomes the share cap');
assert.strictEqual(minViewerReceiveCapMbps([]), Infinity, 'unknown viewers must not invent a cap');
assert.ok(Math.abs(minViewerReceiveCapMbps([{ downloadMbps: 50 }]) - 37) < 0.01);
assert.ok(Math.abs(minViewerReceiveCapMbps([{ downloadMbps: 1000 }, { downloadMbps: 50 }]) - 37) < 0.01, 'the slowest advertised viewer must win');
assert.ok(Math.abs(nextShareBudgetMbps(NaN, { senderMbps: 250, viewerMbps: 37 }) - 37) < 0.01, '1 Gbps + 50 Mbps must start at the viewer path');
assert.ok(Math.abs(nextShareBudgetMbps(80, { senderMbps: 250, viewerMbps: 37 }) - 37) < 0.01, 'a late slow viewer must pull the live share down');
assert.ok(Math.abs(nextShareBudgetMbps(37, { senderMbps: 80, viewerMbps: 37 }) - 37) < 0.01, 'a healthy path must not climb past the slowest viewer');
assert.ok(nextShareBudgetMbps(37, { senderMbps: 80, viewerMbps: 37, congested: true }) < 37, 'loss must tighten the live share');
assert.ok(Math.abs(nextShareBudgetMbps(32.56, { senderMbps: 80, viewerMbps: 37 }) - 37) < 0.01, 'a recovered path must return to the advertised viewer cap');
assert.ok(Math.abs(nextShareBudgetMbps(37, { senderMbps: 80, viewerMbps: 400 }) - 80) < 0.01, 'an improved viewer advertisement must be allowed up to the sender cap');
assert.strictEqual(shouldAdoptShareBudget(37, 32), true);
assert.strictEqual(shouldAdoptShareBudget(37, 36), false, 'tiny drops must not flap the encoder');
assert.strictEqual(shouldAdoptShareBudget(37, 50, { lastChangeAt: Date.now(), now: Date.now() }), false, 'raises must wait for a hold');
assert.strictEqual(shouldAdoptShareBudget(37, 50, { lastChangeAt: Date.now() - 20000, now: Date.now() }), true);
assert.strictEqual(shouldAdoptShareBudget(32.56, 37, { lastChangeAt: Date.now() - 20000, now: Date.now() }), true, 'congestion recovery must be allowed after the hold');
assert.strictEqual(typeof abortCapacityProbe, 'function');
abortCapacityProbe();
assert.ok(normalizeNetBudget({ downloadMbps: 50, uploadMbps: 50, at: 1 }));
assert.strictEqual(normalizeNetBudget({ downloadMbps: 0 }), null);
assert.strictEqual(normalizeNetBudget({ downloadMbps: -4, uploadMbps: 90000 }), null);
assert.strictEqual(normalizeNetBudget({ congested: false, at: 2 })?.congested, false, 'a recovered viewer must be able to clear congestion without a new probe');

assert.strictEqual(shouldStopProbe(100, 1e6), false);
assert.strictEqual(shouldStopProbe(PROBE_WINDOW_MS, PROBE_MIN_BYTES), true);
assert.strictEqual(shouldStopProbe(400, PROBE_MAX_BYTES), true, 'gigabit probes must stop at a bounded byte cap');
assert.strictEqual(shouldStopProbe(12000, 100), true);
assert.strictEqual(shouldStopProbe(PROBE_WINDOW_MS, PROBE_MIN_BYTES - 1), false, 'slow probes must keep filling until they have a real sample');

const now = Date.now();
assert.strictEqual(cachedCapacityFresh({ uploadMbps: 20, downloadMbps: 80, at: now, probeVersion: PROBE_VERSION }), true);
assert.strictEqual(cachedCapacityFresh({ uploadMbps: 20, downloadMbps: 80, at: now }), false, 'v1 handshake-dominated samples must be remeasured');
assert.strictEqual(cachedCapacityFresh({ uploadMbps: 20, downloadMbps: 80, at: now - CACHE_MS - 1, probeVersion: PROBE_VERSION }), false);
assert.strictEqual(cachedCapacityFresh({ uploadMbps: 0, downloadMbps: 80, at: now, probeVersion: PROBE_VERSION }), false);
assert.ok(MAX_SLIDER_MBPS >= MAX_NATIVE_SHARE_MBPS);
console.log('PASS network capacity math');
