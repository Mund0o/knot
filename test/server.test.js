const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');
const { validateSignalPayload } = require('../pair-helpers');

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), 5000);
    ws.once('open', () => { clearTimeout(t); resolve(); });
    ws.once('error', err => { clearTimeout(t); reject(err); });
  });
}

function onceMessage(ws) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws message timeout')), 5000);
    ws.once('message', data => {
      clearTimeout(t);
      try { resolve(JSON.parse(String(data))); } catch (e) { reject(e); }
    });
  });
}

test('validRoom and signal validation stay strict', () => {
  // Mirror server.js room rules without starting a listener.
  const validRoom = value => {
    const parts = String(value).split(':');
    const [base, suffix] = parts;
    return parts.length <= 2 && /^[A-Z0-9_-]{16,64}$/.test(base) && (suffix === undefined || suffix.toLowerCase() === 'stream');
  };
  assert.equal(validRoom('ABCDEFGHIJKLMNOP'), true);
  assert.equal(validRoom('short'), false);
  assert.equal(validRoom('ABCDEFGHIJKLMNOP:stream'), true);
  assert.equal(validateSignalPayload({ kind: 'offer', sdp: 'x'.repeat(300000) }), null);
});

test('signaling room capacity, peer-left, and signal allowlist', async () => {
  const port = 18787 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), PAIR_BIND: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error('server start timeout')), 8000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('listening')) {
        clearTimeout(fail);
        resolve();
      }
    });
    child.stderr.on('data', () => {});
    child.on('exit', code => reject(new Error('server exited early ' + code)));
  });

  try {
    const room = 'TESTROOMABCDEFGHIJ';
    const a = new WebSocket(`ws://127.0.0.1:${port}`);
    const b = new WebSocket(`ws://127.0.0.1:${port}`);
    await Promise.all([waitOpen(a), waitOpen(b)]);

    a.send(JSON.stringify({ type: 'join', room }));
    assert.equal((await onceMessage(a)).type, 'joined');
    b.send(JSON.stringify({ type: 'join', room }));
    const msgs = [];
    msgs.push(await onceMessage(b));
    msgs.push(await onceMessage(a));
    msgs.push(await onceMessage(b));
    assert.ok(msgs.some(m => m.type === 'peer-ready'));

    const leftWait = onceMessage(a);
    b.close();
    const left = await leftWait;
    assert.equal(left.type, 'peer-left');

    const c = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(c);
    const aAfterJoin = onceMessage(a);
    c.send(JSON.stringify({ type: 'join', room }));
    assert.equal((await onceMessage(c)).type, 'joined');
    // Both peers receive peer-ready when the second client joins again.
    assert.equal((await aAfterJoin).type, 'peer-ready');
    assert.equal((await onceMessage(c)).type, 'peer-ready');

    a.send(JSON.stringify({ type: 'signal', payload: { kind: 'nope', sdp: 'x' } }));
    a.send(JSON.stringify({ type: 'signal', payload: { kind: 'reneg-offer', sdp: 'v=0' } }));
    const relayed = await onceMessage(c);
    assert.equal(relayed.type, 'signal');
    assert.equal(relayed.payload.kind, 'reneg-offer');

    a.close();
    c.close();
  } finally {
    child.kill('SIGTERM');
  }
});
