// Publishes the current build as the live update feed.
//
// Usage:  node publish-update.js
//
// Reads the version from package.json, copies that version's installers from
// ./dist8 (named by electron-builder as "<Product> Setup <version>.exe" and
// "pair-p2p-<version>.tar.gz") into ./public, and writes ./public/latest.json.
//
// The auto-updater fetches ./public/latest.json from GitHub (raw repo URL,
// configured in updater.js), so updates work with no personal server. The
// signaling server (server.js) is only used for you and your friend to connect.
//
// Notes appear in the update banner. Pass them via the PAIR_NOTES env var, e.g.:
//   PAIR_NOTES="Faster transfers and bug fixes" node publish-update.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'public');

// GitHub repo that hosts the installers as release assets, e.g. "Mund0o/pair".
// The auto-updater can then fetch them from:
//   https://github.com/<repo>/releases/download/v<version>/<file>
// Set via PAIR_GITHUB_REPO if you fork/relocate the project.
const GITHUB_REPO = (process.env.PAIR_GITHUB_REPO || 'Mund0o/pair').trim().replace(/\/$/, '');

if (!fs.existsSync(SRC)) {
  console.error('No dist/ folder found. Build first (npm run dist).');
  process.exit(1);
}

// Version + product name come from package.json so filenames always match the
// build electron-builder actually produced.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const safeVersion = version.replace(/[^0-9.]/g, '');
// Public release-asset base URL (no auth needed for public releases).
const releaseBase = `https://github.com/${GITHUB_REPO}/releases/download/v${version}`;

const linuxTar = `pair-p2p-${safeVersion}.tar.gz`;
// GitHub release assets normalize spaces to dots in the download URL.
const ghName = f => f.replace(/ /g, '.');

fs.mkdirSync(OUT, { recursive: true });

function copyIf(name) {
  const from = path.join(SRC, name);
  if (!fs.existsSync(from)) return null;
  try { fs.copyFileSync(from, path.join(OUT, name)); }
  catch (e) { console.error('Failed to copy', name, '-', e.message); process.exit(1); }
  return name;
}

// Clear out any previous version's artifacts so public/ only ever holds the
// current release (clients only download what latest.json points to anyway).
for (const f of fs.readdirSync(OUT)) {
  if (f === 'latest.json') continue;
  try { fs.unlinkSync(path.join(OUT, f)); } catch {}
}

const gotTar = copyIf(linuxTar);

if (!gotTar) {
  console.error('Missing Linux build artifact in dist/:');
  console.error('  expected:', linuxTar);
  console.error('  Build with: npm run dist');
  process.exit(1);
}
const linuxSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(SRC, linuxTar))).digest('hex');

const manifest = {
  version,
  notes: process.env.PAIR_NOTES || 'Update available.',
  linuxUrl: `${releaseBase}/${ghName(linuxTar)}`,
  linuxSha256
};

fs.writeFileSync(path.join(OUT, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('Published update feed:');
console.log('  version:', version);
console.log('  linux  :', manifest.linuxUrl);
console.log('  sha256 :', manifest.linuxSha256);
console.log('  notes  :', manifest.notes);
console.log('\nInstallers are hosted as GitHub release assets:');
console.log('  ' + releaseBase);
console.log('Publish it with: gh release create v' + version + ' ' + linuxTar + ' --title "Pair ' + version + '"');
