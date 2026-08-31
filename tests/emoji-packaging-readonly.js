'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { stageEmojiCatalog } = require('../scripts/before-pack');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-emoji-package-'));
const sourceManifest = path.join(root, 'emoji-catalog', 'manifest');
const stagedManifest = path.join(root, 'dist-emoji-catalog', 'manifest');

(async () => {
  try {
    fs.mkdirSync(sourceManifest, { recursive: true });
    const sourcePath = path.join(sourceManifest, 'catalog.db');
    const source = new DatabaseSync(sourcePath);
    source.exec('PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES (\'from-wal-snapshot\')');
    // Keep the source connection open so the packaging path must use SQLite's
    // snapshot API rather than assuming every committed page is in catalog.db.
    await stageEmojiCatalog(root);
    source.close();

    const stagedPath = path.join(stagedManifest, 'catalog.db');
    assert.strictEqual(fs.existsSync(stagedPath), true);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      assert.strictEqual(fs.existsSync(stagedPath + suffix), false, `packaged database leaked ${suffix}`);
    }

    fs.chmodSync(stagedPath, 0o444);
    fs.chmodSync(stagedManifest, 0o555);
    fs.chmodSync(path.dirname(stagedManifest), 0o555);
    const packaged = new DatabaseSync(stagedPath, { readOnly: true });
    try {
      assert.strictEqual(packaged.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
      assert.strictEqual(packaged.prepare('SELECT value FROM sample').get().value, 'from-wal-snapshot');
    } finally {
      packaged.close();
    }
    console.log('PASS packaged emoji catalog snapshot opens from read-only resources');
  } finally {
    try { fs.chmodSync(stagedManifest, 0o755); } catch {}
    try { fs.chmodSync(path.dirname(stagedManifest), 0o755); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error);process.exitCode = 1; });
