(function installCallControl(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotCallControl = api;
})(typeof window === 'object' ? window : typeof globalThis === 'object' ? globalThis : null, () => {
  // Who is in a call with whom, and nothing else. It never touches a socket, a microphone or a peer connection:
  // it is told what happened (a click, a friend's presence message, a timer) and answers with what to publish and
  // what the screen should say. That keeps ringing independent of whether the audio link ever connects, and makes
  // every odd sequence (both pressing at once, a restart mid-ring, a lost "left" message) testable without a browser.
  //
  // The only thing shared with a friend is a "presence" line: { active, session }. A call is the set of people
  // publishing presence under the same session id. Pressing the button when your friend is already present joins
  // their session; otherwise it starts a new one. If both start at once, the lower session id wins and the other
  // side adopts it, so two simultaneous calls collapse into one without any extra messages.
  const BEAT_MS = 8000;           // how often someone in a call repeats their presence
  const TTL_MS = 26000;           // presence not repeated for this long counts as gone (three missed beats)
  const END_GUARD_MS = 600;       // a second click this soon after starting is a double click, not a hang-up

  const randomSession = () => {
    const bytes = new Uint8Array(6);
    (typeof crypto === 'object' && crypto.getRandomValues ? crypto : require('crypto').webcrypto).getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  };

  class CallControl {
    constructor({ publish, onChange = () => {}, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = handle => clearTimeout(handle), newSession = randomSession } = {}) {
      if (typeof publish !== 'function') throw new Error('publish is required');
      Object.assign(this, { publish, onChange, now, setTimer, clearTimer, newSession });
      this.peer = ''; this.session = ''; this.startedAt = 0; this.friendJoined = false; this.everJoined = false;
      this.remote = new Map();            // peerId -> { session, seenAt }
      this.beatTimer = null; this.expiryTimer = null; this.unsent = false;
    }

    get inCall() { return !!this.peer; }
    remoteSession(peerId) { const entry = this.remote.get(peerId); return entry && this.now() - entry.seenAt < TTL_MS ? entry.session : ''; }
    remoteActive(peerId) { return !!this.remoteSession(peerId); }

    // What a click on this friend's call button means right now.
    press(peerId) {
      if (!peerId) return 'nobody';
      if (this.inCall) {
        if (this.peer !== peerId) return 'busy';
        if (this.now() - this.startedAt < END_GUARD_MS) return 'ignored';
        this.leave(); return 'left';
      }
      const theirs = this.remoteSession(peerId);
      this.peer = peerId; this.session = theirs || this.newSession(); this.startedAt = this.now(); this.friendJoined = this.everJoined = !!theirs;
      this._announce(); this._startBeat(); this._emit(theirs ? 'joined' : 'started');
      return theirs ? 'joined' : 'started';
    }

    leave() {
      if (!this.inCall) return false;
      const peer = this.peer, session = this.session;
      this._stopBeat(); this.peer = ''; this.session = ''; this.friendJoined = this.everJoined = false; this.unsent = false;
      try { this.publish(peer, false, session); } catch {}
      this._emit('left', { peer });
      return true;
    }

    // A friend's presence line arrived.
    receive(peerId, active, session) {
      session = String(session || '');
      const known = this.remote.get(peerId);
      if (!active) {
        // A "left" for a session they are no longer in is old news (they hung up one call and started another).
        if (known && session && known.session && known.session !== session) return;
        const was = !!known; this.remote.delete(peerId);
        if (this.peer === peerId) this.friendJoined = false;
        if (was) this._emit(this.peer === peerId ? 'friend-left' : 'ring-ended', { peer: peerId });
        this._scheduleExpiry(); return;
      }
      if (!session) return;
      const wasActive = this.remoteActive(peerId), changed = !known || known.session !== session;
      this.remote.set(peerId, { session, seenAt: this.now() });
      this._scheduleExpiry();
      if (this.peer === peerId) {
        // Both started a call at the same moment: the lower session id is the real one.
        if (session !== this.session) {
          if (session < this.session) { this.session = session; this._announce(); this._emit('merged', { peer: peerId }); }
          else this._announce();      // they will adopt ours; repeating it makes sure they hear it
        }
        if (!this.friendJoined) { this.friendJoined = this.everJoined = true; this._emit('friend-joined', { peer: peerId }); }
        return;
      }
      if (!wasActive || changed) this._emit('ring-in', { peer: peerId });
    }

    // Anything that proves a friend is still there (their audio, their data channel) keeps their presence fresh.
    touch(peerId) { const entry = this.remote.get(peerId); if (entry) { entry.seenAt = this.now(); this._scheduleExpiry(); } }

    // The directory reconnected or the friend came online: say again that we are in the call.
    republish() { if (this.inCall) this._announce(); }

    // What the call button and status line should show. `media` is 'none' | 'connecting' | 'live' from the link.
    view(peerId, media = 'none') {
      const mine = this.peer === peerId, theirs = this.remoteActive(peerId);
      if (this.inCall && !mine) return { state: 'busy', button: 'start', other: this.peer };
      if (!mine) return theirs ? { state: 'incoming', button: 'join' } : { state: 'idle', button: 'start' };
      if (!theirs) return { state: this.everJoined ? 'waiting' : 'calling', button: 'end' };
      return { state: media === 'live' ? 'live' : 'connecting', button: 'end' };
    }

    close() { this._stopBeat(); if (this.expiryTimer) this.clearTimer(this.expiryTimer); this.expiryTimer = null; }

    _announce() {
      let sent = false; try { sent = this.publish(this.peer, true, this.session) !== false; } catch {}
      this.unsent = !sent;
    }
    _startBeat() {
      this._stopBeat();
      const beat = () => { this.beatTimer = this.setTimer(beat, BEAT_MS); this._announce(); };
      this.beatTimer = this.setTimer(beat, BEAT_MS);
    }
    _stopBeat() { if (this.beatTimer) this.clearTimer(this.beatTimer); this.beatTimer = null; }
    _scheduleExpiry() {
      if (this.expiryTimer) this.clearTimer(this.expiryTimer); this.expiryTimer = null;
      let soonest = Infinity; for (const entry of this.remote.values()) soonest = Math.min(soonest, entry.seenAt + TTL_MS);
      if (soonest === Infinity) return;
      this.expiryTimer = this.setTimer(() => {
        this.expiryTimer = null;
        for (const [peerId, entry] of [...this.remote]) if (this.now() - entry.seenAt >= TTL_MS) this.receive(peerId, false, entry.session);
        this._scheduleExpiry();
      }, Math.max(50, soonest - this.now() + 5));
    }
    _emit(type, detail = {}) { try { this.onChange({ type, ...detail, view: this.peer ? this.view(this.peer) : null }); } catch (error) { if (typeof console === 'object') console.warn('call control listener', error); } }
  }

  return { CallControl, BEAT_MS, TTL_MS, END_GUARD_MS };
});
