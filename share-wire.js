(function installShareWire(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotShareWire = api;
})(typeof window === 'object' ? window : typeof globalThis === 'object' ? globalThis : null, () => {
  // The byte format of a screen share on the wire. A share is one ordered list of records numbered 0, 1, 2, ...
  // (the "seq"). Every lane a viewer is connected over (a UDP stream, a data channel) carries the same records in
  // the same wire form, so a viewer can switch lanes, or receive the same record twice, and still rebuild exactly
  // the list the sharer produced. Nothing here knows about sockets or codecs.
  //
  // Header, 20 bytes, big endian:
  //   0  u8   magic 0x4b
  //   1  u8   type    (VIDEO, HEARTBEAT, END)
  //   2  u8   flags   (KEY: this picture can be decoded on its own)
  //   3  u8   config  which description of the stream (codec, size) this record belongs to, modulo 256
  //   4  u32  length  payload bytes that follow
  //   8  u32  seq
  //  12  f64  pts     presentation time in microseconds, the sharer's clock; only differences matter
  const MAGIC = 0x4b;
  const HEADER = 20;
  const MAX_PAYLOAD = 256 * 1024 * 1024;   // a 4K key picture is a few MiB; this only stops a corrupt length from eating memory
  // A still screen produces no pictures at all. HEARTBEAT is the sharer saying "nothing has changed, I am still here", so a viewer
  // can tell a still screen from a dead link; it carries no payload and is numbered, acknowledged and ordered like any record.
  const TYPE = { VIDEO: 2, HEARTBEAT: 3, END: 5 };
  const FLAG = { KEY: 1 };

  const VALID_TYPES = new Set(Object.values(TYPE));

  function encodeRecord({ type, flags = 0, config = 0, seq, pts = 0, payload = new Uint8Array(0) }) {
    if (!VALID_TYPES.has(type)) throw new Error('unknown record type ' + type);
    if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) throw new Error('bad record seq');
    if (payload.length > MAX_PAYLOAD) throw new Error('record payload too large');
    const out = new Uint8Array(HEADER + payload.length);
    const view = new DataView(out.buffer);
    out[0] = MAGIC; out[1] = type; out[2] = flags & 0xff; out[3] = config & 0xff;
    view.setUint32(4, payload.length); view.setUint32(8, seq); view.setFloat64(12, pts);
    out.set(payload, HEADER);
    return out;
  }

  // Lanes hand over bytes in whatever pieces they like (a data channel message, a UDP stream read). The parser
  // keeps the pieces and copies a record's payload exactly once, when the record is complete, so a 4 MiB key
  // picture that arrives in a hundred pieces is not re-copied a hundred times.
  class RecordParser {
    constructor() { this.chunks = []; this.length = 0; this.head = null; }
    get buffered() { return this.length; }
    push(chunk) {
      if (chunk && chunk.length) { this.chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)); this.length += chunk.length; }
      const records = [];
      for (;;) {
        if (!this.head) {
          if (this.length < HEADER) break;
          const raw = this._take(HEADER), view = new DataView(raw.buffer, raw.byteOffset, HEADER);
          if (raw[0] !== MAGIC) throw new Error('share stream is corrupt (bad magic)');
          if (!VALID_TYPES.has(raw[1])) throw new Error('share stream is corrupt (unknown record type)');
          const size = view.getUint32(4);
          if (size > MAX_PAYLOAD) throw new Error('share stream is corrupt (record too large)');
          this.head = { type: raw[1], flags: raw[2], config: raw[3], size, seq: view.getUint32(8), pts: view.getFloat64(12) };
        }
        if (this.length < this.head.size) break;
        const { type, flags, config, size, seq, pts } = this.head; this.head = null;
        records.push({ type, flags, config, seq, pts, key: !!(flags & FLAG.KEY), payload: this._take(size) });
      }
      return records;
    }
    _take(size) {
      const out = new Uint8Array(size);
      let written = 0;
      while (written < size) {
        const first = this.chunks[0], count = Math.min(size - written, first.length);
        out.set(count === first.length ? first : first.subarray(0, count), written);
        written += count;
        if (count === first.length) this.chunks.shift(); else this.chunks[0] = first.subarray(count);
      }
      this.length -= size;
      return out;
    }
  }

  return { MAGIC, HEADER, MAX_PAYLOAD, TYPE, FLAG, encodeRecord, RecordParser };
});
