'use strict';

const assert = require('assert');
const crypto = require('crypto');
const dgram = require('dgram');
const { UdxLanes, validEndpoint, cleanEndpoints, parseStunResponse, stunRequest, warmStunAddresses, stunAddresses } = require('../udx-lane');
const { DirectFileHost, connect } = require('../direct-file');

const COOKIE = 0x2112a442;

// A minimal STUN server: answers a binding request with the sender's address.
function startStun() {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (message, from) => {
      if (message.length < 20 || message.readUInt16BE(0) !== 1) return;
      const response = Buffer.alloc(32);
      response.writeUInt16BE(0x0101, 0); response.writeUInt16BE(12, 2); response.writeUInt32BE(COOKIE, 4);
      message.copy(response, 8, 8, 20);
      response.writeUInt16BE(0x0020, 20); response.writeUInt16BE(8, 22); response[25] = 1;
      response.writeUInt16BE(from.port ^ (COOKIE >>> 16), 26);
      const cookie = [0x21, 0x12, 0xa4, 0x42], ip = from.address.split('.').map(Number);
      for (let index = 0; index < 4; index++) response[28 + index] = ip[index] ^ cookie[index];
      socket.send(response, from.port, from.address);
    });
    socket.bind(0, '127.0.0.1', () => resolve(socket));
  });
}

function lanes(stunPort, extra = {}) {
  return new UdxLanes({ stunServers: [['127.0.0.1', stunPort]], stunTimeoutMs: 1500, allowLoopback: true, advertiseHosts: ['198.51.100.7'], punchWindowMs: 4000, ...extra });   // a LAN address nothing answers on, so the STUN-reflected loopback endpoint is what really connects
}

const token = () => crypto.randomBytes(24).toString('hex');
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const until = async (predicate, message, timeout = 15000) => {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
};

