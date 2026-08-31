// Authenticated, encrypted TCP framing for Pair's optional fast file lane.
// A listener only accepts one-time tokens registered by the renderer over an
// already-established Pair session; it is never a public unauthenticated file
// server. Payload frames use AES-256-GCM with a fresh nonce per frame.
const net = require('net');
const crypto = require('crypto');

const MAX_HANDSHAKE = 4096;
const PROTOCOL_VERSION = 2;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const AUTH_NONCE_BYTES = 32;
const AUTH_PROOF_BYTES = 32;
const AEAD_IV_BYTES = 12;
const AEAD_TAG_BYTES = 16;
const FRAME_OVERHEAD = AEAD_IV_BYTES + AEAD_TAG_BYTES;
// Keep the renderer-facing payload limit and the encrypted wire limit
// separate. The old 8 MiB wire limit rejected an otherwise valid 8 MiB IPC
// payload after AES-GCM added its 28 bytes of IV/tag overhead.
const MAX_PLAINTEXT = 8 * 1024 * 1024;
const MAX_FRAME = MAX_PLAINTEXT + FRAME_OVERHEAD;
const CONNECT_TIMEOUT = 5000;
const MAX_PENDING_TOKENS = 32;
const MAX_PENDING_SOCKETS = 128;
const MAX_PENDING_SOCKETS_PER_ADDRESS = 16;
// The app normally has one inbound and one outbound fast lane during a
// simultaneous cross-send. Keep modest headroom without allowing dozens of
// authenticated lanes to each consume a 48 MiB renderer handoff window.
const MAX_ACTIVE_SOCKETS = 8;
const MAX_ACTIVE_SOCKETS_PER_ADDRESS = 4;
const MAX_EARLY_FRAMES = 128;
const MAX_RECEIVE_QUEUE = MAX_FRAME + 1024 * 1024;
const DEFAULT_DRAIN_TIMEOUT = 5 * 60 * 1000;
const ACTIVE_IDLE_TIMEOUT = 10 * 60 * 1000;
const KEEPALIVE_DELAY = 30000;
const MAX_COUNTER = (1n << 64n) - 1n;
const FRAME_AAD = Buffer.from('Knot direct-file frame v2', 'utf8');
// Receive flow control between this process and its own renderer. Frames are
// forwarded over IPC as they decrypt; if the renderer's disk writes fall
// behind a fast LAN peer, these bounds pause the socket instead of letting
// pending IPC frames grow without limit. Pausing closes the TCP receive
// window, which throttles the remote sender through ordinary TCP, so peers
// running older versions need no changes. The high-water mark MUST stay below
// the renderer's per-transfer ACTIVE_FRAME_LIMIT (64 MiB) plus one maximum
// frame: this bounds the handoff while enqueueChunk waits for renderer-side
// decrypt/write capacity, applying TCP backpressure before memory can balloon.
const DEFAULT_HIGH_WATER = 48 * 1024 * 1024;
const DEFAULT_LOW_WATER = 12 * 1024 * 1024;

function credentialKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid direct-file key');
  return Buffer.from(key);
}

