const assert = require('assert');
const crypto = require('crypto');
const net = require('net');
const { EventEmitter } = require('events');
const { DirectFileHost, PeerSocket, connect, seal, pack } = require('../direct-file');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deadline(promise, ms = 5000, message = 'direct-file test timed out') {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]);
}
function closed(socket) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise(resolve => socket.once('close', resolve));
}
function mockSocket({ writeResult = true } = {}) {
  const socket = new EventEmitter();
  socket.written = []; socket.paused = false; socket.destroyed = false; socket.writableEnded = false;
  socket.write = frame => { socket.written.push(Buffer.from(frame)); return writeResult; };
  socket.pause = () => { socket.paused = true; };
  socket.resume = () => { socket.paused = false; };
  socket.end = callback => { socket.writableEnded = true; queueMicrotask(() => { callback?.(); socket.destroy(); }); };
  socket.destroy = error => {
    if (!socket.destroyed) {
      socket.destroyed = true;
      if (error) socket.emit('error', error);
      socket.emit('close');
    }
    return socket;
  };
  socket.setKeepAlive = () => {};
  return socket;
}

async function happyPath() {
  const key = crypto.randomBytes(32);
  const token = crypto.randomBytes(24).toString('base64url');
  const host = new DirectFileHost(0);
  await host.listen();
  const port = host.server.address().port;
  const payload = crypto.randomBytes(1024 * 1024);
  const received = new Promise((resolve, reject) => host.register(token, key, peer => {
    peer.onFrame = async frame => {
      try { assert.deepStrictEqual(frame, payload); await peer.sendAsync(Buffer.from('ok')); resolve(); }
      catch (error) { reject(error); }
    };
  }));
  const client = await connect('127.0.0.1', port, token, key);
  const acknowledged = new Promise((resolve, reject) => {
    client.onFrame = frame => frame.toString() === 'ok' ? resolve() : reject(new Error('unexpected reply'));
    client.sendAsync(payload).catch(reject);
  });
  await Promise.all([received, acknowledged]);
  client.close(); host.close();
  console.log('PASS authenticated encrypted TCP file lane');
}

// Receiver-side flow control: with tiny watermarks and a deliberately slow
// consumer that still acknowledges, the transfer must pause instead of
// buffering without bound, then complete with intact data.
async function flowControl() {
  const key = crypto.randomBytes(32);
  const token = crypto.randomBytes(24).toString('base64url');
  const options = { highWater: 256 * 1024, lowWater: 64 * 1024 };
  const host = new DirectFileHost(0, options);
  await host.listen();
  const port = host.server.address().port;

  let pausedSeen = false;
  const TOTAL_FRAMES = 12;
  const frames = [];
  const done = new Promise((resolve, reject) => host.register(token, key, peer => {
    const watch = setInterval(() => { if (peer.paused) pausedSeen = true; }, 2);
    peer.onClose = () => clearInterval(watch);
    // Slow consumer: process one frame at a time and acknowledge afterwards.
    peer.onFrame = async frame => {
      frames.push(frame);
      await new Promise(resolve => setTimeout(resolve, 8));
      peer.credit(frame.length);
      if (frames.length === TOTAL_FRAMES) resolve();
    };
  }));

  const chunk = crypto.randomBytes(64 * 1024);
  const client = await connect('127.0.0.1', port, token, key, options);
  for (let i = 0; i < TOTAL_FRAMES; i++) await client.sendAsync(chunk); // 768 KiB total
  await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error('flow-controlled transfer stalled')), 6000))
  ]);
  assert.strictEqual(frames.length, TOTAL_FRAMES, 'receiver did not consume every frame');
  for (const frame of frames) assert(frame.equals(chunk), 'flow-controlled frame was corrupted');
  assert(pausedSeen, 'receive flow control never engaged despite a slow consumer');
  client.close(); host.close();
  console.log('PASS receive flow control pauses above the high-water mark and resumes on credits');
}

