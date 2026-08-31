const fs = require('fs');
const path = require('path');
const { verifyWindowsAudioAddon } = require('./windows-audio-addon-guard');

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') {
    // Still stage on non-win dev builds so `npm run dist` stays consistent.
    await stageEmojiCatalog(context.packager.projectDir);
    return;
  }
  verifyWindowsAudioAddon(context.packager.projectDir);
  await stageEmojiCatalog(context.packager.projectDir);
};

// Copy the collected emoji catalog (db + assets + manifest) into a staging
// directory referenced by build.extraResources, so packaged apps ship the
// catalog without pulling crawler logs or WAL sidecars into installers.
async function stageEmojiCatalog(projectDir) {
  const srcCatalog = path.join(projectDir, 'emoji-catalog');
  const stage = path.join(projectDir, 'dist-emoji-catalog');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'manifest'), { recursive: true });
  const dbSrc = path.join(srcCatalog, 'manifest', 'catalog.db');
  const dbDst = path.join(stage, 'manifest', 'catalog.db');
  if (!fs.existsSync(dbSrc)) {
    // CI checkouts don't carry the gitignored catalog. Fetch the pinned
    // snapshot release instead of shipping installers without emojis.
    if (!process.env.CI) return;
    console.log('[emoji-catalog] fetching pinned snapshot for packaging…');
    const { execSync } = require('child_process');
    const tmp = path.join(projectDir, '.emoji-catalog-fetch');
    fs.mkdirSync(tmp, { recursive: true });
    execSync(`gh release download catalog-v1 -R ${process.env.GITHUB_REPOSITORY} -p "emoji-catalog.tar.gz" -O "${path.join(tmp, 'catalog.tar.gz')}" --clobber`, { stdio: 'inherit', cwd: projectDir });
    fs.mkdirSync(path.join(srcCatalog, 'manifest'), { recursive: true });
    execSync(`tar -xzf "${path.join(tmp, 'catalog.tar.gz')}" -C "${srcCatalog}"`, { stdio: 'inherit' });
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(dbSrc)) throw new Error('catalog snapshot did not contain manifest/catalog.db');
  }
  // Take a SQLite-level snapshot so committed rows that still live in the
  // source WAL cannot be omitted by a plain file copy. Convert the snapshot to
  // DELETE journaling: AppImages and normal application resource directories
  // are read-only, while a WAL database tries to create `-shm`/`-wal` files
  // even when opened with readOnly:true.
  const { DatabaseSync, backup } = require('node:sqlite');
  const sourceDb = new DatabaseSync(dbSrc, { readOnly: true });
  try {
    await backup(sourceDb, dbDst);
  } finally {
    sourceDb.close();
  }
  const stagedDb = new DatabaseSync(dbDst);
  try {
    stagedDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const result = stagedDb.prepare('PRAGMA journal_mode=DELETE').get();
    if (String(result?.journal_mode || '').toLowerCase() !== 'delete') {
      throw new Error('could not convert the packaged emoji catalog to read-only-safe journaling');
    }
  } finally {
    stagedDb.close();
  }
  for (const side of ['-wal', '-shm', '-journal']) fs.rmSync(dbDst + side, { force: true });
  const originals = path.join(srcCatalog, 'originals');
  if (fs.existsSync(originals)) fs.cpSync(originals, path.join(stage, 'originals'), { recursive: true });
  const mj = path.join(srcCatalog, 'manifest', 'manifest.json');
  if (fs.existsSync(mj)) fs.copyFileSync(mj, path.join(stage, 'manifest', 'manifest.json'));
}

module.exports.stageEmojiCatalog = stageEmojiCatalog;
