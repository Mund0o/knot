const path = require('path');
const { app, BrowserWindow, Menu, session, dialog, ipcMain, desktopCapturer, shell } = require('electron');
const { installLinuxLauncher } = require('./linux-launcher');
const { execFileSync, spawn } = require('child_process');
const APP_ICON = path.join(__dirname, 'build', 'icon.png');

app.setName('Knot');

let mainWin = null;
let pendingSourceId = null;
let pendingSources = [];
let activeShareSourceId = null;
let linuxShareAudio = null;
function pipewire(command, args) { try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }
function pipewireOk(command, args) { try { execFileSync(command, args, { stdio: 'ignore' }); return true; } catch { return false; } }
function pairProcessTree() {
  const rows = pipewire('ps', ['-eo', 'pid=,ppid=']).split(/\n+/).map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 2 && row.every(Number.isFinite));
  const children = new Map(); for (const [pid, ppid] of rows) { const list = children.get(ppid) || []; list.push(pid); children.set(ppid, list); }
  const ids = new Set([process.pid]), todo = [process.pid]; while (todo.length) for (const child of children.get(todo.pop()) || []) if (!ids.has(child)) { ids.add(child); todo.push(child); }
  return ids;
}
function routeLinuxDesktopAudio(sink, moved) {
  const pairPids = pairProcessTree(), sinkNames = new Map(pipewire('pactl', ['list', 'short', 'sinks']).split(/\n+/).map(line => line.split(/\s+/)).filter(parts => parts.length >= 2).map(parts => [parts[0], parts[1]]));
  const details = pipewire('pactl', ['list', 'sink-inputs']);
  for (const parts of pipewire('pactl', ['list', 'short', 'sink-inputs']).split(/\n+/).map(line => line.split(/\s+/)).filter(parts => parts.length >= 2)) {
    const [id, currentSink] = parts, currentName = sinkNames.get(currentSink), block = details.match(new RegExp(`Sink Input #${id}\\n([\\s\\S]*?)(?=\\nSink Input #|$)`))?.[1] || '';
    const pid = Number(block.match(/application\.process\.id\s*=\s*"(\d+)"/)?.[1]);
    const appName = block.match(/application\.name\s*=\s*"([^"]+)"/)?.[1] || '';
    const binary = block.match(/application\.process\.binary\s*=\s*"([^"]+)"/)?.[1] || '';
    // Move only attributable desktop application streams. Knot and its helper
    // processes stay on the normal output, so call playback never enters the
    // share monitor. Module streams have no PID and are deliberately untouched.
    if (!pid || pairPids.has(pid) || appName === 'Knot' || binary === 'pair-p2p' || !currentName || currentName === sink) continue;
    if (pipewireOk('pactl', ['move-sink-input', id, sink]) && !moved.some(item => item.id === id)) moved.push({ id, sink: currentName });
  }
}
function startLinuxShareAudio(webContents) {
  if (process.platform !== 'linux') return null;
  if (linuxShareAudio) return { label: linuxShareAudio.label, source: linuxShareAudio.source };
  if (!/PipeWire/i.test(pipewire('pactl', ['info']))) return null;
  const original = pipewire('pactl', ['get-default-sink']);
  if (!original) return null;
  const sink = `pair_share_${process.pid}`;
  const routeSink = `pair_route_${process.pid}`;
  const module = pipewire('pactl', ['load-module', 'module-null-sink', `sink_name=${sink}`, 'sink_properties=device.description=Knot_Share_Audio']);
  if (!module) return null;
  // Duplicate selected desktop streams to both the user's normal output and the
  // isolated share sink. This lets the sharer keep hearing games/videos while
  // the friend receives the same playback. Knot itself is never moved here.
  const loop = pipewire('pactl', ['load-module', 'module-combine-sink', `sink_name=${routeSink}`, `slaves=${original},${sink}`, 'sink_properties=device.description=Knot_Share_Route']);
  if (!loop) {
    pipewire('pactl', ['unload-module', module]);
    return null;
  }
  const moved = [];
  routeLinuxDesktopAudio(routeSink, moved);
  // Capture the monitor directly instead of asking Chromium to expose it as a
  // microphone. Chromium's Linux device enumeration can omit virtual monitor
  // sources even though PipeWire created them successfully, which used to make
  // a healthy share route appear as "sound unavailable".
  const capture = spawn('parec', ['--device', `${sink}.monitor`, '--format=float32le', '--rate=48000', '--channels=2', '--latency-msec=40'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { original, sink, routeSink, module, loop, capture, moved, label: 'Knot Share Audio', source: `${sink}.monitor`, watch: null, audits: [] };
  const failCaptureRoute = message => {
    if (linuxShareAudio !== state) return;
    if (webContents && !webContents.isDestroyed()) try { webContents.send('pair:linuxShareAudioError', message); } catch {}
    // Tear down the isolated route immediately if capture dies and restore any
    // desktop streams moved into it.
    stopLinuxShareAudio();
  };
  capture.stdout.on('data', chunk => {
    if (linuxShareAudio !== state || !webContents || webContents.isDestroyed()) return;
    // Copy the exact Buffer window. Sending `chunk.buffer` directly can include
    // unrelated bytes from Node's pooled backing allocation.
    const samples = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    try { webContents.send('pair:linuxShareAudio', samples); } catch {}
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
      if (linuxShareAudio === state && /sink-input/i.test(text)) routeLinuxDesktopAudio(routeSink, moved);
    });
    watch.unref();
  } catch {}
  // Cover streams created between the initial move and subscription becoming
  // active; these are one-shot checks, not a constant polling loop.
  state.audits = [50, 500].map(delay => setTimeout(() => { if (linuxShareAudio === state) routeLinuxDesktopAudio(routeSink, moved); }, delay));
  linuxShareAudio = state;
  return { label: linuxShareAudio.label, source: linuxShareAudio.source };
}
function stopLinuxShareAudio() {
  const state = linuxShareAudio; if (!state) return;
  linuxShareAudio = null;
  if (state.watch) try { state.watch.kill(); } catch {}
  for (const audit of state.audits || []) clearTimeout(audit);
  if (state.capture) try { state.capture.kill(); } catch {}
  for (const input of state.moved || []) pipewireOk('pactl', ['move-sink-input', input.id, input.sink]);
  pipewire('pactl', ['unload-module', state.loop]);
  pipewire('pactl', ['unload-module', state.module]);
}

function isPairRenderer(event) {
  return event.senderFrame?.url?.startsWith('file://') === true;
}
const SETTING_KEYS = new Set(['signalServer', 'roomCode', 'volume', 'screenVol', 'profileAvatar', 'profileFrame', 'profileIdentity', 'profileName', 'profilePhotoMode', 'theme', 'savedInviteCode', 'inputDevice', 'outputDevice', 'voiceProcessing', 'voiceInputMode', 'pushToTalkKey', 'pushToTalkDelay', 'soundEffects', 'shareProfile', 'rememberInvite', 'reduceMotion', 'hardwareAcceleration', 'screenBitrate', 'screenCursor', 'screenContentHint', 'screenCodec', 'shareResolution', 'shareFrameRate', 'directoryUserId', 'directoryToken', 'messageHistory', 'serverMembersCollapsed']);
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
  pendingSources = await desktopCapturer.getSources({ types: ['screen', 'window'], fetchWindowIcons: false, thumbnailSize: { width: 240, height: 180 } });
  return pendingSources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), display_id: s.display_id }));
});
ipcMain.handle('pair:getSystemAvatar', event => isPairRenderer(event) ? systemAccountAvatar() : null);
ipcMain.handle('pair:setPendingSource', (event, id) => {
  if (!isPairRenderer(event) || typeof id !== 'string') return false;
  pendingSourceId = id;
  return true;
});
ipcMain.handle('pair:startLinuxShareAudio', event => isPairRenderer(event) ? startLinuxShareAudio(event.sender) : null);
ipcMain.on('pair:stopLinuxShareAudio', event => { if (isPairRenderer(event)) stopLinuxShareAudio(); });

