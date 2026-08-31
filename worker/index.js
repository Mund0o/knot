const MAX_ROOM_PEERS = 2;
const MAX_SIGNAL_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 768 * 1024;
const MAX_PEER_SDP_BYTES = 512 * 1024;
const MAX_DIRECTORY_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_SOCKET_BYTES_PER_SECOND = 4 * 1024 * 1024;
const MAX_SOCKET_MESSAGES_PER_SECOND = 240;
const INVITE_TTL_MS = 15 * 60 * 1000;
const MAX_RELAY_CIPHERTEXT_BYTES = 96 * 1024;
const DM_MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DM_MAILBOX_MAX_MESSAGES = 256;
const DM_MAILBOX_MAX_BYTES = 8 * 1024 * 1024;
const ACCOUNT_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const MAX_USER_SOCKETS = 8;
const LOGIN_GLOBAL_LIMIT_PER_MINUTE = 4096;
const LOGIN_SHARD_LIMIT_PER_MINUTE = 120;
const SIGNUP_GLOBAL_LIMIT_PER_HOUR = 512;
const SIGNUP_SHARD_LIMIT_PER_HOUR = 30;
const MAX_FRIENDS = 500;
const MAX_SERVERS = 100;
const MAX_SERVER_MEMBERS = 500;
const MAX_GROUP_DMS = 100;
const MAX_GROUP_DM_MEMBERS = 10;
const MAX_VOICE_CHANNEL_MEMBERS = 16;
const INVITE_REDEEM_WINDOW_MS = 60 * 1000;
const INVITE_REDEEM_MAX_ATTEMPTS = 12;
const INVITE_CREATE_WINDOW_MS = 60 * 1000;
const INVITE_CREATE_MAX_PER_USER = 20;
const INVITE_GLOBAL_LIMIT_PER_MINUTE = 2048;
const INVITE_SHARD_LIMIT_PER_MINUTE = 120;
const MAX_SNAPSHOT_MEMBER_PROFILES = 4096;
const STORAGE_READ_BATCH_SIZE = 32;
const GROUP_KEY_REQUEST_TTL_MS = 2 * 60 * 1000;

function normalizeRoom(value) {
  const room = String(value || '').trim().toUpperCase();
  return /^(?:\d{5}|[A-Z0-9_-]{16,64})$/.test(room) ? room : '';
}

function normalizeId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(id) ? id : '';
}

function normalizeToken(value) {
  const token = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}

function cleanText(value, max, fallback = '') {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, max) : fallback;
}

function cleanImage(value) {
  const image = String(value || '');
  return image.length <= 512 * 1024 && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(image) ? image : '';
}

function cleanFrame(value) {
  const number = (input, fallback, min, max) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  };
  return { zoom: number(value?.zoom, 100, 40, 180), x: number(value?.x, 50, 0, 100), y: number(value?.y, 50, 0, 100) };
}

// Account recovery data is private to the password-authenticated login flow.
// Public user snapshots continue to expose only user.name/image/frame, so a
// hidden profile photo can be recoverable without being shown to friends.
function cleanAccountProfile(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    name: cleanText(value.name, 32, cleanText(fallback.name, 32, 'Knot user')),
    image: Object.prototype.hasOwnProperty.call(value, 'image') ? cleanImage(value.image) : cleanImage(fallback.image),
    frame: Object.prototype.hasOwnProperty.call(value, 'frame') ? cleanFrame(value.frame) : cleanFrame(fallback.frame),
  };
}

function accountProfileFromUser(user) {
  return { name: cleanText(user?.name, 32, 'Knot user'), image: cleanImage(user?.image), frame: cleanFrame(user?.frame) };
}

// When the photo is public, the client references the already-present public
// image instead of sending the same ~480 KiB data URL twice in one WebSocket
// message. When it is hidden, the private account copy travels here directly.
function accountProfileFromWire(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = { ...value };
  if (candidate.imageFromPublic === true) candidate.image = cleanImage(fallback.image);
  delete candidate.imageFromPublic;
  return cleanAccountProfile(candidate, fallback);
}

// A public ECDH P-256 key is identity metadata, not a secret. Private device
// keys and all message/group keys stay in the desktop app. Keeping this narrow
// also stops the directory from becoming a general key-value store.
function cleanDeviceKey(value) {
  if (!value || typeof value !== 'object') return null;
  const key = { kty: value.kty, crv: value.crv, x: value.x, y: value.y };
  return key.kty === 'EC' && key.crv === 'P-256'
    && typeof key.x === 'string' && /^[A-Za-z0-9_-]{40,80}$/.test(key.x)
    && typeof key.y === 'string' && /^[A-Za-z0-9_-]{40,80}$/.test(key.y) ? key : null;
}

function cleanCiphertext(value) {
  if (!value || typeof value !== 'object') return null;
  const iv = String(value.iv || ''), data = String(value.data || '');
  if (!/^[A-Za-z0-9_.-]{16,32}$/.test(iv) || !/^[A-Za-z0-9_.-]+$/.test(data) || data.length > MAX_RELAY_CIPHERTEXT_BYTES) return null;
  return { iv, data };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{2,23}$/.test(username) ? username : '';
}

function cleanVerifier(value) {
  const verifier = typeof value === 'string' ? value : '';
  return /^[A-Za-z0-9_.-]{43}$/.test(verifier) ? verifier : '';
}

function cleanPasswordSalt(value) {
  const salt = typeof value === 'string' ? value : '';
  return /^[A-Za-z0-9_.-]{22,64}$/.test(salt) ? salt : '';
}

function secureEqual(left, right) {
  const a = String(left || ''), b = String(right || ''); let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
}

function randomHex(bytes = 16) {
  const value = new Uint8Array(bytes); crypto.getRandomValues(value);
  return [...value].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes) {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);
      return jsonResponse({ service: 'Knot control plane', status: 'ready', transport: 'websocket', encryptedDmMailbox: true });
    }
    if (url.pathname === '/directory') {
      const id = env.PAIR_DIRECTORY.idFromName('pair-directory-v1');
      return env.PAIR_DIRECTORY.get(id).fetch(request);
    }
    const room = normalizeRoom(url.searchParams.get('room'));
    if (!room) return jsonResponse({ error: 'invalid invite code' }, 400);
    const id = env.PAIR_ROOMS.idFromName(room);
    const headers = new Headers(request.headers); headers.set('x-pair-room', room);
    return env.PAIR_ROOMS.get(id).fetch(new Request(request, { headers }));
  }
};

export class PairRoom {
  constructor(state) { this.state = state; }

