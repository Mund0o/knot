'use strict';

// The UDP side of a screen share, in the main process. A share viewer connects to the sharer over a UDP stream that
// both Knots punched through their NATs (udx-lane.js), and that stream is then run through exactly the same one-time
// token, mutual proof and AES-GCM framing as the file lane (direct-file.js). Nothing new is trusted here: this only
// gives shares their own lanes, peers and limits, so that a file-session reset can never end a share and a share can
// never end a file transfer.
//
// The runtime does not know about windows or IPC. Each lane and peer belongs to an opaque "owner" (the document that
// asked for it); a caller must present the same owner to use or close it, and events say which owner they are for.
const crypto = require('crypto');
const { UdxLanes } = require('./udx-lane');
const { DirectFileHost, connect } = require('./direct-file');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;           // direct-file.js refuses larger frames; the sender splits writes below this
const RECEIVE_HIGH_WATER = 32 * 1024 * 1024;       // unconsumed bytes the renderer may owe before the stream is paused
const RECEIVE_LOW_WATER = 8 * 1024 * 1024;

class ShareLaneRuntime {
  constructor({ sameOwner = (a, b) => a === b, maxPeers = 16, udxOptions = {}, onOpen = () => {}, onFrame = () => {}, onClose = () => {} } = {}) {
    Object.assign(this, { sameOwner, maxPeers, onOpen, onFrame, onClose });
    this.udx = new UdxLanes({ maxLanes: maxPeers, ...udxOptions });
    this.host = new DirectFileHost(0, { maxActive: maxPeers, maxActivePerAddress: maxPeers, highWater: RECEIVE_HIGH_WATER, lowWater: RECEIVE_LOW_WATER });
    this.laneOwners = new Map();     // lane id -> owner
    this.peers = new Map();          // peer id -> { peer, owner }
    this.pending = 0;
    this.closed = false;
  }

  _ownsLane(owner, id) { const record = typeof id === 'string' ? this.laneOwners.get(id) : null; return !!owner && !!record && this.sameOwner(owner, record); }
  _ownsPeer(owner, id) { const record = typeof id === 'string' ? this.peers.get(id) : null; return !!owner && !!record && this.sameOwner(owner, record.owner) ? record : null; }
  _sweepLanes() { for (const id of [...this.laneOwners.keys()]) if (!this.udx.lanes.has(id)) this.laneOwners.delete(id); }

  async open(owner) {
    if (this.closed || !owner) throw new Error('share lanes are not available');
    this._sweepLanes();
    const lane = await this.udx.open();
    if (this.closed) { this.udx.close(lane.id); throw new Error('share lanes were closed'); }
    this.laneOwners.set(lane.id, owner);
    return { id: lane.id, streamId: lane.streamId, endpoints: lane.endpoints };
  }

  // The viewer's side of a lane waits for the sharer's connection: it registers the one-time token first.
  register(owner, token, key) {
    if (this.closed || !owner || !TOKEN_PATTERN.test(token || '') || !Buffer.isBuffer(key) || key.length !== 32) return false;
    try { this.host.register(token, key, (peer, hello) => this._attach(owner, peer, hello)); return true; } catch { return false; }
  }