const fs = require('fs');
// Electron only accepts this before its ready event. Read the tightly scoped
// local setting early; toggling it in the UI takes effect on restart.
let hardwareAccelerationEnabled = true;
try {
  const earlySettings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
  hardwareAccelerationEnabled = earlySettings.hardwareAcceleration !== 'off';
  if (!hardwareAccelerationEnabled) app.disableHardwareAcceleration();
} catch {}
// Keep PipeWire desktop capture enabled explicitly for native Wayland sessions.
// Do not force a different render node for video encoding: capture surfaces on
// NVIDIA/AMD display GPUs often cannot be imported by an Intel render node,
// producing a black WebRTC stream with zero outbound bitrate on hybrid systems.
if (process.platform === 'linux' && hardwareAccelerationEnabled) {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,AcceleratedVideoEncoder,VaapiVideoEncoder');
  // Electron/Chromium currently rejects Vulkan surfaces under native Wayland;
  // falling back to GL avoids a captured DMABUF presenting as a black frame.
  if (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) app.commandLine.appendSwitch('disable-features', 'Vulkan');
}
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

// Updates are checked and installed by the main process on launch. The renderer
// cannot influence the feed URL, package URL, or installer invocation.
const { startAutoUpdater, getUpdateStatus } = require('./updater');
ipcMain.handle('pair:getUpdateStatus', event => isPairRenderer(event) ? getUpdateStatus() : { state: 'idle' });
ipcMain.on('pair:relaunch', event => { if (isPairRenderer(event)) { app.relaunch(); app.exit(0); } });
// The update feed is never accepted from renderer or signaling input.
ipcMain.on('pair:toggleFullscreen', event => { if (isPairRenderer(event) && mainWin) mainWin.setFullScreen(!mainWin.isFullScreen()); });

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
  mainWin.on('enter-full-screen', () => mainWin?.webContents.send('pair:fullscreenChanged', true));
  mainWin.on('leave-full-screen', () => mainWin?.webContents.send('pair:fullscreenChanged', false));
}

