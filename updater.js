// Launch-time updater for packaged Knot builds.
//
// Release metadata is fetched over HTTPS, then the installer/AppImage is
// downloaded to a private staging directory and SHA-256 verified before it is
// ever executed. Updates run without renderer involvement and restart Knot
// immediately once the replacement has been handed off to the OS.
const { app, BrowserWindow } = require('electron');
const PRODUCT_NAME = 'Knot';
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// The Contents API follows the current Git branch immediately. GitHub's raw
// CDN can serve an older latest.json for several minutes after a release,
// making an otherwise valid Windows update look like "no update".
const DEFAULT_FEED = 'https://api.github.com/repos/Mund0o/knot/contents/public/latest.json?ref=master';
const CHECK_INTERVAL = 30 * 60 * 1000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_UPDATE_BYTES = 4 * 1024 * 1024 * 1024;
let timer = null;
let checking = false;
let installing = false;
let updateStatus = { state: 'idle', message: '' };

function report(state, message = '', extra = {}) {
  updateStatus = { state, message, ...extra };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('pair:updateStatus', updateStatus);
  }
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function readFeedUrl() {
  const configured = process.env.PAIR_FEED || (() => {
    try { return fs.readFileSync(path.join(os.homedir(), '.pair-update-url'), 'utf8').trim(); } catch { return ''; }
  })();
  return httpsUrl(configured || DEFAULT_FEED);
}

function isNewer(local, remote) {
  const valid = /^\d+(?:\.\d+){0,2}(?:[-+].*)?$/;
  if (!valid.test(String(local)) || !valid.test(String(remote))) return false;
  const a = String(local).split(/[+-]/, 1)[0].split('.').map(Number);
  const b = String(remote).split(/[+-]/, 1)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (b[i] || 0) > (a[i] || 0);
  }
  return false;
}

function request(url, maxBytes, onResponse) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Knot-Updater/1.1.2', Accept: 'application/vnd.github+json' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve({ redirect: new URL(response.headers.location, url).href });
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      const length = Number(response.headers['content-length'] || 0);
      if (length && (!Number.isSafeInteger(length) || length > maxBytes)) {
        response.resume();
        return reject(new Error('update is too large'));
      }
      onResponse(response, resolve, reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('update request timed out')));
  });
}

async function fetchText(url, depth = 0) {
  if (depth > 3 || !httpsUrl(url)) throw new Error('unsafe update URL');
  const result = await request(url, MAX_MANIFEST_BYTES, (response, resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_MANIFEST_BYTES) response.destroy(new Error('manifest too large'));
      else chunks.push(chunk);
    });
    response.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8') }));
    response.on('error', reject);
  });
  return result.redirect ? fetchText(result.redirect, depth + 1) : result.text;
}

async function fetchManifest(feedUrl) {
  const url = feedUrl.includes('/contents/public/latest.json') ? feedUrl : `${feedUrl.replace(/\/$/, '')}/latest.json`;
  const text = await fetchText(url);
  if (!url.startsWith('https://api.github.com/')) return JSON.parse(text);
  const envelope = JSON.parse(text);
  if (envelope?.encoding !== 'base64' || typeof envelope.content !== 'string') throw new Error('invalid GitHub update manifest');
  return JSON.parse(Buffer.from(envelope.content.replace(/\s/g, ''), 'base64').toString('utf8'));
}

async function download(url, output, expectedHash, onProgress, depth = 0) {
  if (depth > 3 || !httpsUrl(url)) throw new Error('unsafe update URL');
  const result = await request(url, MAX_UPDATE_BYTES, (response, resolve, reject) => {
    const file = fs.createWriteStream(output, { mode: 0o700, flags: 'wx' });
    const hash = crypto.createHash('sha256');
    let size = 0;
    const total = Number(response.headers['content-length'] || 0);
    const fail = error => {
      file.destroy();
      response.destroy();
      reject(error);
    };
    response.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_UPDATE_BYTES) return fail(new Error('update is too large'));
      hash.update(chunk);
      onProgress?.(size, Number.isSafeInteger(total) && total > 0 ? total : 0);
    });
    response.on('error', fail);
    file.on('error', fail);
    file.on('finish', () => {
      const actualHash = hash.digest('hex');
      if (actualHash !== expectedHash) return reject(new Error('update checksum mismatch'));
      resolve({ file: output });
    });
    response.pipe(file);
  });
  if (result.redirect) {
    try { await fsp.unlink(output); } catch {}
    return download(result.redirect, output, expectedHash, onProgress, depth + 1);
  }
  return result.file;
}

function updateFields(manifest) {
  if (process.platform === 'win32') return { url: manifest.winUrl, sha256: manifest.winSha256, extension: '.exe' };
  if (process.platform === 'linux' && process.env.APPIMAGE) {
    return { url: manifest.linuxAppImageUrl, sha256: manifest.linuxAppImageSha256, extension: '.AppImage' };
  }
  if (process.platform === 'linux') return { url: manifest.linuxUrl, sha256: manifest.linuxSha256, extension: '.tar.gz' };
  return null;
}

function updateDirectory() {
  return path.join(app.getPath('userData'), 'updates');
}

