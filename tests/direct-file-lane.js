const assert = require('assert');
const crypto = require('crypto');
const { DirectFileHost, connect } = require('../direct-file');

async function main() {
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

main().catch(error => { console.error(error); process.exitCode = 1; });
