const fs = require('fs');
const path = require('path');
const assert = require('assert');

class Storage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = '' } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))); }
}

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'worker', 'index.js'), 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const storage = new Storage(), sockets = [];
  const state = { storage, getWebSockets: () => sockets };
  const directory = new module.PairDirectory(state, {});
  const senderId = 'a'.repeat(32), recipientId = 'b'.repeat(32), messageId = 'c'.repeat(32);
  const sender = { id: senderId, friends: [recipientId], servers: [] };
  const recipient = { id: recipientId, friends: [senderId], servers: [] };
  await storage.put(`user:${senderId}`, sender);await storage.put(`user:${recipientId}`, recipient);
  await directory.relayText(sender, { scope: 'dm', peerId: recipientId, id: messageId, cipher: { iv: 'A'.repeat(16), data: 'B'.repeat(32) } });
  assert.strictEqual((await storage.list({ prefix: `mail:${recipientId}:` })).size, 1, 'offline ciphertext was not queued');
  const delivered = [], socket = { readyState: 1, deserializeAttachment: () => ({ authed: true, userId: recipientId }), send: value => delivered.push(JSON.parse(value)) };
  sockets.push(socket);await directory.deliverMailbox(recipientId);
  assert(delivered.some(value => value.type === 'relay-text' && value.id === messageId && value.offline), 'queued ciphertext was not delivered after reconnect');
  await directory.ackRelayText(recipient, { id: messageId });
  assert.strictEqual((await storage.list({ prefix: `mail:${recipientId}:` })).size, 0, 'acknowledged ciphertext was not deleted');
  console.log('PASS encrypted offline DM mailbox delivery and acknowledgement');
})().catch(error => { console.error(error);process.exitCode = 1; });
