'use strict';

// What the sharer hears of their own computer's sound while Knot shares it on Linux.
//
// Sharing with sound moves the chosen programs' sound onto a private PipeWire sink and records that sink's monitor for the share. The sharer must
// still hear it, so the monitor is looped back to the real speakers. That loopback used to be parked at 0% and the sharer was given a copy that
// had gone through the capture path instead (parec, 20 ms packets, the page's audio worklet with its 60 ms buffer, a compressor, 0.62 gain): about
// 150 ms late and squashed. PipeWire's own loopback measures 31 ms (tests/linux-share-audio-loopback.js), so it carries the sound once it is safe.
//
// Why it was parked, and what keeps it safe now:
//   * the first buffers of a monitor are uninitialized floats, a full-scale square wave. The return is loaded onto a dummy sink first, so they
//     drain there, and is only moved to the speakers muted at 0%;
//   * PipeWire remembers a stream's volume, mute and target by its name, and restores them when a stream of that name appears. A return that
//     was once faded up would come back at full volume on the speakers. Each session's return therefore has a name nothing has seen before;
//   * the fade starts from 0% and runs only once the stream is verified to be on the speakers.
const { randomBytes } = require('crypto');

const RETURN_MEDIA_PREFIX = 'KnotShareReturn';
const FADE_STEPS = 8;
const FADE_STEP_MS = 60;

const returnMediaName = () => `${RETURN_MEDIA_PREFIX}-${randomBytes(4).toString('hex')}`;
const isReturnMedia = name => new RegExp(`^${RETURN_MEDIA_PREFIX}(-[0-9a-f]{8})?$`).test(String(name || ''));

// The index of the sink called `name` in `pactl list short sinks` output.
function sinkIndexByName(shortSinks, name) {
  for (const line of String(shortSinks || '').split('\n')) {
    const [index, sinkName] = line.trim().split(/\t+|\s{2,}/);
    if (sinkName === name && /^\d+$/.test(index)) return index;
  }
  return '';
}

// Splits `pactl list sink-inputs` into { id, sink, muted, volumes[], media } for the inputs whose media name satisfies `match`.
function parseSinkInputs(listing, match = () => true) {
  const out = [];
  for (const block of String(listing || '').split(/\n(?=Sink Input #)/)) {
    const id = block.match(/^Sink Input #(\d+)/)?.[1];
    if (!id) continue;
    const media = block.match(/media\.name\s*=\s*"([^"]*)"/)?.[1] || '';
    if (!match(media, block)) continue;
    const volumeLine = block.match(/^\s*Volume:\s.+$/m)?.[0] || '';
    out.push({ id, media, sink: block.match(/^\s*Sink:\s*(\d+)/m)?.[1] || '', muted: /^\s*Mute:\s*yes\b/mi.test(block), volumes: [...volumeLine.matchAll(/(\d+)%/g)].map(item => Number(item[1])) });
  }
  return out;
}

// Raises the return from silence to full over steps*stepMs. `run(args)` runs pactl and resolves true when it worked. Returns true only if every
// step was applied to every input and the caller still wants it (`stillWanted`), so a share that ends mid-fade stops quietly.
async function fadeUpReturn({ ids, run, sleep, steps = FADE_STEPS, stepMs = FADE_STEP_MS, stillWanted = () => true }) {
  for (const id of ids) {
    if (!await run(['set-sink-input-volume', id, '0%'])) return false;
    if (!await run(['set-sink-input-mute', id, '0'])) return false;
  }
  for (let step = 1; step <= steps; step++) {
    if (!stillWanted()) return false;
    for (const id of ids) if (!await run(['set-sink-input-volume', id, `${Math.round(100 * step / steps)}%`])) return false;
    if (step < steps) await sleep(stepMs);
  }
  return true;
}

// Makes sure the return streams `ids` are on the sink called `sinkName`, silent, moving them again if a move did not stick (a first move was seen not
// to, about one time in seven, on PipeWire 1.6). `run(args)` runs pactl and resolves true when it worked; `list(args)` resolves its output.
async function ensureReturnOnSink({ ids, sinkName, run, list, sleep, tries = 6, settleMs = 120 }) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const index = sinkIndexByName(await list(['list', 'short', 'sinks']), sinkName);
    if (!index) return false;                                    // the speakers are gone (unplugged, switched): there is nothing to return to
    const inputs = parseSinkInputs(await list(['list', 'sink-inputs']), isReturnMedia);
    const mine = ids.map(id => inputs.find(item => item.id === id));
    if (mine.every(item => item && item.sink === index)) return true;
    if (mine.some(item => !item)) return false;                  // a stream is gone (its module was unloaded)
    for (const item of mine) if (item.sink !== index) {
      await run(['set-sink-input-mute', item.id, '1']); await run(['set-sink-input-volume', item.id, '0%']);
      await run(['move-sink-input', item.id, sinkName]);
      await run(['set-sink-input-mute', item.id, '1']); await run(['set-sink-input-volume', item.id, '0%']);
    }
    await sleep(settleMs);
  }
  return false;
}

// Are the return streams still there? (Someone unloaded the module, the speakers went away.) Never touches their volume: the sharer may have
// turned it down on purpose.
async function returnStillThere({ ids, list }) {
  const inputs = parseSinkInputs(await list(['list', 'sink-inputs']), isReturnMedia);
  return ids.every(id => inputs.some(item => item.id === id));
}

module.exports = { ensureReturnOnSink, returnStillThere, RETURN_MEDIA_PREFIX, FADE_STEPS, FADE_STEP_MS, returnMediaName, isReturnMedia, sinkIndexByName, parseSinkInputs, fadeUpReturn };
