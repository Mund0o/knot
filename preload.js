const { contextBridge, ipcRenderer } = require('electron');

function turnServersFromEnvironment() {
  try {
    const config = JSON.parse(process.env.PAIR_TURN || '[]');
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

// Minimal, audited bridge for streaming an incoming file to disk.
// The renderer is sandboxed, so it cannot touch `fs` directly — only these
// four methods are exposed, and each round-trips to main.js over IPC.
contextBridge.exposeInMainWorld('pairSave', {
  // Pops a Save As dialog, opens the write stream. Resolves { ok, path } or { ok: false } on cancel.
  start: name => ipcRenderer.invoke('pair:saveStart', name),
  // Writes one chunk; resolves only once the OS accepts it (or 'drain' fires).
  write: buf => ipcRenderer.invoke('pair:saveWrite', buf),
  // Flushes and closes the stream; resolves on 'finish'.
  end: () => ipcRenderer.invoke('pair:saveEnd'),
  // Aborts and discards the current stream.
  cancel: () => ipcRenderer.invoke('pair:saveCancel')
});

// Settings persistence bridge for the sandboxed renderer. Falls through to
// localStorage automatically when running in a browser (no IPC available).
contextBridge.exposeInMainWorld('pairSettings', {
  get: key => ipcRenderer.invoke('pair:getSetting', key),
  set: (key, value) => ipcRenderer.invoke('pair:setSetting', key, value)
});

contextBridge.exposeInMainWorld('pairUpdates', {
  getStatus: () => ipcRenderer.invoke('pair:getUpdateStatus'),
  onStatus: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, status) => cb(status);
    ipcRenderer.on('pair:updateStatus', listener);
    return () => ipcRenderer.removeListener('pair:updateStatus', listener);
  }
});

// Read-only environment info exposed to the sandboxed renderer.
contextBridge.exposeInMainWorld('pairEnv', {
  platform: process.platform,
  useSystemPicker: process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY,
  isApp: true,
  iceServers: turnServersFromEnvironment(),
  toggleFullscreen: () => ipcRenderer.send('pair:toggleFullscreen'),
  onFullscreenChange: cb => { if (typeof cb !== 'function') return () => {}; const listener = (_event, value) => cb(!!value); ipcRenderer.on('pair:fullscreenChanged', listener); return () => ipcRenderer.removeListener('pair:fullscreenChanged', listener); },
  getSystemAvatar: () => ipcRenderer.invoke('pair:getSystemAvatar'),
  getSources: () => ipcRenderer.invoke('pair:getSources'),
  setPendingSource: id => ipcRenderer.send('pair:setPendingSource', id),
  startLinuxShareAudio: () => ipcRenderer.invoke('pair:startLinuxShareAudio'),
  stopLinuxShareAudio: () => ipcRenderer.send('pair:stopLinuxShareAudio'),
  onLinuxShareAudio: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, samples) => cb(samples);
    ipcRenderer.on('pair:linuxShareAudio', listener);
    return () => ipcRenderer.removeListener('pair:linuxShareAudio', listener);
  },
  onLinuxShareAudioError: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, message) => cb(message);
    ipcRenderer.on('pair:linuxShareAudioError', listener);
    return () => ipcRenderer.removeListener('pair:linuxShareAudioError', listener);
  },
  relaunch: () => ipcRenderer.send('pair:relaunch')
});

// Native WASAPI process-loopback bridge. The OS includes only the selected app
// or excludes Pair's process tree, so Pair voice never enters these samples.
// Only available when the native addon is built and loaded.
contextBridge.exposeInMainWorld('pairCapture', {
  start: () => ipcRenderer.send('pair:startCapture'),
  stop: () => ipcRenderer.send('pair:stopCapture'),
  // Register for isolated desktop/application audio data from the native addon.
  onCleanAudio: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, buf, frames) => cb(buf, frames);
    ipcRenderer.on('pair:cleanAudio', listener);
    return () => ipcRenderer.removeListener('pair:cleanAudio', listener);
  },
  // Register for capture errors.
  onError: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('pair:captureError', listener);
    return () => ipcRenderer.removeListener('pair:captureError', listener);
  },
  // Register for capture format info.
  onFormat: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, fmt) => cb(fmt);
    ipcRenderer.on('pair:captureFormat', listener);
    return () => ipcRenderer.removeListener('pair:captureFormat', listener);
  }
});
