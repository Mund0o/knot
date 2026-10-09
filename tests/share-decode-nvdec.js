'use strict';

// The GPU decoder helper (share-decode-nvdec.js + native/nvdec/knot-nvdec.c) against the real GPU: pictures come out in order, match a
// software decode, come out promptly when fed at a live rate, and are never held back when the input stops; the process is gone after stop,
// and every way it can fail is reported instead of hanging. Skips (with the reason) where there is no helper or no NVIDIA AV1 decoder.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { NvdecSession, ShareDecodeRuntime, probeNvdec, ivfPictures, packetHeader, PROBE_IVF } = require('../share-decode-nvdec');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Mean absolute difference of two byte ranges, sampled.
const difference = (a, b, from, to) => { let total = 0, n = 0; for (let i = from; i < to; i += 3) { total += Math.abs(a[i] - b[i]); n++; } return total / n; };

function collect(session) {
  const out = { frames: [], errors: [], ended: false };
  session.on('frame', picture => out.frames.push({ pts: picture.pts, width: picture.width, height: picture.height, data: Buffer.from(picture.data), at: Date.now() }));
  session.on('error', error => out.errors.push(error.message));
  session.on('end', () => { out.ended = true; });
  return out;
}
async function waitFor(check, ms, what) { for (let waited = 0; waited < ms; waited += 20) { if (check()) return; await sleep(20); } throw new Error('timed out waiting for ' + what); }

