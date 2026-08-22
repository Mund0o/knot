// Authenticated, encrypted TCP framing for Pair's optional fast file lane.
// A listener only accepts one-time tokens registered by the renderer over an
// already-established Pair session; it is never a public unauthenticated file
// server. Payload frames use AES-256-GCM with a fresh nonce per frame.
const net = require('net');
const crypto = require('crypto');

const MAX_HANDSHAKE = 4096;
const MAX_FRAME = 8 * 1024 * 1024;
const CONNECT_TIMEOUT = 5000;
// Receive flow control between this process and its own renderer. Frames are
// forwarded over IPC as they decrypt; if the renderer's disk writes fall
// behind a fast LAN peer, these bounds pause the socket instead of letting
// pending IPC frames grow without limit. Pausing closes the TCP receive
// window, which throttles the remote sender through ordinary TCP, so peers
// running older versions need no changes. The high-water mark MUST stay below
// the renderer's per-transfer ACTIVE_FRAME_LIMIT (64 MiB) plus one maximum
// frame: crossing it would make enqueueChunk silently drop a chunk and stall
// the whole transfer instead of applying backpressure.
const DEFAULT_HIGH_WATER = 48 * 1024 * 1024;
const DEFAULT_LOW_WATER = 12 * 1024 * 1024;

function seal(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
function open(key, frame) {
  if (frame.length < 28) throw new Error('short encrypted frame');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, frame.subarray(0, 12));
  decipher.setAuthTag(frame.subarray(12, 28));
  return Buffer.concat([decipher.update(frame.subarray(28)), decipher.final()]);
}
function pack(frame) {
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(frame.length);
  return Buffer.concat([len, frame]);
}

class PeerSocket {
  constructor(socket, key, options = {}) {
    this.socket = socket; this.key = key; this.buffer = Buffer.alloc(0); this.closed = false;
    const high = Number(options.highWater), low = Number(options.lowWater);
    this.highWater = high > 0 ? high : DEFAULT_HIGH_WATER;
    // Keep resume strictly below pause so a single acknowledgement batch
    // cannot flip-flop the socket every frame.
    this.lowWater = Math.min(low > 0 ? low : DEFAULT_LOW_WATER, this.highWater / 2);
    this.inflight = 0; this.paused = false;
    this._frameHandler = null; this._earlyFrames = []; this.onClose = () => {};
    socket.on('data', b => this._read(b));
    socket.once('close', () => { this.closed = true; this.onClose(); });
    socket.once('error', () => {});
  }
  // Frames can decode before the owner assigns a handler: the accept path
  // feeds pipelined bytes left over from the handshake, and a fast sender's
  // first chunk may already be in that buffer. Queue them instead of letting
  // a default no-op swallow the data, then flush on assignment.
  get onFrame() { return this._frameHandler || (frame => {}); }
  set onFrame(handler) {
    this._frameHandler = handler || (frame => {});
    if (this._earlyFrames.length && this._frameHandler) {
      const early = this._earlyFrames; this._earlyFrames = [];
      for (const frame of early) if (!this._emit(frame)) return;
    }
  }
  _emit(frame) {
    this.inflight += frame.length;
    // Stop reading above the high-water mark; resume once the renderer has
    // acknowledged enough consumption below the low-water mark.
    if (!this.paused && this.inflight > this.highWater) { this.paused = true; try { this.socket.pause(); } catch {} }
    try { this.onFrame(frame); } catch { this.socket.destroy(new Error('invalid encrypted frame')); return false; }
    return true;
  }
  _read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (!len || len > MAX_FRAME) return this.socket.destroy(new Error('invalid frame length'));
      if (this.buffer.length < 4 + len) return;
      const encrypted = this.buffer.subarray(4, 4 + len); this.buffer = this.buffer.subarray(4 + len);
      let plain;
      try { plain = open(this.key, encrypted); } catch { this.socket.destroy(new Error('invalid encrypted frame')); return; }
      if (!this._frameHandler) { this._earlyFrames.push(plain); continue; }
      if (!this._emit(plain)) return;
    }
  }
  // Acknowledge consumed bytes from the renderer. Purely local accounting:
  // the wire protocol is unchanged and no remote acknowledgement exists.
  credit(bytes) {
    if (this.closed) return;
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return;
    this.inflight = Math.max(0, this.inflight - value);
    if (this.paused && this.inflight <= this.lowWater) { this.paused = false; try { this.socket.resume(); } catch {} }
  }
  send(data) {
    if (this.closed) throw new Error('socket closed');
    const frame = pack(seal(this.key, Buffer.from(data)));
    return this.socket.write(frame);
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
      const timeout = setTimeout(done(() => reject(new Error('socket did not drain'))), 30000);
      this.socket.once('drain', onDrain); this.socket.once('error', onError); this.socket.once('close', onClose);
    });
  }
  close() { try { this.socket.end(); } catch {} }
}

