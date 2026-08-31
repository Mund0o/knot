const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
const pair = crypto.generateKeyPairSync('ed25519');
process.env.KNOT_UPDATE_TEST_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' });
const updater = require('../updater');

function manifest(version = '99.0.0') {
  const hash = 'a'.repeat(64);
  const value = {
    version,
    linuxUrl: `https://github.com/Mund0o/knot/releases/download/v${version}/Knot.tar.gz`, linuxSha256: hash,
    linuxAppImageUrl: `https://github.com/Mund0o/knot/releases/download/v${version}/Knot.AppImage`, linuxAppImageSha256: hash,
    winUrl: `https://github.com/Mund0o/knot/releases/download/v${version}/Knot.exe`, winSha256: hash,
    notes: 'authenticated display text'
  };
  value.signature = crypto.sign(null, updater.canonicalManifestPayload(value), pair.privateKey).toString('base64');
  return value;
}

assert.throws(() => updater.verifyManifest({ ...manifest(), signature: undefined }, '1.0.0'), /signature/);
assert.doesNotThrow(() => updater.verifyManifest(manifest(), '1.0.0'));
const altered = manifest();altered.winSha256 = 'b'.repeat(64);
assert.throws(() => updater.verifyManifest(altered, '1.0.0'), /signature/);
const alteredNotes = manifest();alteredNotes.notes = 'tampered release notes';
assert.throws(() => updater.verifyManifest(alteredNotes, '1.0.0'), /signature/);
const forged = manifest();forged.signature = crypto.sign(null, updater.canonicalManifestPayload(forged), crypto.generateKeyPairSync('ed25519').privateKey).toString('base64');
assert.throws(() => updater.verifyManifest(forged, '1.0.0'), /signature/);
assert.throws(() => updater.verifyManifest(manifest('1.0.0'), '2.0.0'), /not newer/);

(async () => {
  updater._test.reset();
  const originalMkdir = fs.promises.mkdir;
  fs.promises.mkdir = async () => { throw new Error('injected mkdir failure'); };
  await assert.rejects(updater._test.install(manifest()), /injected mkdir failure/);
  assert.strictEqual(updater._test.isInstalling(), false, 'staging failure must allow retry');
  fs.promises.mkdir = originalMkdir;

  const sweepRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-update-sweep-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-update-outside-'));
  try {
    const old = path.join(sweepRoot, 'stage-old'), recent = path.join(sweepRoot, 'stage-recent'), unrelated = path.join(sweepRoot, 'keep-me');
    fs.mkdirSync(old);fs.writeFileSync(path.join(old, 'installer.bin'), 'old');
    fs.mkdirSync(recent);fs.writeFileSync(path.join(recent, 'installer.bin'), 'recent');
    fs.mkdirSync(unrelated);
    fs.symlinkSync(outside, path.join(sweepRoot, 'stage-symlink'), 'dir');
    const now=Date.now(),oldTime=new Date(now-60*60*1000);fs.utimesSync(old,oldTime,oldTime);
    const removed=await updater._test.sweepStaleUpdateStages({root:sweepRoot,now,minAgeMs:15*60*1000});
    assert.deepStrictEqual(removed,[old]);
    assert.strictEqual(fs.existsSync(old),false,'old update stage was not reclaimed');
    assert.strictEqual(fs.existsSync(recent),true,'active-age update stage was deleted too early');
    assert.strictEqual(fs.existsSync(unrelated),true,'non-stage updater data was deleted');
    assert.strictEqual(fs.existsSync(outside),true,'stage symlink escaped the update root');
  } finally { fs.rmSync(sweepRoot,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true}); }
  console.log('PASS updater signed-manifest authenticity, rollback rejection, and staging retry');
})().catch(error => { console.error(error);process.exitCode = 1; });
