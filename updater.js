// Launch-time updater for packaged Knot builds.
//
// Release metadata is fetched over HTTPS, then the installer/AppImage is
// downloaded to a private staging directory and SHA-256 verified before it is
// ever executed. A release is only downloaded after the person using Knot
// explicitly accepts it in the app.
const { app, BrowserWindow } = require('electron');
const PRODUCT_NAME = 'Knot';
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { UPDATE_PUBLIC_KEY, SIGNED_MANIFEST_FIELDS, canonicalManifestPayload } = require('./update-signing');

// The Contents API follows the current Git branch immediately. GitHub's raw
// CDN can serve an older latest.json for several minutes after a release,
// making an otherwise valid Windows update look like "no update".
const DEFAULT_FEED = 'https://api.github.com/repos/Mund0o/knot/contents/public/latest.json?ref=master';
// The same signed file from GitHub's raw CDN. It can lag a release by a few
// minutes, but it is a separate host and is not subject to the API's
// per-address rate limit, so a flaky or shared connection still gets an answer.
// The manifest is signature-checked either way.
const FALLBACK_FEED = 'https://raw.githubusercontent.com/Mund0o/knot/master/public/latest.json';
const CHECK_INTERVAL = 30 * 60 * 1000;
// A check makes a few quick attempts, alternating feeds. When all of them
// fail the next round comes minutes later rather than after a full interval.
const CHECK_RETRY_DELAYS_MS = [3000, 8000, 15000];
const CHECK_BACKOFF_MS = [2, 5, 10, 30].map(minutes => minutes * 60 * 1000);
// Downloads resume from the bytes already on disk after a dropped connection.
const DOWNLOAD_RETRY_DELAYS_MS = [2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000, 30000, 30000, 30000];
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_UPDATE_BYTES = 4 * 1024 * 1024 * 1024;
const STALE_UPDATE_STAGE_MS = 15 * 60 * 1000;
let timer = null;
let retryTimer = null;
let checkFailures = 0;
let checking = false;
let installing = false;
let availableManifest = null;
let updateStatus = { state: 'idle', message: '' };
let beforeExit = async () => {};
const activeUpdateStages = new Set();

async function prepareToExit(){try{await beforeExit()}catch(error){console.warn('[updater] pre-exit cleanup failed:',error?.message||error)}}

function releaseNotes(value) {
  if (typeof value !== 'string') return [];
  return value.split(/\r?\n/).map(note => note.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 8).map(note => note.slice(0, 280));
}

function report(state, message = '', extra = {}) {
  updateStatus = { state, message, ...extra };
  for (const win of BrowserWindow?.getAllWindows?.() || []) {
    if (!win.isDestroyed()) win.webContents.send('pair:updateStatus', updateStatus);
  }
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function validVersion(value) {
  const version=typeof value==='string'?value.trim():'';
  return version.length<=64&&/^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)?version:null;
}

function trustedArtifactUrl(value) {
  const url = httpsUrl(value);if (!url) return null;
  try { const parsed = new URL(url), host = parsed.hostname.toLowerCase();if (host === 'github.com') return parsed.pathname.startsWith('/Mund0o/knot/releases/download/') ? parsed.href : null;if (host === 'objects.githubusercontent.com' || host.endsWith('.githubusercontent.com')) return parsed.href;return null; } catch { return null; }
}

function verificationPublicKey() {
  // Tests need disposable keys, but packaged builds must never accept a key
  // selected by an environment variable or renderer-controlled input.
  if (!app?.isPackaged && process.env.NODE_ENV === 'test' && process.env.KNOT_UPDATE_TEST_PUBLIC_KEY) {
    return process.env.KNOT_UPDATE_TEST_PUBLIC_KEY.replace(/\\n/g, '\n');
  }
  return UPDATE_PUBLIC_KEY;
}

