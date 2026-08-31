const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_CHUNK = 8 * 1024 * 1024;
const MAX_TARGET_PATH = 32 * 1024;

function validChunk(value, maxChunk) {
  let byteLength = 0;
  try {
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) byteLength = value.byteLength;
    else if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)) byteLength = value.byteLength;
    else return null;
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > maxChunk) return null;

  // Always own the bytes for the lifetime of the asynchronous disk write.
  // In particular, Buffer.from(ArrayBuffer) aliases its source, so route every
  // accepted shape through a Uint8Array view and then copy that view.
  try {
    const view = Buffer.isBuffer(value)
      ? value
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
    return Buffer.from(view);
  } catch {
    return null;
  }
}

function truncateUtf8(value, maxBytes) {
  let result = '';
  let bytes = 0;
  for (const character of String(value || '')) {
    const length = Buffer.byteLength(character);
    if (bytes + length > maxBytes) break;
    result += character;
    bytes += length;
  }
  return result;
}

const WINDOWS_RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function safeSuggestedFileName(value, maxBytes = 240) {
  const limit = Math.max(32, Math.min(240, Math.floor(Number(maxBytes) || 240)));
  let name = path.basename(String(value || 'incoming'))
    .normalize('NFC')
    .replace(/[\0-\x1f\x7f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') name = 'incoming';
  if (WINDOWS_RESERVED_FILENAME.test(name)) name = `_${name}`;

  if (Buffer.byteLength(name) > limit) {
    const extension = path.extname(name);
    const extensionBytes = Buffer.byteLength(extension);
    if (extension && extensionBytes <= 32 && extensionBytes < limit - 8) {
      name = `${truncateUtf8(name.slice(0, -extension.length), limit - extensionBytes)}${extension}`;
    } else {
      name = truncateUtf8(name, limit);
    }
  }
  name = name.replace(/[. ]+$/g, '');
  return name || 'incoming';
}

function statKind(stat) {
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  return 'special';
}

function statValue(value) {
  return value == null ? '' : String(value);
}

async function destinationFingerprint(filesystem, targetPath) {
  let stat;
  try {
    stat = await filesystem.promises.lstat(targetPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const kind = statKind(stat);
  let link = '';
  if (kind === 'symlink') link = await filesystem.promises.readlink(targetPath);
  return {
    kind,
    dev: statValue(stat.dev),
    ino: statValue(stat.ino),
    mode: statValue(stat.mode),
    size: statValue(stat.size),
    mtime: statValue(stat.mtimeNs ?? stat.mtimeMs),
    ctime: statValue(stat.ctimeNs ?? stat.ctimeMs),
    birthtime: statValue(stat.birthtimeNs ?? stat.birthtimeMs),
    link,
  };
}

function sameFingerprint(left, right) {
  if (left === null || right === null) return left === right;
  return Object.keys(left).every(key => left[key] === right[key]);
}

function recoveryError(message, state, cause) {
  const error = new Error(`${message}; recovery file: ${state.temporaryPath}`, { cause });
  error.code = 'KNOT_SAVE_RECOVERY';
  error.recoveryPath = state.temporaryPath;
  return error;
}

function aggregateError(primary, secondary, message = primary?.message || 'save operation failed') {
  if (!secondary) return primary;
  return new AggregateError([primary, secondary], message, { cause: primary });
}

class SaveStreamManager {
  constructor({
    maxActive = 16,
    highWater = 64 * 1024 * 1024,
    maxChunk = DEFAULT_MAX_CHUNK,
    filesystem = fs,
    onWarning = null,
    renameRetryDelays = [20, 50, 100, 200, 400],
  } = {}) {
    this.maxActive = Math.max(1, Math.min(64, Math.floor(Number(maxActive) || 16)));
    // Retained as a public compatibility value. Writes now go straight through
    // one FileHandle operation at a time, which provides a stricter bound than
    // buffering up to this previous stream watermark.
    this.highWater = Math.max(1024 * 1024, Math.min(512 * 1024 * 1024, Math.floor(Number(highWater) || 64 * 1024 * 1024)));
    this.maxChunk = Math.max(1, Math.min(64 * 1024 * 1024, Math.floor(Number(maxChunk) || DEFAULT_MAX_CHUNK)));
    this.fs = filesystem;
    this.onWarning = typeof onWarning === 'function' ? onWarning : () => {};
    this.renameRetryDelays = Array.isArray(renameRetryDelays)
      ? renameRetryDelays.slice(0, 8).map(value => Math.max(0, Math.min(1000, Math.floor(Number(value) || 0))))
      : [];
    this.streams = new Map();
    this.targets = new Map();
    this.closing = false;
    this.closePromise = null;
  }

  validId(value) { return Number.isSafeInteger(value) && value > 0 ? value : 0; }
  has(idValue) { return this.streams.has(this.validId(idValue)); }
  get size() { return this.streams.size; }

  _warn(error, context) {
    try { this.onWarning(error, context); } catch {}
  }

  _targetKey(targetPath) {
    let key = path.normalize(targetPath).normalize('NFC');
    // The default Windows and macOS filesystems are case-insensitive. It is
    // safer to reject two simultaneous spellings on a case-sensitive macOS
    // volume than to allow an accidental last-finisher-wins overwrite on the
    // overwhelmingly common case-insensitive volume.
    if (process.platform === 'win32' || process.platform === 'darwin') key = key.toLocaleLowerCase('en-US');
    return key;
  }

  _release(state) {
    if (state.targetKey && this.targets.get(state.targetKey) === state) this.targets.delete(state.targetKey);
    if (this.streams.get(state.id) === state) this.streams.delete(state.id);
  }

  async _syncDirectory(directory, context) {
    if (!directory || process.platform === 'win32') return;
    let handle = null;
    try {
      handle = await this.fs.promises.open(directory, 'r');
      await handle.sync();
    } catch (error) {
      // The file itself is synced before rename. Some filesystems do not allow
      // syncing a directory handle; warn rather than reporting a false save
      // failure after the atomic rename has already succeeded.
      this._warn(error, context);
    } finally {
      if (handle) try { await handle.close(); } catch (error) { this._warn(error, `${context}:close`); }
    }
  }

  async _syncCommit(targetPath) {
    if (process.platform !== 'win32') return this._syncDirectory(path.dirname(targetPath), 'commit-save');
    let handle = null;
    try {
      // libuv's Windows rename uses replace semantics, but not
      // MOVEFILE_WRITE_THROUGH. Reopening and flushing the committed file is
      // the closest portable durability barrier Node exposes on that platform.
      handle = await this.fs.promises.open(targetPath, 'r');
      await handle.sync();
    } catch (error) {
      this._warn(error, 'commit-save');
    } finally {
      if (handle) try { await handle.close(); } catch (error) { this._warn(error, 'commit-save:close'); }
    }
  }

  async _renameTemporary(state) {
    let attempt = 0;
    for (;;) {
      const currentDestination = await destinationFingerprint(this.fs, state.targetPath);
      if (!sameFingerprint(state.destinationSnapshot, currentDestination)) {
        throw recoveryError('Destination changed while the file was downloading', state);
      }
      try {
        await this.fs.promises.rename(state.temporaryPath, state.targetPath);
        return;
      } catch (error) {
        const retryable = ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code);
        if (!retryable || attempt >= this.renameRetryDelays.length) {
          throw recoveryError('Completed download could not replace its destination', state, error);
        }
        const delay = this.renameRetryDelays[attempt++];
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async _closeHandle(state) {
    const handle = state.handle;
    if (!handle) return;
    state.handle = null;
    await handle.close();
  }

  async _unlinkTemporary(state) {
    if (!state.temporaryPath) return;
    const temporaryPath = state.temporaryPath;
    try {
      await this.fs.promises.unlink(temporaryPath);
      state.temporaryPath = null;
      await this._syncDirectory(path.dirname(temporaryPath), 'discard-partial-save');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        state.temporaryPath = null;
        return;
      }
      throw error;
    }
  }

  async _discard(state) {
    if (state.cleanupPromise) return state.cleanupPromise;
    state.cleanupPromise = (async () => {
      let cleanupError = null;
      try { await this._closeHandle(state); } catch (error) { cleanupError = error; }
      try { await this._unlinkTemporary(state); } catch (error) { cleanupError = cleanupError ? new AggregateError([cleanupError, error], 'could not discard partial save') : error; }
      this._release(state);
      if (cleanupError) throw cleanupError;
    })();
    return state.cleanupPromise;
  }

  async _preserve(state) {
    let closeError = null;
    try { await this._closeHandle(state); } catch (error) { closeError = error; }
    if (state.temporaryPath) await this._syncDirectory(path.dirname(state.temporaryPath), 'preserve-recovery-save');
    this._release(state);
    if (closeError) throw closeError;
  }

  async _openTemporary(state) {
    const suffixBytes = 48;
    const base = truncateUtf8(path.basename(state.targetPath), Math.max(16, 200 - suffixBytes)) || 'incoming';
    for (let attempt = 0; attempt < 5; attempt++) {
      const temporaryPath = path.join(
        path.dirname(state.targetPath),
        `.${base}.knot-part-${state.id}-${crypto.randomBytes(12).toString('hex')}`,
      );
      try {
        const handle = await this.fs.promises.open(temporaryPath, 'wx', 0o600);
        state.temporaryPath = temporaryPath;
        state.handle = handle;
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST' || attempt === 4) throw error;
      }
    }
  }

  async _openState(state) {
    const requested = path.resolve(state.requestedTargetPath);
    const filename = path.basename(requested);
    if (!filename || filename === '.' || filename === '..') throw new Error('invalid save destination');
    const parent = await this.fs.promises.realpath(path.dirname(requested));
    if (state.cancelRequested) throw new Error('save cancelled');
    const parentStat = await this.fs.promises.stat(parent);
    if (!parentStat.isDirectory()) throw new Error('save destination parent is not a directory');

    state.targetPath = path.join(parent, filename);
    state.targetKey = this._targetKey(state.targetPath);
    if (this.targets.has(state.targetKey)) throw new Error('save destination is already active');
    this.targets.set(state.targetKey, state);

    state.destinationSnapshot = await destinationFingerprint(this.fs, state.targetPath);
    if (state.destinationSnapshot && !['file', 'symlink'].includes(state.destinationSnapshot.kind)) {
      throw new Error('save destination is not a regular file');
    }
    if (state.cancelRequested) throw new Error('save cancelled');
    await this._openTemporary(state);
    if (state.cancelRequested) throw new Error('save cancelled');
    state.phase = 'open';
  }

  async open(idValue, targetPath, options = {}) {
    const id = this.validId(idValue);
    const expectedValue = typeof options === 'number' ? options : options?.expectedSize;
    const expectedSize = expectedValue == null ? null : Number(expectedValue);
    if (
      !id ||
      typeof targetPath !== 'string' ||
      !targetPath ||
      targetPath.includes('\0') ||
      targetPath.length > MAX_TARGET_PATH ||
      (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) ||
      this.streams.has(id)
    ) throw new Error('invalid save transfer');
    if (this.closing) throw new Error('save manager is closing');
    if (this.streams.size >= this.maxActive) throw new Error('too many active saves');

    // Reserve the ID synchronously before path resolution or file opening can
    // yield, so concurrent IPC calls cannot reuse the same transfer ID or race
    // past maxActive.
    const state = {
      id,
      requestedTargetPath: targetPath,
      targetPath: null,
      targetKey: null,
      temporaryPath: null,
      destinationSnapshot: null,
      handle: null,
      position: 0,
      expectedSize,
      phase: 'opening',
      failed: null,
      cancelRequested: false,
      completeWrites: false,
      openPromise: null,
      writePromise: null,
      finishPromise: null,
      cancelPromise: null,
      cleanupPromise: null,
    };
    this.streams.set(id, state);
    state.openPromise = this._openState(state);
    try {
      await state.openPromise;
      if (this.streams.get(id) !== state || state.cancelRequested) throw new Error('save cancelled');
      return { id, path: state.targetPath };
    } catch (error) {
      let cleanupError = null;
      try { await this._discard(state); } catch (cleanupFailure) { cleanupError = cleanupFailure; }
      throw aggregateError(error, cleanupError);
    }
  }

  async write(idValue, value) {
    const state = this.streams.get(this.validId(idValue));
    if (!state) throw new Error('no open stream');
    if (state.phase !== 'open' || state.cancelRequested) throw new Error('save stream is not writable');
    if (state.failed) throw state.failed;
    if (state.writePromise) throw new Error('concurrent save writes are not allowed');
    const data = validChunk(value, this.maxChunk);
    if (!data) throw new Error('invalid save chunk');
    if (state.expectedSize !== null && state.position + data.byteLength > state.expectedSize) {
      const error = new Error('save data exceeds its declared size');
      error.code = 'EFBIG';
      state.failed = error;
      throw error;
    }
    const handle = state.handle;
    if (!handle) throw new Error('save stream is closed');

    const operation = (async () => {
      let offset = 0;
      try {
        while (offset < data.byteLength) {
          const result = await handle.write(data, offset, data.byteLength - offset, state.position);
          const bytesWritten = Number(result?.bytesWritten);
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > data.byteLength - offset) {
            const error = new Error('disk write made no forward progress');
            error.code = 'EIO';
            throw error;
          }
          offset += bytesWritten;
          state.position += bytesWritten;
        }
        return true;
      } catch (error) {
        state.failed = error;
        throw error;
      }
    })();
    state.writePromise = operation;
    try {
      return await operation;
    } finally {
      if (state.writePromise === operation) state.writePromise = null;
    }
  }

  async finish(idValue) {
    const id = this.validId(idValue);
    const state = this.streams.get(id);
    if (!state) return false;
    if (state.finishPromise) return state.finishPromise;
    if (state.cancelPromise || state.cancelRequested) {
      try { await state.cancelPromise; } catch {}
      return false;
    }

    state.phase = 'finishing';
    const operation = (async () => {
      let primaryError = null;
      try {
        await state.openPromise;
        const pendingWrite = state.writePromise;
        if (pendingWrite) await pendingWrite;
        if (state.failed) throw state.failed;
        if (!state.handle) throw new Error('save stream closed before finishing');
        if (state.expectedSize !== null && state.position !== state.expectedSize) {
          const error = new Error(`save size mismatch: expected ${state.expectedSize} bytes, received ${state.position}`);
          error.code = 'EBADMSG';
          throw error;
        }
        state.completeWrites = true;

        // A successful close only proves bytes reached the kernel. Sync the
        // completed temporary inode before its atomic name handoff so a sudden
        // power loss cannot leave a zero-length or stale destination behind.
        await state.handle.sync();
        await this._closeHandle(state);

        await this._renameTemporary(state);
        state.temporaryPath = null;
        await this._syncCommit(state.targetPath);
        state.phase = 'done';
        return true;
      } catch (error) {
        primaryError = error;
        if (state.completeWrites && state.temporaryPath) {
          const surfaced = error?.code === 'KNOT_SAVE_RECOVERY'
            ? error
            : recoveryError('Completed download could not be committed safely', state, error);
          let preserveError = null;
          try { await this._preserve(state); } catch (failure) { preserveError = failure; }
          throw aggregateError(surfaced, preserveError, surfaced.message);
        }
        let cleanupError = null;
        try { await this._discard(state); } catch (failure) { cleanupError = failure; }
        throw aggregateError(error, cleanupError);
      } finally {
        // _preserve/_discard normally release first. This also covers the
        // successful rename and any unexpected exception in cleanup itself.
        this._release(state);
        if (primaryError) state.failed = state.failed || primaryError;
      }
    })();
    state.finishPromise = operation;
    return operation;
  }

  async cancel(idValue) {
    const id = this.validId(idValue);
    const state = this.streams.get(id);
    if (!state) return false;
    if (state.finishPromise) {
      try { await state.finishPromise; } catch {}
      return false;
    }
    if (state.cancelPromise) return state.cancelPromise;

    state.cancelRequested = true;
    state.phase = 'cancelling';
    const operation = (async () => {
      try { await state.openPromise; } catch {}
      const pendingWrite = state.writePromise;
      if (pendingWrite) try { await pendingWrite; } catch {}
      await this._discard(state);
      return true;
    })();
    state.cancelPromise = operation;
    return operation;
  }

  async closeAll() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const operation = (async () => {
      const states = [...this.streams.values()];
      const operations = states.map(state => state.finishPromise || state.cancelPromise || this.cancel(state.id));
      await Promise.allSettled(operations);
    })();
    this.closePromise = operation.finally(() => {
      this.closing = false;
      this.closePromise = null;
    });
    return this.closePromise;
  }
}

module.exports = { SaveStreamManager, safeSuggestedFileName };
