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

// The UDP lane bridge is as narrow as the file bridge: the renderer can open, punch and release
// lanes, and every byte then goes through the authenticated frame path above. Endpoints are
// checked here as well as in the main process.
const validLaneId = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const udxEndpoint = value => value && typeof value === 'object' && typeof value.ip === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value.ip) && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535;
const udxRemote = value => value && typeof value === 'object' && Number.isInteger(value.streamId) && value.streamId >= 1 && value.streamId <= 0xffffffff
  && Array.isArray(value.endpoints) && value.endpoints.length >= 1 && value.endpoints.length <= 16 && value.endpoints.every(udxEndpoint)
  ? { streamId: value.streamId, endpoints: value.endpoints.map(item => ({ ip: item.ip, port: item.port, kind: item.kind === 'host' ? 'host' : 'srflx' })) } : null;
contextBridge.exposeInMainWorld('pairUdxLane', {
  open: () => ipcRenderer.invoke('pair:udxOpen', bridgeDocumentId),
  register: (token, key) => validDirectToken(token) && validDirectKey(key)
    ? ipcRenderer.invoke('pair:udxRegister', bridgeDocumentId, token, key)
    : Promise.resolve(false),
  establish: options => {
    const remote = udxRemote(options?.remote), role = options?.role;
    if (!options || !validLaneId(options.id) || (role !== 'accept' && role !== 'connect') || !validDirectToken(options.token) || !remote || (role === 'connect' && !validDirectKey(options.key))) {
      return Promise.reject(new Error('Invalid UDP lane request'));
    }
    return ipcRenderer.invoke('pair:udxEstablish', bridgeDocumentId, options.id, role, options.token, role === 'connect' ? options.key : null, remote,
      Number.isFinite(options.timeout) ? options.timeout : undefined, Number.isFinite(options.hold) ? options.hold : undefined);
  },
  release: id => validLaneId(id) ? ipcRenderer.invoke('pair:udxRelease', bridgeDocumentId, id) : Promise.resolve(false),
  close: id => validLaneId(id) ? (ipcRenderer.send('pair:udxClose', bridgeDocumentId, id), true) : false,
});

// Screen shares ride their own UDP lanes (share-lane-runtime.js): same punching and authenticated framing as the file lane, separate
// peers and limits. The shape is what share-session.js expects of `lanes`: open/register/establish/release/close/closePeer/send/credit,
// and onOpen/onFrame/onClose hooks.
const validPeerId = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const shareLaneHook = (channel, valid) => cb => {
  if (typeof cb !== 'function') return () => {};
  const listener = (_event, documentId, id, extra) => { if (documentId === bridgeDocumentId && validPeerId(id) && valid(extra)) cb(id, extra); };
  ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('pairShareLane', {
  open: () => ipcRenderer.invoke('pair:shareLaneOpen', bridgeDocumentId),
  register: (token, key) => validDirectToken(token) && validDirectKey(key) ? ipcRenderer.invoke('pair:shareLaneRegister', bridgeDocumentId, token, key) : Promise.resolve(false),
  establish: options => {
    const remote = udxRemote(options?.remote), role = options?.role;
    if (!options || !validLaneId(options.id) || (role !== 'accept' && role !== 'connect') || !validDirectToken(options.token) || !remote || (role === 'connect' && !validDirectKey(options.key))) return Promise.reject(new Error('Invalid share lane request'));
    return ipcRenderer.invoke('pair:shareLaneEstablish', bridgeDocumentId, options.id, role, options.token, role === 'connect' ? options.key : null, remote,
      Number.isFinite(options.timeout) ? options.timeout : undefined, Number.isFinite(options.hold) ? options.hold : undefined);
  },
  release: id => validLaneId(id) ? ipcRenderer.invoke('pair:shareLaneRelease', bridgeDocumentId, id) : Promise.resolve(false),
  close: id => validLaneId(id) ? (ipcRenderer.send('pair:shareLaneClose', bridgeDocumentId, id), true) : false,
  closePeer: id => validPeerId(id) ? (ipcRenderer.send('pair:shareLaneClosePeer', bridgeDocumentId, id), true) : false,
  send: (id, bytes) => validPeerId(id) && validBinaryChunk(bytes) ? ipcRenderer.invoke('pair:shareLaneSend', bridgeDocumentId, id, bytes) : Promise.reject(new Error('Invalid share frame')),
  // Bytes the renderer has finished with: lets the receive side keep reading.
  credit: (id, count) => validPeerId(id) && Number.isSafeInteger(count) && count > 0 && count <= MAX_FILE_IPC_CHUNK ? (ipcRenderer.send('pair:shareLaneCredit', bridgeDocumentId, id, count), true) : false,
  onOpen: shareLaneHook('pair:shareLaneOpen', token => validDirectToken(token) || token === ''),
  onFrame: shareLaneHook('pair:shareLaneFrame', validBinaryChunk),
  onClose: shareLaneHook('pair:shareLaneClose', value => value === undefined),
});

// The Linux recorder (GPU Screen Recorder) as the renderer sees it: start it, and it reports the stream's description once and then
// every encoded picture as plain { key, pts, data }. Nothing here is a container or a process.
const shareCaptureHook = (channel, valid) => cb => {
  if (typeof cb !== 'function') return () => {};
  const listener = (_event, documentId, value) => { if (documentId === bridgeDocumentId && valid(value)) cb(value); };
  ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener);
};
const validShareConfig = value => value && typeof value === 'object' && typeof value.codec === 'string' && value.codec.length <= 64 && Number.isInteger(value.width) && Number.isInteger(value.height);
const validSharePicture = value => value && typeof value === 'object' && typeof value.key === 'boolean' && Number.isFinite(value.pts) && ArrayBuffer.isView(value.data) && value.data.byteLength > 0;
contextBridge.exposeInMainWorld('pairShareCapture', {
  info: () => ipcRenderer.invoke('pair:shareCaptureInfo', bridgeDocumentId),
  start: options => ipcRenderer.invoke('pair:shareCaptureStart', bridgeDocumentId, options && typeof options === 'object' ? options : {}),
  stop: () => ipcRenderer.invoke('pair:shareCaptureStop', bridgeDocumentId),
  onConfig: shareCaptureHook('pair:shareCaptureConfig', validShareConfig),
  onFrame: shareCaptureHook('pair:shareCaptureFrame', validSharePicture),
  onError: shareCaptureHook('pair:shareCaptureError', value => typeof value === 'string'),
  onEnd: shareCaptureHook('pair:shareCaptureEnd', value => value === undefined),
});