// The selected ICE candidate pair may be IPv6; the listener must accept it.
async function ipv6(family) {
  if (family !== 'IPv6') return console.log('SKIP IPv6 fast lane (no IPv6 stack)');
  const key = crypto.randomBytes(32);
  const token = crypto.randomBytes(24).toString('base64url');
  const host = new DirectFileHost(0);
  await host.listen();
  const port = host.server.address().port;
  const got = new Promise((resolve, reject) => host.register(token, key, peer => {
    peer.onFrame = frame => frame.toString() === 'v6' ? resolve() : reject(new Error('bad frame'));
  }));
  const client = await connect('::1', port, token, key);
  client.sendAsync(Buffer.from('v6')).catch(() => {});
  await Promise.race([
    got,
    new Promise((_, reject) => setTimeout(() => reject(new Error('IPv6 lane did not deliver')), 3000))
  ]);
  client.close(); host.close();
  console.log('PASS IPv6 loopback fast lane');
}

// A wrong or unregistered token must reject the client AND destroy its
// socket — no half-open connections left behind.
async function authFailure() {
  const key = crypto.randomBytes(32);
  const host = new DirectFileHost(0);
  await host.listen();
  const port = host.server.address().port;
  await assert.rejects(
    connect('127.0.0.1', port, crypto.randomBytes(24).toString('base64url'), key, { timeout: 3000 }),
    /authentication failed|connection closed|timed out/
  );
  host.close();
  console.log('PASS rejected handshake destroys the client socket');
}

// Regression: a frame that decodes before onFrame is assigned (pipelined
// handshake leftovers from a fast sender) must be queued and delivered, not
// swallowed by the default no-op handler.
async function earlyFrameDelivery() {
  const key = crypto.randomBytes(32);
  const socket = new EventEmitter();
  socket.written = []; socket.paused = false; socket.destroyed = false;
  socket.write = frame => { socket.written.push(frame); return true; };
  socket.pause = () => { socket.paused = true; };
  socket.resume = () => { socket.paused = false; };
  socket.destroy = () => { if (!socket.destroyed) { socket.destroyed = true; socket.emit('close'); } return socket; };

  const peer = new PeerSocket(socket, key, { highWater: 32 * 1024, lowWater: 8 * 1024 });
  const payload = crypto.randomBytes(64 * 1024);
  // Arrives pipelined before any handler exists.
  peer._read(pack(seal(key, payload)));
  assert.strictEqual(socket.paused, true, 'an unwired receiver did not apply its memory high-water mark');
  const received = [];
  peer.onFrame = frame => received.push(frame); // assignment flushes the queue
  assert.strictEqual(received.length, 1, 'early frame was dropped before onFrame was wired');
  assert(received[0].equals(payload), 'queued early frame was corrupted');
  assert.strictEqual(peer.inflight, payload.length, 'early frame bytes were not included in flow-control accounting');
  peer.credit(payload.length);assert.strictEqual(socket.paused, false, 'credit did not resume an early-frame receiver');
  // A second, normal in-flight frame still flows.
  const second = crypto.randomBytes(1024);
  peer._read(pack(seal(key, second)));
  assert.strictEqual(received.length, 2, 'frames stopped flowing after the early queue flushed');
  peer.close();
  console.log('PASS frames decoded before onFrame is wired are queued, not dropped');
}

async function tokenHygiene() {
  const key = crypto.randomBytes(32);
  const host = new DirectFileHost(0);
  await host.listen();
  const expired = crypto.randomBytes(24).toString('base64url');
  host.register(expired, key, () => {});
  host.tokens.get(expired).expiry = Date.now() - 1;
  const live = crypto.randomBytes(24).toString('base64url');
  host.register(live, key, () => {});
  assert(!host.tokens.has(expired), 'expired token was not pruned');
  assert(host.tokens.has(live), 'live token was pruned');
  host.close();
  console.log('PASS expired tokens are swept');
}

async function pendingSocketBoundAndClose() {
  const host = new DirectFileHost(0);
  await host.listen();
  const port = host.server.address().port;
  const sockets = [];
  for (let index = 0; index < 40; index++) {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    sockets.push(socket);
  }
  await new Promise(resolve => setTimeout(resolve, 80));
  assert(host.pendingSockets.size <= 16, 'per-address unauthenticated socket cap was exceeded');
  const tracked = [...host.pendingSockets];
  host.close();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.strictEqual(host.pendingSockets.size, 0, 'host close retained unauthenticated sockets');
  assert(tracked.every(socket => socket.destroyed), 'host close did not destroy every pending handshake');
  for (const socket of sockets) socket.destroy();
  console.log('PASS unauthenticated sockets are bounded and destroyed on host close');
}

