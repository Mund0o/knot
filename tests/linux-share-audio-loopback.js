'use strict';

// The sharer's low-delay return (linux-share-return.js) against a real PipeWire, on PRIVATE sinks only: a stand-in share sink, a dummy hold sink
// and stand-in speakers, fed a very quiet test tone (-54 dBFS with -40 dBFS clicks). Nothing here touches the real speakers, the default sink or
// any program's stream; the test checks that afterwards. What it proves about the return:
//   * silent while parked, never louder than its source at any moment (including the move from the hold sink and the fade), fade rising;
//   * about 30 ms behind its source (the capture path it replaces is about 150 ms);
//   * two sessions in a row each start from silence, because each return has a name nothing has remembered;
//   * it leaves nothing behind. Skips where there is no PipeWire/PulseAudio to talk to.
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const { returnMediaName, isReturnMedia, sinkIndexByName, parseSinkInputs, fadeUpReturn, ensureReturnOnSink, returnStillThere, RETURN_MEDIA_PREFIX } = require('../linux-share-return');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const RATE = 48000, TONE = 0.002, CLICK = 0.01;

// ---- pure parts first
async function pureChecks() {
  const name = returnMediaName();
  assert(isReturnMedia(name) && name.startsWith(RETURN_MEDIA_PREFIX + '-'), 'a return name looks like ' + name);
  assert(isReturnMedia('KnotShareReturn') && !isReturnMedia('KnotShareReturnX') && !isReturnMedia('Spotify') && !isReturnMedia('KnotShareReturn-zzzz'), 'only Knot return names match');
  assert.notStrictEqual(returnMediaName(), returnMediaName(), 'two sessions must not share a name');
  assert.strictEqual(sinkIndexByName('61\talsa_a\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED\n67\tkt_speakers\tPipeWire\tfloat32le\tIDLE', 'kt_speakers'), '67');
  assert.strictEqual(sinkIndexByName('61\talsa_a\tPipeWire', 'missing'), '');
  const listing = 'Sink Input #12\n\tDriver: PipeWire\n\tSink: 67\n\tMute: yes\n\tVolume: front-left: 0 /   0% / -inf dB,   front-right: 0 /   0% / -inf dB\n\tProperties:\n\t\tmedia.name = "KnotShareReturn-ab12cd34"\n\nSink Input #13\n\tSink: 5\n\tMute: no\n\tVolume: front-left: 65536 / 100%\n\tProperties:\n\t\tmedia.name = "YouTube"\n';
  const parsed = parseSinkInputs(listing, isReturnMedia);
  assert.deepStrictEqual(parsed, [{ id: '12', media: 'KnotShareReturn-ab12cd34', sink: '67', muted: true, volumes: [0, 0] }]);
  assert.strictEqual(parseSinkInputs(listing).length, 2);
  // the fade: starts from 0% and unmuted last, rises in even steps, stops when it is no longer wanted, stops when a command fails
  const calls = []; const run = async args => { calls.push(args.join(' ')); return true; };
  assert.strictEqual(await fadeUpReturn({ ids: ['9'], run, sleep: async () => {}, steps: 4 }), true);
  assert.deepStrictEqual(calls, ['set-sink-input-volume 9 0%', 'set-sink-input-mute 9 0', 'set-sink-input-volume 9 25%', 'set-sink-input-volume 9 50%', 'set-sink-input-volume 9 75%', 'set-sink-input-volume 9 100%']);
  let wanted = 3; const stopped = await fadeUpReturn({ ids: ['9'], run: async () => true, sleep: async () => {}, steps: 10, stillWanted: () => --wanted > 0 });
  assert.strictEqual(stopped, false, 'a fade that is no longer wanted must stop');
  assert.strictEqual(await fadeUpReturn({ ids: ['9'], run: async args => !args.includes('50%'), sleep: async () => {}, steps: 4 }), false, 'a failed command must stop the fade');
  // a move that did not stick is repeated; a stream that vanished, or speakers that vanished, are reported instead of faded up
  {
    const shortSinks = '7\tspeakers\tPipeWire\tfloat32le\tRUNNING\n8\thold\tPipeWire\tfloat32le\tIDLE';
    const inputsOn = sink => `Sink Input #5\n\tSink: ${sink}\n\tMute: yes\n\tVolume: front-left: 0 /   0% / -inf dB\n\tProperties:\n\t\tmedia.name = "${RETURN_MEDIA_PREFIX}-00000001"\n`;
    let moves = 0, onSink = '8'; const commands = [];
    const list = async args => args[1] === 'short' ? shortSinks : inputsOn(onSink);
    const run = async args => { commands.push(args.join(' ')); if (args[0] === 'move-sink-input') { moves++; if (moves >= 3) onSink = '7'; } return true; };
    assert.strictEqual(await ensureReturnOnSink({ ids: ['5'], sinkName: 'speakers', run, list, sleep: async () => {} }), true);
    assert.strictEqual(moves, 3, 'a move that does not stick must be repeated until it does');
    assert(commands.every((c, i) => !c.startsWith('set-sink-input-mute 5 0')), 'a stream was unmuted while it was being moved');
    assert.strictEqual(await ensureReturnOnSink({ ids: ['5'], sinkName: 'speakers', run: async () => true, list: async args => args[1] === 'short' ? shortSinks : inputsOn('8'), sleep: async () => {}, tries: 3 }), false, 'a stream that never arrives must not be faded up');
    assert.strictEqual(await ensureReturnOnSink({ ids: ['5'], sinkName: 'gone', run, list, sleep: async () => {} }), false, 'speakers that are gone must be reported');
    assert.strictEqual(await ensureReturnOnSink({ ids: ['99'], sinkName: 'speakers', run, list, sleep: async () => {} }), false, 'a stream that is gone must be reported');
    assert.strictEqual(await returnStillThere({ ids: ['5'], list }), true); assert.strictEqual(await returnStillThere({ ids: ['6'], list }), false);
  }
  console.log('PASS the return has a name nothing has remembered, the fade starts from silence and stops when it should, the pactl output is read correctly');
}
const pactl = (...args) => { try { return execFileSync('pactl', args, { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return ''; } };
const have = command => { try { execFileSync('which', [command], { stdio: 'ignore' }); return true; } catch { return false; } };

async function session(label, names, pids) {
  const modules = [], procs = [];
  const recorder = device => { const p = spawn('parec', ['-d', device, '--format=float32le', '--rate=48000', '--channels=2', '--latency-msec=5'], { stdio: ['ignore', 'pipe', 'ignore'] }); procs.push(p); const rec = { chunks: [], startedAt: 0 }; p.stdout.on('data', c => { if (!rec.startedAt) rec.startedAt = Date.now(); rec.chunks.push(c); }); return rec; };
  const floats = rec => { const b = Buffer.concat(rec.chunks); return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)); };
  try {
    for (const name of [names.share, names.hold, names.speakers]) modules.push(pactl('load-module', 'module-null-sink', `sink_name=${name}`, `sink_properties=device.description=Knot_Test_${name}`));
    await sleep(500);
    const shareRec = recorder(`${names.share}.monitor`), speakersRec = recorder(`${names.speakers}.monitor`);
    const SECS = 11, total = SECS * RATE, pcm = new Float32Array(total * 2);
    for (let i = 0; i < total; i++) { const t = i / RATE; let v = TONE * Math.sin(2 * Math.PI * 440 * t); if ((t * 1000) % 500 < 5) v += CLICK * Math.sin(2 * Math.PI * 1000 * t); pcm[i * 2] = pcm[i * 2 + 1] = v; }
    const player = spawn('paplay', ['--raw', `--device=${names.share}`, '--format=float32le', '--rate=48000', '--channels=2', '--latency-msec=20'], { stdio: ['pipe', 'ignore', 'ignore'] }); procs.push(player);
    player.stdin.on('error', () => {}); player.stdin.write(Buffer.from(pcm.buffer));
    const t0 = Date.now(); await sleep(2000);
    const media = returnMediaName();
    modules.push(pactl('load-module', 'module-loopback', `source=${names.share}.monitor`, `sink=${names.hold}`, 'latency_msec=40', 'source_dont_move=true', `sink_input_properties=media.name=${media}`));
    let input = null; for (let i = 0; i < 60 && !input; i++) { input = parseSinkInputs(pactl('list', 'sink-inputs'), isReturnMedia).find(item => item.media === media); if (!input) await sleep(40); }
    assert(input, 'the return stream did not appear');
    const run = async args => { pactl(...args); return true; };
    // exactly the order main.js uses: silence it, move it to the speakers, silence it again, wait, then fade up
    await run(['set-sink-input-mute', input.id, '1']); await run(['set-sink-input-volume', input.id, '0%']);
    await run(['move-sink-input', input.id, names.speakers]); await run(['set-sink-input-mute', input.id, '1']); await run(['set-sink-input-volume', input.id, '0%']);
    assert.strictEqual(await ensureReturnOnSink({ ids: [input.id], sinkName: names.speakers, run, list: async args => pactl(...args), sleep }), true, 'the return could not be put on the speakers sink');
    await sleep(1500);
    const speakersIndex = sinkIndexByName(pactl('list', 'short', 'sinks'), names.speakers);
    const parked = parseSinkInputs(pactl('list', 'sink-inputs'), isReturnMedia).find(item => item.media === media);
    assert.strictEqual(parked?.sink, speakersIndex, 'the return was not on the speakers sink after the move');
    assert(parked.muted || parked.volumes.every(v => v === 0), 'the return was not silent while parked');
    const rampStart = Date.now() - t0;
    assert.strictEqual(await fadeUpReturn({ ids: [input.id], run, sleep }), true);
    const rampEnd = Date.now() - t0; await sleep(2500);
    for (const p of procs) { try { p.kill('SIGTERM'); } catch {} } await sleep(300);

    const spk = floats(speakersRec), shr = floats(shareRec), win = RATE / 100;
    const peak = (arr, a, b) => { let m = 0; for (let i = Math.max(0, a * 2); i < Math.min(arr.length, b * 2); i++) m = Math.max(m, Math.abs(arr[i])); return m; };
    const timeline = []; for (let w = 0; w * win < spk.length / 2; w++) timeline.push({ at: speakersRec.startedAt - t0 + w * 10, peak: peak(spk, w * win, (w + 1) * win) });
    const parkedPeak = Math.max(0, ...timeline.filter(x => x.at > 2500 && x.at < rampStart - 20).map(x => x.peak));
    const overall = Math.max(0, ...timeline.map(x => x.peak));
    assert(parkedPeak < 1e-4, `${label}: the return was audible while parked (peak ${parkedPeak})`);
    assert(overall <= (TONE + CLICK) * 1.05, `${label}: the speakers got ${overall.toFixed(4)}, louder than the source (${(TONE + CLICK).toFixed(4)})`);
    // the fade rises: the tone's level in 100 ms steps across the ramp never falls by more than a hair
    // The tone's level in a stretch of the recording: the median of |sample|, which the test clicks (a few ms every 500 ms) cannot skew.
    const level = (from, to) => { const values = []; for (let i = Math.max(0, Math.round((from - (speakersRec.startedAt - t0)) / 1000 * RATE)); i < Math.min(spk.length / 2, Math.round((to - (speakersRec.startedAt - t0)) / 1000 * RATE)); i++) values.push(Math.abs(spk[i * 2])); values.sort((a, b) => a - b); return values.length ? values[values.length >> 1] : 0; };
    const steps = []; for (let at = rampStart; at < rampEnd + 200; at += 100) steps.push(level(at, at + 100));
    assert(steps.every((v, i) => i === 0 || v >= steps[i - 1] * 0.8), `${label}: the fade is not rising: ${steps.map(v => v.toFixed(5)).join(' ')}`);
    assert(steps.at(-1) > TONE * 0.5, `${label}: the return never reached full volume (${steps.at(-1)})`);
    // latency of the clicks: each click at the speakers against the nearest earlier click at the share sink
    const onsets = (arr, started) => { const out = []; let last = -1e9; for (let i = 0; i < arr.length / 2; i++) if (Math.abs(arr[i * 2]) > CLICK * 0.6 && i - last > RATE * 0.2) { out.push(started - t0 + i / RATE * 1000); last = i; } return out; };
    const so = onsets(shr, shareRec.startedAt), po = onsets(spk, speakersRec.startedAt);
    const latencies = po.filter(t => t > rampEnd + 200).map(t => t - so.filter(x => x <= t + 5).pop());
    assert(latencies.length >= 3, label + ': too few clicks to measure the delay');
    const median = latencies.sort((a, b) => a - b)[latencies.length >> 1];
    assert(median < 80, `${label}: the return is ${median} ms behind its source`);
    return { median, overall, parkedPeak };
  } finally {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
    for (const m of modules.reverse()) if (m) pactl('unload-module', m);
    await sleep(200);
  }
}

