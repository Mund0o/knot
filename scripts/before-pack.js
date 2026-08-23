const fs = require('fs');
const path = require('path');
const { verifyWindowsAudioAddon } = require('./windows-audio-addon-guard');

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') {
    // Still stage on non-win dev builds so `npm run dist` stays consistent.
    stageEmojiCatalog(context.packager.projectDir);
    return;
  }
  verifyWindowsAudioAddon(context.packager.projectDir);
  stageEmojiCatalog(context.packager.projectDir);
};

// Copy the collected emoji catalog (db + assets + manifest) into a staging
// directory referenced by build.extraResources, so packaged apps ship the
// catalog without pulling crawler logs or WAL sidecars into installers.
function stageEmojiCatalog(projectDir) {
  const srcCatalog = path.join(projectDir, 'emoji-catalog');
  const stage = path.join(projectDir, 'dist-emoji-catalog');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'manifest'), { recursive: true });
  const dbSrc = path.join(srcCatalog, 'manifest', 'catalog.db');
  const dbDst = path.join(stage, 'manifest', 'catalog.db');
  if (!fs.existsSync(dbSrc)) return; // no catalog yet: packaged app degrades gracefully
  fs.copyFileSync(dbSrc, dbDst);
  try { // fold any write-ahead log into the staged copy
    const { DatabaseSync } = require('node:sqlite');
    const sdb = new DatabaseSync(dbDst);
    sdb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    sdb.close();
    for (const side of ['-wal', '-shm']) fs.rmSync(dbDst + side, { force: true });
  } catch {}
  const originals = path.join(srcCatalog, 'originals');
  if (fs.existsSync(originals)) fs.cpSync(originals, path.join(stage, 'originals'), { recursive: true });
  const mj = path.join(srcCatalog, 'manifest', 'manifest.json');
  if (fs.existsSync(mj)) fs.copyFileSync(mj, path.join(stage, 'manifest', 'manifest.json'));
}
