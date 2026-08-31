'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalManifestPayload, publishRelease } = require('../publish-update');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-publish-'));
  try {
    const dist = path.join(root, 'dist');
    const publicDirectory = path.join(root, 'public');
    fs.mkdirSync(dist);
    fs.mkdirSync(publicDirectory);
    fs.writeFileSync(path.join(publicDirectory, 'latest.json'), '{"old":true}\n');
    fs.writeFileSync(path.join(publicDirectory, 'old-installer.exe'), 'keep-on-failure');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pair-p2p', version: '2.3.4-beta.1', build: { productName: 'Knot' } }));
    const keys = crypto.generateKeyPairSync('ed25519');
    const keyFile = path.join(root, 'release-key.pem');
    fs.writeFileSync(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

    await assert.rejects(
      publishRelease({ root, signingKeyPath: keyFile }),
      /does not match the public key pinned/,
      'a wrong release key must fail before touching the live feed',
    );
    assert.strictEqual(fs.readFileSync(path.join(publicDirectory, 'old-installer.exe'), 'utf8'), 'keep-on-failure');

    await assert.rejects(
      publishRelease({ root, signingKeyPath: keyFile, expectedPublicKey: keys.publicKey }),
      /Missing release artifact/,
    );
    assert.strictEqual(fs.readFileSync(path.join(publicDirectory, 'old-installer.exe'), 'utf8'), 'keep-on-failure', 'failed preflight changed the live feed');

    const names = [
      'pair-p2p-2.3.4-beta.1.tar.gz',
      'Knot-2.3.4-beta.1.AppImage',
      'Knot Setup 2.3.4-beta.1.exe',
    ];
    names.forEach((name, index) => fs.writeFileSync(path.join(dist, name), `artifact-${index}`));
    const result = await publishRelease({ root, signingKeyPath: keyFile, expectedPublicKey: keys.publicKey, notes: 'transaction test' });
    const manifest = JSON.parse(fs.readFileSync(path.join(publicDirectory, 'latest.json'), 'utf8'));
    assert.strictEqual(manifest.version, '2.3.4-beta.1');
    assert.strictEqual(manifest.notes, 'transaction test');
    assert.strictEqual(fs.existsSync(path.join(publicDirectory, 'old-installer.exe')), false, 'old artifacts were not retired after commit');
    for (const name of names) assert.strictEqual(fs.existsSync(path.join(publicDirectory, name)), true);
    assert.strictEqual(
      crypto.verify(null, canonicalManifestPayload(manifest), keys.publicKey, Buffer.from(manifest.signature, 'base64')),
      true,
      'published manifest signature did not cover staged artifacts and notes',
    );
    const alteredNotes = { ...manifest, notes: 'changed after publication' };
    assert.strictEqual(
      crypto.verify(null, canonicalManifestPayload(alteredNotes), keys.publicKey, Buffer.from(manifest.signature, 'base64')),
      false,
      'published manifest signature did not cover release notes',
    );
    assert.strictEqual(result.manifest.winSha256, crypto.createHash('sha256').update('artifact-2').digest('hex'));
    assert.strictEqual(fs.readdirSync(root).some(name => name.startsWith('.publish-')), false, 'transaction scratch directory leaked');
    console.log('PASS update publishing is staged, signed, and failure-atomic');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error);process.exitCode = 1; });
