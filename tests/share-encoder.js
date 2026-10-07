'use strict';

// The in-page screen encoder, in a real renderer: a moving canvas stands in for the screen, goes through the encoder this machine
// picks, then through the same sender / receiver / player chain a share uses, and has to come out the other side as a picture.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const fail = error => { console.error(error?.stack || error); app.exit(1); };

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-encoder-'));
  try {
    fs.writeFileSync(path.join(dir, 'blank.html'), '<!doctype html><html><body></body></html>');
    const x11 = process.env.KNOT_ELECTRON_SMOKE_X11 === '1';
    const window = new BrowserWindow({ show: x11, opacity: x11 ? 0 : 1, skipTaskbar: x11, width: 1280, height: 720,
      webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, backgroundThrottling: false, offscreen: !x11 } });
    const pageErrors = []; window.webContents.on('console-message', event => { if (/Uncaught/.test(event.message || '')) pageErrors.push(event.message); });
    await window.loadFile(path.join(dir, 'blank.html'));
    const r = await window.webContents.executeJavaScript(`(async () => {
      const ROOT = ${JSON.stringify(ROOT)};
      const { ShareSender, ShareReceiver } = require(ROOT + '/share-core');
      const { createSharePlayer } = require(ROOT + '/share-player');
      const Encoder = require(ROOT + '/share-encoder');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const out = {};

      out.supported = Encoder.supported();
      const probed = await Encoder.probe({ width: 1280, height: 720, fps: 30, bitrateKbps: 4000 });
      out.probed = probed.map(p => p.codec + (p.hardware ? ':hw' : ':sw'));
      out.order = { none: Encoder.codecOrder(''), h264: Encoder.codecOrder('H264'), vp9: Encoder.codecOrder('vp9'), vp8: Encoder.codecOrder('VP8'), junk: Encoder.codecOrder(null) };
      const preferred = await Encoder.probe({ width: 1280, height: 720, fps: 30, bitrateKbps: 4000, prefer: 'vp9' });
      out.preferred = preferred.map(p => p.codec + (p.hardware ? ':hw' : ':sw'));
      const chosen = await Encoder.choose({ width: 1280, height: 720, fps: 30, bitrateKbps: 4000 });
      out.chosen = { codec: chosen.choice?.codec, hardware: chosen.choice?.hardware, keepsUp: chosen.keepsUp, sustained: Math.round(chosen.sustainedFps), tried: chosen.tried };
      out.recommended = { av1_1080p60: Encoder.recommendedKbps({ width: 1920, height: 1080, fps: 60, codec: 'av1' }), av1_4k60: Encoder.recommendedKbps({ width: 3840, height: 2160, fps: 60, codec: 'av1' }), h264_4k60: Encoder.recommendedKbps({ width: 3840, height: 2160, fps: 60, codec: 'h264' }), av1_1080p30: Encoder.recommendedKbps({ width: 1920, height: 1080, fps: 30, codec: 'av1' }) };

      // A canvas stands in for the screen: scrolling text and a moving block, repainted at 30 fps.
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720; document.body.append(canvas);
      const context = canvas.getContext('2d');
      let tick = 0;
      const paint = () => {
        context.fillStyle = '#1e1e2e'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#cdd6f4'; context.font = '18px monospace';
        for (let line = 0; line < 36; line++) context.fillText('line ' + (line + Math.floor(tick / 3)) + ': the quick brown fox jumps over the lazy dog ' + (line * 7 % 13), 20, ((line * 22 - (tick % 66) / 3 * 1) % canvas.height + canvas.height) % canvas.height);
        context.fillStyle = 'hsl(' + (tick * 5 % 360) + ' 70% 55%)'; context.fillRect(600 + (tick * 9) % 600, 200, 220, 160); tick++;
      };
      paint(); const painter = setInterval(paint, 33);
      const stream = canvas.captureStream(30), track = stream.getVideoTracks()[0];

      const configs = [], pictures = [], errors = [];
      // The content hint must reach the encoder's own configuration (and only as a hint: size and rate are untouched).
      const configured = []; const realConfigure = VideoEncoder.prototype.configure;
      VideoEncoder.prototype.configure = function (config) { configured.push({ hint: config.contentHint, width: config.width, height: config.height, framerate: config.framerate }); return realConfigure.call(this, config); };
      const encoder = Encoder.create({ track, width: 1280, height: 720, fps: 30, bitrateKbps: 4000, contentHint: 'text', choice: chosen.choice, onConfig: c => configs.push(c), onFrame: f => pictures.push(f), onError: e => errors.push(String(e.message || e)) });
      const running = encoder.start();

      // Straight into a viewer: sender -> wire -> receiver -> player.
      const viewCanvas = document.createElement('canvas'); document.body.append(viewCanvas);
      const playerErrors = [];
      const player = createSharePlayer({ surface: { canvas: viewCanvas, context: viewCanvas.getContext('2d', { alpha: false }), reveal() {} }, onError: e => playerErrors.push(String(e.message || e)) });
      const sender = new ShareSender({ emit: () => {} }), receiver = new ShareReceiver({ onRecord: record => player.push(record) });
      let sentConfig = false;
      const feedTimer = setInterval(() => {
        if (configs.length && !sentConfig) { sender.setConfig(configs[0]); player.configure(configs[0]); const offer = sender.addViewer('v'); receiver.start(offer.startSeq); sender.attachLane('v', 'l', { kind: 'dc', write: bytes => { receiver.pushBytes('l', bytes); return true; } }); sentConfig = true; }
        while (sentConfig && pictures.length) { const f = pictures.shift(); out.fed = (out.fed || 0) + 1; (out.keyTimes ||= []).push(...(f.key ? [f.pts / 1e6] : [])); sender.pushFrame(f); }
        if (sentConfig) { sender.onAck('v', receiver.ackSeq); }
      }, 16);

      await sleep(5200);
      out.beforeResize = encoder.stats();
      // The shared window is resized: the encoder must describe the new size and start on a key picture.
      canvas.width = 960; canvas.height = 540;
      await sleep(2200);
      const stats = encoder.stats();
      clearInterval(painter);
      await encoder.stop(); await running;
      VideoEncoder.prototype.configure = realConfigure; out.configured = configured;
      clearInterval(feedTimer);
      const after = player.stats(); player.destroy();
      out.configs = configs; out.errors = errors; out.playerErrors = playerErrors;
      out.stats = stats; out.player = { painted: after.painted, decoded: after.decoded, width: after.width, height: after.height };
      out.trackEnded = track.readyState;
      const framesAfterStop = pictures.length; await sleep(300); out.noFramesAfterStop = pictures.length === framesAfterStop;
      return out;
    })()`);
    if (pageErrors.length) throw new Error('page errors: ' + pageErrors.join(' | '));

    assert(r.supported, 'this build must be able to encode');
    assert.deepStrictEqual(r.order, { none: ['av1', 'h264', 'vp9'], h264: ['h264', 'av1', 'vp9'], vp9: ['vp9', 'av1', 'h264'], vp8: ['av1', 'h264', 'vp9'], junk: ['av1', 'h264', 'vp9'] }, 'the requested codec does not lead the order');
    const swPreferred = r.preferred.filter(p => p.endsWith(':sw')); assert(!swPreferred.length || swPreferred[0] === 'vp9:sw', 'the requested codec is not tried first among software encoders: ' + r.preferred);
    const hintWanted = r.chosen.codec === 'av1' ? 'text' : undefined;   // the hint goes to AV1 only (it makes H.264 worse)
    assert(r.configured.length >= 2 && r.configured.every(c => c.hint === hintWanted && c.framerate === 30), `content hint ${hintWanted} for ${r.chosen.codec} did not reach every encoder configuration (including after the resize): ` + JSON.stringify(r.configured));
    assert(r.probed.length >= 3, 'at least the software encoders must be found: ' + r.probed);
    assert(r.probed.indexOf(r.probed.find(p => p.endsWith(':sw'))) >= r.probed.filter(p => p.endsWith(':hw')).length, 'hardware encoders are listed before software ones');
    assert(r.chosen.keepsUp, 'this machine should keep up with 720p30: ' + JSON.stringify(r.chosen));
    console.log(`PASS encoder choice: ${r.probed.join(', ')} found; chose ${r.chosen.hardware ? 'hardware' : 'software'} ${r.chosen.codec} (${r.chosen.sustained} fps sustained; tried ${r.chosen.tried.map(t => t.codec + ':' + (t.hardware ? 'hw' : 'sw') + '=' + t.fps).join(' ')})`);

    assert.deepStrictEqual(r.errors, [], 'encoder errors: ' + r.errors.join('; '));
    assert.deepStrictEqual(r.playerErrors, [], 'player errors: ' + r.playerErrors.join('; '));
    assert(r.configs.length === 2, 'one description at the start and one after the resize, got ' + r.configs.length);
    assert.deepStrictEqual([r.configs[0].width, r.configs[0].height, r.configs[1].width, r.configs[1].height], [1280, 720, 960, 540]);
    assert(/^(av01\.|avc1\.|vp09\.)/.test(r.configs[0].codec), 'a real codec string: ' + r.configs[0].codec);
    assert(r.stats.reconfigured === 1, 'the resize is handled once');
    const gaps = r.keyTimes.slice(1).map((t, i) => t - r.keyTimes[i]);
    assert(r.keyTimes.length >= 3, 'key pictures about every 2 s: ' + r.keyTimes);
    const early = gaps.filter(g => g <= 1.4);
    assert(early.length <= 1, 'only the resize may add a key picture early, gaps were ' + gaps.map(g => g.toFixed(2)));
    assert(gaps.filter(g => g > 1.4).every(g => g < 3.2), 'key pictures should be about 2 s apart, were ' + gaps.map(g => g.toFixed(2)));
    const kbps = r.beforeResize.kbps;
    // AV1's screen-content tools (the Desktop hint) need far fewer bits for this synthetic text, at better quality, so the floor is lower then.
    assert(kbps > 4000 * (hintWanted ? 0.1 : 0.2) && kbps < 4000 * 1.4, `bitrate should stay in a sane band around the 4000 kbps asked for, was ${kbps}`);
    assert(r.beforeResize.dropped <= r.beforeResize.encoded * 0.1, 'a capable encoder drops almost nothing: ' + r.beforeResize.dropped);
    assert(r.player.painted > r.player.decoded * 0.8 && r.player.decoded > 150, 'the viewer must show what was encoded: ' + JSON.stringify(r.player));
    assert.deepStrictEqual([r.player.width, r.player.height], [960, 540], 'the viewer follows the new size');
    assert.strictEqual(r.trackEnded, 'ended');
    assert(r.noFramesAfterStop);
    console.log(`PASS in-page encoding: ${r.stats.encoded} pictures, ${kbps} kbps for 4000 asked, ${r.stats.keys} key pictures about 2 s apart, resize handled (new description + key), viewer shows ${r.player.painted} of ${r.player.decoded}, stop() ends the capture`);
    console.log('recommended bitrates (kbps):', JSON.stringify(r.recommended));
    console.log('ALL SHARE ENCODER CHECKS PASSED');
    app.exit(0);
  } catch (error) { fail(error); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
