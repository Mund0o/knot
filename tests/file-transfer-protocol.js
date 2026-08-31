const assert = require('assert');
const { IncomingRangeTracker, parseChunkFrame, validSequence } = require('../file-transfer-protocol');

function packedChunk(sequence, offset, bodyLength, last = false) {
  return packedHeader({ t: 'c', s: sequence, o: offset, l: last ? 1 : 0 }, bodyLength);
}

function packedHeader(value, bodyLength = 1) {
  const header = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(4 + header.length + 12 + bodyLength + 16);
  frame.writeUInt32BE(header.length, 0);header.copy(frame, 4);
  frame.fill(7, 4 + header.length, 4 + header.length + 12);
  frame.fill(9, 4 + header.length + 12);
  return frame;
}

assert(validSequence(1) && validSequence(Number.MAX_SAFE_INTEGER) && !validSequence(0) && !validSequence(1.5));
const parsed = parseChunkFrame(packedChunk(7, 4, 4, false));
assert.deepStrictEqual({ sequence: parsed.sequence, offset: parsed.offset, plainBytes: parsed.plainBytes, last: parsed.last }, { sequence: 7, offset: 4, plainBytes: 4, last: false });
assert.throws(() => parseChunkFrame(Buffer.alloc(12)), /invalid size/);
assert.throws(() => parseChunkFrame(packedChunk(7, 0, 4, false), { maxChunkBytes: 3 }), /invalid size|payload/);
for (const invalid of [
  { t: 'c', s: '7', o: 0, l: 0 },
  { t: 'c', s: true, o: 0, l: 0 },
  { t: 'c', s: 7, o: '0', l: 0 },
  { t: 'c', s: 7, o: null, l: 0 },
]) assert.throws(() => parseChunkFrame(packedHeader(invalid)), /metadata/, 'coerced JSON metadata crossed the strict frame schema');

const retryWire = packedChunk(9, 0, 4, true);
const retryTracker = new IncomingRangeTracker(4);
assert.strictEqual(retryTracker.reserve(parseChunkFrame(retryWire)), true);
assert.strictEqual(retryTracker.reserve(parseChunkFrame(Buffer.from(retryWire))), false, 'an identical encrypted retry was rejected');
const conflictingRetryWire = Buffer.from(retryWire);conflictingRetryWire[conflictingRetryWire.length - 1] ^= 1;
assert.throws(
  () => retryTracker.reserve(parseChunkFrame(conflictingRetryWire)),
  /conflicts/,
  'the same range with different authenticated ciphertext was silently deduplicated'
);

// Simulate a TCP-to-WebRTC fallback where chunks cross in flight. Resolution
// order is deliberately different again to exercise the concurrent decrypt pool.
const tracker = new IncomingRangeTracker(12);
const middle = { offset: 4, plainBytes: 4, last: false };
const first = { offset: 0, plainBytes: 4, last: false };
const final = { offset: 8, plainBytes: 4, last: true };
assert.strictEqual(tracker.reserve(middle), true);
assert.strictEqual(tracker.reserve(first), true);
assert.strictEqual(tracker.reserve(final), true);
assert.strictEqual(tracker.reserve({ ...middle }), false, 'an uncertain cross-lane retry was not deduplicated');
tracker.resolve(final, Buffer.from('CCCC'));
assert.deepStrictEqual(tracker.takeContiguous(), []);
tracker.resolve(middle, Buffer.from('BBBB'));
assert.deepStrictEqual(tracker.takeContiguous(), []);
tracker.resolve(first, Buffer.from('AAAA'));
const ordered = tracker.takeContiguous();
assert.strictEqual(Buffer.concat(ordered.map(item => Buffer.from(item.bytes))).toString(), 'AAAABBBBCCCC');
assert.strictEqual(tracker.complete, true);
assert.strictEqual(tracker.reserve({ ...first }), false, 'a late retry of committed bytes was not ignored');

const gap = new IncomingRangeTracker(12);
gap.reserve(first);gap.reserve(final);gap.resolve(first, Buffer.alloc(4));gap.resolve(final, Buffer.alloc(4));gap.takeContiguous();
assert.strictEqual(gap.complete, false, 'a missing middle chunk completed the file');
assert.throws(() => gap.reserve({ offset: 2, plainBytes: 4, last: false }), /overlap/);
assert.throws(() => new IncomingRangeTracker(8).reserve({ offset: 4, plainBytes: 4, last: false }), /final marker/);
assert.throws(() => new IncomingRangeTracker(8).reserve({ offset: 0, plainBytes: 9, last: true }), /offered size/);

const empty = new IncomingRangeTracker(0);
assert.strictEqual(empty.complete, true, 'an accepted zero-byte file did not complete');

