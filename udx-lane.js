'use strict';

// Fast direct file lane over UDP. Two Knots that already share an authenticated
// WebRTC session use that session to swap UDP endpoints, punch through their
// NATs, and then run the same token + AEAD protocol as direct-file.js over a
// UDX stream (reliable, congestion controlled, no handshake or encryption of
// its own). Nothing here is trusted on its own: a stream only becomes a file
// lane after direct-file.js has authenticated it with the one-time token.
const crypto = require('crypto');
const dns = require('dns');
const os = require('os');
const { EventEmitter } = require('events');

const STUN_SERVERS = [['stun.l.google.com', 19302], ['stun1.l.google.com', 19302]];
const STUN_COOKIE = 0x2112a442;
const STUN_TIMEOUT_MS = 2000;
const PUNCH_INTERVAL_MS = 80;
// A punch that reaches the other NAT before that side has sent anything of its own makes
// Linux-style NATs hand the sender a different external port afterwards, and both sides
// then aim at ports the other is not using. So the first punches carry a TTL that gets out
// of our own router but expires long before the other one; only after the hold do normal
// punches start. The hold has to outlast the skew between the two sides' start times.
const PUNCH_HOLD_MS = 600;
// After this side has its stream it keeps answering the other side's punches this long: the
// other side may not have heard an ACK yet, and it needs one round trip to get it.
const PUNCH_LINGER_MS = 3000;
const LOW_TTLS = [2, 3];
const PUNCH_WINDOW_MS = 6000;
const LANE_IDLE_MS = 45000;
const MAX_LANES = 4;                       // default; a caller that needs more lanes at once (one per viewer of a share) passes maxLanes
const MAX_REMOTE_ENDPOINTS = 8;
const PUNCH_MAGIC = Buffer.from('KUDX1', 'ascii');
const PUNCH = 1, ACK = 2;
const PUNCH_LENGTH = PUNCH_MAGIC.length + 1 + 8;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

let udxModule = null;
function loadUdx() {
  if (!udxModule) udxModule = require('udx-native');
  return udxModule;
}

function ipv4Parts(value) {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.some(part => part > 255) ? null : parts;
}

// Endpoints come from the other Knot over the encrypted session, but they still
// decide where this process sends UDP. Refuse anything that is not an ordinary
// unicast IPv4 address and port.
function validEndpoint(endpoint, allowLoopback = false) {
  const parts = ipv4Parts(endpoint?.ip);
  const port = Number(endpoint?.port);
  if (!parts || !Number.isInteger(port) || port < 1024 || port > 65535) return false;
  const [a, b] = parts;
  if (a === 0 || (a === 127 && !allowLoopback) || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

function cleanEndpoints(list, allowLoopback = false) {
  const seen = new Set(), result = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!validEndpoint(item, allowLoopback)) continue;
    const key = item.ip + ':' + item.port;
    if (seen.has(key)) continue;
    seen.add(key); result.push({ ip: item.ip, port: Number(item.port), kind: item.kind === 'host' ? 'host' : 'srflx' });
    if (result.length >= MAX_REMOTE_ENDPOINTS) break;
  }
  return result;
}

function privateLan(ip) {
  const parts = ipv4Parts(ip);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

function localAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const item of list || []) {
      if (item.internal || (item.family !== 'IPv4' && item.family !== 4)) continue;
      const parts = ipv4Parts(item.address);
      if (!parts || parts[0] === 169) continue;
      found.push(item.address);
    }
  }
  return [...new Set(found)];
}

// ---------------------------------------------------------------- STUN ----
function stunRequest() {
  const packet = Buffer.alloc(20);
  packet.writeUInt16BE(0x0001, 0);
  packet.writeUInt32BE(STUN_COOKIE, 4);
  crypto.randomFillSync(packet, 8, 12);
  return packet;
}