  fetch(request) {
    const room = normalizeRoom(request.headers.get('x-pair-room'));
    if (!room || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return jsonResponse({ error: 'websocket upgrade required' }, 426);
    const live = this.state.getWebSockets().filter(socket => socket.readyState === 1);
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    server.serializeAttachment({ room, joined: false, rateAt: Date.now(), rateBytes: 0 });
    this.state.acceptWebSocket(server);
    if (live.length >= MAX_ROOM_PEERS) server.send(JSON.stringify({ type: 'full' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment() || {};
    // Signaling is deliberately text-only. Knot content must never traverse the Worker.
    if (typeof message !== 'string') return socket.close(1003, 'binary content relay disabled');
    const bytes = new TextEncoder().encode(message).byteLength;
    if (!this.withinRate(socket, attachment, bytes)) return;
    if (bytes > MAX_SIGNAL_BYTES) return socket.close(1009, 'message too large');
    let value; try { value = JSON.parse(message); } catch { return; }
    if (value?.type === 'join') {
      const requestedRoom = normalizeRoom(value.room);
      if (!requestedRoom || requestedRoom !== attachment.room) return socket.close(1008, 'room mismatch');
      if (attachment.joined) return;
      const joined = this.joinedSockets(attachment.room);
      if (joined.length >= MAX_ROOM_PEERS) { socket.send(JSON.stringify({ type: 'full' })); return socket.close(1008, 'room full'); }
      attachment.joined = true; socket.serializeAttachment(attachment);
      const ready = this.joinedSockets(attachment.room);
      socket.send(JSON.stringify({ type: 'joined', count: ready.length }));
      if (ready.length === MAX_ROOM_PEERS) for (const peer of ready) this.safeSend(peer, JSON.stringify({ type: 'peer-ready' }));
      return;
    }
    if (attachment.joined && value?.type === 'signal') this.broadcast(socket, message, attachment.room);
  }

  webSocketClose() {}
  webSocketError() {}
  joinedSockets(room) { return this.state.getWebSockets().filter(socket => { const a = socket.deserializeAttachment() || {}; return socket.readyState === 1 && a.joined && a.room === room; }); }
  broadcast(sender, message, room) { for (const socket of this.joinedSockets(room)) if (socket !== sender) this.safeSend(socket, message); }
  safeSend(socket, message) { try { socket.send(message); } catch {} }
  withinRate(socket, attachment, bytes) { const now = Date.now(); if (!attachment.rateAt || now - attachment.rateAt >= 1000) { attachment.rateAt = now; attachment.rateBytes = 0;attachment.rateMessages = 0; } attachment.rateBytes = (attachment.rateBytes || 0) + bytes;attachment.rateMessages = (attachment.rateMessages || 0) + 1; socket.serializeAttachment(attachment); if (attachment.rateBytes <= MAX_SOCKET_BYTES_PER_SECOND && attachment.rateMessages <= MAX_SOCKET_MESSAGES_PER_SECOND) return true; socket.close(1008, 'rate limit'); return false; }
}

export class PairDirectory {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return jsonResponse({ error: 'websocket upgrade required' }, 426);
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    // Keep abuse budgets source-scoped without retaining a raw network address.
    // Cloudflare supplies this header; a random key is adequate for local dev.
    const address = request.headers.get('cf-connecting-ip') || '', securityKey = address ? await tokenHash(`knot-client-v1|${address}`) : randomHex(32);
    server.serializeAttachment({ authed: false, userId: '', rateAt: Date.now(), rateBytes: 0, securityKey });
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment() || {};
    if (typeof message !== 'string') return socket.close(1003, 'control messages must be text');
    const bytes = new TextEncoder().encode(message).byteLength;
    if (bytes > MAX_DIRECTORY_BYTES || !this.withinRate(socket, attachment, bytes)) return;
    let value; try { value = JSON.parse(message); } catch { return; }
    if (!attachment.authed) return this.authenticate(socket, attachment, value);
    const user = await this.user(attachment.userId);
    if (!user) return socket.close(1008, 'account missing');
    try {
      if (value.type === 'create-account') {
        await this.createAccount(socket, user, value, attachment);await this.broadcastProfile(user.id);
      } else if (value.type === 'remove-friend') {
        const peerId = normalizeId(value.peerId); if (!peerId) throw new Error('friend is missing');
        await this.state.storage.transaction(async transaction => {
          const actor = await transaction.get(`user:${user.id}`), friend = await transaction.get(`user:${peerId}`);
          if (!actor || !friend || !(actor.friends || []).includes(peerId)) throw new Error('friend is missing');
          actor.friends = actor.friends.filter(id => id !== peerId); friend.friends = (friend.friends || []).filter(id => id !== actor.id);
          await transaction.put(`user:${actor.id}`, this.normalizedUser(actor));
          await transaction.put(`user:${friend.id}`, this.normalizedUser(friend));
        });
        await this.broadcastSnapshots([user.id,peerId]);
      } else if (value.type === 'create-group-dm') {
        const migrationPeer = normalizeId(value.migrateCallPeerId);
        if (migrationPeer && !this.directCallPairActive(attachment, user.id, migrationPeer)) throw new Error('the direct call is no longer active');
        const group = await this.createGroupDm(user, { ...value, migrateCallPeerId: migrationPeer });
        this.safeSend(socket, JSON.stringify({ type: 'group-dm-created', groupId: group.id }));
        await this.broadcastSnapshots(group.members);
      } else if (value.type === 'add-group-member') {
        const group=await this.addGroupMembers(user, value); await this.broadcastSnapshots(group.members);
      } else if (value.type === 'update-group-dm') {
        const group=await this.updateGroupDm(user, value); await this.broadcastSnapshots(group.members);
      } else if (value.type === 'remove-group-member') {
        const audience=await this.removeGroupMember(user, value); await this.broadcastSnapshots(audience);
      } else if (value.type === 'leave-group-dm') {
        const audience=await this.leaveGroupDm(user, value); await this.broadcastSnapshots(audience);
      } else if (value.type === 'call-presence') {
        const peerId = normalizeId(value.peerId); if (!peerId || !user.friends.includes(peerId)) throw new Error('call recipient is not a friend');
        const active = !!value.active, session = cleanText(value.session, 32, '');
        if (active) { attachment.dmCallActive = true; attachment.dmCallPeerId = peerId; attachment.dmCallSession = session; }
        else if (attachment.dmCallPeerId === peerId) { delete attachment.dmCallActive; delete attachment.dmCallPeerId; delete attachment.dmCallSession; }
        socket.serializeAttachment(attachment);
        this.sendUser(peerId, { type: 'call-presence', from: user.id, active, session, at: Date.now() });
      } else if (value.type === 'update-profile') {
        let updatedUser;
        await this.state.storage.transaction(async transaction => {
          const actor = await transaction.get(`user:${user.id}`);if (!actor) throw new Error('account missing');
          actor.name = cleanText(value.name, 32, actor.name || 'Knot user');
          actor.image = cleanImage(value.image);
          actor.frame = cleanFrame(value.frame);
          actor.deviceKey = cleanDeviceKey(value.deviceKey) || actor.deviceKey || null;
          if (actor.username) {
            const account = await transaction.get(`account:${actor.username}`);
            if (account?.userId === actor.id) {
              const existing = cleanAccountProfile(account.profile, accountProfileFromUser(actor)) || accountProfileFromUser(actor);
              account.profile = accountProfileFromWire(value.accountProfile, { ...existing, name: actor.name, image: actor.image, frame: actor.frame }) || existing;
              await transaction.put(`account:${actor.username}`, account);
            }
          }
          updatedUser = this.normalizedUser(actor);await transaction.put(`user:${actor.id}`, updatedUser);
        });
        Object.assign(user, updatedUser);await this.broadcastProfile(user.id);
      } else if (value.type === 'create-invite') {
        const kind = value.kind === 'server' ? 'server' : 'friend';
        if (kind === 'server' && !user.servers.includes(normalizeId(value.serverId))) throw new Error('not a server member');
        await this.consumeInviteCreateBudget(socket, attachment, user.id);
        const code = await this.createInvite(kind, kind === 'server' ? normalizeId(value.serverId) : user.id, user.id);
        this.safeSend(socket, JSON.stringify({ type: 'invite-created', kind, code }));
      } else if (value.type === 'redeem-invite') {
        await this.consumeInviteRedeemBudget(socket, attachment); const audience=await this.redeemInvite(user, String(value.code || '')); await this.broadcastSnapshots(audience);
      } else if (value.type === 'create-server') {
        const server = { id: randomHex(), name: cleanText(value.name, 48, 'New server'), picture: cleanImage(value.picture), owner: user.id, members: [user.id], channels: [{ id: randomHex(), type: 'text', name: 'general' }, { id: randomHex(), type: 'voice', name: 'Lounge' }] };
        await this.state.storage.transaction(async transaction => {
          if (await transaction.get(`server:${server.id}`)) throw new Error('could not allocate a server');
          const actor = await transaction.get(`user:${user.id}`); if (!actor) throw new Error('account missing');
          actor.servers = Array.isArray(actor.servers) ? actor.servers : [];
          if (actor.servers.length >= MAX_SERVERS) throw new Error('server limit reached');
          actor.servers.push(server.id);
          await transaction.put(`server:${server.id}`, server);
          await transaction.put(`user:${actor.id}`, this.normalizedUser(actor));
        });
        await this.sendSnapshot(user.id);
      } else if (value.type === 'update-server') {
        const server = await this.server(value.serverId); this.requireOwner(server, user.id);
        if ('name' in value) server.name = cleanText(value.name, 48, server.name);
        if ('picture' in value) server.picture = cleanImage(value.picture);
        await this.state.storage.put(`server:${server.id}`, server); this.broadcastEntity(server);
      } else if (value.type === 'create-channel') {
        const server = await this.server(value.serverId); this.requireOwner(server, user.id);
        if (server.channels.length >= 64) throw new Error('channel limit reached');
        server.channels.push({ id: randomHex(), type: value.channelType === 'voice' ? 'voice' : 'text', name: cleanText(value.name, 48, value.channelType === 'voice' ? 'New voice' : 'new-channel') });
        await this.state.storage.put(`server:${server.id}`, server); this.broadcastEntity(server);
      } else if (value.type === 'delete-channel') {
        const server = await this.server(value.serverId); this.requireOwner(server, user.id);
        const channelId = normalizeId(value.channelId), channel = server.channels.find(item => item.id === channelId);
        if (!channel) throw new Error('channel missing');
        if (channel.type === 'text' && server.channels.filter(item => item.type === 'text').length <= 1) throw new Error('a server needs at least one text channel');
        server.channels = server.channels.filter(item => item.id !== channelId);
        for (const live of this.state.getWebSockets()) { const liveAttachment = live.deserializeAttachment() || {}; if (liveAttachment.voiceChannelId === channelId) { delete liveAttachment.voiceScope; delete liveAttachment.voiceServerId; delete liveAttachment.voiceChannelId; delete liveAttachment.voiceJoinedAt; live.serializeAttachment(liveAttachment); } }
        await this.state.storage.put(`server:${server.id}`, server); this.broadcastEntity(server);if(channel.type==='voice')this.broadcastVoiceStates(server);
      } else if (value.type === 'reorder-channels') {
        const server = await this.server(value.serverId); this.requireOwner(server, user.id);
        const ids = Array.isArray(value.channelIds) ? value.channelIds.map(normalizeId).filter(Boolean) : [];
        if (ids.length !== server.channels.length || new Set(ids).size !== ids.length || ids.some(id => !server.channels.some(channel => channel.id === id))) throw new Error('invalid channel order');
        const channels = new Map(server.channels.map(channel => [channel.id, channel])); server.channels = ids.map(id => channels.get(id));
        await this.state.storage.put(`server:${server.id}`, server); this.broadcastEntity(server);
      } else if (value.type === 'voice-state') {
        const entity=await this.updateVoiceState(socket, attachment, user, value); this.broadcastVoiceStates(entity);
      } else if (value.type === 'relay-text') {
        await this.relayText(user, value);
      } else if (value.type === 'relay-ack') {
        await this.ackRelayText(user, value);
      } else if (value.type === 'relay-key') {
        await this.relayGroupKey(user, value);
      } else if (value.type === 'turn-credentials') {
        await this.issueTurnCredentials(socket, attachment, user);
      } else if (value.type === 'connect' || value.type === 'signal') {
        await this.relayPeerControl(socket, attachment, user, value);
      }
    } catch (error) { this.safeSend(socket, JSON.stringify({ type: 'error', action: value.type, message: cleanText(error?.message, 160, 'request failed') })); }
  }

  async authenticate(socket, attachment, value) {
    if (value?.type === 'account-challenge') return this.accountChallenge(socket, attachment, value);
    if (value?.type === 'account-login') return this.loginAccount(socket, attachment, value);
    if (value?.type !== 'hello') return socket.close(1008, 'authenticate first');
    const id = normalizeId(value.userId), token = normalizeToken(value.token);
    if (!id || !token) return socket.close(1008, 'invalid credentials');
    const hash = await tokenHash(token); let user = await this.user(id), profileChanged = false, matchedSession = null;
    if (user) {
      const now = Date.now(), sessions = (user.sessions || []).filter(session => session && typeof session.hash === 'string' && Number(session.expiresAt) > now).slice(-8);
      const legacyValid = user.tokenHash === hash;matchedSession = sessions.find(session => secureEqual(session.hash, hash)) || null;const sessionValid = !!matchedSession;
      if (!legacyValid && !sessionValid) return socket.close(1008, 'authentication failed');
      // Once an anonymous identity becomes an account, even its original device
      // credential becomes an expiring, revocable session instead of a forever token.
      if (user.username && legacyValid) { matchedSession = { hash, expiresAt: now + ACCOUNT_SESSION_TTL_MS, accountLogin: true }; sessions.push(matchedSession); delete user.tokenHash; }
      // Upgrade sessions issued by older Worker versions as they reconnect.
      // Account handshakes are authentication, not profile-write operations.
      if (user.username && matchedSession) matchedSession.accountLogin = true;
      user.sessions = [...new Map(sessions.map(session => [session.hash, session])).values()].slice(-8);
    }
    if (!user) user = { id, tokenHash: hash, name: cleanText(value.name, 32, 'Knot user'), image: cleanImage(value.image), frame: cleanFrame(value.frame), deviceKey: cleanDeviceKey(value.deviceKey), friends: [], servers: [], groupDms: [] };
    else {
      // A token created by password login is a recovery session. Its reconnect
      // handshake must not replace the saved account profile with a new
      // machine's defaults. Explicit update-profile messages still can.
      const profileLocked=!!(user.username&&matchedSession?.accountLogin),name=!profileLocked&&'name'in value?cleanText(value.name,32,user.name):user.name,image=!profileLocked&&'image'in value?cleanImage(value.image):user.image,frame=!profileLocked&&'frame'in value?cleanFrame(value.frame):cleanFrame(user.frame),deviceKey=cleanDeviceKey(value.deviceKey)||user.deviceKey||null;
      profileChanged=name!==user.name||image!==user.image||frame.zoom!==user.frame?.zoom||frame.x!==user.frame?.x||frame.y!==user.frame?.y||deviceKey?.x!==user.deviceKey?.x||deviceKey?.y!==user.deviceKey?.y;
      user.name=name;user.image=image;user.frame=frame;user.deviceKey=deviceKey;
    }
    await this.putUser(user); attachment.authed = true; attachment.userId = id; attachment.connectionId = normalizeId(attachment.connectionId) || randomHex(); attachment.connectedAt = Date.now(); socket.serializeAttachment(attachment);this.limitUserSockets(id, socket);
    this.safeSend(socket, JSON.stringify({ type: 'authenticated', userId: id, username: user.username || '', connectionId: attachment.connectionId })); await this.sendSnapshot(user.id);if(profileChanged)await this.broadcastProfile(user.id,[user.id]);else await this.broadcastPresence(user.id,[user.id]);await this.deliverMailbox(user.id);
  }

  async createAccount(socket, user, value, attachment = {}) {
    const shard=this.securityShard(socket,attachment);await this.consumeSecurityBudget('signup', 60 * 60 * 1000, SIGNUP_GLOBAL_LIMIT_PER_HOUR);await this.consumeSecurityBudget(`signup:${shard}`, 60 * 60 * 1000, SIGNUP_SHARD_LIMIT_PER_HOUR);
    const username = normalizeUsername(value.username), passwordSalt = cleanPasswordSalt(value.passwordSalt), verifier = cleanVerifier(value.verifier);
    if (!username) throw new Error('username must be 3–24 letters, numbers, dots, dashes, or underscores');
    if (!passwordSalt || !verifier) throw new Error('password verifier is invalid; update Knot and try again');
    if (user.username && user.username !== username) throw new Error('this identity already has an account');
    const verifierHash = await tokenHash(verifier);
    let updatedUser,recoveryProfile;
    await this.state.storage.transaction(async transaction => {
      const existing = await transaction.get(`account:${username}`);
      if (existing && existing.userId !== user.id) throw new Error('that username is already taken');
      const actor = await transaction.get(`user:${user.id}`); if (!actor) throw new Error('account identity is missing');
      if (actor.username && actor.username !== username) throw new Error('this identity already has an account');
      const now = Date.now();
      if (actor.tokenHash) { actor.sessions = [...(actor.sessions || []), { hash: actor.tokenHash, expiresAt: now + ACCOUNT_SESSION_TTL_MS, accountLogin: true }].slice(-8); delete actor.tokenHash; }
      actor.username = username; updatedUser = this.normalizedUser(actor);
      recoveryProfile = cleanAccountProfile(value.profile, accountProfileFromUser(actor)) || accountProfileFromUser(actor);
      await transaction.put(`account:${username}`, { userId: user.id, passwordSalt, verifierHash, profile: recoveryProfile });
      await transaction.put(`user:${user.id}`, updatedUser);
    });
    Object.assign(user, updatedUser);
    this.safeSend(socket, JSON.stringify({ type: 'account-session', mode: 'created', userId: user.id, username, profile: { id: user.id, ...recoveryProfile }, profileMigrated: false }));
  }

  async accountChallenge(socket, attachment, value) {
    const now = Date.now();
    if (!attachment.challengeWindowStarted || now - Number(attachment.challengeWindowStarted) >= LOGIN_WINDOW_MS) { attachment.challengeWindowStarted = now; attachment.challengeAttempts = 0; }
    attachment.challengeAttempts = Number(attachment.challengeAttempts || 0) + 1; socket.serializeAttachment?.(attachment);
    if (attachment.challengeAttempts > LOGIN_MAX_FAILURES) return this.safeSend(socket, JSON.stringify({ type: 'error', action: 'account-challenge', message: 'sign-in is temporarily limited' }));
    const shard = this.securityShard(socket, attachment);
    try { await this.consumeSecurityBudget('challenge', 60 * 1000, LOGIN_GLOBAL_LIMIT_PER_MINUTE); await this.consumeSecurityBudget(`challenge:${shard}`, 60 * 1000, LOGIN_SHARD_LIMIT_PER_MINUTE); }
    catch { return this.safeSend(socket, JSON.stringify({ type: 'error', action: 'account-challenge', message: 'sign-in is temporarily limited' })); }
    const requested = String(value?.username || '').trim().toLowerCase().slice(0, 24), username = normalizeUsername(requested);
    const account = username ? await this.state.storage.get(`account:${username}`) : null;
    // Existing and unknown names both receive a stable, same-shape salt so this
    // pre-login step does not become a reliable username-enumeration endpoint.
    const dummySalt = await this.dummyPasswordSalt(requested);
    const passwordSalt = cleanPasswordSalt(account?.passwordSalt) || dummySalt;
    this.safeSend(socket, JSON.stringify({ type: 'account-challenge', username: username || requested, passwordSalt }));
  }

  async loginAccount(socket, attachment, value) {
    const now = Date.now(), genericError=()=>this.safeSend(socket, JSON.stringify({ type: 'error', action: 'account-login', message: 'username or password is incorrect, or sign-in is temporarily limited' }));
    if (!attachment.loginWindowStarted || now - Number(attachment.loginWindowStarted) >= LOGIN_WINDOW_MS) { attachment.loginWindowStarted=now;attachment.loginFailures=0; }
    if (Number(attachment.loginFailures)>=LOGIN_MAX_FAILURES) { genericError();return; }
    const shard=this.securityShard(socket,attachment);try { await this.consumeSecurityBudget('login', 60 * 1000, LOGIN_GLOBAL_LIMIT_PER_MINUTE);await this.consumeSecurityBudget(`login:${shard}`, 60 * 1000, LOGIN_SHARD_LIMIT_PER_MINUTE); } catch { genericError();return; }
    const username = normalizeUsername(value.username), verifier = cleanVerifier(value.verifier), account = username ? await this.state.storage.get(`account:${username}`) : null;
    // Password stretching happens on the desktop. The Worker receives only the
    // derived verifier and stores only its SHA-256 hash, keeping raw passwords
    // out of Cloudflare while avoiding Workers' per-operation PBKDF2 ceiling.
    const supplied = await tokenHash(verifier || randomHex(32)), expected = account?.verifierHash || randomHex(32);
    if (!account || !verifier || !secureEqual(supplied, expected)) {
      attachment.loginFailures=Number(attachment.loginFailures||0)+1;socket.serializeAttachment(attachment);genericError();return;
    }
    const token = randomHex(32), hash = await tokenHash(token); let user,recoveryProfile,profileMigrated=false;
    try {
      await this.state.storage.transaction(async transaction => {
        const currentAccount = await transaction.get(`account:${username}`);
        if (!currentAccount || !secureEqual(currentAccount.verifierHash, supplied)) throw new Error('account changed during sign-in');
        user = await transaction.get(`user:${currentAccount.userId}`); if (!user) throw new Error('account identity is missing');
        if (currentAccount.login) delete currentAccount.login;
        const storedProfile=cleanAccountProfile(currentAccount.profile);profileMigrated=!storedProfile;recoveryProfile=storedProfile||accountProfileFromUser(user);currentAccount.profile=recoveryProfile;
        user.sessions = [...(user.sessions || []).filter(session => Number(session?.expiresAt) > now), { hash, expiresAt: now + ACCOUNT_SESSION_TTL_MS, accountLogin: true }].slice(-8); user.username = username;
        await transaction.put(`account:${username}`, currentAccount);
        await transaction.put(`user:${user.id}`, this.normalizedUser(user));
      });
    } catch (error) {
      if (/identity is missing/.test(String(error?.message || ''))) return socket.close(1008, 'account identity is missing');
      genericError(); return;
    }
    delete attachment.loginFailures;delete attachment.loginWindowStarted;attachment.authed = true; attachment.userId = user.id; attachment.connectionId = normalizeId(attachment.connectionId) || randomHex(); attachment.connectedAt = now; socket.serializeAttachment(attachment);this.limitUserSockets(user.id, socket);
    this.safeSend(socket, JSON.stringify({ type: 'account-session', mode: 'login', userId: user.id, token, username, connectionId: attachment.connectionId, profile: { id: user.id, ...recoveryProfile }, profileMigrated }));
    await this.sendSnapshot(user.id);await this.broadcastPresence(user.id,[user.id]);await this.deliverMailbox(user.id);
  }

  async createInvite(kind, targetId, ownerId) {
    const activeKey = `active-invite:${ownerId}:${kind}`;
    for (let attempt = 0; attempt < 20; attempt++) {
      const random = new Uint32Array(1); crypto.getRandomValues(random); const code = String(10000 + random[0] % 90000);
      let created = false;
      await this.state.storage.transaction(async transaction => {
        const key = `invite:${code}`, now = Date.now(), existing = await transaction.get(key);
        if (existing && Number(existing.expires) >= now) return;
        const previousCode = await transaction.get(activeKey);
        if (/^\d{5}$/.test(String(previousCode || '')) && previousCode !== code) {
          const previous = await transaction.get(`invite:${previousCode}`);
          if (previous?.ownerId === ownerId) await transaction.delete(`invite:${previousCode}`);
        }
        await transaction.put(key, { kind, targetId, ownerId, expires: now + INVITE_TTL_MS });
        await transaction.put(activeKey, code); created = true;
      });
      if (created) return code;
    }
    throw new Error('could not allocate an invite code');
  }

  async redeemInvite(user, rawCode) {
    const code = String(rawCode).trim(); if (!/^\d{5}$/.test(code)) throw new Error('invalid invite code');
    const key = `invite:${code}`; let audience = [], failure = '';
    await this.state.storage.transaction(async transaction => {
      const invite = await transaction.get(key), now = Date.now();
      if (!invite || Number(invite.expires) < now) {
        if (invite) await transaction.delete(key);
        if (invite?.ownerId) { const activeKey = `active-invite:${invite.ownerId}:${invite.kind}`; if (await transaction.get(activeKey) === code) await transaction.delete(activeKey); }
        failure = 'invite expired'; return;
      }
      const actor = await transaction.get(`user:${user.id}`); if (!actor) { failure = 'account missing'; return; }
      if (invite.kind === 'friend') {
        if (invite.targetId === actor.id) { failure = 'that is your own invite'; return; }
        const friend = await transaction.get(`user:${invite.targetId}`); if (!friend) { failure = 'friend account missing'; return; }
        actor.friends = Array.isArray(actor.friends) ? actor.friends : []; friend.friends = Array.isArray(friend.friends) ? friend.friends : [];
        if (!actor.friends.includes(friend.id) && actor.friends.length >= MAX_FRIENDS) { failure = 'friend limit reached'; return; }
        if (!friend.friends.includes(actor.id) && friend.friends.length >= MAX_FRIENDS) { failure = 'your friend has reached their friend limit'; return; }
        if (!actor.friends.includes(friend.id)) actor.friends.push(friend.id);
        if (!friend.friends.includes(actor.id)) friend.friends.push(actor.id);
        await transaction.put(`user:${actor.id}`, this.normalizedUser(actor));
        await transaction.put(`user:${friend.id}`, this.normalizedUser(friend)); audience = [actor.id, friend.id];
      } else if (invite.kind === 'server') {
        const server = await transaction.get(`server:${invite.targetId}`); if (!server) { failure = 'server missing'; return; }
        actor.servers = Array.isArray(actor.servers) ? actor.servers : []; server.members = Array.isArray(server.members) ? server.members : [];
        if (!server.members.includes(actor.id) && server.members.length >= MAX_SERVER_MEMBERS) { failure = 'server member limit reached'; return; }
        if (!actor.servers.includes(server.id) && actor.servers.length >= MAX_SERVERS) { failure = 'server limit reached'; return; }
        if (!server.members.includes(actor.id)) server.members.push(actor.id);
        if (!actor.servers.includes(server.id)) actor.servers.push(server.id);
        await transaction.put(`server:${server.id}`, server);
        await transaction.put(`user:${actor.id}`, this.normalizedUser(actor)); audience = [...server.members];
      } else { failure = 'invalid invite'; return; }
      await transaction.delete(key);
      if (invite.ownerId) { const activeKey = `active-invite:${invite.ownerId}:${invite.kind}`; if (await transaction.get(activeKey) === code) await transaction.delete(activeKey); }
    });
    if (failure) throw new Error(failure);
    return audience;
  }

  async createGroupDm(user, value) {
    const memberIds = [...new Set((Array.isArray(value.memberIds) ? value.memberIds : []).map(normalizeId).filter(id => id && id !== user.id))];
    const migrationPeer = normalizeId(value.migrateCallPeerId);
    if (memberIds.length < 2) throw new Error('choose at least two friends for a group DM');
    if (memberIds.length + 1 > MAX_GROUP_DM_MEMBERS) throw new Error(`group DMs can have at most ${MAX_GROUP_DM_MEMBERS} members`);
    if (memberIds.some(id => !user.friends.includes(id))) throw new Error('you can only add your friends to a group DM');
    if (migrationPeer && !memberIds.includes(migrationPeer)) throw new Error('the active call member must be included in the group DM');
    const id = randomHex(), now = Date.now();
    const group = {
      id,
      kind: 'group-dm',
      name: cleanText(value.name, 48, 'Group DM'),
      owner: user.id,
      keySteward: user.id,
      members: [user.id, ...memberIds],
      channels: [
        { id: randomHex(), type: 'text', name: 'chat' },
        { id: randomHex(), type: 'voice', name: 'Call' }
      ],
      keyEpoch: 1,
      createdAt: now,
      updatedAt: now,
      ...(migrationPeer ? { callMigration: { members: [user.id, migrationPeer], expiresAt: now + 60 * 1000 } } : {})
    };
    await this.state.storage.transaction(async transaction => {
      if (await transaction.get(`group:${id}`)) throw new Error('could not allocate a group DM');
      const actor = await transaction.get(`user:${user.id}`);
      if (!actor) throw new Error('account missing');
      actor.groupDms = Array.isArray(actor.groupDms) ? actor.groupDms : [];
      if (actor.groupDms.length >= MAX_GROUP_DMS) throw new Error('group DM limit reached');
      const targets = [];
      for (const memberId of memberIds) {
        const target = await transaction.get(`user:${memberId}`);
        if (!target || !(actor.friends || []).includes(memberId)) throw new Error('a selected friend is no longer available');
        target.groupDms = Array.isArray(target.groupDms) ? target.groupDms : [];
        if (target.groupDms.length >= MAX_GROUP_DMS) throw new Error('a selected friend has reached their group DM limit');
        targets.push(target);
      }
      actor.groupDms.push(id);
      await transaction.put(`user:${actor.id}`, this.normalizedUser(actor));
      for (const target of targets) {
        target.groupDms.push(id);
        await transaction.put(`user:${target.id}`, this.normalizedUser(target));
      }
      await transaction.put(`group:${id}`, group);
    });
    return group;
  }

  async addGroupMembers(user, value) {
    const groupId = normalizeId(value.groupId), requested = Array.isArray(value.memberIds) ? value.memberIds : [value.memberId];
    const memberIds = [...new Set(requested.map(normalizeId).filter(id => id && id !== user.id))];
    if (!groupId || !memberIds.length) throw new Error('choose at least one friend to add');
    let updated;
    await this.state.storage.transaction(async transaction => {
      const group = await transaction.get(`group:${groupId}`),actor=await transaction.get(`user:${user.id}`); this.requireGroupMember(group, user.id);if(!actor)throw new Error('account missing');
      const additions = memberIds.filter(id => !group.members.includes(id));
      if (!additions.length) { updated = group; return; }
      if (group.members.length + additions.length > MAX_GROUP_DM_MEMBERS) throw new Error(`group DMs can have at most ${MAX_GROUP_DM_MEMBERS} members`);
      if (additions.some(id => !(actor.friends||[]).includes(id))) throw new Error('you can only add your friends to a group DM');
      const targets = [];
      for (const memberId of additions) {
        const target = await transaction.get(`user:${memberId}`);
        if (!target || !(actor.friends || []).includes(memberId)) throw new Error('a selected friend is no longer available');
        target.groupDms = Array.isArray(target.groupDms) ? target.groupDms : [];
        if (target.groupDms.length >= MAX_GROUP_DMS) throw new Error('a selected friend has reached their group DM limit');
        targets.push(target);
      }
      group.members.push(...additions); group.keyEpoch = Math.max(1, Number(group.keyEpoch) || 1) + 1; group.keySteward = user.id; group.updatedAt = Date.now();
      for (const target of targets) {
        target.groupDms.push(group.id);
        await transaction.put(`user:${target.id}`, this.normalizedUser(target));
      }
      await transaction.put(`group:${group.id}`, group); updated = group;
    });
    return updated;
  }

  async updateGroupDm(user, value) {
    const groupId = normalizeId(value.groupId); if (!groupId) throw new Error('group DM missing');
    let updated;
    await this.state.storage.transaction(async transaction => {
      const group = await transaction.get(`group:${groupId}`); this.requireGroupOwner(group, user.id);
      if ('name' in value) group.name = cleanText(value.name, 48, group.name || 'Group DM');
      group.updatedAt = Date.now(); await transaction.put(`group:${group.id}`, group); updated = group;
    });
    return updated;
  }

  async removeGroupMember(user, value) {
    const groupId = normalizeId(value.groupId), memberId = normalizeId(value.memberId);
    if (!groupId || !memberId) throw new Error('group member missing');
    if (memberId === user.id) throw new Error('use leave group DM to remove yourself');
    let deleted = false, originalMembers = [];
    await this.state.storage.transaction(async transaction => {
      const group = await transaction.get(`group:${groupId}`); this.requireGroupOwner(group, user.id);
      if (!group.members.includes(memberId)) throw new Error('group member missing');
      originalMembers = [...group.members]; group.members = group.members.filter(id => id !== memberId);
      const removed = await transaction.get(`user:${memberId}`);
      if (removed) { removed.groupDms = (removed.groupDms || []).filter(id => id !== group.id); await transaction.put(`user:${removed.id}`, this.normalizedUser(removed)); }
      if (group.members.length < 2) {
        deleted = true; await transaction.delete(`group:${group.id}`);
        for (const id of originalMembers.filter(id => id !== memberId)) {
          const member = await transaction.get(`user:${id}`); if (!member) continue;
          member.groupDms = (member.groupDms || []).filter(value => value !== group.id); await transaction.put(`user:${member.id}`, this.normalizedUser(member));
        }
      } else {
        group.keyEpoch = Math.max(1, Number(group.keyEpoch) || 1) + 1; group.keySteward = user.id; group.updatedAt = Date.now(); await transaction.put(`group:${group.id}`, group);
      }
    });
    this.clearVoicePresence(groupId, [memberId]);
    if (deleted) this.clearVoicePresence(groupId);
    await Promise.all((deleted ? originalMembers : [memberId]).map(id => this.purgeGroupMailbox(id, groupId)));
    return originalMembers;
  }

  async leaveGroupDm(user, value) {
    const groupId = normalizeId(value.groupId); if (!groupId) throw new Error('group DM missing');
    let deleted = false, originalMembers = [];
    await this.state.storage.transaction(async transaction => {
      const group = await transaction.get(`group:${groupId}`); this.requireGroupMember(group, user.id); originalMembers = [...group.members];
      group.members = group.members.filter(id => id !== user.id);
      const actor = await transaction.get(`user:${user.id}`);
      if (actor) { actor.groupDms = (actor.groupDms || []).filter(id => id !== group.id); await transaction.put(`user:${actor.id}`, this.normalizedUser(actor)); }
      if (group.members.length < 2) {
        deleted = true; await transaction.delete(`group:${group.id}`);
        for (const id of group.members) {
          const member = await transaction.get(`user:${id}`); if (!member) continue;
          member.groupDms = (member.groupDms || []).filter(value => value !== group.id); await transaction.put(`user:${member.id}`, this.normalizedUser(member));
        }
      } else {
        if (group.owner === user.id) group.owner = group.members[0];
        group.keyEpoch = Math.max(1, Number(group.keyEpoch) || 1) + 1; group.keySteward = group.members.find(id => this.isOnline(id)) || group.owner; group.updatedAt = Date.now(); await transaction.put(`group:${group.id}`, group);
      }
    });
    this.clearVoicePresence(groupId, deleted ? originalMembers : [user.id]);
    await Promise.all((deleted ? originalMembers : [user.id]).map(id => this.purgeGroupMailbox(id, groupId)));
    return originalMembers;
  }

  async updateVoiceState(socket, attachment, user, value) {
    const groupId = normalizeId(value.groupId), serverId = normalizeId(value.serverId), scope = groupId ? 'group-dm' : 'server';
    const entity = groupId ? await this.groupDm(groupId) : await this.server(serverId);
    if (groupId) this.requireGroupMember(entity, user.id); else this.requireMember(entity, user.id);
    const channelId = normalizeId(value.channelId), channel = entity.channels.find(item => item.id === channelId && item.type === 'voice');
    if (value.joined && !channel) throw new Error('voice channel missing');
    if (value.joined) {
      const occupants=new Set(this.state.getWebSockets().map(live=>live.deserializeAttachment?.()||{}).filter(live=>live.authed&&live.voiceServerId===entity.id&&live.voiceChannelId===channelId).map(live=>live.userId).filter(Boolean));
      if(!occupants.has(user.id)&&occupants.size>=MAX_VOICE_CHANNEL_MEMBERS)throw new Error(`voice channel is full (${MAX_VOICE_CHANNEL_MEMBERS} people maximum)`);
      const sameChannel = attachment.voiceScope === scope && attachment.voiceServerId === entity.id && attachment.voiceChannelId === channelId;
      attachment.voiceScope = scope; attachment.voiceServerId = entity.id; attachment.voiceChannelId = channelId;
      attachment.voiceJoinedAt = sameChannel && attachment.voiceJoinedAt ? attachment.voiceJoinedAt : Date.now();
    } else {
      delete attachment.voiceScope; delete attachment.voiceServerId; delete attachment.voiceChannelId; delete attachment.voiceJoinedAt;
    }
    socket.serializeAttachment(attachment);
    return entity;
  }

  async relayPeerControl(socket, attachment, user, value) {
    const peerId = normalizeId(value.peerId), context = this.cleanContext(value.context);
    if (!peerId || peerId === user.id) throw new Error('peer is invalid');
    if (value.type === 'connect') {
      if (context.type !== 'dm' || !await this.canContact(user, peerId)) throw new Error('direct calls can only connect to friends');
      const session = normalizeId(value.session); if (!session) throw new Error('invalid session');
      if (!this.sendUser(peerId, { type: 'connect-request', from: user.id, session, context })) throw new Error('peer is offline');
      return;
    }
    if (context.type === 'dm' || context.type === 'dm-persistent') {
      if (!await this.canContact(user, peerId)) throw new Error('direct signaling is limited to friends');
      const payload = this.cleanPeerSignal(value.payload, context.type === 'dm-persistent');
      if (!this.sendUser(peerId, { type: 'peer-signal', from: user.id, context, payload })) throw new Error('peer is offline');
      return;
    }
    const isGroup = context.type === 'group-dm', entity = isGroup ? await this.groupDm(context.groupId) : await this.server(context.serverId);
    if (isGroup) this.requireGroupMember(entity, user.id); else this.requireMember(entity, user.id);
    if (!entity.members.includes(peerId)) throw new Error('peer is not a conversation member');
    const channel = entity.channels.find(item => item.id === context.channelId && item.type === 'voice');
    if (!channel) throw new Error('voice channel missing');
    if (isGroup && context.keyEpoch !== Number(entity.keyEpoch)) throw new Error('group call state is out of date');
    const scope = isGroup ? 'group-dm' : 'server';
    if (!this.voicePeerAllowed(attachment, peerId, scope, entity.id, channel.id)) throw new Error('peer is not in this voice channel');
    const payload = this.cleanPeerSignal(value.payload);
    const sent = this.sendVoicePeer(peerId, scope, entity.id, channel.id, { type: 'peer-signal', from: user.id, context, payload });
    if (!sent) throw new Error('peer left the voice channel');
  }

  voicePeerAllowed(senderAttachment, peerId, scope, entityId, channelId) {
    if (senderAttachment.voiceScope !== scope || senderAttachment.voiceServerId !== entityId || senderAttachment.voiceChannelId !== channelId) return false;
    return this.state.getWebSockets().some(socket => {
      const attachment = socket.deserializeAttachment() || {};
      return socket.readyState === 1 && attachment.authed && attachment.userId === peerId && attachment.voiceScope === scope && attachment.voiceServerId === entityId && attachment.voiceChannelId === channelId;
    });
  }

  sendVoicePeer(userId, scope, entityId, channelId, value) {
    let sent = false, data = JSON.stringify(value);
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() || {};
      if (socket.readyState !== 1 || !attachment.authed || attachment.userId !== userId || attachment.voiceScope !== scope || attachment.voiceServerId !== entityId || attachment.voiceChannelId !== channelId) continue;
      if (this.safeSend(socket, data)) sent = true;
    }
    return sent;
  }

  clearVoicePresence(entityId, userIds = null) {
    const allowedUsers = userIds ? new Set(userIds) : null;
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.voiceServerId !== entityId || (allowedUsers && !allowedUsers.has(attachment.userId))) continue;
      delete attachment.voiceScope; delete attachment.voiceServerId; delete attachment.voiceChannelId; delete attachment.voiceJoinedAt;
      socket.serializeAttachment(attachment);
    }
  }