app.whenReady().then(() => {
  // Keep Knot itself outside the temporary PipeWire share mix.
  if (process.platform === 'linux' && /PipeWire/i.test(pipewire('pactl', ['info']))) {
    const sink = pipewire('pactl', ['get-default-sink']); if (sink) process.env.PULSE_SINK = sink;
  }
  installLinuxLauncher();
  Menu.setApplicationMenu(null);
  // Needed for the browser File System Access API used to stream large downloads.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media');
  // Required for navigator.mediaDevices.getDisplayMedia() in Electron 28+.
  // Without this handler the API throws "Not supported".
  // System audio is deliberately not granted here. Chromium "loopback" captures
  // the full render mix (including Knot's own call playback) and reintroduces
  // echo into the screenshare. Knot attaches isolated system audio from the
  // native process-loopback addon / PipeWire share sink instead.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const useId = pendingSourceId;
    pendingSourceId = null;
    const src = useId ? pendingSources.find(s => s.id === useId) : null;
    if (src) {
      activeShareSourceId = src.id;
      callback({ video: src });
    } else callback({ video: undefined });
  }, { useSystemPicker: false });
  createWindow();
  startAutoUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
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
  let cbCount=0;
  try {
    // Discord-style application shares capture the selected process and its
    // children. Full-display shares capture the desktop but exclude Knot's
    // process tree, which prevents the watcher hearing their returned voice.
    let targetPid = process.pid, includeTarget = false;
    if (activeShareSourceId?.startsWith('window:') && typeof addon.windowProcessId === 'function') {
      const selectedPid = Number(addon.windowProcessId(activeShareSourceId));
      if (Number.isInteger(selectedPid) && selectedPid > 0 && selectedPid !== process.pid) { targetPid = selectedPid; includeTarget = true; }
    }
    console.log('native capture target:', includeTarget ? `include process tree ${targetPid}` : `exclude Knot process tree ${targetPid}`);
    addon.start(
      (buf, frames) => {
        cbCount++;
        if (cbCount%50===0) console.log('native capture: data cb #'+cbCount+' frames='+frames);
        if (win && !win.isDestroyed()) {
          try { win.send('pair:cleanAudio', buf, frames); } catch(e) { console.warn('send cleanAudio err:', e.message); }
        }
      },
      (errMsg) => {
        console.warn('native capture err:', errMsg);
        if (win && !win.isDestroyed()) win.send('pair:captureError', errMsg);
        // Fatal native errors end the worker. Join and release its WASAPI/TSFN
        // resources after this TSFN callback returns, so a later share can start
        // a fresh instance without releasing the callback while it is executing.
        setImmediate(() => { try { addon.stop(); } catch {} addon._running = false; });
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
    activeShareSourceId = null;
    if (win && !win.isDestroyed()) win.send('pair:captureError', 'Start failed: '+e.message);
  }
}
function stopNativeCapture() {
  const addon = nativeCapture;
  if (addon && addon._running) {
    try { addon.stop(); } catch {}
    addon._running = false;
  }
  activeShareSourceId = null;
}
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