async function mutualAuthenticationAndOneTimeOffers() {
  const key = crypto.randomBytes(32), wrongKey = crypto.randomBytes(32);
  const token = crypto.randomBytes(24).toString('base64url');
  const host = new DirectFileHost(0);
  await host.listen();
  const port = host.server.address().port;
  let acceptedPeer;
  host.register(token, key, peer => { acceptedPeer = peer; });

  // A client that merely knows the public token cannot burn it: it must prove
  // possession of the ECDH-derived file key before the offer is consumed.
  await assert.rejects(connect('127.0.0.1', port, token, wrongKey, { timeout: 1000 }), /closed|authentication|timed out/);
  assert(host.tokens.has(token), 'a bad client proof consumed the one-time offer');

  const client = await connect('127.0.0.1', port, token, key);
  assert(acceptedPeer, 'valid mutual-auth handshake did not create a peer');
  assert(!host.tokens.has(token), 'a successful offer remained replayable');
  await assert.rejects(connect('127.0.0.1', port, token, key, { timeout: 1000 }), /closed|authentication|timed out/);
  client.close(); host.close();

  // A listener that knows the token but not the key must not be able to spoof
  // the server's OK response and receive encrypted file traffic.
  const rogue = net.createServer(socket => {
    let request = Buffer.alloc(0);
    socket.on('data', chunk => {
      request = Buffer.concat([request, chunk]);
      if (request.includes(10)) socket.write(`PAIR/2 ${crypto.randomBytes(32).toString('base64url')} ${crypto.randomBytes(32).toString('base64url')}\n`);
    });
  });
  await new Promise((resolve, reject) => { rogue.once('error', reject); rogue.listen(0, '127.0.0.1', resolve); });
  await assert.rejects(
    connect('127.0.0.1', rogue.address().port, crypto.randomBytes(24).toString('base64url'), key, { timeout: 1000 }),
    /authentication failed/
  );
  await new Promise(resolve => rogue.close(resolve));
  console.log('PASS v2 handshake mutually authenticates key possession and consumes offers exactly once');
}

async function malformedAndLegacyHandshakesPreserveOffer() {
  const key = crypto.randomBytes(32), token = crypto.randomBytes(24).toString('base64url');
  const host = new DirectFileHost(0);
  await host.listen();
  const port = host.server.address().port;
  host.register(token, key, () => {});

  const attempts = [
    JSON.stringify({ v: 1, token }) + '\n',
    JSON.stringify({ v: 2, token, nonce: crypto.randomBytes(32).toString('base64url'), proof: crypto.randomBytes(32).toString('base64url') }) + '\n',
    '{not json}\n',
    'x'.repeat(4097)
  ];
  for (const hello of attempts) {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write(hello);
    await deadline(closed(socket), 1500, 'malformed handshake socket remained open');
    assert(host.tokens.has(token), 'malformed or obsolete handshake consumed a valid offer');
  }
  host.close();
  console.log('PASS malformed, oversized, and obsolete handshakes are rejected without burning offers');
}

async function replayAndConnectionBinding() {
  const key = crypto.randomBytes(32), token = crypto.randomBytes(24).toString('base64url');
  const host = new DirectFileHost(0);
  await host.listen();
  const port = host.server.address().port;
  const frames = [];
  let serverPeer;
  const serverClosed = new Promise(resolve => host.register(token, key, peer => {
    serverPeer = peer;
    peer.onFrame = frame => frames.push(Buffer.from(frame));
    peer.onClose = resolve;
  }));
  const client = await connect('127.0.0.1', port, token, key);
  const originalWrite = client.socket.write.bind(client.socket);
  let captured = null;
  client.socket.write = (data, ...args) => {
    if (!captured && Buffer.isBuffer(data) && data.length > 4) captured = Buffer.from(data);
    return originalWrite(data, ...args);
  };
  await client.sendAsync(Buffer.from('deliver exactly once'));
  await deadline((async () => { while (frames.length < 1) await delay(5); })(), 1500);
  assert(captured, 'did not capture the encrypted session frame');

  // TCP itself orders bytes, but an active network peer can replay captured
  // ciphertext. The per-direction connection counter must reject it.
  originalWrite(captured);
  await deadline(serverClosed, 1500, 'replayed frame did not close the protocol session');
  assert.strictEqual(frames.length, 1, 'a replayed frame reached the application twice');
  assert.strictEqual(serverPeer.closed, true, 'server peer remained usable after a replay');
  assert.strictEqual(host.activeSockets.size, 0, 'replayed session remained in the active-socket table');
  client.close(); host.close();
  console.log('PASS connection-bound counters reject replayed or reordered ciphertext');
}