class DirectFileHost {
  constructor(port = 8787, options = {}) { this.port = port; this.peerOptions = options || {}; this.server = null; this.tokens = new Map(); }
  listen() {
    if (this.server) return Promise.resolve();
    const start = host => new Promise((resolve, reject) => {
      const server = net.createServer(socket => this._accept(socket));
      const fail = error => { try { server.close(); } catch {} reject(error); };
      server.once('error', fail);
      server.listen(this.port, host, () => {
        server.removeListener('error', fail);
        // Keep serving after runtime errors; only listen failures reject.
        server.on('error', () => {});
        resolve(server);
      });
    });
    return (async () => {
      // '::' accepts IPv6 and IPv4-mapped connections. ICE may report either
      // address family for the selected candidate pair, so the fast lane must
      // accept both; fall back when the system has no IPv6 stack at all.
      try { this.server = await start('::'); }
      catch (error) {
        if (error && ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENOTSUP'].includes(error.code)) this.server = await start('0.0.0.0');
        else throw error;
      }
    })();
  }
  register(token, key, onPeer) {
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token) || !Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid direct-file credentials');
    // Sweep tokens whose owner never completed a connection instead of
    // accumulating them for the lifetime of the listener.
    const now = Date.now();
    for (const [stale, item] of this.tokens) if (item.expiry < now) this.tokens.delete(stale);
    this.tokens.set(token, { key, onPeer, expiry: now + 60000 });
  }
  _accept(socket) {
    socket.setNoDelay(true); socket.setTimeout(10000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    const read = chunk => {
      buffer = Buffer.concat([buffer, chunk]); if (buffer.length > MAX_HANDSHAKE) return socket.destroy();
      const nl = buffer.indexOf(10); if (nl < 0) return;
      socket.removeListener('data', read);
      let hello; try { hello = JSON.parse(buffer.subarray(0, nl).toString('utf8')); } catch { return socket.destroy(); }
      const item = typeof hello.token === 'string' ? this.tokens.get(hello.token) : null;
      if (!item || item.expiry < Date.now()) return socket.destroy();
      this.tokens.delete(hello.token); socket.setTimeout(0); socket.write('PAIR/1 OK\n');
      const peer = new PeerSocket(socket, item.key, this.peerOptions);
      // Wire the owner before consuming any pipelined handshake leftovers so
      // a fast sender's first frames are never decoded without a handler.
      item.onPeer(peer, hello);
      if (buffer.length > nl + 1) peer._read(buffer.subarray(nl + 1));
    };
    socket.on('data', read);
  }
  close() { if (this.server) { try { this.server.close(); } catch {} this.server = null; } this.tokens.clear(); }
}

function connect(host, port, token, key, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }); socket.setNoDelay(true);
    let settled = false;
    // Every failure path destroys the socket: a dropped SYN or a bad token
    // must not leave a half-open connection hanging for minutes.
    const fail = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      socket.removeListener('data', read);
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => fail(new Error('direct-file connection timed out')), Number(options.timeout) || CONNECT_TIMEOUT);
    const onClose = () => fail(new Error('direct-file connection closed'));
    socket.once('error', fail);
    socket.once('close', onClose);
    const read = b => {
      response = Buffer.concat([response, b]);
      if (response.length > MAX_HANDSHAKE) return fail(new Error('direct-file authentication failed'));
      const nl = response.indexOf(10); if (nl < 0) return;
      socket.removeListener('data', read);
      if (response.subarray(0, nl).toString() !== 'PAIR/1 OK') return fail(new Error('direct-file authentication failed'));
      settled = true; clearTimeout(timer);
      socket.removeListener('error', fail); socket.removeListener('close', onClose);
      const peer = new PeerSocket(socket, key, options);
      if (response.length > nl + 1) peer._read(response.subarray(nl + 1));
      resolve(peer);
    };
    let response = Buffer.alloc(0);
    socket.once('connect', () => socket.write(JSON.stringify({ v: 1, token }) + '\n'));
    socket.on('data', read);
  });
}

module.exports = { DirectFileHost, PeerSocket, connect, seal, open, pack };