(async () => {
  await pureChecks();
  if (!['pactl', 'parec', 'paplay'].every(have) || !pactl('info')) { console.log('SKIP the low-delay return test: no PipeWire/PulseAudio to talk to'); return; }
  const before = { defaultSink: pactl('get-default-sink'), inputs: pactl('list', 'short', 'sink-inputs').split('\n').filter(Boolean), sinks: pactl('list', 'short', 'sinks').split('\n').filter(l => !l.includes('kt_')).map(l => l.split('\t').slice(0, 2).join(':')).sort().join('|') };
  const first = await session('first session', { share: `kt_share_${process.pid}`, hold: `kt_hold_${process.pid}`, speakers: `kt_speakers_${process.pid}` });
  const second = await session('second session', { share: `kt_share_${process.pid}b`, hold: `kt_hold_${process.pid}b`, speakers: `kt_speakers_${process.pid}b` });
  assert(!pactl('list', 'short', 'sinks').includes('kt_'), 'a test sink was left behind');
  assert(!pactl('list', 'sink-inputs').includes(RETURN_MEDIA_PREFIX), 'a return stream was left behind');
  assert.strictEqual(pactl('get-default-sink'), before.defaultSink, 'the default sink changed');
  // A program's own sounds start and stop by themselves; what must never happen is a stream that is still there being moved to another sink.
  const after = new Map(pactl('list', 'short', 'sink-inputs').split('\n').filter(Boolean).map(line => line.split('\t')));
  const moved = before.inputs.map(line => line.split('\t')).filter(([id, sink]) => after.has(id) && after.get(id) !== sink);
  assert.deepStrictEqual(moved, [], 'a running program\'s stream was moved to another sink: ' + JSON.stringify(moved));
  console.log(`PASS the return is silent while parked, never louder than its source (peaks ${first.overall.toFixed(4)} / ${second.overall.toFixed(4)}), rises smoothly, is ${first.median} / ${second.median} ms behind its source, starts from silence in two sessions in a row, and leaves your speakers, default device and running programs untouched`);
})().catch(error => { console.error(error?.stack || error); process.exit(1); });
