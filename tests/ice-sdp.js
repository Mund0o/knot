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

const stripped = ice.preferPublicIceSdp('v=0\r\n' + mdnsHost + lanHost + srflx);
assert.ok(!stripped.includes('.local'), 'public SDP should drop mDNS host lines once srflx exists');
assert.ok(stripped.includes('192.168.1.20'), 'public SDP must keep a real host candidate');
assert.ok(stripped.includes('typ srflx'), 'public SDP must keep srflx');
const strippedLines = stripped.split(/\r?\n/);
assert.deepStrictEqual(strippedLines.filter(line => !line), [''], 'public SDP must end with one newline and contain no blank line');
assert.ok(stripped.endsWith('\r\n') && !stripped.includes('\r\n\r\n'), 'public SDP must keep a single trailing newline');
assert.strictEqual(ice.preferPublicIceSdp('v=0\r\n' + mdnsHost), 'v=0\r\n' + mdnsHost, 'do not strip mDNS when it is the only candidate');
const bare = ice.preferPublicIceSdp('v=0\r\na=candidate:1 1 udp 1 uuid.local 9 typ host\r\na=candidate:3 1 udp 1 203.0.113.8 9 typ srflx');
assert.strictEqual(bare, 'v=0\r\na=candidate:3 1 udp 1 203.0.113.8 9 typ srflx');

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

const blank = 'v=0\r\n\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n\r\na=rtpmap:111 opus/48000/2\r\n';
const cleaned = ice.unbundleOpusCollision(blank);
assert.ok(!cleaned.includes('\r\n\r\n'), 'inbound SDP must drop a blank line from an older offer');
assert.ok(cleaned.endsWith('\r\n') && cleaned.includes('a=rtpmap:111 opus/48000/2'), 'cleaned SDP must keep its media lines and one trailing newline');
assert.strictEqual(ice.cleanSdp('v=0\r\n\r\n'), 'v=0\r\n');
assert.strictEqual(ice.cleanSdp('v=0\r\na=mid:0'), 'v=0\r\na=mid:0');

const highProfile = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102\r\na=rtpmap:102 H264/90000\r\na=rtcp-fb:102 nack\r\na=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f\r\n';
const baseline = ice.normalizeInboundH264Fmtp(highProfile);
assert.ok(baseline.includes('profile-level-id=42e01f') && !baseline.includes('640c1f'), 'inbound H264 must be constrained baseline so Linux can decode a Windows screen');
assert.ok(baseline.includes('a=rtcp-fb:102 nack\r\n'), 'H264 rewrite must keep the feedback line between rtpmap and fmtp');
assert.ok(!baseline.includes('\r\n\r\n'), 'H264 rewrite must not insert a blank SDP line');
assert.strictEqual((baseline.match(/a=fmtp:102 /g) || []).length, 1, 'H264 rewrite must not duplicate fmtp');
const inserted = ice.normalizeInboundH264Fmtp('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n');
assert.ok(inserted.includes('a=rtpmap:96 H264/90000\r\na=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n'), 'missing H264 fmtp must be inserted on its own line');
assert.ok(!inserted.includes('\r\n\r\n') && !inserted.includes('\r\r'), 'inserted H264 fmtp must not corrupt CRLF');
assert.ok(!ice.unbundleOpusCollision(highProfile).includes('42e01f'), 'payload remap must not rewrite outbound H264');

console.log('PASS ice-sdp');
