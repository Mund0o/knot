'use strict';

// Screen capture and hardware AV1 encoding on Linux, done by GPU Screen Recorder (NVENC on NVIDIA, VA-API on AMD) and read
// back as plain encoded pictures. The recorder writes a WebM stream to its stdout; this takes it apart into
// { key, pts, data } records, so nothing downstream ever sees a container.
//
// The recorder is a separate program that keeps capturing the screen until it is told to stop, so how it ends matters as
// much as how it starts. Measured on a Flatpak install: signalling the process group (what a plain spawn offers) leaves
// the sandboxed recorder running after stop(), and killing the app outright leaves it running forever. Here:
//   * Flatpak runs with --die-with-parent, so its sandbox ends with the process that launched it;
//   * the launching shell carries a watchdog that takes the whole group down when Knot disappears, however it went;
//   * stop() sends TERM to the group, then KILL if anything is left, and only reports done once the process has gone.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { gpuScreenRecorderCommand, nativeScreenInfoAsync, WebmClusterSegmenter } = require('./native-screen');
const { av1Description, av1Codec, webmAv1Frames } = require('./native-video');

const KEYFRAME_SECONDS = 2;
const STOP_TERM_WAIT_MS = 1500;
const STOP_KILL_WAIT_MS = 2500;
const RESOLUTIONS = { widths: [1280, 1920, 2560, 3840], heights: [720, 1080, 1440, 2160] };

// A real kernel pipe sits between the recorder and Knot: the recorder reopens /dev/stdout, which a socketpair cannot do.
// The watchdog must not share the recorder's output pipe (it would keep the pipe open and hide the recorder's exit), and it ends
// by itself when this shell does, so a capture that finished leaves nothing sleeping behind it.
const LAUNCH_SCRIPT = 'p=$PPID; ( while kill -0 "$p" 2>/dev/null && kill -0 $$ 2>/dev/null; do sleep 0.3; done; kill -TERM -- -$$ 2>/dev/null ) >/dev/null 2>&1 & "$@" | /bin/cat';

