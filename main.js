const path = require('path');
const { app, BrowserWindow, Menu, session, dialog, ipcMain, desktopCapturer, shell } = require('electron');
const { installLinuxLauncher } = require('./linux-launcher');
const { linuxMainGpu, applyLinuxMainGpuEnvironment } = require('./linux-gpu');
const { applyGpuAccelerationPolicy } = require('./gpu-acceleration');
const { NativeScreenService } = require('./native-screen');
const { execFile, execFileSync, spawn } = require('child_process');
const APP_ICON = path.join(__dirname, 'build', 'icon.png');

app.setName('Knot');

let mainWin = null;
let pendingSource = null;
let pendingSources = [];
let activeShareSourceId = null;
let linuxShareAudio = null;
let nativeScreenService = null;
let selectedPrimaryGpu = null;
// NVIDIA Broadcast/NVBroadcast can expose a virtual audio/render surface that
// contains a monitored microphone. It must stay out of both the window picker
// and the Linux PipeWire share route, otherwise a local voice echo is possible.
function isNvidiaBroadcastLabel(...values) { return values.some(value => /(?:nvidia[\s._-]*broadcast|nvbroadcast)/i.test(String(value || ''))); }
function isExcludedShareSource(source) { return isNvidiaBroadcastLabel(source?.name); }
function pipewire(command, args) { try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }
function pipewireOk(command, args) { try { execFileSync(command, args, { stdio: 'ignore' }); return true; } catch { return false; } }
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
  state.routeTimer = setTimeout(async () => {
    state.routeTimer = null;
    if (linuxShareAudio !== state) return;
    if (state.routeRunning) { state.routeAgain = true;return; }
    state.routeRunning = true;
    try { do { state.routeAgain = false;await routeLinuxDesktopAudio(state); } while (state.routeAgain && linuxShareAudio === state); }
    finally { state.routeRunning = false; }
  }, delay);
}
function startLinuxShareAudio(webContents) {
  if (process.platform !== 'linux') return null;
  if (linuxShareAudio) return { label: linuxShareAudio.label, source: linuxShareAudio.source };
  if (!/PipeWire/i.test(pipewire('pactl', ['info']))) return null;
  const original = pipewire('pactl', ['get-default-sink']);
  if (!original) return null;
  const sink = `pair_share_${process.pid}`;
  const module = pipewire('pactl', ['load-module', 'module-null-sink', `sink_name=${sink}`, 'sink_properties=device.description=Knot_Share_Audio']);
  if (!module) return null;
  // Move selected desktop streams to the private share sink, then loop that
  // monitor back once to the normal speakers. The previous combine-sink design
  // fanned every stream into two sinks; PipeWire could exhaust its playback
  // buffers on a busy call, making a burst/beep and starving the share monitor.
  // A one-way loopback keeps local playback and isolated capture independent.
  const loop = pipewire('pactl', ['load-module', 'module-loopback', `source=${sink}.monitor`, `sink=${original}`, 'latency_msec=40']);
  if (!loop) {
    pipewire('pactl', ['unload-module', module]);
    return null;
  }
  const moved = [];
  // Capture the monitor directly instead of asking Chromium to expose it as a
  // microphone. Chromium's Linux device enumeration can omit virtual monitor
  // sources even though PipeWire created them successfully, which used to make
  // a healthy share route appear as "sound unavailable".
  const capture = spawn('parec', ['--device', `${sink}.monitor`, '--format=float32le', '--rate=48000', '--channels=2', '--latency-msec=40'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { original, sink, module, loop, capture, moved, label: 'Knot Share Audio', source: `${sink}.monitor`, watch: null, audits: [], routeTimer: null, routeRunning: false, routeAgain: false, pcmChunks: [], pcmBytes: 0 };
  linuxShareAudio = state;
  const failCaptureRoute = message => {
    if (linuxShareAudio !== state) return;
    if (webContents && !webContents.isDestroyed()) try { webContents.send('pair:linuxShareAudioError', message); } catch {}
    // Tear down the isolated route immediately if capture dies and restore any
    // desktop streams moved into it.
    stopLinuxShareAudio();
  };
  capture.stdout.on('data', chunk => {
    if (linuxShareAudio !== state || !webContents || webContents.isDestroyed()) return;
    state.pcmChunks.push(chunk);state.pcmBytes += chunk.byteLength;
    // One 20 ms stereo float packet per IPC message matches Opus cadence and
    // avoids flooding Electron's renderer/main bridge with tiny parec chunks.
    const packetBytes = 48000*.02*2*4;
    while (state.pcmBytes >= packetBytes) {
      const packet = Buffer.allocUnsafe(packetBytes);let offset = 0;
      while (offset < packetBytes) { const head=state.pcmChunks[0],take=Math.min(head.byteLength,packetBytes-offset);head.copy(packet,offset,0,take);offset+=take;state.pcmBytes-=take;if(take===head.byteLength)state.pcmChunks.shift();else state.pcmChunks[0]=head.subarray(take); }
      const samples = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength);
      try { webContents.send('pair:linuxShareAudio', samples); } catch {}
    }
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
  const state = linuxShareAudio; if (!state) return;
  linuxShareAudio = null;
  if (state.watch) try { state.watch.kill(); } catch {}
  clearTimeout(state.routeTimer);
  for (const audit of state.audits || []) clearTimeout(audit);
  if (state.capture) try { state.capture.kill(); } catch {}
  state.pcmChunks.length = 0;state.pcmBytes = 0;
  for (const input of state.moved || []) pipewireOk('pactl', ['move-sink-input', input.id, input.sink]);
  pipewire('pactl', ['unload-module', state.loop]);
  pipewire('pactl', ['unload-module', state.module]);
}

function isPairRenderer(event) {
  return event.senderFrame?.url?.startsWith('file://') === true;
}
const SETTING_KEYS = new Set(['signalServer', 'roomCode', 'volume', 'screenVol', 'profileAvatar', 'profileFrame', 'profileIdentity', 'profileName', 'profilePhotoMode', 'theme', 'savedInviteCode', 'inputDevice', 'outputDevice', 'voiceProcessing', 'voiceInputMode', 'pushToTalkKey', 'pushToTalkDelay', 'soundEffects', 'shareProfile', 'rememberInvite', 'reduceMotion', 'hardwareAcceleration', 'screenBitrate', 'screenCursor', 'screenContentHint', 'screenCodec', 'shareResolution', 'shareResolutionExplicit', 'shareFrameRate', 'shareSystemAudio', 'directoryUserId', 'directoryToken', 'messageHistory', 'serverMembersCollapsed', 'deviceIdentityPrivate', 'serverTextKeys', 'serverTextMembership']);
const MAX_SETTING_VALUE = 7 * 1024 * 1024;
const MAX_IPC_CHUNK = 8 * 1024 * 1024;
const MAX_SYSTEM_AVATAR_SIZE = 5 * 1024 * 1024;
const SYSTEM_AVATAR_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
function imageMime(buffer, extension = '') {
  if (SYSTEM_AVATAR_MIME[extension]) return SYSTEM_AVATAR_MIME[extension];
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('ascii').startsWith('GIF')) return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function safeFileName(value) {
  const name = path.basename(String(value || 'incoming')).replace(/[\0<>:"/\\|?*]/g, '_').trim();
  return (name || 'incoming').slice(0, 255);
}

function accountAvatarCandidates(dir, depth = 1) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) return accountAvatarCandidates(file, depth - 1);
    if (!entry.isFile() || !SYSTEM_AVATAR_MIME[path.extname(entry.name).toLowerCase()]) return [];
    try {
      const stat = fs.statSync(file);
      return stat.size > 0 && stat.size <= MAX_SYSTEM_AVATAR_SIZE ? [{ file, stat }] : [];
    } catch { return []; }
  });
}

function systemAccountAvatar() {
  const home = app.getPath('home');
  const direct = process.platform === 'linux' ? [path.join(home, '.face'), path.join(home, '.face.icon')] : [];
  const directories = process.platform === 'win32'
    ? [path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'AccountPictures'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'AccountPictures')]
    : [];
  const candidates = [
    ...direct.flatMap(file => {
      try { const stat = fs.statSync(file); return stat.isFile() && stat.size > 0 && stat.size <= MAX_SYSTEM_AVATAR_SIZE ? [{ file, stat }] : []; } catch { return []; }
    }),
    ...directories.flatMap(dir => accountAvatarCandidates(dir))
  ].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.stat.size - a.stat.size);
  const selected = candidates[0];
  if (!selected) return null;
  try {
    const bytes = fs.readFileSync(selected.file);
    const mime = imageMime(bytes, path.extname(selected.file).toLowerCase());
    return mime ? `data:${mime};base64,${bytes.toString('base64')}` : null;
  } catch { return null; }
}

