const { contextBridge, ipcRenderer } = require('electron');
// Sandboxed Electron preloads only expose a small allowlist of CommonJS
// modules. Use Chromium's Web Crypto implementation so the bridge nonce stays
// unpredictable without depending on Node's unavailable `crypto` module.
const bridgeDocumentBytes = new Uint8Array(16);
globalThis.crypto.getRandomValues(bridgeDocumentBytes);
const bridgeDocumentId = Array.from(bridgeDocumentBytes, byte => byte.toString(16).padStart(2, '0')).join('');
const MAX_FILE_SIZE = 200 * 1024 ** 3;
const MAX_FILE_IPC_CHUNK = 8 * 1024 * 1024;
const validTransferId = value => Number.isSafeInteger(value) && value > 0;
const validFileSize = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_FILE_SIZE;
const validDirectPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
const validDirectId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const validDirectToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
const validDirectHost = value => typeof value === 'string' && value.length >= 2 && value.length <= 64 && /^[0-9a-f:.]+$/i.test(value);
const validBinaryChunk = value => {
  try { return (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) && Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= MAX_FILE_IPC_CHUNK; }
  catch { return false; }
};
const validDirectKey = value => validBinaryChunk(value) && value.byteLength === 32;
const directConnectOptions = value => {
  const timeout = value && typeof value === 'object' && typeof value.timeout === 'number' && Number.isFinite(value.timeout)
    ? Math.max(1000, Math.min(10000, Math.floor(value.timeout)))
    : null;
  return timeout === null ? {} : { timeout };
};

// Main records this unpredictable value as the one live preload document for
// the BrowserWindow. A same-URL reload otherwise leaves async IPC unable to
// distinguish the dead document from the new one.
ipcRenderer.send('pair:bridgeReady', bridgeDocumentId);

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
  start: (id, name, size) => validTransferId(id) && typeof name === 'string' && name.length > 0 && name.length <= 255 && validFileSize(size)
    ? ipcRenderer.invoke('pair:saveStart', bridgeDocumentId, id, name, size)
    : Promise.resolve({ ok: false, error: 'Invalid file offer' }),
  // Writes one chunk; resolves only once the OS accepts it (or 'drain' fires).
  write: (id, buf) => validTransferId(id) && validBinaryChunk(buf)
    ? ipcRenderer.invoke('pair:saveWrite', bridgeDocumentId, id, buf)
    : Promise.reject(new Error('Invalid file chunk')),
  // Flushes and closes the stream; resolves on 'finish'.
  end: (id, size) => validTransferId(id) && validFileSize(size)
    ? ipcRenderer.invoke('pair:saveEnd', bridgeDocumentId, id, size)
    : Promise.reject(new Error('Invalid file completion')),
  // Aborts and discards the current stream.
  cancel: id => validTransferId(id) ? ipcRenderer.invoke('pair:saveCancel', bridgeDocumentId, id) : Promise.resolve(false)
});

// The native TCP file lane is deliberately narrow: the sandboxed renderer can
// exchange authenticated encrypted frames, but cannot open arbitrary sockets.
contextBridge.exposeInMainWorld('pairDirectFile', {
  listen: port => validDirectPort(port)
    ? ipcRenderer.invoke('pair:directFileListen', bridgeDocumentId, port)
    : Promise.resolve({ ok: false, error: 'Choose a port from 1024 through 65535.' }),
  register: (token, key) => validDirectToken(token) && validDirectKey(key)
    ? ipcRenderer.invoke('pair:directFileRegister', bridgeDocumentId, token, key)
    : Promise.resolve(false),
  connect: (host, port, token, key, options) => validDirectHost(host) && validDirectPort(port) && validDirectToken(token) && validDirectKey(key)
    ? ipcRenderer.invoke('pair:directFileConnect', bridgeDocumentId, host, port, token, key, directConnectOptions(options))
    : Promise.reject(new Error('Invalid direct-file connection')),
  send: (id, data) => validDirectId(id) && validBinaryChunk(data)
    ? ipcRenderer.invoke('pair:directFileSend', bridgeDocumentId, id, data)
    : Promise.reject(new Error('Invalid direct-file frame')),
  close: id => validDirectId(id) ? (ipcRenderer.send('pair:directFileClose', bridgeDocumentId, id), true) : false,
  reset: () => ipcRenderer.invoke('pair:directFileReset', bridgeDocumentId),
  // Release the receiver-side flow-control window once a frame has been
  // consumed, so a slow disk pauses the TCP lane instead of growing memory.
  ack: (id, bytes) => validDirectId(id) && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MAX_FILE_IPC_CHUNK
    ? (ipcRenderer.send('pair:directFileAck', bridgeDocumentId, id, bytes), true)
    : false,
  onOpen: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, documentId, id, token) => { if(documentId===bridgeDocumentId&&validDirectId(id)&&validDirectToken(token))cb(id,token) };
    ipcRenderer.on('pair:directFileOpen', listener);return () => ipcRenderer.removeListener('pair:directFileOpen', listener);
  },
  onFrame: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, documentId, id, data) => { if(documentId===bridgeDocumentId&&validDirectId(id)&&validBinaryChunk(data))cb(id,data) };
    ipcRenderer.on('pair:directFileFrame', listener);return () => ipcRenderer.removeListener('pair:directFileFrame', listener);
  },
  onClose: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, documentId, id) => { if(documentId===bridgeDocumentId&&validDirectId(id))cb(id) };
    ipcRenderer.on('pair:directFileClose', listener);return () => ipcRenderer.removeListener('pair:directFileClose', listener);
  }
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
  // main.js overwrites this environment value with app.getVersion() before
  // constructing the sandboxed renderer. Requiring package.json from a
  // sandboxed preload is not supported by Electron.
  version: String(process.env.KNOT_APP_VERSION || ''),
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
    const listener = (_event, samples, metadata) => {
      try { cb(samples, metadata || null); }
      finally {
        const sequence = Number(metadata?.sequence);
        if (Number.isInteger(sequence) && sequence > 0) ipcRenderer.send('pair:linuxShareAudioAck', sequence);
      }
    };
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


