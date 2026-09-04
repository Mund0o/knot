const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, Menu, session, dialog, ipcMain, desktopCapturer, shell, safeStorage, protocol } = require('electron');
const { installLinuxLauncher } = require('./linux-launcher');
const { linuxMainGpu, applyLinuxMainGpuEnvironment } = require('./linux-gpu');
const { applyGpuAccelerationPolicy } = require('./gpu-acceleration');
const { NativeScreenService } = require('./native-screen');
const { DirectFileHost, connect: connectDirectFile } = require('./direct-file');
const { LanHouse, localIpv4, privateIpv4 } = require('./lan-house');
const { SettingsStore } = require('./settings-store');
const { FORMAT: LOCAL_SETTINGS_FORMAT, LocalSettingsCipher } = require('./settings-crypto');
const { EncryptedHistoryStore, validScope: validHistoryScope, MAX_ENTRY_BYTES: MAX_HISTORY_ENTRY_BYTES } = require('./history-store');
const { LocalMetricsStore } = require('./local-metrics');
const { SaveStreamManager, safeSuggestedFileName } = require('./save-streams');
const nodeNet = require('net');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { execFile, spawn } = require('child_process');
const APP_ICON = path.join(__dirname, 'build', 'icon.png');
const PAIR_RENDERER_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;
const emojiCatalog = require('./emoji-catalog');

app.setName('Knot');
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on('second-instance', () => {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();mainWin.focus();
});

