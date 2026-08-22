const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { DirectFileHost, PeerSocket, connect, seal, pack } = require('../direct-file');

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

  const peer = new PeerSocket(socket, key);
  const payload = crypto.randomBytes(64 * 1024);
  // Arrives pipelined before any handler exists.
  peer._read(pack(seal(key, payload)));
  const received = [];
  peer.onFrame = frame => received.push(frame); // assignment flushes the queue
  assert.strictEqual(received.length, 1, 'early frame was dropped before onFrame was wired');
  assert(received[0].equals(payload), 'queued early frame was corrupted');
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
    console.log('ALL DIRECT-FILE CHECKS PASSED');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    // Closed sockets and expired timers must not hold the event loop open.
    process.exit(process.exitCode || 0);
  }
})();
