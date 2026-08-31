'use strict';

// Transactional release-feed publisher. It never changes public/ until every
// artifact has been copied, hashed, and the manifest has been signed.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UPDATE_PUBLIC_KEY, canonicalManifestPayload } = require('./update-signing');

const fsp = fs.promises;

function validatedRepository(value) {
  const repository = String(value || '').trim().replace(/\/$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('PAIR_GITHUB_REPO must be an owner/repository name');
  }
  return repository;
}

async function readSigningKey(filename, expectedPublicKey = UPDATE_PUBLIC_KEY) {
  if (!filename) throw new Error('KNOT_UPDATE_SIGNING_KEY must name the offline Ed25519 private-key PEM file');
  const resolved = path.resolve(filename);
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error('KNOT_UPDATE_SIGNING_KEY is not a regular file');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('KNOT_UPDATE_SIGNING_KEY must not be readable by other users');
  const privateKey = crypto.createPrivateKey(await fsp.readFile(resolved));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('KNOT_UPDATE_SIGNING_KEY is not an Ed25519 private key');
  const actual = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const expectedKey = expectedPublicKey?.type === 'public' ? expectedPublicKey : crypto.createPublicKey(expectedPublicKey);
  const expected = expectedKey.export({ type: 'spki', format: 'der' });
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('KNOT_UPDATE_SIGNING_KEY does not match the public key pinned in this Knot build');
  }
  return privateKey;
}

async function assertRegularFile(filename, label) {
  let stat;
  try { stat = await fsp.stat(filename); } catch { throw new Error(`Missing release artifact: ${label}`); }
  if (!stat.isFile()) throw new Error(`Release artifact is not a regular file: ${label}`);
}

function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filename);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function syncFile(filename) {
  const handle = await fsp.open(filename, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await fsp.open(directory, 'r');await handle.sync(); } catch {} finally { await handle?.close().catch(() => {}); }
}

async function stageFile(source, target) {
  await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(target, 0o644).catch(() => {});
  await syncFile(target);
}

async function publishRelease({
  root = __dirname,
  repository = process.env.PAIR_GITHUB_REPO || 'Mund0o/knot',
  signingKeyPath = process.env.KNOT_UPDATE_SIGNING_KEY,
  expectedPublicKey = UPDATE_PUBLIC_KEY,
  notes = process.env.PAIR_NOTES || 'Update available.',
} = {}) {
  root = path.resolve(root);
  repository = validatedRepository(repository);
  const sourceDirectory = path.join(root, 'dist');
  const outputDirectory = path.join(root, 'public');
  const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  const version = typeof pkg.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(pkg.version) ? pkg.version : null;
  if (!version) throw new Error('package.json has an invalid release version');
  const productName = String(pkg.build?.productName || pkg.name || '').trim();
  const packageName = String(pkg.name || '').trim();
  if (!productName || !packageName || /[\\/\0]/.test(productName + packageName)) throw new Error('package.json has an invalid product name');

  const privateKey = await readSigningKey(signingKeyPath, expectedPublicKey);
  const linuxTar = `${packageName}-${version}.tar.gz`;
  const linuxAppImage = `${productName}-${version}.AppImage`;
  const windowsExe = `${productName} Setup ${version}.exe`;
  const windowsBlockmap = `${windowsExe}.blockmap`;
  const required = [linuxTar, linuxAppImage, windowsExe];
  for (const name of required) await assertRegularFile(path.join(sourceDirectory, name), name);
  const blockmapSource = path.join(sourceDirectory, windowsBlockmap);
  const hasBlockmap = await fsp.stat(blockmapSource).then(stat => stat.isFile()).catch(() => false);

  const releaseBase = `https://github.com/${repository}/releases/download/v${version}`;
  const releaseUrl = name => `${releaseBase}/${encodeURIComponent(name.replace(/ /g, '.'))}`;
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const stage = path.join(root, `.publish-stage-${nonce}`);
  const backup = path.join(root, `.publish-backup-${nonce}`);
  let outputMoved = false;
  let stagePublished = false;

  try {
    await fsp.mkdir(stage, { mode: 0o755 });
    for (const name of required) await stageFile(path.join(sourceDirectory, name), path.join(stage, name));
    if (hasBlockmap) await stageFile(blockmapSource, path.join(stage, windowsBlockmap));

    // Hash the exact staged bytes that will become public, not a mutable source
    // file that could change between hashing and publication.
    const [linuxSha256, linuxAppImageSha256, winSha256] = await Promise.all([
      sha256File(path.join(stage, linuxTar)),
      sha256File(path.join(stage, linuxAppImage)),
      sha256File(path.join(stage, windowsExe)),
    ]);
    const manifest = {
      version,
      notes: String(notes).slice(0, 16 * 1024),
      linuxUrl: releaseUrl(linuxTar),
      linuxSha256,
      linuxAppImageUrl: releaseUrl(linuxAppImage),
      linuxAppImageSha256,
      winUrl: releaseUrl(windowsExe),
      winSha256,
    };
    const payload = canonicalManifestPayload(manifest);
    manifest.signature = crypto.sign(null, payload, privateKey).toString('base64');
    if (!crypto.verify(null, payload, crypto.createPublicKey(privateKey), Buffer.from(manifest.signature, 'base64'))) {
      throw new Error('release manifest signature self-check failed');
    }
    const manifestFile = path.join(stage, 'latest.json');
    await fsp.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    await syncFile(manifestFile);
    await syncDirectory(stage);

    const outputExists = await fsp.stat(outputDirectory).then(stat => stat.isDirectory()).catch(() => false);
    if (outputExists) { await fsp.rename(outputDirectory, backup);outputMoved = true; }
    try {
      await fsp.rename(stage, outputDirectory);
      stagePublished = true;
      await syncDirectory(root);
    } catch (error) {
      if (outputMoved) await fsp.rename(backup, outputDirectory).catch(() => {});
      outputMoved = false;
      throw error;
    }
    if (outputMoved) await fsp.rm(backup, { recursive: true, force: true });
    await syncDirectory(root);
    return { manifest, names: { linuxTar, linuxAppImage, windowsExe, windowsBlockmap: hasBlockmap ? windowsBlockmap : null }, releaseBase };
  } catch (error) {
    if (!stagePublished) await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (outputMoved) {
      const outputExists = await fsp.stat(outputDirectory).then(() => true).catch(() => false);
      if (!outputExists) await fsp.rename(backup, outputDirectory).catch(() => {});
    }
    throw error;
  }
}

function printResult({ manifest, names, releaseBase }) {
  console.log('Published update feed:');
  console.log('  version:', manifest.version);
  console.log('  windows:', manifest.winUrl);
  console.log('  win sha:', manifest.winSha256);
  console.log('  linux  :', manifest.linuxUrl);
  console.log('  sha256 :', manifest.linuxSha256);
  console.log('  AppImage:', manifest.linuxAppImageUrl);
  console.log('  AppImage sha256:', manifest.linuxAppImageSha256);
  console.log('  notes  :', manifest.notes);
  console.log('\nInstallers are hosted as GitHub release assets:');
  console.log('  ' + releaseBase);
  console.log(`Publish them with: gh release create v${manifest.version} "public/${names.windowsExe}" "public/${names.linuxTar}" "public/${names.linuxAppImage}" --title "Knot ${manifest.version}"`);
}

if (require.main === module) {
  publishRelease().then(printResult).catch(error => { console.error('Could not publish update:', error.message);process.exitCode = 1; });
}

module.exports = { canonicalManifestPayload, publishRelease, validatedRepository };