// AV1 decoding on the NVIDIA GPU, done by a helper program the main process runs (share-decode-nvdec.js). The renderer hands it encoded
// pictures and gets raw NV12 pictures back, tagged with the time they were given; it never sees the process.
const validDecodeId = value => Number.isSafeInteger(value) && value > 0 && value < 2 ** 31;
const validDecodeSide = value => Number.isInteger(value) && value >= 128 && value <= 8192;
const MAX_DECODED_PICTURE = 16 * 1024 * 1024;
const validDecodedPicture = (meta, bytes) => meta && typeof meta === 'object' && validDecodeSide(meta.width) && validDecodeSide(meta.height) && Number.isFinite(meta.pts)
  && ArrayBuffer.isView(bytes) && bytes.byteLength === meta.width * meta.height * 3 / 2 && bytes.byteLength <= MAX_DECODED_PICTURE;
const shareDecodeHook = (channel, valid) => cb => {
  if (typeof cb !== 'function') return () => {};
  const listener = (_event, documentId, id, ...rest) => { if (documentId === bridgeDocumentId && validDecodeId(id) && valid(...rest)) cb(id, ...rest); };
  ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('pairShareDecode', {
  info: () => ipcRenderer.invoke('pair:shareDecodeInfo', bridgeDocumentId),
  open: options => options && typeof options === 'object' && [options.width, options.height, options.outWidth, options.outHeight].every(validDecodeSide)
    ? ipcRenderer.invoke('pair:shareDecodeOpen', bridgeDocumentId, { width: options.width, height: options.height, outWidth: options.outWidth, outHeight: options.outHeight })
    : Promise.resolve({ ok: false, error: 'invalid decoder request' }),
  push: (id, pts, bytes) => validDecodeId(id) && Number.isFinite(pts) && pts >= 0 && validBinaryChunk(bytes) ? (ipcRenderer.send('pair:shareDecodePush', bridgeDocumentId, id, pts, bytes), true) : false,
  close: id => validDecodeId(id) ? (ipcRenderer.send('pair:shareDecodeClose', bridgeDocumentId, id), true) : false,
  onFrame: shareDecodeHook('pair:shareDecodeFrame', validDecodedPicture),
  onError: shareDecodeHook('pair:shareDecodeError', message => typeof message === 'string'),
  onEnd: shareDecodeHook('pair:shareDecodeEnd', () => true),
});

// Settings persistence bridge for the sandboxed renderer. Falls through to
// localStorage automatically when running in a browser (no IPC available).
contextBridge.exposeInMainWorld('pairSettings', {
  get: key => ipcRenderer.invoke('pair:getSetting', key),
  set: (key, value) => ipcRenderer.invoke('pair:setSetting', key, value),
  has: key => ipcRenderer.invoke('pair:hasSetting', key),
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
  // Only set for the development test rig (see main.js); empty in every real run.
  signalServer: String(process.env.KNOT_SIGNAL_SERVER || ''),
  primaryGpuVendor: process.env.KNOT_PRIMARY_GPU_VENDOR || '',
  // Set when NVIDIA VA-API decode is enabled for this launch and must be verified.
  nvidiaVaapiDriver: process.env.KNOT_NVIDIA_VAAPI_DRIVER || '',
  // NVIDIA only: 'on', 'failed' (every driver build failed its check) or 'missing'.
  nvidiaVaapiState: process.env.KNOT_NVIDIA_VAAPI_STATE || '',
  reportNvidiaDecode: verdict => ipcRenderer.send('pair:nvidiaDecodeVerdict', String(verdict || '')),
  // Linux selection is handled by desktopCapturer inside the display-media
  // request so the PipeWire portal source is consumed before it can expire.
  useSystemPicker: process.platform === 'linux' && !!(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY),
  isApp: true,
  iceServers: turnServersFromEnvironment(),
  networkProbe: () => ipcRenderer.invoke('pair:networkProbe'),
  abortNetworkProbe: () => ipcRenderer.invoke('pair:abortNetworkProbe'),
  getSystemAvatar: () => ipcRenderer.invoke('pair:getSystemAvatar'),
  getSources: () => ipcRenderer.invoke('pair:getSources'),
  setPendingSource: source => ipcRenderer.invoke('pair:setPendingSource', source),
  startLinuxShareAudio: () => ipcRenderer.invoke('pair:startLinuxShareAudio'),
  stopLinuxShareAudio: () => ipcRenderer.invoke('pair:stopLinuxShareAudio'),
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
  onLinuxShareAudioDebug: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, message) => cb(message);
    ipcRenderer.on('pair:linuxShareAudioDebug', listener);
    return () => ipcRenderer.removeListener('pair:linuxShareAudioDebug', listener);
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
  // allowSystemMix lets Windows fall back to the whole device mix when
  // process isolation is unavailable (Windows 10 without the update).
  start: options => ipcRenderer.send('pair:startCapture', { allowSystemMix: options?.allowSystemMix === true }),
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

const validLanFp = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const validLanNonce = value => typeof value === 'string' && /^[a-f0-9]{16,64}$/.test(value);
const validLanHost = value => typeof value === 'string' && /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}(?:\.\d{1,3}){0,2}$/.test(value);
const validLanPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
const validLanPeerId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const validLanFrame = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.t !== 'string' || value.t.length > 32) return false;
  try { return JSON.stringify(value).length <= 48 * 1024; } catch { return false; }
};