  // Direct and group-DM messages are encrypted before this Durable Object sees
  // them. Store only each recipient's opaque envelope until they acknowledge a
  // successful local decrypt, then delete it. A bounded TTL/byte cap keeps the
  // free-tier mailbox predictable even if a device stays offline for weeks.
  async relayText(user, value) {
    const scope = value.scope === 'group-dm' ? 'group-dm' : value.scope === 'server' ? 'server' : value.scope === 'dm' ? 'dm' : '';
    const id = normalizeId(value.id), cipher = cleanCiphertext(value.cipher);
    if (!scope || !id || !cipher) throw new Error('invalid encrypted text envelope');
    if (scope === 'dm') {
      const peerId = normalizeId(value.peerId);
      if (!peerId || !user.friends.includes(peerId)) throw new Error('direct-message recipient is not a friend');
      const envelope = { type: 'relay-text', scope: 'dm', from: user.id, id, cipher, queuedAt: Date.now() };
      await this.storeMailbox(peerId, envelope);const delivered = this.sendUser(peerId, envelope);
      this.sendUser(user.id, { type: 'relay-status', id, queued: !delivered });
      return;
    }
    if (scope === 'group-dm') {
      const group = await this.groupDm(value.groupId); this.requireGroupMember(group, user.id);
      const channelId = normalizeId(value.channelId), channel = group.channels.find(item => item.id === channelId && item.type === 'text');
      const keyEpoch = Number(value.keyEpoch);
      if (!channel) throw new Error('group text channel missing');
      if (!Number.isInteger(keyEpoch) || keyEpoch !== Number(group.keyEpoch)) throw new Error('group encryption key is out of date');
      const envelope = { type: 'relay-text', scope: 'group-dm', from: user.id, id, groupId: group.id, channelId, keyEpoch, cipher, queuedAt: Date.now() };
      let delivered = 0;
      for (const memberId of group.members) if (memberId !== user.id) {
        await this.storeMailbox(memberId, envelope); if (this.sendUser(memberId, envelope)) delivered++;
      }
      this.sendUser(user.id, { type: 'relay-status', id, queued: delivered < group.members.length - 1 });
      return;
    }
    const server = await this.server(value.serverId); this.requireMember(server, user.id);
    const channelId = normalizeId(value.channelId), channel = server.channels.find(item => item.id === channelId && item.type === 'text');
    if (!channel) throw new Error('text channel missing');
    const envelope = { type: 'relay-text', scope: 'server', from: user.id, id, serverId: server.id, channelId, cipher };
    this.sendUsers(server.members,envelope,[user.id]);
  }