function encodeFixed(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeFixed(value, size) {
  if (typeof value !== 'string' || !new RegExp(`^[A-Za-z0-9_-]{${Math.ceil(size * 4 / 3)}}$`).test(value)) return null;
  let decoded;
  try { decoded = Buffer.from(value, 'base64url'); } catch { return null; }
  if (decoded.length !== size || decoded.toString('base64url') !== value) return null;
  return decoded;
}

function authProof(key, role, token, clientNonce, serverNonce = null) {
  const mac = crypto.createHmac('sha256', key);
  mac.update(`Knot direct-file ${role} proof v${PROTOCOL_VERSION}\0`, 'utf8');
  mac.update(token, 'ascii');
  mac.update(Buffer.from([0]));
  mac.update(clientNonce);
  if (serverNonce) mac.update(serverNonce);
  return mac.digest();
}

function sameProof(actual, expected) {
  return Buffer.isBuffer(actual) && Buffer.isBuffer(expected) && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function makeSession(key, token, clientNonce, serverNonce, role) {
  const salt = crypto.createHash('sha256')
    .update(`Knot direct-file session salt v${PROTOCOL_VERSION}\0`, 'utf8')
    .update(token, 'ascii').update(Buffer.from([0]))
    .update(clientNonce).update(serverNonce).digest();
  const material = Buffer.from(crypto.hkdfSync(
    'sha256', key, salt, Buffer.from(`Knot direct-file traffic v${PROTOCOL_VERSION}`, 'utf8'), 72
  ));
  const clientToServer = { key: Buffer.from(material.subarray(0, 32)), prefix: Buffer.from(material.subarray(32, 36)) };
  const serverToClient = { key: Buffer.from(material.subarray(36, 68)), prefix: Buffer.from(material.subarray(68, 72)) };
  material.fill(0); salt.fill(0);
  return role === 'client'
    ? { send: clientToServer, receive: serverToClient }
    : { send: serverToClient, receive: clientToServer };
}

function sequenceIv(prefix, counter) {
  if (!Buffer.isBuffer(prefix) || prefix.length !== 4 || typeof counter !== 'bigint' || counter < 0n || counter > MAX_COUNTER) {
    throw new Error('direct-file frame counter exhausted');
  }
  const iv = Buffer.allocUnsafe(AEAD_IV_BYTES);
  prefix.copy(iv, 0); iv.writeBigUInt64BE(counter, 4);
  return iv;
}

function sealSessionFrame(session, plain) {
  if (session.counter > MAX_COUNTER) throw new Error('direct-file frame counter exhausted');
  const iv = sequenceIv(session.prefix, session.counter);
  const cipher = crypto.createCipheriv('aes-256-gcm', session.key, iv);
  cipher.setAAD(FRAME_AAD, { plaintextLength: plain.length });
  const body = cipher.update(plain), tail = cipher.final();
  const length = FRAME_OVERHEAD + body.length + tail.length;
  const output = Buffer.allocUnsafe(4 + length);
  output.writeUInt32BE(length, 0); iv.copy(output, 4); cipher.getAuthTag().copy(output, 4 + AEAD_IV_BYTES);
  body.copy(output, 4 + FRAME_OVERHEAD);
  if (tail.length) tail.copy(output, 4 + FRAME_OVERHEAD + body.length);
  session.counter++;
  return output;
}

function openSessionFrame(session, frame) {
  if (frame.length < FRAME_OVERHEAD || session.counter > MAX_COUNTER) throw new Error('invalid encrypted frame');
  const expectedIv = sequenceIv(session.prefix, session.counter);
  const actualIv = frame.subarray(0, AEAD_IV_BYTES);
  if (!crypto.timingSafeEqual(actualIv, expectedIv)) throw new Error('unexpected encrypted frame sequence');
  const decipher = crypto.createDecipheriv('aes-256-gcm', session.key, actualIv);
  decipher.setAuthTag(frame.subarray(AEAD_IV_BYTES, FRAME_OVERHEAD));
  decipher.setAAD(FRAME_AAD);
  const body = decipher.update(frame.subarray(FRAME_OVERHEAD)), tail = decipher.final();
  session.counter++;
  return tail.length ? Buffer.concat([body, tail]) : body;
}

function seal(key, plain) {
  const iv = crypto.randomBytes(AEAD_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = cipher.update(plain), tail = cipher.final(), tag = cipher.getAuthTag();
  const frame = Buffer.allocUnsafe(FRAME_OVERHEAD + body.length + tail.length);
  iv.copy(frame, 0);tag.copy(frame, AEAD_IV_BYTES);body.copy(frame, FRAME_OVERHEAD);if (tail.length) tail.copy(frame, FRAME_OVERHEAD + body.length);
  return frame;
}
function open(key, frame) {
  if (frame.length < FRAME_OVERHEAD) throw new Error('short encrypted frame');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, frame.subarray(0, AEAD_IV_BYTES));
  decipher.setAuthTag(frame.subarray(AEAD_IV_BYTES, FRAME_OVERHEAD));
  const body = decipher.update(frame.subarray(FRAME_OVERHEAD)), tail = decipher.final();
  return tail.length ? Buffer.concat([body, tail]) : body;
}
function pack(frame) {
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(frame.length);
  return Buffer.concat([len, frame]);
}

function sealAndPack(key, plain) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = cipher.update(plain), tail = cipher.final(), length = FRAME_OVERHEAD + body.length + tail.length;
  const output = Buffer.allocUnsafe(4 + length);output.writeUInt32BE(length, 0);iv.copy(output, 4);cipher.getAuthTag().copy(output, 4 + AEAD_IV_BYTES);body.copy(output, 4 + FRAME_OVERHEAD);if(tail.length)tail.copy(output, 4 + FRAME_OVERHEAD + body.length);
  return output;
}

// A framed transfer commonly arrives as scores of 64 KiB TCP chunks. Repeated
// Buffer.concat on every chunk recopies the entire partial multi-megabyte frame
// and turns receive cost quadratic. This queue consumes each byte once.
class ChunkQueue {
  constructor() { this.chunks = [];this.head = 0;this.offset = 0;this.length = 0; }
  push(chunk) { if (chunk?.length) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));this.length += chunk.length; } }
  take(size) {
    if (!Number.isInteger(size) || size < 0 || size > this.length) return null;
    if (!size) return Buffer.alloc(0);
    const first = this.chunks[this.head], available = first.length - this.offset;
    if (size <= available) {
      const output = first.subarray(this.offset, this.offset + size);this.offset += size;this.length -= size;
      if (this.offset === first.length) { this.head++;this.offset = 0;this.compact(); }
      return output;
    }
    const output = Buffer.allocUnsafe(size);let written = 0;
    while (written < size) {
      const chunk = this.chunks[this.head], count = Math.min(size - written, chunk.length - this.offset);
      chunk.copy(output, written, this.offset, this.offset + count);written += count;this.offset += count;
      if (this.offset === chunk.length) { this.head++;this.offset = 0; }
    }
    this.length -= size;this.compact();return output;
  }
  compact() { if (this.head > 32 && this.head * 2 >= this.chunks.length) { this.chunks = this.chunks.slice(this.head);this.head = 0; } }
  clear() { this.chunks = [];this.head = 0;this.offset = 0;this.length = 0; }
}

