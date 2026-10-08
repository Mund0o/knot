'use strict';

// The viewer's player on the machine's real GPU, configured exactly the way the app configures it (the same Linux GPU selection, the bundled
// NVIDIA VA-API driver, the same Chromium switches). A real AV1 stream is played onto a visible canvas, and what the compositor really shows
// (webContents.capturePage, not a canvas read-back, which can read fine while the screen is white) is compared with what ffmpeg decodes from
// the same stream. This is the check for the failure Knot has had before: a hardware decoder that "works" and paints a white or black picture.
//   node tests/run-electron-smoke.js tests/share-player-gpu.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { linuxMainGpu, applyLinuxMainGpuEnvironment, nvidiaVaapiDrivers } = require('../linux-gpu');
const { applyGpuAccelerationPolicy } = require('../gpu-acceleration');

const ROOT = path.join(__dirname, '..');
const W = 1280, H = 720, SHOWN_W = 640, SHOWN_H = 360, FRAMES = 240;
const fail = error => { console.error(error?.stack || error); app.exit(1); };

// Apply the app's GPU configuration before Electron is ready, as main.js does.
const gpu = process.platform === 'linux' ? linuxMainGpu() : null;
const nvidia = gpu?.vendor === '0x10de';
const driver = nvidia ? nvidiaVaapiDrivers(process.env, fs, { bundledDirs: [path.join(ROOT, 'vendor', 'nvidia-vaapi')] })[0] || null : null;
const wayland = process.platform === 'linux' && process.env.KNOT_ELECTRON_SMOKE_X11 !== '1' && !!(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY);
let configured = false;
if (gpu) { try { configured = !!(applyLinuxMainGpuEnvironment(gpu, process.env, { nvidiaVaapi: !!driver, nvidiaVaapiDir: driver?.dir || '' }) && applyGpuAccelerationPolicy(app, { platform: process.platform, gpu, wayland, nvidiaVaapi: !!driver })); } catch (error) { fail(error); } }