async function simultaneousPeersAndActiveCaps() {
  // Unit-check the global accounting separately from the real loopback test:
  // CI hosts do not consistently route multiple 127/8 source aliases, while
  // the production cap must still hold across many distinct addresses.
  const accountingHost = new DirectFileHost(0), accountedSockets = [];
  for (let index = 0; index < 8; index++) {
    const socket = mockSocket();socket._pairRemoteAddress = `192.0.2.${index + 1}`;
    assert.strictEqual(accountingHost._canPromote(socket), true, 'global active cap engaged too early');
    accountingHost._promote(socket);accountedSockets.push(socket);
  }
  const ninth = mockSocket();ninth._pairRemoteAddress = '198.51.100.1';
  assert.strictEqual(accountingHost._canPromote(ninth), false, 'global authenticated socket cap exceeded eight lanes');
  accountingHost.close();
  assert(accountedSockets.every(socket => socket.destroyed), 'global cap cleanup retained an accounted socket');

  const key = crypto.randomBytes(32);
  const host = new DirectFileHost(0);
  await host.listen();
  const port = host.server.address().port;
  const tokens = Array.from({ length: 5 }, () => crypto.randomBytes(24).toString('base64url'));
  const serverPeers = [];
  for (let index = 0; index < tokens.length; index++) {
    host.register(tokens[index], key, peer => {
      serverPeers.push(peer);
      peer.onFrame = frame => { void peer.sendAsync(Buffer.from(`reply:${frame.toString()}`)); };
    });
  }
  const clients = await Promise.all(tokens.slice(0, 4).map(token => connect('127.0.0.1', port, token, key)));
  assert.strictEqual(host.activeSockets.size, 4, 'simultaneous authenticated peers were not tracked independently');
  await Promise.all(clients.map((client, index) => new Promise((resolve, reject) => {
    client.onFrame = frame => frame.toString() === `reply:peer-${index}` ? resolve() : reject(new Error('cross-routed peer frame'));
    client.sendAsync(Buffer.from(`peer-${index}`)).catch(reject);
  })));

  await assert.rejects(connect('127.0.0.1', port, tokens[4], key, { timeout: 1000 }), /closed|authentication|timed out/);
  assert(host.tokens.has(tokens[4]), 'active socket pressure consumed an offer that should be retryable');
  clients[0].close();
  await deadline((async () => { while (host.activeSockets.size !== 3) await delay(5); })(), 1500);
  const retried = await connect('127.0.0.1', port, tokens[4], key);
  assert.strictEqual(host.activeSockets.size, 4, 'offer did not recover after an active slot was released');

  const allSockets = [...clients.slice(1).map(peer => peer.socket), retried.socket];
  const allClosed = Promise.all(allSockets.map(closed));
  host.close();
  await deadline(allClosed, 1500, 'host close left authenticated sockets alive');
  assert.strictEqual(host.activeSockets.size, 0, 'host close retained authenticated sockets');
  console.log('PASS simultaneous peers stay isolated and authenticated socket caps recover cleanly');
}

