(function installShareCore(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotShareCore = api;
})(typeof window === 'object' ? window : typeof globalThis === 'object' ? globalThis : null, root => {
  // The logic of sending and receiving a screen share, with no sockets, codecs or timers of its own. It is told
  // what happened (a picture was captured, a lane has room, an acknowledgement arrived) and answers by writing
  // bytes to lanes. That keeps every awkward ordering testable: lanes that stall, die mid-picture, deliver late or
  // twice, a viewer that joins halfway or falls far behind.
  //
  // The rule everything follows: a picture that was captured is delivered, whole and in order, unless the viewer
  // is so far behind that holding it would exhaust memory. Nothing is ever thinned out to suit a slow link; a slow
  // link makes the viewer wait (and the sharer's backlog grow), it does not make the picture worse.
  const Wire = (typeof require === 'function' && typeof module === 'object') ? require('./share-wire') : root.KnotShareWire;
  const { TYPE, FLAG, HEADER, encodeRecord, RecordParser } = Wire;

  const DEFAULT_MAX_LOG_BYTES = 384 * 1024 * 1024;   // everything not yet acknowledged by the slowest viewer, shared by all viewers
  // How far behind the live picture a viewer may fall before it is moved up to the latest key picture. Nobody wants to watch the past, and only the
  // sender can act on this: pictures still waiting here have not reached the viewer, so its player cannot jump over them. A link slower than the stream
  // (measured: 25 Mbit/s carrying 42) makes the lag grow by about half a second every second, so with a long limit (it was 45 s) the viewer watched
  // pictures 19 s old and climbing. Now it falls back to live every few seconds; the picture itself is never made worse. An outage is the same:
  // what came after the first seconds of it is not worth sending.
  const DEFAULT_MAX_BACKLOG_MS = 6000;
  const DEFAULT_VIEWER_TIMEOUT_MS = 30000;            // no acknowledgement for this long: the viewer is gone
  const RESEND_AFTER_MS = 10000;                      // outstanding records, no progress at all for this long: send them again
  const KEEP_CONFIGS = 8;
  const LANE_RANK = { udx: 2, dc: 1 };                // a lane with a higher rank is preferred whenever it is usable

  const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  class ShareSender {
    constructor({ now = () => Date.now(), maxLogBytes = DEFAULT_MAX_LOG_BYTES, maxBacklogMs = DEFAULT_MAX_BACKLOG_MS, viewerTimeoutMs = DEFAULT_VIEWER_TIMEOUT_MS, emit = () => {} } = {}) {
      Object.assign(this, { now, maxLogBytes, maxBacklogMs, viewerTimeoutMs, emit });
      this.records = [];            // retained records, oldest first; records[0].seq === baseSeq
      this.baseSeq = 0;
      this.nextSeq = 0;
      this.keySeq = -1;             // the latest picture that can be decoded on its own: where a new viewer starts
      this.logBytes = 0;
      this.config = null;
      this.configVersion = -1;
      this.configs = new Map();
      this.waitingForKey = true;    // nothing can be decoded before the first key picture, so earlier pictures are not kept
      this.viewers = new Map();
      this.ended = false;
      this.discardedBeforeKey = 0;
    }

    // Describes the stream (codec string, size, rate). A different description needs a new key picture first.
    setConfig(config) {
      if (this.config && sameConfig(this.config, config)) return this.configVersion;
      this.config = config; this.configVersion++;
      this.configs.set(this.configVersion, config);
      for (const version of [...this.configs.keys()]) if (version <= this.configVersion - KEEP_CONFIGS) this.configs.delete(version);
      this.waitingForKey = true;
      this.emit({ type: 'config', version: this.configVersion, config });
      return this.configVersion;
    }

    pushFrame({ key, pts, data }) {
      if (this.ended) return -1;
      if (this.configVersion < 0) throw new Error('setConfig must come before the first picture');
      if (this.waitingForKey) {
        if (!key) { this.discardedBeforeKey++; return -1; }
        this.waitingForKey = false;
      }
      const seq = this.nextSeq++;
      const wire = encodeRecord({ type: TYPE.VIDEO, flags: key ? FLAG.KEY : 0, config: this.configVersion, seq, pts, payload: data });
      this.records.push({ seq, key: !!key, at: this.now(), wire });
      this.logBytes += wire.length;
      if (key) this.keySeq = seq;
      this._afterAppend();
      return seq;
    }

    // Called when the screen has been still for a moment (see HEARTBEAT in share-wire.js).
    heartbeat(pts) {
      if (this.ended || this.waitingForKey) return -1;
      const seq = this.nextSeq++;
      const wire = encodeRecord({ type: TYPE.HEARTBEAT, config: Math.max(0, this.configVersion), seq, pts });
      this.records.push({ seq, key: false, at: this.now(), wire });
      this.logBytes += wire.length;
      this._afterAppend();
      return seq;
    }

    end() {
      if (this.ended) return;
      const seq = this.nextSeq++;
      const wire = encodeRecord({ type: TYPE.END, seq, config: Math.max(0, this.configVersion) });
      this.records.push({ seq, key: false, at: this.now(), wire });
      this.logBytes += wire.length;
      this.ended = true;
      this._afterAppend();
    }

    addViewer(id) {
      if (this.viewers.has(id)) this.removeViewer(id);
      // Start at the latest key picture, so the viewer can decode at once and then catches up through the rest of that group.
      const startSeq = this.keySeq >= 0 ? this.keySeq : this.baseSeq;
      const viewer = { id, startSeq, acked: startSeq - 1, cursor: startSeq, lanes: new Map(), active: null, lastAckAt: this.now(), progressAt: this.now(), sentBytes: 0, resent: 0, skips: 0 };
      this.viewers.set(id, viewer);
      return { startSeq, configVersion: this.configVersion, config: this.config };
    }

    removeViewer(id) {
      const viewer = this.viewers.get(id);
      if (!viewer) return;
      this.viewers.delete(id);
      for (const lane of viewer.lanes.values()) { try { lane.close?.(); } catch {} }
      this._trim();
    }

    // write(bytes) -> false when the lane has no more room (call laneWritable() once it does); close() releases it.
    attachLane(viewerId, laneId, { kind, write, close }) {
      const viewer = this.viewers.get(viewerId);
      if (!viewer) return false;
      viewer.lanes.set(laneId, { id: laneId, kind, rank: LANE_RANK[kind] || 0, write, close, blocked: false });
      this._choose(viewer);
      return true;
    }

    laneWritable(viewerId, laneId) {
      const viewer = this.viewers.get(viewerId), lane = viewer?.lanes.get(laneId);
      if (!lane) return;
      lane.blocked = false;
      if (viewer.active === lane) this._pump(viewer);
    }

    removeLane(viewerId, laneId) {
      const viewer = this.viewers.get(viewerId);
      if (!viewer || !viewer.lanes.delete(laneId)) return;
      if (viewer.active && viewer.active.id === laneId) { viewer.active = null; this._choose(viewer); }
    }

    // The viewer has every record up to and including seq, in order.
    onAck(viewerId, seq) {
      const viewer = this.viewers.get(viewerId);
      if (!viewer) return;
      viewer.lastAckAt = this.now();
      if (seq > viewer.acked) { viewer.acked = Math.min(seq, this.nextSeq - 1); viewer.progressAt = this.now(); if (viewer.cursor <= viewer.acked) viewer.cursor = viewer.acked + 1; }
      this._trim();
    }

    // The viewer is waiting for a record that never came (a lane died with it in flight). Send from its first missing one again.
    onResend(viewerId) {
      const viewer = this.viewers.get(viewerId);
      if (!viewer) return;
      viewer.resent += Math.max(0, viewer.cursor - (viewer.acked + 1));
      viewer.cursor = viewer.acked + 1;
      if (viewer.active) viewer.active.blocked = false;
      this._pump(viewer);
    }

    // Called a few times a second: moves up viewers that are hopelessly behind and reports viewers that went silent.
    tick() {
      const now = this.now();
      for (const viewer of [...this.viewers.values()]) {
        if (now - viewer.lastAckAt > this.viewerTimeoutMs) { this.emit({ type: 'viewer-timeout', viewerId: viewer.id }); continue; }
        const oldest = this._record(viewer.acked + 1);
        if (oldest && now - oldest.at > this.maxBacklogMs) this._skip(viewer, 'behind');
        // Safety net: records are outstanding yet the viewer's position has not moved for a long while. Normal recovery
        // is asked for by the viewer; this covers a viewer that lost the record before it knew it was waiting.
        if (viewer.cursor > viewer.acked + 1 && now - viewer.progressAt > RESEND_AFTER_MS) { viewer.progressAt = now; this.onResend(viewer.id); }
      }
    }

    stats() {
      const now = this.now();
      return {
        records: this.records.length, logBytes: this.logBytes, nextSeq: this.nextSeq, keySeq: this.keySeq, discardedBeforeKey: this.discardedBeforeKey,
        // lagMs: how old the oldest picture this viewer has not yet confirmed is (a few hundred milliseconds on a healthy link)
        viewers: [...this.viewers.values()].map(v => ({ id: v.id, acked: v.acked, cursor: v.cursor, behind: this.nextSeq - 1 - v.acked, lagMs: Math.max(0, now - (this._record(v.acked + 1)?.at ?? now)), lane: v.active?.kind || null, sentBytes: v.sentBytes, resent: v.resent, skips: v.skips })),
      };
    }

    _record(seq) {
      const index = seq - this.baseSeq;
      return index >= 0 && index < this.records.length ? this.records[index] : null;
    }

    _afterAppend() {
      if (this.logBytes > this.maxLogBytes) this._relieveMemory();
      for (const viewer of this.viewers.values()) this._pump(viewer);
      this._trim();
    }

    // Everything older than what the slowest viewer still needs (and older than the latest key picture, which a new viewer starts from) is freed.
    _trim() {
      // With no viewer, only the latest group of pictures is kept (for whoever joins next); once the share has ended, nothing is.
      let floor = this.ended ? this.nextSeq : this.keySeq >= 0 ? this.keySeq : this.baseSeq;
      for (const viewer of this.viewers.values()) floor = Math.min(floor, viewer.acked + 1);
      floor = Math.max(floor, this.baseSeq);
      let drop = 0, bytes = 0;
      while (drop < this.records.length && this.records[drop].seq < floor) bytes += this.records[drop++].wire.length;
      if (!drop) return;
      this.records.splice(0, drop);
      this.baseSeq += drop; this.logBytes -= bytes;
    }

    // Memory is the one thing that can force a viewer to miss pictures: move the furthest-behind viewers to the live picture.
    _relieveMemory() {
      const behind = [...this.viewers.values()].sort((a, b) => a.acked - b.acked);
      for (const viewer of behind) {
        if (this.logBytes <= this.maxLogBytes * 0.75) break;
        this._skip(viewer, 'memory');
        this._trim();
      }
    }

    _skip(viewer, reason) {
      const target = this.keySeq;
      if (target < 0 || target <= viewer.acked + 1) return;          // already inside the latest group: nothing newer to jump to
      const from = viewer.acked + 1;
      // A cursor already past the target keeps its place: those records are in flight and the viewer will use them.
      viewer.acked = target - 1; viewer.cursor = Math.max(viewer.cursor, target); viewer.skips++; viewer.progressAt = this.now();
      this.emit({ type: 'gap', viewerId: viewer.id, from, to: target - 1, reason });
      this._pump(viewer);
    }

    _choose(viewer) {
      let best = null;
      for (const lane of viewer.lanes.values()) if (!best || lane.rank > best.rank) best = lane;
      if (best === viewer.active) return;
      viewer.active = best;
      // Whatever the previous lane had not yet confirmed is sent again on the new one; the viewer drops duplicates.
      viewer.resent += Math.max(0, viewer.cursor - (viewer.acked + 1));
      viewer.cursor = viewer.acked + 1;
      this._pump(viewer);
    }

    _pump(viewer) {
      const lane = viewer.active;
      if (!lane || lane.blocked) return;
      while (viewer.cursor < this.nextSeq) {
        const record = this._record(viewer.cursor);
        if (!record) { this._skip(viewer, 'trimmed'); if (!this._record(viewer.cursor)) return; continue; }
        let room;
        try { room = lane.write(record.wire); } catch { this.removeLane(viewer.id, lane.id); return; }
        viewer.cursor++; viewer.sentBytes += record.wire.length;
        if (room === false) { lane.blocked = true; return; }
      }
    }
  }

  class ShareReceiver {
    constructor({ onRecord, onGap = () => {}, onStuck = () => {}, onLaneError = () => {}, now = () => Date.now(), stuckMs = 1500, maxPending = 16384 } = {}) {
      if (typeof onRecord !== 'function') throw new Error('onRecord is required');
      Object.assign(this, { onRecord, onGap, onStuck, onLaneError, now, stuckMs, maxPending });
      this.expected = 0;
      this.started = false;
      this.pending = new Map();
      this.parsers = new Map();
      this.advancedAt = now();
      this.stuckAt = 0;
      this.duplicates = 0;
      this.delivered = 0;
      this.bytes = 0;                 // wire bytes of the records handed on so far (for the viewer's bitrate readout)
    }

    // A lane can deliver before the offer that names the first record has been processed; those records wait in pending.
    start(startSeq) {
      this.expected = startSeq; this.started = true; this.advancedAt = this.now();
      for (const key of [...this.pending.keys()]) if (key < startSeq) this.pending.delete(key);
      this._drain();
    }

    // The highest seq received in order: what to acknowledge.
    get ackSeq() { return this.expected - 1; }

    pushBytes(laneId, bytes) {
      let parser = this.parsers.get(laneId);
      if (!parser) this.parsers.set(laneId, parser = new RecordParser());
      let records;
      try { records = parser.push(bytes); } catch (error) { this.parsers.delete(laneId); this.onLaneError(laneId, error); return; }
      for (const record of records) this._accept(record);
    }

    removeLane(laneId) { this.parsers.delete(laneId); }

    // The sharer moved this viewer ahead: everything before seq is never coming.
    skipTo(seq) {
      if (seq <= this.expected) return;
      for (const key of [...this.pending.keys()]) if (key < seq) this.pending.delete(key);
      const from = this.expected;
      this.expected = seq; this.advancedAt = this.now();
      this.onGap({ from, to: seq - 1 });
      this._drain();
    }

    tick() {
      if (!this.pending.size) return;
      const now = this.now();
      if (now - this.advancedAt >= this.stuckMs && now - this.stuckAt >= this.stuckMs) { this.stuckAt = now; this.onStuck(this.expected); }
    }

    _accept(record) {
      if (this.started && record.seq < this.expected || this.pending.has(record.seq)) { this.duplicates++; return; }
      if (this.started && record.seq === this.expected) { this._deliver(record); this._drain(); return; }
      if (this.pending.size >= this.maxPending) return;      // dropped here, asked for again once the gap is filled
      this.pending.set(record.seq, record);
    }

    _drain() {
      for (let next = this.pending.get(this.expected); next; next = this.pending.get(this.expected)) { this.pending.delete(this.expected); this._deliver(next); }
    }

    _deliver(record) {
      this.expected = record.seq + 1; this.delivered++; this.bytes += HEADER + record.payload.length; this.advancedAt = this.now();
      this.onRecord(record);
    }
  }

  return { ShareSender, ShareReceiver, DEFAULT_MAX_LOG_BYTES, DEFAULT_MAX_BACKLOG_MS, DEFAULT_VIEWER_TIMEOUT_MS, LANE_RANK, HEADER };
});