// API-fetched emoji assets use a private scheme so the sandboxed renderer never
// receives filesystem paths. The handler below enforces the Emoji.gg CDN host,
// validates image signatures, and owns the bounded on-demand cache.
protocol.registerSchemesAsPrivileged([
  { scheme: 'emoji', privileges: { standard: false, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWin = null;
let pendingSource = null;
let pendingSources = [];
let activeShareSourceId = null;
let linuxShareAudio = null;
let linuxShareAudioStart = null, linuxShareAudioStopping = null, linuxShareAudioGeneration = 0;
const LINUX_AUDIO_PACKET_BYTES = 48000 * .02 * 2 * 4;
const LINUX_AUDIO_MAX_INFLIGHT = 3;
const LINUX_AUDIO_MAX_BUFFER_BYTES = LINUX_AUDIO_PACKET_BYTES * 6;
let nativeScreenService = null;
let selectedPrimaryGpu = null;
let emojiWorker = null, emojiWorkerSequence = 0, emojiRefreshPromise = null;
const emojiWorkerPending = new Map();
function stopEmojiWorker(error = new Error('Emoji catalog worker stopped')) {
  const worker = emojiWorker;emojiWorker = null;
  for (const pending of emojiWorkerPending.values()) { clearTimeout(pending.timer);pending.reject(error); }
  emojiWorkerPending.clear();
  return worker?.terminate?.();
}
function startEmojiWorker(root) {
  void stopEmojiWorker();
  const worker = new Worker(path.join(__dirname, 'emoji-catalog-worker.js'), { workerData: { root } });emojiWorker = worker;
  worker.on('message', message => {
    const pending = emojiWorkerPending.get(Number(message?.id));if(!pending)return;emojiWorkerPending.delete(Number(message.id));clearTimeout(pending.timer);message.error?pending.reject(new Error(message.error)):pending.resolve(message.value);
  });
  worker.on('error', error => { if(emojiWorker===worker)void stopEmojiWorker(error); });
  worker.on('exit', code => { if(emojiWorker===worker)void stopEmojiWorker(new Error(`Emoji catalog worker exited with code ${code}`)); });
}
function ensureEmojiWorker() { if (!emojiWorker && emojiCatalog.available()) startEmojiWorker(emojiCatalog.dir());return emojiWorker; }
function emojiWorkerRequest(worker, method, args) {
  const id=++emojiWorkerSequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{emojiWorkerPending.delete(id);reject(new Error('Emoji catalog request timed out'))},5000);emojiWorkerPending.set(id,{resolve,reject,timer});try{worker.postMessage({id,method,args})}catch(error){clearTimeout(timer);emojiWorkerPending.delete(id);reject(error)}});
}
function emojiWorkerCall(method, ...args) {
  const worker=ensureEmojiWorker();if(!worker)return Promise.resolve().then(()=>emojiCatalog[method](...args));
  return emojiWorkerRequest(worker,method,args).catch(error=>{console.warn('[emoji api] worker request failed:',error?.message||error);if(emojiWorker===worker)void stopEmojiWorker(error);const retry=ensureEmojiWorker();return retry&&retry!==worker?emojiWorkerRequest(retry,method,args):method==='search'?{items:[],nextCursor:null,total:0,stale:true}:method==='stats'?{total:0,animated:0,cacheBytes:0,cacheFiles:0,updatedAt:0,source:'api'}:null});
}
function refreshEmojiCatalog(force=false){
  if(!emojiRefreshPromise)emojiRefreshPromise=emojiCatalog.refresh({force}).catch(error=>{console.warn('[emoji api] refresh failed:',error?.message||error);return emojiCatalog.stats()}).finally(()=>{emojiRefreshPromise=null});
  return emojiRefreshPromise;
}
async function ensureEmojiCatalog(){const current=emojiCatalog.stats();if(!current.total)await refreshEmojiCatalog(true);else if(!current.updatedAt||Date.now()-current.updatedAt>6*60*60*1000)void refreshEmojiCatalog(false);return emojiCatalog.stats()}
// NVIDIA Broadcast/NVBroadcast can expose a virtual audio/render surface that
// contains a monitored microphone. It must stay out of both the window picker
// and the Linux PipeWire share route, otherwise a local voice echo is possible.
function isNvidiaBroadcastLabel(...values) { return values.some(value => /(?:nvidia[\s._-]*broadcast|nvbroadcast)/i.test(String(value || ''))); }
function isExcludedShareSource(source) { return isNvidiaBroadcastLabel(source?.name); }
function pipewireAsync(command, args) { return new Promise(resolve => execFile(command, args, { encoding: 'utf8', timeout: 2500, maxBuffer: 4*1024*1024 }, (error, stdout) => resolve(error ? '' : String(stdout || '').trim()))); }
function pipewireOkAsync(command, args) { return new Promise(resolve => execFile(command, args, { timeout: 2500 }, error => resolve(!error))); }
function pairProcessTree(output) {
  const rows = String(output || '').split(/\n+/).map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 2 && row.every(Number.isFinite));
  const children = new Map(); for (const [pid, ppid] of rows) { const list = children.get(ppid) || []; list.push(pid); children.set(ppid, list); }
  const ids = new Set([process.pid]), todo = [process.pid]; while (todo.length) for (const child of children.get(todo.pop()) || []) if (!ids.has(child)) { ids.add(child); todo.push(child); }
  return ids;
}
async function routeLinuxDesktopAudio(state) {
  const [processes, sinks, details, inputs] = await Promise.all([
    pipewireAsync('ps', ['-eo', 'pid=,ppid=']),
    pipewireAsync('pactl', ['list', 'short', 'sinks']),
    pipewireAsync('pactl', ['list', 'sink-inputs']),
    pipewireAsync('pactl', ['list', 'short', 'sink-inputs'])
  ]);
  if (linuxShareAudio !== state) return;
  const pairPids = pairProcessTree(processes), sinkNames = new Map(sinks.split(/\n+/).map(line => line.split(/\s+/)).filter(parts => parts.length >= 2).map(parts => [parts[0], parts[1]]));
  for (const parts of inputs.split(/\n+/).map(line => line.split(/\s+/)).filter(parts => parts.length >= 2)) {
    const [id, currentSink] = parts, currentName = sinkNames.get(currentSink), block = details.match(new RegExp(`Sink Input #${id}\\n([\\s\\S]*?)(?=\\nSink Input #|$)`))?.[1] || '';
    const pid = Number(block.match(/application\.process\.id\s*=\s*"(\d+)"/)?.[1]);
    const appName = block.match(/application\.name\s*=\s*"([^"]+)"/)?.[1] || '';
    const binary = block.match(/application\.process\.binary\s*=\s*"([^"]+)"/)?.[1] || '';
    const mediaName = block.match(/media\.name\s*=\s*"([^"]+)"/)?.[1] || '';
    // Move only attributable desktop application streams. Knot and its helper
    // processes stay on the normal output, so call playback never enters the
    // share monitor. Module streams have no PID and are deliberately untouched.
    if (!pid || pairPids.has(pid) || appName === 'Knot' || binary === 'pair-p2p' || isNvidiaBroadcastLabel(appName, binary, mediaName) || !currentName || currentName === state.sink) continue;
    if (linuxShareAudio !== state) return;
    const movedOk = await pipewireOkAsync('pactl', ['move-sink-input', id, state.sink]);
    if (linuxShareAudio !== state) { if (movedOk) await pipewireOkAsync('pactl', ['move-sink-input', id, currentName]);return; }
    if (movedOk && !state.moved.some(item => item.id === id)) state.moved.push({ id, sink: currentName });
  }
}
function scheduleLinuxDesktopAudioRoute(state, delay = 80) {
  if (linuxShareAudio !== state) return;
  clearTimeout(state.routeTimer);
  // PipeWire needs a short, silent settling period after the null sink and its
  // loopback have been created. Moving live streams while that graph is still
  // negotiating can replay an invalid startup buffer at full volume.
  const warmupDelay = Math.max(0, (state.routeReadyAt || 0) - Date.now());
  const routeDelay = Math.max(delay, warmupDelay);
  state.routeTimer = setTimeout(async () => {
    state.routeTimer = null;
    if (linuxShareAudio !== state) return;
    if (state.routeRunning) { state.routeAgain = true;return; }
    state.routeRunning = true;
    try { do { state.routeAgain = false;await routeLinuxDesktopAudio(state); } while (state.routeAgain && linuxShareAudio === state); }
    finally { state.routeRunning = false; }
  }, routeDelay);
}
function startLinuxShareAudio(webContents) {
  if (process.platform !== 'linux') return Promise.resolve(null);
  // A rapid Stop -> Share must not create a second module-null-sink with the
  // same process-scoped name while the previous route is still restoring and
  // unloading. Retry only after that retirement has fully settled.
  if (linuxShareAudioStopping) return linuxShareAudioStopping.then(()=>startLinuxShareAudio(webContents));
  if (linuxShareAudio) return Promise.resolve({ label: linuxShareAudio.label, source: linuxShareAudio.source });
  if (linuxShareAudioStart) return linuxShareAudioStart;
  const generation=linuxShareAudioGeneration;
  linuxShareAudioStart=startLinuxShareAudioInner(webContents,generation).finally(()=>{linuxShareAudioStart=null});
  return linuxShareAudioStart;
}
function trimLinuxShareAudio(state, targetBytes = LINUX_AUDIO_MAX_BUFFER_BYTES) {
  let discard = Math.max(0, state.pcmBytes - targetBytes);
  while (discard > 0 && state.pcmChunks.length) {
    const head = state.pcmChunks[0], take = Math.min(discard, head.byteLength);
    if (take === head.byteLength) state.pcmChunks.shift();
    else state.pcmChunks[0] = head.subarray(take);
    state.pcmBytes -= take;discard -= take;
  }
}
function flushLinuxShareAudio(state) {
  if (linuxShareAudio !== state || !state.webContents || state.webContents.isDestroyed()) return;
  const now = Date.now();
  if (state.pcmInflight.size >= LINUX_AUDIO_MAX_INFLIGHT && state.pcmOldestInflightAt && now - state.pcmOldestInflightAt > 500) {
    // The renderer may have crashed or stalled after accepting an IPC message.
    // Drop stale accounting and audio, then probe it with current sound only.
    state.pcmInflight.clear();state.pcmOldestInflightAt = 0;
    trimLinuxShareAudio(state, LINUX_AUDIO_PACKET_BYTES * 4);
  }
  while (state.pcmInflight.size < LINUX_AUDIO_MAX_INFLIGHT && state.pcmBytes >= LINUX_AUDIO_PACKET_BYTES) {
    const packet = Buffer.allocUnsafe(LINUX_AUDIO_PACKET_BYTES);let offset = 0;
    while (offset < packet.byteLength) {
      const head = state.pcmChunks[0], take = Math.min(head.byteLength, packet.byteLength - offset);
      head.copy(packet, offset, 0, take);offset += take;state.pcmBytes -= take;
      if (take === head.byteLength) state.pcmChunks.shift();
      else state.pcmChunks[0] = head.subarray(take);
    }
    const sequence = state.pcmNextSequence++;
    const samples = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength);
    try {
      state.webContents.send('pair:linuxShareAudio', samples, { sequence, capturedAt: now });
      state.pcmInflight.add(sequence);
      if (!state.pcmOldestInflightAt) state.pcmOldestInflightAt = now;
    } catch { break; }
  }
}
async function startLinuxShareAudioInner(webContents,generation) {
  if (!/PipeWire/i.test(await pipewireAsync('pactl', ['info']))||generation!==linuxShareAudioGeneration) return null;
  const original = await pipewireAsync('pactl', ['get-default-sink']);
  if (!original) return null;
  const sink = `pair_share_${process.pid}`;
  const module = await pipewireAsync('pactl', ['load-module', 'module-null-sink', `sink_name=${sink}`, 'sink_properties=device.description=Knot_Share_Audio']);
  if (!module) return null;
  if(generation!==linuxShareAudioGeneration){await pipewireAsync('pactl',['unload-module',module]);return null}
  const capture = spawn('parec', ['--device', `${sink}.monitor`, '--format=float32le', '--rate=48000', '--channels=2', '--latency-msec=40'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if(generation!==linuxShareAudioGeneration){
    try { capture.kill('SIGKILL'); } catch {}
    await pipewireAsync('pactl',['unload-module',module]);
    return null;
  }
  // Move selected desktop streams to the private share sink, then loop that
  // monitor back once to the normal speakers. The previous combine-sink design
  // fanned every stream into two sinks; PipeWire could exhaust its playback
  // buffers on a busy call, making a burst/beep and starving the share monitor.
  // A one-way loopback keeps local playback and isolated capture independent.
  // The loopback itself is loaded below only after the monitor has settled:
  // connecting it while the graph negotiates replayed an invalid buffer into
  // the real speakers at full volume — the loud burst heard when sharing
  // started with desktop audio.
  const moved = [];
  // Capture the monitor directly instead of asking Chromium to expose it as a
  // microphone. Chromium's Linux device enumeration can omit virtual monitor
  // sources even though PipeWire created them successfully, which used to make
  // a healthy share route appear as "sound unavailable".
  // Do not redirect real desktop audio until the new monitor and loopback have
  // settled. This costs only a fraction of a second of initial share audio and
  // prevents the full-volume startup burst reported on PipeWire systems.
  const state = { original, sink, module, loop: '', capture, moved, label: 'Knot Share Audio', source: `${sink}.monitor`, webContents, watch: null, audits: [], routeTimer: null, loopTimer: null, routeRunning: false, routeAgain: false, routeReadyAt: Date.now() + 650, discardUntil: Date.now() + 250, pcmChunks: [], pcmBytes: 0, pcmInflight: new Set(), pcmOldestInflightAt: 0, pcmNextSequence: 1 };
  linuxShareAudio = state;
  if(generation!==linuxShareAudioGeneration){
    linuxShareAudio = null;
    try { capture.kill('SIGKILL'); } catch {}
    await pipewireAsync('pactl',['unload-module',module]);
    return null;
  }
  const failCaptureRoute = message => {
    if (linuxShareAudio !== state) return;
    if (webContents && !webContents.isDestroyed()) try { webContents.send('pair:linuxShareAudioError', message); } catch {}
    // Tear down the isolated route immediately if capture dies and restore any
    // desktop streams moved into it.
    stopLinuxShareAudio();
  };
  // Load the monitor→speakers loopback only after the new sink and monitor
  // have settled, but always before the first scheduled desktop-audio move
  // (routeReadyAt). Created during negotiation, it could replay an invalid
  // buffer into the real output at full volume; created against a quiet,
  // running monitor it starts silently. Failure here ends the audio route so
  // desktop sound is never stranded in the private share sink.
  state.loopTimer = setTimeout(async () => {
    state.loopTimer = null;
    if (linuxShareAudio !== state) return;
    const loop = await pipewireAsync('pactl', ['load-module', 'module-loopback', `source=${sink}.monitor`, `sink=${original}`, 'latency_msec=40']);
    if(linuxShareAudio!==state){if(loop)await pipewireAsync('pactl',['unload-module',loop]);return}
    state.loop=loop;if (!state.loop) failCaptureRoute('Could not create the Knot Share Audio loopback');
  }, 600);
  capture.stdout.on('data', chunk => {
    if (linuxShareAudio !== state || !webContents || webContents.isDestroyed()) return;
    // A fresh PipeWire monitor can emit uninitialized negotiation buffers in
    // its first moments; interpreted as float PCM those are enormous samples,
    // i.e. a full-scale blast for the peer. Drop this bounded startup window.
    if (Date.now() < state.discardUntil) return;
    state.pcmChunks.push(chunk);state.pcmBytes += chunk.byteLength;
    trimLinuxShareAudio(state);
    // One 20 ms stereo float packet per IPC message matches Opus cadence. A
    // three-packet acknowledgement window keeps a stalled renderer from making
    // Electron queue an unbounded amount of audio in its IPC transport.
    flushLinuxShareAudio(state);
  });
  let captureError = '';
  capture.stderr.setEncoding('utf8');
  capture.stderr.on('data', text => { captureError = (captureError + text).slice(-1000); });
  capture.on('error', error => failCaptureRoute(error.message));
  capture.on('exit', code => {
    if (linuxShareAudio === state) failCaptureRoute(captureError.trim() || `parec exited with code ${code ?? 'unknown'}`);
  });
  // Route newly created desktop streams too. Knot streams are always excluded
  // by process identity and application metadata.
  try {
    const watch = spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] });
    state.watch = watch;
    watch.stdout.setEncoding('utf8');
    watch.stdout.on('data', text => {
      if (linuxShareAudio === state && /sink-input/i.test(text)) scheduleLinuxDesktopAudioRoute(state);
    });
    watch.unref();
  } catch {}
  // Cover streams created between the initial move and subscription becoming
  // active; these are one-shot checks, not a constant polling loop.
  state.audits = [0, 500].map(delay => setTimeout(() => scheduleLinuxDesktopAudioRoute(state, delay ? 80 : 0), delay));
  return { label: linuxShareAudio.label, source: linuxShareAudio.source };
}
function stopLinuxShareAudio() {
  linuxShareAudioGeneration++;
  if(linuxShareAudioStopping)return linuxShareAudioStopping;
  const pendingStart=linuxShareAudioStart,state=linuxShareAudio;
  linuxShareAudio = null;
  const stopping=(async()=>{
    // If cancellation landed during capability/module discovery, wait until
    // that startup has observed the generation change and removed any module
    // it briefly created before allowing a replacement route.
    if(pendingStart)try{await pendingStart}catch{}
    if(!state)return;
    if (state.watch) try { state.watch.kill(); } catch {}
    clearTimeout(state.routeTimer);
    if (state.loopTimer) { clearTimeout(state.loopTimer); state.loopTimer = null; }
    for (const audit of state.audits || []) clearTimeout(audit);
    if (state.capture) try { state.capture.kill(); } catch {}
    state.pcmChunks.length = 0;state.pcmBytes = 0;state.pcmInflight.clear();state.pcmOldestInflightAt = 0;
    await Promise.all((state.moved || []).map(input=>pipewireOkAsync('pactl', ['move-sink-input', input.id, input.sink])));
    if (state.loop) await pipewireAsync('pactl', ['unload-module', state.loop]);
    await pipewireAsync('pactl', ['unload-module', state.module]);
  })().finally(()=>{if(linuxShareAudioStopping===stopping)linuxShareAudioStopping=null});
  linuxShareAudioStopping=stopping;return stopping;
}