(async () => {
  // ---- STUN codec
  {
    const request = stunRequest();
    assert.strictEqual(request.length, 20); assert.strictEqual(request.readUInt16BE(0), 1); assert.strictEqual(request.readUInt32BE(4), COOKIE);
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101, 0); response.writeUInt16BE(12, 2); response.writeUInt32BE(COOKIE, 4); request.copy(response, 8, 8, 20);
    response.writeUInt16BE(0x0020, 20); response.writeUInt16BE(8, 22); response[25] = 1;
    response.writeUInt16BE(40001 ^ (COOKIE >>> 16), 26);
    [203, 0, 113, 9].forEach((byte, index) => { response[28 + index] = byte ^ [0x21, 0x12, 0xa4, 0x42][index]; });
    assert.deepStrictEqual(parseStunResponse(response, request.subarray(8, 20)), { ip: '203.0.113.9', port: 40001 });
    assert.strictEqual(parseStunResponse(response, crypto.randomBytes(12)), null, 'a response to another transaction was accepted');
    assert.strictEqual(parseStunResponse(Buffer.alloc(8), request.subarray(8, 20)), null);
    assert.strictEqual(parseStunResponse('nope', request.subarray(8, 20)), null);
    console.log('PASS STUN request and response codec');
  }

  // ---- endpoint validation
  {
    assert.ok(validEndpoint({ ip: '203.0.113.9', port: 40000 }));
    assert.ok(validEndpoint({ ip: '192.168.1.20', port: 51000 }));
    for (const bad of [{ ip: '127.0.0.1', port: 40000 }, { ip: '0.0.0.0', port: 40000 }, { ip: '224.0.0.1', port: 40000 }, { ip: '255.255.255.255', port: 40000 }, { ip: '169.254.1.1', port: 40000 },
      { ip: '10.0.0.1', port: 80 }, { ip: '10.0.0.1', port: 70000 }, { ip: '10.0.0.1', port: 'x' }, { ip: '999.1.1.1', port: 40000 }, { ip: '::1', port: 40000 }, { ip: 'example.com', port: 40000 }, null, {}]) {
      assert.ok(!validEndpoint(bad), 'accepted ' + JSON.stringify(bad));
    }
    assert.ok(validEndpoint({ ip: '127.0.0.1', port: 40000 }, true), 'loopback must be allowed for tests only when asked');
    const many = Array.from({ length: 30 }, (_, index) => ({ ip: '198.51.100.' + (index + 1), port: 40000 + index }));
    assert.strictEqual(cleanEndpoints(many).length, 8, 'too many endpoints were kept');
    assert.strictEqual(cleanEndpoints([{ ip: '198.51.100.1', port: 40000 }, { ip: '198.51.100.1', port: 40000 }]).length, 1, 'duplicates were kept');
    console.log('PASS endpoint validation only allows ordinary unicast IPv4');
  }

  const stun = await startStun();
  const stunPort = stun.address().port;
  const laneA = lanes(stunPort), laneB = lanes(stunPort);
  const hostB = new DirectFileHost(0);
  try {
    // ---- discovery
    const a = await laneA.open(), b = await laneB.open();
    assert.ok(a.endpoints.some(item => item.kind === 'srflx') && a.endpoints.some(item => item.kind === 'host'), 'discovery found no reflexive or host endpoint');
    assert.notStrictEqual(a.streamId, b.streamId);
    console.log('PASS lane discovery finds host and STUN-reflected endpoints');

    // ---- a slow or lost DNS answer never holds a lane up (one lost packet costs the system resolver 5 s; a lane used to wait for it)
    {
      const slowFor = ms => host => new Promise(resolve => setTimeout(() => resolve({ address: '127.0.0.1' }), ms));
      const named = (lookup, extra = {}) => new UdxLanes({ stunServers: [['one.stun.test', stunPort], ['two.stun.test', stunPort]], stunTimeoutMs: 1500, stunDnsWaitMs: 700, allowLoopback: true, advertiseHosts: ['198.51.100.7'], lookup, ...extra });
      stunAddresses.clear();
      let began = Date.now();
      const onlyOneSlow = await named(host => new Promise(resolve => setTimeout(() => resolve({ address: '127.0.0.1' }), host === 'one.stun.test' ? 4000 : 5))).open();
      assert(Date.now() - began < 900, 'one slow name held the lane up ' + (Date.now() - began) + ' ms');
      assert(onlyOneSlow.endpoints.some(item => item.kind === 'srflx'), 'the quick name did not give a reflexive endpoint');
      stunAddresses.clear(); began = Date.now();
      const allSlow = await named(slowFor(2500)).open();
      const took = Date.now() - began;
      assert(took > 600 && took < 1200, 'with every name slow the lane should wait about the DNS cap, waited ' + took + ' ms');
      assert(allSlow.endpoints.every(item => item.kind === 'host'), 'a lane with no STUN answer must still offer its host address');
      await new Promise(resolve => setTimeout(resolve, 2200));           // the slow lookups finish in the background and fill the cache
      began = Date.now();
      const cached = await named(slowFor(2500)).open();
      assert(Date.now() - began < 300 && cached.endpoints.some(item => item.kind === 'srflx'), 'the answers that arrived late were not kept for the next lane');
      stunAddresses.clear(); let tries = 0;
      const flaky = async () => { if (++tries === 1) throw new Error('SERVFAIL'); return { address: '127.0.0.1' }; };
      assert.deepStrictEqual(await warmStunAddresses([['x.stun.test', 1]], { lookup: flaky }), [null], 'a failed lookup must give no address');
      assert.deepStrictEqual(await warmStunAddresses([['x.stun.test', 1]], { lookup: flaky }), ['127.0.0.1'], 'a failed lookup must be tried again, not remembered');
      let calls = 0; const counted = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); return { address: '127.0.0.2' }; };
      stunAddresses.clear();
      await Promise.all([warmStunAddresses([['y.stun.test', 1]], { lookup: counted }), warmStunAddresses([['y.stun.test', 1]], { lookup: counted })]); await warmStunAddresses([['y.stun.test', 1]], { lookup: counted });
      assert.strictEqual(calls, 1, 'one name was looked up ' + calls + ' times');
      let clock = 0; stunAddresses.clear(); await warmStunAddresses([['z.stun.test', 1]], { lookup: counted, now: () => clock }); clock = 31 * 60 * 1000;
      await warmStunAddresses([['z.stun.test', 1]], { lookup: counted, now: () => clock }); assert.strictEqual(calls, 3, 'an old answer was not refreshed');
      stunAddresses.clear();
      console.log('PASS a slow or lost DNS answer never holds a lane up, late answers are kept, failed ones are retried, lookups are shared and refreshed');
    }

    // ---- punch + authenticate + transfer, both directions
    const key = crypto.randomBytes(32), tok = token();
    const received = { b: [], a: [] };
    let peerB = null;
    hostB.register(tok, key, peer => { peerB = peer; peer.onFrame = frame => { received.b.push(Buffer.from(frame)); peer.credit(frame.length); }; });
    const [socketA, socketB] = await Promise.all([
      laneA.establish(a.id, { token: tok, remote: { streamId: b.streamId, endpoints: b.endpoints } }),
      laneB.establish(b.id, { token: tok, remote: { streamId: a.streamId, endpoints: a.endpoints } }),
    ]);
    hostB.acceptStream(socketB);
    const peerA = await connect(null, null, tok, key, { socket: socketA, timeout: 4000 });
    peerA.onFrame = frame => { received.a.push(Buffer.from(frame)); peerA.credit(frame.length); };
    await until(() => peerB, 'the receiving side never produced an authenticated peer');

    const payload = crypto.randomBytes(24 * 1024 * 1024), pieces = [];
    for (let offset = 0; offset < payload.length; offset += 1024 * 1024) pieces.push(payload.subarray(offset, offset + 1024 * 1024));
    const started = Date.now();
    for (const piece of pieces) await peerA.sendAsync(piece);
    await until(() => received.b.reduce((sum, frame) => sum + frame.length, 0) === payload.length, 'the receiver did not get every byte');
    const seconds = (Date.now() - started) / 1000;
    assert.strictEqual(sha(Buffer.concat(received.b)), sha(payload), 'bytes arrived altered or out of order');
    await peerB.sendAsync(Buffer.from('reply over the same lane'));
    await until(() => received.a.length === 1, 'the reverse direction did not deliver');
    assert.strictEqual(received.a[0].toString(), 'reply over the same lane');
    assert.strictEqual(laneA.lanes.get(a.id)?.timer, null, 'a connected lane kept the timer that closes unconnected lanes');
    assert.strictEqual(laneB.lanes.get(b.id)?.timer, null);
    console.log('PASS punch, token handshake and 24 MiB encrypted transfer both ways (' + (24 / seconds).toFixed(0) + ' MiB/s on loopback)');
    peerA.close(); peerB.close();

    // ---- wrong key or wrong token never produces a peer
    for (const label of ['wrong key', 'wrong token']) {
      const x = await laneA.open(), y = await laneB.open();
      const realKey = crypto.randomBytes(32), realToken = token();
      let produced = false;
      const host = new DirectFileHost(0);
      host.register(realToken, realKey, () => { produced = true; });
      const [sa, sb] = await Promise.all([
        laneA.establish(x.id, { token: realToken, remote: { streamId: y.streamId, endpoints: y.endpoints } }),
        laneB.establish(y.id, { token: realToken, remote: { streamId: x.streamId, endpoints: x.endpoints } }),
      ]);
      host.acceptStream(sb);
      await assert.rejects(
        connect(null, null, label === 'wrong token' ? token() : realToken, label === 'wrong key' ? crypto.randomBytes(32) : realKey, { socket: sa, timeout: 1500 }),
        /authentication failed|closed|timed out|reset/,
        label + ' was accepted'
      );
      assert.ok(!produced, label + ' produced an authenticated peer');
      host.close();
    }
    console.log('PASS a wrong key or token never authenticates');

    // ---- garbage from an unauthenticated peer is dropped
    {
      const x = await laneA.open(), y = await laneB.open(), tk = token(), host = new DirectFileHost(0);
      let produced = false; host.register(tk, crypto.randomBytes(32), () => { produced = true; });
      const [sa, sb] = await Promise.all([
        laneA.establish(x.id, { token: tk, remote: { streamId: y.streamId, endpoints: y.endpoints } }),
        laneB.establish(y.id, { token: tk, remote: { streamId: x.streamId, endpoints: x.endpoints } }),
      ]);
      host.acceptStream(sb);
      let closed = false; sb.once('close', () => { closed = true; });
      sa.write(Buffer.from('this is not a handshake\n'));
      await until(() => closed, 'the host kept an unauthenticated stream open');
      assert.ok(!produced); host.close();
      console.log('PASS garbage from an unauthenticated peer is dropped');
    }

    // ---- no peer: punching times out, and the lane is released
    {
      const x = await laneA.open(), tk = token(), before = laneA.lanes.size;
      await assert.rejects(laneA.establish(x.id, { token: tk, timeoutMs: 700, remote: { streamId: 99, endpoints: [{ ip: '127.0.0.1', port: 9 + 40000 }] } }), /timed out/);
      assert.strictEqual(laneA.lanes.size, before - 1, 'a failed lane was not released');
      await assert.rejects(laneA.establish('nope', { token: tk, remote: { streamId: 1, endpoints: [{ ip: '127.0.0.1', port: 40001 }] } }), /unknown/);
      console.log('PASS an unreachable peer times out and releases its socket');
    }

    // ---- limits
    {
      const many = lanes(stunPort), opened = [];
      for (let index = 0; index < 4; index++) opened.push(await many.open());
      await assert.rejects(many.open(), /too many/);
      many.closeAll(); assert.strictEqual(many.lanes.size, 0);
      console.log('PASS the number of open UDP lanes is bounded');
    }
  } finally {
    laneA.closeAll(); laneB.closeAll(); hostB.close(); stun.close();
  }
  console.log('ALL UDX LANE CHECKS PASSED');
  setTimeout(() => process.exit(0), 100);
})().catch(error => { console.error(error); process.exit(1); });
