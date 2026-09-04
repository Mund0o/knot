(function installWatchTogether(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotWatchTogether = api;
})(typeof window === 'object' ? window : null, () => {
  const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,32}$/;
  const HASH = /^[a-f0-9]{32,64}$/;
  const ACTIONS = new Set(['open', 'state', 'close', 'request', 'need-file']);

  function youtubeVideoId(value) {
    try {
      const u = new URL(value);
      const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
      let id = '';
      if (host === 'youtu.be') id = u.pathname.split('/').filter(Boolean)[0] || '';
      else if (host === 'youtube.com' || host === 'music.youtube.com') {
        id = u.searchParams.get('v') || '';
        if (!id) {
          const bits = u.pathname.split('/').filter(Boolean);
          if (['embed', 'shorts', 'live'].includes(bits[0])) id = bits[1] || '';
        }
      }
      return YOUTUBE_ID.test(id) ? id : '';
    } catch {
      return '';
    }
  }

  function watchEmbedUrl(id, { start = 0, playing = false } = {}) {
    if (!YOUTUBE_ID.test(id)) return '';
    const params = new URLSearchParams({
      rel: '0',
      modestbranding: '1',
      controls: '0',
      fs: '1',
      autoplay: playing ? '1' : '0',
      start: String(Math.max(0, Math.floor(Number(start) || 0))),
      playsinline: '1',
      disablekb: '1',
    });
    return 'https://www.youtube-nocookie.com/embed/' + id + '?' + params.toString();
  }

  function mediaTime(state, now = Date.now()) {
    const time = Math.max(0, Number(state?.time) || 0);
    if (!state?.playing) return time;
    const at = Number(state.at);
    const origin = Number.isFinite(at) && at > 0 ? at : now;
    return time + Math.max(0, (now - origin) / 1000);
  }

  function drifted(localTime, remoteTime, tolerance = 1.25) {
    return Math.abs((Number(localTime) || 0) - (Number(remoteTime) || 0)) > tolerance;
  }

  function watchRoom({ dmPeerId = '', entityId = '', channelId = '' } = {}) {
    if (/^[a-f0-9]{32}$/.test(dmPeerId)) return 'dm:' + dmPeerId;
    if (/^[a-f0-9]{32}$/.test(entityId) && /^[a-f0-9]{32}$/.test(channelId)) return 'voice:' + entityId + ':' + channelId;
    return '';
  }

  function cleanTitle(value, fallback = 'Watch together') {
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 96) || fallback;
  }

  function cleanWatchMessage(value) {
    if (!value || value.t !== 'watch' || value.v !== 1 || !ACTIONS.has(value.action)) return null;
    const action = value.action;
    if (action === 'request' || action === 'close') return { t: 'watch', v: 1, action };
    if (action === 'need-file') {
      const hash = String(value.hash || '').toLowerCase();
      return HASH.test(hash) ? { t: 'watch', v: 1, action, hash } : null;
    }
    if (action === 'open') {
      const kind = value.kind === 'local' ? 'local' : value.kind === 'youtube' ? 'youtube' : '';
      if (!kind) return null;
      const seq = Number(value.seq);
      const base = {
        t: 'watch',
        v: 1,
        action: 'open',
        kind,
        title: cleanTitle(value.title, kind === 'local' ? 'Local video' : 'YouTube'),
        playing: value.playing === true,
        time: Math.max(0, Number(value.time) || 0),
        at: Number.isFinite(Number(value.at)) ? Number(value.at) : Date.now(),
        seq: Number.isSafeInteger(seq) && seq > 0 ? seq : 1,
      };
      if (kind === 'youtube') {
        const id = YOUTUBE_ID.test(value.id) ? value.id : youtubeVideoId(String(value.url || ''));
        return id ? { ...base, id } : null;
      }
      const hash = String(value.hash || '').toLowerCase();
      const size = Number(value.size);
      if (!HASH.test(hash) || !Number.isSafeInteger(size) || size < 0) return null;
      return { ...base, hash, size, name: cleanTitle(value.name, 'video') };
    }
    if (action === 'state') {
      const seq = Number(value.seq);
      return {
        t: 'watch',
        v: 1,
        action: 'state',
        playing: value.playing === true,
        time: Math.max(0, Number(value.time) || 0),
        at: Number.isFinite(Number(value.at)) ? Number(value.at) : Date.now(),
        seq: Number.isSafeInteger(seq) && seq > 0 ? seq : 1,
      };
    }
    return null;
  }

  function newerWatch(current, incoming) {
    if (!incoming) return false;
    if (!current) return true;
    const left = Number(current.seq) || 0, right = Number(incoming.seq) || 0;
    if (right !== left) return right > left;
    return (Number(incoming.at) || 0) >= (Number(current.at) || 0);
  }

  function hexFrom(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  async function hashPrefix(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof crypto === 'object' && crypto.subtle?.digest) {
      return hexFrom(await crypto.subtle.digest('SHA-256', data));
    }
    const nodeCrypto = require('crypto');
    return nodeCrypto.createHash('sha256').update(data).digest('hex');
  }

  return {
    youtubeVideoId,
    watchEmbedUrl,
    mediaTime,
    drifted,
    watchRoom,
    cleanWatchMessage,
    newerWatch,
    hashPrefix,
    PREFIX_BYTES: 2 * 1024 * 1024,
  };
});
