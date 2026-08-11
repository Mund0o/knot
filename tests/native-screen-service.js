const assert = require('assert');
const { parseInfo, validateNativeScreenInfo, WebmClusterSegmenter, nativeScreenInfo } = require('../native-screen');

const parsed = parseInfo('section=gpu_info\nvendor|nvidia\ncard_path|/dev/dri/card1\nsection=video_codecs\nh264\nav1\nav1_10bit\n');
assert.deepStrictEqual(parsed, { vendor: 'nvidia', cardPath: '/dev/dri/card1', codecs: ['h264', 'av1', 'av1_10bit'] });
const amd = parseInfo('section=gpu_info\nvendor|amd\ncard_path|/dev/dri/card2\nsection=video_codecs\nh264\nav1\n');
assert.deepStrictEqual(validateNativeScreenInfo('0x1002', 'card2', amd, 'fixture'), {
  supported: true, source: 'fixture', vendor: 'amd', encoder: 'AMD VA-API', cardPath: '/dev/dri/card2', codecs: ['h264', 'av1'], latencyTargetMs: 100
});
assert.strictEqual(validateNativeScreenInfo('0x1002', 'card1', amd).supported, false);
assert.strictEqual(validateNativeScreenInfo('0x10de', 'card2', amd).supported, false);
assert.strictEqual(validateNativeScreenInfo('0x1002', 'card1', amd, 'flatpak').supported, true);

const cluster = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const clusterWith = value => Buffer.concat([cluster, Buffer.from([0x80|value.length]), Buffer.from(value)]);
const bytes = Buffer.concat([Buffer.from('header'), clusterWith(Buffer.concat([Buffer.from('one'),cluster,Buffer.from('inside')])), clusterWith('two'), clusterWith('three')]);
const segmenter = new WebmClusterSegmenter();
const output = [
  ...segmenter.push(bytes.subarray(0, 9)),
  ...segmenter.push(bytes.subarray(9, 17)),
  ...segmenter.push(bytes.subarray(17)),
  ...segmenter.push(null, true)
];
assert.deepStrictEqual(output.map(item => item.kind), ['init', 'cluster', 'cluster', 'cluster']);
assert.strictEqual(Buffer.concat(output.map(item => item.data)).equals(bytes), true);
assert.strictEqual(nativeScreenInfo('0x8086').supported, false);

const live = nativeScreenInfo('0x10de');
if (live.supported) {
  assert(live.codecs.includes('av1'));
  assert.strictEqual(nativeScreenInfo('0x10de', live.cardPath.split('/').at(-1)).supported, true);
  // Flatpak assigns its own DRM node names. The vendor remains authoritative;
  // system installs still require an exact selected-card match (covered above).
  if (live.source === 'flatpak') assert.strictEqual(nativeScreenInfo('0x10de', 'card999').supported, true);
  else assert.strictEqual(nativeScreenInfo('0x10de', 'card999').supported, false);
  console.log(`PASS native screen service framing and ${live.source} ${live.encoder} capability`);
} else {
  console.log('PASS native screen service framing and AMD capability fixture (live GPU AV1 unavailable: '+live.reason+')');
}
