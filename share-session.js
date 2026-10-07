(function installShareSession(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotShareSession = api;
})(typeof window === 'object' ? window : typeof globalThis === 'object' ? globalThis : null, root => {
  // The two ends of a screen share and the conversation between them. ShareHost belongs to the person sharing: it takes the
  // encoded pictures from a capture, keeps them for every viewer, and sends them over a data channel at once and over a punched
  // UDP lane as soon as that exists. ShareViewer belongs to someone watching: it asks to watch, collects what arrives on either
  // lane, tells the sharer how far it has got, and hands pictures to a player.
  //
  // Nothing here touches the network itself. The control messages go through sendControl() (the encrypted channel two Knots
  // already share), data channels are handed in, and UDP lanes are reached through a small runtime object whose shape matches
  // window.pairShareLane. That is what makes the whole conversation testable with real UDP and no browser.
  const Core = (typeof require === 'function' && typeof module === 'object') ? require('./share-core') : root.KnotShareCore;
  const Wire = (typeof require === 'function' && typeof module === 'object') ? require('./share-wire') : root.KnotShareWire;
  const { ShareSender, ShareReceiver } = Core;
  const { TYPE } = Wire;

  const HEARTBEAT_MS = 100;            // a still screen says so this often: inside the playout delay, or the viewer's buffer drains between beats
  const ACK_MS = 200;
  const TICK_MS = 250;
  const DC_CHUNK = 60 * 1024;          // data channel messages stay well below the 256 KiB limit
  const DC_HIGH_WATER = 1024 * 1024;   // little is queued in the data channel: whatever is, a switch to UDP sends a second time
  const DC_LOW_WATER = 256 * 1024;
  const UDX_WRITE_HIGH = 4 * 1024 * 1024;
  const UDX_READY_TIMEOUT_MS = 12000;
  const UDX_PUNCH_MS = 8000;
  const UDX_RETRY_MS = [15000, 30000, 60000];
  const MAX_UDX_VIEWERS = 8;
  const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
  const SHARE_ID = /^[A-Za-z0-9_-]{8,64}$/;

  const randomHex = bytes => { const a = new Uint8Array(bytes); (root?.crypto || require('crypto').webcrypto).getRandomValues(a); return Array.from(a, v => v.toString(16).padStart(2, '0')).join(''); };
  const hexToBytes = hex => { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; };
  const cleanEndpoints = list => (Array.isArray(list) ? list : []).filter(e => e && typeof e.ip === 'string' && Number.isInteger(e.port)).slice(0, 16).map(e => ({ ip: e.ip, port: e.port, kind: e.kind === 'host' ? 'host' : 'srflx' }));

  // A data channel as a lane: writes are cut into messages the transport accepts, and "no room" is reported when too much is queued.
  function createDcLane(channel, { onWritable = () => {} } = {}) {
    channel.bufferedAmountLowThreshold = DC_LOW_WATER;
    channel.onbufferedamountlow = () => onWritable();
    return {
      write(bytes) {
        for (let at = 0; at < bytes.length; at += DC_CHUNK) channel.send(bytes.subarray(at, Math.min(bytes.length, at + DC_CHUNK)));
        return channel.bufferedAmount < DC_HIGH_WATER;
      },
      close() { try { channel.close(); } catch {} },
    };
  }

  // ------------------------------------------------------------------------------------------------------------ sharing
  class ShareHost {
    constructor({ shareId, config, sendControl, openDataChannel, lanes = null, now = () => Date.now(), setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = h => clearInterval(h), setDelay = (fn, ms) => setTimeout(fn, ms), clearDelay = h => clearTimeout(h), log = () => {}, onViewerLost = () => {}, senderOptions = {} }) {
      if (!SHARE_ID.test(shareId || '')) throw new Error('invalid share id');
      Object.assign(this, { shareId, sendControl, openDataChannel, lanes, now, setDelay, clearDelay, log, onViewerLost });
      this.sender = new ShareSender({ now, emit: event => this._onSenderEvent(event), ...senderOptions });
      this.viewers = new Map();       // viewer id -> { udx state, dc lane ... }
      this.unknownAt = new Map();     // viewer id -> when it was last told that the sharer does not know it
      this.lastPts = 0; this.lastRecordAt = now();
      this.destroyed = false; this.ended = false;
      this.sender.setConfig(config);
      this.timer = setTimer(() => this._tick(), HEARTBEAT_MS);
      this.tickCount = 0; this._clear = clearTimer;
      if (lanes) {
        lanes.onClose?.(peerId => this._onPeerClosed(peerId));
      }
    }

    get config() { return this.sender.config; }

    // The offer every candidate viewer gets: what is being shared and how it is described.
    offer() { return { t: 'share-offer', shareId: this.shareId, v: 2, config: this.sender.config }; }

    setConfig(config) { this.sender.setConfig(config); }

    pushFrame(frame) {
      if (this.destroyed || this.ended) return -1;
      this.lastPts = frame.pts; this.lastRecordAt = this.now();
      return this.sender.pushFrame(frame);
    }

    _tick() {
      if (this.destroyed) return;
      const t = this.now();
      if (!this.ended && t - this.lastRecordAt >= HEARTBEAT_MS) {
        // The sharer's picture clock keeps running while nothing changes: each beat carries the time of the last record plus what has passed.
        this.lastPts += (t - this.lastRecordAt) * 1000; this.lastRecordAt = t;
        this.sender.heartbeat(this.lastPts);
      }
      if (++this.tickCount % Math.round(TICK_MS / HEARTBEAT_MS) === 0) this.sender.tick();
    }

    _onSenderEvent(event) {
      if (event.type === 'config') { for (const id of this.viewers.keys()) this.sendControl(id, { t: 'share-config', shareId: this.shareId, version: event.version, config: event.config }); }
      else if (event.type === 'gap') { this.log(`viewer ${event.viewerId} moved up (${event.reason}) over ${event.from}..${event.to}`); this.sendControl(event.viewerId, { t: 'share-gap', shareId: this.shareId, from: event.from, to: event.to, reason: event.reason }); }
      else if (event.type === 'viewer-timeout') { this.log(`viewer ${event.viewerId} stopped answering`); this.removeViewer(event.viewerId); this.onViewerLost(event.viewerId); }
    }

    // A viewer asked to watch.
    addViewer(viewerId, { udx = false } = {}) {
      if (this.destroyed || this.ended) return false;
      this.removeViewer(viewerId);
      const offer = this.sender.addViewer(viewerId);
      const entry = { id: viewerId, dc: null, udx: { state: 'idle', laneId: '', token: '', peerId: '', attempts: 0, timer: null, wait: null }, wantsUdx: !!udx, outstanding: 0, udxBlocked: false };
      this.viewers.set(viewerId, entry);
      this.sendControl(viewerId, { t: 'share-start', shareId: this.shareId, startSeq: offer.startSeq, configVersion: offer.configVersion, config: offer.config });
      const channel = this.openDataChannel(viewerId, 'knot-share-' + this.shareId);
      if (channel) {
        entry.dc = createDcLane(channel, { onWritable: () => this.sender.laneWritable(viewerId, 'dc') });
        // A data channel refuses to send until it is open, and the records are already waiting: the lane joins the moment it opens.
        const attach = () => { if (this.viewers.get(viewerId) === entry) this.sender.attachLane(viewerId, 'dc', { kind: 'dc', write: bytes => entry.dc.write(bytes), close: () => entry.dc.close() }); };
        if (channel.readyState === 'open') attach(); else channel.onopen = attach;
        channel.onclose = () => { if (this.viewers.get(viewerId) === entry) this.sender.removeLane(viewerId, 'dc'); };
      }
      if (entry.wantsUdx && this.lanes && this._udxCount() < MAX_UDX_VIEWERS) this._startUdx(viewerId);
      return true;
    }

    removeViewer(viewerId) {
      const entry = this.viewers.get(viewerId);
      if (!entry) return;
      this.viewers.delete(viewerId);
      this._abandonUdx(entry);
      this.sender.removeViewer(viewerId);
    }

    _udxCount() { let n = 0; for (const e of this.viewers.values()) if (e.udx.state === 'connecting' || e.udx.state === 'ready' || e.udx.state === 'offered') n++; return n; }

    // ---- UDP lane: offer, wait for the viewer's answer, punch, attach.
    async _startUdx(viewerId) {
      const entry = this.viewers.get(viewerId);
      if (!entry || this.destroyed || entry.udx.state !== 'idle') return;
      const udx = entry.udx; udx.state = 'offered'; udx.attempts++;
      let lane = null;
      try {
        lane = await this.lanes.open();
        if (!lane?.ok) throw new Error(lane?.error || 'no UDP lane');
        if (this.viewers.get(viewerId) !== entry) { this.lanes.close(lane.id); return; }
        udx.laneId = lane.id; udx.token = randomHex(24); udx.key = randomHex(32);
        this.sendControl(viewerId, { t: 'share-udx-offer', shareId: this.shareId, token: udx.token, key: udx.key, streamId: lane.streamId, endpoints: lane.endpoints });
        const remote = await new Promise((resolve, reject) => {
          udx.wait = { resolve, reject, timer: this.setDelay(() => reject(new Error('the viewer did not answer the UDP lane offer')), UDX_READY_TIMEOUT_MS) };
        });
        if (this.viewers.get(viewerId) !== entry) return;
        udx.state = 'connecting';
        // The viewer is already punching with low-TTL packets; ours go out at once and we say so, which lets its normal punches start.
        const connecting = this.lanes.establish({ id: lane.id, role: 'connect', token: udx.token, key: hexToBytes(udx.key), remote, timeout: UDX_PUNCH_MS, hold: 0 });
        connecting.catch(() => {});
        this.sendControl(viewerId, { t: 'share-udx-armed', shareId: this.shareId, token: udx.token });
        const peerId = await connecting;
        if (this.viewers.get(viewerId) !== entry || this.destroyed) { try { this.lanes.closePeer(peerId); } catch {} return; }
        udx.peerId = peerId; udx.state = 'ready'; entry.outstanding = 0; entry.udxBlocked = false;
        this.sender.attachLane(viewerId, 'udx', {
          kind: 'udx', close: () => { try { this.lanes.closePeer(peerId); } catch {} },
          write: bytes => this._writeUdx(entry, peerId, bytes),
        });
        this.log(`viewer ${viewerId} is on the UDP lane`);
      } catch (error) {
        if (this.viewers.get(viewerId) !== entry) return;
        this.log(`UDP lane for ${viewerId} failed: ${error?.message || error}`);
        this._abandonUdx(entry, false);
        const delay = UDX_RETRY_MS[udx.attempts - 1];
        if (delay && !this.destroyed) udx.timer = this.setDelay(() => { udx.timer = null; udx.state = 'idle'; this._startUdx(viewerId); }, delay);
        else udx.state = 'failed';
      }
    }

    _writeUdx(entry, peerId, bytes) {
      // Pieces below the transport's frame limit, written at once; the lane applies its own flow control and reports when it has drained.
      let room = true;
      for (let at = 0; at < bytes.length; at += 4 * 1024 * 1024) {
        const piece = bytes.subarray(at, Math.min(bytes.length, at + 4 * 1024 * 1024));
        entry.outstanding += piece.length;
        Promise.resolve(this.lanes.send(peerId, piece)).catch(() => {}).finally(() => {
          entry.outstanding -= piece.length;
          if (entry.udxBlocked && entry.outstanding < UDX_WRITE_HIGH / 2) { entry.udxBlocked = false; this.sender.laneWritable(entry.id, 'udx'); }
        });
      }
      if (entry.outstanding >= UDX_WRITE_HIGH) { entry.udxBlocked = true; room = false; }
      return room;
    }

    _abandonUdx(entry, closePeer = true) {
      const udx = entry.udx;
      if (udx.wait) { this.clearDelay(udx.wait.timer); udx.wait = null; }
      if (udx.timer) { this.clearDelay(udx.timer); udx.timer = null; }
      if (udx.laneId) { try { this.lanes?.close(udx.laneId); } catch {} udx.laneId = ''; }
      if (closePeer && udx.peerId) { try { this.lanes?.closePeer(udx.peerId); } catch {} }
      if (closePeer) this.sender.removeLane(entry.id, 'udx');
      udx.peerId = ''; udx.state = udx.state === 'failed' ? 'failed' : 'idle';
    }

    _onPeerClosed(peerId) {
      for (const entry of this.viewers.values()) {
        if (entry.udx.peerId !== peerId) continue;
        this.log(`UDP lane to ${entry.id} closed; carrying on over the data channel`);
        entry.udx.peerId = ''; entry.udx.state = 'idle'; entry.udx.laneId = '';
        this.sender.removeLane(entry.id, 'udx');
        const delay = UDX_RETRY_MS[Math.min(entry.udx.attempts, UDX_RETRY_MS.length) - 1] || UDX_RETRY_MS.at(-1);
        if (!this.destroyed && !this.ended && entry.wantsUdx && entry.udx.attempts < 6) { entry.udx.attempts++; entry.udx.timer = this.setDelay(() => { entry.udx.timer = null; this._startUdx(entry.id); }, delay); }
      }
    }

    // ---- what viewers send back
    onControl(viewerId, message) {
      const entry = this.viewers.get(viewerId);
      if (!message || message.shareId !== this.shareId) return;
      switch (message.t) {
        case 'share-ack': if (entry && Number.isInteger(message.seq)) this.sender.onAck(viewerId, message.seq); else if (!entry) this._tellUnknown(viewerId); break;
        case 'share-resend': if (entry) this.sender.onResend(viewerId); else this._tellUnknown(viewerId); break;
        case 'share-unwatch': this.removeViewer(viewerId); break;
        case 'share-udx-ready': {
          const udx = entry?.udx;
          if (!udx?.wait || message.token !== udx.token || !Number.isInteger(message.streamId)) break;
          this.clearDelay(udx.wait.timer); const { resolve } = udx.wait; udx.wait = null;
          resolve({ streamId: message.streamId, endpoints: cleanEndpoints(message.endpoints) });
          break;
        }
        case 'share-udx-no': { const udx = entry?.udx; if (udx?.wait && message.token === udx.token) { this.clearDelay(udx.wait.timer); const { reject } = udx.wait; udx.wait = null; reject(new Error('the viewer cannot use a UDP lane')); } break; }
        default: break;
      }
    }

    // A viewer keeps acknowledging a share the sharer let go of (it was silent for too long). Saying so, once in a while, lets that viewer
    // ask again; nothing else makes it do so, so a stalled link never makes a viewer give up its place.
    _tellUnknown(viewerId) {
      if (this.ended || this.destroyed) return;
      const t = this.now();
      if (t - (this.unknownAt.get(viewerId) || 0) < 2000) return;
      this.unknownAt.set(viewerId, t);
      this.sendControl(viewerId, { t: 'share-unknown', shareId: this.shareId });
    }

    // Resolves once every viewer has acknowledged everything (the end included), or after timeoutMs.
    whenDrained(timeoutMs = 5000) {
      return new Promise(resolve => {
        const started = this.now();
        const check = () => {
          const behind = this.sender.stats().viewers.some(v => v.behind > 0);
          if (!behind || this.destroyed || this.now() - started >= timeoutMs) return resolve(!behind);
          this.setDelay(check, 50);
        };
        check();
      });
    }

    stats() { return { ...this.sender.stats(), udx: [...this.viewers.values()].map(e => ({ id: e.id, state: e.udx.state, attempts: e.udx.attempts })) }; }

    // Everything already captured is still delivered; the end follows it.
    end(reason = 'ended') {
      if (this.ended) return;
      this.ended = true; this.sender.end();
      for (const id of this.viewers.keys()) this.sendControl(id, { t: 'share-end', shareId: this.shareId, reason });
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this._clear(this.timer);
      for (const entry of [...this.viewers.values()]) this._abandonUdx(entry);
      this.viewers.clear(); this.unknownAt.clear();
    }
  }

  // ------------------------------------------------------------------------------------------------------------ watching
  class ShareViewer {
    constructor({ shareId, sendControl, player, lanes = null, now = () => Date.now(), setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = h => clearInterval(h), log = () => {}, onEnded = () => {}, onGap = () => {} }) {
      if (!SHARE_ID.test(shareId || '')) throw new Error('invalid share id');
      Object.assign(this, { shareId, sendControl, player, lanes, now, log, onEnded, onGap });
      this.receiver = new ShareReceiver({
        now, onRecord: record => this._onRecord(record), onStuck: () => this.sendControl({ t: 'share-resend', shareId }), onLaneError: (laneId, error) => this._laneFailed(laneId, error),
      });
      this.started = false; this.ended = false; this.stopped = false; this.finalAckSent = false;
      this.udx = { laneId: '', token: '', peerId: '' };
      this.configs = new Map();
      this.timer = setTimer(() => this._tick(), ACK_MS); this._clear = clearTimer;
      lanes?.onOpen?.((peerId, token) => this._onPeerOpen(peerId, token));
      lanes?.onFrame?.((peerId, bytes) => { if (peerId === this.udx.peerId) { this.receiver.pushBytes('udx', bytes); this.lanes.credit(peerId, bytes.length); } });
      lanes?.onClose?.(peerId => { if (peerId === this.udx.peerId) { this.udx.peerId = ''; this.receiver.removeLane('udx'); } });
    }

    watch() { this.sendControl({ t: 'share-watch', shareId: this.shareId, caps: { udx: !!this.lanes } }); }

    // The sharer made a data channel for this share.
    attachDataChannel(channel) {
      channel.binaryType = 'arraybuffer';
      channel.onmessage = event => { const data = event.data; this.receiver.pushBytes('dc', data instanceof Uint8Array ? data : new Uint8Array(data)); };
      channel.onclose = () => this.receiver.removeLane('dc');
    }

    onControl(message) {
      if (!message || message.shareId !== this.shareId || this.stopped) return;
      switch (message.t) {
        case 'share-start':
          if (!Number.isInteger(message.startSeq) || message.startSeq < 0 || !message.config || typeof message.config.codec !== 'string') return;
          this.configs.set(message.configVersion, message.config);
          this.player.configure(message.config);
          if (!this.started) { this.started = true; this.receiver.start(message.startSeq); }
          // The sharer started this viewer over (it let go of it and the viewer asked again). Records before startSeq will never come:
          // jump there, and the player starts again from that key picture. A startSeq the viewer is already past changes nothing.
          else if (message.startSeq > this.receiver.expected) { const from = this.receiver.expected; this.receiver.skipTo(message.startSeq); this.player.skip?.(); this.onGap({ from, to: message.startSeq - 1, reason: 'rejoined' }); }
          break;
        case 'share-config':
          if (message.config && typeof message.config.codec === 'string') { this.configs.set(message.version, message.config); this.player.configure(message.config); }
          break;
        case 'share-gap':
          if (Number.isInteger(message.to)) { this.receiver.skipTo(message.to + 1); this.player.skip?.(); this.onGap({ from: message.from, to: message.to, reason: message.reason }); }
          break;
        case 'share-end': this.endedByHost = true; break;
        case 'share-unknown': this.watch(); break;      // the sharer let go of this viewer: ask again
        case 'share-udx-offer': this._answerUdx(message); break;
        case 'share-udx-armed': if (message.token === this.udx.token && this.udx.laneId) { try { this.lanes.release(this.udx.laneId); } catch {} } break;
        default: break;
      }
    }

    async _answerUdx(offer) {
      const refuse = () => this.sendControl({ t: 'share-udx-no', shareId: this.shareId, token: offer.token });
      if (!this.lanes || this.udx.laneId || !TOKEN.test(offer.token || '') || !/^[0-9a-f]{64}$/.test(offer.key || '') || !Number.isInteger(offer.streamId)) return refuse();
      try {
        const local = await this.lanes.open();
        if (!local?.ok) throw new Error(local?.error || 'no UDP lane');
        if (this.stopped) { this.lanes.close(local.id); return; }
        this.udx = { laneId: local.id, token: offer.token, peerId: '' };
        if (!await this.lanes.register(offer.token, hexToBytes(offer.key))) throw new Error('could not authorize the lane');
        const accepting = this.lanes.establish({ id: local.id, role: 'accept', token: offer.token, remote: { streamId: offer.streamId, endpoints: cleanEndpoints(offer.endpoints) }, timeout: UDX_PUNCH_MS + 4000, hold: 30000 });
        accepting.catch(() => { if (this.udx.laneId === local.id && !this.udx.peerId) { try { this.lanes.close(local.id); } catch {} this.udx = { laneId: '', token: '', peerId: '' }; } });
        this.sendControl({ t: 'share-udx-ready', shareId: this.shareId, token: offer.token, streamId: local.streamId, endpoints: local.endpoints });
      } catch (error) {
        this.log(`UDP lane unavailable: ${error?.message || error}`);
        if (this.udx.laneId) { try { this.lanes.close(this.udx.laneId); } catch {} }
        this.udx = { laneId: '', token: '', peerId: '' };
        refuse();
      }
    }

    _onPeerOpen(peerId, token) {
      if (token !== this.udx.token) return;
      this.udx.peerId = peerId;
      this.log('on the UDP lane');
    }

    _laneFailed(laneId, error) {
      this.log(`lane ${laneId} is corrupt: ${error?.message || error}`);
      if (laneId === 'udx' && this.udx.peerId) { try { this.lanes.closePeer(this.udx.peerId); } catch {} }
    }

    _onRecord(record) {
      this.player.push(record);
      if (record.type === TYPE.END) { this.ended = true; this._tick(); this.onEnded(); }
    }

    _tick() {
      if (this.stopped) return;
      this.receiver.tick();
      if (!this.started) return;
      // After the end, one last acknowledgement lets the sharer release everything; then there is nothing more to say.
      if (this.ended && this.finalAckSent) return;
      if (this.ended) this.finalAckSent = true;
      this.sendControl({ t: 'share-ack', shareId: this.shareId, seq: this.receiver.ackSeq });
    }

    stats() { return { ackSeq: this.receiver.ackSeq, delivered: this.receiver.delivered, bytes: this.receiver.bytes, duplicates: this.receiver.duplicates, pending: this.receiver.pending.size, udx: !!this.udx.peerId }; }

    stop({ notify = true } = {}) {
      if (this.stopped) return;
      this.stopped = true; this._clear(this.timer);
      if (notify) this.sendControl({ t: 'share-unwatch', shareId: this.shareId });
      if (this.udx.peerId) { try { this.lanes.closePeer(this.udx.peerId); } catch {} }
      if (this.udx.laneId) { try { this.lanes.close(this.udx.laneId); } catch {} }
      this.udx = { laneId: '', token: '', peerId: '' };
    }
  }

  return { ShareHost, ShareViewer, createDcLane, HEARTBEAT_MS, ACK_MS, DC_CHUNK, MAX_UDX_VIEWERS };
});
