const MAX_ROOM_PEERS = 2;
const MAX_SIGNAL_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 768 * 1024;
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
const LOGIN_GLOBAL_LIMIT_PER_MINUTE = 120;
const SIGNUP_GLOBAL_LIMIT_PER_HOUR = 30;

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

function cleanPassword(value) {
  const password = typeof value === 'string' ? value : '';
  return password.length >= 8 && password.length <= 128 ? password : '';
}

async function passwordHash(password, salt) {
  const encoder = new TextEncoder(), key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 600000 }, key, 256);
  return [...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, '0')).join('');
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

  fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return jsonResponse({ error: 'websocket upgrade required' }, 426);
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    server.serializeAttachment({ authed: false, userId: '', rateAt: Date.now(), rateBytes: 0 });
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
        await this.createAccount(socket, user, value);
      } else if (value.type === 'remove-friend') {
        const peerId = normalizeId(value.peerId), friend = await this.user(peerId);
        if (!peerId || !friend || !user.friends.includes(peerId)) throw new Error('friend is missing');
        user.friends = user.friends.filter(id => id !== peerId); friend.friends = friend.friends.filter(id => id !== user.id);
        await this.putUser(user); await this.putUser(friend); await this.broadcastSnapshots();
      } else if (value.type === 'call-presence') {
        const peerId = normalizeId(value.peerId); if (!peerId || !user.friends.includes(peerId)) throw new Error('call recipient is not a friend');
        this.sendUser(peerId, { type: 'call-presence', from: user.id, active: !!value.active, session: cleanText(value.session, 32, ''), at: Date.now() });
      } else if (value.type === 'update-profile') {
        user.name = cleanText(value.name, 32, user.name || 'Knot user');
        user.image = cleanImage(value.image);
        user.frame = cleanFrame(value.frame);
        user.deviceKey = cleanDeviceKey(value.deviceKey) || user.deviceKey || null;
        await this.putUser(user); await this.broadcastSnapshots();
      } else if (value.type === 'create-invite') {
        const kind = value.kind === 'server' ? 'server' : 'friend';
        if (kind === 'server' && !user.servers.includes(normalizeId(value.serverId))) throw new Error('not a server member');
        const code = await this.createInvite(kind, kind === 'server' ? normalizeId(value.serverId) : user.id);
        this.safeSend(socket, JSON.stringify({ type: 'invite-created', kind, code }));
      } else if (value.type === 'redeem-invite') {
        await this.redeemInvite(user, String(value.code || '')); await this.broadcastSnapshots();
      } else if (value.type === 'create-server') {
        const server = { id: randomHex(), name: cleanText(value.name, 48, 'New server'), picture: cleanImage(value.picture), owner: user.id, members: [user.id], channels: [{ id: randomHex(), type: 'text', name: 'general' }, { id: randomHex(), type: 'voice', name: 'Lounge' }] };
        user.servers.push(server.id); await this.state.storage.put(`server:${server.id}`, server); await this.putUser(user); await this.broadcastSnapshots();
      } else if (value.type === 'update-server') {
        const server = await this.server(value.serverId); this.requireOwner(server, user.id);
        if ('name' in value) server.name = cleanText(value.name, 48, server.name);
        if ('picture' in value) server.picture = cleanImage(value.picture);
        await this.state.storage.put(`server:${server.id}`, server); await this.broadcastSnapshots();
      } else if (value.type === 'create-channel') {
        const server = await this.server(value.serverId); this.requireOwner(server, user.id);
        if (server.channels.length >= 64) throw new Error('channel limit reached');
        server.channels.push({ id: randomHex(), type: value.channelType === 'voice' ? 'voice' : 'text', name: cleanText(value.name, 48, value.channelType === 'voice' ? 'New voice' : 'new-channel') });
        await this.state.storage.put(`server:${server.id}`, server); await this.broadcastSnapshots();
      } else if (value.type === 'delete-channel') {
        const server = await this.server(value.serverId); this.requireOwner(server, user.id);
        const channelId = normalizeId(value.channelId), channel = server.channels.find(item => item.id === channelId);
        if (!channel) throw new Error('channel missing');
        if (channel.type === 'text' && server.channels.filter(item => item.type === 'text').length <= 1) throw new Error('a server needs at least one text channel');
        server.channels = server.channels.filter(item => item.id !== channelId);
        for (const live of this.state.getWebSockets()) { const liveAttachment = live.deserializeAttachment() || {}; if (liveAttachment.voiceChannelId === channelId) { delete liveAttachment.voiceServerId; delete liveAttachment.voiceChannelId; delete liveAttachment.voiceJoinedAt; live.serializeAttachment(liveAttachment); } }
        await this.state.storage.put(`server:${server.id}`, server); await this.broadcastSnapshots();
      } else if (value.type === 'reorder-channels') {
        const server = await this.server(value.serverId); this.requireOwner(server, user.id);
        const ids = Array.isArray(value.channelIds) ? value.channelIds.map(normalizeId).filter(Boolean) : [];
        if (ids.length !== server.channels.length || new Set(ids).size !== ids.length || ids.some(id => !server.channels.some(channel => channel.id === id))) throw new Error('invalid channel order');
        const channels = new Map(server.channels.map(channel => [channel.id, channel])); server.channels = ids.map(id => channels.get(id));
        await this.state.storage.put(`server:${server.id}`, server); await this.broadcastSnapshots();
      } else if (value.type === 'voice-state') {
        const server = await this.server(value.serverId); this.requireMember(server, user.id);
        const channelId = normalizeId(value.channelId), channel = server.channels.find(item => item.id === channelId && item.type === 'voice');
        if (value.joined && !channel) throw new Error('voice channel missing');
        if (value.joined) { const sameChannel = attachment.voiceServerId === server.id && attachment.voiceChannelId === channelId; attachment.voiceServerId = server.id; attachment.voiceChannelId = channelId; attachment.voiceJoinedAt = sameChannel && attachment.voiceJoinedAt ? attachment.voiceJoinedAt : Date.now(); }
        else { delete attachment.voiceServerId; delete attachment.voiceChannelId; delete attachment.voiceJoinedAt; }
        socket.serializeAttachment(attachment); await this.broadcastSnapshots();
      } else if (value.type === 'relay-text') {
        await this.relayText(user, value);
      } else if (value.type === 'relay-ack') {
        await this.ackRelayText(user, value);
      } else if (value.type === 'relay-key') {
        await this.relayGroupKey(user, value);
      } else if (value.type === 'turn-credentials') {
        await this.issueTurnCredentials(socket, attachment, user);
      } else if (value.type === 'connect' || value.type === 'signal') {
        const peerId = normalizeId(value.peerId); if (!peerId || !await this.canContact(user, peerId)) throw new Error('peer is not connected to you');
        const context = this.cleanContext(value.context);
        if (context.type === 'server') { const server = await this.server(context.serverId); this.requireMember(server, user.id); if (!server.members.includes(peerId)) throw new Error('peer is not a server member'); if (context.channelId && !server.channels.some(channel => channel.id === context.channelId)) throw new Error('server channel missing'); }
        const envelope = value.type === 'connect' ? { type: 'connect-request', from: user.id, session: normalizeId(value.session), context } : { type: 'peer-signal', from: user.id, context, payload: value.payload };
        if (value.type === 'connect' && !envelope.session) throw new Error('invalid session');
        if (!this.sendUser(peerId, envelope)) throw new Error('peer is offline');
      }
    } catch (error) { this.safeSend(socket, JSON.stringify({ type: 'error', action: value.type, message: cleanText(error?.message, 160, 'request failed') })); }
  }

  async authenticate(socket, attachment, value) {
    if (value?.type === 'account-login') return this.loginAccount(socket, attachment, value);
    if (value?.type !== 'hello') return socket.close(1008, 'authenticate first');
    const id = normalizeId(value.userId), token = normalizeToken(value.token);
    if (!id || !token) return socket.close(1008, 'invalid credentials');
    const hash = await tokenHash(token); let user = await this.user(id);
    if (user) {
      const now = Date.now(), sessions = (user.sessions || []).filter(session => session && typeof session.hash === 'string' && Number(session.expiresAt) > now).slice(-8);
      const legacyValid = user.tokenHash === hash, sessionValid = sessions.some(session => secureEqual(session.hash, hash));
      if (!legacyValid && !sessionValid) return socket.close(1008, 'authentication failed');
      // Once an anonymous identity becomes an account, even its original device
      // credential becomes an expiring, revocable session instead of a forever token.
      if (user.username && legacyValid) { sessions.push({ hash, expiresAt: now + ACCOUNT_SESSION_TTL_MS }); delete user.tokenHash; }
      user.sessions = [...new Map(sessions.map(session => [session.hash, session])).values()].slice(-8);
    }
    if (!user) user = { id, tokenHash: hash, name: cleanText(value.name, 32, 'Knot user'), image: cleanImage(value.image), frame: cleanFrame(value.frame), deviceKey: cleanDeviceKey(value.deviceKey), friends: [], servers: [] };
    else { user.name = cleanText(value.name, 32, user.name); user.image = cleanImage(value.image); user.frame = cleanFrame(value.frame); user.deviceKey = cleanDeviceKey(value.deviceKey) || user.deviceKey || null; }
    await this.putUser(user); attachment.authed = true; attachment.userId = id; attachment.connectedAt = Date.now(); socket.serializeAttachment(attachment);this.limitUserSockets(id, socket);
    this.safeSend(socket, JSON.stringify({ type: 'authenticated', userId: id, username: user.username || '' })); await this.broadcastSnapshots();await this.deliverMailbox(user.id);
  }

  async createAccount(socket, user, value) {
    await this.consumeSecurityBudget('signup', 60 * 60 * 1000, SIGNUP_GLOBAL_LIMIT_PER_HOUR);
    const username = normalizeUsername(value.username), password = cleanPassword(value.password);
    if (!username) throw new Error('username must be 3–24 letters, numbers, dots, dashes, or underscores');
    if (!password) throw new Error('password must be 8–128 characters');
    if (user.username && user.username !== username) throw new Error('this identity already has an account');
    const salt = randomHex(16), hash = await passwordHash(password, salt);
    await this.state.storage.transaction(async transaction => {
      const existing = await transaction.get(`account:${username}`);
      if (existing && existing.userId !== user.id) throw new Error('that username is already taken');
      await transaction.put(`account:${username}`, { userId: user.id, salt, hash });
    });
    const now = Date.now();if (user.tokenHash) { user.sessions = [...(user.sessions || []), { hash: user.tokenHash, expiresAt: now + ACCOUNT_SESSION_TTL_MS }].slice(-8);delete user.tokenHash; }
    user.username = username; await this.putUser(user);
    this.safeSend(socket, JSON.stringify({ type: 'account-session', mode: 'created', userId: user.id, username }));
  }

  async loginAccount(socket, attachment, value) {
    try { await this.consumeSecurityBudget('login', 60 * 1000, LOGIN_GLOBAL_LIMIT_PER_MINUTE); } catch { this.safeSend(socket, JSON.stringify({ type: 'error', action: 'account-login', message: 'username or password is incorrect, or sign-in is temporarily limited' }));return; }
    const username = normalizeUsername(value.username), password = cleanPassword(value.password), account = username ? await this.state.storage.get(`account:${username}`) : null, now = Date.now();
    // Run the same expensive hash for unknown and malformed accounts to avoid
    // turning response timing into a username-enumeration oracle.
    const supplied = await passwordHash(password || 'invalid-password', account?.salt || randomHex(16)), locked = Number(account?.login?.blockedUntil) > now;
    if (!account || !password || locked || !secureEqual(supplied, account.hash)) {
      if (account) { const current = account.login && now - Number(account.login.windowStarted) < LOGIN_WINDOW_MS ? account.login : { windowStarted: now, failures: 0, blockedUntil: 0 };current.failures++;if (current.failures >= LOGIN_MAX_FAILURES) current.blockedUntil = now + LOGIN_WINDOW_MS;account.login = current;await this.state.storage.put(`account:${username}`, account); }
      this.safeSend(socket, JSON.stringify({ type: 'error', action: 'account-login', message: 'username or password is incorrect, or sign-in is temporarily limited' })); return;
    }
    if (account.login) { delete account.login;await this.state.storage.put(`account:${username}`, account); }
    const user = await this.user(account.userId); if (!user) return socket.close(1008, 'account identity is missing');
    const token = randomHex(32), hash = await tokenHash(token); user.sessions = [...(user.sessions || []).filter(session => Number(session?.expiresAt) > now), { hash, expiresAt: now + ACCOUNT_SESSION_TTL_MS }].slice(-8); user.username = username; await this.putUser(user);
    attachment.authed = true; attachment.userId = user.id; attachment.connectedAt = now; socket.serializeAttachment(attachment);this.limitUserSockets(user.id, socket);
    this.safeSend(socket, JSON.stringify({ type: 'account-session', mode: 'login', userId: user.id, token, username }));
  }

  async createInvite(kind, targetId) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const random = new Uint32Array(1); crypto.getRandomValues(random); const code = String(10000 + random[0] % 90000);
      const existing = await this.state.storage.get(`invite:${code}`);
      if (!existing || existing.expires < Date.now()) { await this.state.storage.put(`invite:${code}`, { kind, targetId, expires: Date.now() + INVITE_TTL_MS }); return code; }
    }
    throw new Error('could not allocate an invite code');
  }

  async redeemInvite(user, rawCode) {
    const code = String(rawCode).trim(); if (!/^\d{5}$/.test(code)) throw new Error('invalid invite code');
    const key = `invite:${code}`, invite = await this.state.storage.get(key); await this.state.storage.delete(key);
    if (!invite || invite.expires < Date.now()) throw new Error('invite expired');
    if (invite.kind === 'friend') {
      if (invite.targetId === user.id) throw new Error('that is your own invite');
      const friend = await this.user(invite.targetId); if (!friend) throw new Error('friend account missing');
      if (!user.friends.includes(friend.id)) user.friends.push(friend.id);
      if (!friend.friends.includes(user.id)) friend.friends.push(user.id);
      await this.putUser(user); await this.putUser(friend);
    } else {
      const server = await this.server(invite.targetId); if (!server) throw new Error('server missing');
      if (!server.members.includes(user.id)) server.members.push(user.id);
      if (!user.servers.includes(server.id)) user.servers.push(server.id);
      await this.state.storage.put(`server:${server.id}`, server); await this.putUser(user);
    }
  }

  // Direct messages are encrypted on the sender before this Durable Object sees
  // them. Store only that opaque envelope until the recipient acknowledges a
  // successful local decrypt, then delete it. A bounded TTL/byte cap keeps the
  // free-tier mailbox predictable even if a device stays offline for weeks.
  async relayText(user, value) {
    const scope = value.scope === 'server' ? 'server' : value.scope === 'dm' ? 'dm' : '';
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
    const server = await this.server(value.serverId); this.requireMember(server, user.id);
    const channelId = normalizeId(value.channelId), channel = server.channels.find(item => item.id === channelId && item.type === 'text');
    if (!channel) throw new Error('text channel missing');
    const envelope = { type: 'relay-text', scope: 'server', from: user.id, id, serverId: server.id, channelId, cipher };
    for (const memberId of server.members) if (memberId !== user.id) this.sendUser(memberId, envelope);
  }

  async storeMailbox(userId, envelope) {
    const indexKey = `mail-id:${userId}:${envelope.id}`, existing = await this.state.storage.get(indexKey);
    if (existing) return existing;
    const now = Date.now(), key = `mail:${userId}:${String(now).padStart(13, '0')}:${envelope.id}`;
    const stored = { ...envelope, expiresAt: now + DM_MAILBOX_TTL_MS };
    await this.state.storage.put(key, stored);await this.state.storage.put(indexKey, key);await this.pruneMailbox(userId);return key;
  }

  async pruneMailbox(userId) {
    const entries = [...(await this.state.storage.list({ prefix: `mail:${userId}:` })).entries()];let bytes = 0;
    for (const [, value] of entries) bytes += JSON.stringify(value).length;
    while (entries.length && (entries.length > DM_MAILBOX_MAX_MESSAGES || bytes > DM_MAILBOX_MAX_BYTES || Number(entries[0][1]?.expiresAt) <= Date.now())) {
      const [key, value] = entries.shift();bytes -= JSON.stringify(value).length;await this.state.storage.delete(key);await this.state.storage.delete(`mail-id:${userId}:${value.id}`);
    }
  }

  async deliverMailbox(userId) {
    await this.pruneMailbox(userId);const entries = await this.state.storage.list({ prefix: `mail:${userId}:` });
    for (const [, envelope] of entries) this.sendUser(userId, { ...envelope, offline: true });
  }

  async ackRelayText(user, value) {
    const id = normalizeId(value.id);if (!id) throw new Error('invalid relay acknowledgement');
    const indexKey = `mail-id:${user.id}:${id}`, key = await this.state.storage.get(indexKey);if (!key) return;
    const envelope = await this.state.storage.get(key);if (envelope?.id === id) await this.state.storage.delete(key);await this.state.storage.delete(indexKey);
  }

  // Group-key wrapping is also opaque. A requesting member broadcasts no key;
  // a member that already has the local key sends an ECDH-wrapped copy directly
  // to the requester. Neither form is persisted by this Durable Object.
  async relayGroupKey(user, value) {
    const server = await this.server(value.serverId); this.requireMember(server, user.id);
    const mode = value.mode === 'request' ? 'request' : value.mode === 'deliver' ? 'deliver' : '';
    if (!mode) throw new Error('invalid group-key relay');
    if (mode === 'request') {
      const requestId = normalizeId(value.id); if (!requestId) throw new Error('invalid key request');
      const envelope = { type: 'relay-key', mode: 'request', from: user.id, id: requestId, serverId: server.id };
      for (const memberId of server.members) if (memberId !== user.id) this.sendUser(memberId, envelope);
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

  async snapshot(userId) {
    const user = await this.user(userId); if (!user) return null;
    const friends = (await Promise.all(user.friends.map(id => this.user(id)))).filter(Boolean).map(friend => this.publicUser(friend));
    const servers = (await Promise.all(user.servers.map(id => this.server(id)))).filter(Boolean);
    const memberIds = [...new Set(servers.flatMap(server => server.members))];
    const members = Object.fromEntries((await Promise.all(memberIds.map(id => this.user(id)))).filter(Boolean).map(member => [member.id, this.publicUser(member)]));
    return { type: 'snapshot', self: this.publicUser(user), friends, servers, members, voiceStates: this.voiceStates(servers) };
  }

  publicUser(user) { return { id: user.id, name: user.name, username: user.username || '', image: user.image, frame: cleanFrame(user.frame), deviceKey: cleanDeviceKey(user.deviceKey), online: this.isOnline(user.id) }; }
  voiceStates(servers) { const allowed = new Set(servers.map(server => server.id)), states = {}; for (const socket of this.state.getWebSockets()) { if (socket.readyState !== 1) continue; const attachment = socket.deserializeAttachment() || {}; if (!attachment.authed || !allowed.has(attachment.voiceServerId) || !normalizeId(attachment.voiceChannelId)) continue; const list = states[attachment.voiceChannelId] || (states[attachment.voiceChannelId] = []); if (!list.some(entry => entry.id === attachment.userId)) list.push({ id: attachment.userId, joinedAt: Number(attachment.voiceJoinedAt) || Date.now() }); } return states; }
  isOnline(userId) { return this.state.getWebSockets().some(socket => { const a = socket.deserializeAttachment() || {}; return socket.readyState === 1 && a.authed && a.userId === userId; }); }
  async broadcastSnapshots() { const ids = [...new Set(this.state.getWebSockets().map(socket => (socket.deserializeAttachment() || {}).userId).filter(Boolean))]; for (const id of ids) { const snapshot = await this.snapshot(id); if (snapshot) this.sendUser(id, snapshot); } }
  sendUser(userId, value) { let sent = false, data = JSON.stringify(value); for (const socket of this.state.getWebSockets()) { const a = socket.deserializeAttachment() || {}; if (socket.readyState === 1 && a.authed && a.userId === userId) { this.safeSend(socket, data); sent = true; } } return sent; }
  async consumeSecurityBudget(name, windowMs, limit) { const key = `security-budget:${name}`, now = Date.now();await this.state.storage.transaction(async transaction => { const previous = await transaction.get(key), budget = previous && now - Number(previous.startedAt) < windowMs ? previous : { startedAt: now, count: 0 };if (budget.count >= limit) throw new Error('security rate limit reached; try again later');budget.count++;await transaction.put(key, budget); }); }
  limitUserSockets(userId, current) { const sockets = this.state.getWebSockets().filter(socket => { const attachment = socket.deserializeAttachment() || {}; return socket.readyState === 1 && attachment.authed && attachment.userId === userId; }).sort((left, right) => Number((left.deserializeAttachment() || {}).connectedAt) - Number((right.deserializeAttachment() || {}).connectedAt));while (sockets.length > MAX_USER_SOCKETS) { const socket = sockets.shift();if (socket !== current) try { socket.close(1008, 'too many account sessions'); } catch {} } }
  async canContact(user, peerId) { if (user.friends.includes(peerId)) return true; for (const id of user.servers) { const server = await this.server(id); if (server?.members.includes(peerId)) return true; } return false; }
  cleanContext(value) { const context = value && typeof value === 'object' ? value : {}, type = context.type === 'server' ? 'server' : context.type === 'dm-persistent' ? 'dm-persistent' : 'dm'; return { type, serverId: normalizeId(context.serverId), channelId: normalizeId(context.channelId), relay: type === 'dm' && context.relay === true }; }
  async user(id) { return normalizeId(id) ? this.state.storage.get(`user:${id}`) : null; }
  async server(id) { return normalizeId(id) ? this.state.storage.get(`server:${normalizeId(id)}`) : null; }
  async putUser(user) { user.friends = [...new Set(user.friends.map(normalizeId).filter(Boolean))].slice(0, 500); user.servers = [...new Set(user.servers.map(normalizeId).filter(Boolean))].slice(0, 100); await this.state.storage.put(`user:${user.id}`, user); }
  requireMember(server, userId) { if (!server || !server.members.includes(userId)) throw new Error('not a server member'); }
  requireOwner(server, userId) { this.requireMember(server, userId); if (server.owner !== userId) throw new Error('only the server owner can edit this server'); }
  safeSend(socket, message) { try { socket.send(message); } catch {} }
  withinRate(socket, attachment, bytes) { const now = Date.now(); if (!attachment.rateAt || now - attachment.rateAt >= 1000) { attachment.rateAt = now; attachment.rateBytes = 0;attachment.rateMessages = 0; } attachment.rateBytes = (attachment.rateBytes || 0) + bytes;attachment.rateMessages = (attachment.rateMessages || 0) + 1; socket.serializeAttachment(attachment); if (attachment.rateBytes <= MAX_SOCKET_BYTES_PER_SECOND && attachment.rateMessages <= MAX_SOCKET_MESSAGES_PER_SECOND) return true; socket.close(1008, 'rate limit'); return false; }
  async webSocketClose(socket) { const userId = (socket.deserializeAttachment() || {}).userId; if (userId) await this.broadcastSnapshots(); }
  async webSocketError(socket) { const userId = (socket.deserializeAttachment() || {}).userId; if (userId) await this.broadcastSnapshots(); }
}
