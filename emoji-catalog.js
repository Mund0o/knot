// Emoji.gg catalog access for the renderer: indexed search and attribution.
// The catalog is a locally collected SQLite database (see tools/emoji-collector).
// A missing catalog must never affect app startup: every entry point degrades
// to an empty result set.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const PREFERRED_DIR = 'emoji-catalog';
// Resolution order: explicit env override, then the app's userData directory
// (canonical for installs), then the development folder beside this module.
function candidateDirs(app) {
  const list = [];
  if (process.env.KNOT_EMOJI_CATALOG) list.push(process.env.KNOT_EMOJI_CATALOG);
  try { if (app?.isPackaged && process.resourcesPath) list.push(path.join(process.resourcesPath, PREFERRED_DIR)); } catch {}
  try { if (app?.getPath) list.push(path.join(app.getPath('userData'), PREFERRED_DIR)); } catch {}
  list.push(path.join(__dirname, PREFERRED_DIR));
  return [...new Set(list)];
}
const CATALOG_DIR = path.join(__dirname, PREFERRED_DIR);
const SYNONYMS = {
  lol: ['laugh', 'laughing', 'lmao'], cry: ['crying', 'sad', 'tears'],
  mad: ['angry', 'rage'], heart: ['love', 'hearts'], skull: ['dead', 'death'],
  party: ['celebrate', 'celebration'], happy: ['smile', 'joy'],
  cat: ['kitty', 'kitten'], frog: ['pepe'], dance: ['dancing', 'party'],
};
let db = null;
let activeRoots = [];

function normalizeName(name) { return String(name || '').toLowerCase().replace(/[_\-+.]+/g, ' ').replace(/[^\p{L}\p{N}\s]+/gu,' ').replace(/\s+/g, ' ').trim(); }

function available() { return !!db; }

// Open whichever catalog database is most recently updated so an installed
// app automatically follows a collection still running in the dev tree.
function init(app) {
  const dirs = candidateDirs(app).flatMap(dir=>{const file=path.join(dir,'manifest','catalog.db');try{const stat=fs.statSync(file);return stat.isFile()?[{dir,mtime:stat.mtimeMs}]:[]}catch{return[]}});
  if (!dirs.length) { try{db?.close?.()}catch{}db = null; activeRoots = []; return false; }
  dirs.sort((a,b)=>b.mtime-a.mtime);
  try { db?.close?.();db = new DatabaseSync(path.join(dirs[0].dir, 'manifest', 'catalog.db'),{readOnly:true}); } catch (error) { console.warn('[emoji catalog] unavailable:', error.message); db = null; return false; }
  activeRoots = dirs.map(entry=>entry.dir);
  return true;
}

function dir() { return activeRoots[0] || CATALOG_DIR; }

function resolveAsset(relPath) {
  if (!/^[0-9a-f]{2}\/[0-9a-f]{64}\.(gif|png|webp|jpg)$/.test(relPath)) return null;
  for (const root of activeRoots) {
    const abs = path.join(root, 'originals', relPath);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function stats() {
  if (!db) return { total: 0, animated: 0 };
  try { return db.prepare('SELECT COUNT(*) total, COALESCE(SUM(animated),0) animated FROM items').get(); } catch { return { total: 0, animated: 0 }; }
}

// Ranking tiers mandated by the catalog design: exact name beats token match
// beats prefix beats substring beats tag hit; popularity then a stable id as
// tie-breakers so identical scores never shuffle between keystrokes.
function scoreRow(row, normQuery, tokens) {
  if (!normQuery) return row.faves || 0;
  // Tiers are exclusive: a better tier always outranks any pile of weaker
  // signals, so an exact name can never lose to a longer name that merely
  // starts with the query.
  const words = row.normalized_name.split(' ');
  let base;
  if (normQuery === row.normalized_name) base = 1000;
  else if (words.includes(normQuery)) base = 800;
  else if (row.normalized_name.startsWith(normQuery)) base = 600;
  else if (words.some(word => word.startsWith(normQuery))) base = 400;
  else if (row.normalized_name.includes(normQuery)) base = 200;
  else base = 0;
  let score = base;
  for (const token of tokens) {
    if (token.length >= 3 && words.some(word => word.startsWith(token))) score += 40;
    if (token.length >= 3 && row.normalized_name.includes(token)) score += 20;
  }
  score += Math.min(50, (row.faves || 0) / 20);
  return score;
}

// Bounded Damerau-Levenshtein used only when strict matching comes back thin.
// Early-exits once the distance provably exceeds cap so the scan stays cheap.
function editDistanceWithin(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return false;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j), cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > cap) return false;
    prev2 = prev; prev = cur.slice();
  }
  return prev[b.length] <= cap;
}

