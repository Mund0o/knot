'use strict';

// Emoji.gg integration without redistributing its image catalog. Metadata is
// fetched from the public legacy API and indexed locally; image bytes are only
// downloaded on demand into a small, bounded cache on the user's own device.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const API_URL = 'https://emoji.gg/api';
const CACHE_DIR = 'emoji-api-cache';
const METADATA_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_API_BYTES = 10 * 1024 * 1024;
const MAX_API_ITEMS = 10000;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_FILES = 512;
const FETCH_TIMEOUT_MS = 12000;
const SYNONYMS = {
  lol: ['laugh', 'laughing', 'lmao'], cry: ['crying', 'sad', 'tears'],
  mad: ['angry', 'rage'], heart: ['love', 'hearts'], skull: ['dead', 'death'],
  party: ['celebrate', 'celebration'], happy: ['smile', 'joy'],
  cat: ['kitty', 'kitten'], frog: ['pepe'], dance: ['dancing', 'party'],
};

let db = null;
let activeRoot = '';
let readOnly = false;
let refreshPromise = null;
const assetRequests = new Map();

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[_\-+.]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function resolveRoot(app, options = {}) {
  if (typeof options.cacheRoot === 'string' && options.cacheRoot) return path.resolve(options.cacheRoot);
  if (process.env.KNOT_EMOJI_CACHE) return path.resolve(process.env.KNOT_EMOJI_CACHE);
  try { if (app?.getPath) return path.join(app.getPath('appData'), 'Knot', CACHE_DIR); } catch {}
  return path.join(__dirname, CACHE_DIR);
}

function createSchema(database) {
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS items(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      slug TEXT NOT NULL,
      image_url TEXT NOT NULL,
      ext TEXT NOT NULL,
      animated INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      license TEXT NOT NULL DEFAULT '',
      faves INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS emoji_fts USING fts5(
      normalized_name, name, author, description, tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS asset_cache(
      item_id INTEGER PRIMARY KEY,
      file_name TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    );
  `);
}

function init(app, options = {}) {
  try { db?.close?.(); } catch {}
  db = null;
  activeRoot = resolveRoot(app, options);
  readOnly = options.readOnly === true;
  const databasePath = path.join(activeRoot, 'catalog.db');
  try {
    if (readOnly) {
      if (!fs.existsSync(databasePath)) return false;
      db = new DatabaseSync(databasePath, { readOnly: true });
      db.exec('PRAGMA busy_timeout=3000');
    } else {
      fs.mkdirSync(path.join(activeRoot, 'assets'), { recursive: true, mode: 0o700 });
      db = new DatabaseSync(databasePath);
      createSchema(db);
      pruneAssets();
    }
    return true;
  } catch (error) {
    console.warn('[emoji api] local index unavailable:', error?.message || error);
    try { db?.close?.(); } catch {}
    db = null;
    return false;
  }
}

function dir() { return activeRoot; }
function available() { return !!db; }
function meta(key) { try { return db?.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value || ''; } catch { return ''; } }
function setMeta(key, value) { db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }

function stats() {
  if (!db) return { total: 0, animated: 0, cacheBytes: 0, cacheFiles: 0, updatedAt: 0, source: 'api' };
  try {
    const items = db.prepare('SELECT COUNT(*) total, COALESCE(SUM(animated),0) animated FROM items').get();
    const cache = readOnly ? { cacheBytes: 0, cacheFiles: 0 } : db.prepare('SELECT COALESCE(SUM(bytes),0) cacheBytes, COUNT(*) cacheFiles FROM asset_cache').get();
    return { ...items, ...cache, updatedAt: Number(meta('updated_at')) || 0, source: 'api' };
  } catch { return { total: 0, animated: 0, cacheBytes: 0, cacheFiles: 0, updatedAt: 0, source: 'api' }; }
}

function safeImageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || !/^cdn\d*\.emoji\.gg$/i.test(url.hostname) || !/^\/emojis\//.test(url.pathname)) return null;
    const match = /\.((?:png|gif|webp|jpg|jpeg))$/i.exec(url.pathname);
    if (!match) return null;
    return { href: url.href, ext: match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase() };
  } catch { return null; }
}

function cleanApiItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id), image = safeImageUrl(raw.image), name = String(raw.title || '').trim().slice(0, 120);
  if (!Number.isSafeInteger(id) || id <= 0 || !image || !name) return null;
  return {
    id, name, normalizedName: normalizeName(name), slug: String(raw.slug || id).trim().slice(0, 180),
    imageUrl: image.href, ext: image.ext, animated: image.ext === 'gif' ? 1 : 0,
    category: String(raw.category ?? '').slice(0, 32), author: String(raw.submitted_by || '').trim().slice(0, 120),
    description: String(raw.description || '').trim().slice(0, 500), license: String(raw.license ?? '').slice(0, 32),
    faves: Math.max(0, Math.min(100000000, Number(raw.faves) || 0)),
  };
}

async function fetchJson(url, { maxBytes = MAX_API_BYTES, timeout = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'Knot emoji picker' },
    });
    if (!response.ok) throw new Error(`Emoji.gg returned HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length')) || 0;
    if (declared > maxBytes) throw new Error('Emoji.gg response exceeded the metadata limit');
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maxBytes) throw new Error('Emoji.gg response exceeded the metadata limit');
    return JSON.parse(body.toString('utf8'));
  } finally { clearTimeout(timer); }
}