function isPairRenderer(event) {
  return event.sender === mainWin?.webContents && event.senderFrame === event.sender?.mainFrame && event.senderFrame?.url === PAIR_RENDERER_URL;
}
const SETTING_KEYS = new Set(['signalServer', 'roomCode', 'volume', 'screenVol', 'profileAvatar', 'profileFrame', 'profileIdentity', 'profileName', 'profilePhotoMode', 'theme', 'fontFamily', 'savedInviteCode', 'inputDevice', 'outputDevice', 'voiceProcessing', 'noiseReduction', 'noiseHardware', 'voiceInputMode', 'pushToTalkKey', 'pushToTalkDelay', 'soundEffects', 'shareProfile', 'rememberInvite', 'rememberAccount', 'reduceMotion', 'hardwareAcceleration', 'fileTransport', 'tcpListenPort', 'encryptedFileRelay', 'groupSfuPilot', 'screenBitrate', 'screenBitrateExplicit', 'screenCursor', 'screenContentHint', 'screenCodec', 'shareResolution', 'shareResolutionExplicit', 'shareFrameRate', 'shareSystemAudio', 'directoryUserId', 'directoryToken', 'directoryAccountName', 'accountOnboardingDismissed', 'closedDmIds', 'unreadDmCounts', 'directoryRosterCache', 'socialSidebarCollapsed', 'socialSidebarWidth', 'dmCallPanelHeight', 'messageHistory', 'serverMembersCollapsed', 'deviceIdentityPrivate', 'serverTextKeys', 'serverTextMembership', 'emojiRecents']);
const ENCRYPTED_SETTING_KEYS = new Set(['directoryToken', 'savedInviteCode', 'messageHistory', 'deviceIdentityPrivate', 'serverTextKeys']);
const MAX_SETTING_VALUE = 7 * 1024 * 1024;
const MAX_IPC_CHUNK = 8 * 1024 * 1024;
const MAX_FILE_SIZE = 200 * 1024 ** 3;
const DIRECT_FILE_DEFAULT_PORT = 8787;
const MAX_SYSTEM_AVATAR_SIZE = 5 * 1024 * 1024;
const MAX_SHARE_SOURCES = 64;
const DEEPFILTER_ASSETS = Object.freeze({
  wasm: path.join(__dirname, 'build', 'deepfilternet', 'v3', 'pkg', 'df_bg.wasm'),
  model: path.join(__dirname, 'build', 'deepfilternet', 'v3', 'models', 'DeepFilterNet3_onnx.tar.gz')
});
const MAX_DEEPFILTER_ASSET_SIZE = 20 * 1024 * 1024;
function validBridgeDocumentId(value) { return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : ''; }
function validIpcBinary(value, maxBytes = MAX_IPC_CHUNK) {
  try {
    const validType = Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
    return validType && Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= maxBytes;
  } catch { return false; }
}
const SYSTEM_AVATAR_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
function imageMime(buffer, extension = '') {
  if (SYSTEM_AVATAR_MIME[extension]) return SYSTEM_AVATAR_MIME[extension];
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('ascii').startsWith('GIF')) return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function accountAvatarCandidates(dir, depth = 1) {
  let entries = [];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const candidates = await Promise.all(entries.map(async entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) return accountAvatarCandidates(file, depth - 1);
    if (!entry.isFile() || !SYSTEM_AVATAR_MIME[path.extname(entry.name).toLowerCase()]) return [];
    try {
      const stat = await fs.promises.stat(file);
      return stat.size > 0 && stat.size <= MAX_SYSTEM_AVATAR_SIZE ? [{ file, stat }] : [];
    } catch { return []; }
  }));
  return candidates.flat();
}

async function systemAccountAvatar() {
  const home = app.getPath('home');
  const direct = process.platform === 'linux' ? [path.join(home, '.face'), path.join(home, '.face.icon')] : [];
  const directories = process.platform === 'win32'
    ? [path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'AccountPictures'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'AccountPictures')]
    : [];
  const candidates = [
    ...(await Promise.all(direct.map(async file => {
      try { const stat = await fs.promises.stat(file); return stat.isFile() && stat.size > 0 && stat.size <= MAX_SYSTEM_AVATAR_SIZE ? [{ file, stat }] : []; } catch { return []; }
    }))).flat(),
    ...(await Promise.all(directories.map(dir => accountAvatarCandidates(dir)))).flat()
  ].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.stat.size - a.stat.size);
  const selected = candidates[0];
  if (!selected) return null;
  try {
    const bytes = await fs.promises.readFile(selected.file);
    const mime = imageMime(bytes, path.extname(selected.file).toLowerCase());
    return mime ? `data:${mime};base64,${bytes.toString('base64')}` : null;
  } catch { return null; }
}

ipcMain.handle('pair:getSources', async event => {
  if (!isPairRenderer(event)) return [];
  pendingSources = (await desktopCapturer.getSources({ types: ['screen', 'window'], fetchWindowIcons: false, thumbnailSize: { width: 240, height: 180 } })).filter(source => !isExcludedShareSource(source)).slice(0,MAX_SHARE_SOURCES);
  return pendingSources.map(s => ({ id: s.id, name: s.name, type: s.id.startsWith('screen:') ? 'screen' : 'application', thumbnail: s.thumbnail.toDataURL(), display_id: s.display_id }));
});
ipcMain.handle('pair:getSystemAvatar', event => isPairRenderer(event) ? systemAccountAvatar() : null);
// DeepFilterNet's model is shipped with Knot.  The renderer may request only
// these two known files, never an arbitrary local path or a network URL.
ipcMain.handle('pair:getDeepFilterAsset', async (event, name) => {
  if (!isPairRenderer(event) || !Object.hasOwn(DEEPFILTER_ASSETS, name)) return null;
  try {
    const bytes = await fs.promises.readFile(DEEPFILTER_ASSETS[name]);
    return bytes.length > 0 && bytes.length <= MAX_DEEPFILTER_ASSET_SIZE ? bytes : null;
  } catch { return null; }
});
ipcMain.handle('pair:setPendingSource', (event, selection) => {
  if (!isPairRenderer(event)) return false;
  if (selection == null) { pendingSource = null; pendingSources = []; return true; }
  if (!selection || typeof selection.id !== 'string') return false;
  const source = pendingSources.find(item => item.id === selection.id);
  if (!source || isExcludedShareSource(source)) return false;
  // Keep immutable source identity as well as Electron's transient id. Windows
  // can recreate an HWND capture source between the picker and getDisplayMedia.
  pendingSource = { id: source.id, displayId: String(source.display_id || ''), type: source.id.startsWith('screen:') ? 'screen' : 'application', name: String(source.name || '') };
  return true;
});
ipcMain.handle('pair:startLinuxShareAudio', event => isPairRenderer(event) ? startLinuxShareAudio(event.sender) : null);
ipcMain.on('pair:stopLinuxShareAudio', event => { if (isPairRenderer(event)) void stopLinuxShareAudio(); });
ipcMain.on('pair:linuxShareAudioAck', (event, sequenceValue) => {
  if (!isPairRenderer(event)) return;
  const state = linuxShareAudio, sequence = Math.floor(Number(sequenceValue) || 0);
  if (!state || state.webContents !== event.sender || !state.pcmInflight.delete(sequence)) return;
  state.pcmOldestInflightAt = state.pcmInflight.size ? Date.now() : 0;
  flushLinuxShareAudio(state);
});
ipcMain.handle('pair:nativeScreenInfo', (event, documentId) => bridgeRequestOwner(event,documentId) ? nativeScreenService?.infoAsync() || { supported: false } : { supported: false });
ipcMain.handle('pair:startNativeScreen', (event, documentId, options) => {
  const owner=bridgeRequestOwner(event,documentId);
  if (!owner || !options || typeof options !== 'object') return null;
  const started=nativeScreenService?.startAsync(options,()=>currentBridgeOwner(owner)).then(result=>{
    // Native capture never consumes picker NativeImages. Drop them so a live
    // share does not keep 64 window thumbnails pinned in the main process.
    if(result&&!result.error)pendingSources=[];
    return result;
  }).catch(error=>({error:error?.message||String(error)}));
  return started || { error: 'Native screen capture is unavailable' };
});
ipcMain.handle('pair:readNativeScreen', (event, documentId, id) => bridgeRequestOwner(event,documentId) && Number.isInteger(id) ? nativeScreenService?.read(id) || { active: false } : { active: false });
ipcMain.handle('pair:readNativeScreenMany', (event, documentId, id, options) => bridgeRequestOwner(event,documentId) && Number.isInteger(id) ? nativeScreenService?.readMany(id, options) || { active: false, items: [] } : { active: false, items: [] });
ipcMain.on('pair:stopNativeScreen', (event, documentId, id) => { if (bridgeRequestOwner(event,documentId)) nativeScreenService?.stop(Number.isInteger(id) ? id : 0); });