  async storeMailbox(userId, envelope) {
    const now = Date.now(), key = `mail:${userId}:${String(now).padStart(13, '0')}:${envelope.id}`;
    const stored = { ...envelope, expiresAt: now + DM_MAILBOX_TTL_MS }, indexKey = `mail-id:${userId}:${envelope.id}`; let storedKey;
    await this.state.storage.transaction(async transaction => {
      storedKey = await transaction.get(indexKey); if (storedKey) return;
      await transaction.put(key, stored); await transaction.put(indexKey, key); storedKey = key;
    });
    await this.pruneMailbox(userId);return storedKey;
  }

  async pruneMailbox(userId) {
    const entries = [...(await this.state.storage.list({ prefix: `mail:${userId}:` })).entries()];let bytes = 0;const removals=[];
    for (const [, value] of entries) bytes += JSON.stringify(value).length;
    while (entries.length && (entries.length > DM_MAILBOX_MAX_MESSAGES || bytes > DM_MAILBOX_MAX_BYTES || Number(entries[0][1]?.expiresAt) <= Date.now())) {
      const [key, value] = entries.shift();bytes -= JSON.stringify(value).length;removals.push([key,`mail-id:${userId}:${value.id}`]);
    }
    for(let offset=0;offset<removals.length;offset+=32)await this.state.storage.transaction(async transaction=>{for(const [key,indexKey] of removals.slice(offset,offset+32)){await transaction.delete(key);await transaction.delete(indexKey)}});
  }