ipcMain.handle('pair:getSources', async event => {
  if (!isPairRenderer(event)) return [];
  pendingSources = (await desktopCapturer.getSources({ types: ['screen', 'window'], fetchWindowIcons: false, thumbnailSize: { width: 240, height: 180 } })).filter(source => !isExcludedShareSource(source));
  return pendingSources.map(s => ({ id: s.id, name: s.name, type: s.id.startsWith('screen:') ? 'screen' : 'application', thumbnail: s.thumbnail.toDataURL(), display_id: s.display_id }));
});
ipcMain.handle('pair:getSystemAvatar', event => isPairRenderer(event) ? systemAccountAvatar() : null);
ipcMain.handle('pair:setPendingSource', (event, selection) => {
  if (!isPairRenderer(event) || !selection || typeof selection.id !== 'string') return false;
  const source = pendingSources.find(item => item.id === selection.id);
  if (!source || isExcludedShareSource(source)) return false;
  // Keep immutable source identity as well as Electron's transient id. Windows
  // can recreate an HWND capture source between the picker and getDisplayMedia.
  pendingSource = { id: source.id, displayId: String(source.display_id || ''), type: source.id.startsWith('screen:') ? 'screen' : 'application' };
  return true;
});
ipcMain.handle('pair:startLinuxShareAudio', event => isPairRenderer(event) ? startLinuxShareAudio(event.sender) : null);
ipcMain.on('pair:stopLinuxShareAudio', event => { if (isPairRenderer(event)) stopLinuxShareAudio(); });
ipcMain.handle('pair:nativeScreenInfo', event => isPairRenderer(event) ? nativeScreenService?.info() || { supported: false } : { supported: false });
ipcMain.handle('pair:startNativeScreen', (event, options) => {
  if (!isPairRenderer(event) || !options || typeof options !== 'object') return null;
  try { return nativeScreenService?.start(options) || { error: 'Native screen capture is unavailable' }; } catch (error) { return { error: error?.message || String(error) }; }
});
ipcMain.handle('pair:readNativeScreen', (event, id) => isPairRenderer(event) && Number.isInteger(id) ? nativeScreenService?.read(id) || { active: false } : { active: false });
ipcMain.on('pair:stopNativeScreen', (event, id) => { if (isPairRenderer(event)) nativeScreenService?.stop(Number.isInteger(id) ? id : 0); });

