/* Shared non-UI helpers for Pair (renderer + Node tests). */
(function (root) {
  'use strict';

  const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  const MAX_SIGNAL_SDP = 256 * 1024;
  const MAX_SIGNAL_PUB = 8192;
  const SIGNAL_KINDS = new Set([
    'offer', 'answer', 'reneg-offer', 'reneg-answer'
  ]);

  function mergeIceServers(defaults, custom) {
    const base = Array.isArray(defaults) ? defaults.slice() : DEFAULT_ICE_SERVERS.slice();
    if (!Array.isArray(custom) || !custom.length) return base;
    const seen = new Set(base.map(s => JSON.stringify(s)));
    for (const item of custom) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        base.push(item);
      }
    }
    return base;
  }

  function turnServersFromConfig(raw) {
    try {
      const config = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
      if (!Array.isArray(config)) return [];
      return config.slice(0, 8).flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const urls = (Array.isArray(item.urls) ? item.urls : [item.urls])
          .filter(url => typeof url === 'string' && /^(?:stun|turn|turns):[^\s]+$/i.test(url));
        if (!urls.length) return [];
        const server = { urls };
        if (typeof item.username === 'string' && item.username.length <= 512) server.username = item.username;
        if (typeof item.credential === 'string' && item.credential.length <= 1024) server.credential = item.credential;
        return [server];
      });
    } catch {
      return [];
    }
  }

  function validateSignalPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (!SIGNAL_KINDS.has(payload.kind)) return null;
    if (typeof payload.sdp !== 'string' || !payload.sdp || payload.sdp.length > MAX_SIGNAL_SDP) return null;
    if (payload.pub != null) {
      if (typeof payload.pub !== 'string' || payload.pub.length > MAX_SIGNAL_PUB) return null;
    }
    const out = { kind: payload.kind, sdp: payload.sdp };
    if (typeof payload.pub === 'string') out.pub = payload.pub;
    return out;
  }

  function patchOpusSdp(sdp, bitrate = 96000) {
    const br = Math.max(16000, Math.min(256000, Number(bitrate) || 96000));
    return String(sdp).replace(/a=fmtp:111[^\r\n]*/g, m => {
      if (!m.includes('maxaveragebitrate')) m += `; maxaveragebitrate=${br}`;
      else m = m.replace(/maxaveragebitrate=\d+/, `maxaveragebitrate=${br}`);
      if (!m.includes('maxplaybackrate')) m += '; maxplaybackrate=48000';
      if (!m.includes('useinbandfec')) m += '; useinbandfec=1';
      if (!m.includes('usedtx')) m += '; usedtx=1';
      else m = m.replace(/usedtx=[01]/, 'usedtx=1');
      if (!m.includes('stereo')) m += '; stereo=1';
      else m = m.replace(/stereo=[01]/, 'stereo=1');
      if (!m.includes('sprop-stereo')) m += '; sprop-stereo=1';
      else m = m.replace(/sprop-stereo=[01]/, 'sprop-stereo=1');
      return m;
    });
  }

  function patchVideoSdp(sdp, maxBitrateKbps = 12000) {
    const cap = Math.max(2000, Math.min(140000, Number(maxBitrateKbps) || 12000));
    sdp = String(sdp).replace(/\r\n/g, '\n');
    return sdp.replace(/^m=video .*\n(?:[^m].*\n)*/gm, m => {
      let section = m;
      section = section.replace(/\nb=AS:\d+/g, '');
      section = section.replace(/\na=x-google-(?:min|max)-bitrate:\d+/g, '');
      return section + `a=x-google-max-bitrate:${cap}\n`;
    });
  }

  function preferredVideoCodecs(preferred) {
    const order = preferred === 'auto' || !preferred
      ? ['H264', 'VP9', 'VP8', 'H265', 'AV1']
      : [preferred, 'H264', 'VP9', 'VP8', 'H265', 'AV1'];
    return [...new Set(order)];
  }

  function isDebugEnabled() {
    try {
      if (typeof process !== 'undefined' && process.env && process.env.PAIR_DEBUG === '1') return true;
    } catch {}
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem('PAIR_DEBUG') === '1') return true;
    } catch {}
    return false;
  }

  function debugLog(...args) {
    if (isDebugEnabled()) console.log('[pair]', ...args);
  }

  const helpers = {
    DEFAULT_ICE_SERVERS,
    MAX_SIGNAL_SDP,
    mergeIceServers,
    turnServersFromConfig,
    validateSignalPayload,
    patchOpusSdp,
    patchVideoSdp,
    preferredVideoCodecs,
    isDebugEnabled,
    debugLog
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  root.pairHelpers = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
