const { contextBridge, ipcRenderer } = require('electron');
const { turnServersFromConfig, mergeIceServers, DEFAULT_ICE_SERVERS } = require('./pair-helpers');

function iceServersForRenderer() {
  return mergeIceServers(DEFAULT_ICE_SERVERS, turnServersFromConfig(process.env.PAIR_TURN || '[]'));
}

function optionalKey(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 8 && value.length < 256 ? value : '';
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
  isApp: true,
  iceServers: iceServersForRenderer(),
  giphyKey: optionalKey('PAIR_GIPHY_KEY'),
  klipyKey: optionalKey('PAIR_KLIPY_KEY'),
  toggleFullscreen: () => ipcRenderer.send('pair:toggleFullscreen'),
  getSystemAvatar: () => ipcRenderer.invoke('pair:getSystemAvatar'),
  getSources: () => ipcRenderer.invoke('pair:getSources'),
  setPendingSource: id => ipcRenderer.send('pair:setPendingSource', id),
  startLinuxShareAudio: () => ipcRenderer.invoke('pair:startLinuxShareAudio'),
  stopLinuxShareAudio: () => ipcRenderer.send('pair:stopLinuxShareAudio'),
  relaunch: () => ipcRenderer.send('pair:relaunch')
});

// Native WASAPI loopback capture with echo cancellation bridge.
// The renderer sends reference audio (Pair's voice) and receives clean audio.
// Only available when the native addon is built and loaded.
contextBridge.exposeInMainWorld('pairCapture', {
  start: () => ipcRenderer.send('pair:startCapture'),
  stop: () => ipcRenderer.send('pair:stopCapture'),
  // Send reference audio samples (Float32Array) to the native addon for cancellation.
  pushReference: buf => ipcRenderer.send('pair:captureRef', buf),
  // Register for clean audio data from the native addon.
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
