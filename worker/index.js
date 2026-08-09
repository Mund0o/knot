const MAX_ROOM_PEERS = 2;
const MAX_SIGNAL_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 768 * 1024;
const MAX_SOCKET_BYTES_PER_SECOND = 4 * 1024 * 1024;
const INVITE_TTL_MS = 15 * 60 * 1000;

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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
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
      return jsonResponse({ service: 'Pair control plane', status: 'ready', transport: 'websocket', contentRelay: false });
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
    // Signaling is deliberately text-only. Pair content must never traverse the Worker.
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
  withinRate(socket, attachment, bytes) { const now = Date.now(); if (!attachment.rateAt || now - attachment.rateAt >= 1000) { attachment.rateAt = now; attachment.rateBytes = 0; } attachment.rateBytes = (attachment.rateBytes || 0) + bytes; socket.serializeAttachment(attachment); if (attachment.rateBytes <= MAX_SOCKET_BYTES_PER_SECOND) return true; socket.close(1008, 'rate limit'); return false; }
}

export class PairDirectory {
  constructor(state) { this.state = state; }

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
      if (value.type === 'update-profile') {
        user.name = cleanText(value.name, 32, user.name || 'Pair user');
        user.image = cleanImage(value.image);
        user.frame = cleanFrame(value.frame);
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
    if (value?.type !== 'hello') return socket.close(1008, 'authenticate first');
    const id = normalizeId(value.userId), token = normalizeToken(value.token);
    if (!id || !token) return socket.close(1008, 'invalid credentials');
    const hash = await tokenHash(token); let user = await this.user(id);
    if (user && user.tokenHash !== hash) return socket.close(1008, 'authentication failed');
    if (!user) user = { id, tokenHash: hash, name: cleanText(value.name, 32, 'Pair user'), image: cleanImage(value.image), frame: cleanFrame(value.frame), friends: [], servers: [] };
    else { user.name = cleanText(value.name, 32, user.name); user.image = cleanImage(value.image); user.frame = cleanFrame(value.frame); }
    await this.putUser(user); attachment.authed = true; attachment.userId = id; socket.serializeAttachment(attachment);
    this.safeSend(socket, JSON.stringify({ type: 'authenticated', userId: id })); await this.broadcastSnapshots();
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

  async snapshot(userId) {
    const user = await this.user(userId); if (!user) return null;
    const friends = (await Promise.all(user.friends.map(id => this.user(id)))).filter(Boolean).map(friend => this.publicUser(friend));
    const servers = (await Promise.all(user.servers.map(id => this.server(id)))).filter(Boolean);
    const memberIds = [...new Set(servers.flatMap(server => server.members))];
    const members = Object.fromEntries((await Promise.all(memberIds.map(id => this.user(id)))).filter(Boolean).map(member => [member.id, this.publicUser(member)]));
    return { type: 'snapshot', self: this.publicUser(user), friends, servers, members, voiceStates: this.voiceStates(servers) };
  }

  publicUser(user) { return { id: user.id, name: user.name, image: user.image, frame: cleanFrame(user.frame), online: this.isOnline(user.id) }; }
  voiceStates(servers) { const allowed = new Set(servers.map(server => server.id)), states = {}; for (const socket of this.state.getWebSockets()) { if (socket.readyState !== 1) continue; const attachment = socket.deserializeAttachment() || {}; if (!attachment.authed || !allowed.has(attachment.voiceServerId) || !normalizeId(attachment.voiceChannelId)) continue; const list = states[attachment.voiceChannelId] || (states[attachment.voiceChannelId] = []); if (!list.some(entry => entry.id === attachment.userId)) list.push({ id: attachment.userId, joinedAt: Number(attachment.voiceJoinedAt) || Date.now() }); } return states; }
  isOnline(userId) { return this.state.getWebSockets().some(socket => { const a = socket.deserializeAttachment() || {}; return socket.readyState === 1 && a.authed && a.userId === userId; }); }
  async broadcastSnapshots() { const ids = [...new Set(this.state.getWebSockets().map(socket => (socket.deserializeAttachment() || {}).userId).filter(Boolean))]; for (const id of ids) { const snapshot = await this.snapshot(id); if (snapshot) this.sendUser(id, snapshot); } }
  sendUser(userId, value) { let sent = false, data = JSON.stringify(value); for (const socket of this.state.getWebSockets()) { const a = socket.deserializeAttachment() || {}; if (socket.readyState === 1 && a.authed && a.userId === userId) { this.safeSend(socket, data); sent = true; } } return sent; }
  async canContact(user, peerId) { if (user.friends.includes(peerId)) return true; for (const id of user.servers) { const server = await this.server(id); if (server?.members.includes(peerId)) return true; } return false; }
  cleanContext(value) { const context = value && typeof value === 'object' ? value : {}; return { type: context.type === 'server' ? 'server' : 'dm', serverId: normalizeId(context.serverId), channelId: normalizeId(context.channelId) }; }
  async user(id) { return normalizeId(id) ? this.state.storage.get(`user:${id}`) : null; }
  async server(id) { return normalizeId(id) ? this.state.storage.get(`server:${normalizeId(id)}`) : null; }
  async putUser(user) { user.friends = [...new Set(user.friends.map(normalizeId).filter(Boolean))].slice(0, 500); user.servers = [...new Set(user.servers.map(normalizeId).filter(Boolean))].slice(0, 100); await this.state.storage.put(`user:${user.id}`, user); }
  requireMember(server, userId) { if (!server || !server.members.includes(userId)) throw new Error('not a server member'); }
  requireOwner(server, userId) { this.requireMember(server, userId); if (server.owner !== userId) throw new Error('only the server owner can edit this server'); }
  safeSend(socket, message) { try { socket.send(message); } catch {} }
  withinRate(socket, attachment, bytes) { const now = Date.now(); if (!attachment.rateAt || now - attachment.rateAt >= 1000) { attachment.rateAt = now; attachment.rateBytes = 0; } attachment.rateBytes = (attachment.rateBytes || 0) + bytes; socket.serializeAttachment(attachment); if (attachment.rateBytes <= MAX_SOCKET_BYTES_PER_SECOND) return true; socket.close(1008, 'rate limit'); return false; }
  async webSocketClose(socket) { const userId = (socket.deserializeAttachment() || {}).userId; if (userId) await this.broadcastSnapshots(); }
  async webSocketError(socket) { const userId = (socket.deserializeAttachment() || {}).userId; if (userId) await this.broadcastSnapshots(); }
}