function parseStunResponse(message, transaction) {
  if (!Buffer.isBuffer(message) || message.length < 20 || message.readUInt16BE(0) !== 0x0101 || message.readUInt32BE(4) !== STUN_COOKIE) return null;
  if (!message.subarray(8, 20).equals(transaction)) return null;
  const end = Math.min(message.length, 20 + message.readUInt16BE(2));
  for (let offset = 20; offset + 4 <= end;) {
    const type = message.readUInt16BE(offset), length = message.readUInt16BE(offset + 2), body = offset + 4;
    if (body + length > end) return null;
    if ((type === 0x0020 && length >= 8 && message[body + 1] === 1) || (type === 0x0001 && length >= 8 && message[body + 1] === 1)) {
      let port = message.readUInt16BE(body + 2), ip = [message[body + 4], message[body + 5], message[body + 6], message[body + 7]];
      if (type === 0x0020) {
        port ^= STUN_COOKIE >>> 16;
        const cookie = Buffer.alloc(4); cookie.writeUInt32BE(STUN_COOKIE);
        ip = ip.map((byte, index) => byte ^ cookie[index]);
      }
      return { ip: ip.join('.'), port };
    }
    offset = body + length + ((4 - (length % 4)) % 4);
  }
  return null;
}

// ----------------------------------------------------- socket-like stream ----
// direct-file.js was written against net.Socket. This exposes exactly the
// surface it uses on top of a UDX stream, including its idle timeout.
class UdxStreamSocket extends EventEmitter {
  constructor(stream, remoteAddress, onClosed = () => {}) {
    super();
    this.stream = stream;
    this.remoteAddress = remoteAddress;
    this._closed = false; this._ended = false; this._idleMs = 0; this._idleTimer = null; this._onClosed = onClosed;
    // A lane that is reset after its owners stopped listening must never become an
    // uncaught exception in the main process.
    this.on('error', () => {});
    stream.on('data', chunk => { this._touch(); this.emit('data', chunk); });
    stream.on('drain', () => this.emit('drain'));
    stream.on('error', error => { this.emit('error', error); });
    stream.on('close', () => this._finish());
    stream.on('end', () => { try { stream.end(); } catch {} });
  }
  get destroyed() { return this._closed; }
  get writableEnded() { return this._ended; }
  get readyState() { return this._closed ? 'closed' : 'open'; }
  write(data) { this._touch(); return this.stream.write(data); }
  end() { this._ended = true; try { this.stream.end(); } catch {} }
  pause() { this.stream.pause(); return this; }
  resume() { this.stream.resume(); return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  setTimeout(ms, callback) {
    this._idleMs = Number(ms) > 0 ? Number(ms) : 0;
    if (typeof callback === 'function') this.once('timeout', callback);
    this._touch();
    return this;
  }
  _touch() {
    clearTimeout(this._idleTimer); this._idleTimer = null;
    if (!this._idleMs || this._closed) return;
    this._idleTimer = setTimeout(() => this.emit('timeout'), this._idleMs);
    this._idleTimer.unref?.();
  }
  destroy(error) {
    if (this._closed) return this;
    try { this.stream.destroy(error instanceof Error ? error : undefined); } catch {}
    this._finish();
    return this;
  }
  _finish() {
    if (this._closed) return;
    this._closed = true; clearTimeout(this._idleTimer); this._idleTimer = null;
    try { this._onClosed(); } catch {}
    this.emit('close');
  }
}

// ----------------------------------------------------------------- lanes ----
class UdxLanes {
  constructor(options = {}) {
    this.stunServers = Array.isArray(options.stunServers) ? options.stunServers : STUN_SERVERS;
    this.stunTimeoutMs = options.stunTimeoutMs || STUN_TIMEOUT_MS;
    this.punchWindowMs = options.punchWindowMs || PUNCH_WINDOW_MS;
    this.bindHost = options.bindHost || '0.0.0.0';
    this.advertiseHosts = options.advertiseHosts || null;
    this.allowLoopback = options.allowLoopback === true;          // tests only
    this.debug = typeof options.debug === 'function' ? options.debug : null;
    this.holdMs = Number.isFinite(options.holdMs) ? options.holdMs : PUNCH_HOLD_MS;
    this.lowTtls = Array.isArray(options.lowTtls) ? options.lowTtls : LOW_TTLS;
    this.maxLanes = Number.isInteger(options.maxLanes) && options.maxLanes > 0 ? Math.min(64, options.maxLanes) : MAX_LANES;
    this.lanes = new Map();
    this.nextStreamId = 1 + crypto.randomInt(1, 0x3fffffff);
  }