const fs = require('fs');
// Electron only accepts this before its ready event. Read the tightly scoped
// local setting early; toggling it in the UI takes effect on restart.
let hardwareAccelerationEnabled = true;
try {
  const stableSettings=path.join(app.getPath('appData'),'Knot','settings.json'),legacySettings=path.join(app.getPath('userData'),'settings.json'),earlyFile=[stableSettings,stableSettings+'.bak',legacySettings].find(file=>fs.existsSync(file));
  const earlySettings = earlyFile?JSON.parse(fs.readFileSync(earlyFile, 'utf8')):{};
  hardwareAccelerationEnabled = earlySettings.hardwareAcceleration !== 'off';
  if (!hardwareAccelerationEnabled) app.disableHardwareAcceleration();
} catch {}
// Apply the acceleration policy only when the setting is on. Linux prefers and
// pins a discrete render node, while integrated-only machines retain their real
// compositor/video GPU instead of being forced through CPU rendering.
if (hardwareAccelerationEnabled) {
  const wayland = process.platform === 'linux' && !!(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY);
  if (process.platform === 'linux') {
    const primaryGpu = linuxMainGpu();selectedPrimaryGpu=primaryGpu;
    if (applyLinuxMainGpuEnvironment(primaryGpu) && applyGpuAccelerationPolicy(app, { platform: process.platform, gpu: primaryGpu, wayland })) {
      console.log('[gpu] full acceleration selected:', primaryGpu.renderNode, primaryGpu.vendor, primaryGpu.pciAddress, primaryGpu.integrated?'integrated':'discrete');
    } else {
      // No usable DRM render node exists. Retain the explicit user-facing
      // software fallback rather than letting Chromium choose unpredictably.
      app.disableHardwareAcceleration();
      process.env.KNOT_PRIMARY_GPU_VENDOR = '';
      console.warn('[gpu] no render node found; using CPU rendering');
    }
  } else {
    // Windows/macOS expose their high-performance adapter through Chromium's
    // platform backend. The same policy covers D3D/Metal compositing, raster,
    // canvas, zero-copy surfaces, and platform video acceleration.
    applyGpuAccelerationPolicy(app, { platform: process.platform });
  }
}
nativeScreenService = new NativeScreenService({
  // gpu-screen-recorder's encode-once path remains discrete-only. Integrated
  // GPUs still accelerate Chromium's standard WebRTC screen path above.
  primaryGpuVendor: selectedPrimaryGpu?.integrated ? '' : process.env.KNOT_PRIMARY_GPU_VENDOR || '',
  primaryGpuCard: selectedPrimaryGpu?.card || '',
  onError: message => {if(mainWin&&!mainWin.isDestroyed())try{mainWin.webContents.send('pair:nativeScreenError', String(message || 'Native screen capture failed'))}catch{}}
});
// Knot is serverless by default. `server.js` remains available through
// `npm run signal` for people who deliberately operate their own signaling
// service, but the desktop app must not silently start a localhost server.

// --- Incoming-file disk streaming (isolated per transfer) ---
// The renderer is sandboxed, so all fs access happens here. `write` resolves
// only when the OS accepts the chunk or 'drain' fires — that backpressure
// flows back through the renderer and WebRTC to the sender.
const WRITE_HIGH_WATER = 64 * 1024 * 1024;
const MAX_ACTIVE_SAVE_STREAMS = 16;
const saveStreams = new SaveStreamManager({ maxActive: MAX_ACTIVE_SAVE_STREAMS, highWater: WRITE_HIGH_WATER });
const pendingSaveDialogs = new Map();
const cancelledSaveDialogs = new Set();
const saveOwners = new Map();
let activeBridgeOwner = null;
function sameBridgeOwner(left,right){return !!left&&!!right&&left.senderId===right.senderId&&left.document===right.document}
function bridgeOwnerCandidate(event,documentId){const document=validBridgeDocumentId(documentId);return document&&isPairRenderer(event)?{senderId:event.sender.id,document}:null}
function currentBridgeOwner(owner){return sameBridgeOwner(owner,activeBridgeOwner)&&mainWin&&!mainWin.isDestroyed()&&mainWin.webContents.id===owner.senderId&&mainWin.webContents.mainFrame?.url===PAIR_RENDERER_URL}
function bridgeRequestOwner(event,documentId){const owner=bridgeOwnerCandidate(event,documentId);return owner&&currentBridgeOwner(owner)?owner:null}
function invalidateBridgeOwner(webContents=null){if(activeBridgeOwner&&(!webContents||webContents.id===activeBridgeOwner.senderId))activeBridgeOwner=null}
ipcMain.on('pair:bridgeReady',(event,documentId)=>{
  const owner=bridgeOwnerCandidate(event,documentId);if(!owner)return;
  const replaced=activeBridgeOwner&&!sameBridgeOwner(owner,activeBridgeOwner);activeBridgeOwner=owner;
  // did-start-navigation normally starts this cleanup first. Repeating it here
  // closes the narrow race where a new preload starts after an unusual renderer
  // replacement that did not emit a usable navigation event.
  if(replaced){
    pendingSource=null;pendingSources=[];
    void nativeScreenService?.stopAsync?.().catch(error=>console.error('[runtime] bridge screen cleanup failed:',error?.message||error));
    void stopLinuxShareAudio().catch(error=>console.error('[runtime] bridge share-audio cleanup failed:',error?.message||error));
    stopNativeCapture();
    void closeDirectFileRuntime().catch(()=>{});void closeAllSaveStreams().catch(()=>{});
    void closeLanHouse().catch(()=>{});
  }
});
function validSaveId(value) { return Number.isSafeInteger(value) && value > 0 ? value : 0; }
function saveRequestOwner(event, documentId) { return bridgeRequestOwner(event,documentId); }
function saveOwnerKey(owner,id){return owner?`${owner.senderId}:${owner.document}:${id}`:''}
function ownsSave(event,documentId,id){const owner=saveRequestOwner(event,documentId),record=saveOwners.get(id);return owner&&record&&record.senderId===owner.senderId&&record.document===owner.document?record:null}
async function closeAllSaveStreams() {
  for (const [id, owner] of pendingSaveDialogs) cancelledSaveDialogs.add(saveOwnerKey(owner,id));
  await saveStreams.closeAll();
  saveOwners.clear();
  if (!pendingSaveDialogs.size) cancelledSaveDialogs.clear();
}

ipcMain.handle('pair:saveStart', async (event, documentId, idValue, name, sizeValue) => {
  const owner=saveRequestOwner(event,documentId),id=validSaveId(idValue),size=Number(sizeValue);
  if(!owner||!id||typeof name!=='string'||!name.length||name.length>255||!Number.isSafeInteger(size)||size<0||size>MAX_FILE_SIZE||saveStreams.has(id)||saveOwners.has(id)||pendingSaveDialogs.has(id)||saveStreams.size+pendingSaveDialogs.size>=MAX_ACTIVE_SAVE_STREAMS)return{ok:false,error:'Invalid or duplicate save request'};
  pendingSaveDialogs.set(id,owner);const cancellationKey=saveOwnerKey(owner,id);let result=null,dialogError=null;
  try {
    const options={ title: 'Save incoming file', defaultPath: safeSuggestedFileName(name), buttonLabel: 'Save' };
    result=mainWin&&!mainWin.isDestroyed()?await dialog.showSaveDialog(mainWin,options):await dialog.showSaveDialog(options);
  } catch (error) {
    dialogError=error;
  } finally {
    pendingSaveDialogs.delete(id);
  }
  const cancelled=cancelledSaveDialogs.delete(cancellationKey);if(!pendingSaveDialogs.size&&cancelledSaveDialogs.size)cancelledSaveDialogs.clear();
  if(dialogError)return{ok:false,error:'Could not open the Save dialog'};
  if(cancelled||event.sender.isDestroyed()||!currentBridgeOwner(owner)||result?.canceled||!result?.filePath)return{ok:false};
  try {
    await saveStreams.open(id,result.filePath,{expectedSize:size});
    if(!currentBridgeOwner(owner)){await saveStreams.cancel(id);return{ok:false};}
    saveOwners.set(id,{...owner,size});
  }
  catch(error){return{ok:false,error:error?.message||'Could not open the save destination'};}
  return { ok: true, path: result.filePath };
});

ipcMain.handle('pair:saveWrite', async (event, documentId, idValue, buf) => {
  const id=validSaveId(idValue);if(!id||!ownsSave(event,documentId,id)||!validIpcBinary(buf))throw new Error('invalid file chunk');
  return saveStreams.write(id,buf);
});

ipcMain.handle('pair:saveEnd', async (event, documentId, idValue, sizeValue) => {
  const id=validSaveId(idValue),owner=id?ownsSave(event,documentId,id):null,size=Number(sizeValue);if(!owner||!Number.isSafeInteger(size)||size!==owner.size)return false;
  try{return await saveStreams.finish(id)}finally{saveOwners.delete(id)}
});

ipcMain.handle('pair:saveCancel', async (event,documentId,idValue) => {
  const owner=saveRequestOwner(event,documentId),id=validSaveId(idValue);if(!owner||!id)return false;
  const pending=pendingSaveDialogs.get(id);if(pending&&pending.senderId===owner.senderId&&pending.document===owner.document){cancelledSaveDialogs.add(saveOwnerKey(owner,id));return true}
  if(!ownsSave(event,documentId,id))return false;try{return await saveStreams.cancel(id)}finally{saveOwners.delete(id)}
});