function spawnRecorder(runner, args) {
  const prefix = runner.source === 'flatpak' ? [runner.prefix[0], '--die-with-parent', ...runner.prefix.slice(1)] : runner.prefix;
  return spawn('/bin/bash', ['-o', 'pipefail', '-c', LAUNCH_SCRIPT, 'knot-native-screen', runner.command, ...prefix, ...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
}

function signalGroup(child, signal) {
  try { process.kill(-child.pid, signal); return; } catch {}
  try { child.kill(signal); } catch {}
}

// The picture size the recorder announces in the WebM header: Segment > Tracks > TrackEntry > Video > PixelWidth / PixelHeight.
const EBML = { SEGMENT: 0x18538067, TRACKS: 0x1654ae6b, TRACK_ENTRY: 0xae, VIDEO: 0xe0, PIXEL_WIDTH: 0xb0, PIXEL_HEIGHT: 0xba };
// An EBML id or size. A size with every value bit set means "unknown" (a live stream's Segment); its number is not meaningful,
// and an eight byte one does not fit a safe integer, so it is flagged instead of computed.
function ebmlNumber(bytes, at, keepMarker = false) {
  if (at >= bytes.length) return null;
  const first = bytes[at]; let length = 1, mask = 0x80;
  while (length <= 8 && !(first & mask)) { mask >>= 1; length++; }
  if (length > 8 || at + length > bytes.length) return null;
  let value = keepMarker ? first : first & (mask - 1), allOnes = (first & (mask - 1)) === mask - 1;
  for (let index = 1; index < length; index++) { value = value * 256 + bytes[at + index]; allOnes = allOnes && bytes[at + index] === 0xff; }
  return { length, value, unknown: !keepMarker && allOnes };
}
function webmVideoSize(init) {
  const bytes = init instanceof Uint8Array ? init : new Uint8Array(init);
  const containers = new Set([EBML.SEGMENT, EBML.TRACKS, EBML.TRACK_ENTRY, EBML.VIDEO]);
  const number = (from, to) => { let value = 0; for (let at = from; at < to; at++) value = value * 256 + bytes[at]; return value; };
  const walk = (from, to, inVideo) => {
    const size = { width: 0, height: 0 };
    for (let at = from; at < to;) {
      const id = ebmlNumber(bytes, at, true), length = id && ebmlNumber(bytes, at + id.length);
      if (!id || !length) break;
      const body = at + id.length + length.length, stop = length.unknown ? to : Math.min(to, body + length.value);
      if (inVideo && id.value === EBML.PIXEL_WIDTH) size.width = number(body, stop);
      else if (inVideo && id.value === EBML.PIXEL_HEIGHT) size.height = number(body, stop);
      else if (containers.has(id.value)) {
        const inner = walk(body, stop, inVideo || id.value === EBML.VIDEO);
        if (inner.width && inner.height) return inner;
      }
      at = stop;
    }
    return size;
  };
  return walk(0, bytes.length, false);
}

class GsrCapture extends EventEmitter {
  constructor({ primaryGpuVendor = '', primaryGpuCard = '', runner = gpuScreenRecorderCommand, spawnImpl = spawnRecorder, keyframeSeconds = KEYFRAME_SECONDS, stopWaits = { term: STOP_TERM_WAIT_MS, kill: STOP_KILL_WAIT_MS } } = {}) {
    super();
    Object.assign(this, { primaryGpuVendor, primaryGpuCard, runner, spawnImpl, keyframeSeconds, stopWaits });
    this.child = null; this.stopping = false; this.stopped = null; this.error = '';
  }

  info() { return nativeScreenInfoAsync(this.primaryGpuVendor, this.primaryGpuCard); }

  // Returns once the recorder is launched. 'config' follows when the first picture exists (after the user has chosen a screen
  // in the system picker, which can take as long as they like), then 'frame' for every picture.
  async start(options = {}) {
    if (this.child) throw new Error('A screen capture is already running');
    const info = await this.info();
    if (!info.supported) throw new Error(info.reason);
    const runner = this.runner();
    if (!runner) throw new Error('GPU Screen Recorder is unavailable');
    const fps = Number(options.fps) === 30 ? 30 : 60;
    const sourceSize = Number(options.width) === 0 && Number(options.height) === 0;
    const width = sourceSize ? 0 : RESOLUTIONS.widths.includes(Number(options.width)) ? Number(options.width) : 3840;
    const height = sourceSize ? 0 : RESOLUTIONS.heights.includes(Number(options.height)) ? Number(options.height) : 2160;
    const maxKbps = info.vendor === 'amd' ? 150000 : 200000;
    const bitrateKbps = Math.max(1000, Math.min(maxKbps, Math.round(Number(options.bitrateKbps) || 16000)));
    const cursor = options.cursor === 'never' ? 'no' : 'yes';
    const testSource = process.env.KNOT_NATIVE_SCREEN_TEST === '1' && /^[A-Za-z0-9_.-]{1,64}$/.test(options.captureSource || '') ? options.captureSource : '';
    // CBR so the bytes per second the link has to carry are the bytes the sharer chose. A long keyframe interval is what
    // makes this much sharper than the old 0.15 s one: the same bitrate buys about 4.7 dB more picture (measured on NVENC AV1).
    // One picture per WebM cluster keeps delivery at display cadence; strict GOP keeps the interval exact. The options after
    // -ffmpeg-video-opts are NVENC-specific; AMD VA-API keeps its own defaults.
    const videoOptions = info.vendor === 'nvidia' ? ['-ffmpeg-video-opts', 'spatial-aq=1;aq-strength=8;rc-lookahead=0;strict_gop=1'] : [];
    const args = ['-w', testSource || 'portal', '-s', `${width}x${height}`, '-k', 'av1', '-encoder', 'gpu', '-f', String(fps), '-fm', 'content', '-bm', 'cbr', '-q', String(bitrateKbps),
      '-tune', 'performance', '-keyint', String(this.keyframeSeconds), '-cursor', cursor, '-fallback-cpu-encoding', 'no', '-c', 'webm', ...videoOptions, '-ffmpeg-opts', 'cluster_time_limit=0'];
    const child = this.spawnImpl(runner, args);
    this.child = child; this.stopping = false; this.error = ''; this.stopped = null;
    const state = { segmenter: new WebmClusterSegmenter(), init: null, announced: false, firstUs: null, stderr: '', frames: 0, width, height, fps, encoder: info.encoder, source: info.source };
    this._state = state;
    child.stdout.on('data', chunk => { if (!this.stopping && this.child === child) this._read(state, chunk); });
    child.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk.toString()).slice(-4096); });
    let finished = false;
    const finish = (code, signal, spawnError) => {
      if (finished) return; finished = true;
      if (this.child === child) this.child = null;
      const lines = state.stderr.trim().split('\n').map(line => line.trim()).filter(line => line && !/gsr warning/i.test(line));
      const said = (lines.find(line => /^gsr error:/i.test(line)) || lines.at(-1) || '').replace(/^gsr error:\s*/i, '');
      const reason = spawnError?.message || (code && !this.stopping ? said || `GPU Screen Recorder exited with code ${code}` : '');
      if (reason && !this.stopping) { this.error = reason; this.emit('error', new Error(reason)); }
      else if (!this.stopping && signal) this.emit('error', new Error(`GPU Screen Recorder was stopped by ${signal}`));
      this.emit('end');
      this.stopped?.resolve();
    };
    child.on('error', error => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal));
    return { width, height, fps, bitrateKbps, encoder: info.encoder, source: info.source };
  }

  _read(state, chunk) {
    let segments;
    try { segments = state.segmenter.push(chunk); } catch (error) { this.error = error.message; this.emit('error', error); this.stop(); return; }
    for (const segment of segments) {
      if (segment.kind === 'init') { state.init = segment.data; continue; }
      if (!state.init) continue;
      for (const frame of webmAv1Frames(segment.data, state.fps)) {
        if (!state.announced) {
          // Nothing can be shown before a key picture, and the recorder's first one carries the stream's description.
          if (frame.type !== 'key') continue;
          const description = av1Description(state.init), size = webmVideoSize(state.init);
          state.announced = true; state.firstUs = frame.timestamp;
          this.emit('config', { codec: av1Codec(description), width: size.width || state.width, height: size.height || state.height, fps: state.fps, encoder: state.encoder });
        }
        state.frames++;
        this.emit('frame', { key: frame.type === 'key', pts: frame.timestamp - state.firstUs, data: frame.data });
      }
    }
  }

  // Resolves once the recorder has really gone.
  stop() {
    if (this.stopped) return this.stopped.promise;
    const child = this.child;
    let resolve; const promise = new Promise(done => { resolve = done; });
    this.stopped = { promise, resolve };
    if (!child) { resolve(); return promise; }
    this.stopping = true;
    signalGroup(child, 'SIGTERM');
    const term = setTimeout(() => signalGroup(child, 'SIGKILL'), this.stopWaits.term);
    const kill = setTimeout(() => { signalGroup(child, 'SIGKILL'); resolve(); }, this.stopWaits.kill);
    promise.then(() => { clearTimeout(term); clearTimeout(kill); });
    return promise;
  }
}

module.exports = { GsrCapture, webmVideoSize, spawnRecorder, LAUNCH_SCRIPT, KEYFRAME_SECONDS };