  async deliverMailbox(userId) {
    await this.pruneMailbox(userId);const entries = await this.state.storage.list({ prefix: `mail:${userId}:` });
    for (const [, envelope] of entries) this.sendUser(userId, { ...envelope, offline: true });
  }

  async purgeGroupMailbox(userId, groupId) {
    const entries = await this.state.storage.list({ prefix: `mail:${userId}:` }),removals=[...entries].filter(([,envelope])=>envelope?.scope==='group-dm'&&envelope.groupId===groupId);
    for(let offset=0;offset<removals.length;offset+=32)await this.state.storage.transaction(async transaction=>{for(const [key,envelope] of removals.slice(offset,offset+32)){await transaction.delete(key);await transaction.delete(`mail-id:${userId}:${envelope.id}`)}});
  }

  async ackRelayText(user, value) {
    const id = normalizeId(value.id);if (!id) throw new Error('invalid relay acknowledgement');
    const indexKey = `mail-id:${user.id}:${id}`;
    await this.state.storage.transaction(async transaction => { const key = await transaction.get(indexKey);if(!key)return;const envelope=await transaction.get(key);if(envelope?.id===id)await transaction.delete(key);await transaction.delete(indexKey); });
  }

  // Group-key wrapping is also opaque. A requesting member broadcasts no key;
  // a member that already has the local key sends an ECDH-wrapped copy directly
  // to the requester. Neither form is persisted by this Durable Object.
  async relayGroupKey(user, value) {
    if (value.scope === 'group-dm' || value.groupId) {
      const group = await this.groupDm(value.groupId); this.requireGroupMember(group, user.id);
      const mode = value.mode === 'request' ? 'request' : value.mode === 'deliver' ? 'deliver' : '';
      const id = normalizeId(value.id), keyEpoch = Number(value.keyEpoch);
      if (!mode || !id || !Number.isInteger(keyEpoch) || keyEpoch !== Number(group.keyEpoch)) throw new Error('invalid group-key relay');
      const requestKey = `group-key-request:${group.id}:${id}`;
      if (mode === 'request') {
        const now = Date.now(), requests = await this.state.storage.list({ prefix: `group-key-request:${group.id}:` });let active = 0;
        // A retry supersedes this member's older request IDs. Keeping only the
        // current one prevents an offline group from rate-limiting itself.
        for (const [key, request] of requests) { if (Number(request?.expiresAt) <= now || request?.requester === user.id) await this.state.storage.delete(key);else active++; }
        if (active >= 40) throw new Error('too many pending group-key requests');
        const existing = await this.state.storage.get(requestKey);if (existing && Number(existing.expiresAt) > now && existing.requester !== user.id) throw new Error('group-key request collision');
        await this.state.storage.put(requestKey, { requester: user.id, keyEpoch, expiresAt: now + GROUP_KEY_REQUEST_TTL_MS });
        const envelope = { type: 'relay-key', scope: 'group-dm', mode: 'request', from: user.id, id, groupId: group.id, keyEpoch };
        for (const memberId of group.members) if (memberId !== user.id) this.sendUser(memberId, envelope);
        return;
      }
      const peerId = normalizeId(value.peerId), cipher = cleanCiphertext(value.cipher), request = await this.state.storage.get(requestKey);
      if (!peerId || !cipher || !group.members.includes(peerId) || request?.requester !== peerId || Number(request?.keyEpoch) !== keyEpoch || Number(request?.expiresAt) <= Date.now()) {
        await this.state.storage.delete(requestKey); throw new Error('invalid or expired group-key delivery');
      }
      // Keep the short-lived request open so another member can answer if the
      // first opaque response is corrupt or undecryptable. The requester accepts
      // only the first locally validated key and the record expires automatically.
      if (!this.sendUser(peerId, { type: 'relay-key', scope: 'group-dm', mode: 'deliver', from: user.id, id, groupId: group.id, keyEpoch, cipher })) throw new Error('member is offline');
      return;
    }
    const server = await this.server(value.serverId); this.requireMember(server, user.id);
    const mode = value.mode === 'request' ? 'request' : value.mode === 'deliver' ? 'deliver' : '';
    if (!mode) throw new Error('invalid group-key relay');
    if (mode === 'request') {
      const requestId = normalizeId(value.id); if (!requestId) throw new Error('invalid key request');
      const envelope = { type: 'relay-key', mode: 'request', from: user.id, id: requestId, serverId: server.id };
      this.sendUsers(server.members,envelope,[user.id]);
      return;
    }
    const peerId = normalizeId(value.peerId), id = normalizeId(value.id), cipher = cleanCiphertext(value.cipher);
    if (!peerId || !id || !cipher || !server.members.includes(peerId)) throw new Error('invalid key delivery');
    if (!this.sendUser(peerId, { type: 'relay-key', mode: 'deliver', from: user.id, id, serverId: server.id, cipher })) throw new Error('member is offline');
  }

