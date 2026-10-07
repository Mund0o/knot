const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { parseInfo, validateNativeScreenInfo, WebmClusterSegmenter, nativeScreenInfo, nativeScreenInfoAsync } = require('../native-screen');

const parsed = parseInfo('section=gpu_info\nvendor|nvidia\ncard_path|/dev/dri/card1\nsection=video_codecs\nh264\nav1\nav1_10bit\n');
assert.deepStrictEqual(parsed, { vendor: 'nvidia', cardPath: '/dev/dri/card1', codecs: ['h264', 'av1', 'av1_10bit'] });
const amd = parseInfo('section=gpu_info\nvendor|amd\ncard_path|/dev/dri/card2\nsection=video_codecs\nh264\nav1\n');
assert.deepStrictEqual(validateNativeScreenInfo('0x1002', 'card2', amd, 'fixture'), {
  supported: true, source: 'fixture', vendor: 'amd', encoder: 'AMD VA-API', cardPath: '/dev/dri/card2', codecs: ['h264', 'av1'], latencyTargetMs: 110
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
const largePayload=Buffer.alloc(2*1024*1024,0x5a),largeBytes=Buffer.concat([Buffer.from('init'),clusterWith(largePayload)]),tinySegmenter=new WebmClusterSegmenter(),tinyOutput=[];
for(let offset=0;offset<largeBytes.length;offset+=1021)tinyOutput.push(...tinySegmenter.push(largeBytes.subarray(offset,Math.min(largeBytes.length,offset+1021))));
tinyOutput.push(...tinySegmenter.push(null,true));
assert(Buffer.concat(tinyOutput.map(item=>item.data)).equals(largeBytes),'chunk-queued WebM segmenter corrupted a multi-megabyte partial cluster');
const unknownClusterHeader=Buffer.from([0x1f,0x43,0xb6,0x75,0xff]);
const simpleBlock=payload=>Buffer.from([0xa3,0x80|payload.length,...payload]);
const embeddedClusterId=Buffer.from([0x81,0,0,0x80,0x1f,0x43,0xb6,0x75]);
const ordinaryBlock=Buffer.from([0x81,0,1,0]);
const unknownFirst=Buffer.concat([unknownClusterHeader,Buffer.from([0xe7,0x81,0]),simpleBlock(embeddedClusterId)]),unknownSecond=Buffer.concat([unknownClusterHeader,Buffer.from([0xe7,0x81,1]),simpleBlock(ordinaryBlock)]),unknownBytes=Buffer.concat([Buffer.from('init'),unknownFirst,unknownSecond]),unknownSegmenter=new WebmClusterSegmenter(),unknownOutput=[];
for(let offset=0;offset<unknownBytes.length;offset+=3)unknownOutput.push(...unknownSegmenter.push(unknownBytes.subarray(offset,offset+3)));
unknownOutput.push(...unknownSegmenter.push(null,true));
assert.deepStrictEqual(unknownOutput.map(item=>item.kind),['init','cluster','cluster'],'unknown-sized WebM clusters were not framed at EBML child boundaries');
assert(unknownOutput[1].data.equals(unknownFirst)&&unknownOutput[2].data.equals(unknownSecond),'AV1 payload bytes that resembled a Cluster ID split a live WebM frame');
assert.strictEqual(nativeScreenInfo('0x8086').supported, false);

const live = nativeScreenInfo('0x10de');
if (live.supported) {
  assert(live.codecs.includes('av1'));
  assert.strictEqual(nativeScreenInfo('0x10de', live.cardPath.split('/').at(-1)).supported, true);
  // Flatpak assigns its own DRM node names. The vendor remains authoritative;
  // system installs still require an exact selected-card match (covered above).
  if (live.source === 'flatpak') assert.strictEqual(nativeScreenInfo('0x10de', 'card999').supported, true);
  else assert.strictEqual(nativeScreenInfo('0x10de', 'card999').supported, false);
  console.log(`PASS native screen info and WebM framing: ${live.source} ${live.encoder} capability`);
} else {
  console.log('PASS native screen info and WebM framing: AMD capability fixture (live GPU AV1 unavailable: '+live.reason+')');
}

(async () => {
  assert.strictEqual((await nativeScreenInfoAsync('0x8086')).supported, false);
  console.log('PASS async capability probe refuses an integrated GPU');
})().catch(error => { console.error(error); process.exit(1); });
