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

// The native TCP file lane is deliberately narrow: the sandboxed renderer can
// exchange authenticated encrypted frames, but cannot open arbitrary sockets.
contextBridge.exposeInMainWorld('pairDirectFile', {
  listen: port => ipcRenderer.invoke('pair:directFileListen', port),
  register: (token, key) => ipcRenderer.invoke('pair:directFileRegister', token, key),
  connect: (host, port, token, key) => ipcRenderer.invoke('pair:directFileConnect', host, port, token, key),
  send: (id, data) => ipcRenderer.invoke('pair:directFileSend', id, data),
  close: id => ipcRenderer.send('pair:directFileClose', id),
  // Release the receiver-side flow-control window once a frame has been
  // consumed, so a slow disk pauses the TCP lane instead of growing memory.
  ack: (id, bytes) => ipcRenderer.send('pair:directFileAck', id, bytes),
  onFrame: cb => { const listener = (_event, id, data) => cb?.(id, data); ipcRenderer.on('pair:directFileFrame', listener); return () => ipcRenderer.removeListener('pair:directFileFrame', listener); },
  onClose: cb => { const listener = (_event, id) => cb?.(id); ipcRenderer.on('pair:directFileClose', listener); return () => ipcRenderer.removeListener('pair:directFileClose', listener); }
});

// Settings persistence bridge for the sandboxed renderer. Falls through to
// localStorage automatically when running in a browser (no IPC available).
contextBridge.exposeInMainWorld('pairSettings', {
  get: key => ipcRenderer.invoke('pair:getSetting', key),
  set: (key, value) => ipcRenderer.invoke('pair:setSetting', key, value)
});

// Read-only, allowlisted DeepFilterNet assets.  Keeping model access here
// prevents renderer code from ever receiving filesystem access.
contextBridge.exposeInMainWorld('pairDeepFilter', {
  getAsset: name => (name === 'wasm' || name === 'model')
    ? ipcRenderer.invoke('pair:getDeepFilterAsset', name)
    : Promise.resolve(null)
});

contextBridge.exposeInMainWorld('pairUpdates', {
  getStatus: () => ipcRenderer.invoke('pair:getUpdateStatus'),
  accept: () => ipcRenderer.invoke('pair:acceptUpdate'),
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
  primaryGpuVendor: process.env.KNOT_PRIMARY_GPU_VENDOR || '',
  // Linux selection is handled by desktopCapturer inside the display-media
  // request so the PipeWire portal source is consumed before it can expire.
  useSystemPicker: process.platform === 'linux',
  isApp: true,
  iceServers: turnServersFromEnvironment(),
  getSystemAvatar: () => ipcRenderer.invoke('pair:getSystemAvatar'),
  getSources: () => ipcRenderer.invoke('pair:getSources'),
  setPendingSource: source => ipcRenderer.invoke('pair:setPendingSource', source),
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
  onGpuProcessGone: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, details) => cb(details || { reason: 'unknown' });
    ipcRenderer.on('pair:gpuProcessGone', listener);
    return () => ipcRenderer.removeListener('pair:gpuProcessGone', listener);
  },
  relaunch: () => ipcRenderer.send('pair:relaunch')
});

// Native WASAPI process-loopback bridge. The OS includes only the selected app
// or excludes Knot's process tree, so Knot voice never enters these samples.
// Only available when the native addon is built and loaded.
contextBridge.exposeInMainWorld('pairCapture', {
  start: () => ipcRenderer.send('pair:startCapture'),
  stop: () => ipcRenderer.send('pair:stopCapture'),
  // Register for isolated desktop/application audio data from the native addon.
  onCleanAudio: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, buf, frames, metadata) => {
      try { cb(buf, frames, metadata || null); }
      finally {
        const sequence = Number(metadata?.sequence);
        if (Number.isInteger(sequence) && sequence > 0) ipcRenderer.send('pair:cleanAudioAck', sequence);
      }
    };
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

// Pull-based GPU AV1 bridge: renderer and data-channel backpressure naturally
// pause reads instead of allowing encoded video to accumulate without bounds.
contextBridge.exposeInMainWorld('pairNativeScreen', {
  info: () => ipcRenderer.invoke('pair:nativeScreenInfo'),
  start: options => ipcRenderer.invoke('pair:startNativeScreen', options),
  read: id => ipcRenderer.invoke('pair:readNativeScreen', id),
  stop: id => ipcRenderer.send('pair:stopNativeScreen', id),
  onError: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, message) => cb(String(message || 'Native screen capture failed'));
    ipcRenderer.on('pair:nativeScreenError', listener);
    return () => ipcRenderer.removeListener('pair:nativeScreenError', listener);
  }
});
