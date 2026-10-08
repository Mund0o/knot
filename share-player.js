(function installSharePlayer(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotSharePlayer = api;
})(typeof window === 'object' ? window : typeof globalThis === 'object' ? globalThis : null, root => {
  // Shows a screen share: decodes the pictures a viewer receives and draws them on a canvas at the right moments.
  // Records go in (from share-core's receiver); a picture comes out of the decoder when its turn is near, and the playout
  // controller (share-playout.js) decides when it is shown. Nothing here ever lowers the quality of what is shown.
  //
  // Decoded 4K pictures are big (about 12 MB each in software), so the player keeps the *encoded* pictures queued and only decodes
  // a few ahead of the clock; the buffer the viewer waits behind costs the memory of the compressed stream, not of the raw one.
  const Playout = (typeof require === 'function' && typeof module === 'object') ? require('./share-playout').Playout : root.KnotSharePlayout.Playout;
  const Wire = (typeof require === 'function' && typeof module === 'object') ? require('./share-wire') : root.KnotShareWire;
  const { TYPE } = Wire;

  const DECODE_AHEAD_MIN_US = 150000;      // decode pictures this far ahead of the clock (or six pictures, whichever is more)
  const START_BATCH = 40;                  // before the clock has started, decode this many to get the first picture out
  const MAX_DECODE_QUEUE = 48;
  const MAX_BACKLOG_SECONDS = 20;          // encoded pictures waiting this long means the decoder cannot keep up at all: restart from the newest key
  // Software decoding runs in one of two modes. Low-latency mode hands every picture out as soon as it is decoded, with none held back, but
  // Chromium then decodes on few threads: about 49 pictures a second at 4K on a fast desktop CPU. The other mode decodes on all of them
  // (175 a second) but keeps about four pictures inside the decoder until more arrive, which is invisible on a stream of 60 a second and
  // a stuck, stale picture on a screen that has stopped changing (measured: at 10 pictures a second they show 400 ms late, and the last four never
  // come out). So a share starts in low-latency mode and moves to the fast one only while the decoder is what the viewer is waiting for on
  // a steady stream, and moves back when the pictures stop.
  const DECODE_BOUND_SWITCH_MS = 1000;     // waiting on the decoder this long (leaky count) moves to the fast mode
  const DECODE_BOUND_PENDING = 5;         // a low-latency decoder that keeps up has one or two pictures inside; this many staying there means it does not
  const HEAVY_PIXELS_PER_SECOND = 300e6;   // a stream this large (4K at 60 a second is 500 million) is past what low-latency decoding manages (about 400 million): start in the fast mode
  const THROUGHPUT_MIN_FPS = 20;           // ... but only for a stream this busy: a slow one would sit on its held-back pictures
  const IDLE_FLUSH_MS = 150;               // in the fast mode, pictures held back this long with nothing more arriving: back to low latency
  const SPARSE_REVERT_MS = 2000;           // the fast mode on a stream that is not busy after all (fewer than THROUGHPUT_MIN_FPS a second) for this long: back too
  const MODE_SWITCH_GAP_MS = 4000;         // the two never flap: a switch replays from the last key picture
  // The GPU decoder (share-gpu-decoder.js, NVIDIA on Linux) hands pictures over already scaled to the size they are shown at. Beyond this many
  // pixels (a 4K picture in full screen) copying them between processes costs more than the CPU decoder, so those are decoded on the CPU.
  const GPU_MAX_PIXELS = 2560 * 1440;
  const GPU_MIN_SIDE = 128;                // the decoder's own limit
  const GPU_SIZE_STEP = 64;                // pictures are asked for in steps of this width, so a window being resized does not restart the decoder every pixel
  const GPU_RESIZE_SETTLE_MS = 1000;       // a change of size or of decoder must hold this long before the decoder is restarted for it
  const BACKEND_REVIEW_MS = 500;
  const BACKEND_SWITCH_GAP_MS = 3000;
  const NO_OUTPUT_MS = 1200;               // a decoder that has been fed this long without a picture coming out is not working
  const DEFAULT_FPS = 60;
  // A hardware decoder can "work" (every picture decodes, nothing throws) and still hand back garbage: a black or white picture from a bad
  // driver. The first picture it produces is checked once against a software decode of the same key picture, on small thumbnails. If the
  // two disagree, the hardware decoder is replaced by the software one. Two decoders that agree on a black screen (a legitimately black or
  // white share) cause no change.
  const THUMB_W = 64, THUMB_H = 36, VERIFY_MAX_DIFFERENCE = 24;      // brightness, 0-255, averaged over the thumbnail

  function supported() { return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function'; }

  let thumbContext = null;
  function thumbnail(frame) {
    try {
      if (!thumbContext) { const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(THUMB_W, THUMB_H) : Object.assign(document.createElement('canvas'), { width: THUMB_W, height: THUMB_H }); thumbContext = canvas.getContext('2d', { willReadFrequently: true }); }
      thumbContext.drawImage(frame, 0, 0, THUMB_W, THUMB_H);
      const pixels = thumbContext.getImageData(0, 0, THUMB_W, THUMB_H).data, luma = new Float32Array(THUMB_W * THUMB_H);
      for (let i = 0, j = 0; i < pixels.length; i += 4, j++) luma[j] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      return luma;
    } catch { return null; }
  }
  function thumbnailDifference(a, b) { let total = 0; for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]); return total / a.length; }

  function createSharePlayer({ surface, getDisplaySize = () => null, onState = () => {}, onError = () => {}, onFrameDecoded = null, now = () => performance.now(),
    schedule = fn => (typeof requestAnimationFrame === 'function' && (typeof document === 'undefined' || document.visibilityState === 'visible') ? requestAnimationFrame(fn) : setTimeout(() => fn(now()), 16)),
    preferSoftware = false, playoutOptions = {}, gpuDecode = null } = {}) {
    if (!supported()) throw new Error('This build cannot decode video');
    const playout = new Playout(playoutOptions);
    const canvas = surface?.canvas || null, context = surface?.context || null;
    let config = null, decoder = null, generation = 0, destroyed = false, active = true, ended = false, loopOn = false;
    let software = !!preferSoftware, softwareReason = '', needKey = true, pending = 0, lastSubmitAt = 0, lastOutputAt = 0, verified = !!preferSoftware, verification = preferSoftware ? 'not needed' : 'waiting';
    let encoded = [], replay = [];
    let lowLatency = true, decodeBoundMs = 0, lastTickAt = 0, modeSwitchAt = -Infinity, modeSince = 0, sparseSince = 0, flushed = false;
    const recentArrivals = [];           // when the last second's pictures arrived: how busy the stream is
    let gpuOn = false, gpuFailed = false, gpuReason = '', gpuSize = null, backendWantedSince = 0, lastBackendReviewAt = 0, lastBackendSwitchAt = -Infinity;
    const arrivals = new Map();            // picture time -> when it arrived, for latency
    const latencies = [];
    const stats = { received: 0, decoded: 0, painted: 0, ticks: 0, decodeSkips: 0, restarts: 0, modeSwitches: 0, backendSwitches: 0, errors: 0, width: 0, height: 0, firstPaintAt: 0, lastPaintAt: 0, lastPacketAt: 0, lastLiveAt: 0, lastState: '' };
    const renderIntervals = [];
    const drawTimes = [];                  // how long each picture took to draw (ms): a graphics card that is busy elsewhere makes this grow

    const fps = () => Number(config?.fps) || DEFAULT_FPS;
    const aheadUs = () => Math.max(DECODE_AHEAD_MIN_US, 6e6 / fps());

    function closeFrame(frame) { try { frame.close(); } catch {} }
    // A decoder restarted mid-stream replays pictures from its last key picture, some of which were already shown: those are let go.
    let shownThrough = -Infinity;
    function resetPlayout() { playout.reset(); shownThrough = -Infinity; }

    function stopDecoder() {
      generation++;
      const old = decoder; decoder = null; pending = 0;
      if (old) { try { old.close(); } catch {} }
      for (const entry of playout.frames) closeFrame(entry.handle);
      playout.frames = [];
    }

    // The size the GPU decoder should hand pictures over at, or null when the GPU is not the right decoder now: not available, failed before,
    // not AV1, or a picture so large that the copy between processes costs more than decoding it on the CPU would.
    function gpuTarget() {
      if (!gpuDecode || gpuFailed || !gpuDecode.usable() || !config || !/^av01/i.test(String(config.codec))) return null;
      const nativeW = Number(config.width) || 0, nativeH = Number(config.height) || 0;
      if (nativeW < GPU_MIN_SIDE || nativeH < GPU_MIN_SIDE || nativeW > 8192 || nativeH > 8192) return null;
      const display = getDisplaySize();       // null in full screen: the picture is shown at its own size
      let w = nativeW, h = nativeH;
      if (display && display.width > 0 && display.height > 0 && (w > display.width || h > display.height)) {
        const scale = Math.min(display.width / w, display.height / h);
        w = Math.min(nativeW, Math.max(GPU_MIN_SIDE, Math.ceil(nativeW * scale / GPU_SIZE_STEP) * GPU_SIZE_STEP));
        h = Math.min(nativeH, Math.max(GPU_MIN_SIDE, Math.round(nativeH * w / nativeW)));
      }
      w -= w % 2; h -= h % 2;
      return w * h <= GPU_MAX_PIXELS ? { width: w, height: h } : null;
    }

    function startDecoder() {
      if (destroyed || !config) return false;
      stopDecoder();
      const mine = generation, target = gpuTarget(), mode = software ? 'prefer-software' : 'prefer-hardware';
      gpuOn = !!target;
      verified = !gpuOn && software; verification = verified ? 'not needed' : 'waiting';
      try {
        if (gpuOn) {
          const adapter = gpuDecode.create({ output: frame => onOutput(frame, mine), error: error => onDecoderError(error, mine) });
          adapter.configure({ codedWidth: config.width, codedHeight: config.height, outWidth: target.width, outHeight: target.height });
          decoder = adapter; gpuSize = target; needKey = true; flushed = false; lastOutputAt = now(); lastSubmitAt = 0;
          return true;
        }
        const instance = new VideoDecoder({
          output: frame => onOutput(frame, mine),
          error: error => onDecoderError(error, mine),
        });
        // A hardware decoder always keeps the flag; the software one follows lowLatency (see DECODE_BOUND_SWITCH_MS).
        instance.configure({ codec: config.codec, codedWidth: config.width || undefined, codedHeight: config.height || undefined, hardwareAcceleration: mode, optimizeForLatency: !software || lowLatency });
        decoder = instance; needKey = true; flushed = false; lastOutputAt = now(); lastSubmitAt = 0;
        return true;
      } catch (error) { return fallbackOrFail(error); }
    }

    // A hardware decoder that refuses a stream or produces nothing is replaced by the software one, once, and the stream is replayed
    // from its last key picture. That is a decoder failure, not a response to the link, so it is not a downgrade.
    function fallbackOrFail(error) {
      if (gpuOn) {
        // The GPU decoder failed (it would not start, stopped, showed a different picture, or went quiet): the CPU takes over for good.
        gpuFailed = true; gpuOn = false; gpuReason = String(error?.message || error || 'the GPU decoder failed'); stats.restarts++;
        const resume = replay.slice();
        if (!startDecoder()) return false;
        encoded = [...resume, ...encoded]; replay = [];
        return true;
      }
      if (!software) {
        software = true; softwareReason = String(error?.message || error || 'hardware decoder failed'); stats.restarts++;
        const resume = replay.slice();
        if (!startDecoder()) return false;
        encoded = [...resume, ...encoded]; replay = [];
        return true;
      }
      stats.errors++; destroyedWith(error); return false;
    }
    // Moves the software decoder between its two modes and replays the pictures since the last key picture, as the hardware fallback does.
    function changeDecodeMode(low) {
      if (low === lowLatency || !software || gpuOn || destroyed || !decoder) return;
      lowLatency = low; modeSwitchAt = modeSince = now(); decodeBoundMs = 0; sparseSince = 0; stats.modeSwitches++;
      const resume = replay.slice();
      if (!startDecoder()) return;
      encoded = [...resume, ...encoded]; replay = [];
    }

    // Called every refresh: has the decoder fallen behind (pictures stay inside it, or one is due and none is decoded), or are pictures
    // sitting inside the fast mode's decoder with nothing more coming?
    function adaptDecodeMode(t, waitingOnDecoder) {
      const dt = lastTickAt ? Math.min(250, t - lastTickAt) : 0; lastTickAt = t;
      if (!software || gpuOn || ended) return;
      while (recentArrivals.length && t - recentArrivals[0] > 1000) recentArrivals.shift();
      const busy = recentArrivals.length >= THROUGHPUT_MIN_FPS;
      if (lowLatency) {
        decodeBoundMs = Math.max(0, decodeBoundMs + (waitingOnDecoder ? dt : -dt / 2));
        if (decodeBoundMs > DECODE_BOUND_SWITCH_MS && busy && t - modeSwitchAt > MODE_SWITCH_GAP_MS) changeDecodeMode(false);
        return;
      }
      if (t - modeSince < MODE_SWITCH_GAP_MS) return;
      if (pending > 0 && !encoded.length && lastSubmitAt && t - lastSubmitAt > IDLE_FLUSH_MS) { changeDecodeMode(true); return; }
      if (busy) sparseSince = 0;
      else if (!sparseSince) sparseSince = t;
      else if (t - sparseSince > SPARSE_REVERT_MS) changeDecodeMode(true);
    }

    // Called a few times a second: is the decoder in use still the right one for the size the picture is shown at? Full screen on a 4K
    // display wants the CPU decoder, a window wants the GPU one, and a window that was resized wants the GPU to hand over another size.
    // A change must hold for a moment before the decoder is restarted for it (which replays from the last key picture).
    function reviewBackend(t) {
      if (!gpuDecode || gpuFailed || !active || ended || t - lastBackendReviewAt < BACKEND_REVIEW_MS) return;
      lastBackendReviewAt = t;
      const target = gpuTarget();
      const change = !!target !== gpuOn || (!!target && gpuOn && (target.width !== gpuSize.width || target.height !== gpuSize.height));
      if (!change) { backendWantedSince = 0; return; }
      if (!backendWantedSince) { backendWantedSince = t; return; }
      if (t - backendWantedSince < GPU_RESIZE_SETTLE_MS || t - lastBackendSwitchAt < BACKEND_SWITCH_GAP_MS || !decoder) return;
      backendWantedSince = 0; lastBackendSwitchAt = t; stats.backendSwitches++;
      // Leaving the GPU decoder for the CPU: Chromium's own hardware decoder is not an option where this exists (NVIDIA on Linux shows black).
      if (!target && !software) { software = true; softwareReason = 'decoded on the CPU at this size'; }
      const resume = replay.slice();
      if (!startDecoder()) return;
      encoded = [...resume, ...encoded]; replay = [];
    }

    function destroyedWith(error) { if (destroyed) return; try { onError(error instanceof Error ? error : new Error(String(error))); } catch {} }

    function verifyAgainstSoftware(first, reference, mine) {
      let reference2 = reference, soft = null, done = false;
      const finish = thumb => {
        if (done) return; done = true;
        try { soft?.close(); } catch {}
        if (mine !== generation || destroyed || (software && !gpuOn)) return;
        if (!thumb || !reference2) { verification = 'could not compare'; return; }          // nothing to compare with: the hardware decoder is trusted
        if (thumbnailDifference(thumb, reference2) > VERIFY_MAX_DIFFERENCE) { verification = 'different'; fallbackOrFail(new Error('The ' + (gpuOn ? 'GPU' : 'hardware') + ' decoder showed a different picture than the software decoder')); }
        else verification = 'ok';
      };
      try {
        soft = new VideoDecoder({ output: frame => { const thumb = thumbnail(frame); try { frame.close(); } catch {} finish(thumb); }, error: () => finish(null) });
        soft.configure({ codec: config.codec, codedWidth: config.width || undefined, codedHeight: config.height || undefined, hardwareAcceleration: 'prefer-software' });
        soft.decode(new EncodedVideoChunk({ type: 'key', timestamp: first.pts, data: first.data }));
        soft.flush().then(() => finish(null), () => finish(null));      // a decoder that outputs nothing at all ends the wait here
      } catch { finish(null); }
    }

    function onDecoderError(error, mine) { if (mine !== generation || destroyed) return; fallbackOrFail(error); }

    function onOutput(frame, mine) {
      if (mine !== generation || destroyed) { closeFrame(frame); return; }
      pending = Math.max(0, pending - 1); stats.decoded++; lastOutputAt = now();
      if (frame.timestamp <= shownThrough) { closeFrame(frame); arrivals.delete(frame.timestamp); return; }
      stats.width = frame.displayWidth || frame.codedWidth; stats.height = frame.displayHeight || frame.codedHeight;
      // The first picture a hardware decoder produces is the key picture that began the replay: check it against a software decode of it.
      if (!verified && (gpuOn || !software) && replay.length && replay[0].key && replay[0].pts === frame.timestamp) { verified = true; verification = 'checking'; verifyAgainstSoftware(replay[0], thumbnail(frame), mine); }
      if (onFrameDecoded) { try { onFrameDecoded(frame); } catch {} }
      if (!active) { closeFrame(frame); arrivals.delete(frame.timestamp); return; }
      playout.addFrame(frame.timestamp, frame);
      kick();
    }

    // ---- input
    // The description can arrive after the first pictures (it travels a different way); those wait in the queue until there is a decoder.
    function configure(next) {
      const changed = !!config && (config.codec !== next.codec || config.width !== next.width || config.height !== next.height);
      if (!config || changed) { lowLatency = !((Number(next.width) || 0) * (Number(next.height) || 0) * (Number(next.fps) || DEFAULT_FPS) >= HEAVY_PIXELS_PER_SECOND); modeSwitchAt = -Infinity; modeSince = now(); sparseSince = 0; }
      config = { ...next };
      if (changed) { encoded = []; replay = []; resetPlayout(); }
      if (!decoder || changed) startDecoder();
      kick();
    }

    function push(record) {
      if (destroyed) return;
      const t = now();
      if (record.type === TYPE.HEARTBEAT) { playout.noteSource(record.pts); stats.lastLiveAt = t; kick(); return; }
      if (record.type === TYPE.END) { ended = true; playout.finish(); stats.lastLiveAt = t; kick(); return; }
      if (record.type !== TYPE.VIDEO) return;
      stats.received++; stats.lastPacketAt = stats.lastLiveAt = t;
      const pts = Math.round(record.pts);
      playout.noteSource(pts);
      arrivals.set(pts, t);
      recentArrivals.push(t);
      encoded.push({ key: record.key, pts, data: record.payload });
      if (!active) trimToLastKey();
      else if (encoded.length > MAX_BACKLOG_SECONDS * fps()) skipToLatestKey();
      kick();
    }

    // The sharer moved this viewer forward (it had fallen too far behind): start again from a key picture.
    function skip() {
      encoded = []; replay = []; arrivals.clear(); resetPlayout(); stats.decodeSkips++;
      if (decoder) startDecoder();
    }

    function trimToLastKey() {
      let at = -1; for (let i = encoded.length - 1; i >= 0; i--) if (encoded[i].key) { at = i; break; }
      if (at > 0) encoded.splice(0, at);
    }
    function skipToLatestKey() {
      trimToLastKey(); stats.decodeSkips++;
      resetPlayout(); replay = []; if (decoder) startDecoder();
    }

    function setActive(value) {
      value = !!value; if (value === active) return; active = value;
      if (!active) { stopDecoder(); trimToLastKey(); replay = []; resetPlayout(); }
      else { resetPlayout(); startDecoder(); kick(); }
    }

    // ---- decoding
    function pump() {
      if (!decoder || !active) return;
      const limit = playout.playhead === null ? null : playout.playhead + aheadUs();
      let started = playout.playhead === null ? START_BATCH : Infinity;
      // Nothing decoded and nothing on its way: the next picture is decoded now, however far ahead of the clock it is. Pictures further apart than
      // the look-ahead window (a quiet screen) would otherwise never give a buffering clock the decoded picture it is waiting for.
      let forced = playout.playhead !== null && !playout.frames.length && pending === 0;
      while (encoded.length && started > 0 && (decoder.decodeQueueSize || 0) < MAX_DECODE_QUEUE && (limit === null || forced || encoded[0].pts <= limit)) {
        const item = encoded.shift(); started--;
        if (needKey) { if (!item.key) { arrivals.delete(item.pts); continue; } needKey = false; replay = []; }
        else if (item.key) replay = [];
        forced = false;
        replay.push(item);
        try { decoder.decode(gpuOn ? { type: item.key ? 'key' : 'delta', timestamp: item.pts, data: item.data } : new EncodedVideoChunk({ type: item.key ? 'key' : 'delta', timestamp: item.pts, data: item.data })); pending++; lastSubmitAt = now(); }
        catch (error) { onDecoderError(error, generation); return; }
      }
      // The share is over and every picture is inside the decoder: a decoder that holds some back (the fast mode) must let the last ones out.
      if (ended && !flushed && !encoded.length && pending > 0) { flushed = true; try { decoder.flush().catch(() => {}); } catch {} }
    }

    // ---- presenting
    function size() {
      const display = getDisplaySize();
      let w = stats.width, h = stats.height;
      if (display && w && h && (w > display.width || h > display.height)) { const scale = Math.min(display.width / w, display.height / h, 1); w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale)); }
      return { w: w || 960, h: h || 540 };
    }

    function draw(frame) {
      const t = now(), pts = frame.timestamp, arrived = arrivals.get(pts); arrivals.delete(pts);
      if (canvas && context) {
        const { w, h } = size();
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        const drawStart = now();
        try { context.drawImage(frame, 0, 0, w, h); } catch (error) { closeFrame(frame); stats.errors++; destroyedWith(error); return; }
        drawTimes.push(now() - drawStart); if (drawTimes.length > 120) drawTimes.shift();
        if (!stats.firstPaintAt) { stats.firstPaintAt = t; surface?.reveal?.(); }
      }
      closeFrame(frame);
      if (stats.lastPaintAt) { renderIntervals.push(t - stats.lastPaintAt); if (renderIntervals.length > 360) renderIntervals.shift(); }
      stats.lastPaintAt = t; stats.painted++;
      if (pts > shownThrough) shownThrough = pts;
      if (arrived !== undefined) { latencies.push(t - arrived); if (latencies.length > 360) latencies.shift(); }
    }

    function tick(t) {
      loopOn = false;
      if (destroyed) return;
      stats.ticks++;
      pump();
      if (active) {
        const result = playout.tick(t, { pending });
        for (const frame of result.dropped) { arrivals.delete(frame.timestamp); closeFrame(frame); }
        if (result.present) draw(result.present);
        pump();
        reviewBackend(t);
        adaptDecodeMode(t, pending >= DECODE_BOUND_PENDING || (playout.state === 'playing' && !playout.frames.length && pending > 0));
        const label = ended && !playout.frames.length && !encoded.length ? 'ended' : stats.painted ? result.state === 'buffering' ? 'buffering' : 'live' : 'connecting';
        if (label !== stats.lastState) { stats.lastState = label; try { onState({ state: label, ...status() }); } catch {} }
        // A decoder that is fed and never answers is not working (a driver that accepts AV1 and returns nothing, say).
        if (decoder && (gpuOn || !software) && pending >= 18 && t - Math.max(lastOutputAt, lastSubmitAt - 1) > NO_OUTPUT_MS && lastSubmitAt) fallbackOrFail(new Error('The hardware decoder produced no pictures'));
      }
      if (active) kick();
    }

    function kick() {
      if (loopOn || destroyed) return;
      loopOn = true; schedule(tick);
    }

    function status() {
      return { buffering: playout.state === 'buffering', delayMs: Math.round(playout.delayMs), depthMs: Math.round(playout.depthMs), stalls: playout.stalls, jumps: playout.jumps };
    }

    function percentile(list, p) { if (!list.length) return 0; const sorted = [...list].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]; }

    return {
      configure, push, skip, setActive, supported,
      get ended() { return ended; },
      // What the buffering view needs: a still screen keeps lastLiveAt fresh through heartbeats even though no picture arrives.
      read() { return { painted: stats.painted, lastPacketAt: stats.lastPacketAt, lastLiveAt: stats.lastLiveAt, liveCapable: true }; },
      stats() {
        const intervals = renderIntervals.slice(-120), mean = intervals.reduce((a, b) => a + b, 0) / Math.max(1, intervals.length);
        return {
          ...stats, ...status(), decoder: gpuOn ? 'nvdec' : software ? 'software' : 'hardware-preferred', decodeMode: gpuOn ? 'gpu' : software && !lowLatency ? 'throughput' : 'low-latency', softwareReason: gpuReason && !gpuOn ? gpuReason : softwareReason, gpuSize, pending, verification, queued: encoded.length, decodedWaiting: playout.frames.length, skippedShown: playout.skipped, skippedAtStart: playout.skippedAtStart,
          renderFps: mean ? 1000 / mean : 0, renderCadenceP95Ms: percentile(intervals, .95), drawMsP95: percentile(drawTimes, .95), latencyP50Ms: percentile(latencies, .5), latencyP95Ms: percentile(latencies, .95), rate: playout.rate,
        };
      },
      destroy() { if (destroyed) return; destroyed = true; stopDecoder(); encoded = []; replay = []; arrivals.clear(); },
    };
  }

  return { createSharePlayer, supported };
});