// Keyless Emoji.gg API search backed by a bounded local metadata/image cache.
contextBridge.exposeInMainWorld('pairEmojiCatalog', {
  available: () => ipcRenderer.invoke('pair:emojiSearch', {}).then(r => r.total > 0).catch(() => false),
  search: params => ipcRenderer.invoke('pair:emojiSearch', params),
  get: id => ipcRenderer.invoke('pair:emojiGet', id),
  stats: () => ipcRenderer.invoke('pair:emojiStats'),
});

// Numeric, allowlisted diagnostics are kept only in the local metrics database.
contextBridge.exposeInMainWorld('pairMetrics', {
  record: (name,value,tags={}) => { if(typeof name==='string'&&typeof value==='number'&&Number.isFinite(value))ipcRenderer.send('pair:metricRecord',name,value,tags) },
  summary: hours => ipcRenderer.invoke('pair:metricSummary',hours),
});

const validHistoryOwner=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const validHistoryConversation=value=>typeof value==='string'&&/^(?:dm:[a-f0-9]{32}|(?:server|group):[a-f0-9]{32}:[a-f0-9]{32})$/.test(value);
contextBridge.exposeInMainWorld('pairHistory',{
  append:(owner,conversation,entry)=>validHistoryOwner(owner)&&validHistoryConversation(conversation)&&entry&&typeof entry==='object'?ipcRenderer.invoke('pair:historyAppend',owner,conversation,entry):Promise.resolve({added:0}),
  list:(owner,conversation,options={})=>validHistoryOwner(owner)&&validHistoryConversation(conversation)?ipcRenderer.invoke('pair:historyList',owner,conversation,{before:Number.isSafeInteger(Number(options.before))&&Number(options.before)>0?Number(options.before):null,limit:Math.max(1,Math.min(200,Number(options.limit)||80))}):Promise.resolve({items:[],nextBefore:null,hasOlder:false}),
  importLegacy:(owner,histories)=>validHistoryOwner(owner)&&histories&&typeof histories==='object'?ipcRenderer.invoke('pair:historyImport',owner,histories):Promise.resolve(false),
});

// Pull-based GPU AV1 bridge: renderer and data-channel backpressure naturally
// pause reads instead of allowing encoded video to accumulate without bounds.
contextBridge.exposeInMainWorld('pairNativeScreen', {
  info: () => ipcRenderer.invoke('pair:nativeScreenInfo', bridgeDocumentId),
  start: options => ipcRenderer.invoke('pair:startNativeScreen', bridgeDocumentId, options),
  read: id => ipcRenderer.invoke('pair:readNativeScreen', bridgeDocumentId, id),
  stop: id => ipcRenderer.send('pair:stopNativeScreen', bridgeDocumentId, id),
  onError: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, message) => cb(String(message || 'Native screen capture failed'));
    ipcRenderer.on('pair:nativeScreenError', listener);
    return () => ipcRenderer.removeListener('pair:nativeScreenError', listener);
  }
});