function verifyManifest(manifest, localVersion = app?.getVersion?.(), { requireNewer = true } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('invalid update manifest');
  const version = validVersion(manifest.version);
  if (!version) throw new Error('invalid update version');
  for (const field of SIGNED_MANIFEST_FIELDS.slice(1)) {
    if (typeof manifest[field] !== 'string' || !manifest[field]) throw new Error(`missing signed update field: ${field}`);
  }
  for (const field of ['linuxSha256', 'linuxAppImageSha256', 'winSha256']) {
    if (!/^[a-f0-9]{64}$/.test(manifest[field])) throw new Error(`invalid update hash: ${field}`);
  }
  for (const field of ['linuxUrl', 'linuxAppImageUrl', 'winUrl']) {
    if (!trustedArtifactUrl(manifest[field])) throw new Error(`unsafe update URL: ${field}`);
  }
  const signature = typeof manifest.signature === 'string' ? Buffer.from(manifest.signature, 'base64') : Buffer.alloc(0);
  if (signature.length !== 64 || !crypto.verify(null, canonicalManifestPayload(manifest), verificationPublicKey(), signature)) {
    throw new Error('update manifest signature is invalid');
  }
  if (requireNewer && !isNewer(localVersion, version)) throw new Error('update manifest is not newer than this build');
  return manifest;
}

function readFeedUrl() {
  // Packaged builds are pinned to Knot's repository. Local overrides are a
  // development convenience only; accepting them in production would let a
  // modified environment or dotfile choose both an installer and its checksum.
  if (app.isPackaged) return DEFAULT_FEED;
  const configured = process.env.PAIR_FEED || (() => {
    try { return fs.readFileSync(path.join(os.homedir(), '.pair-update-url'), 'utf8').trim(); } catch { return ''; }
  })();
  return httpsUrl(configured || DEFAULT_FEED);
}

