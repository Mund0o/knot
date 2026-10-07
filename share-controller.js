(function installShareController(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotShareController = api;
})(typeof window === 'object' ? window : typeof globalThis === 'object' ? globalThis : null, root => {
  // What sits between the app and the share engine. The app says what it can do (send a control message to a friend, open a data
  // channel to them, draw on a surface) and this joins that to the engine: a capture source feeding a ShareHost for the person
  // sharing, a ShareViewer and player for each person watching, and the sound lined up with the picture. It owns no UI and no
  // sockets, and holds no opinion about the link: nothing here lowers the quality of a share.
  const required = (name, local) => (typeof require === 'function' && typeof module === 'object') ? require(local) : root[name];
  const defaults = () => ({ Session: required('KnotShareSession', './share-session'), Player: required('KnotSharePlayer', './share-player') });

  const SHARE_ID_BYTES = 12;
  const REANNOUNCE_MS = 3000;          // the offer is repeated this often while sharing: whoever joins late, or reconnects, finds the share without any other trigger
  const END_DRAIN_MS = 6000;           // after the sharer stops: how long viewers get to take in what was already captured
  const END_QUIET_MS = 4000;           // the sharer said the share ended but the end record never came: nothing has arrived for this long
  const END_PLAYOUT_MS = 10000;        // the end record arrived: how long a viewer may take to play out what it still holds
  const AUDIO_MARGIN_MS = 40;
  const AUDIO_MIN_MS = 120;            // sound keeps at least this much jitter buffer (see holdScreenAudioJitter): shorter makes it choke
  const AUDIO_MAX_MS = 4000;           // what the browser accepts
  const AUDIO_STEP_MS = 25;

  function newShareId() {
    const bytes = new Uint8Array(SHARE_ID_BYTES);
    (root?.crypto || require('crypto').webcrypto).getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------------------------------------------------------ capture sources
  // A source does one thing: after start(handlers) it calls handlers.onConfig(description) once the stream exists (and again if the
  // picture changes size), then handlers.onFrame({ key, pts, data }) for every encoded picture. onError / onEnd report a source that
  // failed or finished by itself. stop() resolves once it has really stopped.

  // The Linux recorder (GPU Screen Recorder), through window.pairShareCapture.
  function recorderSource(api, options = {}) {
    let off = [];
    const unsubscribe = () => { for (const fn of off) { try { fn?.(); } catch {} } off = []; };
    return {
      kind: 'recorder',
      async start(handlers) {
        off = [api.onConfig(handlers.onConfig), api.onFrame(handlers.onFrame), api.onError(message => handlers.onError(new Error(message))), api.onEnd(handlers.onEnd)];
        let started;
        try { started = await api.start(options); } catch (error) { unsubscribe(); throw error; }
        if (!started || started.error) { unsubscribe(); throw new Error(started?.error || 'The screen recorder did not start'); }
        return { encoder: started.encoder || 'GPU', hardware: true, width: started.width, height: started.height, fps: started.fps, bitrateKbps: started.bitrateKbps, keepsUp: true };
      },
      async stop() { unsubscribe(); try { await api.stop(); } catch {} },
    };
  }

  // The browser's own capture (a video track from the screen picker), encoded in the page with WebCodecs. The bitrate is given for AV1
  // (av1Kbps) and scaled for the codec the computer ends up using: H.264 and VP9 need more bits for the same picture. Left out, the
  // encoder uses the rate it recommends for the picture size.
  function pageSource({ Encoder = required('KnotShareEncoder', './share-encoder'), track, width, height, fps = 60, av1Kbps = 0, prefer = '', contentHint = '', choice = null } = {}) {
    let encoder = null, onEnded = null;
    return {
      kind: 'page',
      async start(handlers) {
        if (!track) throw new Error('There is no screen picture to share');
        const picked = choice || await Encoder.choose({ width, height, fps, prefer, bitrateKbps: av1Kbps > 0 ? av1Kbps : undefined });
        if (!picked.choice) throw new Error('This computer cannot encode video');
        const codec = picked.choice.codec, bitrateKbps = av1Kbps > 0 ? Math.round(av1Kbps * (Encoder.EFFICIENCY?.[codec] || 1)) : undefined;
        encoder = Encoder.create({ track, width, height, fps, bitrateKbps, contentHint, choice: picked.choice, onConfig: handlers.onConfig, onFrame: handlers.onFrame, onError: handlers.onError });
        onEnded = () => handlers.onEnd(); track.addEventListener?.('ended', onEnded);
        encoder.start().catch(error => handlers.onError(error));
        return { encoder: (picked.choice.hardware ? 'hardware ' : 'software ') + codec.toUpperCase(), hardware: !!picked.choice.hardware, codec, bitrateKbps: bitrateKbps || 0, keepsUp: picked.keepsUp, sustainedFps: picked.sustainedFps, tried: picked.tried };
      },
      stats() { return encoder ? encoder.stats() : null; },
      async stop() { if (onEnded) { try { track.removeEventListener?.('ended', onEnded); } catch {} } await encoder?.stop(); },
    };
  }

  // ------------------------------------------------------------------------------------------------------------ sharing
  function createShareSender({ shareId = newShareId(), source, lanes = null, sendControl, openDataChannel, announce = () => {}, reannounceMs = REANNOUNCE_MS, onConfig = () => {}, onViewerLost = () => {}, onError = () => {}, onEnd = () => {}, log = () => {}, hostOptions = {}, Session = defaults().Session } = {}) {
    if (!source || typeof sendControl !== 'function' || typeof openDataChannel !== 'function') throw new Error('a share needs a source, sendControl and openDataChannel');
    let host = null, stopped = false, starting = null, lastConfig = null, announceTimer = null;
    const handlers = {
      onConfig(config) {
        if (stopped) return;
        lastConfig = config;
        if (!host) { host = new Session.ShareHost({ shareId, config, sendControl, openDataChannel, lanes, log, onViewerLost, ...hostOptions }); try { announce(host.offer()); } catch {}
          if (reannounceMs > 0) announceTimer = setInterval(() => { if (host && !stopped) { try { announce(host.offer()); } catch {} } }, reannounceMs); }
        else host.setConfig(config);
        try { onConfig(config); } catch {}
      },
      onFrame(frame) { host?.pushFrame(frame); },
      onError(error) { if (!stopped) onError(error); },
      onEnd() { if (!stopped) onEnd(); },
    };
    return {
      shareId,
      // Resolves with what the source reports about itself (which encoder, whether it keeps up) once it is running.
      start() { return starting || (starting = source.start(handlers)); },
      get config() { return lastConfig; },
      // The announcement every friend who may watch gets; null until the first picture has described the stream.
      offer() { return host && !stopped ? host.offer() : null; },
      onControl(viewerId, message) {
        if (!host || !message || message.shareId !== shareId) return;
        // After stop() nobody new may join, but the viewers' acknowledgements are what let the last records be delivered.
        if (message.t === 'share-watch') { if (!stopped) host.addViewer(viewerId, { udx: !!message.caps?.udx }); }
        else host.onControl(viewerId, message);
      },
      removeViewer(viewerId) { host?.removeViewer(viewerId); },
      hasViewers() { return !!host && host.viewers.size > 0; },
      stats() { return host ? { ...host.stats(), source: source.kind, capture: source.stats?.() || null } : null; },
      // Everything already captured is still delivered (up to drainMs); then the end.
      async stop({ drainMs = END_DRAIN_MS } = {}) {
        if (stopped) return; stopped = true; clearInterval(announceTimer); announceTimer = null;
        try { await source.stop(); } catch (error) { log('stopping the capture failed: ' + (error?.message || error)); }
        if (host) { host.end(); if (drainMs > 0) await host.whenDrained(drainMs); host.destroy(); }
      },
    };
  }

  // ------------------------------------------------------------------------------------------------------------ watching
  function createShareWatcher({ shareId, surface, getDisplaySize, lanes = null, sendControl, onState = () => {}, onEnded = () => {}, onError = () => {}, onGap = () => {}, log = () => {}, preferSoftware = false, playoutOptions = {}, now = () => performance.now(), endQuietMs = END_QUIET_MS, endPlayoutMs = END_PLAYOUT_MS, Session, Player } = {}) {
    const engine = { ...defaults(), ...(Session ? { Session } : {}), ...(Player ? { Player } : {}) };
    let sample = null, rates = { receivedFps: 0, shownFps: 0, mbps: 0 };
    let finished = false, recordEnded = false, playerEnded = false, endTimer = null, hostEnded = false, hostEndedAt = 0, recordEndedAt = 0, stopped = false;
    const finish = () => { if (finished) return; finished = true; clearInterval(endTimer); endTimer = null; try { onEnded(); } catch {} };
    // Over when the end record has arrived and the player has shown everything before it, in whichever order those two happen.
    const settle = () => { if (recordEnded && playerEnded) finish(); };
    const player = engine.Player.createSharePlayer({
      surface, getDisplaySize, preferSoftware, playoutOptions, onError,
      onState: state => { try { onState(state); } catch {} if (state.state === 'ended') { playerEnded = true; settle(); } },
    });
    const viewer = new engine.Session.ShareViewer({ shareId, sendControl, player, lanes, log, onGap, onEnded: () => { recordEnded = true; recordEndedAt = now(); armEnd(); settle(); } });
    // The share ends for the viewer when everything it was sent has been shown. Two things can keep that from happening and neither may
    // leave the share hanging: the sharer went away before its last records were delivered, or a stalled link keeps the rest from ever arriving.
    function armEnd() {
      if (endTimer || finished || stopped) return;
      endTimer = setInterval(() => {
        const t = now(), seen = player.read();
        if (recordEnded && t - recordEndedAt > endPlayoutMs) finish();
        else if (hostEnded && !recordEnded && t - Math.max(hostEndedAt, seen.lastPacketAt || 0, seen.lastLiveAt || 0) > endQuietMs) finish();
      }, Math.max(20, Math.min(500, endQuietMs / 4)));
    }
    return {
      shareId, player, viewer,
      watch() { viewer.watch(); },
      onControl(message) {
        if (stopped) return;
        viewer.onControl(message);
        if (message?.t === 'share-end' && message.shareId === shareId) { hostEnded = true; hostEndedAt = now(); armEnd(); }
      },
      attachDataChannel(channel) { viewer.attachDataChannel(channel); },
      setActive(value) { player.setActive(value); },
      // The delay the picture is being shown behind live: the sound is held back by the same amount.
      get delayMs() { return player.stats().delayMs || 0; },
      // The status line for this share. Rates are measured over the last second or more, so call it as often as you like.
      readout({ label = 'Friend sharing', config = null } = {}) {
        const t = now(), p = player.stats(), v = viewer.stats(), seen = player.read();
        if (!sample || t - sample.t >= 1000) {
          if (sample) { const seconds = (t - sample.t) / 1000; rates = { receivedFps: (p.received - sample.received) / seconds, shownFps: (p.painted - sample.painted) / seconds, mbps: (v.bytes - sample.bytes) * 8 / seconds / 1e6 }; }
          sample = { t, received: p.received, painted: p.painted, bytes: v.bytes };
        }
        const lastHeard = Math.max(seen.lastPacketAt || 0, seen.lastLiveAt || 0), quietMs = lastHeard ? t - lastHeard : 0;
        return describeShare({ label, config, ...rates, software: p.decoder === 'software', buffering: p.buffering === true, quietMs, stillScreen: (seen.lastLiveAt || 0) > (seen.lastPacketAt || 0) });
      },
      stats() { return { viewer: viewer.stats(), player: player.stats() }; },
      read() { return player.read(); },
      stop({ notify = true } = {}) {
        if (stopped) return; stopped = true; clearInterval(endTimer); endTimer = null;
        try { viewer.stop({ notify }); } catch {}
        try { player.destroy(); } catch {}
      },
    };
  }

  // ------------------------------------------------------------------------------------------------------------ what the viewer is told
  const codecName = codec => { const text = String(codec || '').toLowerCase(); return text.startsWith('av01') ? 'AV1' : text.startsWith('avc1') ? 'H.264' : text.startsWith('vp09') ? 'VP9' : text.startsWith('hvc1') || text.startsWith('hev1') ? 'HEVC' : String(codec || 'video'); };
  // The line under a friend's share: what arrives, what is shown, what decodes it, and, when something is wrong, whose end it is on. A still
  // screen sends no pictures, so "0 fps" with heartbeats arriving is a quiet screen, not a problem.
  function describeShare({ label = 'Friend sharing', config = null, receivedFps = 0, shownFps = 0, mbps = 0, software = false, buffering = false, quietMs = 0, stillScreen = false } = {}) {
    const parts = [label], height = Number(config?.height) || 0;
    if (height) parts.push(height + 'p');
    parts.push(stillScreen && receivedFps < 1 ? 'still screen' : Math.round(receivedFps) + ' fps');
    if (mbps > 0.05) parts.push(mbps.toFixed(mbps < 10 ? 1 : 0) + ' Mbps');
    parts.push(codecName(config?.codec) + ' on ' + (software ? 'CPU' : 'GPU'));
    if (quietMs > 1500) parts.push('nothing arriving from your friend’s connection');
    else if (buffering) parts.push('buffering');
    else if (receivedFps >= 5 && shownFps < receivedFps * 0.6) parts.push('only ' + Math.round(shownFps) + ' fps shown · this computer is falling behind');
    return parts.join(' · ');
  }

  // ------------------------------------------------------------------------------------------------------------ sound
  // The picture is shown a little behind the newest picture that arrived; the sound travels another way and would run ahead of it.
  // Holding it back by the same amount keeps lips and clicks together. Applied to the audio receivers' jitter buffer (the browser
  // time-stretches to reach it), never below the floor that stops screen sound choking, never above what the browser allows.
  function audioTargetMs(videoDelayMs) { return Math.max(AUDIO_MIN_MS, Math.min(AUDIO_MAX_MS, Math.round((Number(videoDelayMs) || 0) + AUDIO_MARGIN_MS))); }
  function createAudioAlign({ getReceivers, getDelayMs, setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = handle => clearInterval(handle), everyMs = 1000 } = {}) {
    const applied = new WeakMap();
    let timer = null, last = AUDIO_MIN_MS;
    function apply() {
      const target = audioTargetMs(getDelayMs());
      for (const receiver of getReceivers() || []) {
        if (!receiver || !('jitterBufferTarget' in receiver)) continue;
        const before = applied.get(receiver);
        if (before !== undefined && Math.abs(before - target) < AUDIO_STEP_MS) continue;
        try { receiver.jitterBufferTarget = target; applied.set(receiver, target); } catch {}
      }
      last = target; return target;
    }
    return { apply, start() { if (!timer) { apply(); timer = setTimer(apply, everyMs); } }, stop() { if (timer) clearTimer(timer); timer = null; }, get targetMs() { return last; } };
  }

  return { createShareSender, createShareWatcher, createAudioAlign, recorderSource, pageSource, audioTargetMs, describeShare, codecName, newShareId, REANNOUNCE_MS, END_DRAIN_MS, END_QUIET_MS, END_PLAYOUT_MS, AUDIO_MIN_MS, AUDIO_MAX_MS };
});