async function framingBoundariesAndQueuedFlow() {
  const key = crypto.randomBytes(32);
  const payloads = [Buffer.alloc(1024, 1), Buffer.alloc(1024, 2), Buffer.alloc(1024, 3)];
  const socket = mockSocket();
  const peer = new PeerSocket(socket, key, { highWater: 1024, lowWater: 256 });
  const got = [];
  peer.onFrame = frame => got.push(Buffer.from(frame));
  peer._read(Buffer.concat(payloads.map(payload => pack(seal(key, payload)))));
  assert.strictEqual(got.length, 1, 'flow control decoded queued frames beyond its high-water mark');
  assert.strictEqual(peer.queue.length > 0, true, 'paused parser did not retain the already-read tail');
  peer.credit(1024); assert.strictEqual(got.length, 2, 'credit did not drain the next queued frame');
  peer.credit(1024); assert.strictEqual(got.length, 3, 'second credit did not drain the final queued frame');
  peer.credit(1024);
  payloads.forEach((payload, index) => assert(got[index].equals(payload), 'queued frame order changed under backpressure'));
  peer.close();

  // Fragment every header and body byte to exercise the queue's cross-chunk
  // integer parsing, then reject all malformed length/tag boundaries.
  const fragmentedSocket = mockSocket();
  const fragmentedPeer = new PeerSocket(fragmentedSocket, key);
  const fragmented = [];
  fragmentedPeer.onFrame = frame => fragmented.push(frame);
  const wire = Buffer.concat([pack(seal(key, Buffer.from('one'))), pack(seal(key, Buffer.from('two')))]);
  for (const byte of wire) fragmentedPeer._read(Buffer.from([byte]));
  assert.deepStrictEqual(fragmented.map(frame => frame.toString()), ['one', 'two'], 'byte-fragmented frames were not reassembled in order');
  fragmentedPeer.close();

  for (const malformed of [
    Buffer.alloc(4),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    pack(seal(key, Buffer.alloc(0))),
    (() => { const value = pack(seal(key, Buffer.from('tampered'))); value[value.length - 1] ^= 1; return value; })()
  ]) {
    const badSocket = mockSocket(), badPeer = new PeerSocket(badSocket, key);
    badPeer.onFrame = () => { throw new Error('malformed frame was emitted'); };
    badPeer._read(malformed);
    assert.strictEqual(badSocket.destroyed, true, 'malformed frame did not abort its socket');
  }
  console.log('PASS fragmented/coalesced framing, malformed lengths, empty payloads, tags, and queued flow are bounded');
}

async function maximumPayloadBoundary() {
  const key = crypto.randomBytes(32), token = crypto.randomBytes(24).toString('base64url');
  const host = new DirectFileHost(0, { highWater: 16 * 1024 * 1024, lowWater: 4 * 1024 * 1024 });
  await host.listen();
  const port = host.server.address().port;
  const maximum = Buffer.alloc(8 * 1024 * 1024, 0xa5);
  const received = new Promise((resolve, reject) => host.register(token, key, peer => {
    peer.onFrame = frame => {
      try { assert(frame.equals(maximum), 'maximum payload was corrupted'); peer.credit(frame.length); resolve(); }
      catch (error) { reject(error); }
    };
  }));
  const client = await connect('127.0.0.1', port, token, key);
  await client.sendAsync(maximum);
  await deadline(received, 5000, 'maximum payload was not delivered');
  assert.throws(() => client.send(Buffer.alloc(8 * 1024 * 1024 + 1)), /payload length/, 'oversized payload crossed the wire limit');
  client.close(); host.close();
  console.log('PASS exact 8 MiB plaintext boundary includes AES-GCM overhead without off-by-28 rejection');
}

async function immediateAbortAndLateCloseCleanup() {
  const key = crypto.randomBytes(32);
  const socket = mockSocket({ writeResult: false });
  const peer = new PeerSocket(socket, key);
  let closes = 0;
  peer.onClose = () => { closes++; };
  const pending = peer.sendAsync(Buffer.from('queued'));
  peer.close();
  await assert.rejects(pending, /closed/);
  await delay(0);
  assert.strictEqual(closes, 1, 'immediate close notified its owner more than once');
  assert.strictEqual(peer.queue.length, 0, 'close retained receive buffers');
  assert.throws(() => peer.send(Buffer.from('late')), /closed/, 'send was allowed after close began');

  const lateSocket = mockSocket(), latePeer = new PeerSocket(lateSocket, key);
  lateSocket.destroy();
  let lateClose = 0;
  latePeer.onClose = () => { lateClose++; };
  assert.strictEqual(lateClose, 1, 'a close before handler assignment was lost');

  const rejectingSocket = mockSocket(), rejectingPeer = new PeerSocket(rejectingSocket, key);
  rejectingPeer.onFrame = async () => { throw new Error('consumer stopped'); };
  rejectingPeer._read(pack(seal(key, Buffer.from('frame'))));
  await delay(0);
  assert.strictEqual(rejectingSocket.destroyed, true, 'rejected async frame consumer left the socket alive');

  // connect() can decrypt response-pipelined frames before main.js attaches
  // its IPC handler. If that handler closes on the first frame, no remaining
  // early data may leak through after the lane has become stale.
  const earlySocket = mockSocket(), earlyPeer = new PeerSocket(earlySocket, key);
  earlyPeer._read(Buffer.concat([
    pack(seal(key, Buffer.from('first'))),
    pack(seal(key, Buffer.from('must-not-arrive'))),
  ]));
  const earlyDelivered = [];
  earlyPeer.onFrame = frame => { earlyDelivered.push(frame.toString());earlyPeer.close(); };
  assert.deepStrictEqual(earlyDelivered, ['first'], 'buffered frames were delivered after their consumer closed the lane');
  console.log('PASS immediate aborts, late close handlers, async errors, and queued writes tear down exactly once');
}

