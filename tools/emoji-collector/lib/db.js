// Catalog database: items, crawl checkpoint state, and FTS5 search.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

function open(outputDir) {
  fs.mkdirSync(path.join(outputDir, 'manifest'), { recursive: true });
  const db = new DatabaseSync(path.join(outputDir, 'manifest', 'catalog.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT 'emoji.gg',
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      slug TEXT NOT NULL,
      category INTEGER,
      animated INTEGER NOT NULL DEFAULT 0,
      mime TEXT NOT NULL,
      ext TEXT NOT NULL,
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      file_size INTEGER DEFAULT 0,
      asset_hash TEXT NOT NULL UNIQUE,
      asset_path TEXT NOT NULL,
      license TEXT NOT NULL CHECK (license IN ('WTFPL','CC-BY-4.0','Basic')),
      author TEXT DEFAULT '',
      source_page TEXT NOT NULL,
      original_url TEXT NOT NULL,
      attribution_required INTEGER NOT NULL DEFAULT 0,
      faves INTEGER DEFAULT 0,
      search_text TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_items_normalized ON items(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_items_animated ON items(animated);
    CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
    CREATE INDEX IF NOT EXISTS idx_items_license ON items(license);
    CREATE INDEX IF NOT EXISTS idx_items_faves ON items(faves DESC);
    CREATE TABLE IF NOT EXISTS crawl_state (
      url TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('queued','processing','complete','complete-metadata','skipped-license','duplicate','failed-temporary','failed-permanent')),
      attempts INTEGER DEFAULT 0,
      last_error TEXT DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_state_status ON crawl_state(status);
    CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS emoji_fts USING fts5(
      normalized_name, search_text, content='items', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
      INSERT INTO emoji_fts(rowid, normalized_name, search_text)
      VALUES (new.id, new.normalized_name, new.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
      INSERT INTO emoji_fts(emoji_fts, rowid, normalized_name, search_text)
      VALUES ('delete', old.id, old.normalized_name, old.search_text);
    END;
  `);
  return db;
}

module.exports = { open };