// Optional native TCP lane for large P2P files. The renderer can register only
// one-time credentials generated from an already authenticated paired session;
// this listener never accepts arbitrary unauthenticated traffic.
let directFileHost = null, directFilePort = 0;
let directFileHostEpoch = 0;
let directFileHostTask = Promise.resolve();
let directFileRuntimeOwner = null;
const directFilePeers = new Map();
let pendingDirectFileConnects = 0;
const MAX_DIRECT_FILE_PEERS = 8;
const MAX_PENDING_DIRECT_FILE_CONNECTS = 4;
function validDirectPort(value) { const port = Number(value); return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0; }
function directKey(value) { try { if(!validIpcBinary(value,32)||value.byteLength!==32)return null;const view=value instanceof ArrayBuffer?new Uint8Array(value):new Uint8Array(value.buffer,value.byteOffset,value.byteLength);return Buffer.from(view); } catch { return null; } }
function directRequestOwner(event,documentId){return bridgeRequestOwner(event,documentId)}
function sameDirectOwner(left,right){return sameBridgeOwner(left,right)}
function closeDirectPeer(id,owner=null) { const record=directFilePeers.get(id);if(!record||owner&&!sameDirectOwner(owner,record.owner))return false;directFilePeers.delete(id);try{record.peer.close()}catch{}return true }
function attachDirectPeer(webContents, owner, peer, context={}) {
  if(!currentBridgeOwner(owner)||webContents.isDestroyed()||webContents.id!==owner.senderId||directFilePeers.size>=MAX_DIRECT_FILE_PEERS){try{peer.close()}catch{}throw new Error('direct-file document changed or peer limit reached')}
  const id = crypto.randomBytes(16).toString('hex'),record={peer,owner};directFilePeers.set(id,record);
  peer.onFrame = frame => { if (!webContents.isDestroyed()&&currentBridgeOwner(owner)&&directFilePeers.get(id)===record) webContents.send('pair:directFileFrame',owner.document,id,frame); };
  peer.onClose = () => { const attached=directFilePeers.get(id)===record;if(attached)directFilePeers.delete(id);if(attached&&!webContents.isDestroyed()&&currentBridgeOwner(owner)) webContents.send('pair:directFileClose',owner.document,id); };
  try {
    if(!currentBridgeOwner(owner)||webContents.isDestroyed())throw new Error('direct-file document changed');
    webContents.send('pair:directFileOpen',owner.document,id,typeof context.token==='string'?context.token:'');
  } catch(error) {
    if(directFilePeers.get(id)===record)directFilePeers.delete(id);
    try{peer.close()}catch{}
    throw error;
  }
  return id;
}
async function ensureDirectFileHost(port) {
  const epoch = directFileHostEpoch;
  const operation = directFileHostTask.then(async () => {
    if (epoch !== directFileHostEpoch) throw new Error('direct-file listener was stopped');
    if (directFileHost && directFilePort === port) return;
    if (directFileHost) { directFileHost.close(); directFileHost = null; directFilePort = 0; }
    const host = new DirectFileHost(port);
    try {
      await host.listen();
      if (epoch !== directFileHostEpoch) throw new Error('direct-file listener was stopped');
      directFileHost = host;directFilePort = port;
    } catch (error) {
      host.close();
      throw error;
    }
  });
  directFileHostTask = operation.catch(() => {});
  return operation;
}
async function closeDirectFileRuntime() {
  directFileHostEpoch++;
  for (const id of [...directFilePeers.keys()]) closeDirectPeer(id);
  directFileRuntimeOwner=null;
  const operation=directFileHostTask.then(()=>{directFileHost?.close();directFileHost=null;directFilePort=0});
  directFileHostTask=operation.catch(()=>{});return operation;
}
ipcMain.handle('pair:directFileListen', async (event, documentId, portValue) => {
  const owner=directRequestOwner(event,documentId);if (!owner) return { ok: false, error: 'unauthorized' };
  const port = validDirectPort(portValue); if (!port) return { ok: false, error: 'Choose a port from 1024 through 65535.' };
  try {
    if(directFileRuntimeOwner&&!sameDirectOwner(owner,directFileRuntimeOwner))await closeDirectFileRuntime();
    if(!currentBridgeOwner(owner))throw new Error('direct-file document changed');
    directFileRuntimeOwner=owner;await ensureDirectFileHost(port);
    if(!currentBridgeOwner(owner)||!sameDirectOwner(owner,directFileRuntimeOwner)){if(sameDirectOwner(owner,directFileRuntimeOwner))await closeDirectFileRuntime();throw new Error('direct-file document changed')}
    return { ok: true, port };
  } catch (error) { return { ok: false, error: error?.message || 'Could not listen on that TCP port.' }; }
});
ipcMain.handle('pair:directFileRegister', async (event, documentId, token, keyValue) => {
  const owner=directRequestOwner(event,documentId);if (!owner||!sameDirectOwner(owner,directFileRuntimeOwner)||typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return false;
  const key = directKey(keyValue); if (!key) return false;if(!directFileHost){key.fill(0);return false}
  try{directFileHost.register(token,key,(peer,hello)=>{if(!currentBridgeOwner(owner)||!sameDirectOwner(owner,directFileRuntimeOwner)){peer.close();return}attachDirectPeer(event.sender,owner,peer,hello)});return true}finally{key.fill(0)}
});
ipcMain.handle('pair:directFileConnect', async (event, documentId, host, portValue, token, keyValue, options) => {
  const owner=directRequestOwner(event,documentId);if (!owner||typeof host !== 'string' || !nodeNet.isIP(host) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('invalid direct-file connection');
  const port = validDirectPort(portValue), key = directKey(keyValue); if (!port || !key){if(key)key.fill(0);throw new Error('invalid direct-file credentials')}
  if(directFilePeers.size+pendingDirectFileConnects>=MAX_DIRECT_FILE_PEERS||pendingDirectFileConnects>=MAX_PENDING_DIRECT_FILE_CONNECTS){key.fill(0);throw new Error('too many direct-file connections')}
  const requestedTimeout = Number(options?.timeout);
  const connectOptions = Number.isFinite(requestedTimeout) ? { timeout: Math.max(1000, Math.min(10000, Math.floor(requestedTimeout))) } : {};
  const epoch=directFileHostEpoch;let peer;pendingDirectFileConnects++;
  try{peer=await connectDirectFile(host,port,token,key,connectOptions)}finally{pendingDirectFileConnects--;key.fill(0)}
  if(epoch!==directFileHostEpoch||!currentBridgeOwner(owner)){peer.close();throw new Error('direct-file document changed')}
  return attachDirectPeer(event.sender,owner,peer,{token});
});
ipcMain.handle('pair:directFileSend', async (event, documentId, id, data) => {
  const owner=directRequestOwner(event,documentId),record=directFilePeers.get(id);if (!owner||typeof id !== 'string'||!sameDirectOwner(owner,record?.owner)||!validIpcBinary(data)) throw new Error('invalid direct-file frame');
  // Buffer.from(DataView) produces an empty buffer on Node. Normalize every
  // IPC binary shape to its explicit byte range before the native lane copies
  // it, otherwise a valid DataView frame is rejected as zero length.
  const bytes=data instanceof ArrayBuffer?new Uint8Array(data):new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
  await record.peer.sendAsync(bytes); return true;
});
ipcMain.on('pair:directFileClose', (event, documentId, id) => {const owner=directRequestOwner(event,documentId);if(owner&&typeof id==='string')closeDirectPeer(id,owner)});
ipcMain.handle('pair:directFileReset', async(event,documentId)=>{const owner=directRequestOwner(event,documentId);if(!owner)return false;if(directFileRuntimeOwner&&!sameDirectOwner(owner,directFileRuntimeOwner)&&![...directFilePeers.values()].some(record=>sameDirectOwner(owner,record.owner)))return false;await closeDirectFileRuntime();return true});
// Renderer acknowledgement of consumed file frames. This bounds the IPC queue
// between the TCP lane and slow disk writes instead of letting pending frames
// grow without limit during very large transfers.
ipcMain.on('pair:directFileAck', (event, documentId, id, bytes) => {
  const owner=directRequestOwner(event,documentId),record=directFilePeers.get(id),count=Number(bytes);if(!owner||!sameDirectOwner(owner,record?.owner)||!Number.isSafeInteger(count)||count<1||count>MAX_IPC_CHUNK)return;
  record.peer.credit(count);
});

let lanHouse = null, lanOwner = null;
function lanFrameOk(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.t !== 'string' || value.t.length > 32) return false;
  try { return JSON.stringify(value).length <= 48 * 1024; } catch { return false; }
}
function emitLan(channel, ...args) {
  if (!lanOwner || !mainWin || mainWin.isDestroyed() || !currentBridgeOwner(lanOwner)) return;
  try { mainWin.webContents.send(channel, lanOwner.document, ...args); } catch {}
}
function attachLanPeer(peer) {
  peer.onFrame = value => { if (lanFrameOk(value)) emitLan('pair:lanFrame', peer.id, value); };
  const previousClose = peer.onClose;
  peer.onClose = () => { try { previousClose?.(); } catch {} emitLan('pair:lanClose', peer.id); };
  emitLan('pair:lanPeer', { id: peer.id, host: peer.host, port: peer.port, localAddress: peer.localAddress || '', incoming: !!peer.incoming });
}
async function closeLanHouse() {
  const house = lanHouse; lanHouse = null; lanOwner = null;
  try { house?.close(); } catch {}
}
ipcMain.handle('pair:lanStart', async (event, documentId) => {
  const owner = bridgeRequestOwner(event, documentId); if (!owner) return { ok: false };
  if (lanOwner && !sameBridgeOwner(owner, lanOwner)) await closeLanHouse();
  if (!lanHouse) {
    const house = new LanHouse();
    house.onBeacon = beacon => emitLan('pair:lanBeacon', beacon);
    house.onPeer = attachLanPeer;
    try { await house.start(); } catch (error) { return { ok: false, error: error?.message || 'LAN house failed to start' }; }
    lanHouse = house;
  }
  lanOwner = owner;
  return { ok: true, port: lanHouse.tcpPort, addresses: localIpv4() };
});
ipcMain.handle('pair:lanStop', async (event, documentId) => {
  const owner = bridgeRequestOwner(event, documentId); if (!owner || (lanOwner && !sameBridgeOwner(owner, lanOwner))) return false;
  await closeLanHouse(); return true;
});
ipcMain.handle('pair:lanSetBeacon', async (event, documentId, fp, nonce) => {
  const owner = bridgeRequestOwner(event, documentId);
  if (!owner || !sameBridgeOwner(owner, lanOwner) || !lanHouse || typeof fp !== 'string' || !/^[a-f0-9]{32}$/.test(fp) || typeof nonce !== 'string' || !/^[a-f0-9]{16,64}$/.test(nonce)) return false;
  return lanHouse.setBeacon(fp, nonce);
});
ipcMain.handle('pair:lanConnect', async (event, documentId, host, portValue) => {
  const owner = bridgeRequestOwner(event, documentId), port = Number(portValue);
  if (!owner || !sameBridgeOwner(owner, lanOwner) || !lanHouse || !privateIpv4(host) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('LAN peer is not on this network');
  const peer = await lanHouse.connect(host, port);
  return { id: peer.id, host: peer.host, port: peer.port, localAddress: peer.localAddress || '', incoming: false };
});
ipcMain.handle('pair:lanSend', async (event, documentId, id, value) => {
  const owner = bridgeRequestOwner(event, documentId);
  if (!owner || !sameBridgeOwner(owner, lanOwner) || !lanHouse || typeof id !== 'string' || !lanFrameOk(value)) return false;
  return lanHouse.send(id, value);
});
ipcMain.on('pair:lanClose', (event, documentId, id) => {
  const owner = bridgeRequestOwner(event, documentId);
  if (owner && sameBridgeOwner(owner, lanOwner) && typeof id === 'string') lanHouse?.closePeer(id);
});

// --- Settings persistence (sandboxed renderer can't rely on localStorage) ---
// Writes/reads a small JSON file in the app's userData directory so room code
// and signaling address survive restarts even in sandboxed Electron on file://.
// Defer app.getPath until first use (module-level call may throw before ready).
let _sp = null;
function sp() {
  if (!_sp) {
    // Keep the Cloudflare identity in one product-name-independent location.
    // Rebranding Pair to Knot changed Electron's default userData folder, which
    // looked like every server disappeared because a new directory identity was
    // generated. Updates now reuse this stable folder and migrate older builds.
    const appData = app.getPath('appData');
    const stableDir = path.join(appData, 'Knot');
    _sp = path.join(stableDir, 'settings.json');
    try {
      fs.mkdirSync(stableDir, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(_sp)) {
        const candidates = [app.getPath('userData'), path.join(appData, 'Pair'), path.join(appData, 'pair-p2p'), path.join(appData, 'pair')];
        const legacy = [...new Set(candidates)].map(dir => path.join(dir, 'settings.json')).find(file => file !== _sp && fs.existsSync(file));
        if (legacy) fs.copyFileSync(legacy, _sp);
      }
    } catch {}
  }
  return _sp;
}
const settingsStore = new SettingsStore(sp);
const settingsCipher = new LocalSettingsCipher(() => path.join(path.dirname(sp()), 'settings.key'), { vault: safeStorage });
const historyStore = new EncryptedHistoryStore(() => path.join(path.dirname(sp()), 'history.db'), { keyProvider: () => settingsCipher.key() });
const metricsStore = new LocalMetricsStore(() => path.join(path.dirname(sp()), 'metrics.db'));
// The AES key is wrapped by Electron safeStorage when the OS vault is available.
// Existing raw 32-byte keys migrate in place after their first successful read;
// systems without vault support retain the mode-0600 compatibility fallback.
const PLAIN_V1 = 'plain-v1';
async function revealSetting(value) {
  if (value == null) return undefined;
  if (typeof value === 'string') return value; // legacy raw plaintext from very old builds
  if (value.format === LOCAL_SETTINGS_FORMAT) {
    try { return await settingsCipher.reveal(value); } catch { return undefined; }
  }
  if (value.format === PLAIN_V1 && typeof value.data === 'string') {
    try { return Buffer.from(value.data, 'base64').toString('utf8'); } catch { return undefined; }
  }
  if (value.format === 'safeStorage-v1' && typeof value.data === 'string') {
    try { return safeStorage.decryptString(Buffer.from(value.data, 'base64')); } catch { return undefined; }
  }
  return undefined;
}
ipcMain.handle('pair:getSetting', async (event, key) => {
  if (!isPairRenderer(event) || !SETTING_KEYS.has(key)) return undefined;
  const stored = await settingsStore.get(key);
  const value = await revealSetting(stored);
  if (value != null && ENCRYPTED_SETTING_KEYS.has(key) && stored?.format !== LOCAL_SETTINGS_FORMAT) {
    try { await settingsStore.set(key, await settingsCipher.protect(value)); } catch {}
  }
  return value;
});
ipcMain.handle('pair:setSetting', async (event, key, value) => {
  if (!isPairRenderer(event) || !SETTING_KEYS.has(key)) return false;
  if (value != null && (typeof value !== 'string' || value.length > MAX_SETTING_VALUE)) return false;
  let stored = value;
  if (value != null && ENCRYPTED_SETTING_KEYS.has(key)) {
    try { stored = await settingsCipher.protect(value); } catch { return false; }
  }
  return settingsStore.set(key, stored);
});
ipcMain.on('pair:metricRecord',(event,name,value,tags)=>{if(isPairRenderer(event))metricsStore.record(name,value,tags)});
ipcMain.handle('pair:metricSummary',(event,hours)=>isPairRenderer(event)?metricsStore.summary({hours}):{localOnly:true,hours:24,samples:0,metrics:{}});
ipcMain.handle('pair:historyAppend',async(event,owner,conversation,entry)=>{
  if(!isPairRenderer(event)||!validHistoryScope(owner,conversation))return{added:0};let size=Infinity;try{size=Buffer.byteLength(JSON.stringify(entry),'utf8')}catch{}if(size>MAX_HISTORY_ENTRY_BYTES)return{added:0};const started=performance.now();try{return await historyStore.append(owner,conversation,entry)}finally{metricsStore.record('history.append_ms',performance.now()-started)}
});
ipcMain.handle('pair:historyList',async(event,owner,conversation,options)=>{
  if(!isPairRenderer(event)||!validHistoryScope(owner,conversation))return{items:[],nextBefore:null,hasOlder:false};const started=performance.now();try{return await historyStore.list(owner,conversation,options||{})}finally{metricsStore.record('history.read_ms',performance.now()-started)}
});
ipcMain.handle('pair:historyImport',async(event,owner,histories)=>{
  if(!isPairRenderer(event)||!/^[a-f0-9]{32}$/.test(String(owner||'')))return false;let size=Infinity;try{size=Buffer.byteLength(JSON.stringify(histories),'utf8')}catch{}if(size>MAX_SETTING_VALUE)return false;return historyStore.importLegacy(owner,histories)
});

// Updates are checked by the main process on launch. The renderer can only
// accept a manifest already verified by that process; it cannot influence the
// feed URL, package URL, or installer invocation.
const { startAutoUpdater, getUpdateStatus, installAvailableUpdate } = require('./updater');
ipcMain.handle('pair:getUpdateStatus', event => isPairRenderer(event) ? getUpdateStatus() : { state: 'idle' });
ipcMain.handle('pair:acceptUpdate', event => isPairRenderer(event) ? installAvailableUpdate() : false);
let runtimeCleanupPromise=null,relaunching=false;
async function cleanupRuntime(){
  if(runtimeCleanupPromise)return runtimeCleanupPromise;
  runtimeCleanupPromise=(async()=>{await nativeScreenService?.stopAsync?.();await stopLinuxShareAudio();await closeDirectFileRuntime();await closeLanHouse();await closeAllSaveStreams();await settingsStore.flush();historyStore.close();metricsStore.close();await stopEmojiWorker();emojiCatalog.close();stopNativeCapture()})().finally(()=>{runtimeCleanupPromise=null});
  return runtimeCleanupPromise;
}
ipcMain.on('pair:relaunch', event => { if(!isPairRenderer(event)||relaunching)return;relaunching=true;void cleanupRuntime().finally(()=>{app.relaunch();app.exit(0)}) });
// The update feed is never accepted from renderer or signaling input.

function createWindow() {
  ensureEmojiWorker();
  const windowTitle = `Knot ${app.getVersion()} — private P2P chat`;
  // A sandboxed preload cannot require package.json. Supply the trusted app
  // version through the renderer's inherited environment before it starts.
  process.env.KNOT_APP_VERSION = app.getVersion();
  mainWin = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 680,
    backgroundColor: '#111318',
    title: windowTitle,
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // Calls and the isolated PipeWire audio bridge must keep real-time timing
      // when the shared game/window has focus instead of Knot.
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  // The document's <title> is updated after load on Linux and would otherwise
  // replace the versioned native title bar text.
  mainWin.on('page-title-updated', event => { event.preventDefault(); mainWin?.setTitle(windowTitle); });
  mainWin.webContents.on('did-finish-load', () => { mainWin?.setTitle(windowTitle);ensureEmojiWorker(); });
  mainWin.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if(!isInPlace&&isMainFrame){
      invalidateBridgeOwner(mainWin?.webContents);pendingSource=null;pendingSources=[];
      // A reload destroys the renderer-side pumps without necessarily killing
      // the renderer process. Tear down every capture owned by that document so
      // the replacement page cannot inherit an orphaned recorder/audio route or
      // receive "already active" when it starts a new share.
      void nativeScreenService?.stopAsync?.().catch(error=>console.error('[runtime] navigation screen cleanup failed:',error?.message||error));
      void stopLinuxShareAudio().catch(error=>console.error('[runtime] navigation share-audio cleanup failed:',error?.message||error));
      stopNativeCapture();
      void closeDirectFileRuntime().catch(()=>{});void closeLanHouse().catch(()=>{});void closeAllSaveStreams().catch(()=>{});
    }
  });
  mainWin.webContents.on('render-process-gone', (_event, details) => {
    console.error('[runtime] renderer process gone:', details?.reason || 'unknown', details?.exitCode ?? '');
    invalidateBridgeOwner(mainWin?.webContents);
    void cleanupRuntime().catch(error => console.error('[runtime] renderer-crash cleanup failed:', error?.message || error));
  });
  mainWin.webContents.on('unresponsive', () => console.error('[runtime] renderer became unresponsive'));
  mainWin.setMenuBarVisibility(false);

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url), host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host) || /^169\.254\.\d+\.\d+$/.test(host);
      if (parsed.protocol === 'https:' && !loopback) void shell.openExternal(parsed.href).catch(()=>{});
    } catch {}
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', event => event.preventDefault());
  mainWin.loadFile(path.join(__dirname, 'index.html'));
}