function isNewer(local, remote) {
  local=validVersion(local);remote=validVersion(remote);if(!local||!remote)return false;
  const parse=value=>{const withoutBuild=value.split('+',1)[0],dash=withoutBuild.indexOf('-'),core=dash<0?withoutBuild:withoutBuild.slice(0,dash),pre=dash<0?'':withoutBuild.slice(dash+1);return{core:core.split('.').map(Number),pre:pre?pre.split('.'):[]}},a=parse(local),b=parse(remote);
  for (let i = 0; i < 3; i++) {
    if ((a.core[i] || 0) !== (b.core[i] || 0)) return (b.core[i] || 0) > (a.core[i] || 0);
  }
  if(!a.pre.length||!b.pre.length)return !!a.pre.length&&!b.pre.length;
  for(let index=0;index<Math.max(a.pre.length,b.pre.length);index++){
    if(a.pre[index]===undefined)return true;if(b.pre[index]===undefined)return false;if(a.pre[index]===b.pre[index])continue;
    const aNumeric=/^\d+$/.test(a.pre[index]),bNumeric=/^\d+$/.test(b.pre[index]);if(aNumeric!==bNumeric)return aNumeric;
    if(aNumeric){const left=BigInt(a.pre[index]),right=BigInt(b.pre[index]);return right>left}
    return b.pre[index]>a.pre[index];
  }
  return false;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function request(url, maxBytes, onResponse, { headers = {}, statuses = [200] } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': `Knot-Updater/${app?.getVersion?.() || 'dev'}`, Accept: 'application/vnd.github+json', ...headers } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve({ redirect: new URL(response.headers.location, url).href });
      }
      if (!statuses.includes(response.statusCode)) {
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
  const url = feedUrl.includes('/contents/public/latest.json') || /\/latest\.json$/.test(feedUrl) ? feedUrl : `${feedUrl.replace(/\/$/, '')}/latest.json`;
  const text = await fetchText(url);
  if (!url.startsWith('https://api.github.com/')) return JSON.parse(text);
  const envelope = JSON.parse(text);
  if (envelope?.encoding !== 'base64' || typeof envelope.content !== 'string') throw new Error('invalid GitHub update manifest');
  return JSON.parse(Buffer.from(envelope.content.replace(/\s/g, ''), 'base64').toString('utf8'));
}

// One request for the bytes after `offset`. Resolves when the response body
// has fully arrived; a dropped or stalled connection rejects so the caller can
// resume. A server that ignores Range (200) restarts the file from zero.
async function downloadPart(url, output, offset, onProgress, depth = 0) {
  if (depth > 3 || !trustedArtifactUrl(url)) throw Object.assign(new Error('unsafe update URL'), { fatal: true });
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
  const result = await request(url, MAX_UPDATE_BYTES, (response, resolve, reject) => {
    if (response.statusCode === 416) {
      response.resume();
      const total = Number(String(response.headers['content-range'] || '').match(/^bytes \*\/(\d+)$/)?.[1]);
      if (Number.isSafeInteger(total) && total === offset) return resolve({ total });
      return reject(Object.assign(new Error('update download could not resume'), { restart: true }));
    }
    let start = 0, total = 0;
    if (response.statusCode === 206) {
      const range = String(response.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      start = Number(range?.[1]);total = Number(range?.[3]);
      if (!range || start !== offset || !Number.isSafeInteger(total)) {
        response.resume();
        return reject(Object.assign(new Error('update download could not resume'), { restart: true }));
      }
    } else total = Number(response.headers['content-length'] || 0);
    if (total && (!Number.isSafeInteger(total) || total > MAX_UPDATE_BYTES)) {
      response.resume();
      return reject(Object.assign(new Error('update is too large'), { fatal: true }));
    }
    const file = fs.createWriteStream(output, { mode: 0o600, flags: start > 0 ? 'a' : 'w' });
    let written = start, ended = false, settled = false;
    const fail = error => {
      if (settled) return;settled = true;
      response.destroy();
      file.end(() => reject(error));
    };
    response.on('data', chunk => {
      written += chunk.length;
      if (written > MAX_UPDATE_BYTES || (total && written > total)) return fail(Object.assign(new Error('update is too large'), { fatal: true }));
      onProgress?.(written, total);
    });
    response.on('end', () => { ended = true; });
    response.on('aborted', () => fail(new Error('update download was interrupted')));
    response.on('error', fail);
    file.on('error', error => fail(Object.assign(error, { fatal: true })));
    file.on('finish', () => {
      if (settled) return;settled = true;
      if (!ended || (total && written !== total)) return reject(new Error('update download was interrupted'));
      resolve({ total: total || written });
    });
    response.pipe(file);
  }, { headers, statuses: [200, 206, 416] });
  if (result.redirect) return downloadPart(result.redirect, output, offset, onProgress, depth + 1);
  return result;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

// Download with resume. The partial file survives failed attempts (and a
// failed install round, so the next click continues it); the finished file is
// SHA-256 checked against the signed manifest before anything uses it.
async function download(url, output, expectedHash, onProgress, { onRetry, retryDelays = DOWNLOAD_RETRY_DELAYS_MS } = {}) {
  if (!trustedArtifactUrl(url)) throw new Error('unsafe update URL');
  for (let attempt = 0; ; attempt++) {
    let offset = 0;
    try { offset = (await fsp.stat(output)).size; } catch {}
    try {
      await downloadPart(url, output, offset, onProgress);
      break;
    } catch (error) {
      if (error?.restart) await fsp.rm(output, { force: true });
      if (error?.fatal || attempt >= retryDelays.length) throw error;
      onRetry?.(attempt + 1, retryDelays.length, error);
      await delay(retryDelays[attempt]);
    }
  }
  if (await sha256File(output) !== expectedHash) {
    await fsp.rm(output, { force: true });
    throw new Error('update checksum mismatch');
  }
  return output;
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
  if (!app?.getPath && process.env.NODE_ENV === 'test') return path.join(os.tmpdir(), 'knot-updater-test');
  return path.join(app.getPath('userData'), 'updates');
}

async function sweepStaleUpdateStages({ root = updateDirectory(), now = Date.now(), minAgeMs = STALE_UPDATE_STAGE_MS } = {}) {
  const resolvedRoot = path.resolve(root);
  let entries;
  try { entries = await fsp.readdir(resolvedRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return [];throw error; }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^stage-[A-Za-z0-9._-]{1,128}$/.test(entry.name)) continue;
    const target = path.join(resolvedRoot, entry.name);
    if (activeUpdateStages.has(path.resolve(target))) continue;
    let stat, realTarget;
    try { stat = await fsp.lstat(target);realTarget = await fsp.realpath(target); } catch { continue; }
    if (!stat.isDirectory() || realTarget === resolvedRoot || !realTarget.startsWith(resolvedRoot + path.sep)) continue;
    if (Math.max(0, Number(minAgeMs) || 0) && now - stat.mtimeMs < minAgeMs) continue;
    await fsp.rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

async function runWindowsInstaller(installer) {
  // electron-builder's NSIS installer understands these arguments, waits for
  // the running app when needed, updates it in place, and launches it again.
  const child = spawn(installer, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve,reject)=>{let settled=false;const finish=fn=>value=>{if(settled)return;settled=true;child.removeListener('spawn',spawned);child.removeListener('error',failed);fn(value)};const spawned=finish(resolve),failed=finish(reject);child.once('spawn',spawned);child.once('error',failed)});
  child.unref();
  report('restarting', `Update installed. Restarting ${PRODUCT_NAME}…`);
  await prepareToExit();
  app.exit(0);
}

async function findLinuxBundle(root, executable) {
  const queue = [{ dir: root, depth: 0 }];
  const matches = [];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    try {
      const [binary, resources] = await Promise.all([
        fsp.stat(path.join(dir, executable)),
        fsp.stat(path.join(dir, 'resources')),
      ]);
      if (binary.isFile() && resources.isDirectory()) matches.push(dir);
    } catch {}
    if (depth >= 3) continue;
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch {}
    for (const entry of entries) if (entry.isDirectory()) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
  }
  return matches.length === 1 ? matches[0] : null;
}

// A Linux update swaps the app in place. When this account cannot write where
// Knot lives (unpacked under /opt, for example), say so before downloading
// rather than quitting into a swap that cannot happen.
async function assertLinuxUpdateTargetWritable() {
  const target = process.env.APPIMAGE ? path.resolve(process.env.APPIMAGE) : process.resourcesPath ? path.dirname(process.resourcesPath) : '';
  if (!target) return;
  const parent = path.dirname(target);
  try { await fsp.access(parent, fs.constants.W_OK); }
  catch {
    const error = new Error(`${PRODUCT_NAME} is installed in ${parent}, which this account cannot change. Download the new version from https://github.com/Mund0o/knot/releases and install it there yourself`);
    error.permanent = true;
    throw error;
  }
}

async function handOffLinuxReplacement(target, replacement, executable, stage) {
  const resolvedTarget=path.resolve(target),resolvedStage=await fsp.realpath(stage),updatesRoot=await fsp.realpath(updateDirectory()),resolvedReplacement=await fsp.realpath(replacement);
  if(resolvedTarget===path.parse(resolvedTarget).root||resolvedTarget===path.resolve(os.homedir())||resolvedTarget===path.resolve(app.getPath('appData')))throw new Error('unsafe Linux update target');
  if(resolvedStage===updatesRoot||!resolvedStage.startsWith(updatesRoot+path.sep)||!resolvedReplacement.startsWith(resolvedStage+path.sep))throw new Error('unsafe Linux update staging path');
  target=resolvedTarget;replacement=resolvedReplacement;stage=resolvedStage;
  const parent = path.dirname(target);
  const backup = path.join(parent, `.${path.basename(target)}.backup-${Date.now()}`);
  const script = path.join(stage, 'apply-update.sh');
  // All filesystem paths are positional parameters; none are interpolated into
  // shell source. The target is always the resolved packaged-app directory or
  // AppImage path, never a user-provided path.
  await fsp.writeFile(script, `#!/bin/sh
pid="$1"
target="$2"
replacement="$3"
backup="$4"
executable="$5"
stage="$6"
while kill -0 "$pid" 2>/dev/null; do sleep 1; done
if [ -e "$target" ] && ! mv "$target" "$backup"; then
  if [ -d "$target" ]; then "$target/$executable" >/dev/null 2>&1 & else "$target" >/dev/null 2>&1 & fi
  rm -rf "$stage"
  exit 1
fi
if mv "$replacement" "$target"; then
  if [ -d "$target" ]; then "$target/$executable" >/dev/null 2>&1 & else "$target" >/dev/null 2>&1 & fi
  replacement_pid=$!
  sleep 3
  if kill -0 "$replacement_pid" 2>/dev/null; then
    rm -rf "$backup" "$stage"
    exit 0
  fi
  rm -rf "$target"
fi
[ -e "$backup" ] && mv "$backup" "$target"
if [ -d "$target" ]; then "$target/$executable" >/dev/null 2>&1 & elif [ -e "$target" ]; then "$target" >/dev/null 2>&1 & fi
rm -rf "$stage"
`, { mode: 0o700 });
  await fsp.chmod(script, 0o700);
  const child = spawn('sh', [script, String(process.pid), target, replacement, backup, executable, stage], { detached: true, stdio: 'ignore' });
  await new Promise((resolve,reject)=>{let settled=false;const finish=fn=>value=>{if(settled)return;settled=true;child.removeListener('spawn',spawned);child.removeListener('error',failed);fn(value)};const spawned=finish(resolve),failed=finish(reject);child.once('spawn',spawned);child.once('error',failed)});
  child.unref();
  await prepareToExit();
  app.exit(0);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve,reject)=>{let settled=false;const finish=fn=>value=>{if(settled)return;settled=true;clearTimeout(timer);child.removeListener('error',failed);child.removeListener('close',closed);fn(value)};const failed=finish(reject),closed=finish(code=>code===0?resolve():reject(new Error(`process exited with code ${code}`))),timer=setTimeout(()=>{try{child.kill('SIGKILL')}catch{};failed(new Error('process timed out'))},timeoutMs);child.once('error',failed);child.once('close',closed)});
}

