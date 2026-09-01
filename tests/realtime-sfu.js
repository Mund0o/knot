const assert = require('assert');
const { RealtimeSfuPilot, safeDescription, safeTrack } = require('../realtime-sfu');

const ownId = 'a'.repeat(32), remoteId = 'b'.repeat(32), entityId = 'c'.repeat(32), channelId = 'd'.repeat(32);
const sdp = type => ({ type, sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' });

class FakePeerConnection {
  static instances = [];
  constructor() { this.connectionState = 'new';this.localDescription = null;this.remoteDescription = null;this.ontrack = null;this.onconnectionstatechange = null;this.transceivers = [];FakePeerConnection.instances.push(this); }
  addTransceiver(track) { const value = { mid: null, sender: { track } };this.transceivers.push(value);return value; }
  async createOffer() { return sdp('offer'); }
  async createAnswer() { return sdp('answer'); }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) { this.remoteDescription = value;if(value.type === 'offer' && this.ontrack){const track = { id: 'remote-audio', kind: 'audio' }, stream = { getTracks: () => [track] };this.ontrack({ track, streams: [stream], transceiver: { mid: 'remote-mid' } });} }
  setState(value) { this.connectionState = value;this.onconnectionstatechange?.(); }
  close() { this.connectionState = 'closed';this.onconnectionstatechange?.(); }
}

(async () => {
  const originalPeerConnection = global.RTCPeerConnection, originalMediaStream = global.MediaStream;
  global.RTCPeerConnection = FakePeerConnection;global.MediaStream = class { constructor(tracks) { this.tracks = tracks; } };
  try {
    assert(safeDescription(sdp('offer'), 'offer'), 'valid SDP was rejected');
    assert.strictEqual(safeDescription({ type: 'offer', sdp: 'bad' }, 'offer'), null, 'invalid SDP was accepted');
    assert(safeTrack({ ownerId: remoteId, sessionId: 'remote-session', trackName: 'voice-track', kind: 'audio' }), 'valid remote track was rejected');
    assert.strictEqual(safeTrack({ ownerId: 'bad', sessionId: 'remote-session', trackName: 'voice-track' }), null, 'invalid owner was accepted');

    const calls = [], states = [], received = [], failures = [];
    const rpc = async (action, value) => {
      calls.push({ action, value });
      if(action === 'publish') return { sessionId: 'publisher-session', sessionDescription: sdp('answer'), roomTracks: [{ ownerId: remoteId, sessionId: 'remote-session-1', trackName: 'voice-track-1', kind: 'audio' }] };
      if(action === 'subscribe') return { sessionId: 'subscriber-session', sessionDescription: sdp('offer'), tracks: value.tracks.map(track => ({ ...track, mid: 'remote-mid' })) };
      if(action === 'renegotiate' || action === 'close') return { ok: true };
      throw new Error('unexpected RPC action: ' + action);
    };
    const localTrack = { id: 'local-audio', kind: 'audio' }, stream = { getAudioTracks: () => [localTrack], getTracks: () => [localTrack] };
    const pilot = new RealtimeSfuPilot({ rpc, onTrack: value => received.push(value), onState: value => states.push(value), onFailure: value => failures.push(value) });
    await pilot.start(stream, { entityId, channelId, ownId });
    const publish = calls.find(call => call.action === 'publish');
    assert.strictEqual(publish.value.tracks[0].mid, '0', 'a temporarily null transceiver mid was not mapped to its media-line index');
    assert(calls.some(call => call.action === 'subscribe') && calls.some(call => call.action === 'renegotiate'), 'subscriber negotiation did not complete');
    assert.strictEqual(received[0]?.ownerId, remoteId, 'a subscribed track lost its authenticated owner mapping');

    await pilot.syncTracks([{ ownerId: remoteId, sessionId: 'remote-session-2', trackName: 'voice-track-2', kind: 'audio' }]);
    const currentSubscriber = pilot.subscriber;currentSubscriber.setState('connected');
    assert(states.some(value => value.side === 'subscriber' && value.state === 'connected'), 'the current subscriber generation suppressed connection state');
    assert.strictEqual(failures.length, 0, 'retiring an old subscriber triggered a false SFU failure');

    await pilot.close();
    assert(calls.some(call => call.action === 'close'), 'closing the pilot did not release its remote publisher');
    assert.strictEqual(failures.length, 0, 'normal pilot close was reported as a failure');
    console.log('PASS feature-gated realtime SFU pilot lifecycle');
  } finally {
    global.RTCPeerConnection = originalPeerConnection;global.MediaStream = originalMediaStream;
  }
})().catch(error => { console.error(error);process.exitCode = 1; });