function makeClip(dir) {
  const clip = path.join(dir, 'clip.ivf');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=60:d=${FRAMES / 60}`, '-c:v', 'libsvtav1', '-preset', '10', '-g', '120', '-b:v', '5M', '-pix_fmt', 'yuv420p', '-f', 'ivf', clip]);
  if (made.status !== 0) return null;
  // The last picture, as ffmpeg decodes it, scaled the way the page shows it.
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', `select=eq(n\\,${FRAMES - 1}),scale=${SHOWN_W}:${SHOWN_H}:flags=bilinear`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
  return { clip, reference: raw };
}

// Mean absolute difference per colour channel, between the captured page (BGRA) and the reference (RGB), over the picture's own area.
function difference(bitmap, size, reference) {
  // The capture is in device pixels (the page may be scaled); the reference is SHOWN_W x SHOWN_H, so sample the capture at the matching places.
  let total = 0, count = 0, white = 0, black = 0;
  const sx = size.width / SHOWN_W, sy = size.height / SHOWN_H;
  for (let y = 0; y < SHOWN_H; y += 2) for (let x = 0; x < SHOWN_W; x += 2) {
    const at = (Math.min(size.height - 1, Math.round(y * sy)) * size.width + Math.min(size.width - 1, Math.round(x * sx))) * 4, ref = (y * SHOWN_W + x) * 3;
    const r = bitmap[at + 2], g = bitmap[at + 1], b = bitmap[at];
    total += Math.abs(r - reference[ref]) + Math.abs(g - reference[ref + 1]) + Math.abs(b - reference[ref + 2]); count += 3;
    if (r > 245 && g > 245 && b > 245) white++; else if (r < 10 && g < 10 && b < 10) black++;
  }
  const samples = count / 3;
  return { mad: total / count, whiteShare: white / samples, blackShare: black / samples };
}

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-player-gpu-'));
  try {
    if (process.env.KNOT_TEST_VISIBLE !== '1') { console.log('SKIP share player GPU test: it needs a real window on the real GPU, which would appear on screen (KNOT_TEST_VISIBLE=1 to run it)'); return app.exit(0); }
    if (!gpu) { console.log('SKIP share player GPU test: no Linux GPU selection'); return app.exit(0); }
    const made = makeClip(dir);
    if (!made) { console.log('SKIP share player GPU test: ffmpeg with libsvtav1 is not available'); return app.exit(0); }
    fs.writeFileSync(path.join(dir, 'page.html'), `<!doctype html><html><body style="margin:0;background:#202020"><canvas id="c" style="position:absolute;left:0;top:0;width:${SHOWN_W}px;height:${SHOWN_H}px"></canvas></body></html>`);
    const window = new BrowserWindow({ show: true, opacity: 0, skipTaskbar: true, focusable: false, width: 800, height: 500, useContentSize: true, backgroundColor: '#202020',
      webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, backgroundThrottling: false } });
    await window.loadFile(path.join(dir, 'page.html'));
    await new Promise(resolve => setTimeout(resolve, 600));

    const run = async preferSoftware => {
      await window.webContents.executeJavaScript('document.getElementById("c").getContext("2d").clearRect(0,0,1,1);true');
      return window.webContents.executeJavaScript(`(async () => {
        const fs = require('fs'), ROOT = ${JSON.stringify(ROOT)};
        const { ShareSender, ShareReceiver } = require(ROOT + '/share-core'), { createSharePlayer } = require(ROOT + '/share-player'), { TYPE } = require(ROOT + '/share-wire');
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const data = fs.readFileSync(${JSON.stringify(made.clip)}), frames = [];
        for (let at = data.readUInt16LE(6); at + 12 <= data.length;) { const size = data.readUInt32LE(at); frames.push(new Uint8Array(data.subarray(at + 12, at + 12 + size))); at += 12 + size; }
        const canvas = document.getElementById('c'); const surface = { canvas, context: canvas.getContext('2d', ${process.env.SHARE_GPU_CTX || "{ alpha: false }"}), reveal() {} };
        const states = [], errors = []; let ended = false;
        const player = createSharePlayer({ surface, preferSoftware: ${preferSoftware}, onState: s => { states.push(s.state); if (s.state === 'ended') ended = true; }, onError: e => errors.push(String(e.message || e)) });
        const CONFIG = { codec: 'av01.0.08M.08', width: ${W}, height: ${H}, fps: 60 };
        const sender = new ShareSender({ emit: () => {} }), receiver = new ShareReceiver({ onRecord: record => player.push(record) });
        sender.setConfig(CONFIG); player.configure(CONFIG);
        const offer = sender.addViewer('v'); receiver.start(offer.startSeq);
        sender.attachLane('v', 'l', { kind: 'dc', write: bytes => { receiver.pushBytes('l', bytes); return true; } });
        const ack = setInterval(() => { sender.onAck('v', receiver.ackSeq); sender.tick(); }, 100);
        const t0 = performance.now();
        for (let i = 0; i < frames.length; i++) { const wait = t0 + i * 1000 / 60 - performance.now(); if (wait > 1) await sleep(wait); sender.pushFrame({ key: i % 120 === 0, pts: Math.round(i * 1e6 / 60), data: frames[i] }); }
        sender.end();
        for (let waited = 0; !ended && waited < 15000; waited += 50) await sleep(50);
        await sleep(400);                      // let the last picture reach the screen
        const stats = player.stats(); clearInterval(ack); player.destroy();
        return { ended, errors, decoder: stats.decoder, softwareReason: stats.softwareReason, painted: stats.painted, decoded: stats.decoded, width: stats.width, height: stats.height, states: [...new Set(states)] };
      })()`);
    };
    let shots = 0;
    const capture = async () => {
      const image = await window.webContents.capturePage({ x: 0, y: 0, width: SHOWN_W, height: SHOWN_H });
      if (process.env.SHARE_GPU_SAVE) fs.writeFileSync(path.join(process.env.SHARE_GPU_SAVE, 'shot' + (shots++) + '.png'), image.toPNG());
      return difference(image.toBitmap(), image.getSize(), made.reference);
    };

    const software = await run(true), softwareShot = await capture();
    const hardware = await run(false), hardwareShot = await capture();
    const status = app.getGPUFeatureStatus();
    const report = { gpu: gpu.vendor + ' ' + gpu.renderNode, configured, nvidiaDriver: driver ? 'bundled' : nvidia ? 'none found' : 'n/a', video_decode: status.video_decode, software: { ...software, ...softwareShot }, hardware: { ...hardware, ...hardwareShot } };
    console.log(JSON.stringify(report));

    for (const [name, result, shot] of [['software', software, softwareShot], ['hardware-preferred', hardware, hardwareShot]]) {
      assert.deepStrictEqual(result.errors, [], `${name}: the player reported errors`);
      assert(result.ended && result.painted > FRAMES * 0.6, `${name}: only ${result.painted} of ${FRAMES} pictures were shown (ended ${result.ended})`);
      assert(shot.whiteShare < 0.5 && shot.blackShare < 0.5, `${name}: the screen shows a ${shot.whiteShare >= 0.5 ? 'white' : 'black'} picture (white ${shot.whiteShare.toFixed(2)}, black ${shot.blackShare.toFixed(2)})`);
      assert(shot.mad < softwareShot.mad + 8 && shot.mad < 20, `${name}: the screen differs from ffmpeg's decode by ${shot.mad.toFixed(1)} (software control: ${softwareShot.mad.toFixed(1)})`);
    }
    console.log(`PASS the player's picture on screen matches ffmpeg (software: ${softwareShot.mad.toFixed(1)}, ${hardware.decoder} preferred: ${hardwareShot.mad.toFixed(1)}; decoder used ${hardware.decoder}${hardware.softwareReason ? ' because ' + hardware.softwareReason : ''})`);
    app.exit(0);
  } catch (error) { fail(error); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
