'use strict';

const assert = require('assert');
const {
  mbpsFrom, effectiveUploadCapMbps, voiceBitrateBps, preferAudioRed,
  recommendShareBudgetMbps, autoShareCeilingMbps, sliderBitrateMaxMbps, encoderShareCapMbps,
  viewerReceiveCapMbps, minViewerReceiveCapMbps, normalizeNetBudget, viewerDecodesInSoftware,
  abortCapacityProbe,
  cachedCapacityFresh, shouldStopProbe, CACHE_MS, PROBE_VERSION,
  MAX_NATIVE_SHARE_MBPS, MAX_HARDWARE_WEBRTC_SHARE_MBPS, MAX_SLIDER_MBPS,
  PROBE_WINDOW_MS, PROBE_MIN_BYTES, PROBE_MAX_BYTES,
} = require('../network-capacity');

assert.ok(Math.abs(mbpsFrom(1_000_000, 800) - 10) < 0.01);
assert.strictEqual(effectiveUploadCapMbps(NaN, Infinity), Infinity);
assert.ok(Math.abs(effectiveUploadCapMbps(20, Infinity) - 14.5) < 0.01);
assert.ok(effectiveUploadCapMbps(40, 10) < effectiveUploadCapMbps(40, Infinity), 'live uplink must be allowed to tighten the probe');

assert.strictEqual(voiceBitrateBps({ relay: true }), 24000);
assert.strictEqual(voiceBitrateBps({ uploadMbps: 4 }), 64000);
assert.strictEqual(voiceBitrateBps({ uploadMbps: 12 }), 96000);
assert.strictEqual(voiceBitrateBps({ uploadMbps: 40 }), 128000);

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
assert.strictEqual(typeof abortCapacityProbe, 'function');
abortCapacityProbe();
assert.ok(normalizeNetBudget({ downloadMbps: 50, uploadMbps: 50, at: 1 }));
assert.strictEqual(normalizeNetBudget({ downloadMbps: 0 }), null);
assert.strictEqual(normalizeNetBudget({ downloadMbps: -4, uploadMbps: 90000 }), null);
assert.strictEqual(normalizeNetBudget({ congested: false, at: 2 })?.congested, false, 'a recovered viewer must be able to clear congestion without a new probe');
assert.deepStrictEqual(normalizeNetBudget({ hwDecode: ['AV1', 'bogus', 'H264'], at: 3 }), { hwDecode: ['AV1', 'H264'], at: 3 }, 'a decode capability must travel even before a speed probe');
assert.deepStrictEqual(normalizeNetBudget({ downloadMbps: 50, hwDecode: [] })?.hwDecode, [], 'an empty list means the viewer decodes everything on the CPU');
assert.strictEqual(normalizeNetBudget({ downloadMbps: 50, hwDecode: 'AV1' })?.hwDecode, undefined);
assert.strictEqual(viewerDecodesInSoftware({ hwDecode: [] }, 'av1'), true, 'a CPU-decoding viewer must hold the share to the conservative bitrate curve');
assert.strictEqual(viewerDecodesInSoftware({ hwDecode: ['AV1'] }, 'AV1'), false);
assert.strictEqual(viewerDecodesInSoftware({ downloadMbps: 50 }, 'AV1'), false, 'an older viewer without the field keeps the existing behaviour');

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
assert.strictEqual(MAX_NATIVE_SHARE_MBPS, 200, 'GPU encoder ceiling must stay 200 Mbps');
assert.strictEqual(sliderBitrateMaxMbps(), 200, 'an unmeasured path must still expose the 200 Mbps ceiling');
assert.strictEqual(sliderBitrateMaxMbps(40, 40), 30, 'a 40 Mbps path must not offer the 200 Mbps slider');
assert.ok(sliderBitrateMaxMbps(40, 40) < 40, 'the settings slider must stay at the derated safe rate');
assert.strictEqual(sliderBitrateMaxMbps(2000, 2000), 200, 'gigabit paths must still be allowed the 200 Mbps GPU ceiling');
console.log('PASS network capacity math');

