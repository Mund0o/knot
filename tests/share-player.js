'use strict';

// The viewer's player in a real renderer: a real AV1 stream goes through the sender, the wire format, the receiver and the player,
// and what comes out of Chromium's decoder is compared, pixel for pixel, with what ffmpeg decodes from the same stream.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const fail = error => { console.error(error?.stack || error); app.exit(1); };

function makeClip(dir) {
  const clip = path.join(dir, 'clip.ivf');
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60:d=4', '-c:v', 'libsvtav1', '-preset', '10', '-g', '120', '-b:v', '5M', '-pix_fmt', 'yuv420p', '-f', 'ivf', clip], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const md5 = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop().trim());
  return { clip, md5 };
}

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-player-'));
  try {
    const made = makeClip(dir);
    if (!made) { console.log('SKIP share player test: ffmpeg with libsvtav1 is not available'); return app.exit(0); }
    fs.writeFileSync(path.join(dir, 'blank.html'), '<!doctype html><html><body></body></html>');
    const window = new BrowserWindow({
      show: process.env.KNOT_ELECTRON_SMOKE_X11 === '1', opacity: process.env.KNOT_ELECTRON_SMOKE_X11 === '1' ? 0 : 1, skipTaskbar: process.env.KNOT_ELECTRON_SMOKE_X11 === '1', width: 1000, height: 600,
      webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, backgroundThrottling: false, offscreen: process.env.KNOT_ELECTRON_SMOKE_X11 !== '1' },
    });
    const pageErrors = []; window.webContents.on('console-message', event => { if (/Uncaught/.test(event.message || '')) pageErrors.push(event.message); });
    await window.loadFile(path.join(dir, 'blank.html'));

    const report = await window.webContents.executeJavaScript(`(async () => {
      const fs = require('fs'), crypto = require('crypto');
      const ROOT = ${JSON.stringify(ROOT)}, CLIP = ${JSON.stringify(made.clip)};
      const { ShareSender, ShareReceiver } = require(ROOT + '/share-core');
      const { createSharePlayer } = require(ROOT + '/share-player');
      const { TYPE } = require(ROOT + '/share-wire');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const data = fs.readFileSync(CLIP), frames = [];
      for (let at = data.readUInt16LE(6); at + 12 <= data.length;) { const size = data.readUInt32LE(at); frames.push(new Uint8Array(data.subarray(at + 12, at + 12 + size))); at += 12 + size; }
      const CONFIG = { codec: 'av01.0.08M.08', width: 1280, height: 720, fps: 60 };
      const out = { frames: frames.length };

      // Builds a viewer: sender -> (wire bytes) -> receiver -> player, with a canvas to draw on.
      function viewer(options = {}) {
        const canvas = document.createElement('canvas'); document.body.append(canvas);
        const surface = { canvas, context: canvas.getContext('2d', { alpha: false }), reveal() {} };
        const hashes = {}, want = new Set(options.hashAt || []);
        const states = [], errors = [];
        const player = createSharePlayer({ surface, onState: s => states.push(s.state), onError: e => errors.push(String(e.message || e)), preferSoftware: options.preferSoftware,
          onFrameDecoded: frame => { const index = Math.round(frame.timestamp * 60 / 1e6); if (want.has(index)) { const buffer = new Uint8Array(frame.allocationSize()); frame.copyTo(buffer); hashes[index] = crypto.createHash('md5').update(buffer).digest('hex'); } } });
        const sender = new ShareSender({ emit: () => {} });
        const receiver = new ShareReceiver({ onRecord: record => player.push(record) });
        sender.setConfig(CONFIG); player.configure(CONFIG);
        const offer = sender.addViewer('v'); receiver.start(offer.startSeq);
        sender.attachLane('v', 'l', { kind: 'dc', write: bytes => { receiver.pushBytes('l', bytes); return true; } });
        const ackTimer = setInterval(() => { sender.onAck('v', receiver.ackSeq); sender.tick(); }, 100);
        return { canvas, player, sender, receiver, hashes, states, errors, stop() { clearInterval(ackTimer); player.destroy(); canvas.remove(); } };
      }
      async function feed(v, from, to, realtime = true) {
        const t0 = performance.now();
        for (let i = from; i < to; i++) {
          if (realtime) { const due = t0 + (i - from) * 1000 / 60; const wait = due - performance.now(); if (wait > 1) await sleep(wait); }
          v.sender.pushFrame({ key: i % 120 === 0, pts: Math.round(i * 1e6 / 60), data: frames[i] });
        }
      }
      const settle = async (v, ms = 12000) => { for (let waited = 0; waited < ms; waited += 50) { const s = v.player.stats(); if (v.player.ended && s.decodedWaiting === 0 && s.pending === 0 && s.queued === 0) return; await sleep(50); } };

      // 1. Every picture decodes, and what comes out is what ffmpeg decodes.
      {
        const samples = [0, 1, 59, 120, 180, 239];
        const v = viewer({ hashAt: samples });
        await feed(v, 0, frames.length); v.sender.end(); await settle(v);
        const s = v.player.stats();
        const px = v.canvas.getContext('2d').getImageData(0, 0, v.canvas.width, v.canvas.height).data;
        let distinct = new Set(); for (let i = 0; i < px.length; i += 4 * 997) distinct.add(px[i] + ',' + px[i + 1] + ',' + px[i + 2]);
        out.one = { decoded: s.decoded, painted: s.painted, skippedShown: s.skippedShown, skippedAtStart: s.skippedAtStart, errors: v.errors, states: [...new Set(v.states)], width: s.width, height: s.height, hashes: v.hashes, distinctColors: distinct.size, canvas: [v.canvas.width, v.canvas.height], stalls: s.stalls, jumps: s.jumps, cadenceP95: Math.round(s.renderCadenceP95Ms), latencyP95: Math.round(s.latencyP95Ms), decoder: s.decoder, delayMs: s.delayMs };
        v.stop();
      }

      // 2. A skip (the sharer moved this viewer forward) restarts cleanly from the next key picture.
      {
        const v = viewer(); await feed(v, 0, 100);
        v.player.skip(); v.receiver.skipTo(v.receiver.ackSeq + 1);
        await feed(v, 120, frames.length); v.sender.end(); await settle(v);
        const s = v.player.stats(); out.skip = { decoded: s.decoded, errors: v.errors, decodeSkips: s.decodeSkips, painted: s.painted }; v.stop();
      }

      // 3. Hidden and shown again: nothing piles up while hidden, and it resumes from a key picture.
      {
        const v = viewer(); await feed(v, 0, 60);
        v.player.setActive(false); await feed(v, 60, 200, false);
        const hidden = v.player.stats();
        v.player.setActive(true); await feed(v, 200, 230); await sleep(1500);
        const s = v.player.stats(); out.inactive = { queuedWhileHidden: hidden.queued, decodedWaitingWhileHidden: hidden.decodedWaiting, paintedAfter: s.painted, errors: v.errors }; v.stop();
      }

      // 4. A decoder that cannot take the stream at all is reported once, and does not loop.
      {
        const canvas = document.createElement('canvas'), errors = [];
        const player = createSharePlayer({ surface: { canvas, context: canvas.getContext('2d') }, onError: e => errors.push(String(e.message || e)) });
        player.configure({ codec: 'av01.0.99H.08', width: 1280, height: 720, fps: 60 }); await sleep(300);
        out.broken = { errors, stats: player.stats().errors }; player.destroy();
      }
      // 5. A "hardware" decoder that works (every picture decodes, nothing throws) but hands back black pictures is caught on the first picture and
      // replaced by the software decoder. An honest one is left alone. (The decoders here are stand-ins: this machine's Chromium has no hardware
      // decoder, so each one wraps the software decoder and only claims to be hardware.)
      {
        const RealDecoder = window.VideoDecoder;
        const makeFake = lie => class FakeHardware {
          constructor(init) { this.init = init; this.inner = null; }
          static isConfigSupported(config) { return RealDecoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-software' }); }
          configure(config) {
            const hardware = config.hardwareAcceleration === 'prefer-hardware';
            const init = hardware && lie ? { output: frame => { const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight), g = canvas.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height); const black = new VideoFrame(canvas, { timestamp: frame.timestamp }); frame.close(); this.init.output(black); }, error: e => this.init.error(e) } : this.init;
            this.inner = new RealDecoder(init); this.inner.configure({ ...config, hardwareAcceleration: 'prefer-software' });
          }
          decode(chunk) { this.inner.decode(chunk); } flush() { return this.inner.flush(); } close() { try { this.inner.close(); } catch {} } get decodeQueueSize() { return this.inner?.decodeQueueSize || 0; }
        };
        try {
          window.VideoDecoder = makeFake(true);
          const liar = viewer({ hashAt: [200, 239] }); await feed(liar, 0, frames.length); liar.sender.end(); await settle(liar);
          const ls = liar.player.stats(), lpx = liar.canvas.getContext('2d').getImageData(0, 0, liar.canvas.width, liar.canvas.height).data; let lcolors = new Set(); for (let i = 0; i < lpx.length; i += 4 * 997) lcolors.add(lpx[i] + ',' + lpx[i + 1] + ',' + lpx[i + 2]);
          out.liar = { decoder: ls.decoder, reason: ls.softwareReason, verification: ls.verification, restarts: ls.restarts, errors: liar.errors, hashes: liar.hashes, colors: lcolors.size, painted: ls.painted }; liar.stop();
          window.VideoDecoder = makeFake(false);
          const honest = viewer(); await feed(honest, 0, 150); await sleep(800);
          const hs = honest.player.stats(); out.honest = { decoder: hs.decoder, verification: hs.verification, restarts: hs.restarts, errors: honest.errors }; honest.stop();
        } finally { window.VideoDecoder = RealDecoder; }
      }
      return out;
    })()`);
    if (pageErrors.length) throw new Error('page errors: ' + pageErrors.join(' | '));

    const one = report.one;
    assert.deepStrictEqual(one.errors, [], 'decoder errors: ' + one.errors.join('; '));
    assert.strictEqual(one.decoded, report.frames, `decoded ${one.decoded} of ${report.frames}`);
    assert.strictEqual(one.painted + one.skippedShown + one.skippedAtStart, one.decoded, 'every decoded picture is either shown or counted as skipped');
    assert.strictEqual(one.skippedAtStart, 0);
    assert.strictEqual(one.stalls, 0, 'a loopback stream must not stall');
    assert.strictEqual(one.jumps, 0);
    assert.deepStrictEqual([one.width, one.height], [1280, 720]);
    assert(one.distinctColors > 20, 'the canvas must show a real picture, not a blank one (' + one.distinctColors + ' colours sampled)');
    for (const [index, md5] of Object.entries(one.hashes)) assert.strictEqual(md5, made.md5[Number(index)], `picture ${index}: Chromium decoded something different from ffmpeg`);
    assert.strictEqual(Object.keys(one.hashes).length, 6, 'all six sampled pictures were checked');
    assert(one.states.includes('live'), 'the player must reach "live": ' + one.states);
    console.log(`PASS real AV1 plays: ${one.decoded} pictures, ${one.painted} shown, 6 sampled pictures bit-identical to ffmpeg, ${one.decoder} decoder, cadence p95 ${one.cadenceP95} ms, latency p95 ${one.latencyP95} ms, delay ${one.delayMs} ms`);

    assert.deepStrictEqual(report.skip.errors, []);
    assert(report.skip.decodeSkips >= 1 && report.skip.decoded > 100 && report.skip.painted > 50, 'after a skip it must carry on: ' + JSON.stringify(report.skip));
    console.log('PASS after the sharer moves a viewer forward, playback restarts from the next key picture');

    assert.deepStrictEqual(report.inactive.errors, []);
    assert(report.inactive.queuedWhileHidden <= 130, 'while hidden only the newest group of pictures may be kept, kept ' + report.inactive.queuedWhileHidden);
    assert.strictEqual(report.inactive.decodedWaitingWhileHidden, 0, 'no decoded pictures (they are large) may be held while hidden');
    assert(report.inactive.paintedAfter > 0, 'it must paint again once shown');
    console.log(`PASS hiding the viewer keeps ${report.inactive.queuedWhileHidden} encoded pictures and no decoded ones, and showing it resumes`);

    assert(report.broken.errors.length === 1, 'an impossible stream is reported exactly once: ' + JSON.stringify(report.broken));
    console.log('PASS a stream no decoder can take is reported once, without looping');

    const liar = report.liar;
    assert.deepStrictEqual(liar.errors, [], 'the fallback must not be reported as a failure: ' + liar.errors.join('; '));
    assert.strictEqual(liar.decoder, 'software', 'a hardware decoder that paints black was not replaced');
    assert(/different picture/.test(liar.reason), 'the reason must say why: ' + JSON.stringify(liar));
    assert.strictEqual(liar.restarts, 1);
    assert(liar.colors > 20 && liar.painted > 100, 'after the switch the screen must show the real picture: ' + liar.colors + ' colours, ' + liar.painted + ' painted');
    for (const index of ['200', '239']) assert.strictEqual(liar.hashes[index], made.md5[Number(index)], `picture ${index} after the switch is not what ffmpeg decodes`);
    assert.strictEqual(report.honest.decoder, 'hardware-preferred', 'an honest hardware decoder was replaced');
    assert.strictEqual(report.honest.verification, 'ok'); assert.strictEqual(report.honest.restarts, 0); assert.deepStrictEqual(report.honest.errors, []);
    console.log('PASS a hardware decoder that shows black pictures is caught on its first picture and replaced by the software decoder; an honest one is left alone');

    console.log('ALL SHARE PLAYER CHECKS PASSED');
    app.exit(0);
  } catch (error) { fail(error); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