app.on('child-process-gone', (_event, details) => {
  const type=String(details?.type||'');console.error('[runtime] child process gone:', type||'unknown', details?.reason||'unknown', details?.exitCode??'');
  if(type.toLowerCase()==='gpu'&&mainWin&&!mainWin.isDestroyed())try{mainWin.webContents.send('pair:gpuProcessGone',{reason:String(details?.reason||'unknown'),exitCode:Number(details?.exitCode)||0})}catch{}
});

app.whenReady().then(async () => {
  metricsStore.record('app.main_ready_ms',process.uptime()*1000);
  // Populate the local search index in the background. Existing cached metadata
  // is available immediately; the built-in Unicode picker remains the offline
  // seed when Emoji.gg cannot be reached.
  if(emojiCatalog.init(app)){startEmojiWorker(emojiCatalog.dir());void refreshEmojiCatalog(false)}
  protocol.handle('emoji', async request => {
    try {
      const asset=await emojiCatalog.assetForRequest(request.url);if(!asset)return new Response(null,{status:404});
      return new Response(asset.buffer,{headers:{'Content-Type':asset.mime,'Cache-Control':'private, max-age=86400'}});
    } catch { return new Response(null,{status:404}); }
  });
  ipcMain.handle('pair:emojiSearch', async (event, params) => {
    if(!isPairRenderer(event))return {items:[],nextCursor:null,total:0,stale:true};
    await ensureEmojiCatalog();return emojiWorkerCall('search',params||{});
  });
  ipcMain.handle('pair:emojiGet', async (event,id)=>{if(!isPairRenderer(event))return null;await ensureEmojiCatalog();return emojiWorkerCall('get',id)});
  ipcMain.handle('pair:emojiStats', async event=>{if(!isPairRenderer(event))return {total:0,animated:0,cacheBytes:0,cacheFiles:0,updatedAt:0,source:'api'};await ensureEmojiCatalog();return emojiCatalog.stats()});
  // Keep Knot itself outside the temporary PipeWire share mix.
  if (process.platform === 'linux' && /PipeWire/i.test(await pipewireAsync('pactl', ['info']))) {
    const sink = await pipewireAsync('pactl', ['get-default-sink']); if (sink) process.env.PULSE_SINK = sink;
  }
  installLinuxLauncher();
  Menu.setApplicationMenu(null);
  // Needed for the browser File System Access API used to stream large downloads.
  const pairRendererPermission = (webContents, permission, details={}) => {
    if(webContents!==mainWin?.webContents||webContents?.mainFrame?.url!==PAIR_RENDERER_URL||details.isMainFrame===false)return false;
    if(details.requestingUrl&&details.requestingUrl!==PAIR_RENDERER_URL)return false;
    if(permission==='speaker-selection')return true;
    if(permission!=='media')return false;
    if(Array.isArray(details.mediaTypes)&&details.mediaTypes.some(type=>type!=='audio'))return false;
    return details.mediaType!=='video';
  };
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback,details) => {
    callback(pairRendererPermission(webContents, permission,details));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission,_origin,details) => pairRendererPermission(webContents, permission,details));
  // Required for navigator.mediaDevices.getDisplayMedia() in Electron 28+.
  // Without this handler the API throws "Not supported".
  // System audio is deliberately not granted here. Chromium "loopback" captures
  // the full render mix (including Knot's own call playback) and reintroduces
  // echo into the screenshare. Knot attaches isolated system audio from the
  // native process-loopback addon / PipeWire share sink instead.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if(request.frame!==mainWin?.webContents?.mainFrame||request.frame?.url!==PAIR_RENDERER_URL)return callback({video:undefined});
      let src;
      const wayland = process.platform === 'linux' && !!(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY);
      if (wayland) {
        // On Wayland, getSources() owns the xdg-desktop-portal session. Fetch
        // the selected source inside this request and consume it immediately;
        // retaining a source from an earlier renderer IPC call makes KDE close
        // its PipeWire target before Chromium imports it ("target not found").
        // KDE's portal can expose a transient window target that resolves to
        // black after the picker closes. A display share is stable across both
        // AMD and NVIDIA Wayland sessions; window sharing remains available on
        // platforms where Electron supplies a persistent window source.
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        src = sources[0];
      } else {
        const selection = pendingSource;
        // Cached DesktopCapturerSource objects die across the picker → capture
        // gap. Windows recreates HWNDs for fullscreen/UWP apps, and X11 screen
        // indexes can reshuffle. Always resolve a fresh source: monitors by
        // display_id, windows by id then a unique title.
        if (selection) {
          const fresh = await desktopCapturer.getSources({ types: ['screen', 'window'], fetchWindowIcons: false, thumbnailSize: { width: 1, height: 1 } });
          const allowed = fresh.filter(source => !isExcludedShareSource(source));
          if (selection.type === 'screen') {
            src = (selection.displayId ? allowed.find(source => String(source.display_id || '') === selection.displayId) : null) || allowed.find(source => source.id === selection.id);
          } else {
            src = allowed.find(source => source.id === selection.id);
            if (!src && selection.name) {
              const named = allowed.filter(source => String(source.name || '') === selection.name && !String(source.id || '').startsWith('screen:'));
              if (named.length === 1) src = named[0];
            }
          }
        }
      }
      pendingSource = null;
      pendingSources = [];
      if (!src) return callback({ video: undefined });
      console.log('[screen portal] selected', src.id, src.name || 'display');
      activeShareSourceId = src.id;
      callback({ video: src });
    } catch (error) {
      console.log('[screen portal] source request failed:', error?.message || error);
      pendingSource = null;
      pendingSources = [];
      callback({ video: undefined });
    }
  }, { useSystemPicker: false });
  createWindow();
  startAutoUpdater({beforeExit:cleanupRuntime});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting=false;
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting=true;
  void cleanupRuntime().finally(() => app.exit(0));
});
app.on('window-all-closed', async () => {
  await cleanupRuntime();
  if (process.platform !== 'darwin') app.quit();
});

