'use strict';

// main.js's real Linux share-audio route (the code between `let linuxShareAudio` and `isPairRenderer`) run against a real PipeWire, with every
// real thing kept out of reach: the "speakers" are a private null sink named by KNOT_TEST_RETURN_SINK, no program's stream is moved
// (KNOT_TEST_NO_STREAM_MOVES), and the only sound is a very quiet test tone. Checks that, once the route is up:
//   * the stand-in speakers are silent until the return fades up, never get louder than the source, and then play it about 40 ms behind;
//   * the packets for the page say 'return' (page stays silent, never doubled), or 'page' when the setting is off or the return disappears;
//   * stopping leaves no sink or stream behind, the default sink alone and any running program's stream where it was.
// Skips where there is no PipeWire to talk to.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn, execFile, execFileSync } = require('child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// This process's share sinks (a failed run must never leave any behind): module ids of null sinks named pair_share_<pid> / pair_share_hold_<pid>.
const leftovers = () => pactl('list', 'short', 'modules').split('\n').map(line => line.split('\t')).filter(([id, name, args = '']) => name === 'module-null-sink' && (args.includes(`sink_name=pair_share_${process.pid}`) || args.includes(`sink_name=pair_share_hold_${process.pid}`))).map(([id]) => id);
const pactl = (...args) => { try { return execFileSync('pactl', args, { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return ''; } };
const have = command => { try { execFileSync('which', [command], { stdio: 'ignore' }); return true; } catch { return false; } };
const RATE = 48000, TONE = 0.002, CLICK = 0.01;
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const from = mainSource.indexOf('let linuxShareAudio = null;'), to = mainSource.indexOf('function isPairRenderer');
assert(from > 0 && to > from, 'could not find the Linux share-audio route in main.js');

function loadRoute({ localReturn, speakers, breakAfterSink = false }) {
  const events = { packets: [], debug: [] };
  const webContents = {
    isDestroyed: () => false,
    send(channel, samples, metadata) {
      if (channel === 'pair:linuxShareAudioDebug') { events.debug.push(String(samples)); return; }
      if (channel !== 'pair:linuxShareAudio') return;
      events.packets.push({ at: Date.now(), monitor: metadata.monitor, sequence: metadata.sequence });
      setImmediate(() => { const state = hook.state(); if (state && state.pcmInflight.delete(metadata.sequence)) { state.pcmOldestInflightAt = 0; hook.flush(state); } });
    },
  };
  const sandbox = {
    process: { ...process, pid: process.pid, env: { ...process.env, KNOT_TEST_RETURN_SINK: speakers, KNOT_TEST_NO_STREAM_MOVES: '1' } }, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, Promise,
    spawn, execFile, fs, path, TEST_RIG: true, require: id => require(id.startsWith('./') ? path.join(__dirname, '..', id) : id),
    settingsStore: { get: async key => (key === 'shareLocalReturn' ? (localReturn ? 'on' : 'off') : null) },
    ...require('../linux-share-return'),      // main.js imports these at its top, outside the slice
    ...(breakAfterSink ? { returnMediaName: () => { throw new Error('forced failure after the share sink was created'); } } : {}),
    mainWin: null, Float32Array, Date, Math, Number, Set, Map, JSON, Array, Object, String, Error, Uint8Array, Symbol,
  };
  const context = vm.createContext(sandbox);
  const hook = {};
  vm.runInContext(mainSource.slice(from, to) + '\n;globalThis.__route = { inner: wc => startLinuxShareAudioInner(wc, linuxShareAudioGeneration), start: wc => startLinuxShareAudio(wc), stop: () => stopLinuxShareAudio(), state: () => linuxShareAudio, flush: s => flushLinuxShareAudio(s) };', context, { filename: 'main-linux-share-audio.js' });
  Object.assign(hook, { state: context.__route.state, flush: context.__route.flush });
  return { route: context.__route, webContents, events };
}

async function session(label, { localReturn, killReturnAfterLive = false }) {
  const speakers = `kt_route_speakers_${process.pid}_${label.replace(/\W/g, '')}`, shareSink = `pair_share_${process.pid}`;
  const modules = [], procs = [];
  const recorder = device => { const p = spawn('parec', ['-d', device, '--format=float32le', '--rate=48000', '--channels=2', '--latency-msec=5'], { stdio: ['ignore', 'pipe', 'ignore'] }); procs.push(p); const rec = { chunks: [], startedAt: 0 }; p.stdout.on('data', c => { if (!rec.startedAt) rec.startedAt = Date.now(); rec.chunks.push(c); }); return rec; };
  const floats = rec => { const b = Buffer.concat(rec.chunks); return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)); };
  const { route, webContents, events } = loadRoute({ localReturn, speakers });
  try {
    modules.push(pactl('load-module', 'module-null-sink', `sink_name=${speakers}`, 'sink_properties=device.description=Knot_Route_Test_Speakers'));
    await sleep(400);
    const speakersRec = recorder(`${speakers}.monitor`);
    const t0 = Date.now();
    if (process.env.ROUTE_DEBUG) { try { console.log('inner ->', JSON.stringify(await route.inner(webContents))); } catch (error) { console.log('inner threw:', error.stack.split('\n').slice(0, 4).join(' | ')); } await route.stop(); }
    const started = await route.start(webContents);
    assert(started, label + ': the route did not start');
    await sleep(300);
    const shareRec = recorder(`${shareSink}.monitor`);
    const SECS = 16, total = SECS * RATE, pcm = new Float32Array(total * 2);
    for (let i = 0; i < total; i++) { const t = i / RATE; let v = TONE * Math.sin(2 * Math.PI * 440 * t); if ((t * 1000) % 500 < 5) v += CLICK * Math.sin(2 * Math.PI * 1000 * t); pcm[i * 2] = pcm[i * 2 + 1] = v; }
    const player = spawn('paplay', ['--raw', `--device=${shareSink}`, '--format=float32le', '--rate=48000', '--channels=2', '--latency-msec=20'], { stdio: ['pipe', 'ignore', 'ignore'] }); procs.push(player);
    player.stdin.on('error', () => {}); player.stdin.write(Buffer.from(pcm.buffer));

    let liveAt = 0;
    for (let waited = 0; waited < 20000; waited += 100) { const state = route.state(); if (state?.returnLive && !liveAt) liveAt = Date.now() - t0; if (liveAt || (!localReturn && waited > 6000)) break; await sleep(100); }
    if (localReturn) assert(liveAt, label + ': the low-delay return never came up. Log: ' + events.debug.slice(-6).join(' | '));
    await sleep(2500);
    let flippedAt = 0;
    if (killReturnAfterLive) {
      const killedAt = Date.now() - t0; pactl('unload-module', route.state().loop);
      for (let waited = 0; waited < 9000; waited += 100) { if (events.packets.at(-1)?.monitor === 'page') { flippedAt = Date.now() - t0; break; } await sleep(100); }
      assert(flippedAt, label + ': after the return disappeared the packets still said ' + events.packets.at(-1)?.monitor);
      assert(flippedAt - killedAt < 8000, label + ': it took ' + (flippedAt - killedAt) + ' ms to notice the return was gone');
    }
    const loopId = route.state()?.loop;
    await sleep(800);
    await route.stop();
    for (const p of procs) { try { p.kill('SIGTERM'); } catch {} } await sleep(300);

    const spk = floats(speakersRec), shr = floats(shareRec), win = RATE / 100;
    const peak = (arr, a, b) => { let m = 0; for (let i = Math.max(0, a * 2); i < Math.min(arr.length, b * 2); i++) m = Math.max(m, Math.abs(arr[i])); return m; };
    const timeline = []; for (let w = 0; w * win < spk.length / 2; w++) timeline.push({ at: speakersRec.startedAt - t0 + w * 10, peak: peak(spk, w * win, (w + 1) * win) });
    const overall = Math.max(0, ...timeline.map(x => x.peak));
    assert(overall <= (TONE + CLICK) * 1.05, `${label}: the speakers got ${overall.toFixed(4)}, louder than the source ${(TONE + CLICK).toFixed(4)}`);
    const monitors = [...new Set(events.packets.map(p => p.monitor))];
    let median = null;
    if (localReturn) {
      assert(events.packets.length > 20, label + ': the page got too few packets');
      assert.strictEqual(events.packets[0].monitor, 'return', label + ': the very first packet must already say the page stays silent');
      const quietBefore = Math.max(0, ...timeline.filter(x => x.at > 0 && x.at < liveAt - 700).map(x => x.peak));
      assert(quietBefore < 1e-4, `${label}: the speakers were audible before the fade (peak ${quietBefore})`);
      const onsets = (arr, started) => { const out = []; let last = -1e9; for (let i = 0; i < arr.length / 2; i++) if (Math.abs(arr[i * 2]) > CLICK * 0.6 && i - last > RATE * 0.2) { out.push(started - t0 + i / RATE * 1000); last = i; } return out; };
      const so = onsets(shr, shareRec.startedAt), po = onsets(spk, speakersRec.startedAt);
      const lat = po.filter(t => t > liveAt + 300).map(t => t - so.filter(x => x <= t + 5).pop()).filter(Number.isFinite).sort((a, b) => a - b);
      assert(lat.length >= 3, label + ': too few clicks reached the speakers to measure the delay');
      median = lat[lat.length >> 1];
      assert(median < 80, `${label}: the return is ${median} ms behind the share sink`);
      if (!killReturnAfterLive) assert.deepStrictEqual(monitors, ['return'], `${label}: the packets said ${monitors}`);
    } else {
      assert.deepStrictEqual(monitors, ['page'], `${label}: with the return off the packets said ${monitors}`);
      assert(overall < 1e-4, `${label}: with the return off the stand-in speakers still heard something (${overall})`);
    }
    assert(!pactl('list', 'short', 'sinks').includes(shareSink) && !pactl('list', 'short', 'sinks').includes('pair_share_hold_' + process.pid), label + ': the route left a sink behind');
    assert(!pactl('list', 'sink-inputs').includes('KnotShareReturn'), label + ': the route left a return stream behind');
    return { liveAt, median, overall, flippedAt, monitors, loopId };
  } finally {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
    try { await route.stop(); } catch {}
    for (const m of modules.reverse()) if (m) pactl('unload-module', m);
    leftovers().forEach(id => pactl('unload-module', id));
    await sleep(200);
  }
}

