// usage: node udx-bench.js <send|recv> <localIp> <peerIp> <seconds> <streams>
const UDX = require('udx-native');
const [role, ip, peer, secsArg, streamsArg] = process.argv.slice(2);
const secs = Number(secsArg || 14), n = Number(streamsArg || 1), PORT = 41000, CHUNK = 64 * 1024;
const u = new UDX(); const sock = u.createSocket(); sock.bind(PORT, ip);
const sending = role === 'send', t0 = Date.now(); let total = 0; const perSec = [];
const buf = Buffer.alloc(CHUNK, 7);
for (let i = 0; i < n; i++) {
  const mine = sending ? 100 + i : 200 + i, theirs = sending ? 200 + i : 100 + i;
  const s = u.createStream(mine); s.connect(sock, theirs, PORT, peer);
  s.on('error', () => {});
  if (sending) {
    (function pump() { while (Date.now() - t0 < secs * 1000) { const ok = s.write(buf); if (!ok) return s.once('drain', pump) } s.end() })();
  } else {
    s.on('data', d => { total += d.length; const sec = Math.floor((Date.now() - t0) / 1000); perSec[sec] = (perSec[sec] || 0) + d.length });
  }
}
setTimeout(() => {
  if (!sending) {
    const from = 4, to = secs; let bytes = 0; for (let s = from; s < to; s++) bytes += perSec[s] || 0;
    console.log(JSON.stringify({ proto: 'udx', streams: n, steadyMbit: +(bytes * 8 / (to - from) / 1e6).toFixed(2), totalMiB: +(total / 1048576).toFixed(1) }));
  }
  process.exit(0);
}, (secs + 3) * 1000);