// --- Native WASAPI process-loopback capture ---
// Loads the C++ addon that isolates app/desktop audio at the OS process level.
// The addon is built by 'node-gyp rebuild --directory=addon' which outputs to
// addon/build/Release/pair-capture.node.
let nativeCapture = null;
const NATIVE_CAPTURE_ABI = 'knot-screen-audio-v4';
const NATIVE_AUDIO_FRAME_BYTES = 2 * Float32Array.BYTES_PER_ELEMENT;
const NATIVE_AUDIO_PACKET_FRAMES = 960; // 20 ms at 48 kHz
const NATIVE_AUDIO_PACKET_BYTES = NATIVE_AUDIO_PACKET_FRAMES * NATIVE_AUDIO_FRAME_BYTES;
const NATIVE_AUDIO_MAX_BUFFER_BYTES = NATIVE_AUDIO_PACKET_BYTES * 6;
const NATIVE_AUDIO_MAX_INFLIGHT = 3;
let nativeAudioIpc = null;
let nativeAudioNextSequence = 1;
let nativeCaptureGeneration = 0;

function resetNativeAudioIpc(webContents = null) {
  nativeAudioIpc = webContents ? { webContents, chunks: [], bufferedBytes: 0, inflight: new Set(), oldestInflightAt: 0 } : null;
}

function takeNativeAudioPacket(state) {
  if (state.bufferedBytes < NATIVE_AUDIO_PACKET_BYTES) return null;
  const packet = Buffer.allocUnsafe(NATIVE_AUDIO_PACKET_BYTES);
  const capturedAt = state.chunks[0]?.capturedAt || Date.now();
  let written = 0;
  while (written < packet.length && state.chunks.length) {
    const head = state.chunks[0], length = Math.min(packet.length - written, head.data.length);
    head.data.copy(packet, written, 0, length);written += length;state.bufferedBytes -= length;
    if (length === head.data.length) state.chunks.shift();
    else head.data = head.data.subarray(length);
  }
  return { packet, capturedAt };
}

