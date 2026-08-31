const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SettingsStore, settingsObject } = require('../settings-store');

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
    console.log('PASS async atomic settings store concurrency, deletion, and permissions');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error);process.exit(1); });