// The speed test against a local server: a normal one is measured; one that says 429 ("retry in 120 s") is left alone afterwards, and a test app never
// goes to the real endpoint at all. (speed.cloudflare.com refused a machine for an hour after dozens of launches and share stops with no result kept.)
(async () => {
  const http = require('http');
  const { measureCapacity, probeBlockedUntil, resetProbeBackoff } = require('../network-capacity');
  const hits = { down: 0, up: 0 }; let mode = 'ok', slowUploads = false;
  const server = http.createServer((request, response) => {
    const down = request.url.startsWith('/__down');
    if (down) hits.down++; else hits.up++;
    if (mode === 'refuse') { response.writeHead(429, { 'retry-after': '120', 'content-length': '1' }); response.end('x'); request.resume(); return; }
    if (down) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 1); let sent = 0;
      const write = () => { while (sent < 200 * 1024 * 1024) { sent += chunk.length; if (!response.write(chunk)) { response.once('drain', write); return; } } response.end(); };
      request.on('close', () => { sent = Infinity; }); write();
    } else if (slowUploads) {
      // a link that holds writes back: every write reports "full" (a 256 KB chunk is bigger than a stream's buffer), which is what a real connection does.
      // The measuring window used to open only after a write that reported room, so it never opened and the speed test measured nothing.
      request.on('data', chunk => { request.pause(); setTimeout(() => request.resume(), chunk.length / 20000); });
      request.on('end', () => { response.writeHead(200); response.end('ok'); });
    } else { request.resume(); request.on('end', () => { response.writeHead(200); response.end('ok'); }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const urls = { downUrl: `http://127.0.0.1:${server.address().port}/__down?bytes=`, upUrl: `http://127.0.0.1:${server.address().port}/__up` };
  try {
    resetProbeBackoff();
    const good = await measureCapacity(urls);
    assert(good && good.downloadMbps > 10 && good.uploadMbps > 10 && good.probeVersion === PROBE_VERSION, 'a working server was not measured: ' + JSON.stringify(good));
    assert.strictEqual(probeBlockedUntil(), 0, 'a good measurement left the probe blocked');
    slowUploads = true; resetProbeBackoff();
    const held = await measureCapacity(urls);
    assert(held && held.uploadMbps > 10 && held.downloadMbps > 10, 'a link that holds writes back (every write answers "full") was not measured: ' + JSON.stringify(held));
    slowUploads = false; resetProbeBackoff();
    mode = 'refuse'; hits.down = hits.up = 0;
    assert.strictEqual(await measureCapacity(urls), null, 'a refusing server gave a result');
    assert(hits.down <= 2 && hits.up <= 2, `a refusing server was asked ${hits.down} + ${hits.up} times (the two warm-up requests are all it should see)`);
    const until = probeBlockedUntil();
    assert(until - Date.now() > 100000 && until - Date.now() <= 121000, 'the 120 s the server asked for was not remembered: ' + (until - Date.now()) + ' ms');
    mode = 'ok'; const before = hits.down + hits.up;
    assert.strictEqual(await measureCapacity(urls), null, 'a probe ran while the endpoint had asked to be left alone');
    assert.strictEqual(hits.down + hits.up, before, 'the endpoint was contacted again before it said it was ready');
    resetProbeBackoff(); assert((await measureCapacity(urls))?.downloadMbps > 10, 'the probe did not run again after the backoff was cleared');
    // nothing at all answering: remembered for a short while, and not asked again meanwhile
    server.close(); resetProbeBackoff();
    assert.strictEqual(await measureCapacity({ downUrl: 'http://127.0.0.1:9/__down?bytes=', upUrl: 'http://127.0.0.1:9/__up' }), null);
    assert(probeBlockedUntil() - Date.now() > 60000, 'a failed probe was not remembered');
    // test apps never reach the real endpoint
    const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
    assert(/pair:networkProbe[\s\S]{0,400}TEST_RIG && process\.env\.KNOT_TEST_ALLOW_PROBE !== '1'\) return null/.test(main), 'a test app can still reach the real speed test');
    resetProbeBackoff();
    console.log('PASS the speed test is measured on a good server, left alone for as long as a refusing one asked, remembered when nothing answers, and never run by test apps');
  } finally { try { server.close(); } catch {} }
})().catch(error => { console.error(error?.stack || error); process.exit(1); });