async function runLinuxUpdate(archive, stage) {
  if (process.env.APPIMAGE) {
    const target = path.resolve(process.env.APPIMAGE);
    let targetStat;try{targetStat=await fsp.stat(target)}catch{}
    if (!targetStat?.isFile()) throw new Error('AppImage path is not available');
    const replacement = path.join(stage, path.basename(target));
    await fsp.rename(archive, replacement);
    await fsp.chmod(replacement, 0o755);
    await handOffLinuxReplacement(target, replacement, path.basename(target), stage);
    return;
  }

  const installRoot = path.dirname(process.resourcesPath);
  const executable = path.basename(process.execPath);
  const extractRoot = path.join(stage, 'extracted');
  await fsp.mkdir(extractRoot, { recursive: true, mode: 0o700 });
  try { await waitForExit(spawn('tar', ['-xzf', archive, '-C', extractRoot], { stdio: 'ignore' }), 10*60*1000); }
  catch { throw new Error('could not unpack Linux update'); }
  const replacement = await findLinuxBundle(extractRoot, executable);
  if (!replacement) throw new Error('Linux update did not contain one app bundle');
  await handOffLinuxReplacement(installRoot, replacement, executable, stage);
}

async function install(manifest) {
  if (installing) return;
  const fields = updateFields(manifest);
  const url = trustedArtifactUrl(fields?.url);
  const sha256 = String(fields?.sha256 || '').toLowerCase();
  if (!url || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('invalid update metadata');
  installing = true;
  let stage = null;
  try {
    if (process.platform === 'linux') await assertLinuxUpdateTargetWritable();
    await fsp.mkdir(updateDirectory(), { recursive: true, mode: 0o700 });
    stage = await fsp.mkdtemp(path.join(updateDirectory(), 'stage-'));
    activeUpdateStages.add(path.resolve(stage));
    const version=validVersion(manifest.version);if(!version)throw new Error('invalid update version');
    const filename = process.platform === 'win32' ? `${PRODUCT_NAME}-Setup-${version}.exe` : `${PRODUCT_NAME}-${version}${fields.extension}`;
    report('downloading', `Downloading ${PRODUCT_NAME} ${version}…`, { version, percent: 0 });
    // Keyed by the signed hash, outside the throwaway stage, so a download that
    // ran out of retries continues from the same bytes next time.
    const partial = path.join(updateDirectory(), `download-${sha256}.part`);
    await removeOtherPartials(sha256);
    let retrying = '';
    const downloaded = await download(url, partial, sha256, (received, total) => {
      const percent = total ? Math.min(100, Math.round(received / total * 100)) : null;
      report('downloading', `${retrying || `Downloading ${PRODUCT_NAME} ${version}…`}${percent == null ? '' : ` ${percent}%`}`, { version, percent });
    }, {
      onRetry: (attempt, attempts) => {
        retrying = `Connection dropped. Resuming ${PRODUCT_NAME} ${version} download (try ${attempt + 1} of ${attempts + 1})…`;
        report('downloading', retrying, { version, percent: updateStatus.percent ?? null });
      }
    });
    const archive = path.join(stage, filename);
    await fsp.rename(downloaded, archive);
    report('installing', `Verifying and installing ${PRODUCT_NAME} ${version}…`, { version });
    if (process.platform === 'win32') await runWindowsInstaller(archive);
    else if (process.platform === 'linux') await runLinuxUpdate(archive, stage);
  } catch (error) {
    installing = false;
    if (stage) try { await fsp.rm(stage, { recursive: true, force: true }); } catch {}
    throw error;
  } finally { if (stage) activeUpdateStages.delete(path.resolve(stage)); }
}

async function removeOtherPartials(keepHash) {
  let entries = [];
  try { entries = await fsp.readdir(updateDirectory()); } catch { return; }
  for (const name of entries) {
    if (/^download-[a-f0-9]{64}\.part$/.test(name) && name !== `download-${keepHash}.part`) await fsp.rm(path.join(updateDirectory(), name), { force: true }).catch(() => {});
  }
}

function feedCandidates(feedUrl) {
  return feedUrl === DEFAULT_FEED ? [DEFAULT_FEED, FALLBACK_FEED] : [feedUrl];
}

// A few quick attempts, alternating feeds, before giving up on this round.
async function fetchVerifiedManifest(feedUrl, { retryDelays = CHECK_RETRY_DELAYS_MS } = {}) {
  const feeds = feedCandidates(feedUrl);
  let lastError = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    if (attempt) {
      report('checking', 'Checking for updates… (retrying)');
      await delay(retryDelays[attempt - 1]);
    }
    try { return verifyManifest(await fetchManifest(feeds[attempt % feeds.length]), app?.getVersion?.(), { requireNewer: false }); }
    catch (error) { lastError = error; }
  }
  throw lastError || new Error('update check failed');
}