// Deterministic property coverage for cross-lane fallback. Each iteration
// creates a different legal partition, reserves and decrypts it in unrelated
// shuffled orders, injects exact TCP/WebRTC retries, and proves that only the
// declared byte order can reach the writer.
function randomSource(seed = 0x6b6e6f74) {
  let state = seed >>> 0;
  return limit => {
    state ^= state << 13;state ^= state >>> 17;state ^= state << 5;state >>>= 0;
    return limit > 0 ? state % limit : 0;
  };
}
function shuffle(values, random) {
  const output = values.slice();
  for (let index = output.length - 1; index > 0; index--) {
    const other = random(index + 1);
    [output[index], output[other]] = [output[other], output[index]];
  }
  return output;
}

const random = randomSource();
for (let iteration = 0; iteration < 250; iteration++) {
  const size = 1 + random(64 * 1024), source = Buffer.allocUnsafe(size);
  for (let index = 0; index < source.length; index++) source[index] = random(256);
  const chunks = [];
  for (let offset = 0; offset < size;) {
    const length = Math.min(size - offset, 1 + random(Math.min(4096, size - offset)));
    chunks.push({ offset, plainBytes: length, last: offset + length === size });
    offset += length;
  }

  const propertyTracker = new IncomingRangeTracker(size);
  for (const frame of shuffle(chunks, random)) {
    assert.strictEqual(propertyTracker.reserve(frame), true);
    assert.strictEqual(propertyTracker.reserve({ ...frame }), false, 'an exact in-flight retry was not idempotent');
  }
  const written = [];
  for (const frame of shuffle(chunks, random)) {
    propertyTracker.resolve(frame, source.subarray(frame.offset, frame.offset + frame.plainBytes));
    for (const item of propertyTracker.takeContiguous()) written.push(Buffer.from(item.bytes));
  }
  assert(propertyTracker.complete, `randomized tracker ${iteration} did not complete`);
  assert(Buffer.concat(written).equals(source), `randomized tracker ${iteration} reordered or changed bytes`);
  for (const frame of shuffle(chunks, random)) {
    assert.strictEqual(propertyTracker.reserve({ ...frame }), false, 'an exact late retry was not idempotent');
  }

  if (chunks.length > 1) {
    const missing = random(chunks.length), gapTracker = new IncomingRangeTracker(size);
    for (let index = 0; index < chunks.length; index++) if (index !== missing) {
      const frame = chunks[index];gapTracker.reserve(frame);
      gapTracker.resolve(frame, source.subarray(frame.offset, frame.offset + frame.plainBytes));
    }
    gapTracker.takeContiguous();
    assert.strictEqual(gapTracker.complete, false, 'a randomized missing range completed the file');

    const anchor = chunks[random(chunks.length - 1)];
    const overlapOffset = anchor.offset + anchor.plainBytes - 1;
    const overlapLength = 2;
    const overlapTracker = new IncomingRangeTracker(size);
    overlapTracker.reserve(anchor);
    assert.throws(
      () => overlapTracker.reserve({ offset: overlapOffset, plainBytes: overlapLength, last: overlapOffset + overlapLength === size }),
      /overlap/,
      'a randomized partial overlap was accepted'
    );
  }

  const chosen = chunks[random(chunks.length)];
  assert.throws(
    () => new IncomingRangeTracker(size).reserve({ ...chosen, last: !chosen.last }),
    /final marker/,
    'a randomized contradictory final marker was accepted'
  );
}

// Parser fuzz is deterministic and assertion-based: arbitrary bytes may be
// rejected, but any accepted result must satisfy every public invariant and
// retain views inside the supplied frame.
for (let iteration = 0; iteration < 5000; iteration++) {
  const bytes = Buffer.allocUnsafe(random(640));
  for (let index = 0; index < bytes.length; index++) bytes[index] = random(256);
  try {
    const value = parseChunkFrame(bytes, { maxFileSize: 1024 * 1024, maxHeaderBytes: 256, maxChunkBytes: 256 });
    assert(validSequence(value.sequence));
    assert(Number.isSafeInteger(value.offset) && value.offset >= 0 && value.offset <= 1024 * 1024);
    assert(Number.isSafeInteger(value.plainBytes) && value.plainBytes > 0 && value.plainBytes <= 256);
    assert.strictEqual(value.iv.byteLength, 12);
    assert.strictEqual(value.ciphertext.byteLength, value.plainBytes + 16);
    assert.strictEqual(value.iv.buffer, bytes.buffer);
    assert.strictEqual(value.ciphertext.buffer, bytes.buffer);
  } catch (error) {
    assert(error instanceof Error, 'malformed frame threw a non-Error value');
  }
}
console.log('PASS file chunks are parsed strictly and reassembled by authenticated byte offset');
