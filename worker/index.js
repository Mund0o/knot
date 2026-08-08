const MAX_ROOM_PEERS = 2;
const MAX_SIGNAL_BYTES = 2 * 1024 * 1024;
const MAX_SOCKET_BYTES_PER_SECOND = 32 * 1024 * 1024;

function normalizeRoom(value) {
  const room = String(value || '').trim().toUpperCase();
  const parts = room.split(':');
  const [base, suffix] = parts;
  if (parts.length > 2 || !/^(?:\d{5}|[A-Z0-9_-]{16,64})$/.test(base)) return '';
  if (suffix !== undefined && suffix !== 'STREAM') return '';
  return suffix ? `${base}:STREAM` : base;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);
      return jsonResponse({
        service: 'Pair signaling',
        status: 'ready',
        transport: 'websocket',
        privacy: 'ephemeral two-person rooms'
      });
    }

    const room = normalizeRoom(url.searchParams.get('room'));
    if (!room) return jsonResponse({ error: 'invalid invite code' }, 400);

    const id = env.PAIR_ROOMS.idFromName(room);
    const stub = env.PAIR_ROOMS.get(id);
    const headers = new Headers(request.headers);
    headers.set('x-pair-room', room);
    return stub.fetch(new Request(request, { headers }));
  }
};

export class PairRoom {
  constructor(state) {
    this.state = state;
  }

  fetch(request) {
    const room = normalizeRoom(request.headers.get('x-pair-room'));
    if (!room || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return jsonResponse({ error: 'websocket upgrade required' }, 426);
    }

    const live = this.state.getWebSockets();
    if (live.length >= MAX_ROOM_PEERS) {
      const fullPair = new WebSocketPair();
      const client = fullPair[0];
      const server = fullPair[1];
      server.serializeAttachment({ room, joined: false, full: true, rateAt: Date.now(), rateBytes: 0 });
      this.state.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'full' }));
      return new Response(null, { status: 101, webSocket: client });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ room, joined: false, rateAt: Date.now(), rateBytes: 0 });
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment() || {};
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (!this.withinRate(socket, attachment, bytes)) return;

    if (typeof message !== 'string') {
      if (!attachment.joined || !attachment.room?.endsWith(':STREAM')) return;
      this.broadcast(socket, message, attachment.room);
      return;
    }

    if (bytes > MAX_SIGNAL_BYTES) {
      socket.close(1009, 'message too large');
      return;
    }

    let value;
    try { value = JSON.parse(message); } catch { return; }

    if (value?.type === 'join') {
      const requestedRoom = normalizeRoom(value.room);
      if (!requestedRoom || requestedRoom !== attachment.room) {
        socket.send(JSON.stringify({ type: 'error', message: 'Room does not match this connection.' }));
        socket.close(1008, 'room mismatch');
        return;
      }
      if (attachment.joined) return;
      attachment.joined = true;
      socket.serializeAttachment(attachment);
      const joined = this.joinedSockets(attachment.room);
      socket.send(JSON.stringify({ type: 'joined', count: joined.length }));
      if (joined.length === MAX_ROOM_PEERS) {
        for (const peer of joined) this.safeSend(peer, JSON.stringify({ type: 'peer-ready' }));
      }
      return;
    }

    if (attachment.joined && value?.type === 'signal') {
      this.broadcast(socket, message, attachment.room);
    }
  }

  // A disconnected WebRTC peer is detected by the browser's ICE state. There
  // is no need to fan out an extra message while the room's sockets themselves
  // are closing, which also keeps simultaneous app shutdowns noise-free.
  webSocketClose() {}

  webSocketError() {}

  joinedSockets(room) {
    return this.state.getWebSockets().filter(socket => {
      const attachment = socket.deserializeAttachment() || {};
      return attachment.joined && attachment.room === room;
    });
  }

  broadcast(sender, message, room) {
    for (const socket of this.joinedSockets(room)) {
      if (socket !== sender) this.safeSend(socket, message);
    }
  }

  safeSend(socket, message) {
    try { socket.send(message); } catch {}
  }

  withinRate(socket, attachment, bytes) {
    const now = Date.now();
    if (!attachment.rateAt || now - attachment.rateAt >= 1000) {
      attachment.rateAt = now;
      attachment.rateBytes = 0;
    }
    attachment.rateBytes = (attachment.rateBytes || 0) + bytes;
    socket.serializeAttachment(attachment);
    if (attachment.rateBytes <= MAX_SOCKET_BYTES_PER_SECOND) return true;
    socket.close(1008, 'rate limit');
    return false;
  }
}