  async _discover(socket, port) {
    const endpoints = [];
    const hosts = this.advertiseHosts || localAddresses();
    for (const ip of hosts) endpoints.push({ ip, port, kind: 'host' });
    const reflected = await this._stun(socket);
    if (reflected && validEndpoint(reflected, this.allowLoopback) && !endpoints.some(item => item.ip === reflected.ip && item.port === reflected.port)) endpoints.push({ ...reflected, kind: 'srflx' });
    return endpoints;
  }

  async _stun(socket) {
    const targets = [];
    for (const [host, port] of this.stunServers) {
      try {
        const address = ipv4Parts(host) ? host : (await dns.promises.lookup(host, { family: 4 })).address;
        targets.push([address, port]);
      } catch {}
    }
    if (!targets.length) return null;
    const transaction = stunRequest();
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; clearTimeout(timer); clearInterval(resend); socket.removeListener('message', onMessage); resolve(value); };
      const onMessage = message => { const found = parseStunResponse(message, transaction.subarray(8, 20)); if (found) finish(found); };
      socket.on('message', onMessage);
      const send = () => { for (const [address, port] of targets) { try { socket.trySend(transaction, port, address); } catch {} } };
      const timer = setTimeout(() => finish(null), this.stunTimeoutMs);
      const resend = setInterval(send, 400);
      send();
    });
  }

  async open() {
    if (this.lanes.size >= this.maxLanes) throw new Error('too many UDP lanes');
    const UDX = loadUdx();
    const udx = new UDX();
    const socket = udx.createSocket();
    socket.bind(0, this.bindHost);
    const port = socket.address().port;
    const id = crypto.randomBytes(12).toString('hex');
    const streamId = this.nextStreamId++;
    const lane = { id, udx, socket, streamId, stream: null, adapter: null, closed: false, released: false, timer: null, punching: null };
    this.lanes.set(id, lane);
    lane.timer = setTimeout(() => this.close(id), LANE_IDLE_MS);
    lane.timer.unref?.();
    try {
      lane.endpoints = await this._discover(socket, port);
    } catch (error) { this.close(id); throw error; }
    if (lane.closed) throw new Error('UDP lane closed');
    return { id, streamId, endpoints: lane.endpoints };
  }

  // Both Knots call this at the same time with each other's endpoints. Returns a
  // net.Socket-shaped object once a UDX stream to the other side exists.
  // holdMs is how long normal punches wait behind the low-TTL ones. When the two Knots
  // coordinate over their session the late starter passes 0, the early one passes a long
  // hold and calls release() once the late one says it is armed; any start skew is then safe.
  establish(id, { token, remote, timeoutMs, holdMs } = {}) {
    const lane = this.lanes.get(id);
    if (!lane || lane.closed) return Promise.reject(new Error('unknown UDP lane'));
    if (lane.punching) return Promise.reject(new Error('UDP lane is already connecting'));
    if (!TOKEN_PATTERN.test(token || '')) return Promise.reject(new Error('invalid UDP lane token'));
    const candidates = cleanEndpoints(remote?.endpoints, this.allowLoopback);
    const remoteStreamId = Number(remote?.streamId);
    if (!candidates.length || !Number.isInteger(remoteStreamId) || remoteStreamId < 1 || remoteStreamId > 0xffffffff) return Promise.reject(new Error('invalid UDP lane peer'));
    const tag = crypto.createHash('sha256').update('Knot udx punch v1').update(token).digest().subarray(0, 8);
    const packet = kind => Buffer.concat([PUNCH_MAGIC, Buffer.from([kind]), tag]);
    const window = Math.min(30000, Math.max(500, Math.floor(Number(timeoutMs) || this.punchWindowMs)));
    clearTimeout(lane.timer);
    lane.timer = setTimeout(() => this.close(id), window + LANE_IDLE_MS);
    lane.timer.unref?.();
    return new Promise((resolve, reject) => {
      const { socket, udx } = lane;
      const heard = new Map();            // "ip:port" -> true once a valid punch arrived from there
      let winner = null, settled = false;
      const stream = udx.createStream(lane.streamId);
      stream.on('error', () => {});
      lane.stream = stream;
      const finish = (error, value) => {
        if (settled) return; settled = true;
        clearInterval(pump); clearTimeout(deadline); lane.punching = null;
        if (error) { socket.removeListener('message', onMessage); this.close(id); reject(error); return; }
        // Connected: the lane now lives exactly as long as its stream. The idle timer that
        // protected an unconnected lane must not close a transfer that is still running.
        clearTimeout(lane.timer); lane.timer = null;
        const quiet = setTimeout(() => socket.removeListener('message', onMessage), PUNCH_LINGER_MS);
        quiet.unref?.();
        resolve(value);
      };
      const connectTo = from => {
        if (winner) return; winner = from;
        try { stream.connect(socket, remoteStreamId, from.port, from.host); }
        catch (error) { return finish(error); }
        lane.adapter = new UdxStreamSocket(stream, from.host, () => this.close(id));
        finish(null, lane.adapter);
      };
      const onMessage = (message, from) => {
        if (this.debug && message.length === PUNCH_LENGTH) this.debug(`${Date.now() % 100000} got ${message[PUNCH_MAGIC.length] === PUNCH ? 'punch' : 'ack'} from ${from.host}:${from.port}`);
        if (message.length !== PUNCH_LENGTH || !message.subarray(0, PUNCH_MAGIC.length).equals(PUNCH_MAGIC) || !message.subarray(PUNCH_MAGIC.length + 1).equals(tag)) return;
        const key = from.host + ':' + from.port, kind = message[PUNCH_MAGIC.length];
        if (kind === PUNCH) { heard.set(key, true); try { socket.trySend(packet(ACK), from.port, from.host); } catch {} }
        else if (kind === ACK) connectTo(from);
      };
      socket.on('message', onMessage);
      lane.punching = { stop: () => finish(new Error('UDP lane closed')) };
      const began = Date.now(), hold = Number.isFinite(holdMs) ? Math.max(0, holdMs) : this.holdMs;
      const send = (item, ttl) => { try { ttl ? socket.trySend(packet(PUNCH), item.port, item.ip, ttl) : socket.trySend(packet(PUNCH), item.port, item.ip); } catch {} };
      const burst = () => {
        const holding = !lane.released && Date.now() - began < hold;
        for (const item of candidates) {
          if (!holding || privateLan(item.ip)) send(item);              // a LAN peer sits behind no NAT of ours to protect
          else for (const ttl of this.lowTtls) send(item, ttl);
        }
      };
      const pump = setInterval(() => {
        if (winner) return;
        burst();
        for (const key of heard.keys()) {          // the address the other side really used may differ from its advertised one
          const split = key.lastIndexOf(':');
          try { socket.trySend(packet(PUNCH), Number(key.slice(split + 1)), key.slice(0, split)); } catch {}
        }
      }, PUNCH_INTERVAL_MS);
      const deadline = setTimeout(() => finish(new Error('UDP hole punching timed out')), window);
      burst();
    });
  }

  // Ends the hold: from now on punches go out with a normal TTL.
  release(id) {
    const lane = this.lanes.get(id);
    if (!lane || lane.closed) return false;
    lane.released = true;
    return true;
  }

  close(id) {
    const lane = this.lanes.get(id);
    if (!lane || lane.closed) return false;
    lane.closed = true; this.lanes.delete(id); clearTimeout(lane.timer);
    try { lane.punching?.stop(); } catch {}
    try { lane.adapter?.destroy(); } catch {}
    try { lane.stream?.destroy(); } catch {}
    try { lane.socket.close(); } catch {}
    return true;
  }

  closeAll() { for (const id of [...this.lanes.keys()]) this.close(id); }
}

module.exports = { UdxLanes, UdxStreamSocket, validEndpoint, cleanEndpoints, parseStunResponse, stunRequest, localAddresses, PUNCH_LENGTH };
