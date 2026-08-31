(function installFileTransferProtocol(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotFileTransferProtocol = api;
})(typeof globalThis === 'object' ? globalThis : this, function createFileTransferProtocol() {
  'use strict';

  const DEFAULT_MAX_FILE_SIZE = 200 * 1024 ** 3;
  const DEFAULT_MAX_HEADER_BYTES = 256;
  const DEFAULT_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
  const GCM_IV_BYTES = 12;
  const GCM_TAG_BYTES = 16;

  function bytesView(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error('File frame is not binary data');
  }

  function validSequence(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function optionalBytes(value) {
    if (value == null) return null;
    return bytesView(value);
  }

  function sameBytes(left, right) {
    if (left === null || right === null) return left === right;
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
    return true;
  }

  function parseChunkFrame(value, options = {}) {
    const bytes = bytesView(value);
    const maxFileSize = Number.isSafeInteger(options.maxFileSize) ? options.maxFileSize : DEFAULT_MAX_FILE_SIZE;
    const maxHeaderBytes = Number.isSafeInteger(options.maxHeaderBytes) ? options.maxHeaderBytes : DEFAULT_MAX_HEADER_BYTES;
    const maxChunkBytes = Number.isSafeInteger(options.maxChunkBytes) ? options.maxChunkBytes : DEFAULT_MAX_CHUNK_BYTES;
    const maxFrameBytes = 4 + maxHeaderBytes + GCM_IV_BYTES + GCM_TAG_BYTES + maxChunkBytes;
    if (bytes.byteLength < 4 + 2 + GCM_IV_BYTES + GCM_TAG_BYTES + 1 || bytes.byteLength > maxFrameBytes) {
      throw new Error('File chunk has an invalid size');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = view.getUint32(0);
    if (!headerLength || headerLength > maxHeaderBytes || 4 + headerLength + GCM_IV_BYTES + GCM_TAG_BYTES + 1 > bytes.byteLength) {
      throw new Error('File chunk has an invalid header');
    }

    let header;
    try {
      header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + headerLength)));
    } catch {
      throw new Error('File chunk header is malformed');
    }
    // Do not coerce metadata. JSON values such as `true`, `null`, or `"1"`
    // all have surprising numeric conversions and would make the supposedly
    // strict wire schema accept multiple representations of the same range.
    const sequence = header?.s, offset = header?.o;
    const lastValue = header?.l;
    if (header?.t !== 'c' || typeof sequence !== 'number' || !validSequence(sequence)
      || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > maxFileSize
      || ![0, 1, false, true].includes(lastValue)) {
      throw new Error('File chunk metadata is invalid');
    }

    const cipherOffset = 4 + headerLength + GCM_IV_BYTES;
    const ciphertext = bytes.subarray(cipherOffset);
    const plainBytes = ciphertext.byteLength - GCM_TAG_BYTES;
    if (plainBytes <= 0 || plainBytes > maxChunkBytes) throw new Error('File chunk payload is invalid');
    return Object.freeze({
      sequence,
      offset,
      last: lastValue === 1 || lastValue === true,
      plainBytes,
      iv: bytes.subarray(4 + headerLength, cipherOffset),
      ciphertext
    });
  }

  // Tracks authenticated chunk ranges independently of arrival lane. A TCP
  // write that is retried over WebRTC may arrive late or twice; exact retries
  // are harmless, while overlaps and contradictory final markers fail closed.
  class IncomingRangeTracker {
    constructor(size) {
      if (!Number.isSafeInteger(size) || size < 0 || size > DEFAULT_MAX_FILE_SIZE) throw new Error('Invalid offered file size');
      this.size = size;
      this.committed = 0;
      this.finalSeen = size === 0;
      this.ranges = new Map();
    }

    reserve(frame) {
      const offset = Number(frame?.offset), length = Number(frame?.plainBytes), last = frame?.last === true;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
        throw new Error('File chunk range is invalid');
      }
      const end = offset + length;
      if (!Number.isSafeInteger(end) || end > this.size) throw new Error('File chunk exceeds the offered size');
      if (last !== (end === this.size)) throw new Error('File chunk has a contradictory final marker');
      const iv = optionalBytes(frame?.iv), ciphertext = optionalBytes(frame?.ciphertext);
      if ((iv === null) !== (ciphertext === null)) throw new Error('File chunk retry identity is incomplete');

      if (offset < this.committed) {
        if (end <= this.committed) return false;
        throw new Error('File chunk overlaps bytes already written');
      }
      const existingAtOffset = this.ranges.get(offset);
      if (existingAtOffset) {
        if (existingAtOffset.end !== end) throw new Error('File chunks overlap');
        if (existingAtOffset.last !== last || !sameBytes(existingAtOffset.iv, iv) || !sameBytes(existingAtOffset.ciphertext, ciphertext)) {
          throw new Error('File chunk retry conflicts with the reserved ciphertext');
        }
        return false;
      }
      for (const existing of this.ranges.values()) {
        if (offset < existing.end && end > existing.offset) throw new Error('File chunks overlap');
      }
      this.ranges.set(offset, { offset, end, last, iv, ciphertext, bytes: null });
      if (last) this.finalSeen = true;
      return true;
    }

    resolve(frame, value) {
      const bytes = bytesView(value), offset = Number(frame?.offset);
      const range = this.ranges.get(offset);
      if (!range || range.bytes) throw new Error('File chunk was not reserved exactly once');
      if (bytes.byteLength !== range.end - range.offset) throw new Error('Decrypted file chunk changed size');
      range.bytes = bytes;
    }

    takeContiguous() {
      const output = [];
      for (;;) {
        const range = this.ranges.get(this.committed);
        if (!range?.bytes) break;
        this.ranges.delete(range.offset);
        this.committed = range.end;
        output.push({ offset: range.offset, end: range.end, last: range.last, bytes: range.bytes });
      }
      return output;
    }

    get complete() {
      return this.committed === this.size && this.finalSeen && this.ranges.size === 0;
    }
  }

  return Object.freeze({
    DEFAULT_MAX_FILE_SIZE,
    DEFAULT_MAX_HEADER_BYTES,
    DEFAULT_MAX_CHUNK_BYTES,
    GCM_IV_BYTES,
    GCM_TAG_BYTES,
    IncomingRangeTracker,
    parseChunkFrame,
    validSequence
  });
});