async function refresh({ force = false } = {}) {
  if (!db || readOnly) return stats();
  const current = stats(), now = Date.now();
  if (!force && current.total > 0 && now - current.updatedAt < METADATA_TTL_MS) return current;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const payload = await fetchJson(API_URL);
    if (!Array.isArray(payload)) throw new Error('Emoji.gg returned an invalid catalog');
    const byId = new Map();
    for (const raw of payload.slice(0, MAX_API_ITEMS)) { const item = cleanApiItem(raw);if (item) byId.set(item.id, item); }
    const items = [...byId.values()];
    if (!items.length) throw new Error('Emoji.gg returned an empty catalog');
    const insertItem = db.prepare(`INSERT INTO items(id,name,normalized_name,slug,image_url,ext,animated,category,author,description,license,faves)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertFts = db.prepare('INSERT INTO emoji_fts(rowid,normalized_name,name,author,description) VALUES(?,?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM emoji_fts; DELETE FROM items;');
      for (const item of items) {
        insertItem.run(item.id,item.name,item.normalizedName,item.slug,item.imageUrl,item.ext,item.animated,item.category,item.author,item.description,item.license,item.faves);
        insertFts.run(item.id,item.normalizedName,item.name,item.author,item.description);
      }
      setMeta('updated_at', now);setMeta('api_url', API_URL);setMeta('item_count', items.length);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {}throw error; }
    return stats();
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function scoreRow(row, normQuery, tokens) {
  if (!normQuery) return row.faves || 0;
  const words = row.normalized_name.split(' ');let score;
  if (normQuery === row.normalized_name) score = 1000;
  else if (words.includes(normQuery)) score = 800;
  else if (row.normalized_name.startsWith(normQuery)) score = 600;
  else if (words.some(word => word.startsWith(normQuery))) score = 400;
  else if (row.normalized_name.includes(normQuery)) score = 200;
  else score = 0;
  for (const token of tokens) {
    if (token.length >= 3 && words.some(word => word.startsWith(token))) score += 40;
    if (token.length >= 3 && row.normalized_name.includes(token)) score += 20;
  }
  return score + Math.min(50, (row.faves || 0) / 20);
}

function editDistanceWithin(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return false;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j), cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > cap) return false;
    prev2 = prev;prev = cur.slice();
  }
  return prev[b.length] <= cap;
}

function toPublicItem(row) {
  return {
    id: String(row.id), name: row.name, animated: !!row.animated,
    url: `emoji://api/${row.id}.${row.ext}`, fallbackUrl: row.image_url,
    author: row.author || '', category: row.category || '',
    sourcePage: `https://emoji.gg/emoji/${encodeURIComponent(row.slug)}`,
  };
}

