#!/usr/bin/env node
// Trim the static catalog to a budget, keeping quality order: WTFPL > CC BY
// 4.0 > Basic, then popularity, then stable id. Animated rows are never
// touched. Pruned hashes land on a denylist so future crawl passes never
// re-add them.
const fs = require('fs');
const path = require('path');
const { open } = require('./lib/db');
const { rank } = require('./lib/licenses');

let keepBudget = 5000;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--keep') keepBudget = Math.max(0, parseInt(process.argv[++i], 10) || 0);
}
const outputDir = path.resolve(__dirname, '..', '..', 'emoji-catalog');
const db = open(outputDir);

db.exec(`CREATE TABLE IF NOT EXISTS denylist (
  asset_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'pruned',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const staticRows = db.prepare('SELECT id,name,normalized_name,asset_hash,asset_path,license,faves FROM items WHERE animated=0').all()
  .sort((a, b) => rank(a.license) - rank(b.license) || (b.faves || 0) - (a.faves || 0) || a.id - b.id);
const keep = staticRows.slice(0, keepBudget);
const drop = staticRows.slice(keepBudget);
let freedBytes = 0;

if (drop.length) {
  // Bulk strategy: detach FTS triggers first (node:sqlite binds FTS5 'delete'
  // commands strictly), delete items in chunks, then rebuild the index.
  db.exec('DROP TRIGGER IF EXISTS items_ai; DROP TRIGGER IF EXISTS items_ad;');
  const ids = drop.map(r => r.id).join(',');
  for (const row of drop) {
    const abs = path.join(outputDir, row.asset_path);
    try { freedBytes += fs.statSync(abs).size; fs.unlinkSync(abs); } catch {}
    db.prepare('INSERT OR IGNORE INTO denylist(asset_hash) VALUES (?)').run(row.asset_hash);
  }
  db.exec(`DELETE FROM items WHERE id IN (${ids})`);
} else {
  console.log('Static catalog already within budget.');
}

// Recreate search triggers + rebuild the index from surviving rows.
db.exec(`DROP TABLE IF EXISTS emoji_fts;
CREATE VIRTUAL TABLE emoji_fts USING fts5(normalized_name, search_text, content='items', content_rowid='id');
INSERT INTO emoji_fts(emoji_fts) VALUES('rebuild');
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO emoji_fts(rowid, normalized_name, search_text)
  VALUES (new.id, new.normalized_name, new.search_text);
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO emoji_fts(emoji_fts, rowid, normalized_name, search_text)
  VALUES ('delete', old.id, old.normalized_name, old.search_text);
END;`);

const s = db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(animated),0) anim,
    COALESCE(SUM(CASE WHEN license='WTFPL' THEN 1 ELSE 0 END),0) w,
    COALESCE(SUM(CASE WHEN license='CC-BY-4.0' THEN 1 ELSE 0 END),0) cc,
    COALESCE(SUM(CASE WHEN license='Basic' THEN 1 ELSE 0 END),0) basic FROM items`).get();
try {
  const manifestPath = path.join(outputDir, 'manifest', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.totalCount = s.total; manifest.animatedCount = s.anim; manifest.staticCount = s.total - s.anim;
  manifest.basicCount = s.basic; manifest.wtfplCount = s.w; manifest.ccByCount = s.cc;
  manifest.note = 'Animated uncapped; static trimmed to operator budget; pruned hashes denied from re-collection.';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
} catch {}
console.log(`[Emoji Prune] kept ${keep.length} static · removed ${drop.length} · freed ${(freedBytes / 1073741824).toFixed(2)} GB
Catalog now: ${s.total} total · ${s.anim} animated · ${s.total - s.anim} static (W:${s.w} C:${s.cc} B:${s.basic})`);
db.close();
