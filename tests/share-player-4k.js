'use strict';

// How well this machine plays a 4K60 AV1 share: a real 3840x2160 stream goes through the same chain as share-player.js, fed at 60 fps.
// It reports what a viewer would see (are all pictures shown, is the cadence steady, how late is the picture) and fails only when
// the machine cannot keep up at all. It depends on the machine's CPU or GPU, so it is part of the screen suite, not the core one.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const SECONDS = Number(process.env.SHARE_4K_SECONDS || 8);
const fail = error => { console.error(error?.stack || error); app.exit(1); };

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-player4k-'));
  try {
    const clip = path.join(dir, 'clip.ivf');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=3840x2160:r=60:d=${SECONDS}`, '-c:v', 'libsvtav1', '-preset', '12', '-g', '120', '-b:v', '16M', '-pix_fmt', 'yuv420p', '-f', 'ivf', clip], { encoding: 'utf8' });
    if (made.status !== 0) { console.log('SKIP 4K player test: ffmpeg with libsvtav1 is not available'); return app.exit(0); }
    fs.writeFileSync(path.join(dir, 'blank.html'), '<!doctype html><html><body style="margin:0"></body></html>');
    const x11 = process.env.KNOT_ELECTRON_SMOKE_X11 === '1';
    const window = new BrowserWindow({ show: x11, opacity: x11 ? 0 : 1, skipTaskbar: x11, width: 1600, height: 900,
      webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, backgroundThrottling: false, offscreen: !x11 } });
    await window.loadFile(path.join(dir, 'blank.html'));
    const r = await window.webContents.executeJavaScript(`(async () => {
      const fs = require('fs');
      const { ShareSender, ShareReceiver } = require(${JSON.stringify(ROOT)} + '/share-core');
      const { createSharePlayer } = require(${JSON.stringify(ROOT)} + '/share-player');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const data = fs.readFileSync(${JSON.stringify(clip)}), frames = [];
      for (let at = data.readUInt16LE(6); at + 12 <= data.length;) { const size = data.readUInt32LE(at); frames.push(new Uint8Array(data.subarray(at + 12, at + 12 + size))); at += 12 + size; }
      const canvas = document.createElement('canvas'); document.body.append(canvas);
      const errors = [];
      const player = createSharePlayer({ surface: { canvas, context: canvas.getContext('2d', { alpha: false }), reveal() {} }, getDisplaySize: () => ({ width: 1600, height: 900 }), onError: e => errors.push(String(e.message || e)) });
      const sender = new ShareSender({ emit: () => {} }), receiver = new ShareReceiver({ onRecord: record => player.push(record) });
      const config = { codec: 'av01.0.13H.08', width: 3840, height: 2160, fps: 60 };
      sender.setConfig(config); player.configure(config);
      receiver.start(sender.addViewer('v').startSeq);
      sender.attachLane('v', 'l', { kind: 'dc', write: bytes => { receiver.pushBytes('l', bytes); return true; } });
      const timer = setInterval(() => { sender.onAck('v', receiver.ackSeq); sender.tick(); }, 100);
      const t0 = performance.now();
      for (let i = 0; i < frames.length; i++) {
        const wait = t0 + i * 1000 / 60 - performance.now(); if (wait > 1) await sleep(wait);
        sender.pushFrame({ key: i % 120 === 0, pts: Math.round(i * 1e6 / 60), data: frames[i] });
      }
      sender.end();
      for (let waited = 0; waited < 20000; waited += 50) { const s = player.stats(); if (player.ended && !s.decodedWaiting && !s.pending && !s.queued) break; await sleep(50); }
      clearInterval(timer);
      const s = player.stats(); player.destroy();
      return { ...s, frames: frames.length, errorMessages: errors, cores: navigator.hardwareConcurrency };
    })()`);
    assert.deepStrictEqual(r.errorMessages, [], 'decoder errors: ' + r.errorMessages.join('; '));
    assert.strictEqual(r.decoded, r.frames, `decoded ${r.decoded} of ${r.frames}`);
    const shown = r.painted / r.frames;
    console.log(`4K60 on ${r.cores} cores (${r.decoder}): ${r.painted}/${r.frames} pictures shown (${(shown * 100).toFixed(1)}%), ${r.skippedShown} skipped, ${r.stalls} stalls, ${r.jumps} jumps, cadence p95 ${Math.round(r.renderCadenceP95Ms)} ms, ${r.renderFps.toFixed(1)} fps, latency p95 ${Math.round(r.latencyP95Ms)} ms, delay ${r.delayMs} ms`);
    assert(shown > 0.9, 'this machine cannot play 4K60: only ' + (shown * 100).toFixed(0) + '% of pictures were shown');
    assert(r.stalls <= 1, 'the picture stalled ' + r.stalls + ' times on a loopback stream');
    console.log('PASS 4K60 AV1 plays on this machine');
    app.exit(0);
  } catch (error) { fail(error); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