class PeerSocket {
  constructor(socket, key, options = {}, session = null) {
    this.socket = socket;
    this.key = session ? null : credentialKey(key);
    this.session = session;
    if (session) {
      for (const direction of ['send', 'receive']) {
        const state = session[direction];
        if (!state || !Buffer.isBuffer(state.key) || state.key.length !== 32 || !Buffer.isBuffer(state.prefix) || state.prefix.length !== 4) {
          throw new Error('invalid direct-file session');
        }
        state.counter = 0n;
      }
    }
    this.queue = new ChunkQueue(); this.pendingLength = 0; this.closed = false; this._disposed = false;
    const high = Number(options.highWater), low = Number(options.lowWater), drainTimeout = Number(options.drainTimeout);
    this.highWater = Number.isFinite(high) && high > 0
      ? Math.min(64 * 1024 * 1024, Math.max(1, Math.floor(high)))
      : DEFAULT_HIGH_WATER;
    // Keep resume strictly below pause so a single acknowledgement batch
    // cannot flip-flop the socket every frame.
    const requestedLow = Number.isFinite(low) && low > 0 ? Math.floor(low) : DEFAULT_LOW_WATER;
    this.lowWater = Math.max(0, Math.min(requestedLow, Math.floor(this.highWater / 2)));
    this.drainTimeout = Number.isFinite(drainTimeout) && drainTimeout > 0
      ? Math.min(10 * 60 * 1000, Math.max(30000, Math.floor(drainTimeout)))
      : DEFAULT_DRAIN_TIMEOUT;
    this.inflight = 0; this.paused = false; this._draining = false; this._deliveringEarly = false;
    this._frameHandler = null; this._earlyFrames = [];
    this._closeHandler = null; this._closeDelivered = false; this._closeTimer = null;
    socket.on('data', b => this._read(b));
    socket.once('close', () => this._handleClose());
    // A net.Socket emits close after error. Keeping one error listener prevents
    // an intentionally rejected frame from becoming an uncaught exception.
    socket.once('error', () => {});
    try { socket.setKeepAlive?.(true, KEEPALIVE_DELAY); } catch {}
    try { socket.setTimeout?.(ACTIVE_IDLE_TIMEOUT, () => this._abort('direct-file socket became idle')); } catch {}
  }
  // Frames can decode before the owner assigns a handler: the accept path
  // feeds pipelined bytes left over from the handshake, and a fast sender's
  // first chunk may already be in that buffer. Queue them instead of letting
  // a default no-op swallow the data, then flush on assignment.
  get onFrame() { return this._frameHandler || (frame => {}); }
  set onFrame(handler) {
    this._frameHandler = typeof handler === 'function' ? handler : null;
    if (this.closed || !this._frameHandler || !this._earlyFrames.length) return;
    const early = this._earlyFrames; this._earlyFrames = []; this._deliveringEarly = true;
    try {
      for (const frame of early) {
        // The consumer may synchronously cancel the lane while handling an
        // early frame. Do not deliver the remainder after close() has made the
        // connection stale; normal _drain() checks the same condition at the
        // top of every iteration.
        if (this.closed) return;
        if (!this._deliver(frame)) return;
      }
    } finally {
      this._deliveringEarly = false;
      if (!this.paused) {
        this._drain();
        if (!this.paused) this._resumeSocket();
      }
    }
  }

