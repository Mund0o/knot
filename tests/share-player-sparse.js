'use strict';

// A screen that changes a few times a second, then stops. A decoder that holds pictures back (Chromium's software AV1 decoder does, unless it
// is told to favour latency) shows every picture late and leaves the last few inside it for good: measured at 5 pictures a second, 1 second
// late and four stuck. The player must show each picture promptly and show the last one, and must not move to its fast mode for a stream like this.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const PICTURES = 20, INTERVAL_MS = 200;
const fail = error => { console.error(error?.stack || error); app.exit(1); };

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-player-sparse-'));
  try {
    const clip = path.join(dir, 'clip.ivf');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=60:d=${PICTURES / 60 + 0.1}`, '-c:v', 'libsvtav1', '-preset', '12', '-g', '240', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-f', 'ivf', clip], { encoding: 'utf8' });
    if (made.status !== 0) { console.log('SKIP sparse player test: ffmpeg with libsvtav1 is not available'); return app.exit(0); }
    fs.writeFileSync(path.join(dir, 'blank.html'), '<!doctype html><html><body style="margin:0"></body></html>');
    // Offscreen: a covered real window has its frames throttled by the window system, which this test is not about.
    const window = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
    window.webContents.setFrameRate(60);
    await window.loadFile(path.join(dir, 'blank.html'));
    const play = () => window.webContents.executeJavaScript(`(async () => {
      const fs = require('fs');
      const { ShareSender, ShareReceiver } = require(${JSON.stringify(ROOT)} + '/share-core');
      const { createSharePlayer } = require(${JSON.stringify(ROOT)} + '/share-player');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const data = fs.readFileSync(${JSON.stringify(clip)}), frames = [];
      for (let at = data.readUInt16LE(6); at + 12 <= data.length;) { const size = data.readUInt32LE(at); frames.push(new Uint8Array(data.subarray(at + 12, at + 12 + size))); at += 12 + size; }
      const count = Math.min(${PICTURES}, frames.length);
      const canvas = document.createElement('canvas'); document.body.append(canvas);
      const errors = [];
      const player = createSharePlayer({ preferSoftware: true, surface: { canvas, context: canvas.getContext('2d', { alpha: false }), reveal() {} }, getDisplaySize: () => ({ width: 1280, height: 720 }), onError: e => errors.push(String(e.message || e)) });
      const sender = new ShareSender({ emit: () => {} }), receiver = new ShareReceiver({ onRecord: record => player.push(record) });
      const config = { codec: 'av01.0.13H.08', width: 1920, height: 1080, fps: 60 };
      sender.setConfig(config); player.configure(config);
      receiver.start(sender.addViewer('v').startSeq);
      sender.attachLane('v', 'l', { kind: 'dc', write: bytes => { receiver.pushBytes('l', bytes); return true; } });
      const timer = setInterval(() => { sender.onAck('v', receiver.ackSeq); sender.tick(); }, 100);
      for (let i = 0; i < count; i++) { sender.pushFrame({ key: i === 0, pts: Math.round(i * 1e6 / 5), data: frames[i] }); await sleep(${INTERVAL_MS}); }
      await sleep(1200);                      // the screen has stopped changing
      clearInterval(timer);
      const s = player.stats(); player.destroy();
      return { ...s, count, errorMessages: errors };
    })()`);
    const check = (r, label) => {
      assert.deepStrictEqual(r.errorMessages, [], 'decoder errors: ' + r.errorMessages.join('; '));
      console.log(`${label}: ${r.painted}/${r.count} pictures shown, latency p50 ${Math.round(r.latencyP50Ms)} ms p95 ${Math.round(r.latencyP95Ms)} ms, ${r.pending} left inside the decoder, decode mode ${r.decodeMode}, ${r.modeSwitches} switches`);
      assert.strictEqual(r.pending, 0, r.pending + ' pictures were stuck inside the decoder after the stream went quiet');
      assert.strictEqual(r.painted, r.count, `only ${r.painted} of ${r.count} pictures were shown (the last ones stuck?)`);
    };
    const r = await play();
    check(r, 'sparse stream');
    assert(r.latencyP95Ms < 700, 'pictures were shown ' + Math.round(r.latencyP95Ms) + ' ms after they arrived');
    assert.strictEqual(r.decodeMode, 'low-latency', 'a sparse stream must stay in low-latency mode');
    assert.strictEqual(r.modeSwitches, 0, 'a sparse stream must not switch decode modes');
    console.log('PASS a sparse stream shows every picture, promptly, and the last one');
    app.exit(0);
  } catch (error) { fail(error); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