function runWindowsInstaller(installer) {
  // electron-builder's NSIS installer understands these arguments, waits for
  // the running app when needed, updates it in place, and launches it again.
  const child = spawn(installer, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', error => report('failed', `Could not start the Windows installer: ${error.message}`));
  child.unref();
  report('restarting', `Update installed. Restarting ${PRODUCT_NAME}…`);
  app.exit(0);
}

function findLinuxBundle(root, executable) {
  const queue = [{ dir: root, depth: 0 }];
  const matches = [];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (fs.existsSync(path.join(dir, executable)) && fs.existsSync(path.join(dir, 'resources'))) matches.push(dir);
    if (depth >= 3) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const entry of entries) if (entry.isDirectory()) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
  }
  return matches.length === 1 ? matches[0] : null;
}

function handOffLinuxReplacement(target, replacement, executable, stage) {
  const parent = path.dirname(target);
  const backup = path.join(parent, `.${path.basename(target)}.backup-${Date.now()}`);
  const script = path.join(stage, 'apply-update.sh');
  // All filesystem paths are positional parameters; none are interpolated into
  // shell source. The target is always the resolved packaged-app directory or
  // AppImage path, never a user-provided path.
  fs.writeFileSync(script, `#!/bin/sh
pid="$1"
target="$2"
replacement="$3"
backup="$4"
executable="$5"
while kill -0 "$pid" 2>/dev/null; do sleep 1; done
if [ -e "$target" ]; then mv "$target" "$backup" || exit 1; fi
if mv "$replacement" "$target"; then
  rm -rf "$backup"
  if [ -d "$target" ]; then exec "$target/$executable"; else exec "$target"; fi
fi
[ -e "$backup" ] && mv "$backup" "$target"
`, { mode: 0o700 });
  const child = spawn('sh', [script, String(process.pid), target, replacement, backup, executable], { detached: true, stdio: 'ignore' });
  child.unref();
  app.exit(0);
}

function runLinuxUpdate(archive, stage) {
  if (process.env.APPIMAGE) {
    const target = path.resolve(process.env.APPIMAGE);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('AppImage path is not available');
    const replacement = path.join(stage, path.basename(target));
    fs.renameSync(archive, replacement);
    fs.chmodSync(replacement, 0o755);
    handOffLinuxReplacement(target, replacement, path.basename(target), stage);
    return;
  }

  const installRoot = path.dirname(process.resourcesPath);
  const executable = path.basename(process.execPath);
  const extractRoot = path.join(stage, 'extracted');
  fs.mkdirSync(extractRoot, { recursive: true, mode: 0o700 });
  const extraction = spawnSync('tar', ['-xzf', archive, '-C', extractRoot], { stdio: 'ignore' });
  if (extraction.error || extraction.status !== 0) throw new Error('could not unpack Linux update');
  const replacement = findLinuxBundle(extractRoot, executable);
  if (!replacement) throw new Error('Linux update did not contain one app bundle');
  handOffLinuxReplacement(installRoot, replacement, executable, stage);
}

async function install(manifest) {
  if (installing) return;
  const fields = updateFields(manifest);
  const url = httpsUrl(fields?.url);
  const sha256 = String(fields?.sha256 || '').toLowerCase();
  if (!url || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('invalid update metadata');
  installing = true;
  await fsp.mkdir(updateDirectory(), { recursive: true, mode: 0o700 });
  const stage = await fsp.mkdtemp(path.join(updateDirectory(), 'stage-'));
  try {
    const filename = process.platform === 'win32' ? `${PRODUCT_NAME}-Setup-${manifest.version}.exe` : `${PRODUCT_NAME}-${manifest.version}${fields.extension}`;
    report('downloading', `Downloading ${PRODUCT_NAME} ${manifest.version}…`, { version: manifest.version, percent: 0 });
    const archive = await download(url, path.join(stage, filename), sha256, (downloaded, total) => {
      const percent = total ? Math.min(100, Math.round(downloaded / total * 100)) : null;
      report('downloading', percent == null ? `Downloading ${PRODUCT_NAME} ${manifest.version}…` : `Downloading ${PRODUCT_NAME} ${manifest.version}… ${percent}%`, { version: manifest.version, percent });
    });
    report('installing', `Verifying and installing ${PRODUCT_NAME} ${manifest.version}…`, { version: manifest.version });
    if (process.platform === 'win32') runWindowsInstaller(archive);
    else if (process.platform === 'linux') runLinuxUpdate(archive, stage);
  } catch (error) {
    installing = false;
    try { await fsp.rm(stage, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

async function checkOnce(feedUrl) {
  if (checking || installing || !feedUrl || !app.isPackaged) return;
  checking = true;
  report('checking', 'Checking for updates…');
  try {
    const manifest = await fetchManifest(feedUrl);
    if (!isNewer(app.getVersion(), manifest.version)) { report('current', `${PRODUCT_NAME} ${app.getVersion()} is up to date.`); return; }
    console.log(`[updater] installing ${PRODUCT_NAME} ${manifest.version}`);
    report('available', `Update found: ${PRODUCT_NAME} ${manifest.version}. Preparing download…`, { version: manifest.version });
    await install(manifest);
  } catch (error) {
    console.log('[updater] check failed:', error.message);
    report('failed', `Update check failed: ${error.message}`);
  } finally { checking = false; }
}

function startAutoUpdater() {
  const feed = readFeedUrl();
  if (timer) clearInterval(timer);
  // Check immediately on every launch. The interval catches a release that is
  // published while Knot is left running.
  void checkOnce(feed);
  timer = setInterval(() => void checkOnce(feed), CHECK_INTERVAL);
  timer.unref?.();
}

module.exports = { startAutoUpdater, isNewer, getUpdateStatus: () => updateStatus };