  get onClose() { return this._closeHandler || (() => {}); }
  set onClose(handler) {
    this._closeHandler = typeof handler === 'function' ? handler : null;
    if (this._disposed) this._notifyClose();
  }

  _notifyClose() {
    if (this._closeDelivered || !this._closeHandler) return;
    this._closeDelivered = true;
    try { this._closeHandler(); } catch {}
  }

  _handleClose() {
    if (this._disposed) return;
    this._disposed = true; this.closed = true; clearTimeout(this._closeTimer); this._closeTimer = null;
    this.queue.clear(); this._earlyFrames = []; this.pendingLength = 0; this.inflight = 0;
    if (this.key) this.key.fill(0);
    if (this.session) {
      this.session.send.key.fill(0); this.session.receive.key.fill(0);
      this.session.send.prefix.fill(0); this.session.receive.prefix.fill(0);
    }
    this._notifyClose();
  }

  _abort(message) {
    const error = message instanceof Error ? message : new Error(String(message));
    try { this.socket.destroy(error); } catch { this._handleClose(); }
    return false;
  }

  _pauseSocket() {
    if (this.paused) return true;
    this.paused = true;
    try { this.socket.pause(); return true; } catch { return this._abort('direct-file receive flow control failed'); }
  }

  _resumeSocket() {
    if (this.closed || this.paused) return;
    try { this.socket.resume(); } catch { this._abort('direct-file receive flow control failed'); }
  }

