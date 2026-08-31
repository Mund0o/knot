const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SaveStreamManager, safeSuggestedFileName } = require('../save-streams');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function partFiles(directory) {
  return fs.readdirSync(directory).filter(name => name.includes('.knot-part-'));
}

function caseDirectory(root, name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function suggestedFilenameSafety() {
  assert.strictEqual(safeSuggestedFileName('../../outside.bin'), 'outside.bin');
  assert.strictEqual(safeSuggestedFileName('CON.txt'), '_CON.txt');
  assert.strictEqual(safeSuggestedFileName('nul'), '_nul');
  assert.strictEqual(safeSuggestedFileName('bad<>:"/\\|?*\u202efile. '), '_____file');
  assert.strictEqual(safeSuggestedFileName('..'), 'incoming');
  const unicode = safeSuggestedFileName(`${'😀'.repeat(255)}.txt`);
  assert(Buffer.byteLength(unicode) <= 240, 'suggested Unicode filename exceeds the component byte budget');
  assert(unicode.endsWith('.txt'), 'bounded suggested filename discarded a short extension');
  assert(!unicode.includes('\ufffd'), 'suggested filename truncation split a Unicode code point');
}

async function basicAtomicAndCancel(root) {
  const directory = caseDirectory(root, 'basic');
  const manager = new SaveStreamManager();
  const first = path.join(directory, 'first.bin');
  const second = path.join(directory, 'second.bin');
  await Promise.all([
    manager.open(1, first, { expectedSize: 10 }),
    manager.open(2, second, { expectedSize: 11 }),
  ]);
  await Promise.all([
    manager.write(1, Buffer.from('first-data')),
    manager.write(2, new Uint8Array(Buffer.from('second-data'))),
  ]);
  await Promise.all([manager.finish(2), manager.finish(1)]);
  assert.strictEqual(fs.readFileSync(first, 'utf8'), 'first-data');
  assert.strictEqual(fs.readFileSync(second, 'utf8'), 'second-data');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(first).mode & 0o077, 0, 'incoming file was created with group/world permissions');
  }

  const existing = path.join(directory, 'existing.bin');
  fs.writeFileSync(existing, 'keep-me');
  await manager.open(3, existing, { expectedSize: 11 });
  await manager.write(3, Buffer.from('replacement'));
  await manager.cancel(3);
  assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'keep-me', 'cancel overwrote an existing destination');
  assert.deepStrictEqual(partFiles(directory), [], 'cancel left a partial download');
  assert.strictEqual(manager.size, 0);
}

async function validationAndDeclaredSize(root) {
  const directory = caseDirectory(root, 'validation');
  const manager = new SaveStreamManager({ maxActive: 2, maxChunk: 4 });
  await assert.rejects(manager.open(0, path.join(directory, 'bad')), /invalid/);
  await assert.rejects(manager.open(1, `${path.join(directory, 'bad')}\0tail`), /invalid/);
  await assert.rejects(manager.open(1, path.join(directory, 'bad-size'), { expectedSize: -1 }), /invalid/);

  const valid = path.join(directory, 'valid.bin');
  await manager.open(10, valid, { expectedSize: 4 });
  await assert.rejects(manager.open(10, path.join(directory, 'duplicate-id')), /invalid/);
  await assert.rejects(manager.write(10, 'text is not a binary IPC chunk'), /invalid save chunk/);
  await assert.rejects(manager.write(10, Buffer.alloc(0)), /invalid save chunk/);
  await assert.rejects(manager.write(10, Buffer.alloc(5)), /invalid save chunk/);

  await manager.open(11, path.join(directory, 'second.bin'), { expectedSize: 1 });
  await assert.rejects(manager.open(12, path.join(directory, 'over-limit.bin')), /too many/);
  await manager.cancel(11);
  await manager.write(10, Buffer.from('good'));
  await manager.finish(10);
  assert.strictEqual(fs.readFileSync(valid, 'utf8'), 'good');

  const tooLarge = path.join(directory, 'declared-overrun.bin');
  await manager.open(13, tooLarge, { expectedSize: 3 });
  await assert.rejects(manager.write(13, Buffer.from('four')), error => error?.code === 'EFBIG');
  await assert.rejects(manager.finish(13), /exceeds its declared size/);
  assert(!fs.existsSync(tooLarge));

  const short = path.join(directory, 'declared-short.bin');
  await manager.open(14, short, { expectedSize: 5 });
  await manager.write(14, Buffer.from('four'));
  await assert.rejects(manager.finish(14), error => error?.code === 'EBADMSG');
  assert(!fs.existsSync(short));
  assert.deepStrictEqual(partFiles(directory), [], 'size validation left a partial file');
}

