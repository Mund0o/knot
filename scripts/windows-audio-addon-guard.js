const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CAPTURE_ABI = 'knot-screen-audio-v4';
const SOURCE_RELATIVE = path.join('addon', 'pair-capture.cc');
const BINARY_RELATIVE = path.join('addon', 'build', 'Release', 'pair-capture.node');
const MANIFEST_RELATIVE = path.join('addon', 'build', 'Release', 'pair-capture.manifest.json');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceSha256(value) {
  return sha256(Buffer.from(value).toString('utf8').replace(/\r\n/g, '\n'));
}

function readElectronVersion(root) {
  const packageFile = path.join(root, 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(packageFile)) throw new Error('Electron is not installed; run npm ci before verifying the Windows audio addon');
  return String(JSON.parse(fs.readFileSync(packageFile, 'utf8')).version || '');
}

function inspectPeX64(binary) {
  if (binary.length < 0x40 || binary.toString('ascii', 0, 2) !== 'MZ') return false;
  const peOffset = binary.readUInt32LE(0x3c);
  return peOffset + 6 <= binary.length
    && binary.toString('binary', peOffset, peOffset + 4) === 'PE\u0000\u0000'
    && binary.readUInt16LE(peOffset + 4) === 0x8664;
}

function addonDetails(root = path.resolve(__dirname, '..')) {
  const sourcePath = path.join(root, SOURCE_RELATIVE);
  const binaryPath = path.join(root, BINARY_RELATIVE);
  const manifestPath = path.join(root, MANIFEST_RELATIVE);
  if (!fs.existsSync(sourcePath)) throw new Error(`Windows audio source is missing: ${SOURCE_RELATIVE}`);
  if (!fs.existsSync(binaryPath)) throw new Error(`Windows audio addon is missing: ${BINARY_RELATIVE}`);
  if (!fs.existsSync(manifestPath)) throw new Error(`Windows audio build manifest is missing: ${MANIFEST_RELATIVE}; run npm run rebuild:addon on Windows`);
  const source = fs.readFileSync(sourcePath);
  const binary = fs.readFileSync(binaryPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return {
    source,
    binary,
    manifest,
    sourcePath,
    binaryPath,
    manifestPath,
    electronVersion: readElectronVersion(root)
  };
}

function verifyWindowsAudioAddon(root = path.resolve(__dirname, '..')) {
  const details = addonDetails(root);
  const errors = [];
  const sourceHash = sourceSha256(details.source);
  const binaryHash = sha256(details.binary);
  if (!details.source.includes(Buffer.from(CAPTURE_ABI))) errors.push(`source does not declare capture ABI ${CAPTURE_ABI}`);
  if (!details.binary.includes(Buffer.from(CAPTURE_ABI))) errors.push(`compiled addon does not contain capture ABI ${CAPTURE_ABI}`);
  if (!inspectPeX64(details.binary)) errors.push('compiled addon is not a Windows x64 PE module');
  if (details.manifest.captureAbi !== CAPTURE_ABI) errors.push(`manifest captureAbi is ${details.manifest.captureAbi || 'missing'}, expected ${CAPTURE_ABI}`);
  if (details.manifest.arch !== 'x64') errors.push(`manifest arch is ${details.manifest.arch || 'missing'}, expected x64`);
  if (details.manifest.electronVersion !== details.electronVersion) errors.push(`addon targets Electron ${details.manifest.electronVersion || 'unknown'}, installed Electron is ${details.electronVersion}`);
  if (details.manifest.sourceSha256 !== sourceHash) errors.push('addon is stale: pair-capture.cc changed after the recorded Windows build');
  if (details.manifest.binarySha256 !== binaryHash) errors.push('addon binary hash does not match its Windows build manifest');
  if (errors.length) throw new Error(`Windows audio addon verification failed:\n- ${errors.join('\n- ')}\nRebuild it on Windows with npm run rebuild:addon.`);
  return { captureAbi: CAPTURE_ABI, arch: 'x64', electronVersion: details.electronVersion, sourceSha256: sourceHash, binarySha256: binaryHash };
}

function writeWindowsAudioManifest(root = path.resolve(__dirname, '..')) {
  const sourcePath = path.join(root, SOURCE_RELATIVE);
  const binaryPath = path.join(root, BINARY_RELATIVE);
  const manifestPath = path.join(root, MANIFEST_RELATIVE);
  if (!fs.existsSync(sourcePath) || !fs.existsSync(binaryPath)) throw new Error('Cannot record Windows audio build: source or compiled addon is missing');
  const source = fs.readFileSync(sourcePath), binary = fs.readFileSync(binaryPath);
  if (!source.includes(Buffer.from(CAPTURE_ABI)) || !binary.includes(Buffer.from(CAPTURE_ABI))) throw new Error(`Compiled addon does not implement ${CAPTURE_ABI}`);
  if (!inspectPeX64(binary)) throw new Error('Compiled addon is not a Windows x64 PE module');
  const manifest = {
    captureAbi: CAPTURE_ABI,
    arch: 'x64',
    electronVersion: readElectronVersion(root),
    sourceSha256: sourceSha256(source),
    binarySha256: sha256(binary)
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  try {
    const verified = verifyWindowsAudioAddon();
    console.log(`Verified Windows audio addon ${verified.captureAbi} for Electron ${verified.electronVersion} (${verified.arch}).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  CAPTURE_ABI,
  SOURCE_RELATIVE,
  BINARY_RELATIVE,
  MANIFEST_RELATIVE,
  sha256,
  sourceSha256,
  inspectPeX64,
  verifyWindowsAudioAddon,
  writeWindowsAudioManifest
};
