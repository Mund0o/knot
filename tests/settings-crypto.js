const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { FORMAT, WRAPPED_KEY_FORMAT, LocalSettingsCipher } = require('../settings-crypto');

function vault(machineKey) {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',machineKey,iv),body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]); },
    decryptString(value) { const data=Buffer.from(value),decipher=crypto.createDecipheriv('aes-256-gcm',machineKey,data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8'); }
  };
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-settings-crypto-'));
  try {
    const keyPath = path.join(directory, 'settings.key');
    const machineKey = crypto.randomBytes(32), first = new LocalSettingsCipher(() => keyPath, { vault: vault(machineKey) });
    const secret = 'token-and-private-message-data';
    const envelope = await first.protect(secret);
    assert.strictEqual(envelope.format, FORMAT);
    assert(!JSON.stringify(envelope).includes(secret), 'sensitive setting remained plaintext');
    assert.strictEqual(await first.reveal(envelope), secret, 'sensitive setting did not decrypt');
    assert.strictEqual(fs.statSync(keyPath).mode & 0o777, 0o600, 'settings key permissions are not private');

    const keyDocument=JSON.parse(fs.readFileSync(keyPath,'utf8'));
    assert.strictEqual(keyDocument.format,WRAPPED_KEY_FORMAT,'master key was not OS-vault wrapped');
    const afterRestart = new LocalSettingsCipher(() => keyPath, { vault: vault(machineKey) });
    assert.strictEqual(await afterRestart.reveal(envelope), secret, 'settings key did not survive an app restart');
    const tampered = { ...envelope, data: Buffer.from('tampered').toString('base64') };
    await assert.rejects(afterRestart.reveal(tampered), /auth|authenticate|unsupported|invalid/i);

    const copied = new LocalSettingsCipher(() => keyPath, { vault: vault(crypto.randomBytes(32)) });
    await assert.rejects(copied.reveal(envelope), /auth|authenticate|decrypt|invalid/i, 'copied app files decrypted without the OS vault');
    await assert.rejects(new LocalSettingsCipher(() => keyPath).reveal(envelope), /credential encryption is unavailable/i, 'wrapped keys must fail closed without the OS vault');

    const legacyPath=path.join(directory,'legacy.key'),legacyKey=crypto.randomBytes(32);
    fs.writeFileSync(legacyPath,legacyKey,{mode:0o600});
    const migrated=new LocalSettingsCipher(()=>legacyPath,{vault:vault(machineKey)});
    await migrated.protect('migration');
    assert.strictEqual(JSON.parse(fs.readFileSync(legacyPath,'utf8')).format,WRAPPED_KEY_FORMAT,'raw key did not migrate');

    const fallbackPath=path.join(directory,'fallback.key'),fallback=new LocalSettingsCipher(()=>fallbackPath);
    const fallbackEnvelope=await fallback.protect('bounded fallback');
    assert.strictEqual(fs.readFileSync(fallbackPath).length,32,'vault-unavailable fallback changed format');
    assert.strictEqual(await new LocalSettingsCipher(()=>fallbackPath).reveal(fallbackEnvelope),'bounded fallback');

    const basicTextPath=path.join(directory,'basic-text.key'),basicTextVault={...vault(machineKey),getSelectedStorageBackend:()=> 'basic_text'};
    await new LocalSettingsCipher(()=>basicTextPath,{vault:basicTextVault}).protect('not fake vault protected');
    assert.strictEqual(fs.readFileSync(basicTextPath).length,32,'Linux basic_text was incorrectly treated as a secure OS vault');

    if(process.platform!=='win32'){
      const insecurePath=path.join(directory,'insecure.key');fs.writeFileSync(insecurePath,crypto.randomBytes(32),{mode:0o644});
      const originalChmod=fs.promises.chmod;fs.promises.chmod=async(...args)=>{if(args[0]===insecurePath)throw new Error('injected chmod failure');return originalChmod(...args)};
      try{await assert.rejects(new LocalSettingsCipher(()=>insecurePath).protect('must fail'),/injected chmod failure/,'raw key permission failures must not be ignored')}
      finally{fs.promises.chmod=originalChmod}
    }
    console.log('PASS sensitive settings use persistent authenticated local encryption');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