function scheduleCheckRetry(feedUrl) {
  clearTimeout(retryTimer);
  const wait = CHECK_BACKOFF_MS[Math.min(checkFailures, CHECK_BACKOFF_MS.length) - 1] || CHECK_BACKOFF_MS[0];
  retryTimer = setTimeout(() => void checkOnce(feedUrl), wait);
  retryTimer.unref?.();
  return wait;
}

async function checkOnce(feedUrl) {
  if (checking || installing || !feedUrl || !app.isPackaged) return;
  checking = true;
  report('checking', 'Checking for updates…');
  try {
    const manifest = await fetchVerifiedManifest(feedUrl);
    checkFailures = 0;clearTimeout(retryTimer);
    const version=manifest.version;
    if (!isNewer(app.getVersion(), version)) {
      availableManifest = null;
      report('current', `${PRODUCT_NAME} ${app.getVersion()} is up to date.`);
      return;
    }
    const notes = releaseNotes(manifest.notes);
    availableManifest = manifest;
    console.log(`[updater] ${PRODUCT_NAME} ${version} is available; waiting for approval`);
    report('available', `Update found: ${PRODUCT_NAME} ${version}. Download when you are ready.`, { version, canInstall: true, notes });
  } catch (error) {
    console.log('[updater] check failed:', error.message);
    checkFailures++;
    const minutes = Math.round(scheduleCheckRetry(feedUrl) / 60000);
    // A known update stays offered; only a first contact reports the failure.
    if (availableManifest) report('available', `Update found: ${PRODUCT_NAME} ${availableManifest.version}. Download when you are ready.`, { version: availableManifest.version, canInstall: true, notes: releaseNotes(availableManifest.notes) });
    else report('failed', `Couldn't reach the update server (${error.message}). Trying again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  } finally { checking = false; }
}

async function installAvailableUpdate() {
  if (installing) return false;
  const manifest = availableManifest;
  if (!manifest) return false;
  try {
    await install(manifest);
    return true;
  } catch (error) {
    console.log('[updater] install failed:', error.message);
    // Offer the same update again. A dropped download resumes from its bytes.
    const message = error.permanent ? `${error.message}.` : `Update download stopped: ${error.message}. Click Download to try again; it picks up where it left off.`;
    report('available', message, { version: manifest.version, canInstall: true, notes: releaseNotes(manifest.notes) });
    return false;
  }
}

function startAutoUpdater(options={}) {
  beforeExit=typeof options.beforeExit==='function'?options.beforeExit:async()=>{};
  const feed = readFeedUrl();
  if (timer) clearInterval(timer);
  // Check immediately on every launch. The interval catches a release that is
  // published while Knot is left running.
  void sweepStaleUpdateStages().catch(error=>console.warn('[updater] stale-stage cleanup failed:',error?.message||error)).finally(()=>void checkOnce(feed));
  timer = setInterval(() => void sweepStaleUpdateStages().catch(error=>console.warn('[updater] stale-stage cleanup failed:',error?.message||error)).finally(()=>void checkOnce(feed)), CHECK_INTERVAL);
  timer.unref?.();
}

module.exports = { startAutoUpdater, isNewer, validVersion, releaseNotes, canonicalManifestPayload, verifyManifest, getUpdateStatus: () => updateStatus, installAvailableUpdate,
  _test: { install, download, fetchVerifiedManifest, feedCandidates, sweepStaleUpdateStages, reset: () => { installing = false;availableManifest = null;checking = false;checkFailures = 0;clearTimeout(retryTimer);activeUpdateStages.clear(); }, isInstalling: () => installing } };