async function destinationReservationAndPathSafety(root) {
  const directory = caseDirectory(root, 'paths');
  const manager = new SaveStreamManager();
  const target = path.join(directory, 'same.bin');
  await manager.open(20, target, { expectedSize: 1 });
  await assert.rejects(manager.open(21, target, { expectedSize: 1 }), /destination is already active/);

  if (process.platform !== 'win32') {
    const alias = path.join(root, 'paths-alias');
    fs.symlinkSync(directory, alias, 'dir');
    await assert.rejects(manager.open(22, path.join(alias, 'same.bin'), { expectedSize: 1 }), /destination is already active/);
  }
  await manager.write(20, Buffer.from('x'));
  await manager.finish(20);

  await assert.rejects(manager.open(23, directory), /not a regular file/);

  if (process.platform !== 'win32') {
    const source = path.join(directory, 'link-source.bin');
    const link = path.join(directory, 'link-target.bin');
    fs.writeFileSync(source, 'source-stays');
    fs.symlinkSync(source, link);
    await manager.open(24, link, { expectedSize: 3 });
    await manager.write(24, Buffer.from('new'));
    await manager.finish(24);
    assert.strictEqual(fs.readFileSync(source, 'utf8'), 'source-stays', 'atomic replacement followed and modified a destination symlink');
    assert.strictEqual(fs.readFileSync(link, 'utf8'), 'new');
    assert(fs.lstatSync(link).isFile(), 'destination symlink was not replaced by the downloaded file');
  }

  // A valid near-NAME_MAX Unicode destination must not make the hidden
  // temporary prefix exceed the filesystem component limit.
  const unicodeTarget = path.join(directory, `${'😀'.repeat(58)}.bin`);
  await manager.open(25, unicodeTarget, { expectedSize: 1 });
  await manager.write(25, Buffer.from('u'));
  await manager.finish(25);
  assert.strictEqual(fs.readFileSync(unicodeTarget, 'utf8'), 'u');
}

async function partialWritesAndDiskFailure(root) {
  const directory = caseDirectory(root, 'disk');
  const manager = new SaveStreamManager();
  const partial = path.join(directory, 'partial-write.bin');
  const value = Buffer.from('abcdefghijk');
  await manager.open(30, partial, { expectedSize: value.length });
  const partialState = manager.streams.get(30);
  const originalWrite = partialState.handle.write.bind(partialState.handle);
  let writeCalls = 0;
  partialState.handle.write = (buffer, offset, length, position) => {
    writeCalls++;
    return originalWrite(buffer, offset, Math.min(2, length), position);
  };
  await manager.write(30, value);
  await manager.finish(30);
  assert(writeCalls > 1, 'test did not exercise a partial FileHandle.write');
  assert(fs.readFileSync(partial).equals(value), 'partial writes created a hole or duplicate bytes');

  const diskFull = path.join(directory, 'disk-full.bin');
  await manager.open(31, diskFull, { expectedSize: 4 });
  const fullState = manager.streams.get(31);
  fullState.handle.write = async () => {
    const error = new Error('disk full');
    error.code = 'ENOSPC';
    throw error;
  };
  await assert.rejects(manager.write(31, Buffer.from('data')), error => error?.code === 'ENOSPC');
  await assert.rejects(manager.finish(31), error => error?.code === 'ENOSPC');
  assert(!fs.existsSync(diskFull));
  assert.deepStrictEqual(partFiles(directory), [], 'disk-full failure retained a corrupt partial file');
}