const fs = require('fs');
// Electron only accepts this before its ready event. Read the tightly scoped
// local setting early; toggling it in the UI takes effect on restart.
let hardwareAccelerationEnabled = true;
try {
  const earlySettings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
  hardwareAccelerationEnabled = earlySettings.hardwareAcceleration !== 'off';
  if (!hardwareAccelerationEnabled) app.disableHardwareAcceleration();
} catch {}
// Apply the aggressive policy only when the setting is on. Linux first pins the
// exact discrete render node; Windows/macOS ask the OS for its high-performance
// adapter. The policy keeps driver safety workarounds but prevents silent
// integrated-GPU or software-rasterizer fallback.
if (hardwareAccelerationEnabled) {
  const wayland = process.platform === 'linux' && !!(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY);
  if (process.platform === 'linux') {
    const primaryGpu = linuxMainGpu();selectedPrimaryGpu=primaryGpu;
    if (applyLinuxMainGpuEnvironment(primaryGpu) && applyGpuAccelerationPolicy(app, { platform: process.platform, gpu: primaryGpu, wayland })) {
      console.log('[gpu] discrete-only full acceleration selected:', primaryGpu.renderNode, primaryGpu.vendor, primaryGpu.pciAddress);
    } else {
      // Never let an integrated GPU become Knot's implicit fallback. Chromium's
      // software renderer remains available only when acceleration is disabled.
      app.disableHardwareAcceleration();
      process.env.KNOT_PRIMARY_GPU_VENDOR = '';
      console.warn('[gpu] no discrete render node found; integrated GPU rejected, using CPU rendering');
    }
  } else {
    // Windows/macOS expose their high-performance adapter through Chromium's
    // platform backend. The same policy covers D3D/Metal compositing, raster,
    // canvas, zero-copy surfaces, and platform video acceleration.
    applyGpuAccelerationPolicy(app, { platform: process.platform });
  }
}
nativeScreenService = new NativeScreenService({
  primaryGpuVendor: process.env.KNOT_PRIMARY_GPU_VENDOR || '',
  primaryGpuCard: selectedPrimaryGpu?.card || '',
  onError: message => mainWin?.webContents.send('pair:nativeScreenError', String(message || 'Native screen capture failed'))
});
// Knot is serverless by default. `server.js` remains available through
// `npm run signal` for people who deliberately operate their own signaling
// service, but the desktop app must not silently start a localhost server.

