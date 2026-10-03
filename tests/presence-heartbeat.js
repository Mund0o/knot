// Presence accuracy: a heartbeating socket that goes silent must be closed and
// published offline; healthy and non-heartbeating (legacy) sockets must not be.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

class Storage {
  constructor() { this.values = new Map(); this.alarm = null; }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = '' } = {}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))); }
  async transaction(callback) { return callback(this); }
  async getAlarm() { return this.alarm; }
  async setAlarm(at) { this.alarm = at; }
}

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'worker', 'index.js'), 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const storage = new Storage(), sockets = [];
  const directory = new module.PairDirectory({ storage, getWebSockets: () => sockets }, {});
  const aId = 'a'.repeat(32), bId = 'b'.repeat(32), cId = 'c'.repeat(32);
  await storage.put(`user:${aId}`, { id: aId, friends: [bId, cId], servers: [], groupDms: [] });
  await storage.put(`user:${bId}`, { id: bId, friends: [aId], servers: [], groupDms: [] });
  await storage.put(`user:${cId}`, { id: cId, friends: [aId], servers: [], groupDms: [] });

  const make = (userId, extra = {}) => {
    const attachment = { authed: true, userId, ...extra }, sent = [];
    const socket = {
      readyState: 1, attachment, sent,
      deserializeAttachment: () => attachment, serializeAttachment: value => Object.assign(attachment, value),
      send: value => sent.push(JSON.parse(value)),
      close() { this.readyState = 3; }
    };
    return socket;
  };
  const watcher = make(aId, { heartbeat: true, lastSeenAt: Date.now() });
  const ghost = make(bId, { heartbeat: true, lastSeenAt: Date.now() - 200000 });
  const legacy = make(cId, { lastSeenAt: Date.now() - 200000 });
  sockets.push(watcher, ghost, legacy);

  // A ping answers with a pong, marks the socket as heartbeating, and arms the sweep.
  const fresh = make(aId); sockets.push(fresh);
  await directory.webSocketMessage(fresh, JSON.stringify({ type: 'ping' }));
  assert(fresh.sent.some(value => value.type === 'pong'), 'ping did not get a pong');
  assert.strictEqual(fresh.attachment.heartbeat, true, 'ping did not mark the socket as heartbeating');
  assert(storage.alarm, 'ping did not arm the idle sweep');
  sockets.splice(sockets.indexOf(fresh), 1);

  await directory.alarm();
  assert.strictEqual(ghost.readyState, 3, 'a silent heartbeating socket was not closed');
  assert.strictEqual(legacy.readyState, 1, 'a legacy client that never pings was closed');
  assert.strictEqual(watcher.readyState, 1, 'a healthy socket was closed');
  const offline = watcher.sent.find(value => value.type === 'presence-update' && value.userId === bId) || watcher.sent.flatMap(value => value.changes || []).find(change => change.kind === 'presence' && change.userId === bId);
  assert(offline && offline.online === false, 'the dead socket was not published offline');
  assert(storage.alarm, 'the sweep did not re-arm while heartbeating sockets remain');

  // Presence still publishes when voice cleanup throws.
  const voice = make(cId, { voiceServerId: 'd'.repeat(32), voiceScope: 'server' });
  sockets.push(voice);
  directory.server = async () => { throw new Error('storage unavailable'); };
  sockets.splice(sockets.indexOf(legacy), 1);
  const before = watcher.sent.length;
  voice.readyState = 3;
  await directory.webSocketClose(voice);
  assert(watcher.sent.length > before, 'a voice cleanup failure suppressed the offline presence broadcast');
  // Client-side guards against stale "online" (source checks; the renderer is a script, not a module).
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert(/const offline=user=>user\?\{\.\.\.user,online:false\}:user;/.test(app), 'a cached roster can resurrect last session\'s online status');
  assert(app.includes('markDirectoryPresenceUnknown();const disconnected'), 'disconnecting leaves friends showing their last-known presence');
  assert(app.includes("socket.send('{\"type\":\"ping\"}')") && app.includes('forceDirectoryReconnect(socket'), 'the directory socket has no heartbeat or half-open recovery');
  assert(app.includes('LAN_NEIGHBOR_FRESH_MS') && app.includes('lanNeighbors.delete(id)'), 'LAN neighbors never expire');
  console.log('PASS presence heartbeat sweep, legacy safety, and close-handler resilience');
})().catch(error => { console.error(error); process.exit(1); });
