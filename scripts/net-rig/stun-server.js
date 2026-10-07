// A minimal STUN server for the NAT rig: answers a binding request with the sender's address.
const dgram = require('dgram'); const COOKIE = 0x2112a442;
const s = dgram.createSocket('udp4');
s.on('message', (m, f) => { if (m.length < 20 || m.readUInt16BE(0) !== 1) return;
  const r = Buffer.alloc(32); r.writeUInt16BE(0x0101, 0); r.writeUInt16BE(12, 2); r.writeUInt32BE(COOKIE, 4); m.copy(r, 8, 8, 20);
  r.writeUInt16BE(0x0020, 20); r.writeUInt16BE(8, 22); r[25] = 1; r.writeUInt16BE(f.port ^ (COOKIE >>> 16), 26);
  const ck = [0x21, 0x12, 0xa4, 0x42], ip = f.address.split('.').map(Number); for (let i = 0; i < 4; i++) r[28 + i] = ip[i] ^ ck[i];
  s.send(r, f.port, f.address) });
s.bind(3478, '0.0.0.0');