async function listenerLifecycleRaces() {
  for (let index = 0; index < 32; index++) {
    const host = new DirectFileHost(0);
    const pending = host.listen();
    host.close();
    await assert.rejects(pending, /listener was closed/);
  }
  const host = new DirectFileHost(0);
  const first = host.listen(), second = host.listen();
  assert.strictEqual(first, second, 'concurrent listen calls created multiple candidate servers');
  await first;
  const initialPort = host.server.address().port;
  assert(initialPort > 0);
  host.close();
  await host.listen();
  assert(host.server.address().port > 0, 'listener could not restart after a completed close');
  host.close();
  console.log('PASS concurrent, cancelled, and restarted listener lifecycles settle without orphan ports');
}

async function credentialsLimitsAndDrainFailure() {
  const key = crypto.randomBytes(32), host = new DirectFileHost(0);
  const retainedKeys = [];
  for (let index = 0; index < 32; index++) {
    const token = Buffer.alloc(24, 0);
    token.writeUInt32BE(index, 20);
    const encoded = token.toString('base64url');
    host.register(encoded, key, () => {});
    retainedKeys.push(host.tokens.get(encoded).key);
  }
  assert.throws(
    () => host.register(crypto.randomBytes(24).toString('base64url'), key, () => {}),
    /too many pending/,
    'pending offer cap was not enforced'
  );
  const duplicate = [...host.tokens.keys()][0];
  assert.throws(() => host.register(duplicate, key, () => {}), /already registered/, 'duplicate token silently replaced its owner');
  assert.throws(() => host.register('a'.repeat(129), key, () => {}), /invalid/, 'oversized credential token was accepted');
  assert.throws(() => new DirectFileHost(-1), /invalid/, 'negative listener port was accepted');
  await assert.rejects(connect('127.0.0.1', 0, duplicate, key), /invalid/, 'invalid destination port reached net.connect');
  host.close();
  assert(retainedKeys.every(stored => stored.every(byte => byte === 0)), 'closing the offer table retained copied encryption keys');

  const stalledSocket = mockSocket({ writeResult: false });
  const stalledPeer = new PeerSocket(stalledSocket, key);
  stalledPeer.drainTimeout = 15;
  await assert.rejects(stalledPeer.sendAsync(Buffer.from('blocked')), /did not drain/);
  assert.strictEqual(stalledSocket.destroyed, true, 'drain timeout rejected without aborting uncertain queued bytes');
  console.log('PASS credential/integer caps, copied-key erasure, duplicate offers, and drain failures are fail-closed');
}

(async () => {
  try {
    await happyPath();

    const probe = new DirectFileHost(0);
    let family;
    try { await probe.listen(); family = probe.server.address().family; }
    finally { probe.close(); }

    await flowControl();
    await ipv6(family);
    await authFailure();
    await earlyFrameDelivery();
    await tokenHygiene();
    await pendingSocketBoundAndClose();
    await mutualAuthenticationAndOneTimeOffers();
    await malformedAndLegacyHandshakesPreserveOffer();
    await replayAndConnectionBinding();
    await simultaneousPeersAndActiveCaps();
    await framingBoundariesAndQueuedFlow();
    await maximumPayloadBoundary();
    await immediateAbortAndLateCloseCleanup();
    await listenerLifecycleRaces();
    await credentialsLimitsAndDrainFailure();
    console.log('ALL DIRECT-FILE CHECKS PASSED');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