function search({ q = '', type = 'all', cursor = 0, limit = 60 } = {}) {
  if (!db) return { items: [], nextCursor: null, total: 0, stale: true };
  limit = Math.max(1, Math.min(120, Number(limit) | 0));cursor = Math.max(0, Math.min(100000, Number(cursor) | 0));
  type = type === 'animated' || type === 'static' ? type : 'all';
  const normQuery = normalizeName(q).slice(0, 80);
  const tokens = [...new Set(normQuery.split(' ').filter(Boolean).slice(0, 12).flatMap(token => [token.slice(0, 32), ...(SYNONYMS[token] || [])]))];
  try {
    if (!tokens.length) {
      const filter = type === 'animated' ? ' WHERE animated=1' : type === 'static' ? ' WHERE animated=0' : '';
      const total = db.prepare(`SELECT COUNT(*) total FROM items${filter}`).get().total;
      const rows = db.prepare(`SELECT * FROM items${filter} ORDER BY faves DESC,id DESC LIMIT ? OFFSET ?`).all(limit, cursor);
      return { items: rows.map(toPublicItem), nextCursor: cursor + limit < total ? cursor + limit : null, total, stale: Date.now() - (Number(meta('updated_at')) || 0) > METADATA_TTL_MS };
    }
    const match = tokens.map(token => `"${token.replace(/["*]/g, '')}"*`).join(' OR ');
    let rows = db.prepare('SELECT i.* FROM emoji_fts f JOIN items i ON i.id=f.rowid WHERE emoji_fts MATCH ? LIMIT 500').all(match);
    if (rows.length < limit && normQuery.length >= 4) {
      const seen = new Set(rows.map(row => row.id)), cap = normQuery.length >= 7 ? 2 : 1;
      const fragments = [...new Set(tokens.filter(token => token.length >= 4).flatMap(token => [token.slice(0, 3), token.slice(-3)]))].slice(0, 16);
      const where = fragments.length ? fragments.map(() => 'instr(normalized_name,?)>0').join(' OR ') : '1=1';
      for (const row of db.prepare(`SELECT * FROM items WHERE ${where} ORDER BY faves DESC,id DESC LIMIT 3000`).all(...fragments)) {
        if (seen.has(row.id)) continue;
        const words = row.normalized_name.split(' ');
        if (!words.some(word => tokens.some(token => token.length >= 4 && editDistanceWithin(word, token, cap)))) continue;
        seen.add(row.id);rows.push(row);
      }
    }
    if (type !== 'all') rows = rows.filter(row => type === 'animated' ? row.animated === 1 : row.animated === 0);
    rows = rows.map(row => ({ row, score: scoreRow(row, normQuery, tokens) }))
      .sort((a, b) => b.score - a.score || b.row.faves - a.row.faves || b.row.id - a.row.id).map(entry => entry.row);
    const page = rows.slice(cursor, cursor + limit).map(toPublicItem);
    return { items: page, nextCursor: cursor + limit < rows.length ? cursor + limit : null, total: rows.length, stale: Date.now() - (Number(meta('updated_at')) || 0) > METADATA_TTL_MS };
  } catch { return { items: [], nextCursor: null, total: 0, stale: true }; }
}

function get(externalId) {
  if (!db || !/^\d{1,12}$/.test(String(externalId || ''))) return null;
  try { const row = db.prepare('SELECT * FROM items WHERE id=?').get(Number(externalId));return row ? toPublicItem(row) : null; } catch { return null; }
}

function sniffAsset(buffer, expectedExt) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_ASSET_BYTES) return null;
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) return expectedExt === 'gif' ? 'image/gif' : null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return expectedExt === 'png' ? 'image/png' : null;
  if (buffer.length >= 12 && buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WEBP') return expectedExt === 'webp' ? 'image/webp' : null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return expectedExt === 'jpg' ? 'image/jpeg' : null;
  return null;
}

function cacheFileName(item) {
  const suffix = crypto.createHash('sha256').update(item.image_url).digest('hex').slice(0, 16);
  return `${item.id}-${suffix}.${item.ext}`;
}

