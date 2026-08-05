const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeIceServers,
  turnServersFromConfig,
  validateSignalPayload,
  patchOpusSdp,
  patchVideoSdp,
  preferredVideoCodecs,
  DEFAULT_ICE_SERVERS
} = require('../pair-helpers');

test('mergeIceServers keeps STUN and appends TURN', () => {
  const merged = mergeIceServers(DEFAULT_ICE_SERVERS, [
    { urls: 'turn:example.com:3478', username: 'u', credential: 'p' }
  ]);
  assert.equal(merged.length, 3);
  assert.match(merged[0].urls, /^stun:/);
  assert.equal(merged[2].urls, 'turn:example.com:3478');
});

test('turnServersFromConfig rejects non-turn-like urls', () => {
  const servers = turnServersFromConfig(JSON.stringify([
    { urls: 'http://evil.example' },
    { urls: 'turns:ok.example:443', username: 'a', credential: 'b' }
  ]));
  assert.equal(servers.length, 1);
  assert.equal(servers[0].urls[0] || servers[0].urls, 'turns:ok.example:443');
});

test('validateSignalPayload allowlists kind and bounds sdp', () => {
  assert.equal(validateSignalPayload({ kind: 'hack', sdp: 'v=0' }), null);
  assert.equal(validateSignalPayload({ kind: 'offer', sdp: '' }), null);
  const ok = validateSignalPayload({ kind: 'reneg-answer', sdp: 'v=0\nm=audio', pub: 'abc' });
  assert.deepEqual(ok, { kind: 'reneg-answer', sdp: 'v=0\nm=audio', pub: 'abc' });
});

test('patchOpusSdp sets bitrate and dtx', () => {
  const sdp = 'a=fmtp:111 minptime=10;useinbandfec=1\r\n';
  const out = patchOpusSdp(sdp, 64000);
  assert.match(out, /maxaveragebitrate=64000/);
  assert.match(out, /usedtx=1/);
});

test('patchVideoSdp clamps google max bitrate', () => {
  const sdp = 'm=video 9 UDP/TLS/RTP/SAVPF 96\na=rtpmap:96 H264/90000\n';
  const out = patchVideoSdp(sdp, 8000);
  assert.match(out, /a=x-google-max-bitrate:8000/);
});

test('preferredVideoCodecs puts hardware-friendly codecs first', () => {
  assert.deepEqual(preferredVideoCodecs('auto').slice(0, 3), ['H264', 'VP9', 'VP8']);
  assert.equal(preferredVideoCodecs('auto').at(-1), 'AV1');
  assert.equal(preferredVideoCodecs('VP9')[0], 'VP9');
});