async function writeFinishAndCancelRaces(root) {
  const directory = caseDirectory(root, 'races');
  const manager = new SaveStreamManager();
  const finishingTarget = path.join(directory, 'finish-race.bin');
  await manager.open(40, finishingTarget, { expectedSize: 4 });
  const finishState = manager.streams.get(40);
  const finishWrite = finishState.handle.write.bind(finishState.handle);
  let releaseWrite;
  let enteredWrite;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const writeEntered = new Promise(resolve => { enteredWrite = resolve; });
  finishState.handle.write = async (...args) => {
    enteredWrite();
    await writeGate;
    return finishWrite(...args);
  };
  const writing = manager.write(40, Buffer.from('data'));
  await writeEntered;
  await assert.rejects(manager.write(40, Buffer.from('evil')), /concurrent save writes/);
  let finishSettled = false;
  const finishing = manager.finish(40).finally(() => { finishSettled = true; });
  await delay(20);
  assert.strictEqual(finishSettled, false, 'finish raced past an in-flight disk write');
  releaseWrite();
  await Promise.all([writing, finishing]);
  assert.strictEqual(fs.readFileSync(finishingTarget, 'utf8'), 'data');

  const cancelTarget = path.join(directory, 'cancel-race.bin');
  await manager.open(41, cancelTarget, { expectedSize: 4 });
  const cancelState = manager.streams.get(41);
  const cancelWrite = cancelState.handle.write.bind(cancelState.handle);
  let releaseCancelWrite;
  let enteredCancelWrite;
  const cancelGate = new Promise(resolve => { releaseCancelWrite = resolve; });
  const cancelEntered = new Promise(resolve => { enteredCancelWrite = resolve; });
  cancelState.handle.write = async (...args) => {
    enteredCancelWrite();
    await cancelGate;
    return cancelWrite(...args);
  };
  const pendingWrite = manager.write(41, Buffer.from('data'));
  await cancelEntered;
  let cancelSettled = false;
  const cancelling = manager.cancel(41).finally(() => { cancelSettled = true; });
  await delay(20);
  assert.strictEqual(cancelSettled, false, 'cancel closed a descriptor underneath an in-flight write');
  assert.strictEqual(manager.has(41), true, 'cancel allowed the transfer ID to be reused before cleanup finished');
  releaseCancelWrite();
  await Promise.all([pendingWrite, cancelling]);
  assert(!fs.existsSync(cancelTarget));
  assert.deepStrictEqual(partFiles(directory), [], 'cancel/write race left a partial file');
}

async function changedDestinationAndRecovery(root) {
  const directory = caseDirectory(root, 'recovery');
  const manager = new SaveStreamManager({ renameRetryDelays: [1, 1] });
  const changed = path.join(directory, 'changed.bin');
  fs.writeFileSync(changed, 'old');
  await manager.open(50, changed, { expectedSize: 8 });
  await manager.write(50, Buffer.from('download'));
  fs.writeFileSync(changed, 'someone-else');
  let changedError;
  try { await manager.finish(50); } catch (error) { changedError = error; }
  assert.strictEqual(changedError?.code, 'KNOT_SAVE_RECOVERY');
  assert.strictEqual(fs.readFileSync(changed, 'utf8'), 'someone-else', 'download overwrote a destination changed after the Save dialog');
  assert.strictEqual(fs.readFileSync(changedError.recoveryPath, 'utf8'), 'download');
  fs.unlinkSync(changedError.recoveryPath);

  const renameTarget = path.join(directory, 'rename-failure.bin');
  await manager.open(51, renameTarget, { expectedSize: 8 });
  await manager.write(51, Buffer.from('complete'));
  const originalRename = fs.promises.rename;
  let renameAttempts = 0;
  fs.promises.rename = async (from, to) => {
    if (to === renameTarget) {
      renameAttempts++;
      const error = new Error('destination locked');
      error.code = 'EPERM';
      throw error;
    }
    return originalRename.call(fs.promises, from, to);
  };
  let renameError;
  try { await manager.finish(51); } catch (error) { renameError = error; }
  finally { fs.promises.rename = originalRename; }
  assert.strictEqual(renameError?.code, 'KNOT_SAVE_RECOVERY');
  assert.strictEqual(renameError?.cause?.code, 'EPERM');
  assert.strictEqual(renameAttempts, 3, 'temporary Windows-style destination lock was not retried with a bound');
  assert.strictEqual(fs.readFileSync(renameError.recoveryPath, 'utf8'), 'complete');
  fs.unlinkSync(renameError.recoveryPath);

  const transientTarget = path.join(directory, 'transient-lock.bin');
  await manager.open(52, transientTarget, { expectedSize: 2 });
  await manager.write(52, Buffer.from('ok'));
  let transientAttempts = 0;
  fs.promises.rename = async (from, to) => {
    if (to === transientTarget && transientAttempts++ === 0) {
      const error = new Error('scanner has the destination open');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRename.call(fs.promises, from, to);
  };
  try { await manager.finish(52); }
  finally { fs.promises.rename = originalRename; }
  assert.strictEqual(transientAttempts, 2, 'transient rename did not retry exactly once');
  assert.strictEqual(fs.readFileSync(transientTarget, 'utf8'), 'ok');
}

async function durabilityAndShutdownBarrier(root) {
  const directory = caseDirectory(root, 'durability');
  const manager = new SaveStreamManager();
  const target = path.join(directory, 'durable.bin');
  await manager.open(60, target, { expectedSize: 7 });
  await manager.write(60, Buffer.from('durable'));
  const state = manager.streams.get(60);
  const originalSync = state.handle.sync.bind(state.handle);
  const order = [];
  state.handle.sync = async () => { order.push('file-sync'); return originalSync(); };

  const originalRename = fs.promises.rename;
  let releaseRename;
  let renameEntered;
  const renameGate = new Promise(resolve => { releaseRename = resolve; });
  const entered = new Promise(resolve => { renameEntered = resolve; });
  fs.promises.rename = async (from, to) => {
    if (to === target) {
      order.push('rename');
      renameEntered();
      await renameGate;
    }
    return originalRename.call(fs.promises, from, to);
  };
  try {
    const finishing = manager.finish(60);
    await entered;
    let shutdownSettled = false;
    const shutdown = manager.closeAll().then(() => { shutdownSettled = true; });
    await delay(20);
    assert.strictEqual(shutdownSettled, false, 'shutdown ignored a save whose atomic rename was pending');
    assert.strictEqual(manager.has(60), true, 'finishing transfer vanished before its rename settled');
    await assert.rejects(manager.open(61, path.join(directory, 'during-close.bin')), /manager is closing/);
    releaseRename();
    await Promise.all([finishing, shutdown]);
  } finally {
    fs.promises.rename = originalRename;
    releaseRename?.();
  }
  assert.deepStrictEqual(order.slice(0, 2), ['file-sync', 'rename'], 'destination was renamed before file data was synced');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'durable');

  // A renderer crash cleanup is a barrier, not a permanent manager shutdown.
  const after = path.join(directory, 'after-close.bin');
  await manager.open(62, after, { expectedSize: 1 });
  await manager.write(62, Buffer.from('x'));
  await manager.finish(62);
}