  _deliver(frame) {
    let result;
    try { result = this._frameHandler(frame); }
    catch { return this._abort('direct-file frame consumer failed'); }
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => this._abort('direct-file frame consumer failed'));
    }
    return true;
  }

  _emit(frame) {
    this.inflight += frame.length;
    // Stop reading above the high-water mark; resume once the renderer has
    // acknowledged enough consumption below the low-water mark.
    if (this.inflight >= this.highWater && !this._pauseSocket()) return false;
    return this._deliver(frame);
  }

  _read(chunk) {
    if (this.closed || !chunk?.length) return;
    if (this.queue.length + chunk.length > MAX_RECEIVE_QUEUE) return this._abort('direct-file receive queue exceeded its limit');
    this.queue.push(chunk);
    this._drain();
  }

  _drain() {
    if (this.closed || this._draining) return;
    this._draining = true;
    try {
    for (;;) {
      if (this.closed || this.paused) return;
      if (!this.pendingLength) {
        if (this.queue.length < 4) return;
        const header = this.queue.take(4), len = header.readUInt32BE(0);
        if (len < FRAME_OVERHEAD + 1 || len > MAX_FRAME) return void this._abort('invalid direct-file frame length');
        this.pendingLength = len;
      }
      if (this.queue.length < this.pendingLength) return;
      const encrypted = this.queue.take(this.pendingLength);this.pendingLength = 0;
      let plain;
      try { plain = this.session ? openSessionFrame(this.session.receive, encrypted) : open(this.key, encrypted); }
      catch { return void this._abort('invalid encrypted frame'); }
      if (!plain.length || plain.length > MAX_PLAINTEXT) return void this._abort('invalid direct-file payload length');
      if (!this._frameHandler) {
        this.inflight += plain.length;
        this._earlyFrames.push(plain);
        if (this._earlyFrames.length > MAX_EARLY_FRAMES) return void this._abort('too many direct-file frames before consumer setup');
        if (this.inflight >= this.highWater && !this._pauseSocket()) return;
        continue;
      }
      if (!this._emit(plain)) return;
    }
    } finally { this._draining = false; }
  }
  // Acknowledge consumed bytes from the renderer. Purely local accounting:
  // the wire protocol is unchanged and no remote acknowledgement exists.
  credit(bytes) {
    if (this.closed) return;
    const value = Number(bytes);
    if (!Number.isSafeInteger(value) || value <= 0) return;
    this.inflight = Math.max(0, this.inflight - Math.min(value, this.inflight));
    if (this.paused && this.inflight <= this.lowWater) {
      this.paused = false;
      if (!this._deliveringEarly) {
        this._drain();
        if (!this.paused) this._resumeSocket();
      }
    }
  }
  send(data) {
    if (this.closed || this.socket.destroyed || this.socket.writableEnded) throw new Error('socket closed');
    const plain = Buffer.from(data);
    if (!plain.length || plain.length > MAX_PLAINTEXT) throw new Error('invalid direct-file payload length');
    const frame = this.session ? sealSessionFrame(this.session.send, plain) : sealAndPack(this.key, plain);
    try { return this.socket.write(frame); }
    catch (error) { this._abort(error); throw error; }
  }
  sendAsync(data) {
    if (this.closed) return Promise.reject(new Error('socket closed'));
    let drained;
    try { drained = this.send(data); } catch (error) { return Promise.reject(error); }
    if (drained) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = fn => value => { cleanup(); fn(value); };
      const cleanup = () => { clearTimeout(timeout); this.socket.removeListener('drain', onDrain); this.socket.removeListener('error', onError); this.socket.removeListener('close', onClose); };
      const onDrain = done(resolve), onError = done(reject), onClose = done(() => reject(new Error('socket closed')));
      const timeout = setTimeout(done(() => {
        this._abort('direct-file socket did not drain');
        reject(new Error('socket did not drain'));
      }), this.drainTimeout);
      this.socket.once('drain', onDrain); this.socket.once('error', onError); this.socket.once('close', onClose);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.socket.destroyed) return this._handleClose();
    // close() means the application abandoned this lane. Destroy immediately
    // rather than flushing uncertain queued bytes that the caller may retry on
    // WebRTC after this method returns.
    try { this.socket.destroy(); } catch { this._handleClose(); }
  }
}

