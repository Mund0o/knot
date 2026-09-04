// LAN discovery and signaling for Knot. Beacons stay on a link-local
// multicast group; TCP only accepts private IPv4 peers. The renderer still
// authenticates every session with saved friend device keys before SDP moves.
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const crypto = require('crypto');

const PROTOCOL = 1;
const MULTICAST = '239.42.42.87';
const UDP_PORT = 18787;
const MAX_BEACON = 256;
const MAX_FRAME = 48 * 1024;
const MAX_PEERS = 24;
const BEACON_MS = 2000;
const PEER_IDLE_MS = 90000;
const FP = /^[a-f0-9]{32}$/;
const NONCE = /^[a-f0-9]{16,64}$/;

function privateIpv4(value) {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const parts = value.split('.').map(Number);
  if (parts.some(part => part > 255)) return false;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function localIpv4() {
  const found = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets || {})) {
    for (const item of list || []) {
      if (item.internal || item.family !== 'IPv4' && item.family !== 4) continue;
      if (privateIpv4(item.address) && item.address !== '127.0.0.1') found.push(item.address);
    }
  }
  return found;
}

function deviceFingerprint(key) {
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string') return '';
  return crypto.createHash('sha256').update(`${key.x}|${key.y}`, 'utf8').digest('hex').slice(0, 32);
}

function encodeBeacon({ fp, port, nonce }) {
  if (!FP.test(fp) || !Number.isInteger(port) || port < 1024 || port > 65535 || !NONCE.test(nonce)) return null;
  const body = JSON.stringify({ v: PROTOCOL, fp, port, n: nonce });
  if (Buffer.byteLength(body) > MAX_BEACON) return null;
  return Buffer.from(body, 'utf8');
}

function decodeBeacon(buffer, from) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.length > MAX_BEACON) return null;
  if (!privateIpv4(from)) return null;
  let value;
  try { value = JSON.parse(buffer.toString('utf8')); } catch { return null; }
  if (!value || value.v !== PROTOCOL || !FP.test(value.fp) || !NONCE.test(value.n)) return null;
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  return { fp: value.fp, port, nonce: value.n, host: from };
}

function rewriteSdpHostnames(sdp, ip) {
  if (typeof sdp !== 'string' || !sdp || !privateIpv4(ip)) return sdp;
  return sdp.replace(/(\s)([A-Za-z0-9-]+\.local)(\s)/g, `$1${ip}$3`);
}

function readFrame(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const size = buffer.readUInt32BE(0);
  if (size < 1 || size > MAX_FRAME || buffer.length < 4 + size) return null;
  let value;
  try { value = JSON.parse(buffer.subarray(4, 4 + size).toString('utf8')); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.t !== 'string' || value.t.length > 32) return null;
  return { value, rest: buffer.subarray(4 + size) };
}

function packFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_FRAME) throw new Error('LAN frame too large');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

class LanPeer {
  constructor(socket, { id, host, port, localAddress, incoming }) {
    this.id = id;
    this.socket = socket;
    this.host = host;
    this.port = port;
    this.localAddress = localAddress || '';
    this.incoming = !!incoming;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    this.last = Date.now();
    this.onFrame = null;
    this.onClose = null;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15000);
    socket.on('data', chunk => this._data(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }

  _data(chunk) {
    if (!this.alive) return;
    this.last = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    if (this.buffer.length > MAX_FRAME + 4096) { this.close(); return; }
    for (;;) {
      const frame = readFrame(this.buffer);
      if (!frame) break;
      this.buffer = frame.rest;
      try { this.onFrame?.(frame.value); } catch { this.close(); return; }
    }
  }

  send(value) {
    if (!this.alive || this.socket.destroyed) return false;
    try { return this.socket.write(packFrame(value)); }
    catch { this.close(); return false; }
  }

  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this.socket.destroy(); } catch {}
    try { this.onClose?.(); } catch {}
  }
}

class LanHouse {
  constructor(options = {}) {
    this.udpPort = Number.isInteger(options.udpPort) ? options.udpPort : UDP_PORT;
    this.multicast = typeof options.multicast === 'string' ? options.multicast : MULTICAST;
    this.loopback = options.loopback !== false;
    this.udp = null;
    this.server = null;
    this.tcpPort = 0;
    this.beacon = null;
    this.beaconTimer = null;
    this.idleTimer = null;
    this.peers = new Map();
    this.pending = 0;
    this.onBeacon = null;
    this.onPeer = null;
    this.started = false;
  }

