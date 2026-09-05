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
  const MAX_NATIVE_SHARE_MBPS = 250;
  const MAX_HARDWARE_WEBRTC_SHARE_MBPS = 80;
  const MAX_SLIDER_MBPS = 250;
  const PROBE_WINDOW_MS = 800;
  const PROBE_MIN_BYTES = 2 * 1024 * 1024;
  const PROBE_MAX_BYTES = 96 * 1024 * 1024;
  const PROBE_STREAMS = 8;
  const PROBE_STREAM_BYTES = 50 * 1024 * 1024;

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
    if (Number.isFinite(cap) && cap >= 20) return 96000;
    if (Number.isFinite(cap) && cap >= 8) return 64000;
    return 48000;
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
  const SHARE_BUDGET_LOWER_RATIO = 0.88;
  const SHARE_BUDGET_RAISE_RATIO = 1.12;
  const SHARE_BUDGET_RAISE_HOLD_MS = 15000;
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

  function normalizeNetBudget(value) {
    if (!value || typeof value !== 'object') return null;
    const download = Number(value.downloadMbps), upload = Number(value.uploadMbps), live = Number(value.liveMbps), at = Number(value.at);
    const budget = {};
    if (Number.isFinite(download) && download > 0 && download <= 10000) budget.downloadMbps = Math.round(download * 100) / 100;
    if (Number.isFinite(upload) && upload > 0 && upload <= 10000) budget.uploadMbps = Math.round(upload * 100) / 100;
    if (Number.isFinite(live) && live > 0 && live <= 10000) budget.liveMbps = Math.round(live * 100) / 100;
    if (!budget.downloadMbps && !budget.uploadMbps && !budget.liveMbps) {
      if (value.congested !== false) return null;
      budget.congested = false;
      budget.at = Number.isFinite(at) && at > 0 ? at : 0;
      return budget;
    }
    budget.congested = value.congested === true;
    budget.at = Number.isFinite(at) && at > 0 ? at : 0;
    return budget;
  }

  function nextShareBudgetMbps(currentMbps, { senderMbps, viewerMbps, congested = false } = {}) {
    const sender = Number(senderMbps);
    const senderCap = Number.isFinite(sender) && sender > 0 ? sender : Infinity;
    const viewer = Number(viewerMbps);
    const viewerCap = Number.isFinite(viewer) && viewer > 0 ? viewer : Infinity;
    const probed = Math.min(senderCap, viewerCap);
    const current = Number(currentMbps);
    const floor = 0.35;
    if (congested) {
      const drop = Number.isFinite(current) && current > 0 ? current * SHARE_BUDGET_LOWER_RATIO : probed;
      const cap = Number.isFinite(probed) ? Math.min(probed, drop) : drop;
      return Math.max(floor, Number.isFinite(cap) ? cap : floor);
    }
    // Stay on the advertised min path. Climbing past a 50 Mbps friend because
    // the sender is healthy would flood them before loss shows up.
    if (Number.isFinite(probed)) return Math.max(floor, probed);
    if (Number.isFinite(senderCap)) return Math.max(floor, senderCap);
    if (Number.isFinite(current) && current > 0) return Math.max(floor, current);
    return floor;
  }

  function shouldAdoptShareBudget(currentMbps, nextMbps, { lastChangeAt = 0, now = Date.now(), raisingHoldMs = SHARE_BUDGET_RAISE_HOLD_MS } = {}) {
    const next = Number(nextMbps);
    if (!Number.isFinite(next) || next <= 0) return false;
    const current = Number(currentMbps);
    if (!Number.isFinite(current) || current <= 0) return true;
    if (next <= current * SHARE_BUDGET_LOWER_RATIO) return true;
    if (next < current) return false;
    if (next >= current * SHARE_BUDGET_RAISE_RATIO && now - Number(lastChangeAt || 0) >= raisingHoldMs) return true;
    return false;
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
    const https = require('https');
    return new https.Agent({ keepAlive: true, maxSockets: PROBE_STREAMS, maxFreeSockets: PROBE_STREAMS });
  }

  function probeHeaders() {
    return { 'user-agent': 'Mozilla/5.0 KnotNetworkProbe', 'cache-control': 'no-store' };
  }

  async function warmup(agent) {
    const https = require('https');
    await new Promise(resolve => {
      const request = https.get(DOWN_URL + 262144, { agent, headers: probeHeaders() }, response => {
        response.resume();
        response.on('end', resolve);
      });
      request.on('error', () => resolve());
      setTimeout(() => { try { request.destroy(); } catch {} resolve(); }, 4000);
    });
  }

  async function warmupUpload(agent) {
    const https = require('https');
    await new Promise(resolve => {
      const body = Buffer.alloc(65536, 7);
      const request = https.request(UP_URL, {
        method: 'POST',
        agent,
        headers: { ...probeHeaders(), 'content-type': 'application/octet-stream', 'content-length': String(body.length) },
      }, response => {
        response.resume();
        response.on('end', resolve);
      });
      request.on('error', () => resolve());
      request.end(body);
      setTimeout(() => { try { request.destroy(); } catch {} resolve(); }, 4000);
    });
  }

  async function measureDownloadWindow(agent) {
    const https = require('https');
    const requests = [];
    let bytes = 0, origin = 0, bytesAtOrigin = 0, stopped = false;
    const windowBytes = () => Math.max(0, bytes - bytesAtOrigin);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const request of requests) try { request.destroy(); } catch {}
    };
    const jobs = Array.from({ length: PROBE_STREAMS }, () => new Promise(resolve => {
      const request = https.get(DOWN_URL + PROBE_STREAM_BYTES, { agent, headers: probeHeaders() }, response => {
        if ((response.statusCode || 0) >= 400) { response.resume(); resolve(); return; }
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
    const https = require('https');
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
      const request = https.request(UP_URL, {
        method: 'POST',
        agent,
        headers: {
          ...probeHeaders(),
          'content-type': 'application/octet-stream',
          'content-length': String(PROBE_STREAM_BYTES),
        },
      }, response => {
        response.resume();
        response.on('end', resolve);
        response.on('error', () => resolve());
      });
      request.on('error', () => resolve());
      requests.push(request);
      const write = () => {
        if (stopped) return;
        while (!stopped) {
          if (!request.write(chunk)) {
            request.once('drain', write);
            return;
          }
          const sent = sentBytes();
          if (!origin && sent >= 256 * 1024) { origin = nowMs(); bytesAtOrigin = sent; }
          if (origin && shouldStopProbe(nowMs() - origin, windowBytes())) {
            stop();
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

  async function measureCapacity() {
    if (typeof require !== 'function') return null;
    abortCapacityProbe();
    const downAgent = nodeAgent(), upAgent = nodeAgent();
    let aborted = false;
    const abort = () => {
      aborted = true;
      try { downAgent.destroy(); } catch {}
      try { upAgent.destroy(); } catch {}
    };
    activeProbeAbort = abort;
    try {
      await Promise.all([warmup(downAgent), warmupUpload(upAgent)]);
      if (aborted) return null;
      const downloadMbps = await measureDirection('down', downAgent);
      if (aborted) return null;
      const uploadMbps = await measureDirection('up', upAgent);
      if (aborted || !(downloadMbps > 0) || !(uploadMbps > 0)) return null;
      return {
        uploadMbps: Math.round(uploadMbps * 100) / 100,
        downloadMbps: Math.round(downloadMbps * 100) / 100,
        probeVersion: PROBE_VERSION,
        at: Date.now(),
      };
    } catch {
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
    encoderShareCapMbps,
    viewerReceiveCapMbps,
    minViewerReceiveCapMbps,
    normalizeNetBudget,
    nextShareBudgetMbps,
    shouldAdoptShareBudget,
    SHARE_BUDGET_LOWER_RATIO,
    SHARE_BUDGET_RAISE_RATIO,
    SHARE_BUDGET_RAISE_HOLD_MS,
    SHARE_BUDGET_INTERVAL_MS,
    cachedCapacityFresh,
    shouldStopProbe,
    abortCapacityProbe,
    PROBE_WINDOW_MS,
    PROBE_MIN_BYTES,
    PROBE_MAX_BYTES,
    measureCapacity,
  };
});
