// Authenticated, encrypted TCP framing for Pair's optional fast file lane.
// A listener only accepts one-time tokens registered by the renderer over an
// already-established Pair session; it is never a public unauthenticated file
// server. Payload frames use AES-256-GCM with a fresh nonce per frame.
const net = require('net');
const crypto = require('crypto');

const MAX_HANDSHAKE = 4096;
const MAX_FRAME = 8 * 1024 * 1024;

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
  constructor(socket, key) {
    this.socket = socket; this.key = key; this.buffer = Buffer.alloc(0); this.closed = false;
    this.onFrame = () => {}; this.onClose = () => {};
    socket.on('data', b => this._read(b));
    socket.once('close', () => { this.closed = true; this.onClose(); });
    socket.once('error', () => {});
  }
  _read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (!len || len > MAX_FRAME) return this.socket.destroy(new Error('invalid frame length'));
      if (this.buffer.length < 4 + len) return;
      const encrypted = this.buffer.subarray(4, 4 + len); this.buffer = this.buffer.subarray(4 + len);
      try { this.onFrame(open(this.key, encrypted)); } catch { this.socket.destroy(new Error('invalid encrypted frame')); return; }
    }
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
  constructor(port = 8787) { this.port = port; this.server = null; this.tokens = new Map(); }
  listen() {
    if (this.server) return Promise.resolve();
    this.server = net.createServer(socket => this._accept(socket));
    this.server.on('error', () => {});
    return new Promise((resolve, reject) => {
      const fail = e => { this.server = null; reject(e); };
      this.server.once('error', fail);
      this.server.listen(this.port, '0.0.0.0', () => { this.server.removeListener('error', fail); resolve(); });
    });
  }
  register(token, key, onPeer) {
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token) || !Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid direct-file credentials');
    this.tokens.set(token, { key, onPeer, expiry: Date.now() + 60000 });
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
      const peer = new PeerSocket(socket, item.key);
      if (buffer.length > nl + 1) peer._read(buffer.subarray(nl + 1));
      item.onPeer(peer, hello);
    };
    socket.on('data', read);
  }
  close() { if (this.server) { try { this.server.close(); } catch {} this.server = null; } this.tokens.clear(); }
}

function connect(host, port, token, key) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }); socket.setNoDelay(true);
    socket.once('error', reject); socket.once('connect', () => socket.write(JSON.stringify({ v: 1, token }) + '\n'));
    let response = Buffer.alloc(0);
    const read = b => { response = Buffer.concat([response, b]); const nl = response.indexOf(10); if (nl < 0) return; socket.removeListener('data', read); if (response.subarray(0, nl).toString() !== 'PAIR/1 OK') return reject(new Error('direct-file authentication failed')); const peer = new PeerSocket(socket, key); if (response.length > nl + 1) peer._read(response.subarray(nl + 1)); resolve(peer); };
    socket.on('data', read);
  });
}

module.exports = { DirectFileHost, PeerSocket, connect, seal, open };