function flushNativeAudioIpc() {
  const state = nativeAudioIpc;
  if (!state || state.webContents.isDestroyed()) return;
  while (state.inflight.size < NATIVE_AUDIO_MAX_INFLIGHT && state.bufferedBytes >= NATIVE_AUDIO_PACKET_BYTES) {
    const next = takeNativeAudioPacket(state);if (!next) break;
    if (Date.now() - next.capturedAt > 250) continue;
    const sequence = nativeAudioNextSequence++;
    // Copy out of Buffer's slab before structured cloning. At most three
    // packets may be waiting for the renderer; acknowledgements provide real
    // IPC backpressure instead of building an unbounded Electron message queue.
    const samples = next.packet.buffer.slice(next.packet.byteOffset, next.packet.byteOffset + next.packet.byteLength);
    try {
      state.webContents.send('pair:cleanAudio', samples, NATIVE_AUDIO_PACKET_FRAMES, { sequence, capturedAt: next.capturedAt });
      state.inflight.add(sequence);
      if (!state.oldestInflightAt) state.oldestInflightAt = Date.now();
    } catch (error) {
      console.warn('send cleanAudio err:', error.message);
      break;
    }
  }
  // A renderer/GPU pause can also lose acknowledgements. Release only the
  // accounting after a bounded timeout, trim buffered history, and let the
  // newest packet probe the recovered renderer. Late sequence acknowledgements
  // are ignored and cannot release a current packet.
  if (state.inflight.size >= NATIVE_AUDIO_MAX_INFLIGHT && state.oldestInflightAt && Date.now() - state.oldestInflightAt > 500) {
    state.inflight.clear();state.oldestInflightAt = 0;
    while (state.bufferedBytes > NATIVE_AUDIO_PACKET_BYTES * 4 && state.chunks.length) {
      const head = state.chunks.shift();state.bufferedBytes -= head.data.length;
    }
    setImmediate(flushNativeAudioIpc);
  }
}

function enqueueNativeAudioIpc(webContents, value, framesValue, capturedAtValue = Date.now()) {
  if (!webContents || webContents.isDestroyed()) return;
  if (!nativeAudioIpc || nativeAudioIpc.webContents !== webContents) resetNativeAudioIpc(webContents);
  const frameCount = Math.max(0, Math.min(48000, Math.floor(Number(framesValue) || 0)));
  if (!frameCount) return;
  let view;
  if (value instanceof ArrayBuffer) view = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else return;
  const input = Buffer.from(view);
  let stereo;
  if (input.length >= frameCount * NATIVE_AUDIO_FRAME_BYTES) {
    stereo = input.subarray(0, frameCount * NATIVE_AUDIO_FRAME_BYTES);
  } else if (input.length >= frameCount * Float32Array.BYTES_PER_ELEMENT) {
    // Development builds predating the stereo contract emitted one float per
    // frame. Keep them audible locally, while release packaging still rejects
    // those obsolete binaries through the ABI/manifest guard.
    stereo = Buffer.allocUnsafe(frameCount * NATIVE_AUDIO_FRAME_BYTES);
    for (let frame = 0; frame < frameCount; frame++) {
      const sample = input.readFloatLE(frame * Float32Array.BYTES_PER_ELEMENT);
      stereo.writeFloatLE(sample, frame * NATIVE_AUDIO_FRAME_BYTES);
      stereo.writeFloatLE(sample, frame * NATIVE_AUDIO_FRAME_BYTES + Float32Array.BYTES_PER_ELEMENT);
    }
  } else return;
  const capturedAt = Number(capturedAtValue);
  nativeAudioIpc.chunks.push({ data: Buffer.from(stereo), capturedAt: Number.isFinite(capturedAt) ? capturedAt : Date.now() });
  nativeAudioIpc.bufferedBytes += stereo.length;
  if (nativeAudioIpc.bufferedBytes > NATIVE_AUDIO_MAX_BUFFER_BYTES) {
    // Retain only the newest 120 ms. When a renderer recovers from a video/UI
    // stall, it hears current desktop sound rather than replaying old packets.
    let discard = nativeAudioIpc.bufferedBytes - NATIVE_AUDIO_MAX_BUFFER_BYTES;
    while (discard > 0 && nativeAudioIpc.chunks.length) {
      const head = nativeAudioIpc.chunks[0], length = Math.min(discard, head.data.length);
      if (length === head.data.length) nativeAudioIpc.chunks.shift();
      else head.data = head.data.subarray(length);
      nativeAudioIpc.bufferedBytes -= length;discard -= length;
    }
  }
  flushNativeAudioIpc();
}

function loadNativeCapture(win) {
  if (nativeCapture) return nativeCapture;
  const paths = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'app.asar.unpacked', 'addon', 'build', 'Release', 'pair-capture.node')] : []),
    path.join(__dirname, 'addon', 'build', 'Release', 'pair-capture.node'),
    path.join(__dirname, '..', 'addon', 'build', 'Release', 'pair-capture.node'),
  ];
  let lastErr = '';
  for (const addonPath of paths) {
    try {
      console.log('Trying addon path:', addonPath);
      const addon = require(addonPath);
      const captureAbi = typeof addon.captureAbi === 'function' ? addon.captureAbi() : '';
      if (captureAbi !== NATIVE_CAPTURE_ABI) {
        throw new Error(`capture addon ABI ${captureAbi || 'missing'}; expected ${NATIVE_CAPTURE_ABI} (run npm run rebuild:addon on Windows)`);
      }
      nativeCapture = addon;
      console.log('Native capture addon loaded from:', addonPath);
      return addon;
    } catch (e) {
      lastErr = e.message;
      console.warn('Addon path failed:', addonPath, '-', lastErr);
    }
  }
  const errMsg = 'Addon not built: ' + lastErr;
  console.warn(errMsg);
  if (win && !win.isDestroyed()) try { win.send('pair:captureError', errMsg); } catch {}
  return null;
}
function startNativeCapture(win) {
  const addon = loadNativeCapture(win);
  if (!addon) { return; }
  if (addon._running) return;
  console.log('native capture: starting...');
  const generation = ++nativeCaptureGeneration;
  resetNativeAudioIpc(win);
  let cbCount=0;
  try {
    // Capture the Windows playback mix for both display and window shares while
    // excluding Knot's own process tree. Window ownership is not a dependable
    // audio boundary: browsers, games and launchers commonly render sound from
    // a sibling process that is not a child of the selected HWND. Process-only
    // loopback therefore produced a healthy video share with digital silence.
    const targetPid = process.pid, includeTarget = false;
    console.log('native capture target: exclude Knot process tree', targetPid);
    addon.start(
      (buf, frames, capturedAtValue) => {
        if (!addon._running || generation !== nativeCaptureGeneration) return;
        const capturedAt = Number(capturedAtValue);
        if (Number.isFinite(capturedAt) && Date.now() - capturedAt > 250) return;
        cbCount++;
        if (process.env.KNOT_CAPTURE_DEBUG==='1'&&cbCount%50===0) console.log('native capture: data cb #'+cbCount+' frames='+frames);
        enqueueNativeAudioIpc(win, buf, frames, capturedAt);
      },
      (errMsg) => {
        if (generation !== nativeCaptureGeneration) return;
        console.warn('native capture err:', errMsg);
        if (win && !win.isDestroyed()) win.send('pair:captureError', errMsg);
        // Fatal native errors end the worker. Join and release its WASAPI/TSFN
        // resources after this TSFN callback returns, so a later share can start
        // a fresh instance without releasing the callback while it is executing.
        setImmediate(() => { if (generation !== nativeCaptureGeneration) return;addon._running = false;resetNativeAudioIpc();try { addon.stop(); } catch {} });
      },
      targetPid,
      includeTarget
    );
    addon._running = true;
    const fmt = addon.getFormat();
    console.log('native capture: started, format=',JSON.stringify(fmt));
    if (win && !win.isDestroyed()) win.send('pair:captureFormat', fmt);
  } catch(e) {
    console.warn('native capture start failed:', e.message);
    addon._running = false;
    resetNativeAudioIpc();
    activeShareSourceId = null;
    if (win && !win.isDestroyed()) win.send('pair:captureError', 'Start failed: '+e.message);
  }
}
function stopNativeCapture() {
  nativeCaptureGeneration++;
  const addon = nativeCapture;
  if (addon && addon._running) {
    addon._running = false;
    try { addon.stop(); } catch {}
  }
  resetNativeAudioIpc();
  activeShareSourceId = null;
}
ipcMain.on('pair:cleanAudioAck', (event, sequenceValue) => {
  if (!isPairRenderer(event)) return;
  const state = nativeAudioIpc, sequence = Math.floor(Number(sequenceValue) || 0);
  if (!state || state.webContents !== event.sender || !state.inflight.delete(sequence)) return;
  state.oldestInflightAt = state.inflight.size ? Date.now() : 0;
  flushNativeAudioIpc();
});
ipcMain.on('pair:startCapture', (event) => {
  if (!isPairRenderer(event)) return;
  console.log('native capture: IPC startCapture');
  startNativeCapture(event.sender);
});
ipcMain.on('pair:stopCapture', event => {
  if (!isPairRenderer(event)) return;
  console.log('native capture: IPC stopCapture');
  stopNativeCapture();
});