(async () => {
  const info = await probeNvdec();
  if (!info.available) { console.log('SKIP GPU decoder helper tests: ' + info.reason); return; }
  console.log(`PASS the probe finds the helper and really decodes a test picture on the GPU (${info.gpu})`);

  // ---- a probe on a machine without it says why
  assert.deepStrictEqual(await probeNvdec({ helper: '' }), { available: false, reason: 'the GPU decoder helper (knot-nvdec) is not installed', helper: '', permanent: true });
  assert.match((await probeNvdec({ helper: '/nonexistent/knot-nvdec' })).reason, /could not start/);
  assert.strictEqual((await probeNvdec({ platform: 'win32' })).available, false);
  const noGpu = await probeNvdec({ helper: '/bin/false' });
  assert.match(noGpu.reason, /cannot decode AV1/, 'a helper that says no must be reported as a GPU that cannot decode');
  const silent = await probeNvdec({ helper: '/bin/true', spawnImpl: (command, args, options) => spawn('/bin/sh', ['-c', 'echo "ok fake GPU"; cat > /dev/null'], options), timeoutMs: 1500 });
  assert.match(silent.reason, /test picture/, 'a helper that answers but decodes nothing must not be trusted');
  console.log('PASS a machine without the helper, one that cannot start it, a GPU without AV1, a helper that decodes nothing, or another OS gets a reason and no GPU decoding');

  const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  if (!ffmpeg) { console.log('SKIP the picture checks: they need ffmpeg to make a clip and a reference'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-nvdec-'));
  try {
    const clip = path.join(dir, 'clip.ivf');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=2', '-c:v', 'libsvtav1', '-preset', '10', '-g', '60', '-b:v', '8M', '-pix_fmt', 'yuv420p', '-f', 'ivf', clip]);
    assert.strictEqual(made.status, 0, 'could not make a test clip');
    const frames = ivfPictures(fs.readFileSync(clip)).map(buffer => new Uint8Array(buffer));
    const reference = (w, h) => spawnSync('ffmpeg', ['-v', 'error', '-c:v', 'libdav1d', '-i', clip, '-vf', `scale=${w}:${h}:flags=lanczos,format=nv12`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 }).stdout;

    // ---- every picture, in order, the right picture, with nothing held back when the input stops (the input is NOT closed here)
    for (const [outWidth, outHeight, lumaLimit, chromaLimit] of [[0, 0, 0.01, 0.01], [960, 540, 1, 1]]) {
      const session = new NvdecSession({ helper: info.helper, outWidth, outHeight });
      const got = collect(session); session.start();
      frames.forEach((data, i) => assert(session.push(i * 16667, data)));
      await waitFor(() => got.frames.length === frames.length, 15000, `every picture (${got.frames.length} of ${frames.length} came out)`);
      assert.deepStrictEqual(got.errors, []);
      assert.deepStrictEqual(got.frames.map(f => f.pts), frames.map((_, i) => i * 16667), 'pictures must come out in order with their own times');
      const w = outWidth || 1920, h = outHeight || 1080, size = w * h * 3 / 2, expected = reference(w, h);
      assert(got.frames.every(f => f.width === w && f.height === h && f.data.length === size));
      let luma = 0, chroma = 0;
      for (const i of [0, 30, 59, 119]) { luma = Math.max(luma, difference(got.frames[i].data, expected.subarray(i * size, (i + 1) * size), 0, w * h)); chroma = Math.max(chroma, difference(got.frames[i].data, expected.subarray(i * size, (i + 1) * size), w * h, size)); }
      assert(luma <= lumaLimit && chroma <= chromaLimit, `${w}x${h}: the GPU picture differs from a software decode (brightness ${luma.toFixed(2)}, colour ${chroma.toFixed(2)})`);
      const pid = session.child.pid;
      await session.stop();
      assert(got.ended, 'stop must end the session'); await sleep(100);
      assert(!alive(pid), 'the helper process must be gone after stop');
      console.log(`PASS ${frames.length} pictures decode on the GPU at ${w}x${h}, in order, with none held back, within ${luma.toFixed(2)} / ${chroma.toFixed(2)} (brightness / colour) of a software decode`);
    }

    // ---- fed at a live rate
    {
      const session = new NvdecSession({ helper: info.helper, outWidth: 1280, outHeight: 720 });
      const got = collect(session); session.start();
      const sent = [], t0 = Date.now();
      for (let i = 0; i < frames.length; i++) { const due = t0 + i * 1000 / 60; while (Date.now() < due) await sleep(1); sent.push(Date.now()); session.push(i, frames[i]); }
      await waitFor(() => got.frames.length === frames.length, 5000, 'the live pictures');
      const delays = got.frames.map((f, i) => f.at - sent[i]).slice(20).sort((a, b) => a - b), p50 = delays[delays.length >> 1], p95 = delays[Math.floor(delays.length * .95)];
      assert(p95 < 150, 'live pictures came out ' + p95 + ' ms after they went in');
      await session.stop();
      console.log(`PASS fed at 60 a second, pictures come out ${p50} ms (median) and ${p95} ms (95th percentile) after going in`);
    }

    // ---- a screen that changes now and then: each change shows at once, not when the next one arrives
    {
      const session = new NvdecSession({ helper: info.helper, outWidth: 960, outHeight: 540 });
      const got = collect(session); session.start();
      const shownAfter = [];
      for (let i = 0; i < 6; i++) { const before = got.frames.length, at = Date.now(); session.push(i * 200000, frames[i]); await waitFor(() => got.frames.length > before, 1000, `change ${i} to show`); shownAfter.push(Date.now() - at); await sleep(200); }
      assert(shownAfter.every(ms => ms < 300), 'a change took ' + Math.max(...shownAfter) + ' ms to show');
      await session.stop();
      console.log(`PASS on a screen that changes five times a second each change shows within ${Math.max(...shownAfter)} ms, none waits for the next`);
    }

    // ---- failures
    {
      const session = new NvdecSession({ helper: '/nonexistent/knot-nvdec' });
      const got = collect(session); session.start();
      await waitFor(() => got.ended, 3000, 'a missing program to be reported');
      assert.match(got.errors[0], /ENOENT/);
      assert.strictEqual(session.push(0, frames[0]), false, 'a dead helper must refuse pictures');
    }
    {
      const session = new NvdecSession({ helper: info.helper });
      const got = collect(session); session.start();
      session.push(0, new Uint8Array(4000).fill(7));
      await sleep(1500);
      assert.strictEqual(got.frames.length, 0, 'garbage must not produce pictures');
      await session.stop();
      assert(got.ended);
    }
    {
      // A delta picture first (no key picture yet, so no stream description): nothing can be shown, and nothing may hang.
      const session = new NvdecSession({ helper: info.helper });
      const got = collect(session); session.start();
      session.push(0, frames[5]);
      await sleep(1000);
      assert.strictEqual(got.frames.length, 0);
      await session.stop();
    }
    {
      // A helper that takes pictures slower than they come is called too slow rather than buffering without end.
      const session = new NvdecSession({ helper: '/bin/sleep', maxQueuedBytes: 3000, spawnImpl: (command, args, options) => spawn('/bin/sleep', ['30'], options) });
      const got = collect(session); session.start();
      for (let i = 0; i < 20 && !got.errors.length; i++) session.push(i, new Uint8Array(1000));
      await waitFor(() => got.errors.length > 0, 3000, 'the slow helper to be reported');
      assert.match(got.errors[0], /not keeping up/);
      await waitFor(() => got.ended, 3000, 'the slow helper to be stopped');
    }
    {
      // A helper that dies in the middle of a stream is reported once.
      const session = new NvdecSession({ helper: info.helper, outWidth: 960, outHeight: 540 });
      const got = collect(session); session.start();
      session.push(0, frames[0]);
      await waitFor(() => got.frames.length === 1, 5000, 'the first picture');
      process.kill(session.child.pid, 'SIGKILL');
      await waitFor(() => got.ended, 3000, 'the death to be reported');
      assert.strictEqual(got.errors.length, 1, 'one error for one death');
    }
    console.log('PASS a missing program, garbage, a stream with no key picture, a helper that cannot keep up and one that dies are each reported and ended, never left hanging');

    // ---- the runtime: sessions belong to the document that opened them
    {
      const owner = { id: 'a' }, other = { id: 'b' };
      const events = [];
      const runtime = new ShareDecodeRuntime({ sameOwner: (x, y) => x.id === y.id, helper: info.helper, onFrame: e => events.push(['frame', e.id, e.picture.pts]), onError: e => events.push(['error', e.id, e.error.message]), onEnd: e => events.push(['end', e.id]) });
      assert.strictEqual((await runtime.availability()).available, true);
      await assert.rejects(runtime.open(owner, { width: 1920, height: 1080, outWidth: 3840, outHeight: 2160 }), /smaller/);
      await assert.rejects(runtime.open(owner, { width: 10, height: 10, outWidth: 10, outHeight: 10 }), /invalid/);
      const { id, outWidth, outHeight } = await runtime.open(owner, { width: 1920, height: 1080, outWidth: 1000, outHeight: 563 });
      assert.deepStrictEqual([outWidth, outHeight], [1000, 562], 'sizes are rounded down to even numbers');
      assert.strictEqual(runtime.push(other, id, 0, frames[0]), false, 'another document must not feed a decoder it did not open');
      assert.strictEqual(await runtime.close(other, id), false, 'another document must not close it either');
      assert.strictEqual(runtime.push(owner, id, 0, frames[0]), true);
      await waitFor(() => events.some(e => e[0] === 'frame'), 8000, 'a picture from the runtime');
      await runtime.closeAll();
      assert.strictEqual(runtime.sessions.size, 0);
      const none = new ShareDecodeRuntime({ sameOwner: () => true, probe: async () => ({ available: false, reason: 'this GPU cannot decode AV1 (test)' }), onFrame() {}, onError() {}, onEnd() {} });
      await assert.rejects(none.open(owner, { width: 1920, height: 1080, outWidth: 1920, outHeight: 1080 }), /cannot decode AV1/);
      console.log('PASS sessions belong to the document that opened them, sizes are checked, and a machine without GPU decoding refuses to open one');
    }

    // A check that failed for a reason that may pass (it timed out while the machine was busy) is asked again later, here and in the page; a final answer never is.
    {
      let clock = 1000, probes = 0; const answers = [{ available: false, reason: 'this GPU cannot decode AV1 (it did not answer in time)', helper: '/h' }, { available: true, helper: '/h', gpu: 'fake GPU' }];
      const runtime = new ShareDecodeRuntime({ sameOwner: () => true, now: () => clock, retryMs: 30000, probe: async () => answers[Math.min(probes++, 1)], onFrame() {}, onError() {}, onEnd() {} });
      assert.strictEqual((await runtime.availability()).available, false);
      assert.strictEqual((await runtime.availability()).available, false); assert.strictEqual(probes, 1, 'a failed check was asked again at once');
      clock += 29000; await runtime.availability(); assert.strictEqual(probes, 1, 'a failed check was asked again before its time');
      clock += 2000; assert.strictEqual((await runtime.availability()).available, true, 'a check that failed once was never asked again'); assert.strictEqual(probes, 2);
      clock += 3600000; await runtime.availability(); assert.strictEqual(probes, 2, 'a good answer was asked for again');
      let finals = 0; const final = new ShareDecodeRuntime({ sameOwner: () => true, now: () => clock, probe: async () => (finals++, { available: false, reason: 'this GPU cannot decode AV1 (no AV1 here)', helper: '/h', permanent: true }), onFrame() {}, onError() {}, onEnd() {} });
      await final.availability(); clock += 3600000; await final.availability(); assert.strictEqual(finals, 1, 'a final answer was asked for again');
      const timedOut = await probeNvdec({ helper: '/bin/true', spawnImpl: (command, args, options) => spawn('/bin/sh', ['-c', 'sleep 5'], options), timeoutMs: 300 });
      assert.strictEqual(timedOut.available, false); assert.notStrictEqual(timedOut.permanent, true, 'a helper that did not answer in time was called final');
      assert.strictEqual((await probeNvdec({ helper: '/bin/false' })).permanent, true, 'a GPU that said no was not called final');
      // the page's side asks again in the background, once, when the time has come
      const { createGpuDecode } = require('../share-gpu-decoder');
      let asked = 0, now = 5000; const replies = [{ available: false, reason: 'it did not answer in time' }, { available: true, gpu: 'fake GPU' }];
      const gpu = createGpuDecode({ bridge: { info: async () => replies[Math.min(asked++, 1)] }, enabled: () => true, now: () => now, retryMs: 30000 });
      await gpu.check(); assert.strictEqual(gpu.usable(), false); now += 10000; assert.strictEqual(gpu.usable(), false); assert.strictEqual(asked, 1, 'the page asked again too soon');
      now += 21000; assert.strictEqual(gpu.usable(), false, 'it is usable only after the answer comes back'); assert.strictEqual(asked, 2); gpu.usable(); assert.strictEqual(asked, 2, 'a second question was asked while one was out');
      await new Promise(resolve => setTimeout(resolve, 20)); assert.strictEqual(gpu.usable(), true, 'the page never moved to the GPU decoder that turned out to be there'); assert.strictEqual(asked, 2);
      let finalAsked = 0; const never = createGpuDecode({ bridge: { info: async () => (finalAsked++, { available: false, reason: 'no AV1 here', permanent: true }) }, enabled: () => true, now: () => now, retryMs: 30000 });
      await never.check(); now += 3600000; never.usable(); never.usable(); await new Promise(resolve => setTimeout(resolve, 20)); assert.strictEqual(finalAsked, 1, 'a final no was asked for again');
      console.log('PASS a GPU decoder check that failed for a passing reason is asked again (in main and in the page); a final answer, and a yes, are not');
    }

    assert.strictEqual(packetHeader(5, 3).length, 12);
    assert.strictEqual(PROBE_IVF.toString('latin1', 0, 4), 'DKIF');
    console.log('ALL GPU DECODER HELPER CHECKS PASSED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error?.stack || error); process.exit(1); });