// --- Incoming-file disk streaming (single active write stream) ---
// The renderer is sandboxed, so all fs access happens here. `write` resolves
// only when the OS accepts the chunk or 'drain' fires — that backpressure
// flows back through the renderer and WebRTC to the sender.
let writeStream = null;
let writeFailed = null;

let closePromise = null;
function closeStream() {
  if (closePromise) return closePromise;
  if (!writeStream) return Promise.resolve();
  const s = writeStream;
  writeStream = null;
  closePromise = new Promise(resolve => {
    const done = () => { closePromise = null; resolve(); };
    s.once('close', done);
    s.once('error', done);
    s.destroy();
    setTimeout(done, 5000);
  });
  return closePromise;
}

ipcMain.handle('pair:saveStart', async (event, name) => {
  if (!isPairRenderer(event)) return { ok: false };
  await closeStream();
  writeFailed = null;
  const result = await dialog.showSaveDialog({
    title: 'Save incoming file',
    defaultPath: safeFileName(name),
    buttonLabel: 'Save'
  });
  if (result.canceled || !result.filePath) return { ok: false };
  // A cancel may have arrived while the dialog was open (closeStream already ran
  // and nulled writeStream). If a stream was opened in the meantime by another
  // call, don't clobber it; if not, opening here is safe. Re-check to avoid
  // leaving an orphaned, never-closed write stream on disk.
  if (writeStream) {
    try { writeStream.destroy(); } catch {}
    writeStream = null;
  }
  writeStream = fs.createWriteStream(result.filePath);
  writeStream.on('error', err => { writeFailed = err; });
  return { ok: true, path: result.filePath };
});

// How much decrypted data we'll buffer in the Node stream before pausing the
// renderer. Large enough that the network never stalls waiting on a slow disk,
// small enough to bound memory for very large files.
const WRITE_HIGH_WATER = 256 * 1024 * 1024;

ipcMain.handle('pair:saveWrite', async (event, buf) => {
  if (!isPairRenderer(event) || !buf || buf.byteLength > MAX_IPC_CHUNK) throw new Error('invalid file chunk');
  if (!writeStream) throw new Error('no open stream');
  if (writeFailed) throw writeFailed;
  // Write without awaiting each drain. Node's Writable buffers internally; we
  // only back-pressure the renderer when our own buffer exceeds WRITE_HIGH_WATER
  // (i.e. the disk genuinely can't keep up). This removes the per-chunk IPC
  // round-trip latency that otherwise caps receive throughput.
  const ok = writeStream.write(Buffer.from(buf));
  if (!ok && writeStream.writableLength > WRITE_HIGH_WATER) {
    await new Promise((resolve, reject) => {
      const s = writeStream;
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(wt);
        try { s.removeListener('drain', onDrain); } catch {}
        try { s.removeListener('error', onErr); } catch {}
        try { s.removeListener('close', onClose); } catch {}
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onErr = err => { cleanup(); reject(err); };
      const onClose = () => { cleanup(); resolve(); };
      const wt = setTimeout(() => { cleanup(); resolve(); }, 30000);
      s.once('drain', onDrain);
      s.once('error', onErr);
      s.once('close', onClose);
    });
  }
  return true;
});

ipcMain.handle('pair:saveEnd', event => {
  if (!isPairRenderer(event)) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
  if (!writeStream) return resolve(false);
  const s = writeStream;
  writeStream = null;
  const to = setTimeout(() => { s.destroy(); resolve(false); }, 10000);
  s.once('finish', () => { clearTimeout(to); resolve(true); });
  s.once('error', err => { clearTimeout(to); reject(err); });
  s.end();
  });
});

ipcMain.handle('pair:saveCancel', event => isPairRenderer(event) ? closeStream().then(() => true) : false);

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
function readSettings() {
  try { return JSON.parse(fs.readFileSync(sp(), 'utf8')); } catch { return {}; }
}
function writeSettings(obj) {
  try { fs.writeFileSync(sp(), JSON.stringify(obj), { encoding: 'utf8', mode: 0o600 }); fs.chmodSync(sp(), 0o600); } catch {}
}
ipcMain.handle('pair:getSetting', (event, key) => {
  if (!isPairRenderer(event) || !SETTING_KEYS.has(key)) return undefined;
  return (readSettings())[key];
});
ipcMain.handle('pair:setSetting', (event, key, value) => {
  if (!isPairRenderer(event) || !SETTING_KEYS.has(key)) return false;
  if (value != null && (typeof value !== 'string' || value.length > MAX_SETTING_VALUE)) return false;
  const s = readSettings();
  if (value == null) delete s[key]; else s[key] = value;
  writeSettings(s);
  return true;
});

