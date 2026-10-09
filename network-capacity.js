(function installNetworkCapacity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotNetworkCapacity = api;
})(typeof window === 'object' ? window : null, () => {
  const DOWN_URL = 'https://speed.cloudflare.com/__down?bytes=';
  const UP_URL = 'https://speed.cloudflare.com/__up';
  const TIMEOUT_MS = 12000;
  const CACHE_MS = 6 * 60 * 60 * 1000;
  const PROBE_VERSION = 2;
  const MAX_NATIVE_SHARE_MBPS = 200;
  const MAX_HARDWARE_WEBRTC_SHARE_MBPS = 80;
  const MAX_SLIDER_MBPS = 200;
  const PROBE_WINDOW_MS = 800;
  const PROBE_MIN_BYTES = 2 * 1024 * 1024;
  const PROBE_MAX_BYTES = 96 * 1024 * 1024;
  const PROBE_STREAMS = 8;
  const PROBE_STREAM_BYTES = 50 * 1024 * 1024;
  // The speed test goes to speed.cloudflare.com, which refuses a computer that asks too often (HTTP 429, "retry in 54 minutes"; seen on the machine this
  // was written on after many launches, and after every share was stopped while no result had been kept). A refused or failed test is not repeated for a
  // while, so it neither hammers the endpoint nor spends time and bandwidth on a test that cannot work.
  const REFUSED_BACKOFF_MS = 10 * 60 * 1000;     // refused without being told when to come back
  const MAX_BACKOFF_MS = 60 * 60 * 1000;          // however long the endpoint asks to be left alone for
  const FAILURE_BACKOFF_MS = 2 * 60 * 1000;       // no answer at all (offline, a timeout)
  let probeUrls = { down: DOWN_URL, up: UP_URL };
  let blockedUntil = 0, refusal = null;
  const wallMs = () => Date.now();
  const transportFor = url => (String(url).startsWith('http://') ? require('http') : require('https'));
  // An answer that says "not now": remembered, with how long the endpoint asked for.
  function noteRefusal(response) {
    const status = Number(response?.statusCode) || 0;
    if (status < 400) return false;
    const retry = Number(response.headers?.['retry-after']);
    refusal = { status, retryAfterMs: Number.isFinite(retry) && retry > 0 ? Math.min(MAX_BACKOFF_MS, retry * 1000) : REFUSED_BACKOFF_MS };
    return true;
  }

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  function nowMs() {
    return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now();
  }

  function mbpsFrom(bytes, elapsedMs) {
    const elapsed = Math.max(1, Number(elapsedMs) || 1);
    return (Math.max(0, Number(bytes) || 0) * 8) / elapsed / 1000;
  }

  function effectiveUploadCapMbps(probeMbps, liveMbps) {
    const probe = Number(probeMbps), live = Number(liveMbps);
    const usableProbe = Number.isFinite(probe) && probe > 0 ? Math.max(1.5, probe * 0.75 - 0.5) : Infinity;
    const usableLive = Number.isFinite(live) && live > 0 ? Math.max(1.5, live * 0.92) : Infinity;
    return Math.min(usableProbe, usableLive);
  }

  function voiceBitrateBps({ relay = false, uploadMbps } = {}) {
    if (relay) return 24000;
    const cap = effectiveUploadCapMbps(uploadMbps, Infinity);
    if (Number.isFinite(cap) && cap >= 20) return 128000;
    if (Number.isFinite(cap) && cap >= 8) return 96000;
    return 64000;
  }

  function preferAudioRed(uploadMbps) {
    const cap = effectiveUploadCapMbps(uploadMbps, Infinity);
    return Number.isFinite(cap) ? cap >= 8 : true;
  }

  function recommendShareBudgetMbps(uploadMbps, explicitCeiling) {
    const cap = effectiveUploadCapMbps(uploadMbps, Infinity);
    const slider = clamp(explicitCeiling, 2, MAX_SLIDER_MBPS);
    if (!Number.isFinite(cap)) return slider;
    return Math.min(MAX_NATIVE_SHARE_MBPS, Math.max(2, Math.min(slider, cap)));
  }

  function autoShareCeilingMbps(uploadMbps, { explicit = false, slider = 20 } = {}) {
    const cap = effectiveUploadCapMbps(uploadMbps, Infinity);
    if (explicit) return recommendShareBudgetMbps(uploadMbps, slider);
    if (!Number.isFinite(cap)) return clamp(slider, 2, MAX_SLIDER_MBPS);
    if (cap > 20) return Math.min(MAX_NATIVE_SHARE_MBPS, cap);
    return Math.min(20, Math.max(2, cap));
  }

  // Settings slider ceiling. 200 Mbps is the GPU/encoder max; a measured
  // 40 Mbps path only offers the derated safe rate (~30 Mbps), not 200.
  function sliderBitrateMaxMbps(uploadMbps, downloadMbps) {
    const up = effectiveUploadCapMbps(uploadMbps, Infinity);
    const down = effectiveUploadCapMbps(downloadMbps, Infinity);
    const path = Math.min(up, down);
    if (!Number.isFinite(path) || path <= 0) return MAX_SLIDER_MBPS;
    return Math.max(2, Math.min(MAX_SLIDER_MBPS, Math.round(path)));
  }

  function encoderShareCapMbps({ native = false, hardware = false, width = 1920, height = 1080, fps = 60 } = {}) {
    const w = Number(width) > 0 ? Number(width) : 1920;
    const h = Number(height) > 0 ? Number(height) : 1080;
    const f = Number(fps) === 30 ? 30 : 60;
    const pixelsPerSecond = w * h * f;
    if (native) return Math.min(MAX_NATIVE_SHARE_MBPS, Math.max(16, pixelsPerSecond * 0.50 / 1e6));
    if (hardware) return Math.min(MAX_HARDWARE_WEBRTC_SHARE_MBPS, Math.max(12, pixelsPerSecond * 0.16 / 1e6));
    return 20;
  }

  // Same derate as upload: a 50 Mbps advertised path is treated as ~37 Mbps so
  // voice, ACKs, and TCP burst stay out of the way. Missing numbers stay open.
  const SHARE_BUDGET_INTERVAL_MS = 20000;

  function viewerReceiveCapMbps(downloadMbps, liveMbps) {
    return effectiveUploadCapMbps(downloadMbps, liveMbps);
  }

  function minViewerReceiveCapMbps(viewers) {
    let min = Infinity;
    if (viewers == null) return Infinity;
    const list = Array.isArray(viewers) ? viewers : typeof viewers[Symbol.iterator] === 'function' ? [...viewers] : [viewers];
    for (const viewer of list) {
      if (viewer == null) continue;
      const download = Number(viewer.downloadMbps ?? viewer);
      const live = Number(viewer.liveMbps);
      const cap = viewerReceiveCapMbps(
        Number.isFinite(download) && download > 0 ? download : Infinity,
        Number.isFinite(live) && live > 0 ? live : Infinity
      );
      if (Number.isFinite(cap)) min = Math.min(min, cap);
    }
    return min;
  }

  const DECODE_CODECS = ['AV1', 'H264', 'VP9', 'VP8'];

  // Codecs the viewer decodes on its GPU. A viewer without hardware decode
  // (NVIDIA Linux since 1.1.118) cannot keep up with a GPU-sized share
  // bitrate, so senders hold such viewers to the conservative curve.
  function normalizeHardwareDecode(value) {
    if (!Array.isArray(value)) return null;
    return DECODE_CODECS.filter(codec => value.includes(codec));
  }

  function viewerDecodesInSoftware(budget, codec) {
    const hardware = normalizeHardwareDecode(budget?.hwDecode);
    return !!hardware && !hardware.includes(String(codec || '').toUpperCase());
  }

  function normalizeNetBudget(value) {
    if (!value || typeof value !== 'object') return null;
    const download = Number(value.downloadMbps), upload = Number(value.uploadMbps), live = Number(value.liveMbps), at = Number(value.at);
    const budget = {}, hwDecode = normalizeHardwareDecode(value.hwDecode);
    if (Number.isFinite(download) && download > 0 && download <= 10000) budget.downloadMbps = Math.round(download * 100) / 100;
    if (Number.isFinite(upload) && upload > 0 && upload <= 10000) budget.uploadMbps = Math.round(upload * 100) / 100;
    if (Number.isFinite(live) && live > 0 && live <= 10000) budget.liveMbps = Math.round(live * 100) / 100;
    if (hwDecode) budget.hwDecode = hwDecode;
    if (!budget.downloadMbps && !budget.uploadMbps && !budget.liveMbps) {
      if (value.congested === false) budget.congested = false;
      else if (!hwDecode) return null;
      budget.at = Number.isFinite(at) && at > 0 ? at : 0;
      return budget;
    }
    budget.congested = value.congested === true;
    budget.at = Number.isFinite(at) && at > 0 ? at : 0;
    return budget;
  }

  function cachedCapacityFresh(value, now = Date.now()) {
    const upload = Number(value?.uploadMbps), download = Number(value?.downloadMbps), at = Number(value?.at);
    return Number(value?.probeVersion) === PROBE_VERSION && Number.isFinite(upload) && upload > 0 && Number.isFinite(download) && download > 0 && Number.isFinite(at) && now - at >= 0 && now - at < CACHE_MS;
  }

  function shouldStopProbe(elapsedMs, bytes) {
    const elapsed = Number(elapsedMs) || 0, total = Math.max(0, Number(bytes) || 0);
    if (total >= PROBE_MAX_BYTES) return true;
    if (elapsed >= TIMEOUT_MS) return true;
    if (elapsed >= PROBE_WINDOW_MS && total >= PROBE_MIN_BYTES) return true;
    return false;
  }

  function nodeAgent() {
    const lib = transportFor(probeUrls.down);
    return new lib.Agent({ keepAlive: true, maxSockets: PROBE_STREAMS, maxFreeSockets: PROBE_STREAMS });
  }

  function probeHeaders() {
    return { 'user-agent': 'Mozilla/5.0 KnotNetworkProbe', 'cache-control': 'no-store' };
  }

  async function warmup(agent) {
    const https = transportFor(probeUrls.down);
    await new Promise(resolve => {
      const request = https.get(probeUrls.down + 262144, { agent, headers: probeHeaders() }, response => {
        noteRefusal(response);
        response.resume();
        response.on('end', resolve);
      });
      request.on('error', () => resolve());
      setTimeout(() => { try { request.destroy(); } catch {} resolve(); }, 4000);
    });
  }

  async function warmupUpload(agent) {
    const https = transportFor(probeUrls.up);
    await new Promise(resolve => {
      const body = Buffer.alloc(65536, 7);
      const request = https.request(probeUrls.up, {
        method: 'POST',
        agent,
        headers: { ...probeHeaders(), 'content-type': 'application/octet-stream', 'content-length': String(body.length) },
      }, response => {
        noteRefusal(response);
        response.resume();
        response.on('end', resolve);
      });
      request.on('error', () => resolve());
      request.end(body);
      setTimeout(() => { try { request.destroy(); } catch {} resolve(); }, 4000);
    });
  }

  async function measureDownloadWindow(agent) {
    const https = transportFor(probeUrls.down);
    const requests = [];
    let bytes = 0, origin = 0, bytesAtOrigin = 0, stopped = false;
    const windowBytes = () => Math.max(0, bytes - bytesAtOrigin);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const request of requests) try { request.destroy(); } catch {}
    };
    const jobs = Array.from({ length: PROBE_STREAMS }, () => new Promise(resolve => {
      const request = https.get(probeUrls.down + PROBE_STREAM_BYTES, { agent, headers: probeHeaders() }, response => {
        if (noteRefusal(response)) { response.resume(); resolve(); return; }
        response.on('data', chunk => {
          bytes += chunk.length;
          if (!origin && bytes >= 256 * 1024) { origin = nowMs(); bytesAtOrigin = bytes; }
          if (origin && shouldStopProbe(nowMs() - origin, windowBytes())) stop();
        });
        response.on('end', resolve);
        response.on('error', () => resolve());
      });
      request.on('error', () => resolve());
      requests.push(request);
    }));
    const timer = setTimeout(stop, TIMEOUT_MS);
    await Promise.race([Promise.all(jobs), new Promise(resolve => setTimeout(resolve, TIMEOUT_MS + 400))]);
    clearTimeout(timer);
    if (!origin || windowBytes() <= 0) return 0;
    return mbpsFrom(windowBytes(), Math.max(1, nowMs() - origin));
  }

  async function measureUploadWindow(agent) {
    const https = transportFor(probeUrls.up);
    const chunk = Buffer.alloc(256 * 1024, 7);
    const requests = [];
    let origin = 0, bytesAtOrigin = 0, stopped = false, captured = 0;
    const sentBytes = () => requests.reduce((sum, request) => sum + Math.max(0, Number(request.socket?.bytesWritten) || 0), 0);
    const windowBytes = () => Math.max(0, sentBytes() - bytesAtOrigin);
    const stop = () => {
      if (stopped) return;
      captured = windowBytes();
      stopped = true;
      for (const request of requests) try { request.destroy(); } catch {}
    };
    const jobs = Array.from({ length: PROBE_STREAMS }, () => new Promise(resolve => {
      const request = https.request(probeUrls.up, {
        method: 'POST',
        agent,
        headers: {
          ...probeHeaders(),
          'content-type': 'application/octet-stream',
          'content-length': String(PROBE_STREAM_BYTES),
        },
      }, response => {
        noteRefusal(response);
        response.resume();
        response.on('end', resolve);
        response.on('error', () => resolve());
      });
      request.on('error', () => resolve());
      requests.push(request);
      const write = () => {
        if (stopped) return;
        // A few chunks, then back to the event loop (a loop that never yields never sees the socket's byte count move: it is only updated between turns).
        // Progress is looked at after EVERY write, not only after one that reports room: a 256 KB chunk is bigger than a stream's buffer, so write() answers
        // "full" every time, and a window that opened only on "room" never opened. The speed test then measured nothing, on any link.
        for (let batch = 0; !stopped; batch++) {
          if (batch >= 8) { setImmediate(write); return; }
          const room = request.write(chunk);
          const sent = sentBytes();
          if (!origin && sent >= 256 * 1024) { origin = nowMs(); bytesAtOrigin = sent; }
          if (origin && shouldStopProbe(nowMs() - origin, windowBytes())) {
            stop();
            return;
          }
          if (!room) {
            request.once('drain', write);
            return;
          }
        }
      };
      if (request.socket) write();
      else request.on('socket', write);
    }));
    const timer = setTimeout(stop, TIMEOUT_MS);
    await Promise.race([Promise.all(jobs), new Promise(resolve => setTimeout(resolve, TIMEOUT_MS + 400))]);
    clearTimeout(timer);
    if (!stopped) stop();
    if (!origin || captured <= 0) return 0;
    return mbpsFrom(captured, Math.max(1, nowMs() - origin));
  }

  async function measureDirection(kind, agent) {
    return kind === 'up' ? measureUploadWindow(agent) : measureDownloadWindow(agent);
  }

  let activeProbeAbort = null;

  function abortCapacityProbe() {
    const abort = activeProbeAbort;
    activeProbeAbort = null;
    if (typeof abort === 'function') abort();
  }

  // `downUrl` / `upUrl` are for tests (a local server); a result is { uploadMbps, downloadMbps, ... } or null, and a null is remembered for a while.
  async function measureCapacity({ downUrl = DOWN_URL, upUrl = UP_URL } = {}) {
    if (typeof require !== 'function') return null;
    if (wallMs() < blockedUntil) return null;
    abortCapacityProbe();
    probeUrls = { down: downUrl, up: upUrl }; refusal = null;
    const downAgent = nodeAgent(), upAgent = nodeAgent();
    let aborted = false;
    const abort = () => {
      aborted = true;
      try { downAgent.destroy(); } catch {}
      try { upAgent.destroy(); } catch {}
    };
    activeProbeAbort = abort;
    const refused = () => { blockedUntil = wallMs() + refusal.retryAfterMs; return null; };
    try {
      await Promise.all([warmup(downAgent), warmupUpload(upAgent)]);
      if (aborted) return null;
      if (refusal) return refused();                 // told to go away: do not open eight more connections
      const downloadMbps = await measureDirection('down', downAgent);
      if (aborted) return null;
      if (refusal) return refused();
      const uploadMbps = await measureDirection('up', upAgent);
      if (aborted) return null;
      if (!(downloadMbps > 0) || !(uploadMbps > 0)) { if (refusal) return refused(); blockedUntil = wallMs() + FAILURE_BACKOFF_MS; return null; }
      blockedUntil = 0;
      return {
        uploadMbps: Math.round(uploadMbps * 100) / 100,
        downloadMbps: Math.round(downloadMbps * 100) / 100,
        probeVersion: PROBE_VERSION,
        at: Date.now(),
      };
    } catch {
      blockedUntil = wallMs() + FAILURE_BACKOFF_MS;
      return null;
    } finally {
      if (activeProbeAbort === abort) activeProbeAbort = null;
      try { downAgent.destroy(); } catch {}
      try { upAgent.destroy(); } catch {}
    }
  }

  return {
    DOWN_BYTES: 2_000_000,
    UP_BYTES: 1_500_000,
    CACHE_MS,
    PROBE_VERSION,
    MAX_NATIVE_SHARE_MBPS,
    MAX_HARDWARE_WEBRTC_SHARE_MBPS,
    MAX_SLIDER_MBPS,
    clamp,
    mbpsFrom,
    effectiveUploadCapMbps,
    voiceBitrateBps,
    preferAudioRed,
    recommendShareBudgetMbps,
    autoShareCeilingMbps,
    sliderBitrateMaxMbps,
    encoderShareCapMbps,
    viewerReceiveCapMbps,
    minViewerReceiveCapMbps,
    normalizeNetBudget,
    viewerDecodesInSoftware,
    SHARE_BUDGET_INTERVAL_MS,
    cachedCapacityFresh,
    shouldStopProbe,
    abortCapacityProbe,
    PROBE_WINDOW_MS,
    PROBE_MIN_BYTES,
    PROBE_MAX_BYTES,
    measureCapacity,
    probeBlockedUntil: () => blockedUntil,
    resetProbeBackoff: () => { blockedUntil = 0; refusal = null; },
  };
});