contextBridge.exposeInMainWorld('pairLan', {
  start: () => ipcRenderer.invoke('pair:lanStart', bridgeDocumentId),
  stop: () => ipcRenderer.invoke('pair:lanStop', bridgeDocumentId),
  setBeacon: (fp, nonce) => validLanFp(fp) && validLanNonce(nonce)
    ? ipcRenderer.invoke('pair:lanSetBeacon', bridgeDocumentId, fp, nonce)
    : Promise.resolve(false),
  connect: (host, port) => validLanHost(host) && validLanPort(port)
    ? ipcRenderer.invoke('pair:lanConnect', bridgeDocumentId, host, port)
    : Promise.reject(new Error('LAN peer is not on this network')),
  send: (id, value) => validLanPeerId(id) && validLanFrame(value)
    ? ipcRenderer.invoke('pair:lanSend', bridgeDocumentId, id, value)
    : Promise.resolve(false),
  close: id => validLanPeerId(id) ? (ipcRenderer.send('pair:lanClose', bridgeDocumentId, id), true) : false,
  onBeacon: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, documentId, beacon) => { if (documentId === bridgeDocumentId && beacon && validLanFp(beacon.fp) && validLanHost(beacon.host) && validLanPort(beacon.port)) cb(beacon); };
    ipcRenderer.on('pair:lanBeacon', listener); return () => ipcRenderer.removeListener('pair:lanBeacon', listener);
  },
  onPeer: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, documentId, peer) => { if (documentId === bridgeDocumentId && peer && validLanPeerId(peer.id) && validLanHost(peer.host)) cb(peer); };
    ipcRenderer.on('pair:lanPeer', listener); return () => ipcRenderer.removeListener('pair:lanPeer', listener);
  },
  onFrame: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, documentId, id, value) => { if (documentId === bridgeDocumentId && validLanPeerId(id) && validLanFrame(value)) cb(id, value); };
    ipcRenderer.on('pair:lanFrame', listener); return () => ipcRenderer.removeListener('pair:lanFrame', listener);
  },
  onClose: cb => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, documentId, id) => { if (documentId === bridgeDocumentId && validLanPeerId(id)) cb(id); };
    ipcRenderer.on('pair:lanClose', listener); return () => ipcRenderer.removeListener('pair:lanClose', listener);
  },
});