  // Both Knots call this at the same moment with each other's endpoints. 'connect' (the sharer) resolves with the new peer's id;
  // 'accept' (the viewer) resolves with true and the peer then arrives through onOpen.
  async establish(owner, { laneId, role, token, key, remote, timeoutMs, holdMs }) {
    if (!this._ownsLane(owner, laneId) || (role !== 'accept' && role !== 'connect') || !TOKEN_PATTERN.test(token || '')) throw new Error('invalid share lane request');
    if (role === 'connect' && (!Buffer.isBuffer(key) || key.length !== 32)) throw new Error('invalid share lane credentials');
    if (this.peers.size + this.pending >= this.maxPeers) throw new Error('too many share lanes');
    this.pending++;
    try {
      const socket = await this.udx.establish(laneId, {
        token, timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(15000, Math.floor(timeoutMs))) : undefined,
        holdMs: Number.isFinite(holdMs) ? Math.max(0, Math.min(30000, Math.floor(holdMs))) : undefined,
        remote: { streamId: Number(remote?.streamId), endpoints: Array.isArray(remote?.endpoints) ? remote.endpoints.slice(0, 16) : [] },
      });
      if (this.closed || !this._ownsLane(owner, laneId)) { socket.destroy(); throw new Error('share lane was closed'); }
      if (role === 'accept') { this.host.acceptStream(socket); return true; }
      const peer = await connect(null, null, token, key, { socket, timeout: 5000 });
      if (this.closed) { peer.close(); throw new Error('share lanes were closed'); }
      return this._attach(owner, peer, { token });
    } catch (error) { this.closeLane(owner, laneId); throw error; }
    finally { this.pending--; }
  }

  release(owner, laneId) { return this._ownsLane(owner, laneId) ? this.udx.release(laneId) : false; }

  _attach(owner, peer, context = {}) {
    if (this.closed || this.peers.size >= this.maxPeers) { try { peer.close(); } catch {} throw new Error('share lane limit reached'); }
    const id = crypto.randomBytes(12).toString('hex'), record = { peer, owner };
    this.peers.set(id, record);
    peer.onFrame = frame => { if (this.peers.get(id) === record) this.onFrame({ owner, peerId: id, frame }); };
    peer.onClose = () => { if (this.peers.get(id) !== record) return; this.peers.delete(id); this.onClose({ owner, peerId: id }); };
    try { this.onOpen({ owner, peerId: id, token: typeof context.token === 'string' ? context.token : '' }); }
    catch (error) { this.peers.delete(id); try { peer.close(); } catch {} throw error; }
    return id;
  }

  // Resolves once the lane has taken the bytes (immediately when it has room, after it drains when it does not).
  send(owner, peerId, bytes) {
    const record = this._ownsPeer(owner, peerId);
    if (!record) return Promise.reject(new Error('unknown share lane'));
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_FRAME_BYTES) return Promise.reject(new Error('invalid share frame'));
    return record.peer.sendAsync(bytes);
  }

  // What each UDP stream thinks of the path it runs over, for the share log: congestion window (packets), round trip (ms), bytes in flight, packets sent
  // again, fast recoveries and timeouts since it started, and the bandwidth it has measured (Mbit/s). A stream that keeps sending packets again while
  // little is lost is reading reordering as loss: the window and the measured bandwidth fall, and the share slows to a crawl (reproduced under netem).
  stats() {
    const out = [];
    for (const [id, record] of this.peers) {
      try {
        const stream = record.peer?.socket?.stream;
        if (!stream) continue;
        out.push({ id: id.slice(0, 6), cwnd: stream.cwnd, rttMs: stream.rtt, inflight: stream.inflight, retransmits: stream.retransmits, fastRecoveries: stream.fastRecoveries, timeouts: stream.rtoCount, bandwidthMbps: Math.round((Number(stream.bbrBandwidth) || 0) * 8 / 1e5) / 10 });
      } catch {}
    }
    return out;
  }

  // Bytes the renderer has finished with: lets the receive side keep reading.
  credit(owner, peerId, count) { this._ownsPeer(owner, peerId)?.peer.credit(count); }

  closePeer(owner, peerId) { const record = this._ownsPeer(owner, peerId); if (record) { try { record.peer.close(); } catch {} } }
  closeLane(owner, laneId) { if (!this._ownsLane(owner, laneId)) return false; this.laneOwners.delete(laneId); return this.udx.close(laneId); }

  // Everything one document owned (it navigated away or was closed).
  closeOwner(owner) {
    for (const [id, owned] of [...this.laneOwners]) if (this.sameOwner(owner, owned)) { this.laneOwners.delete(id); this.udx.close(id); }
    for (const [, record] of [...this.peers]) if (this.sameOwner(owner, record.owner)) { try { record.peer.close(); } catch {} }
  }

  close() {
    this.closed = true;
    for (const [, record] of [...this.peers]) { try { record.peer.close(); } catch {} }
    this.peers.clear(); this.laneOwners.clear();
    try { this.udx.closeAll(); } catch {}
    try { this.host.close(); } catch {}
  }
}

module.exports = { ShareLaneRuntime, MAX_FRAME_BYTES };