function search({ q = '', type = 'all', cursor = 0, limit = 60 } = {}) {
  if (!db) return { items: [], nextCursor: null, total: 0 };
  limit = Math.max(1, Math.min(200, limit | 0));
  cursor = Math.max(0,Math.min(1000000,parseInt(cursor, 10) || 0));
  type = type === 'animated' || type === 'static' ? type : 'all';
  const normQuery = normalizeName(q).slice(0,80);
  const tokens = Array.from(new Set(normQuery.split(' ').filter(Boolean).slice(0,12).flatMap(token => [token.slice(0,32), ...(SYNONYMS[token] || [])])));
  if (!tokens.length) {
    const filtered = type !== 'all', animated = type === 'animated' ? 1 : 0;
    const total = filtered
      ? db.prepare('SELECT COUNT(*) total FROM items WHERE animated=?').get(animated).total
      : db.prepare('SELECT COUNT(*) total FROM items').get().total;
    const rows = filtered
      ? db.prepare('SELECT * FROM items WHERE animated=? ORDER BY faves DESC, id ASC LIMIT ? OFFSET ?').all(animated, limit, cursor)
      : db.prepare('SELECT * FROM items ORDER BY faves DESC, id ASC LIMIT ? OFFSET ?').all(limit, cursor);
    return { items: rows.map(toPublicItem), nextCursor: cursor + limit < total ? cursor + limit : null, total };
  }
  let rows;
  const matchClause = tokens.map(t => `"${t.replace(/["*]/g, '')}"*`).join(' OR ');
  rows = db.prepare(`SELECT i.*, bm25(emoji_fts) AS bm FROM emoji_fts f JOIN items i ON i.id=f.rowid WHERE emoji_fts MATCH ? LIMIT 400`).all(matchClause);
  // Typo tolerance: when strict matching is thin, accept near-misses within
  // an edit-distance budget against every name word (bounded early-exit).
  const FUZZY_CAP = normQuery.length >= 7 ? 2 : 1;
  if (rows.length < limit && normQuery.length >= 4) {
    const have = new Set(rows.map(r => r.id));
    const fragments=new Set();
    for(const token of tokens.filter(value=>value.length>=4)){const size=token.length>=5?3:2,max=Math.max(0,token.length-size);for(const offset of [0,Math.floor(max/2),max])fragments.add(token.slice(offset,offset+size))}
    const probes=[...fragments].slice(0,24),where=probes.length?probes.map(()=>"instr(normalized_name,?)>0").join(' OR '):'1=1';
    const candidates=db.prepare(`SELECT * FROM items WHERE ${where} ORDER BY faves DESC,id ASC LIMIT 6000`).all(...probes);
    for (const row of candidates) {
      if (have.has(row.id)) continue;
      const words = row.normalized_name.split(' ');
      const matched = words.some(word => tokens.some(token => token.length >= 4 && editDistanceWithin(word, token, FUZZY_CAP)))
        || tokens.some(token => token.length >= 5 && editDistanceWithin(row.normalized_name.replace(/ /g, ''), token, FUZZY_CAP))
        || tokens.some(token => token.length >= 6 && row.normalized_name.includes(token.slice(0, Math.max(4, token.length - 2))));
      if (!matched) continue;
      rows.push(row); have.add(row.id);
    }
  }
  if (type !== 'all') rows = rows.filter(row => type === 'animated' ? row.animated === 1 : row.animated === 0);
  const ranked = rows
    .map(row => ({ row, score: scoreRow(row, normQuery, tokens) }))
    .sort((a, b) => b.score - a.score || a.row.id - b.row.id)
    .map(entry => entry.row);
  const page = ranked.slice(cursor, cursor + limit).map(toPublicItem);
  return { items: page, nextCursor: cursor + limit < ranked.length ? cursor + limit : null, total: ranked.length };
}

function toPublicItem(row) {
  return {
    id: row.external_id, name: row.name, animated: !!row.animated,
    // Keep the prefix as the custom-scheme host. The previous three-slash URL
    // put it in the path while the protocol handler (and saved-message URL
    // validator) correctly expected emoji://<prefix>/<hash>.<ext>.
    url: `emoji://${String(row.asset_hash).slice(0, 2)}/${row.asset_hash}.${row.ext}`,
    // Used only if a recipient does not have this catalog snapshot locally.
    // The app prefers the offline emoji:// copy and falls back to this HTTPS
    // source after a load failure.
    fallbackUrl: row.original_url,
    license: row.license, author: row.author || '', category: row.category,
    sourcePage: row.source_page,
  };
}

// Full detail incl. attribution data — only this endpoint returns heavy fields.
function get(externalId) {
  if (!db || externalId == null) return null;
  const row = db.prepare('SELECT * FROM items WHERE external_id=?').get(String(externalId));
  if (!row) return null;
  return { ...toPublicItem(row), slug: row.slug, width: row.width, height: row.height, fileSize: row.file_size,
    assetHash: row.asset_hash, sourcePage: row.source_page, originalUrl: row.original_url,
    attributionRequired: !!row.attribution_required, createdAt: row.created_at };
}

function attributions() {
  if (!db) return [];
  // Return every legally required credit. Ordering the entire catalog and then
  // truncating it hid all CC-BY rows whenever Basic-license rows filled the
  // first page, which made the in-app attribution screen incomplete.
  return db.prepare(`SELECT * FROM items WHERE attribution_required=1 ORDER BY normalized_name ASC, id ASC`).all()
    .map(row => ({ ...toPublicItem(row), attributionRequired: !!row.attribution_required }));
}

module.exports = { CATALOG_DIR, dir, resolveAsset, init, available, search, get, attributions, stats, normalizeName };