class DirectFileHost {
  constructor(port = 8787, options = {}) {
    const numericPort = Number(port);
    if (!Number.isInteger(numericPort) || numericPort < 0 || numericPort > 65535) throw new Error('invalid direct-file port');
    this.port = numericPort;
    this.peerOptions = options || {};
    this.server = null;
    this.tokens = new Map();
    this.pendingSockets = new Set();
    this.pendingByAddress = new Map();
    this.activeSockets = new Set();
    this.activeByAddress = new Map();
    this._candidateServers = new Map();
    this._listenPromise = null;
    this._generation = 0;
  }
  listen() {
    if (this.server) return Promise.resolve();
    if (this._listenPromise) return this._listenPromise;
    const generation = this._generation;
    const start = host => new Promise((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: false }, socket => this._accept(socket));
      server.maxConnections = MAX_PENDING_SOCKETS + MAX_ACTIVE_SOCKETS;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true; this._candidateServers.delete(server);
        server.removeListener('error', fail); server.on('error', () => {});
        try { server.close(); } catch {}
        reject(error);
      };
      this._candidateServers.set(server, () => fail(new Error('direct-file listener was closed')));
      server.once('error', fail);
      try { server.listen(this.port, host, () => {
        if (settled) { try { server.close(); } catch {} return; }
        settled = true;
        this._candidateServers.delete(server);
        server.removeListener('error', fail);
        // Keep serving after runtime errors; only listen failures reject.
        server.on('error', () => {});
        resolve(server);
      }); } catch (error) { fail(error); }
    });
    const operation = (async () => {
      // '::' accepts IPv6 and IPv4-mapped connections. ICE may report either
      // address family for the selected candidate pair, so the fast lane must
      // accept both; fall back when the system has no IPv6 stack at all.
      let server;
      try { server = await start('::'); }
      catch (error) {
        if (error && ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENOTSUP'].includes(error.code)) server = await start('0.0.0.0');
        else throw error;
      }
      if (generation !== this._generation) { try { server.close(); } catch {} throw new Error('direct-file listener was closed'); }
      this.server = server;
    })();
    let wrapped;
    wrapped = operation.finally(() => {
      if (this._listenPromise === wrapped) this._listenPromise = null;
    });
    this._listenPromise = wrapped;
    return wrapped;
  }
  register(token, key, onPeer) {
    if (!TOKEN_PATTERN.test(token) || !Buffer.isBuffer(key) || key.length !== 32 || typeof onPeer !== 'function') throw new Error('invalid direct-file credentials');
    // Sweep tokens whose owner never completed a connection instead of
    // accumulating them for the lifetime of the listener.
    const now = Date.now();
    this._sweepTokens(now);
    if (this.tokens.has(token)) throw new Error('direct-file token is already registered');
    if (this.tokens.size >= MAX_PENDING_TOKENS) throw new Error('too many pending direct-file offers');
    this.tokens.set(token, { key: Buffer.from(key), onPeer, expiry: now + 60000 });
  }
  _dropToken(token) {
    const item = this.tokens.get(token);
    if (!item) return;
    this.tokens.delete(token);
    try { item.key.fill(0); } catch {}
  }
  _sweepTokens(now = Date.now()) {
    for (const [token, item] of this.tokens) if (item.expiry <= now) this._dropToken(token);
  }
  _address(socket) {
    const raw = String(socket.remoteAddress || 'unknown').toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
    return mapped ? mapped[1] : raw;
  }
  _untrackPending(socket) {
    if (!this.pendingSockets.delete(socket)) return;
    const address = socket._pairRemoteAddress;
    const count = (this.pendingByAddress.get(address) || 1) - 1;
    if (count > 0) this.pendingByAddress.set(address, count);
    else this.pendingByAddress.delete(address);
  }
  _untrackActive(socket) {
    if (!this.activeSockets.delete(socket)) return;
    const address = socket._pairActiveRemoteAddress;
    const count = (this.activeByAddress.get(address) || 1) - 1;
    if (count > 0) this.activeByAddress.set(address, count);
    else this.activeByAddress.delete(address);
  }
  _canPromote(socket) {
    const address = socket._pairRemoteAddress;
    return this.activeSockets.size < MAX_ACTIVE_SOCKETS && (this.activeByAddress.get(address) || 0) < MAX_ACTIVE_SOCKETS_PER_ADDRESS;
  }
  _promote(socket) {
    this._untrackPending(socket);
    socket._pairActiveRemoteAddress = socket._pairRemoteAddress;
    this.activeSockets.add(socket);
    this.activeByAddress.set(socket._pairActiveRemoteAddress, (this.activeByAddress.get(socket._pairActiveRemoteAddress) || 0) + 1);
    const untrack = () => this._untrackActive(socket);
    socket.once('close', untrack);
    socket.once('error', untrack);
  }
  _accept(socket) {
    const address = this._address(socket);
    const addressCount = this.pendingByAddress.get(address) || 0;
    if (this.pendingSockets.size >= MAX_PENDING_SOCKETS || addressCount >= MAX_PENDING_SOCKETS_PER_ADDRESS) {
      socket.destroy();
      return;
    }
    socket._pairRemoteAddress = address;
    this.pendingSockets.add(socket);
    this.pendingByAddress.set(address, addressCount + 1);
    const untrack = () => this._untrackPending(socket);
    socket.once('close', untrack);
    socket.once('error', untrack);
    socket.setNoDelay(true); socket.setKeepAlive(true, KEEPALIVE_DELAY); socket.setTimeout(10000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    const read = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const nl = buffer.indexOf(10);
      // Apply the handshake cap to the line, not to bytes pipelined after it.
      // A valid response/hello and a first multi-megabyte frame can legally be
      // coalesced into one TCP read.
      if (nl < 0) { if (buffer.length > MAX_HANDSHAKE) socket.destroy(); return; }
      if (nl > MAX_HANDSHAKE) return socket.destroy();
      socket.removeListener('data', read);
      let hello; try { hello = JSON.parse(buffer.subarray(0, nl).toString('utf8')); } catch { return socket.destroy(); }
      if (!hello || hello.v !== PROTOCOL_VERSION || !TOKEN_PATTERN.test(hello.token || '')) return socket.destroy();
      const item = this.tokens.get(hello.token);
      if (!item) return socket.destroy();
      if (item.expiry <= Date.now()) { this._dropToken(hello.token); return socket.destroy(); }
      const clientNonce = decodeFixed(hello.nonce, AUTH_NONCE_BYTES);
      const clientProof = decodeFixed(hello.proof, AUTH_PROOF_BYTES);
      if (!clientNonce || !clientProof || !sameProof(clientProof, authProof(item.key, 'client', hello.token, clientNonce))) return socket.destroy();
      // Do not consume a valid one-time offer just because this listener is
      // already at its authenticated-connection cap. The real peer can retry
      // after another lane closes.
      if (!this._canPromote(socket)) return socket.destroy();
      const serverNonce = crypto.randomBytes(AUTH_NONCE_BYTES);
      const serverProof = authProof(item.key, 'server', hello.token, clientNonce, serverNonce);
      let session;
      try { session = makeSession(item.key, hello.token, clientNonce, serverNonce, 'server'); }
      catch { return socket.destroy(); }
      this.tokens.delete(hello.token); item.key.fill(0);
      this._promote(socket);
      socket.removeListener('close', untrack);
      socket.removeListener('error', untrack);
      socket.setTimeout(0); socket.removeAllListeners('timeout');
      try { socket.write(`PAIR/${PROTOCOL_VERSION} ${encodeFixed(serverNonce)} ${encodeFixed(serverProof)}\n`); }
      catch { socket.destroy(); return; }
      let peer;
      try { peer = new PeerSocket(socket, null, this.peerOptions, session); }
      catch { socket.destroy(); return; }
      // Wire the owner before consuming any pipelined handshake leftovers so
      // a fast sender's first frames are never decoded without a handler.
      try { item.onPeer(peer, { v: PROTOCOL_VERSION, token: hello.token }); } catch { socket.destroy(); return; }
      if (buffer.length > nl + 1) peer._read(buffer.subarray(nl + 1));
    };
    socket.on('data', read);
  }
  close() {
    this._generation++;
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
    for (const cancel of this._candidateServers.values()) try { cancel(); } catch {}
    this._candidateServers.clear();
    for (const socket of this.pendingSockets) try { socket.destroy(); } catch {}
    for (const socket of this.activeSockets) try { socket.destroy(); } catch {}
    this.pendingSockets.clear();
    this.pendingByAddress.clear();
    this.activeSockets.clear();
    this.activeByAddress.clear();
    for (const token of [...this.tokens.keys()]) this._dropToken(token);
  }
}

