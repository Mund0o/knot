#!/usr/bin/env node
// Catalog integrity check: every stored asset must exist, hash-match its
// recorded content hash, and carry an accurate animated flag derived from the
// actual bytes (never filenames). Pass --repair to fix drifted animation flags
// and purge rows whose assets are missing or corrupt.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open } = require('./lib/db');
const { sniff, isAnimated } = require('./lib/images');

const args = { repair: process.argv.includes('--repair') };
const outputDir = path.resolve(__dirname, '..', '..', 'emoji-catalog');
if (!fs.existsSync(path.join(outputDir, 'manifest', 'catalog.db'))) {
  console.error('No catalog database at', outputDir, '— run npm run emoji:collect first.');
  process.exit(1);
}
const db = open(outputDir);
const rows = db.prepare('SELECT id,name,asset_hash,asset_path,mime,animated FROM items').all();
let verified = 0, animDrift = 0, missing = 0, corrupt = 0, purged = 0;
for (const row of rows) {
  const abs = path.join(outputDir, row.asset_path);
  if (!fs.existsSync(abs)) { missing++; console.warn('MISSING:', row.name, row.asset_path); if (args.repair) { db.prepare('DELETE FROM items WHERE id=?').run(row.id); db.prepare("INSERT INTO emoji_fts(emoji_fts,rowid,normalized_name,search_text) VALUES('delete',?,?,?)").run(row.id, row.normalized_name || '', row.search_text || ''); purged++; } continue; }
  const buffer = fs.readFileSync(abs);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (hash !== row.asset_hash) { corrupt++; console.warn('HASH MISMATCH:', row.name); if (args.repair) { db.prepare('DELETE FROM items WHERE id=?').run(row.id); purged++; } continue; }
  const sniffed = sniff(buffer);
  const animated = sniffed ? isAnimated(buffer, sniffed.mime) : false;
  if (!!row.animated !== animated) {
    animDrift++;
    if (args.repair) db.prepare('UPDATE items SET animated=? WHERE id=?').run(animated ? 1 : 0, row.id);
    else console.warn(`ANIM DRIFT: ${row.name} recorded=${!!row.animated} actual=${animated}`);
  }
  verified++;
}
const stats = args.repair ? db.prepare(`SELECT COUNT(*) total,SUM(animated) a FROM items`).get() : null;
console.log(`\n[Emoji Verify] ${verified} verified / ${rows.length} rows · missing ${missing} · corrupt ${corrupt} · animation drift ${animDrift}${purged ? ` · purged ${purged}` : ''}`);
if (args.repair && stats) console.log(`Catalog after repair: ${stats.total} items (${stats.a || 0} animated)`);
if ((missing || corrupt) && !args.repair) { console.log('Run with --repair to purge broken entries.'); process.exitCode = 2; }
db.close();
