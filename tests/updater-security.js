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
  // Unstable connection: the server drops the body three times. Each retry
  // must ask for the remaining bytes and the finished file must hash exactly.
  const https = require('https'), { EventEmitter } = require('events'), { PassThrough } = require('stream');
  const payload = crypto.randomBytes(300 * 1024), payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  const realGet = https.get, ranges = [];
  let drops = 0;
  https.get = (url, options, onResponse) => {
    const req = new EventEmitter();req.setTimeout = () => req;req.destroy = error => { if (error) req.emit('error', error); };
    setImmediate(() => {
      if (url.startsWith('https://github.com/')) {
        const redirect = Object.assign(new PassThrough(), { statusCode: 302, headers: { location: 'https://objects.githubusercontent.com/release/asset' } });
        onResponse(redirect);redirect.end();return;
      }
      const range = String(options.headers.Range || '').match(/^bytes=(\d+)-$/), start = range ? Number(range[1]) : 0;ranges.push(start);
      const response = Object.assign(new PassThrough(), range ? { statusCode: 206, headers: { 'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`, 'content-length': String(payload.length - start) } } : { statusCode: 200, headers: { 'content-length': String(payload.length) } });
      onResponse(response);
      const slice = payload.subarray(start);
      if (drops < 3) { drops++;response.write(slice.subarray(0, 64 * 1024));setImmediate(() => { response.emit('aborted');response.destroy(); }); }
      else response.end(slice);
    });
    return req;
  };
  const downloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-update-resume-'));
  try {
    const target = path.join(downloadRoot, 'download.part'), retries = [];
    await updater._test.download('https://github.com/Mund0o/knot/releases/download/v99.0.0/Knot.exe', target, payloadHash, null, { onRetry: attempt => retries.push(attempt), retryDelays: [1, 1, 1, 1] });
    assert.deepStrictEqual(retries, [1, 2, 3], 'each dropped connection must be retried');
    assert.deepStrictEqual(ranges, [0, 64 * 1024, 128 * 1024, 192 * 1024], 'a retry must resume from the bytes already on disk');
    assert(fs.readFileSync(target).equals(payload), 'the resumed file must be byte-identical');
    drops = 0;ranges.length = 0;fs.rmSync(target);
    await assert.rejects(updater._test.download('https://github.com/Mund0o/knot/releases/download/v99.0.0/Knot.exe', target, payloadHash, null, { retryDelays: [1] }), /interrupted/, 'retries must be bounded');
    assert(fs.existsSync(target) && fs.statSync(target).size === 128 * 1024, 'an exhausted download keeps its bytes for the next try');
    drops = 3;
    await assert.rejects(updater._test.download('https://github.com/Mund0o/knot/releases/download/v99.0.0/Knot.exe', target, 'b'.repeat(64), null, { retryDelays: [1] }), /checksum mismatch/);
    assert(!fs.existsSync(target), 'a file that fails its signed hash must be deleted');
  } finally { https.get = realGet;fs.rmSync(downloadRoot, { recursive: true, force: true }); }

  // The API feed times out; the raw mirror answers with the signed manifest.
  const feedHits = [], signed = manifest();
  https.get = (url, options, onResponse) => {
    const req = new EventEmitter();req.setTimeout = () => req;req.destroy = error => { if (error) req.emit('error', error); };
    feedHits.push(new URL(url).hostname);
    setImmediate(() => {
      if (url.startsWith('https://api.github.com/')) return req.emit('error', new Error('update request timed out'));
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });onResponse(response);response.end(JSON.stringify(signed));
    });
    return req;
  };
  try {
    const fetched = await updater._test.fetchVerifiedManifest('https://api.github.com/repos/Mund0o/knot/contents/public/latest.json?ref=master', { retryDelays: [1, 1] });
    assert.strictEqual(fetched.version, '99.0.0');
    assert.deepStrictEqual(feedHits, ['api.github.com', 'raw.githubusercontent.com'], 'a timed-out API check must fall back to the mirror');
    const unsigned = { ...signed, winSha256: 'c'.repeat(64) };
    https.get = (url, options, onResponse) => { const req = new EventEmitter();req.setTimeout = () => req;req.destroy = () => {};setImmediate(() => { const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });onResponse(response);response.end(JSON.stringify(url.startsWith('https://api.github.com/') ? { encoding: 'base64', content: Buffer.from(JSON.stringify(unsigned)).toString('base64') } : unsigned)); });return req; };
    await assert.rejects(updater._test.fetchVerifiedManifest('https://api.github.com/repos/Mund0o/knot/contents/public/latest.json?ref=master', { retryDelays: [1] }), /signature/, 'the mirror must not bypass the signature check');
  } finally { https.get = realGet; }

  assert.deepStrictEqual(updater._test.feedCandidates('https://api.github.com/repos/Mund0o/knot/contents/public/latest.json?ref=master'), ['https://api.github.com/repos/Mund0o/knot/contents/public/latest.json?ref=master', 'https://raw.githubusercontent.com/Mund0o/knot/master/public/latest.json']);
  console.log('PASS updater signed-manifest authenticity, rollback rejection, staging retry, and resumable download');
})().catch(error => { console.error(error);process.exitCode = 1; });