(async () => {
  if (process.platform !== 'linux' || !['pactl', 'parec', 'paplay'].every(have) || !/PipeWire/i.test(pactl('info'))) { console.log('SKIP the Linux share-audio route test: no PipeWire to talk to'); return; }
  const before = { defaultSink: pactl('get-default-sink'), inputs: pactl('list', 'short', 'sink-inputs').split('\n').filter(Boolean).map(l => l.split('\t').slice(0, 2).join('\t')) };
  const live = await session('low-delay-return', { localReturn: true });
  console.log(`PASS the real route brings the low-delay return up from silence in ${live.liveAt} ms, the page is told 'return' from its first packet, and the stand-in speakers hear the sound ${Math.round(live.median)} ms behind its source, never louder than it`);
  const off = await session('setting-off', { localReturn: false });
  console.log(`PASS with the setting off the page keeps its own copy (packets say '${off.monitors}') and the speakers hear nothing from the route`);
  const gone = await session('return-disappears', { localReturn: true, killReturnAfterLive: true });
  console.log(`PASS when the return disappears the route notices (${gone.flippedAt - gone.liveAt} ms after it was live, within seconds of its removal) and tells the page to play the sound again`);
  {
    // New lanes forming over and over, as when a share restarts or its start is retried: the lane forming is where the old burst was heard, so
    // nothing may ever reach the stand-in speakers louder than the source, however the lanes are started, stopped mid-formation or overlapped.
    const speakers = `kt_route_speakers_${process.pid}_churn`, shareSink = `pair_share_${process.pid}`;
    const module = pactl('load-module', 'module-null-sink', `sink_name=${speakers}`); await sleep(400);
    const rec = { chunks: [], startedAt: 0 };
    const recorder = spawn('parec', ['-d', `${speakers}.monitor`, '--format=float32le', '--rate=48000', '--channels=2', '--latency-msec=5'], { stdio: ['ignore', 'pipe', 'ignore'] });
    recorder.stdout.on('data', c => { if (!rec.startedAt) rec.startedAt = Date.now(); rec.chunks.push(c); });
    const tone = () => { const n = 4 * RATE, pcm = new Float32Array(n * 2); for (let i = 0; i < n; i++) { const t = i / RATE; let v = TONE * Math.sin(2 * Math.PI * 440 * t); if ((t * 1000) % 500 < 5) v += CLICK * Math.sin(2 * Math.PI * 1000 * t); pcm[i * 2] = pcm[i * 2 + 1] = v; } return Buffer.from(pcm.buffer); };
    const players = []; let lanes = 0, lived = 0;
    const playInto = async () => { for (let i = 0; i < 40 && !pactl('list', 'short', 'sinks').includes(shareSink); i++) await sleep(25); const p = spawn('paplay', ['--raw', `--device=${shareSink}`, '--format=float32le', '--rate=48000', '--channels=2', '--latency-msec=20'], { stdio: ['pipe', 'ignore', 'ignore'] }); players.push(p); p.stdin.on('error', () => {}); p.stdin.write(tone()); };
    try {
      const plans = ['live', 'live', 'live', 'stop-at-once', 'stop-at-once', 'stop-while-forming', 'overlap', 'overlap', 'live'];
      const silencePlayers = async () => { for (const p of players.splice(0)) { try { p.kill('SIGKILL'); } catch {} } await sleep(150); };      // one tone source at a time, or two would simply add up
      for (const plan of plans) {
        await silencePlayers();
        const { route, webContents } = loadRoute({ localReturn: true, speakers });
        lanes++;
        const starting = route.start(webContents);
        if (plan === 'stop-while-forming') { await sleep(350); await route.stop(); await starting.catch(() => {}); continue; }
        const result = await starting; if (!result) continue;
        await playInto();
        if (plan === 'stop-at-once') { await route.stop(); continue; }
        if (plan === 'overlap') {
          // a restart on top of a route that is still tearing down, as a retry does
          const stopping = route.stop(); await silencePlayers(); const again = loadRoute({ localReturn: true, speakers }); lanes++;
          const second = again.route.start(again.webContents); await stopping; await second; await playInto();
          for (let waited = 0; waited < 9000 && !again.route.state()?.returnLive; waited += 100) await sleep(100);
          if (again.route.state()?.returnLive) lived++;
          await sleep(500); await again.route.stop(); continue;
        }
        for (let waited = 0; waited < 9000 && !route.state()?.returnLive; waited += 100) await sleep(100);
        if (route.state()?.returnLive) lived++;
        await sleep(700); await route.stop();
      }
    } finally {
      for (const p of players) { try { p.kill('SIGKILL'); } catch {} } await sleep(200); try { recorder.kill('SIGTERM'); } catch {} await sleep(300);
      leftovers().forEach(id => pactl('unload-module', id)); pactl('unload-module', module);
    }
    const b = Buffer.concat(rec.chunks), spk = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
    let overall = 0, spikes = 0; for (let i = 0; i < spk.length; i++) { const v = Math.abs(spk[i]); if (v > overall) overall = v; if (v > (TONE + CLICK) * 1.05) spikes++; }
    assert(lived >= 4, 'too few of the lanes ever came up to be a test: ' + lived);
    assert(spikes === 0 && overall <= (TONE + CLICK) * 1.05, `across ${lanes} lanes formed and torn down the stand-in speakers got ${overall.toFixed(4)} (${spikes} samples above the source ${(TONE + CLICK).toFixed(4)})`);
    assert(!pactl('list', 'short', 'sinks').includes(shareSink) && leftovers().length === 0 && !pactl('list', 'sink-inputs').includes('KnotShareReturn'), 'forming and tearing down lanes left something behind');
    console.log(`PASS ${lanes} lanes formed, ${lived} of them reaching the live return, others stopped at once, mid-formation or restarted on top of each other: nothing ever reached the speakers louder than its source (peak ${overall.toFixed(4)}), and nothing was left behind`);
  }
  {
    // A setup that throws once its private sink exists must not leave that sink behind.
    const speakers = `kt_route_speakers_${process.pid}_broken`; const module = pactl('load-module', 'module-null-sink', `sink_name=${speakers}`);
    try {
      const { route, webContents } = loadRoute({ localReturn: true, speakers, breakAfterSink: true });
      const started = await route.start(webContents);
      await sleep(600);
      assert(!started, 'a forced failure still reported a route');
      assert.deepStrictEqual(leftovers(), [], 'a failed setup left its sink behind: ' + leftovers().join(','));
    } finally { pactl('unload-module', module); leftovers().forEach(id => pactl('unload-module', id)); }
    console.log('PASS a setup that fails after creating its private sink removes it again');
  }
  assert(!pactl('list', 'short', 'sinks').includes('kt_route'), 'a test sink was left behind');
  assert.strictEqual(pactl('get-default-sink'), before.defaultSink, 'the default sink changed');
  const after = pactl('list', 'short', 'sink-inputs').split('\n').filter(Boolean).map(l => l.split('\t').slice(0, 2).join('\t'));
  // A program's own sounds start and stop by themselves; what must never happen is a stream that is still there being moved to another sink.
  const afterSink = new Map(after.map(line => line.split('\t'))), moved = before.inputs.map(line => line.split('\t')).filter(([id, sink]) => afterSink.has(id) && afterSink.get(id) !== sink);
  assert.deepStrictEqual(moved, [], 'a running program\'s stream was moved to another sink: ' + JSON.stringify(moved));
  console.log('PASS afterwards the default sink, every running program\'s stream and your speakers are exactly as they were');
})().catch(error => { console.error(error?.stack || error); process.exit(1); });
