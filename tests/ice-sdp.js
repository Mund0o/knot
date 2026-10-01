'use strict';

const assert = require('assert');
const ice = require('../ice-sdp');

const mdnsHost = 'a=candidate:1 1 udp 2122260223 1f4712db-ea17-4bcf-a596-105139dfd8bf.local 54596 typ host generation 0\r\n';
const lanHost = 'a=candidate:2 1 udp 2122260222 192.168.1.20 54597 typ host generation 0\r\n';
const srflx = 'a=candidate:3 1 udp 1686052607 203.0.113.8 3478 typ srflx raddr 192.168.1.20 rport 54597 generation 0\r\n';
const relay = 'a=candidate:4 1 udp 1677729535 198.51.100.9 50100 typ relay raddr 0.0.0.0 rport 0 generation 0\r\n';

assert.strictEqual(ice.parseIceCandidateLine(mdnsHost).mdns, true);
assert.strictEqual(ice.parseIceCandidateLine(mdnsHost).typ, 'host');
assert.strictEqual(ice.parseIceCandidateLine('candidate:3 1 udp 1686052607 203.0.113.8 3478 typ srflx raddr 0.0.0.0 rport 0').typ, 'srflx');
assert.strictEqual(ice.sdpHasPublicIceCandidate('v=0\r\n' + mdnsHost + lanHost), false, 'mDNS/host-only SDP must not count as usable on WAN');
assert.strictEqual(ice.sdpHasPublicIceCandidate('v=0\r\n' + mdnsHost + srflx), true);
assert.strictEqual(ice.sdpHasRelayIceCandidate('v=0\r\n' + srflx), false);
assert.strictEqual(ice.sdpHasRelayIceCandidate('v=0\r\n' + relay), true);
assert.strictEqual(ice.iceCandidateWorthSending('candidate:1 1 udp 1 1f4712db-ea17-4bcf-a596-105139dfd8bf.local 9 typ host'), false);
assert.strictEqual(ice.iceCandidateWorthSending('candidate:2 1 udp 1 192.168.1.20 9 typ host'), true);
assert.strictEqual(ice.iceCandidateWorthSending('candidate:3 1 udp 1 203.0.113.8 9 typ srflx raddr 192.168.1.20 rport 9'), true);

const stripped = ice.preferPublicIceSdp('v=0\r\n' + mdnsHost + srflx);
assert.ok(!stripped.includes('.local'), 'public SDP should drop mDNS host lines once srflx exists');
assert.ok(stripped.includes('typ srflx'), 'public SDP must keep srflx');
assert.strictEqual(ice.preferPublicIceSdp('v=0\r\n' + mdnsHost), 'v=0\r\n' + mdnsHost, 'do not strip mDNS when it is the only candidate');

const colliding = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 110',
  'a=rtpmap:111 opus/48000/2',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 110',
  'a=rtpmap:111 opus/48000/2',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
].join('\r\n');
const once = ice.unbundleOpusCollision(colliding);
assert.ok(/a=rtpmap:114 opus\//.test(once), 'second audio m-line must leave Opus 111');
assert.ok(/a=fmtp:115 114\/114/.test(once) || /a=fmtp:\d+ 114\/114/.test(once), 'RED fmtp must remap both payload types: ' + once);
const twice = ice.unbundleOpusCollision(once);
assert.strictEqual(twice, once, 'already-unique payload types must not be remapped again');

console.log('PASS ice-sdp');