  async start() {
    if (this.started) return { port: this.tcpPort, addresses: localIpv4() };
    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise((resolve, reject) => {
      const fail = error => { this.udp.off('error', fail); reject(error); };
      this.udp.once('error', fail);
      this.udp.bind({ port: this.udpPort, address: '0.0.0.0', exclusive: false }, () => {
        this.udp.off('error', fail);
        try {
          this.udpPort = this.udp.address().port;
          try { this.udp.setBroadcast(true); } catch {}
          try { this.udp.setMulticastTTL(1); } catch {}
          try { this.udp.setMulticastLoopback(this.loopback); } catch {}
          for (const address of ['0.0.0.0', ...localIpv4()]) {
            try { this.udp.addMembership(this.multicast, address); } catch {}
          }
        } catch (error) { reject(error); return; }
        resolve();
      });
    });
    this.udp.on('message', (buffer, rinfo) => {
      const beacon = decodeBeacon(buffer, rinfo.address);
      if (beacon) try { this.onBeacon?.(beacon); } catch {}
    });
    this.server = net.createServer(socket => this._accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '0.0.0.0', () => {
        this.server.off('error', reject);
        this.tcpPort = this.server.address().port;
        resolve();
      });
    });
    this.started = true;
    this.beaconTimer = setInterval(() => this._broadcast(), BEACON_MS);
    if (this.beaconTimer.unref) this.beaconTimer.unref();
    this.idleTimer = setInterval(() => this._reap(), 15000);
    if (this.idleTimer.unref) this.idleTimer.unref();
    this._broadcast();
    return { port: this.tcpPort, addresses: localIpv4() };
  }

  setBeacon(fp, nonce) {
    const encoded = encodeBeacon({ fp, port: this.tcpPort, nonce });
    this.beacon = encoded;
    this._broadcast();
    return !!encoded;
  }

  _broadcast() {
    if (!this.started || !this.beacon || !this.udp) return;
    const targets = new Set([this.multicast, '255.255.255.255']);
    for (const address of localIpv4()) {
      const parts = address.split('.');
      if (parts.length === 4) targets.add(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
    }
    for (const target of targets) {
      try { this.udp.send(this.beacon, this.udpPort, target); } catch {}
    }
  }

  _attach(socket, { host, port, incoming }) {
    if (this.peers.size >= MAX_PEERS) { socket.destroy(); return null; }
    const id = crypto.randomBytes(16).toString('hex');
    const localAddress = privateIpv4(socket.localAddress) ? socket.localAddress : '';
    const peer = new LanPeer(socket, { id, host, port, localAddress, incoming });
    this.peers.set(id, peer);
    peer.onClose = () => { if (this.peers.get(id) === peer) this.peers.delete(id); };
    return peer;
  }

  _accept(socket) {
    const host = socket.remoteAddress && socket.remoteAddress.startsWith('::ffff:')
      ? socket.remoteAddress.slice(7)
      : socket.remoteAddress;
    if (!privateIpv4(host)) { socket.destroy(); return; }
    const peer = this._attach(socket, { host, port: socket.remotePort, incoming: true });
    if (peer) try { this.onPeer?.(peer); } catch { peer.close(); }
  }

  connect(host, port) {
    if (!this.started) return Promise.reject(new Error('LAN house is not started'));
    if (!privateIpv4(host) || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return Promise.reject(new Error('LAN peer is not on this network'));
    }
    if (this.peers.size + this.pending >= MAX_PEERS) return Promise.reject(new Error('Too many LAN peers'));
    this.pending++;
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port, family: 4 }, () => {
        socket.setTimeout(0);
        const peer = this._attach(socket, { host, port, incoming: false });
        if (!peer) { reject(new Error('LAN peer limit reached')); return; }
        try { this.onPeer?.(peer); } catch { peer.close(); reject(new Error('LAN peer setup failed')); return; }
        resolve(peer);
      });
      socket.setTimeout(4000, () => { socket.destroy(); reject(new Error('LAN peer did not answer')); });
      socket.on('error', error => reject(error));
    }).finally(() => { this.pending = Math.max(0, this.pending - 1); });
  }

  send(id, value) {
    return this.peers.get(id)?.send(value) === true;
  }

  closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return false;
    peer.close();
    return true;
  }

  _reap() {
    const now = Date.now();
    for (const peer of [...this.peers.values()]) if (now - peer.last > PEER_IDLE_MS) peer.close();
  }

  close() {
    this.started = false;
    clearInterval(this.beaconTimer); this.beaconTimer = null;
    clearInterval(this.idleTimer); this.idleTimer = null;
    for (const peer of [...this.peers.values()]) peer.close();
    this.peers.clear();
    try { this.udp?.dropMembership(this.multicast); } catch {}
    try { this.udp?.close(); } catch {}
    this.udp = null;
    try { this.server?.close(); } catch {}
    this.server = null;
    this.tcpPort = 0;
    this.beacon = null;
  }
}

module.exports = {
  PROTOCOL, MULTICAST, UDP_PORT, MAX_BEACON, MAX_FRAME,
  privateIpv4, localIpv4, deviceFingerprint, encodeBeacon, decodeBeacon,
  rewriteSdpHostnames, packFrame, readFrame, LanHouse, LanPeer,
};
