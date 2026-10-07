(function installShareEncoder(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotShareEncoder = api;
})(typeof window === 'object' ? window : typeof globalThis === 'object' ? globalThis : null, root => {
  // Captures the screen and encodes it in the page, for every computer that does not have the native recorder (Windows, and Linux
  // without GPU Screen Recorder). It produces exactly what the Linux capture does: a description of the stream, then { key, pts, data }
  // pictures, so everything after it (the lanes, the viewer) is the same on every platform.
  //
  // The encoder is chosen by what this computer can actually do, never by how the link is doing: hardware before software, and
  // among the codecs every Knot can decode (AV1, H.264, VP9), the most efficient one the hardware offers. A computer that can only
  // encode in software is held to the size and rate it can really sustain, and the picker says so; the network is never consulted.
  const KEYFRAME_SECONDS = 2;
  const MAX_ENCODE_QUEUE = 3;              // a frame arriving while this many wait to be encoded is dropped: the encoder, not the link, is the limit
  // How many bits each codec needs for the same picture, relative to AV1 (measured: AV1 at 16 Mbps looks like VP9 at ~20 and H.264 at ~26).
  const EFFICIENCY = { av1: 1, vp9: 1.25, h264: 1.6 };
  const PREFERENCE = ['av1', 'h264', 'vp9'];
  const EARLY_EXIT_RATIO = 0.4;            // a candidate below this share of the wanted rate after a moment is not worth timing any further
  const CHOOSE_BUDGET_MS = 10000;          // choosing stops trying more candidates after this long and takes the best one measured

  const level = { av1: (w, h, f) => (w * h * f > 1920 * 1080 * 60 ? '13H' : w * h * f > 1920 * 1080 * 30 ? '09M' : '08M'), h264: (w, h, f) => (w * h * f > 1920 * 1080 * 60 ? '34' : w * h * f > 1920 * 1080 * 30 ? '2A' : '28'), vp9: (w, h, f) => (w * h * f > 1920 * 1080 * 60 ? '52' : '41') };
  const codecString = (codec, w, h, f) => codec === 'av1' ? `av01.0.${level.av1(w, h, f)}.08` : codec === 'h264' ? `avc1.6400${level.h264(w, h, f)}` : `vp09.00.${level.vp9(w, h, f)}.08`;

  function supported() { return typeof VideoEncoder === 'function' && typeof MediaStreamTrackProcessor === 'function'; }

  // The codecs in the order they are tried. A codec the sharer asked for goes first; it is a preference about what this computer
  // encodes, so a computer that cannot encode it falls through to the rest instead of failing to share.
  const codecOrder = prefer => { const first = PREFERENCE.includes(String(prefer || '').toLowerCase()) ? String(prefer).toLowerCase() : ''; return first ? [first, ...PREFERENCE.filter(codec => codec !== first)] : PREFERENCE; };

  // What this computer can encode at this size and rate, best first. Each entry says whether the encoder is hardware.
  async function probe({ width, height, fps = 60, bitrateKbps = 8000, prefer = '' } = {}) {
    const found = [];
    if (typeof VideoEncoder !== 'function') return found;
    for (const mode of ['prefer-hardware', 'prefer-software']) {
      for (const codec of codecOrder(prefer)) {
        const config = { codec: codecString(codec, width, height, fps), width, height, bitrate: Math.round(bitrateKbps * 1000), framerate: fps, latencyMode: 'realtime', bitrateMode: 'constant', hardwareAcceleration: mode, ...(codec === 'h264' ? { avc: { format: 'annexb' } } : {}) };
        let answer = null;
        try { answer = await VideoEncoder.isConfigSupported(config); } catch {}
        if (answer?.supported) found.push({ codec, hardware: mode === 'prefer-hardware', string: config.codec, config: answer.config || config });
      }
    }
    // Hardware first (AV1, then H.264, then VP9), then software in the same order of preference.
    return found;
  }

  // Encodes a short burst of moving, detailed frames and reports how fast this encoder really goes. A computer that "supports" 1080p60 in
  // software may manage 20 frames a second; the answer decides what the sharer is offered, not what the link does.
  async function benchmark(candidate, { width, height, fps = 60, bitrateKbps = 8000, frames = 36 } = {}) {
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d');
    let done = 0, failed = null;
    const encoder = new VideoEncoder({ output: () => { done++; }, error: error => { failed = error; } });
    try {
      encoder.configure({ ...candidate.config, codec: codecString(candidate.codec, width, height, fps), width, height, bitrate: Math.round(bitrateKbps * 1000), framerate: fps, latencyMode: 'realtime', bitrateMode: 'constant', hardwareAcceleration: candidate.hardware ? 'prefer-hardware' : 'prefer-software' });
      const draw = i => {
        context.fillStyle = '#1e1e2e'; context.fillRect(0, 0, width, height);
        context.fillStyle = '#cdd6f4'; context.font = Math.round(height / 40) + 'px monospace';
        for (let line = 0; line < 30; line++) context.fillText('const frame' + i + ' = render(' + (line * 37 + i * 11) + ', "detail ' + (i % 9) + '");', 20, ((line * (height / 30) - i * 3) % height + height) % height);
        context.fillStyle = 'hsl(' + (i * 7 % 360) + ' 70% 50%)'; context.fillRect((i * 13) % (width / 2), height / 3, width / 3, height / 4);
      };
      const started = performance.now();
      let submitted = 0;
      for (let i = 0; i < frames && !failed; i++) {
        draw(i);
        const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps) });
        while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE && !failed) await new Promise(resolve => setTimeout(resolve, 1));
        encoder.encode(frame, { keyFrame: i === 0 }); frame.close(); submitted++;
        // An encoder far below the rate says so within a few pictures; proving it for seconds longer helps nobody. The rate is the pace the
        // queue let pictures in, which is the encoder's own pace.
        const elapsed = (performance.now() - started) / 1000;
        if (submitted >= 6 && elapsed > 1.2 && submitted / elapsed < fps * EARLY_EXIT_RATIO) return failed ? 0 : submitted / elapsed;
      }
      await encoder.flush();
      const seconds = (performance.now() - started) / 1000;
      return failed ? 0 : done / seconds;
    } catch { return 0; } finally { try { encoder.close(); } catch {} }
  }

  // The encoder this computer should use for a share of this size and rate: the first, in order of preference, that really keeps up.
  // If none does, the best that was found is returned with the rate it can sustain, so the picker can offer a lower setting.
  async function choose(options) {
    const fps = options.fps || 60, candidates = await probe(options), tried = [], began = performance.now();
    for (const candidate of candidates) {
      if (tried.length && performance.now() - began > CHOOSE_BUDGET_MS) break;
      const achieved = await benchmark(candidate, options);
      tried.push({ codec: candidate.codec, hardware: candidate.hardware, fps: Math.round(achieved * 10) / 10 });
      if (achieved >= fps * 1.15) return { choice: candidate, sustainedFps: achieved, keepsUp: true, tried };
    }
    const best = tried.length ? tried.reduce((a, b) => (b.fps > a.fps ? b : a)) : null;
    const choice = best ? candidates.find(c => c.codec === best.codec && c.hardware === best.hardware) : null;
    return { choice, sustainedFps: best?.fps || 0, keepsUp: false, tried };
  }

  // Bits per second a stream of this size needs for a clean picture, scaled for how efficient the codec is. This is a statement about the
  // picture, not the link; the sharer may override it, and nothing lowers it later.
  function recommendedKbps({ width, height, fps = 60, codec = 'av1' }) {
    const pixels = width * height, ratio = pixels / (1920 * 1080), rate = fps === 30 ? 0.62 : 1;
    const av1 = Math.max(2750, 6774 * Math.pow(ratio, 0.62) * rate);
    return Math.round(av1 * (EFFICIENCY[codec] || 1));
  }

  // contentHint ('text' for desktop work, 'motion' for games and video) tells the encoder what it is looking at; it never changes the size or rate.
  // It is applied to AV1 only. Measured with the software encoders on 1280x720 text and moving content at 4 Mbps: 'motion' is identical to no hint;
  // 'text' on AV1 takes half the bits for better quality (40.7 dB against 39.6 dB, worst frame 39.7 against 35.0), but on H.264 it lowers
  // quality (37.1 dB against 40.6 dB). A hint that makes a codec worse is not passed to it.
  function create({ track, width, height, fps = 60, bitrateKbps, choice, contentHint = '', keyframeSeconds = KEYFRAME_SECONDS, onConfig = () => {}, onFrame = () => {}, onError = () => {}, now = () => performance.now() } = {}) {
    if (!supported()) throw new Error('This build cannot encode video');
    if (!track) throw new Error('no video track to encode');
    let encoder = null, reader = null, stopped = false, current = null, firstTs = null, lastKeyTs = -Infinity, needKey = true, configured = false;
    const stats = { encoded: 0, bytes: 0, dropped: 0, keys: 0, reconfigured: 0, errors: 0, width: 0, height: 0, codec: choice?.codec || '', hardware: !!choice?.hardware, startedAt: 0 };

    function open(w, h) {
      const kbps = Number(bitrateKbps) > 0 ? Number(bitrateKbps) : recommendedKbps({ width: w, height: h, fps, codec: choice.codec });
      const config = { ...choice.config, codec: codecString(choice.codec, w, h, fps), width: w, height: h, bitrate: Math.round(kbps * 1000), framerate: fps, latencyMode: 'realtime', bitrateMode: 'constant', hardwareAcceleration: choice.hardware ? 'prefer-hardware' : 'prefer-software', ...(contentHint && choice.codec === 'av1' ? { contentHint } : {}) };
      const instance = new VideoEncoder({
        output: chunk => { if (instance === encoder) emit(chunk); },
        error: error => { if (instance !== encoder || stopped) return; stats.errors++; try { onError(error); } catch {} },
      });
      instance.configure(config);
      encoder = instance; current = { width: w, height: h, codec: config.codec, bitrateKbps: kbps }; needKey = true; configured = false;
      stats.width = w; stats.height = h;
    }

    function emit(chunk) {
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      const key = chunk.type === 'key';
      if (firstTs === null) firstTs = chunk.timestamp;
      if (!configured) {
        // Nothing can be shown before a key picture, and the first one carries the stream's description.
        if (!key) return;
        configured = true;
        onConfig({ codec: current.codec, width: current.width, height: current.height, fps, encoder: (choice.hardware ? 'hardware ' : 'software ') + choice.codec.toUpperCase(), bitrateKbps: Math.round(current.bitrateKbps) });
      }
      stats.encoded++; stats.bytes += data.length; if (key) stats.keys++;
      onFrame({ key, pts: chunk.timestamp - firstTs, data });
    }

    async function pump() {
      const processor = new MediaStreamTrackProcessor({ track });
      reader = processor.readable.getReader();
      try {
        for (;;) {
          const { value: frame, done } = await reader.read();
          if (done || stopped) { frame?.close(); break; }
          try {
            const w = frame.displayWidth || frame.codedWidth, h = frame.displayHeight || frame.codedHeight;
            if (!encoder || w !== current.width || h !== current.height) {
              // The picture changed size (a window was resized, a display was switched): describe the stream anew and start on a key picture.
              if (encoder) { stats.reconfigured++; try { await encoder.flush(); } catch {} try { encoder.close(); } catch {} }
              open(w, h);
            }
            if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) { stats.dropped++; continue; }
            const key = needKey || frame.timestamp - lastKeyTs >= keyframeSeconds * 1e6;
            if (key) { lastKeyTs = frame.timestamp; needKey = false; }
            encoder.encode(frame, { keyFrame: key });
          } finally { frame.close(); }
        }
      } catch (error) { if (!stopped) { stats.errors++; try { onError(error); } catch {} } }
    }

    return {
      start() { stats.startedAt = now(); const settings = track.getSettings?.() || {}; open(settings.width || width, settings.height || height); return pump(); },
      requestKeyFrame() { needKey = true; },
      stats() { const seconds = Math.max(0.001, (now() - stats.startedAt) / 1000); return { ...stats, kbps: Math.round(stats.bytes * 8 / seconds / 1000), queued: encoder?.encodeQueueSize || 0 }; },
      get current() { return current; },
      async stop() {
        if (stopped) return; stopped = true;
        try { await reader?.cancel(); } catch {}
        try { track.stop(); } catch {}
        try { encoder?.close(); } catch {}
        encoder = null;
      },
    };
  }

  return { probe, benchmark, choose, create, recommendedKbps, codecString, codecOrder, supported, KEYFRAME_SECONDS, EFFICIENCY, PREFERENCE };
});