function connect(host, port, token, key, options = {}) {
  const numericPort = Number(port);
  if (typeof host !== 'string' || !host || host.length > 255 || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535 || !TOKEN_PATTERN.test(token || '')) {
    return Promise.reject(new Error('invalid direct-file connection'));
  }
  let baseKey;
  try { baseKey = credentialKey(key); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: numericPort }); socket.setNoDelay(true); socket.setKeepAlive(true, KEEPALIVE_DELAY);
    let settled = false;
    const clientNonce = crypto.randomBytes(AUTH_NONCE_BYTES);
    const clientProof = authProof(baseKey, 'client', token, clientNonce);
    // Every failure path destroys the socket: a dropped SYN or a bad token
    // must not leave a half-open connection hanging for minutes.
    const fail = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      socket.removeListener('data', read);
      socket.destroy();
      baseKey.fill(0);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const requestedTimeout = Number(options.timeout);
    const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(30000, Math.max(250, Math.floor(requestedTimeout)))
      : CONNECT_TIMEOUT;
    const timer = setTimeout(() => fail(new Error('direct-file connection timed out')), timeout);
    const onClose = () => fail(new Error('direct-file connection closed'));
    socket.once('error', fail);
    socket.once('close', onClose);
    const read = b => {
      response = Buffer.concat([response, b]);
      const nl = response.indexOf(10);
      if (nl < 0) { if (response.length > MAX_HANDSHAKE) fail(new Error('direct-file authentication failed')); return; }
      if (nl > MAX_HANDSHAKE) return fail(new Error('direct-file authentication failed'));
      socket.removeListener('data', read);
      const match = new RegExp(`^PAIR/${PROTOCOL_VERSION} ([A-Za-z0-9_-]{${Math.ceil(AUTH_NONCE_BYTES * 4 / 3)}}) ([A-Za-z0-9_-]{${Math.ceil(AUTH_PROOF_BYTES * 4 / 3)}})$`)
        .exec(response.subarray(0, nl).toString('ascii'));
      if (!match) return fail(new Error('direct-file authentication failed'));
      const serverNonce = decodeFixed(match[1], AUTH_NONCE_BYTES);
      const serverProof = decodeFixed(match[2], AUTH_PROOF_BYTES);
      if (!serverNonce || !serverProof || !sameProof(serverProof, authProof(baseKey, 'server', token, clientNonce, serverNonce))) {
        return fail(new Error('direct-file authentication failed'));
      }
      let session;
      try { session = makeSession(baseKey, token, clientNonce, serverNonce, 'client'); }
      catch (error) { return fail(error); }
      settled = true; clearTimeout(timer);
      socket.removeListener('error', fail); socket.removeListener('close', onClose);
      baseKey.fill(0);
      let peer;
      try { peer = new PeerSocket(socket, null, options, session); }
      catch (error) { socket.destroy(); reject(error); return; }
      if (response.length > nl + 1) peer._read(response.subarray(nl + 1));
      resolve(peer);
    };
    let response = Buffer.alloc(0);
    socket.once('connect', () => {
      try { socket.write(JSON.stringify({ v: PROTOCOL_VERSION, token, nonce: encodeFixed(clientNonce), proof: encodeFixed(clientProof) }) + '\n'); }
      catch (error) { fail(error); }
    });
    socket.on('data', read);
  });
}

module.exports = { DirectFileHost, PeerSocket, ChunkQueue, connect, seal, open, pack, sealAndPack };