// Updates are checked by the main process on launch. The renderer can only
// accept a manifest already verified by that process; it cannot influence the
// feed URL, package URL, or installer invocation.
const { startAutoUpdater, getUpdateStatus, installAvailableUpdate } = require('./updater');
ipcMain.handle('pair:getUpdateStatus', event => isPairRenderer(event) ? getUpdateStatus() : { state: 'idle' });
ipcMain.handle('pair:acceptUpdate', event => isPairRenderer(event) ? installAvailableUpdate() : false);
ipcMain.on('pair:relaunch', event => { if (isPairRenderer(event)) { app.relaunch(); app.exit(0); } });
// The update feed is never accepted from renderer or signaling input.

function createWindow() {
  const windowTitle = `Knot ${app.getVersion()} — private P2P chat`;
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
      // Calls and the isolated PipeWire audio bridge must keep real-time timing
      // when the shared game/window has focus instead of Knot.
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  // The document's <title> is updated after load on Linux and would otherwise
  // replace the versioned native title bar text.
  mainWin.on('page-title-updated', event => { event.preventDefault(); mainWin?.setTitle(windowTitle); });
  mainWin.webContents.on('did-finish-load', () => mainWin?.setTitle(windowTitle));
  mainWin.webContents.on('render-process-gone', (_event, details) => {
    console.error('[runtime] renderer process gone:', details?.reason || 'unknown', details?.exitCode ?? '');
  });
  mainWin.webContents.on('unresponsive', () => console.error('[runtime] renderer became unresponsive'));
  mainWin.setMenuBarVisibility(false);

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') shell.openExternal(parsed.href);
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

app.whenReady().then(() => {
  // Keep Knot itself outside the temporary PipeWire share mix.
  if (process.platform === 'linux' && /PipeWire/i.test(pipewire('pactl', ['info']))) {
    const sink = pipewire('pactl', ['get-default-sink']); if (sink) process.env.PULSE_SINK = sink;
  }
  installLinuxLauncher();
  Menu.setApplicationMenu(null);
  // Needed for the browser File System Access API used to stream large downloads.
  const pairRendererPermission = (webContents, permission) =>
    webContents === mainWin?.webContents && (permission === 'media' || permission === 'speaker-selection');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(pairRendererPermission(webContents, permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => pairRendererPermission(webContents, permission));
  // Required for navigator.mediaDevices.getDisplayMedia() in Electron 28+.
  // Without this handler the API throws "Not supported".
  // System audio is deliberately not granted here. Chromium "loopback" captures
  // the full render mix (including Knot's own call playback) and reintroduces
  // echo into the screenshare. Knot attaches isolated system audio from the
  // native process-loopback addon / PipeWire share sink instead.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      let src;
      if (process.platform === 'linux') {
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
        // A Windows display source is not durable across the picker → capture
        // boundary. Display 1 often keeps its original source object alive,
        // while Display 2 can be recreated by DWM and then starts a dead
        // capture track. Always resolve screens again at consumption time by
        // their stable display_id; windows keep the cached object first.
        src = selection?.type === 'screen' ? null : selection ? pendingSources.find(source => source.id === selection.id) : null;
        if (!src && selection) {
          const fresh = await desktopCapturer.getSources({ types: ['screen', 'window'], fetchWindowIcons: false, thumbnailSize: { width: 1, height: 1 } });
          const allowed = fresh.filter(source => !isExcludedShareSource(source));
          src = selection.type === 'screen'
            // `display_id` identifies the physical Windows monitor, unlike a
            // transient screen:<index> source id. Never fall back by name.
            ? (selection.displayId ? allowed.find(source => String(source.display_id || '') === selection.displayId) : null) || allowed.find(source => source.id === selection.id)
            : allowed.find(source => source.id === selection.id);
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
  startAutoUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  nativeScreenService?.stop();
  stopLinuxShareAudio();
  await closeStream();
  stopNativeCapture();
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
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'app.asar.unpacked', 'addon', 'build', 'Release', 'pair-capture')] : []),
    path.join(__dirname, 'addon', 'build', 'Release', 'pair-capture'),
    path.join(__dirname, '..', 'addon', 'build', 'Release', 'pair-capture'),
    path.join(process.cwd(), 'addon', 'build', 'Release', 'pair-capture'),
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
        if (cbCount%50===0) console.log('native capture: data cb #'+cbCount+' frames='+frames);
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
