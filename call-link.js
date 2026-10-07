(function installCallLink(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotCallLink = api;
})(typeof window === 'object' ? window : typeof globalThis === 'object' ? globalThis : null, () => {
  // The peer connection between two friends, and the rules for building it. Signalling is "perfect negotiation":
  // either side may offer at any time, a collision is settled by one fixed side backing down, and every message
  // is safe to receive twice. That is what lets the connection be built while the phone is still ringing, from
  // whichever side clicked first, and lets a lost message be sent again after a reconnect instead of stranding
  // the call. Nothing here knows about calls, microphones or the screen: the app hands in a `setup` hook, a
  // `signal` function (any transport that can carry small JSON to the friend) and hears back through callbacks.
  const LINK_ID = /^[a-f0-9]{16}$/;
  const KEY_PART = /^[A-Za-z0-9_-]{40,80}$/;
  const CONNECT_ESCALATE_MS = 6000;      // not connected this long after the descriptions were exchanged: add the relay
  const OFFER_RETRY_MS = 4500;           // an unanswered offer is sent again this often
  const OFFER_RETRIES = 5;
  const RECOVER_MS = { polite: 2500, impolite: 1500 };
  const RESTART_MIN_MS = 2500;
  const MAX_EARLY_CANDIDATES = 96;
  const MAX_PENDING_CANDIDATES = 256;
  const MAX_SENT_CANDIDATES = 96;

  const randomHex = bytes => {
    const buffer = new Uint8Array(bytes);
    (typeof crypto === 'object' && crypto.getRandomValues ? crypto : require('crypto').webcrypto).getRandomValues(buffer);
    return Array.from(buffer, value => value.toString(16).padStart(2, '0')).join('');
  };

  // The link id and the ephemeral encryption key ride inside the SDP as session-level attributes. They survive
  // any relay that forwards the SDP as it is, and the browser never sees them (they are stripped on arrival).
  function embedMeta(sdp, { link, pub, ack }) {
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    let meta = `a=knot-link:${link}${eol}`;
    if (Number.isInteger(ack)) meta += `a=knot-ack:${ack}${eol}`;
    if (pub && KEY_PART.test(String(pub.x)) && KEY_PART.test(String(pub.y))) meta += `a=knot-pub:${pub.x}.${pub.y}${eol}`;
    const at = sdp.search(/^m=/m);
    return at < 0 ? sdp + (sdp.endsWith('\n') ? '' : eol) + meta : sdp.slice(0, at) + meta + sdp.slice(at);
  }
  function extractMeta(sdp) {
    let link = '', pub = null, ack = null;
    const clean = String(sdp).replace(/^a=knot-(link|pub|ack):([^\r\n]*)\r?\n/gm, (_match, kind, value) => {
      if (kind === 'link') { if (LINK_ID.test(value)) link = value; }
      else if (kind === 'ack') { if (/^\d{1,15}$/.test(value)) ack = Number(value); }
      else { const [x, y] = value.split('.'); if (KEY_PART.test(x || '') && KEY_PART.test(y || '')) pub = { kty: 'EC', crv: 'P-256', x, y }; }
      return '';
    });
    return { sdp: clean, link, pub, ack };
  }
  // The version number in the o= line grows with every description a side makes, which orders old from new.
  const versionOf = sdp => { const match = /^o=\S+ \d+ (\d+)/m.exec(String(sdp || '')); return match ? Number(match[1]) : null; };
  const ufragsOf = sdp => new Set([...String(sdp || '').matchAll(/^a=ice-ufrag:(\S+)/gm)].map(match => match[1]));

  class CallLink {
    constructor(options) {
      const o = this.o = { log: () => {}, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: handle => clearTimeout(handle), now: () => Date.now(), iceServers: [], ...options };
      this.peerId = o.peerId; this.polite = !!o.polite; this.creator = !o.linkId; this.linkId = o.linkId || randomHex(8);
      this.state = 'new'; this.route = ''; this.closed = false; this.dead = false; this.everConnected = false; this.escalated = false; this.established = false;
      this.queue = Promise.resolve().then(() => o.prepare ? o.prepare(this) : undefined).catch(error => this.log('prepare failed: ' + (error?.message || error)));
      this.offerCount = 0; this.epoch = 0; this.needsNegotiation = false; this.iceRestartWanted = false; this.lastRestartAt = 0;
      this.pending = []; this.sentCandidates = []; this.lastLocal = null; this.lastAnswer = null; this.lastRemoteOffer = ''; this.remotePub = ''; this.ignoreOffer = false;
      this.timers = new Set(); this.lastRemoteRestartAt = 0; this.offerRetries = 0; this.recoverDelay = 0; this.failuresAfterEscalation = 0; this.recoveries = 0; this.lastRemoteVersion = -1; this.errors = 0;
      this.pc = new o.RTCPeerConnection({ iceServers: o.iceServers, iceTransportPolicy: o.iceTransportPolicy || 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
      const pc = this.pc;
      pc.onicecandidate = event => { if (event.candidate) this._sendCandidate(event.candidate); };
      pc.onnegotiationneeded = () => { if (pc.signalingState === 'stable') this.negotiate({ since: this.epoch }); };   // mid-negotiation the browser asks again once stable
      pc.onconnectionstatechange = () => this._onConnectionState();
      pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') this._onConnectionState(); };
      if (o.setup) o.setup(pc, this);
    }

    log(message) { this.o.log(`[link ${this.linkId.slice(0, 6)}] ${message}`); }
    _timer(fn, ms) { const handle = this.o.setTimer(() => { this.timers.delete(handle); fn(); }, ms); this.timers.add(handle); return handle; }
    _untimer(handle) { if (handle) { this.o.clearTimer(handle); this.timers.delete(handle); } }
    _enqueue(task) {
      const run = this.queue.then(() => { if (!this.closed) return task(); }).catch(error => this._taskFailed(error));
      this.queue = run; return run;
    }

    // ---- making offers
    // Only the side that made this link makes its first offer; for a link built from a friend's offer this does nothing.
    start() { return this.creator && !this.established && this.offerCount === 0 ? this.negotiate() : Promise.resolve(); }
    negotiate({ iceRestart = false, since } = {}) {
      if (iceRestart) this.iceRestartWanted = true;
      return this._enqueue(async () => {
        const pc = this.pc;
        this.log('negotiate since=' + since + ' epoch=' + this.epoch + ' state=' + pc.signalingState + ' restart=' + iceRestart);
        if (since !== undefined && this.epoch > since && !iceRestart) return true;      // a negotiation finished since the browser asked, and it covered what changed
        this.needsNegotiation = true;
        if (pc.signalingState !== 'stable') return true;                               // an offer is out; _settled() asks again once it is answered
        this.needsNegotiation = false;
        const restart = this.iceRestartWanted; this.iceRestartWanted = false;
        const offer = await pc.createOffer(restart ? { iceRestart: true } : undefined);
        if (pc.signalingState !== 'stable') { this.needsNegotiation = true; this.iceRestartWanted = this.iceRestartWanted || restart; return true; }
        await pc.setLocalDescription({ type: 'offer', sdp: this._local(offer.sdp) });
        this.offerCount++; this.epoch++; this.offerRetries = 0;
        this._announce();
        this._armOfferTimer();
        return true;
      });
    }
    restartIce({ force = false } = {}) {
      const wait = this.lastRestartAt + (this.o.restartMinMs ?? RESTART_MIN_MS) - this.o.now();
      if (wait > 0) { this._timer(() => this.restartIce({ force }), wait); return; }
      // Two restarts crossing each other end with one side rolling back, which is exactly what stalls Chrome's senders.
      // The polite side answers the friend's fresh restart instead of starting its own.
      if (this.polite && !force && this.o.now() - this.lastRemoteRestartAt < 3000) { this.log('the friend just restarted ICE; answering theirs'); return; }
      this.lastRestartAt = this.o.now(); this.log('restarting ICE'); return this.negotiate({ iceRestart: true });
    }
    _settled() { if (this.needsNegotiation && this.pc.signalingState === 'stable') this.negotiate(); }
    // Chrome stops sending RTP from a sender after rolling back an offer that restarted ICE (both sides restarting at
    // once does it every time). Setting each sender's own track again is the one thing that restarts it, and it is
    // harmless when nothing was wrong.
    async _wakeSenders() {
      for (const sender of this.pc.getSenders()) { if (!sender.track) continue; try { await sender.replaceTrack(sender.track); } catch {} }
    }

    // ---- what goes to the friend
    _local(sdp) { return this.o.mungeLocal ? this.o.mungeLocal(sdp) : sdp; }
    _remote(sdp) { return this.o.mungeRemote ? this.o.mungeRemote(sdp) : sdp; }
    _announce() {
      const description = this.pc.localDescription; if (!description?.sdp) return false;
      const kind = description.type === 'answer' ? 'answer' : 'offer';
      const sdp = embedMeta(description.sdp, { link: this.linkId, pub: this.o.localPub, ack: kind === 'answer' ? this.lastRemoteVersion : undefined });
      this.lastLocal = { kind, sdp }; if (kind === 'answer') this.lastAnswer = this.lastLocal;
      return this._signal({ kind, sdp });
    }
    // A link that was closed (replaced by the friend's) may still be finishing an offer; it must not send it.
    _signal(message) { if (this.closed) return false; try { return this.o.signal(message) !== false; } catch (error) { this.log('signal failed: ' + (error?.message || error)); return false; } }
    _sendCandidate(candidate) {
      const json = typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;
      if (this.o.candidateFilter && !this.o.candidateFilter(json)) return;
      this.sentCandidates.push(json); if (this.sentCandidates.length > MAX_SENT_CANDIDATES) this.sentCandidates.shift();
      this._signal({ kind: 'candidate', candidate: json });
    }
    // Sends everything the friend needs again. Safe at any time: they ignore what they already have.
    resend() {
      if (this.closed) return;
      if (this.lastLocal) this._signal(this.lastLocal);
      const current = ufragsOf(this.pc.localDescription?.sdp);
      for (const candidate of this.sentCandidates) if (!candidate.usernameFragment || current.has(candidate.usernameFragment)) this._signal({ kind: 'candidate', candidate });
    }
    _armOfferTimer() {
      this._untimer(this.offerTimer);
      this.offerTimer = this._timer(() => {
        if (this.closed || this.pc.signalingState !== 'have-local-offer') return;
        if (++this.offerRetries > OFFER_RETRIES) { this.log('offer was never answered'); if (this.o.onstuck) this.o.onstuck(this); return; }
        this.log('offer unanswered, sending again'); this.resend(); this._armOfferTimer();
      }, this.o.offerRetryMs ?? OFFER_RETRY_MS);
    }

    // ---- what comes from the friend
    receive(message) { return this._enqueue(() => this._receive(message)); }
    async _receive(message) {
      if (message.kind === 'candidate') return this._addCandidate(message.candidate);
      const meta = extractMeta(message.sdp);
      if (meta.link && meta.link !== this.linkId) { this.log('ignoring a description for another link'); return; }
      if (meta.pub) this._takePub(meta.pub);
      if (message.kind === 'offer') return this._onOffer(message.sdp, meta.sdp);
      if (message.kind === 'answer') return this._onAnswer(meta.sdp, meta.ack);
    }
    _takePub(pub) {
      const key = pub.x + '.' + pub.y;
      if (key === this.remotePub) return;
      const changed = !!this.remotePub; this.remotePub = key;
      if (this.o.onpub) this.o.onpub(pub, { changed });
    }
    async _onOffer(raw, sdp) {
      const pc = this.pc, version = versionOf(sdp);
      if (raw === this.lastRemoteOffer) {                                                  // the same offer again: our answer must have been lost
        if (this.lastLocal?.kind === 'answer') this._signal(this.lastLocal);
        return;
      }
      if (version !== null && version < this.lastRemoteVersion) { this.log('ignoring an offer older than the one already applied'); return; }
      const collision = pc.signalingState !== 'stable';
      if (collision && !this.polite) { this.ignoreOffer = true; this.log('ignoring the friend\'s colliding offer (we are not polite)'); return; }
      this.ignoreOffer = false;
      if (collision) { this._untimer(this.offerTimer); await pc.setLocalDescription({ type: 'rollback' }); this.needsNegotiation = true; }
      const before = [...ufragsOf(pc.remoteDescription?.sdp)].join(' ');
      await pc.setRemoteDescription({ type: 'offer', sdp: this._remote(sdp) });
      if (before && before !== [...ufragsOf(sdp)].join(' ')) this.lastRemoteRestartAt = this.o.now();
      this.lastRemoteOffer = raw; this.lastRemoteVersion = version ?? this.lastRemoteVersion; this.established = true;
      await this._flushCandidates();
      if (this.o.beforeAnswer) this.o.beforeAnswer(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription({ type: 'answer', sdp: this._local(answer.sdp) });
      this._announce();
      this.epoch++;
      if (collision) await this._wakeSenders();
      this._armConnectTimer();
      this._settled();
    }
    async _onAnswer(sdp, ack) {
      const pc = this.pc;
      if (pc.signalingState !== 'have-local-offer') { this.log('ignoring an answer we were not waiting for'); return; }
      const mine = versionOf(pc.localDescription?.sdp);
      if (ack !== null && mine !== null && ack !== mine) { this.log('ignoring an answer to an older offer'); return; }
      await pc.setRemoteDescription({ type: 'answer', sdp: this._remote(sdp) });
      this.established = true; this._untimer(this.offerTimer);
      await this._flushCandidates();
      this._armConnectTimer();
      this._settled();
    }
    async _addCandidate(candidate) {
      const pc = this.pc;
      if (!pc.remoteDescription) { if (this.pending.length < MAX_PENDING_CANDIDATES) this.pending.push(candidate); return; }
      const known = ufragsOf(pc.remoteDescription.sdp);
      if (candidate.usernameFragment && !known.has(candidate.usernameFragment)) { if (this.pending.length < MAX_PENDING_CANDIDATES) this.pending.push(candidate); return; }   // from a restart whose offer has not arrived yet
      try { await pc.addIceCandidate(candidate); } catch (error) { if (!this.ignoreOffer && pc.signalingState !== 'closed') this.log('candidate rejected: ' + (error?.message || error)); }
    }
    async _flushCandidates() {
      const pc = this.pc, waiting = this.pending.splice(0), known = ufragsOf(pc.remoteDescription?.sdp);
      for (const candidate of waiting) {
        if (candidate.usernameFragment && !known.has(candidate.usernameFragment)) continue;   // belongs to a session that never arrived
        try { await pc.addIceCandidate(candidate); } catch (error) { this.log('candidate rejected: ' + (error?.message || error)); }
      }
    }

    // ---- staying connected
    _armConnectTimer() {
      if (this.connectTimer || this.everConnected) return;
      this.connectTimer = this._timer(() => { this.connectTimer = null; if (!this.everConnected && !this.closed) this.escalate('slow'); }, this.o.escalateMs ?? CONNECT_ESCALATE_MS);
    }
    _onConnectionState() {
      if (this.closed) return;
      const state = this.pc.connectionState, ice = this.pc.iceConnectionState;
      const next = state === 'connected' ? 'connected' : state === 'failed' || ice === 'failed' ? 'failed' : state === 'disconnected' ? 'disconnected' : state === 'closed' ? 'closed' : 'connecting';
      if (next === this.state) return;
      this.state = next;
      if (next === 'connected') {
        this.everConnected = true; this.recoverDelay = 0; this._untimer(this.connectTimer); this.connectTimer = null; this._untimer(this.recoverTimer); this.recoverTimer = null;
        this._checkRoute();
        // The path can also change without the state changing (a restart that finds a better pair), so watch for that too.
        const ice = this.pc.sctp?.transport?.iceTransport;
        if (ice && !this.iceWatched) { this.iceWatched = true; try { ice.addEventListener('selectedcandidatepairchange', () => this._checkRoute()); } catch {} }
      } else if (next === 'disconnected' || next === 'failed') this._recover(next);
      if (this.o.onstate) this.o.onstate(next, this);
    }
    _recover(why) {
      this._untimer(this.recoverTimer);
      if (why === 'failed' && !this.everConnected && !this.escalated) { this.escalate('failed'); return; }
      const base = why === 'failed' ? 0 : this.polite ? RECOVER_MS.polite : RECOVER_MS.impolite;
      const delay = base + this.recoverDelay;
      this.recoverTimer = this._timer(() => {
        this.recoverTimer = null;
        if (this.closed || this.state === 'connected') return;
        // Nobody is calling, sending a file or sharing a screen over this: do not keep knocking (every attempt costs
        // signalling messages). The app lets it go and builds a fresh one the next time it is needed.
        if (this.o.keepAlive && !this.o.keepAlive(this)) { this.log('nothing needs this connection; letting it go'); this.dead = true; if (this.o.onabandon) this.o.onabandon(this); return; }
        if (why === 'failed' && this.escalated && !this.everConnected && this.failuresAfterEscalation++ >= 1) { this.dead = true; if (this.o.onfailed) this.o.onfailed('unreachable', this); return; }
        this.recoverDelay = Math.min(8000, Math.round((this.recoverDelay || 1500) * 1.6));
        if (++this.recoveries === 3 && !this.escalated) this.escalate('lost');
        this.restartIce();
        if (this.state !== 'connected') this._recover(why);
      }, delay);
    }
    // The direct path did not come up: add the relay and try once more. Only done when needed, so a call that
    // connects directly never touches the relay.
    async escalate(reason) {
      if (this.escalated || this.closed) return false;
      if (this.o.keepAlive && !this.o.keepAlive(this)) return false;
      this.escalated = true; this.failuresAfterEscalation = 0; this.log('adding the relay (' + reason + ')');
      try {
        const relay = await this.o.relayServers?.();
        if (this.closed) return false;
        if (!relay?.length) return this._noRelay(reason, 'none offered');
        const configuration = this.pc.getConfiguration();
        this.pc.setConfiguration({ ...configuration, iceServers: [...(configuration.iceServers || []), ...relay] });
        const relayAddedAt = this.o.now();
        // The impolite side restarts at once. The polite side gives the friend a moment to do it (answering their
        // restart gathers with the new configuration, so it picks up our relay too). If the friend's latest restart
        // came before our relay was added, our side never offered relay candidates, so then we restart ourselves.
        if (!this.polite) this.restartIce();
        else this._timer(() => { if (!this.closed && this.state !== 'connected' && this.lastRemoteRestartAt <= relayAddedAt) this.restartIce({ force: true }); }, 2500);
        return true;
      } catch (error) { return this._noRelay(reason, error?.message || error); }
    }
    // No relay could be had. If the direct path was only slow, keep waiting for it (and allow one more try later);
    // only a direct path that has already failed makes this fatal.
    _noRelay(reason, why) {
      this.log('relay unavailable (' + why + ')'); this.escalated = false;
      if (reason === 'failed' || this.state === 'failed') { this.escalated = true; this.dead = true; if (this.o.onfailed) this.o.onfailed('no relay', this); }
      return false;
    }
    // Which path the media really takes (direct or through the relay) is only known once the browser has selected a
    // candidate pair, which can be a moment after "connected", so ask again until it answers.
    async _checkRoute(attempt = 0) {
      if (this.closed || this.state !== 'connected') return;
      let answered = false;
      try {
        const stats = await this.pc.getStats(), byId = new Map(); let pair = null;
        stats.forEach(report => byId.set(report.id, report));
        stats.forEach(report => { if (report.type === 'transport' && report.selectedCandidatePairId) pair = byId.get(report.selectedCandidatePairId) || pair; });
        if (!pair) stats.forEach(report => { if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) pair = report; });
        if (pair) {
          const local = byId.get(pair.localCandidateId), remote = byId.get(pair.remoteCandidateId);
          if (local || remote) {
            answered = true;
            const route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
            if (route !== this.route) { this.route = route; if (this.o.onroute) this.o.onroute(route, this); }
          }
        }
      } catch {}
      if (!answered && attempt < 12) this._timer(() => this._checkRoute(attempt + 1), 200 + attempt * 150);
    }
    _taskFailed(error) {
      if (this.closed) return;
      this.log('negotiation error: ' + (error?.message || error));
      const pc = this.pc;
      const settle = async () => { try { if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'have-remote-offer') await pc.setLocalDescription({ type: 'rollback' }); } catch {} this.needsNegotiation = true; };
      return settle().then(() => {
        if (this.closed) return;
        if (++this.errors <= 3) this._timer(() => this.negotiate(), 800 * this.errors);
        else { this.dead = true; if (this.o.onfailed) this.o.onfailed('negotiation', this); }
      });
    }

    close() {
      if (this.closed) return; this.closed = true; this.state = 'closed';
      for (const handle of [...this.timers]) this._untimer(handle);
      try { this.pc.onicecandidate = this.pc.onnegotiationneeded = this.pc.onconnectionstatechange = this.pc.oniceconnectionstatechange = null; this.pc.close(); } catch {}
    }
  }

  // Holds the one live link and decides what an incoming description means for it.
  class LinkHub {
    constructor({ selfId, create, allow = () => true, log = () => {}, now = () => Date.now() }) {
      Object.assign(this, { selfId, create, allow, log, now }); this.link = null; this.early = [];
      this.self = () => String(typeof this.selfId === 'function' ? this.selfId() : this.selfId);
    }
    get current() { return this.link && !this.link.closed ? this.link : null; }
    // The link to this friend, creating it (as the side that offers) if there is none worth keeping.
    ensure(peerId, extra = {}) {
      const link = this.current;
      if (link && link.peerId === peerId && !link.dead && link.state !== 'failed') return link;
      return this._make(peerId, '', extra);
    }
    drop() { const link = this.link; this.link = null; this.early = []; if (link) link.close(); }
    _make(peerId, linkId, extra = {}) {
      const old = this.link; this.link = null;
      if (old) old.close();
      const link = this.link = this.create({ ...extra, peerId, linkId, polite: this.self() > String(peerId) });
      const fresh = this.early.splice(0).filter(item => item.peerId === peerId && this.now() - item.at < 15000);
      for (const item of fresh) link.receive(item.message);
      return link;
    }
    receive(peerId, message, extra = {}) {
      if (!message || typeof message !== 'object') return;
      const link = this.current;
      if (message.kind === 'candidate') {
        if (link && link.peerId === peerId) link.receive(message);
        else { this.early.push({ peerId, message, at: this.now() }); if (this.early.length > MAX_EARLY_CANDIDATES) this.early.shift(); }
        return;
      }
      const meta = extractMeta(message.sdp);
      if (!meta.link) { this.log('a description without a link id (an older Knot?)'); return; }
      if (link && link.peerId === peerId && link.linkId === meta.link) { link.receive(message); return; }
      if (message.kind !== 'offer') return;                           // an answer for a link we no longer have is old news
      if (!this.allow(peerId)) { this.log('ignoring an offer: busy with someone else'); return; }
      // Two fresh links offering at once: the lower id keeps going and the other side adopts it. Anything else
      // (they restarted, or we only ever answered) means the friend's link replaces ours.
      if (link && link.peerId === peerId && link.creator && !link.established && link.linkId < meta.link) { this.log('keeping our own link; theirs has the higher id'); return; }
      this._make(peerId, meta.link, extra).receive(message);
    }
  }

  return { CallLink, LinkHub, embedMeta, extractMeta, ufragsOf, versionOf, CONNECT_ESCALATE_MS, OFFER_RETRY_MS };
});