function pruneAssets() {
  if (!db || readOnly) return;
  const assetDir = path.join(activeRoot, 'assets');let rows;
  try { rows = db.prepare('SELECT * FROM asset_cache ORDER BY accessed_at DESC,item_id DESC').all(); } catch { return; }
  let bytes = 0, files = 0;
  for (const row of rows) {
    const file = path.join(assetDir, path.basename(row.file_name));let valid = false;
    try { const stat = fs.statSync(file);valid = stat.isFile() && stat.size === row.bytes && stat.size > 0 && stat.size <= MAX_ASSET_BYTES; } catch {}
    if (valid && files < MAX_CACHE_FILES && bytes + row.bytes <= MAX_CACHE_BYTES) { files++;bytes += row.bytes;continue; }
    try { fs.unlinkSync(file); } catch {}
    try { db.prepare('DELETE FROM asset_cache WHERE item_id=?').run(row.item_id); } catch {}
  }
}

async function fetchAsset(item) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(item.image_url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'image/avif,image/webp,image/png,image/gif,image/jpeg', 'User-Agent': 'Knot emoji picker' } });
    if (!response.ok) throw new Error(`Emoji asset returned HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length')) || 0;
    if (declared > MAX_ASSET_BYTES) throw new Error('Emoji asset exceeded the cache item limit');
    const buffer = Buffer.from(await response.arrayBuffer()), mime = sniffAsset(buffer, item.ext);
    if (!mime) throw new Error('Emoji asset type did not match its URL');
    return { buffer, mime };
  } finally { clearTimeout(timer); }
}

async function assetForRequest(requestUrl) {
  if (!db || readOnly) return null;
  let parsed;
  try { parsed = new URL(requestUrl); } catch { return null; }
  if (parsed.protocol !== 'emoji:' || parsed.hostname !== 'api') return null;
  const match = /^\/(\d{1,12})\.(png|gif|webp|jpg)$/.exec(parsed.pathname);
  if (!match) return null;
  const id = Number(match[1]), requestedExt = match[2];
  let item;
  try { item = db.prepare('SELECT * FROM items WHERE id=?').get(id); } catch { return null; }
  if (!item || item.ext !== requestedExt || !safeImageUrl(item.image_url)) return null;
  const existing = assetRequests.get(id);if (existing) return existing;
  const task = (async () => {
    const fileName = cacheFileName(item), file = path.join(activeRoot, 'assets', fileName), now = Date.now();
    try {
      const buffer = await fs.promises.readFile(file), mime = sniffAsset(buffer, item.ext);
      if (mime) { db.prepare('INSERT INTO asset_cache(item_id,file_name,bytes,accessed_at) VALUES(?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET file_name=excluded.file_name,bytes=excluded.bytes,accessed_at=excluded.accessed_at').run(id,fileName,buffer.length,now);return { buffer, mime, cached: true }; }
    } catch {}
    const downloaded = await fetchAsset(item), temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try { await fs.promises.writeFile(temporary, downloaded.buffer, { flag: 'wx', mode: 0o600 });await fs.promises.rename(temporary, file); }
    catch (error) { await fs.promises.unlink(temporary).catch(() => {});throw error; }
    db.prepare('INSERT INTO asset_cache(item_id,file_name,bytes,accessed_at) VALUES(?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET file_name=excluded.file_name,bytes=excluded.bytes,accessed_at=excluded.accessed_at').run(id,fileName,downloaded.buffer.length,now);
    pruneAssets();return { ...downloaded, cached: false };
  })().finally(() => assetRequests.delete(id));
  assetRequests.set(id, task);return task;
}

function close() { try { db?.close?.(); } catch {}db = null; }

module.exports = {
  API_URL, CACHE_DIR, MAX_API_BYTES, MAX_ASSET_BYTES, MAX_CACHE_BYTES, MAX_CACHE_FILES,
  init, close, dir, available, refresh, search, get, stats, assetForRequest,
  normalizeName, safeImageUrl, cleanApiItem, sniffAsset,
};
