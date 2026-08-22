// Emoji.gg catalog access for the renderer: indexed search and attribution.
// The catalog is a locally collected SQLite database (see tools/emoji-collector).
// A missing catalog must never affect app startup: every entry point degrades
// to an empty result set.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const CATALOG_DIR = path.join(__dirname, 'emoji-catalog');
const SYNONYMS = {
  lol: ['laugh', 'laughing', 'lmao'], cry: ['crying', 'sad', 'tears'],
  mad: ['angry', 'rage'], heart: ['love', 'hearts'], skull: ['dead', 'death'],
  party: ['celebrate', 'celebration'], happy: ['smile', 'joy'],
  cat: ['kitty', 'kitten'], frog: ['pepe'], dance: ['dancing', 'party'],
};
let db = null;

function normalizeName(name) { return String(name || '').toLowerCase().replace(/[_\-+.]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function available() { return !!db; }

function init() {
  const dbPath = path.join(CATALOG_DIR, 'manifest', 'catalog.db');
  if (!fs.existsSync(dbPath)) return false;
  try { db = new DatabaseSync(dbPath); } catch (error) { console.warn('[emoji catalog] unavailable:', error.message); db = null; }
  return !!db;
}

function stats() {
  if (!db) return { total: 0, animated: 0 };
  try { return db.prepare('SELECT COUNT(*) total, COALESCE(SUM(animated),0) animated FROM items').get(); } catch { return { total: 0, animated: 0 }; }
}

// Ranking tiers mandated by the catalog design: exact name beats token match
// beats prefix beats substring beats tag hit; popularity then a stable id as
// tie-breakers so identical scores never shuffle between keystrokes.
function scoreRow(row, normQuery, tokens) {
  let score = 0;
  if (!normQuery) return row.faves || 0;
  if (row.normalized_name === normQuery) score += 1000;
  else if (row.normalized_name.startsWith(normQuery)) score += 600;
  else if (row.normalized_name.includes(normQuery)) score += 300;
  const words = row.normalized_name.split(' ');
  for (const token of tokens) {
    if (words.includes(token)) score += 500;
    else if (words.some(word => word.startsWith(token))) score += 250;
    if (token.length >= 3 && row.normalized_name.includes(token)) score += 100;
    const tags = row.search_text && row.search_text !== row.normalized_name ? row.search_text.toLowerCase() : '';
    if (tags) {
      if (tags.split(/[^a-z0-9]+/).includes(token)) score += 150;
      else if (tags.includes(token)) score += 60;
    }
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
  cursor = Math.max(0, parseInt(cursor, 10) || 0);
  type = type === 'animated' || type === 'static' ? type : 'all';
  const normQuery = normalizeName(q);
  const tokens = Array.from(new Set(normQuery.split(' ').filter(Boolean).flatMap(token => [token, ...(SYNONYMS[token] || [])])));
  let rows;
  if (tokens.length) {
    const matchClause = tokens.map(t => `"${t.replace(/["*]/g, '')}"*`).join(' OR ');
    rows = db.prepare(`SELECT i.*, bm25(emoji_fts) AS bm FROM emoji_fts f JOIN items i ON i.id=f.rowid WHERE emoji_fts MATCH ? LIMIT 400`).all(matchClause);
    // Typo tolerance: when strict matching is thin, accept near-misses within
    // an edit-distance budget against every name word (bounded early-exit).
    const FUZZY_CAP = normQuery.length >= 7 ? 2 : 1;
    if (rows.length < limit && normQuery.length >= 4) {
      const have = new Set(rows.map(r => r.id));
      for (const row of db.prepare('SELECT * FROM items').all()) {
        if (have.has(row.id)) continue;
        const words = row.normalized_name.split(' ');
        const matched = words.some(word => tokens.some(token => token.length >= 4 && editDistanceWithin(word, token, FUZZY_CAP)))
          || tokens.some(token => token.length >= 5 && editDistanceWithin(row.normalized_name.replace(/ /g, ''), token, FUZZY_CAP))
          || tokens.some(token => token.length >= 6 && row.normalized_name.includes(token.slice(0, Math.max(4, token.length - 2))));
        if (!matched) continue;
        rows.push(row); have.add(row.id);
      }
    }
  } else {
    rows = db.prepare(`SELECT *, 0 AS bm FROM items ORDER BY faves DESC, id ASC`).all();
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
    url: `emoji:///${String(row.asset_hash).slice(0, 2)}/${row.asset_hash}.${row.ext}`,
    license: row.license, author: row.author || '', category: row.category,
    sourcePage: row.source_page, faves: row.faves || 0,
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
  return db.prepare(`SELECT external_id AS id, name, author, license, source_page AS sourcePage,
      animated, attribution_required AS attributionRequired
    FROM items ORDER BY license ASC, normalized_name ASC LIMIT 2000`).all()
    .map(row => ({ ...row, attributionRequired: !!row.attributionRequired }));
}

module.exports = { CATALOG_DIR, init, available, search, get, attributions, stats, normalizeName };
