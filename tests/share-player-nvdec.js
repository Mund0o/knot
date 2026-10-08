'use strict';

// The share player with the GPU decoder behind it (share-gpu-decoder.js -> the real knot-nvdec helper on the real GPU), in a renderer:
// 4K60 plays on the GPU at the size it is shown, full screen goes to the CPU and back, and every way the helper can go wrong ends in the
// CPU decoder carrying on, with the picture never wrong. Offscreen on purpose (see share-player-4k.js). Skips without the helper or a GPU.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const { ShareDecodeRuntime, probeNvdec, findHelper } = require('../share-decode-nvdec');

const ROOT = path.join(__dirname, '..');
const fail = error => { console.error(error?.stack || error); app.exit(1); };

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-player-nvdec-'));
  let runtime = null;
  try {
    const info = await probeNvdec();
    if (!info.available) { console.log('SKIP GPU decoder player test: ' + info.reason); return app.exit(0); }
    const make = (name, size, rate, seconds, bitrate, gop) => {
      const file = path.join(dir, name + '.ivf');
      const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${rate}:d=${seconds}`, '-c:v', 'libsvtav1', '-preset', '12', '-g', String(gop), '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-f', 'ivf', file], { encoding: 'utf8' });
      return made.status === 0 ? file : null;
    };
    const big = make('big', '3840x2160', 60, 6, '30M', 120), small = make('small', '1920x1080', 60, 1, '6M', 60);
    if (!big || !small) { console.log('SKIP GPU decoder player test: ffmpeg with libsvtav1 is not available'); return app.exit(0); }

    // The real runtime in this (main) process, reached from the page the way the app's preload does it.
    const window = new BrowserWindow({ show: false, width: 1600, height: 900, webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
    window.webContents.setFrameRate(60);
    const owner = { id: 'test' };
    runtime = new ShareDecodeRuntime({ sameOwner: () => true, helper: info.helper,
      onFrame: ({ id, picture }) => window.webContents.send('dec:frame', id, { pts: picture.pts, width: picture.width, height: picture.height }, picture.data),
      onError: ({ id, error }) => window.webContents.send('dec:error', id, error.message), onEnd: ({ id }) => window.webContents.send('dec:end', id) });
    ipcMain.handle('dec:info', async () => { const r = await runtime.availability(); return { available: r.available, reason: r.reason, gpu: r.gpu }; });
    ipcMain.handle('dec:open', async (event, options) => { try { return { ok: true, ...(await runtime.open(owner, options)) }; } catch (error) { return { ok: false, error: error.message }; } });
    ipcMain.on('dec:push', (event, id, pts, bytes) => { runtime.push(owner, id, pts, bytes); });
    ipcMain.on('dec:close', (event, id) => { void runtime.close(owner, id); });
    ipcMain.handle('dec:kill', () => { for (const entry of runtime.sessions.values()) { try { process.kill(entry.session.child.pid, 'SIGKILL'); } catch {} } return runtime.sessions.size; });
    const cpu = () => Object.fromEntries(app.getAppMetrics().map(m => [m.pid + ':' + m.type, m.cpu.cumulativeCPUUsage]));
    ipcMain.handle('cpu:snapshot', () => cpu());

    fs.writeFileSync(path.join(dir, 'blank.html'), '<!doctype html><html><body style="margin:0"></body></html>');
    await window.loadFile(path.join(dir, 'blank.html'));
    const run = body => window.webContents.executeJavaScript(`(async () => {
      const fs = require('fs'), { ipcRenderer } = require('electron');
      const { ShareSender, ShareReceiver } = require(${JSON.stringify(ROOT)} + '/share-core');
      const { createSharePlayer } = require(${JSON.stringify(ROOT)} + '/share-player');
      const { createGpuDecode } = require(${JSON.stringify(ROOT)} + '/share-gpu-decoder');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const hook = (channel, make) => cb => { const l = (e, ...a) => make(cb, ...a); ipcRenderer.on(channel, l); return () => ipcRenderer.removeListener(channel, l); };
      const realBridge = { info: () => ipcRenderer.invoke('dec:info'), open: o => ipcRenderer.invoke('dec:open', o), push: (id, pts, bytes) => { ipcRenderer.send('dec:push', id, pts, bytes); return true; }, close: id => { ipcRenderer.send('dec:close', id); return true; },
        onFrame: hook('dec:frame', (cb, id, meta, bytes) => cb(id, meta, bytes)), onError: hook('dec:error', (cb, id, message) => cb(id, message)), onEnd: hook('dec:end', (cb, id) => cb(id)) };
      const readIvf = file => { const data = fs.readFileSync(file), frames = []; for (let at = data.readUInt16LE(6); at + 12 <= data.length;) { const size = data.readUInt32LE(at); frames.push(new Uint8Array(data.subarray(at + 12, at + 12 + size))); at += 12 + size; } return { frames, width: data.readUInt16LE(12), height: data.readUInt16LE(14) }; };
      // A stream played into a player: pictures fed at their rate, a chance to act between them (e.g. change the display size).
      async function play({ file, fps = 60, count = 0, bridge = realBridge, gpu = true, preferSoftware = true, display = { width: 1600, height: 900 }, every = null, interval = 0, after = 1500 }) {
        const { frames, width, height } = readIvf(file); const n = count || frames.length;
        const canvas = document.createElement('canvas'); document.body.append(canvas);
        const errors = []; window.__display = display;
        const gpuDecode = gpu ? createGpuDecode({ bridge }) : null; if (gpuDecode) await gpuDecode.check();
        const player = createSharePlayer({ preferSoftware, gpuDecode, surface: { canvas, context: canvas.getContext('2d', { alpha: false }), reveal() {} }, getDisplaySize: () => window.__display, onError: e => errors.push(String(e.message || e)) });
        const sender = new ShareSender({ emit: () => {} }), receiver = new ShareReceiver({ onRecord: record => player.push(record) });
        const config = { codec: 'av01.0.13H.08', width, height, fps }; sender.setConfig(config); player.configure(config);
        receiver.start(sender.addViewer('v').startSeq);
        sender.attachLane('v', 'l', { kind: 'dc', write: bytes => { receiver.pushBytes('l', bytes); return true; } });
        const timer = setInterval(() => { sender.onAck('v', receiver.ackSeq); sender.tick(); }, 100);
        const t0 = performance.now(), cpuBefore = await ipcRenderer.invoke('cpu:snapshot'), trace = [];
        for (let i = 0; i < n; i++) {
          const wait = t0 + i * (interval || 1000 / fps) - performance.now(); if (wait > 1) await sleep(wait);
          sender.pushFrame({ key: i % 120 === 0, pts: Math.round(i * (interval ? interval * 1000 : 1e6 / fps)), data: frames[i % frames.length] });
          if (every) { const s = await every(i, player); if (s) trace.push(s); }
        }
        await sleep(after);
        const cpuAfter = await ipcRenderer.invoke('cpu:snapshot'), s = player.stats(), wall = (performance.now() - t0) / 1000;
        const cores = Object.fromEntries(Object.keys(cpuAfter).map(k => [k, ((cpuAfter[k] - (cpuBefore[k] || 0)) / wall)]));
        const busy = Object.entries(cores).reduce((sum, [k, v]) => sum + v, 0);
        clearInterval(timer); player.destroy();
        return { ...s, frames: n, errors, cores: busy, trace, firstPaintMs: s.firstPaintAt ? Math.round(s.firstPaintAt - t0) : -1 };
      }
      ${body}
    })()`);

    // ---- A: 4K60 in a window plays on the GPU, handed over at the size it is shown
    {
      const r = await run(`return await play({ file: ${JSON.stringify(big)} });`);
      assert.deepStrictEqual(r.errors, [], 'player errors: ' + r.errors.join('; '));
      assert.strictEqual(r.decoder, 'nvdec', 'a window should decode on the GPU (' + r.decoder + ': ' + r.softwareReason + ')');
      assert.deepStrictEqual([r.gpuSize.width, r.gpuSize.height], [1600, 900], 'the GPU hands over the size shown');
      assert.strictEqual(r.verification, 'ok', 'the first picture is checked against a software decode');
      assert.strictEqual(r.width, 3840, 'the stream still reports its own size');
      const shown = r.painted / r.frames;
      assert(shown > 0.93, `only ${(shown * 100).toFixed(1)}% of the pictures were shown`);
      assert(r.latencyP95Ms < 400, 'pictures were shown ' + Math.round(r.latencyP95Ms) + ' ms after they arrived (95th percentile)');
      assert(r.stalls <= 1, r.stalls + ' stalls on a clean stream');
      console.log(`PASS 4K60 plays on the GPU at ${r.gpuSize.width}x${r.gpuSize.height}: ${(shown * 100).toFixed(1)}% shown, latency p95 ${Math.round(r.latencyP95Ms)} ms, first picture checked (${r.verification}), ${r.cores.toFixed(2)} CPU cores in total`);
      const soft = await run(`return await play({ file: ${JSON.stringify(big)}, gpu: false });`);
      console.log(`     for comparison the CPU decoder: ${(soft.painted / soft.frames * 100).toFixed(1)}% shown, latency p95 ${Math.round(soft.latencyP95Ms)} ms, ${soft.cores.toFixed(2)} CPU cores in total`);
    }

    // ---- B: full screen on a 4K display decodes on the CPU, a window again on the GPU, and nothing is dropped on the way
    {
      const r = await run(`
        let seen = [];
        const result = await play({ file: ${JSON.stringify(big)}, count: 540, after: 2500, every: async (i, player) => {
          if (i === 90) window.__display = null;                      // full screen
          if (i === 240) window.__display = { width: 1600, height: 900 };
          if (i % 30 === 0) seen.push({ i, decoder: player.stats().decoder, painted: player.stats().painted });
        } });
        result.seen = seen; return result;`);
      assert.deepStrictEqual(r.errors, []);
      const at = i => r.seen.find(s => s.i === i)?.decoder;
      assert.strictEqual(at(60), 'nvdec'); assert(['software', 'hardware-preferred'].includes(at(210)), 'full screen should be decoded on the CPU, was ' + at(210)); assert.strictEqual(at(480), 'nvdec', 'back in a window the GPU should decode again');
      assert(r.painted / r.frames > 0.85, `switching decoders dropped too much: ${(r.painted / r.frames * 100).toFixed(1)}% shown`);
      assert(r.backendSwitches >= 2 && r.backendSwitches <= 4, r.backendSwitches + ' switches');
      for (let k = 1; k < r.seen.length; k++) assert(r.seen[k].painted > r.seen[k - 1].painted, 'the picture stood still around picture ' + r.seen[k].i);
      console.log(`PASS full screen on a 4K display decodes on the CPU and a window on the GPU, switching ${r.backendSwitches} times with ${(r.painted / r.frames * 100).toFixed(1)}% of the pictures shown and the picture never standing still`);
    }

    // ---- C: a helper that cannot start, one that dies in the middle, one that shows the wrong picture: the CPU carries on
    {
      const never = `{ ...realBridge, open: async () => ({ ok: false, error: 'the GPU is busy' }) }`;
      const r = await run(`return await play({ file: ${JSON.stringify(small)}, bridge: ${never} });`);
      assert.deepStrictEqual(r.errors, []); assert.strictEqual(r.decoder, 'software'); assert.match(r.softwareReason, /GPU is busy/);
      assert(r.painted >= 55, 'the CPU decoder should show the stream: ' + r.painted);
      console.log(`PASS a GPU decoder that will not start leaves the CPU decoder showing the stream (${r.painted} of ${r.frames} pictures; "${r.softwareReason}")`);
    }
    {
      const r = await run(`return await play({ file: ${JSON.stringify(big)}, count: 300, after: 2000, every: async (i) => { if (i === 150) await ipcRenderer.invoke('dec:kill'); } });`);
      assert.deepStrictEqual(r.errors, []); assert.strictEqual(r.decoder, 'software', 'after the helper died the CPU should decode');
      assert(r.painted / r.frames > 0.8, `the stream should carry on after the helper dies: ${(r.painted / r.frames * 100).toFixed(1)}% shown`);
      console.log(`PASS a GPU decoder that dies mid-stream is replaced by the CPU decoder, which carries on from the last key picture (${(r.painted / r.frames * 100).toFixed(1)}% shown; "${r.softwareReason}")`);
    }
    {
      // A helper whose pictures are all black (what Chromium's own hardware decoder does on this GPU).
      const liar = `{ ...realBridge, onFrame: cb => realBridge.onFrame((id, meta, bytes) => { const black = new Uint8Array(bytes.length); black.fill(16, 0, meta.width * meta.height); black.fill(128, meta.width * meta.height); cb(id, meta, black); }) }`;
      const r = await run(`return await play({ file: ${JSON.stringify(small)}, bridge: ${liar} });`);
      assert.deepStrictEqual(r.errors, []); assert.strictEqual(r.decoder, 'software', 'a GPU decoder that shows black must be replaced'); assert.strictEqual(r.verification, 'not needed');
      assert.match(r.softwareReason, /different picture/);
      console.log(`PASS a GPU decoder that shows the wrong picture is caught on its first picture and replaced ("${r.softwareReason}")`);
    }

    // ---- D: a screen that changes five times a second shows every change at once, the last one included
    {
      const r = await run(`return await play({ file: ${JSON.stringify(small)}, count: 20, interval: 200, after: 1500, display: { width: 1280, height: 720 }, every: async (i, player) => { const q = player.stats(); return i + ': decoded ' + q.decoded + ' painted ' + q.painted + ' pending ' + q.pending + ' queued ' + q.queued + ' waiting ' + q.decodedWaiting + ' skippedAtStart ' + q.skippedAtStart + ' buffering ' + q.buffering + ' delay ' + q.delayMs + ' depth ' + q.depthMs; } });`); if (process.env.NVDEC_DEBUG) console.log(r.trace.join('\n') + '\nfinal: ' + JSON.stringify({ painted: r.painted, decoded: r.decoded, skippedAtStart: r.skippedAtStart, stalls: r.stalls, delayMs: r.delayMs, decoder: r.decoder }));
      assert.deepStrictEqual(r.errors, []); assert.strictEqual(r.decoder, 'nvdec');
      assert.strictEqual(r.painted, 20, `only ${r.painted} of 20 pictures were shown (first picture after ${r.firstPaintMs} ms; ${r.decoded} decoded, ${r.pending} pending, ${r.queued} queued)`);
      assert.strictEqual(r.pending, 0, r.pending + ' pictures were left inside the GPU decoder');
      assert(r.latencyP95Ms < 700, 'changes were shown ' + Math.round(r.latencyP95Ms) + ' ms late');
      console.log(`PASS on the GPU a screen that changes five times a second shows all ${r.painted} pictures, the last included, with latency p95 ${Math.round(r.latencyP95Ms)} ms (first picture after ${r.firstPaintMs} ms)`);
    }

    await runtime.closeAll();
    console.log('ALL GPU DECODER PLAYER CHECKS PASSED');
    app.exit(0);
  } catch (error) { fail(error); }
  finally { try { await runtime?.closeAll(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
