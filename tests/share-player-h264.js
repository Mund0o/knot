'use strict';

// A 1080p58 H.264 share (what a Windows sharer's page encoder sends) played in the viewer's player at the pace it arrives. The player must show nearly
// every picture the sender made: a screen that is shown at 33 of 58 pictures a second is a stuttering screen even though nothing is lost on the link.
// Offscreen, so the window system's own frame throttling for covered windows cannot colour the result.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const FPS = Number(process.env.H264_FPS) || 58, SECONDS = Number(process.env.H264_SECONDS) || 8, MBPS = Number(process.env.H264_MBPS) || 19;
const SOFTWARE = process.env.H264_SOFTWARE === '1', JITTER_MS = Number(process.env.H264_JITTER_MS) || 0;
const fail = error => { console.error(error?.stack || error); app.exit(1); };

// Annex B access units, split at the access unit delimiter x264 writes before each picture.
function splitAccessUnits(data) {
  const starts = [];
  for (let at = 0; at + 5 < data.length; at++) if (data[at] === 0 && data[at + 1] === 0 && data[at + 2] === 0 && data[at + 3] === 1 && (data[at + 4] & 0x1f) === 9) starts.push(at);
  return starts.map((start, index) => data.subarray(start, starts[index + 1] ?? data.length));
}
const hasKey = unit => { for (let at = 0; at + 4 < unit.length; at++) if (unit[at] === 0 && unit[at + 1] === 0 && (unit[at + 2] === 1 || (unit[at + 2] === 0 && unit[at + 3] === 1))) { const nal = unit[at + (unit[at + 2] === 1 ? 3 : 4)] & 0x1f; if (nal === 5) return true; } return false; };

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-player-h264-'));
  try {
    const clip = path.join(dir, 'clip.h264');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=${FPS}:d=${SECONDS}`, '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-bf', '0',
      '-g', String(FPS * 4), '-b:v', MBPS + 'M', '-maxrate', MBPS + 'M', '-bufsize', Math.round(MBPS / FPS * 4) + 'M', '-x264-params', 'aud=1:repeat-headers=1', '-pix_fmt', 'yuv420p', '-f', 'h264', clip], { encoding: 'utf8' });
    if (made.status !== 0) { console.log('SKIP H.264 player test: ffmpeg with libx264 is not available'); return app.exit(0); }
    const units = splitAccessUnits(fs.readFileSync(clip));
    assert(units.length > FPS * (SECONDS - 1), 'the clip has ' + units.length + ' pictures');
    fs.writeFileSync(path.join(dir, 'blank.html'), '<!doctype html><html><body style="margin:0"></body></html>');
    const window = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
    window.webContents.setFrameRate(60);
    await window.loadFile(path.join(dir, 'blank.html'));
    const sizes = units.map(unit => unit.length), keys = units.map(hasKey);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const fs = require('fs');
      const { ShareSender, ShareReceiver } = require(${JSON.stringify(ROOT)} + '/share-core');
      const { createSharePlayer } = require(${JSON.stringify(ROOT)} + '/share-player');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const keys = ${JSON.stringify(keys)}, sizes = ${JSON.stringify(sizes)}, offsets = [];
      const whole = fs.readFileSync(${JSON.stringify(clip)});
      const units = [];
      for (let at = 0, i = 0; i < sizes.length; i++) { units.push(new Uint8Array(whole.subarray(at, at + sizes[i]))); at += sizes[i]; }
      const canvas = document.createElement('canvas'); document.body.append(canvas);
      const errors = [];
      const player = createSharePlayer({ preferSoftware: ${SOFTWARE}, surface: { canvas, context: canvas.getContext('2d', { alpha: false }), reveal() {} }, getDisplaySize: () => ({ width: 1280, height: 720 }), onError: e => errors.push(String(e.message || e)) });
      const sender = new ShareSender({ emit: () => {} }), receiver = new ShareReceiver({ onRecord: record => player.push(record) });
      const config = { codec: 'avc1.64002a', width: 1920, height: 1080, fps: ${FPS} };
      sender.setConfig(config); player.configure(config);
      receiver.start(sender.addViewer('v').startSeq);
      sender.attachLane('v', 'l', { kind: 'dc', write: bytes => { receiver.pushBytes('l', bytes); return true; } });
      const timer = setInterval(() => { sender.onAck('v', receiver.ackSeq); sender.tick(); }, 100);
      const start = performance.now(), interval = 1000 / ${FPS}, samples = [];
      let lastPainted = 0, lastReceived = 0, lastAt = start;
      const sampler = setInterval(() => { const s = player.stats(), t = performance.now(); samples.push({ at: Math.round(t - start), received: (s.received - lastReceived) * 1000 / (t - lastAt), shown: (s.painted - lastPainted) * 1000 / (t - lastAt), delay: Math.round(s.delayMs || 0), pending: s.pending, mode: s.decodeMode }); lastPainted = s.painted; lastReceived = s.received; lastAt = t; }, 1000);
      for (let i = 0; i < units.length; i++) {
        const due = start + i * interval + (${JITTER_MS} ? Math.random() * ${JITTER_MS} : 0);
        const wait = due - performance.now(); if (wait > 0) await sleep(wait);
        sender.pushFrame({ key: keys[i], pts: Math.round(i * 1e6 / ${FPS}), data: units[i] });
      }
      await sleep(1500);
      clearInterval(timer); clearInterval(sampler);
      const stats = player.stats(); player.destroy();
      return { stats, samples, count: units.length, errors };
    })()`);
    const { stats, samples, count, errors } = result;
    assert.deepStrictEqual(errors, [], 'decoder errors: ' + errors.join('; '));
    console.log(`${SOFTWARE ? 'software' : 'default'} decoder, ${FPS} fps, ${MBPS} Mbps${JITTER_MS ? ', arrival jitter ' + JITTER_MS + ' ms' : ''}: ${stats.painted}/${count} pictures shown (${stats.received} received), decoder ${stats.decoder}, decode mode ${stats.decodeMode}, latency p50 ${Math.round(stats.latencyP50Ms)} ms p95 ${Math.round(stats.latencyP95Ms)} ms, delay ${Math.round(stats.delayMs)} ms`);
    console.log('per second  received/shown/delay: ' + samples.map(s => `${Math.round(s.received)}/${Math.round(s.shown)}/${s.delay}`).join('  '));
    assert(stats.ticks > stats.painted * 0.9 && stats.drawMsP95 > 0, `the player does not report how often the window was redrawn (${stats.ticks}) or how long a picture took to draw (${stats.drawMsP95})`);
    const steady = samples.slice(2, -1);
    const shown = steady.reduce((sum, s) => sum + s.shown, 0) / Math.max(1, steady.length), received = steady.reduce((sum, s) => sum + s.received, 0) / Math.max(1, steady.length);
    console.log(`steady state: ${Math.round(received)} received, ${Math.round(shown)} shown a second`);
    assert(shown >= received * 0.9, `only ${Math.round(shown)} of ${Math.round(received)} pictures a second were shown`);
    console.log('PASS 1080p H.264 is shown at the rate it arrives');
    app.exit(0);
  } catch (error) { fail(error); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
