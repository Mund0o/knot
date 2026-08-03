// Linux update notifier. It never downloads or launches software itself.
// A release manifest is accepted only from HTTPS and must provide a SHA-256
// checksum that the download page can show to the user for verification.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const DEFAULT_FEED = 'https://raw.githubusercontent.com/Mund0o/pair/master/public';
const CHECK_INTERVAL = 30 * 60 * 1000;
let timer = null;
let initialTimer = null;
let checking = false;

function httpsUrl(value) {
  try { const u = new URL(String(value)); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}
function readFeedUrl() {
  const configured = process.env.PAIR_FEED || (() => { try { return fs.readFileSync(path.join(os.homedir(), '.pair-update-url'), 'utf8').trim(); } catch { return ''; } })();
  return httpsUrl(configured || DEFAULT_FEED);
}
function isNewer(local, remote) {
  const a = String(local).split('.').map(n => parseInt(n, 10) || 0), b = String(remote).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((b[i] || 0) !== (a[i] || 0)) return (b[i] || 0) > (a[i] || 0); }
  return false;
}
function fetchText(url, depth = 0) {
  if (depth > 3 || !httpsUrl(url)) return Promise.reject(new Error('unsafe update URL'));
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(fetchText(new URL(res.headers.location, url).href, depth + 1));
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > 256 * 1024) req.destroy(new Error('manifest too large')); else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}
async function checkOnce(feedUrl) {
  if (checking || !feedUrl) return;
  checking = true;
  try {
    const manifest = JSON.parse(await fetchText(feedUrl.replace(/\/$/, '') + '/latest.json'));
    const url = httpsUrl(manifest.linuxUrl);
    if (!isNewer(app.getVersion(), manifest.version) || !url || !/^[a-f0-9]{64}$/i.test(String(manifest.linuxSha256 || ''))) return;
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send('update-available', { platform: 'linux', version: String(manifest.version), notes: String(manifest.notes || ''), url, sha256: manifest.linuxSha256.toLowerCase(), stage: 'link' });
  } catch (e) { console.log('[updater] check failed:', e.message); } finally { checking = false; }
}
function startAutoUpdater() {
  const feed = readFeedUrl();
  if (initialTimer) clearTimeout(initialTimer); if (timer) clearInterval(timer);
  initialTimer = setTimeout(() => checkOnce(feed), 4000);
  timer = setInterval(() => checkOnce(feed), CHECK_INTERVAL);
}
function performInstall() {} // Linux builds are deliberately never self-installed.
module.exports = { startAutoUpdater, performInstall };