async function cleanupErrorsAndOpenCancellation(root) {
  const directory = caseDirectory(root, 'cleanup');
  const manager = new SaveStreamManager();
  const target = path.join(directory, 'unlink-error.bin');
  await manager.open(70, target, { expectedSize: 1 });
  const temporaryPath = manager.streams.get(70).temporaryPath;
  const originalUnlink = fs.promises.unlink;
  fs.promises.unlink = async value => {
    if (value === temporaryPath) {
      const error = new Error('unlink denied');
      error.code = 'EACCES';
      throw error;
    }
    return originalUnlink.call(fs.promises, value);
  };
  try {
    await assert.rejects(manager.cancel(70), error => error?.code === 'EACCES');
  } finally {
    fs.promises.unlink = originalUnlink;
  }
  assert.strictEqual(manager.has(70), false, 'failed partial cleanup permanently consumed a transfer slot');
  assert(fs.existsSync(temporaryPath), 'test did not retain the partial after unlink failed');
  fs.unlinkSync(temporaryPath);

  const openingTarget = path.join(directory, 'cancel-opening.bin');
  const originalRealpath = fs.promises.realpath;
  let releaseRealpath;
  let realpathEntered;
  const realpathGate = new Promise(resolve => { releaseRealpath = resolve; });
  const entered = new Promise(resolve => { realpathEntered = resolve; });
  fs.promises.realpath = async value => {
    if (path.resolve(value) === path.resolve(directory)) {
      realpathEntered();
      await realpathGate;
    }
    return originalRealpath.call(fs.promises, value);
  };
  try {
    const opening = manager.open(71, openingTarget, { expectedSize: 1 });
    await entered;
    const cancelling = manager.cancel(71);
    releaseRealpath();
    await assert.rejects(opening, /save cancelled/);
    assert.strictEqual(await cancelling, true);
  } finally {
    fs.promises.realpath = originalRealpath;
    releaseRealpath?.();
  }
  assert.strictEqual(manager.size, 0);
  assert.deepStrictEqual(partFiles(directory), [], 'cancel during open left a partial file');
}

(async () => {
  suggestedFilenameSafety();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-saves-'));
  try {
    await basicAtomicAndCancel(root);
    await validationAndDeclaredSize(root);
    await destinationReservationAndPathSafety(root);
    await partialWritesAndDiskFailure(root);
    await writeFinishAndCancelRaces(root);
    await changedDestinationAndRecovery(root);
    await durabilityAndShutdownBarrier(root);
    await cleanupErrorsAndOpenCancellation(root);
    console.log('PASS save streams: atomic, durable, bounded, race-safe, and cleanup-verified');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
