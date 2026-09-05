const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SettingsStore, settingsObject, migrateSettingsCompanions, mergeMissingAccountIdentity, restoreMissingProfileAvatarSidecar, decodeProfileAvatarSidecar } = require('../settings-store');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-settings-'));
  try {
    const file = path.join(directory, 'settings.json');
    fs.writeFileSync(file, '{}');
    const store = new SettingsStore(() => file, { writeDelayMs: 2 });
    assert.strictEqual(await store.get('missing'), undefined);
    assert.deepStrictEqual(settingsObject([]), {});

    const writes = [];
    for (let index = 0; index < 100; index++) {
      writes.push(store.set(`key${index}`, `value${index}`));
      writes.push(store.set('latest', String(index)));
    }
    assert((await Promise.all(writes)).every(Boolean));
    assert.strictEqual(await store.set('key0', undefined), true);
    assert.strictEqual(await store.flush(), true);

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(saved.latest, '99');
    assert.strictEqual(saved.key99, 'value99');
    assert.strictEqual(Object.hasOwn(saved, 'key0'), false);
    const unchangedMtime = fs.statSync(file).mtimeMs;
    assert.strictEqual(await store.set('latest', '99'), true, 'identical settings writes must still resolve');
    assert.strictEqual(await store.flush(), true);
    assert.strictEqual(fs.statSync(file).mtimeMs, unchangedMtime, 'an unchanged setting rewrote the durable file');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);

    const recoveryFile = path.join(directory, 'recovery.json');
    fs.writeFileSync(recoveryFile, '{broken');
    fs.writeFileSync(`${recoveryFile}.bak`, JSON.stringify({ identity: 'kept' }));
    const recovered = new SettingsStore(() => recoveryFile, { writeDelayMs: 0 });
    assert.strictEqual(await recovered.get('identity'), 'kept', 'validated backup was not recovered');
    assert.strictEqual(await recovered.set('next', 'value'), true, 'recovered settings should remain writable');
    assert.strictEqual(JSON.parse(fs.readFileSync(recoveryFile, 'utf8')).identity, 'kept');

    const invalidRootRecoveryFile = path.join(directory, 'invalid-root-recovery.json');
    fs.writeFileSync(invalidRootRecoveryFile, 'null');
    fs.writeFileSync(`${invalidRootRecoveryFile}.bak`, JSON.stringify({ identity: 'backup-kept' }));
    const invalidRootRecovery = new SettingsStore(() => invalidRootRecoveryFile, { writeDelayMs: 0 });
    assert.strictEqual(await invalidRootRecovery.set('next', 'value'), true);
    assert.strictEqual(JSON.parse(fs.readFileSync(`${invalidRootRecoveryFile}.bak`, 'utf8')).identity, 'backup-kept', 'invalid primary replaced the last good backup');

    const corruptFile = path.join(directory, 'unrecoverable.json');
    fs.writeFileSync(corruptFile, '{broken');fs.writeFileSync(`${corruptFile}.bak`, '{also broken');
    const corrupt = new SettingsStore(() => corruptFile, { writeDelayMs: 0 });
    assert.strictEqual(await corrupt.set('mustNotOverwrite', 'secret'), false);
    assert.strictEqual(fs.readFileSync(corruptFile, 'utf8'), '{broken', 'corrupt primary was destructively overwritten');

    const invalidShapeFile = path.join(directory, 'invalid-shape.json');
    fs.writeFileSync(invalidShapeFile, 'null');
    const invalidShape = new SettingsStore(() => invalidShapeFile, { writeDelayMs: 0 });
    assert.strictEqual(await invalidShape.set('mustNotOverwrite', 'secret'), false, 'non-object settings must fail closed');
    assert.strictEqual(fs.readFileSync(invalidShapeFile, 'utf8'), 'null');

    const transientFile = path.join(directory, 'transient.json');
    fs.writeFileSync(transientFile, JSON.stringify({ newest: true }));
    fs.writeFileSync(`${transientFile}.bak`, JSON.stringify({ stale: true }));
    const originalReadFile = fs.promises.readFile;
    fs.promises.readFile = async (...args) => {
      if (String(args[0]) === transientFile) { const error = new Error('injected read failure');error.code = 'EIO';throw error; }
      return originalReadFile(...args);
    };
    try {
      const transient = new SettingsStore(() => transientFile, { writeDelayMs: 0 });
      assert.strictEqual(await transient.set('mustNotOverwrite', 'value'), false, 'transient primary I/O errors must not promote stale backups');
    } finally { fs.promises.readFile = originalReadFile; }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(transientFile, 'utf8')), { newest: true });
    const legacyDir=path.join(directory,'legacy'),stableDir=path.join(directory,'Knot');
    fs.mkdirSync(legacyDir,{recursive:true});
    fs.writeFileSync(path.join(legacyDir,'settings.json'),JSON.stringify({profileAvatar:'keep-me'}));
    fs.writeFileSync(path.join(legacyDir,'settings.key'),Buffer.alloc(32,7));
    fs.writeFileSync(path.join(legacyDir,'profile-avatar'),'data:image/png;base64,aaa');
    fs.mkdirSync(stableDir,{recursive:true});
    fs.writeFileSync(path.join(stableDir,'settings.json'),JSON.stringify({theme:'dark'}));
    const copied=migrateSettingsCompanions(stableDir,[legacyDir]);
    assert(copied.includes('settings.key')&&copied.includes('profile-avatar')&&!copied.includes('settings.json'),'existing Knot settings.json must not be clobbered while the encryption key and photo sidecar still migrate');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(stableDir,'settings.json'),'utf8')).theme,'dark');
    assert.strictEqual(fs.readFileSync(path.join(stableDir,'settings.key')).equals(Buffer.alloc(32,7)),true);
    assert.strictEqual(fs.readFileSync(path.join(stableDir,'profile-avatar'),'utf8'),'data:image/png;base64,aaa');

    const leftoverDir=path.join(directory,'pair-p2p');
    fs.mkdirSync(leftoverDir,{recursive:true});
    fs.writeFileSync(path.join(leftoverDir,'settings.json'),JSON.stringify({directoryUserId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',directoryToken:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',profileAvatar:'data:image/gif;base64,xxx'}));
    fs.writeFileSync(path.join(stableDir,'settings.json'),JSON.stringify({theme:'dark',profileAvatar:'file:v1',directoryAccountName:'mundo',rememberAccount:'no'}));
    const restored=mergeMissingAccountIdentity(stableDir,[leftoverDir]);
    const after=JSON.parse(fs.readFileSync(path.join(stableDir,'settings.json'),'utf8'));
    assert(restored.includes('directoryUserId')&&restored.includes('directoryToken'),'a Knot settings.json without a session must recover the leftover Pair identity');
    assert.strictEqual(after.theme,'dark');
    assert.strictEqual(after.profileAvatar,'file:v1','identity merge must not pull a 4MB photo back into settings.json');
    assert.strictEqual(after.directoryUserId,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(after.directoryToken,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    assert.strictEqual(after.rememberAccount,'yes');

    const mismatchDir=path.join(directory,'mismatch');
    fs.mkdirSync(mismatchDir,{recursive:true});
    fs.writeFileSync(path.join(mismatchDir,'settings.json'),JSON.stringify({directoryUserId:'cccccccccccccccccccccccccccccccc',directoryAccountName:'mundo'}));
    assert.deepStrictEqual(mergeMissingAccountIdentity(mismatchDir,[leftoverDir]),[],'a leftover Pair token must not attach to a different Knot user id');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(mismatchDir,'settings.json'),'utf8')).directoryToken,undefined);

    const png = decodeProfileAvatarSidecar(Buffer.from('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlqAAAAAASUVORK5CYII='));
    assert.strictEqual(png?.mime, 'image/png');
    assert.ok(png.buffer.length > 8 && png.buffer[0] === 0x89);
    assert.strictEqual(decodeProfileAvatarSidecar(Buffer.from('GIF89a\x01\x00\x01\x00'))?.mime, 'image/gif');
    assert.strictEqual(decodeProfileAvatarSidecar(Buffer.from('file:v1')), null, 'the file:v1 pointer must never be treated as image bytes');

    fs.writeFileSync(path.join(stableDir, 'profile-avatar'), 'data:image/png;base64,aaa');
    assert.strictEqual(restoreMissingProfileAvatarSidecar(stableDir, [leftoverDir]), false, 'an existing sidecar must not be replaced from leftover Pair JSON');
    const emptyPhotoDir = path.join(directory, 'KnotEmpty');
    fs.mkdirSync(emptyPhotoDir, { recursive: true });
    fs.writeFileSync(path.join(emptyPhotoDir, 'settings.json'), JSON.stringify({ profileAvatar: 'file:v1' }));
    assert.strictEqual(restoreMissingProfileAvatarSidecar(emptyPhotoDir, [leftoverDir]), true, 'a missing sidecar must come back from leftover Pair settings');
    assert.ok(fs.readFileSync(path.join(emptyPhotoDir, 'profile-avatar'), 'utf8').startsWith('data:image/gif'));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(emptyPhotoDir, 'settings.json'), 'utf8')).profileAvatar, 'file:v1', 'sidecar restore must not inline the photo into settings.json');

    console.log('PASS async atomic settings store concurrency, deletion, and permissions');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error);process.exit(1); });
