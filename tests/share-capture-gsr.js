'use strict';

// Drives the real GPU Screen Recorder on this machine for a few seconds, so it only runs where one is installed and the
// main GPU is NVIDIA or AMD. The pictures are checked in memory and never written to disk.
const assert = require('assert');
const { spawn, execFileSync, spawnSync } = require('child_process');
const { linuxMainGpu } = require('../linux-gpu');
const { nativeScreenInfo, gpuScreenRecorderCommand } = require('../native-screen');

process.env.KNOT_NATIVE_SCREEN_TEST = '1';
const { GsrCapture } = require('../share-capture-gsr');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The bitrate doubles as a marker: no other recorder on the machine uses these exact values, so a leftover process of this
// test is recognised without ever touching someone else's recorder (a replay buffer, say).
const MARK_RUN = 7771, MARK_CRASH = 7772, MARK_FAIL = 7773;
const leftovers = mark => execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n')
  .filter(line => line.includes('gpu-screen-recorder') && new RegExp(`-q ${mark}(\\s|$)`).test(line)).length;
async function waitGone(mark, ms) { const until = Date.now() + ms; while (Date.now() < until) { if (!leftovers(mark)) return true; await sleep(100); } return !leftovers(mark); }

(async () => {
  const gpu = linuxMainGpu();
  if (!gpu || !['0x10de', '0x1002'].includes(gpu.vendor)) return console.log('SKIP live capture test: main discrete GPU is not NVIDIA or AMD');
  const info = nativeScreenInfo(gpu.vendor, gpu.card);
  if (!info.supported) return console.log('SKIP live capture test: ' + info.reason);
  const runner = gpuScreenRecorderCommand();
  const listing = execFileSync(runner.command, [...runner.prefix, '--info'], { encoding: 'utf8', timeout: 10000 });
  const monitor = listing.split(/\r?\n/).map(line => /^([A-Za-z0-9_.-]+)\|(\d+)x(\d+)$/.exec(line)).find(Boolean)?.[1];
  if (!monitor) return console.log('SKIP live capture test: the recorder lists no monitor');
  const make = () => new GsrCapture({ primaryGpuVendor: gpu.vendor, primaryGpuCard: gpu.card });

  // 1. Pictures arrive, described and decodable, with a key picture about every two seconds.
  {
    const capture = make(), frames = [], configs = [], errors = [];
    capture.on('config', config => configs.push(config)); capture.on('frame', frame => frames.push(frame)); capture.on('error', error => errors.push(error));
    const started = await capture.start({ width: 1920, height: 1080, fps: 60, bitrateKbps: MARK_RUN, captureSource: monitor });
    assert.deepStrictEqual({ w: started.width, h: started.height, fps: started.fps, kbps: started.bitrateKbps }, { w: 1920, h: 1080, fps: 60, kbps: MARK_RUN });
    for (let waited = 0; (waited < 12000) && (!configs.length || frames.at(-1)?.pts < 6.5e6); waited += 100) await sleep(100);
    assert(!errors.length, 'capture failed: ' + errors.map(e => e.message).join('; '));
    assert.strictEqual(configs.length, 1, 'exactly one description of the stream');
    assert(/^av01\.0\.\d\d[MH]\.08$/.test(configs[0].codec), 'AV1 codec string: ' + configs[0].codec);
    assert.deepStrictEqual({ w: configs[0].width, h: configs[0].height }, { w: 1920, h: 1080 }, 'the size read from the stream header');
    assert(frames[0].key, 'the first picture handed over must be a key picture');
    assert(frames.length >= 30, `only ${frames.length} pictures in the capture window (a screen that never changes sends none)`);
    assert(frames.every((frame, index) => index === 0 || frame.pts >= frames[index - 1].pts), 'picture times must not go backwards');
    const keys = frames.filter(f => f.key).map(f => f.pts / 1e6);
    assert(keys.length >= 2, `expected a second key picture within 6.5 s, saw ${keys.length}`);
    const spacing = keys.slice(1).map((time, index) => time - keys[index]);
    assert(spacing.every(gap => gap > 1.2 && gap < 3), 'key pictures should be about 2 s apart, were ' + spacing.map(g => g.toFixed(2)).join(', '));
    // Real decoder, real pictures: wrap them as a bare AV1 stream (a temporal delimiter before each) and decode.
    const tu = Buffer.concat(frames.map(frame => Buffer.concat([Buffer.from([0x12, 0x00]), Buffer.from(frame.data)])));
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-f', 'obu', '-i', 'pipe:0', '-f', 'framecrc', '-'], { input: tu, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 60000 });
    const decodedFrames = decoded.stdout.split('\n').filter(line => line && !line.startsWith('#')).length;
    assert.strictEqual(decoded.stderr.trim(), '', 'ffmpeg complained about the pictures: ' + decoded.stderr.slice(0, 200));
    assert.strictEqual(decodedFrames, frames.length, `ffmpeg decoded ${decodedFrames} of ${frames.length} pictures`);
    const t0 = Date.now(); await capture.stop();
    assert(Date.now() - t0 < 4000, 'stop() took ' + (Date.now() - t0) + ' ms');
    assert(await waitGone(MARK_RUN, 1500), 'the recorder was still running after stop() returned');
    console.log(`PASS real capture: ${frames.length} pictures decode cleanly, ${keys.length} keys about ${(spacing.reduce((a, b) => a + b, 0) / spacing.length).toFixed(1)} s apart, recorder gone ${Date.now() - t0} ms after stop()`);
  }

  // 2. Stopping again later works (state is not stuck on the old run), and a stop that is never needed is harmless.
  {
    const capture = make(); capture.on('error', () => {}); const frames = [];
    capture.on('frame', frame => frames.push(frame));
    await capture.start({ width: 1280, height: 720, fps: 30, bitrateKbps: MARK_RUN, captureSource: monitor });
    for (let waited = 0; !frames.length && waited < 10000; waited += 100) await sleep(100);
    assert(frames.length, 'second run produced nothing');
    await capture.stop(); await capture.stop();
    assert(await waitGone(MARK_RUN, 1500));
    await make().stop();
    console.log('PASS capture can be run again, and stopped twice');
  }

  // 3. A recorder that cannot start reports why and leaves nothing behind.
  {
    const capture = make(), errors = [];
    capture.on('error', error => errors.push(error));
    await capture.start({ width: 1920, height: 1080, fps: 60, bitrateKbps: MARK_FAIL, captureSource: 'NO-SUCH-MONITOR-9' });
    for (let waited = 0; !errors.length && waited < 10000; waited += 100) await sleep(100);
    assert(errors.length, 'a recorder that cannot capture must say so');
    assert(/not found|no such|invalid|failed|cannot|unable/i.test(errors[0].message), 'the reason should be the recorder\'s own words, got: ' + errors[0].message);
    await capture.stop();
    assert(await waitGone(MARK_FAIL, 1500));
    console.log('PASS a capture that cannot start says so: ' + JSON.stringify(errors[0].message.slice(0, 80)));
  }

  // 4. Knot dying without a chance to clean up (a crash, kill -9) must not leave the screen being recorded.
  {
    const child = spawn(process.execPath, ['-e', `
      process.env.KNOT_NATIVE_SCREEN_TEST = '1';
      const { GsrCapture } = require(${JSON.stringify(require.resolve('../share-capture-gsr'))});
      const capture = new GsrCapture({ primaryGpuVendor: ${JSON.stringify(gpu.vendor)}, primaryGpuCard: ${JSON.stringify(gpu.card)} });
      capture.on('error', () => {}); let up = false; capture.on('frame', () => { if (!up) { up = true; console.log('capturing'); } });
      capture.start({ width: 1920, height: 1080, fps: 60, bitrateKbps: ${MARK_CRASH}, captureSource: ${JSON.stringify(monitor)} });
      setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = ''; child.stdout.on('data', chunk => output += chunk);
    for (let waited = 0; !/capturing/.test(output) && waited < 12000; waited += 100) await sleep(100);
    assert(/capturing/.test(output), 'the child never started capturing');
    assert(leftovers(MARK_CRASH) > 0, 'the recorder should be running while the child lives');
    child.kill('SIGKILL');
    const t0 = Date.now(); const gone = await waitGone(MARK_CRASH, 5000);
    assert(gone, 'the recorder kept running after its parent was killed');
    console.log(`PASS killing the app outright takes the recorder with it (gone ${Date.now() - t0} ms later)`);
  }

  console.log('ALL SHARE CAPTURE CHECKS PASSED');
  process.exit(0);
})().catch(error => { console.error(error?.stack || error); process.exit(1); });
