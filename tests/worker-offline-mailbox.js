const fs = require('fs');
const path = require('path');
const assert = require('assert');

class Storage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = '' } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))); }
  async transaction(callback) { return callback(this); }
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
  const accountMessages = [], accountSocket = { readyState: 1, send: value => accountMessages.push(JSON.parse(value)) };
  await directory.createAccount(accountSocket, sender, { username: 'mundo_test', password: 'correct horse battery staple' });
  assert.strictEqual((await storage.get('account:mundo_test')).userId, senderId, 'account did not retain the existing friend identity');
  assert(!(await storage.get('account:mundo_test')).password, 'account stored a plaintext password');
  const duplicate = { id: 'd'.repeat(32), friends: [], servers: [] };await storage.put(`user:${duplicate.id}`, duplicate);
  await assert.rejects(() => directory.createAccount(accountSocket, duplicate, { username: 'MUNDO_TEST', password: 'another correct password' }), /already taken/, 'case-insensitive duplicate username was accepted');
  assert.strictEqual((await storage.get('account:mundo_test')).userId, senderId, 'duplicate signup replaced the original username owner');
  const loginMessages = [], attachment = {}, loginSocket = { readyState: 1, send: value => loginMessages.push(JSON.parse(value)), serializeAttachment: value => Object.assign(attachment, value), close: () => {} };
  await directory.loginAccount(loginSocket, attachment, { username: 'mundo_test', password: 'correct horse battery staple' });
  const session = loginMessages.find(value => value.type === 'account-session');
  assert(session && session.userId === senderId && /^[a-f0-9]{64}$/.test(session.token), 'account login did not recover the original identity');
  assert.strictEqual(attachment.authed, true, 'account login socket was not authenticated');
  console.log('PASS encrypted offline mailbox and recoverable salted-password accounts');
})().catch(error => { console.error(error);process.exitCode = 1; });