  // TURN credentials are optional. The long-lived Cloudflare key is a Worker
  // secret; clients get only a short-lived ICE configuration after direct P2P
  // has failed. If the secrets are absent, the client remains text-only rather
  // than exposing a reusable relay credential.
  async issueTurnCredentials(socket, attachment, user) {
    const now = Date.now();
    if (attachment.turnIssuedAt && now - attachment.turnIssuedAt < 60 * 1000) throw new Error('wait before requesting another relay credential');
    const keyId = String(this.env?.TURN_KEY_ID || ''), token = String(this.env?.TURN_API_TOKEN || '');
    if (!keyId || !token) throw new Error('voice relay is not configured');
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 3600, customIdentifier: user.id })
    });
    if (!response.ok) throw new Error('could not create a voice relay credential');
    const payload = await response.json(), iceServers = (Array.isArray(payload?.iceServers) ? payload.iceServers.slice(0, 8) : []).map(item => ({ ...item, urls: (Array.isArray(item?.urls) ? item.urls : [item?.urls]).filter(url => typeof url === 'string' && !/:[0-9]*53(?:[/?]|$)/.test(url)) })).filter(item => item.urls.length);
    if (!iceServers.length || iceServers.some(item => !item || typeof item !== 'object' || !Array.isArray(item.urls) || !item.urls.every(url => typeof url === 'string' && /^(?:stun|turn|turns):/i.test(url)))) throw new Error('voice relay returned an invalid ICE configuration');
    attachment.turnIssuedAt = now; socket.serializeAttachment(attachment);
    this.safeSend(socket, JSON.stringify({ type: 'turn-credentials', iceServers }));
  }

  boundedSnapshot(snapshot) {
    const byteLength=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength,target=MAX_DIRECTORY_SNAPSHOT_BYTES-16*1024;
    let bytes=byteLength(snapshot);if(bytes<=MAX_DIRECTORY_SNAPSHOT_BYTES)return snapshot;
    const candidates=[];
    for(const server of snapshot.servers||[])if(server.picture)candidates.push({owner:server,key:'picture',size:server.picture.length,priority:0});
    for(const member of Object.values(snapshot.members||{}))if(member.image)candidates.push({owner:member,key:'image',size:member.image.length,priority:1});
    for(const friend of snapshot.friends||[])if(friend.image)candidates.push({owner:friend,key:'image',size:friend.image.length,priority:2});
    if(snapshot.self?.image)candidates.push({owner:snapshot.self,key:'image',size:snapshot.self.image.length,priority:3});
    candidates.sort((a,b)=>a.priority-b.priority||b.size-a.size);
    for(const candidate of candidates){if(bytes<=target)break;candidate.owner[candidate.key]='';bytes-=candidate.size}
    snapshot.profileImagesTruncated=true;bytes=byteLength(snapshot);
    if(bytes>target){
      const memberIds=Object.keys(snapshot.members||{}).reverse();snapshot.memberProfilesTruncated=true;
      for(let index=0;index<memberIds.length&&bytes>target;index++){
        delete snapshot.members[memberIds[index]];
        if(index%32===31||index===memberIds.length-1)bytes=byteLength(snapshot);
      }
    }
    if(byteLength(snapshot)>MAX_DIRECTORY_SNAPSHOT_BYTES)throw new Error('directory snapshot exceeds the safe transport limit');
    return snapshot;
  }

  async snapshot(userId) {
    const user = await this.user(userId); if (!user) return null;
    const liveAttachments=this.liveAttachments(),onlineIds=new Set(liveAttachments.filter(attachment=>attachment.authed).map(attachment=>attachment.userId).filter(Boolean));
    const imageBudget={remaining:2*1024*1024,truncated:false},serverImageBudget={remaining:512*1024,truncated:false};
    const self=this.publicUser(user,onlineIds,imageBudget);
    const friends=(await this.loadMany(user.friends||[],id=>this.user(id),friend=>friend?this.publicUser(friend,onlineIds,imageBudget):null)).filter(Boolean);
    const servers=(await this.loadMany(user.servers||[],id=>this.server(id),server=>{if(!server)return null;const copy=structuredClone(server),size=String(copy.picture||'').length;if(size>serverImageBudget.remaining){copy.picture='';if(size)serverImageBudget.truncated=true}else serverImageBudget.remaining-=size;return copy})).filter(Boolean);
    const groupDms=(await this.loadMany(user.groupDms||[],id=>this.groupDm(id),group=>group?.members?.includes(user.id)?structuredClone(group):null)).filter(Boolean);
    const entities=[...servers,...groupDms],voiceStates=this.voiceStates(entities,liveAttachments),memberIds=[...new Set(entities.flatMap(entity=>entity.members||[]).map(normalizeId).filter(Boolean))];
    const prioritized=[],seen=new Set(),add=id=>{if(id&&!seen.has(id)){seen.add(id);prioritized.push(id)}};
    for(const group of groupDms)for(const id of group.members||[])add(id);
    for(const entries of Object.values(voiceStates))for(const entry of entries)add(entry.id);
    for(const id of memberIds)if(onlineIds.has(id))add(id);
    for(const id of memberIds)add(id);
    const selectedIds=prioritized.slice(0,MAX_SNAPSHOT_MEMBER_PROFILES),memberEntries=(await this.loadMany(selectedIds,id=>this.user(id),member=>member?[member.id,this.publicUser(member,onlineIds,imageBudget)]:null)).filter(Boolean);
    const members=Object.fromEntries(memberEntries);
    const snapshot={type:'snapshot',self,friends,servers,groupDms,members,voiceStates};
    if(memberIds.length>selectedIds.length)snapshot.memberProfilesTruncated=true;
    if(imageBudget.truncated||serverImageBudget.truncated)snapshot.profileImagesTruncated=true;
    return this.boundedSnapshot(snapshot);
  }

  publicUser(user,onlineIds=null,imageBudget=null) { const image=String(user.image||''),allowedImage=!imageBudget||image.length<=imageBudget.remaining;if(imageBudget&&image){if(allowedImage)imageBudget.remaining-=image.length;else imageBudget.truncated=true}return { id: user.id, name: user.name, username: user.username || '', image: allowedImage?image:'', frame: cleanFrame(user.frame), deviceKey: cleanDeviceKey(user.deviceKey), online: onlineIds?onlineIds.has(user.id):this.isOnline(user.id) }; }
  liveAttachments(){return this.state.getWebSockets().filter(socket=>socket.readyState===1).map(socket=>socket.deserializeAttachment()||{})}
  voiceStates(entities,attachments=this.liveAttachments()) { const allowed=new Map(entities.map(entity=>[entity.id,new Set((entity.channels||[]).filter(channel=>channel.type==='voice').map(channel=>channel.id))])),states={},seen={};for(const attachment of attachments){const channelId=normalizeId(attachment.voiceChannelId),channels=allowed.get(attachment.voiceServerId);if(!attachment.authed||!channels?.has(channelId))continue;const channelSeen=seen[channelId]||(seen[channelId]=new Set());if(channelSeen.has(attachment.userId))continue;channelSeen.add(attachment.userId);const list=states[channelId]||(states[channelId]=[]);list.push({id:attachment.userId,joinedAt:Number(attachment.voiceJoinedAt)||Date.now()})}return states; }
  async loadMany(ids,loader,mapper=null){const values=[];for(let offset=0;offset<ids.length;offset+=STORAGE_READ_BATCH_SIZE){const batch=await Promise.all(ids.slice(offset,offset+STORAGE_READ_BATCH_SIZE).map(loader));values.push(...(mapper?batch.map(mapper):batch))}return values}
  isOnline(userId,excludedSocket=null) { return this.state.getWebSockets().some(socket => { if(socket===excludedSocket)return false;const a = socket.deserializeAttachment() || {}; return socket.readyState === 1 && a.authed && a.userId === userId; }); }
  async relatedUserIds(seedIds) { const ids=new Set((seedIds||[]).map(normalizeId).filter(Boolean));for(const seed of [...ids]){const user=await this.user(seed);if(!user)continue;for(const friend of user.friends||[])ids.add(friend);const entityIds=[...(user.servers||[]).map(id=>['server',id]),...(user.groupDms||[]).map(id=>['group',id])],entities=(await this.loadMany(entityIds,([kind,id])=>kind==='group'?this.groupDm(id):this.server(id))).filter(Boolean);for(const entity of entities)for(const member of entity.members||[])ids.add(member)}return[...ids]; }
  async broadcastRelatedSnapshots(seedIds) { return this.broadcastSnapshots(await this.relatedUserIds(seedIds)); }
  async broadcastSnapshots(userIds=[]) { const online=new Set(this.state.getWebSockets().map(socket=>(socket.deserializeAttachment()||{}).userId).filter(Boolean)),ids=[...new Set((userIds||[]).map(normalizeId).filter(id=>id&&online.has(id)))];for(let offset=0;offset<ids.length;offset+=8)await Promise.all(ids.slice(offset,offset+8).map(async id=>{const snapshot=await this.snapshot(id);if(snapshot)this.sendUser(id,snapshot)})); }
  async sendSnapshot(userId){const snapshot=await this.snapshot(userId);return snapshot?this.sendUser(userId,snapshot):false}
  async broadcastProfile(userId,excluded=[]){const user=await this.user(userId);if(!user)return false;const recipients=await this.relatedUserIds([userId]);return this.sendUsers(recipients,{type:'profile-update',profile:this.publicUser(user)},excluded)}
  async broadcastPresence(userId,excluded=[],excludedSocket=null){const recipients=await this.relatedUserIds([userId]);return this.sendUsers(recipients,{type:'presence-update',userId,online:this.isOnline(userId,excludedSocket)},excluded)}
  broadcastEntity(entity){return entity?this.sendUsers(entity.members||[],{type:'entity-update',entity}):false}
  broadcastVoiceStates(entity){return entity?this.sendUsers(entity.members||[],{type:'voice-states',entityId:entity.id,voiceStates:this.voiceStates([entity])}):false}
  sendUsers(userIds,value,excluded=[]){const recipients=new Set((userIds||[]).map(normalizeId).filter(Boolean)),blocked=new Set((excluded||[]).map(normalizeId).filter(Boolean));let sent=false,data=JSON.stringify(value);for(const socket of this.state.getWebSockets()){const attachment=socket.deserializeAttachment()||{};if(socket.readyState===1&&attachment.authed&&recipients.has(attachment.userId)&&!blocked.has(attachment.userId)&&this.safeSend(socket,data))sent=true}return sent}
  sendUser(userId, value) { let sent = false, data = JSON.stringify(value); for (const socket of this.state.getWebSockets()) { const a = socket.deserializeAttachment() || {}; if (socket.readyState === 1 && a.authed && a.userId === userId && this.safeSend(socket, data)) sent = true; } return sent; }
  async dummyPasswordSalt(username){let secret=this.challengeSecret;if(!/^[a-f0-9]{64}$/.test(String(secret||''))){await this.state.storage.transaction(async transaction=>{const existing=await transaction.get('security:challenge-secret');secret=/^[a-f0-9]{64}$/.test(String(existing||''))?existing:randomHex(32);if(secret!==existing)await transaction.put('security:challenge-secret',secret)});this.challengeSecret=secret}const keyBytes=Uint8Array.from(secret.match(/../g).map(value=>parseInt(value,16))),key=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['sign']),digest=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(String(username||'')));return base64Url(new Uint8Array(digest).slice(0,16))}
  async consumeSecurityBudget(name, windowMs, limit) { const key = `security-budget:${name}`, now = Date.now();await this.state.storage.transaction(async transaction => { const previous = await transaction.get(key), budget = previous && now - Number(previous.startedAt) < windowMs ? previous : { startedAt: now, count: 0 };if (budget.count >= limit) throw new Error('security rate limit reached; try again later');budget.count++;await transaction.put(key, budget); }); }
  securityShard(socket, attachment) { let key=String(attachment.securityKey||'');if(!/^[a-f0-9]{64}$/.test(key)){key=randomHex(32);attachment.securityKey=key;socket.serializeAttachment?.(attachment)}return key.slice(0,2); }
  async consumeInviteRedeemBudget(socket, attachment) { const now=Date.now();if(!attachment.inviteRedeemAt||now-attachment.inviteRedeemAt>=INVITE_REDEEM_WINDOW_MS){attachment.inviteRedeemAt=now;attachment.inviteRedeemAttempts=0}attachment.inviteRedeemAttempts=Number(attachment.inviteRedeemAttempts||0)+1;socket.serializeAttachment(attachment);if(attachment.inviteRedeemAttempts>INVITE_REDEEM_MAX_ATTEMPTS)throw new Error('too many invite attempts; wait a minute and try again');const shard=this.securityShard(socket,attachment);await this.consumeSecurityBudget('invite-redeem',INVITE_REDEEM_WINDOW_MS,INVITE_GLOBAL_LIMIT_PER_MINUTE);await this.consumeSecurityBudget(`invite-redeem:${shard}`,INVITE_REDEEM_WINDOW_MS,INVITE_SHARD_LIMIT_PER_MINUTE); }
  async consumeInviteCreateBudget(socket,attachment,userId){const now=Date.now();if(!attachment.inviteCreateAt||now-attachment.inviteCreateAt>=INVITE_CREATE_WINDOW_MS){attachment.inviteCreateAt=now;attachment.inviteCreateAttempts=0}attachment.inviteCreateAttempts=Number(attachment.inviteCreateAttempts||0)+1;socket.serializeAttachment(attachment);if(attachment.inviteCreateAttempts>INVITE_CREATE_MAX_PER_USER)throw new Error('too many new invites; wait a minute and try again');const shard=this.securityShard(socket,attachment);await this.consumeSecurityBudget(`invite-create-user:${userId}`,INVITE_CREATE_WINDOW_MS,INVITE_CREATE_MAX_PER_USER);await this.consumeSecurityBudget('invite-create',INVITE_CREATE_WINDOW_MS,INVITE_GLOBAL_LIMIT_PER_MINUTE);await this.consumeSecurityBudget(`invite-create:${shard}`,INVITE_CREATE_WINDOW_MS,INVITE_SHARD_LIMIT_PER_MINUTE);}
  limitUserSockets(userId, current) { const sockets=this.state.getWebSockets().filter(socket=>{const attachment=socket.deserializeAttachment()||{};return socket.readyState===1&&attachment.authed&&attachment.userId===userId}).sort((left,right)=>Number((left.deserializeAttachment()||{}).connectedAt)-Number((right.deserializeAttachment()||{}).connectedAt)),excess=Math.max(0,sockets.length-MAX_USER_SOCKETS);for(const socket of sockets.filter(value=>value!==current).slice(0,excess))try{socket.close(1008,'too many account sessions')}catch{} }
  async canContact(user, peerId) { return !!peerId && (user.friends || []).includes(peerId); }
  directCallPairActive(senderAttachment, userId, peerId) {
    const session=cleanText(senderAttachment?.dmCallSession,32,'');if (!senderAttachment?.dmCallActive || senderAttachment.dmCallPeerId !== peerId||!session) return false;
    return this.state.getWebSockets().some(socket => { const attachment = socket.deserializeAttachment() || {}; return socket.readyState === 1 && attachment.authed && attachment.userId === peerId && attachment.dmCallActive && attachment.dmCallPeerId === userId&&cleanText(attachment.dmCallSession,32,'')===session; });
  }
  cleanContext(value) { const context = value && typeof value === 'object' ? value : {}, type = context.type === 'group-dm' ? 'group-dm' : context.type === 'server' ? 'server' : context.type === 'dm-persistent' ? 'dm-persistent' : 'dm'; return { type, serverId: normalizeId(context.serverId), groupId: normalizeId(context.groupId), channelId: normalizeId(context.channelId), keyEpoch: Number.isInteger(Number(context.keyEpoch)) ? Number(context.keyEpoch) : 0, relay: type === 'dm' && context.relay === true }; }
  cleanPeerSignal(value, allowKey = false) {
    if (!value || typeof value !== 'object') throw new Error('invalid peer signal');
    const kind = ['offer', 'answer', 'candidate'].includes(value.kind) ? value.kind : '';
    if (!kind) throw new Error('invalid peer signal kind');
    if (kind === 'candidate') {
      const source = value.candidate;
      if (!source || typeof source !== 'object' || typeof source.candidate !== 'string' || source.candidate.length > 4096) throw new Error('invalid ICE candidate');
      const sdpMid = source.sdpMid == null ? null : cleanText(source.sdpMid, 64, ''), sdpMLineIndex = source.sdpMLineIndex == null ? null : Number(source.sdpMLineIndex), usernameFragment = source.usernameFragment == null ? '' : cleanText(source.usernameFragment, 256, '');
      if (sdpMLineIndex !== null && (!Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 255)) throw new Error('invalid ICE candidate');
      return { kind, candidate: { candidate: source.candidate, sdpMid, sdpMLineIndex, ...(usernameFragment ? { usernameFragment } : {}) } };
    }
    const sdp = typeof value.sdp === 'string' ? value.sdp : '';
    if (!sdp || sdp.length > MAX_PEER_SDP_BYTES || !/^v=0(?:\r?\n|$)/.test(sdp)) throw new Error('invalid session description');
    const result = { kind, sdp };
    if (allowKey) { const pub = cleanDeviceKey(value.pub); if (!pub) throw new Error('invalid peer key'); result.pub = pub; }
    return result;
  }
  async user(id) { return normalizeId(id) ? this.state.storage.get(`user:${id}`) : null; }
  async server(id) { return normalizeId(id) ? this.state.storage.get(`server:${normalizeId(id)}`) : null; }
  async groupDm(id) { return normalizeId(id) ? this.state.storage.get(`group:${normalizeId(id)}`) : null; }
  normalizedUser(user) { user.friends = [...new Set((user.friends || []).map(normalizeId).filter(Boolean))].slice(0, MAX_FRIENDS); user.servers = [...new Set((user.servers || []).map(normalizeId).filter(Boolean))].slice(0, MAX_SERVERS); user.groupDms = [...new Set((user.groupDms || []).map(normalizeId).filter(Boolean))].slice(0, MAX_GROUP_DMS); return user; }
  async putUser(user) { await this.state.storage.put(`user:${user.id}`, this.normalizedUser(user)); }
  requireMember(server, userId) { if (!server || !server.members.includes(userId)) throw new Error('not a server member'); }
  requireOwner(server, userId) { this.requireMember(server, userId); if (server.owner !== userId) throw new Error('only the server owner can edit this server'); }
  requireGroupMember(group, userId) { if (!group || group.kind !== 'group-dm' || !group.members.includes(userId)) throw new Error('not a group DM member'); }
  requireGroupOwner(group, userId) { this.requireGroupMember(group, userId); if (group.owner !== userId) throw new Error('only the group owner can do that'); }
  safeSend(socket, message) { try { socket.send(message);return true; } catch { return false; } }
  withinRate(socket, attachment, bytes) { const now = Date.now(); if (!attachment.rateAt || now - attachment.rateAt >= 1000) { attachment.rateAt = now; attachment.rateBytes = 0;attachment.rateMessages = 0; } attachment.rateBytes = (attachment.rateBytes || 0) + bytes;attachment.rateMessages = (attachment.rateMessages || 0) + 1; socket.serializeAttachment(attachment); if (attachment.rateBytes <= MAX_SOCKET_BYTES_PER_SECOND && attachment.rateMessages <= MAX_SOCKET_MESSAGES_PER_SECOND) return true; socket.close(1008, 'rate limit'); return false; }
  async webSocketClose(socket) { const attachment=socket.deserializeAttachment()||{},userId=attachment.userId;if(attachment.voiceServerId){const entity=attachment.voiceScope==='group-dm'?await this.groupDm(attachment.voiceServerId):await this.server(attachment.voiceServerId);if(entity)this.broadcastVoiceStates(entity)}if(userId)await this.broadcastPresence(userId,[userId],socket); }
  async webSocketError(socket) { return this.webSocketClose(socket); }
}
