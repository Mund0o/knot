const assert = require('assert');
const fs = require('fs');
const { av1Description, av1Codec, webmAv1Frames, webmAv1FrameMeta } = require('../native-video');

const description = Uint8Array.from([0x81,0x0d,0x8c,0,0]);
const init = Buffer.concat([Buffer.from([0x63,0xa2,0x85]),Buffer.from(description)]);
assert.deepStrictEqual([...av1Description(init)],[...description]);
assert.strictEqual(av1Codec(description),'av01.0.13H.08');

const payload=Buffer.from([1,2,3,4]),simpleBlock=Buffer.concat([Buffer.from([0x81,0x00,0x02,0x80]),payload]);
const body=Buffer.concat([Buffer.from([0xe7,0x81,0x05,0xa3,0x80|simpleBlock.length]),simpleBlock]);
const cluster=Buffer.concat([Buffer.from([0x1f,0x43,0xb6,0x75,0x80|body.length]),body]);
const frames=webmAv1Frames(cluster,60);
assert.strictEqual(frames.length,1);
assert.strictEqual(frames[0].type,'key');
assert.strictEqual(frames[0].timestamp,7000);
assert.deepStrictEqual([...frames[0].data],[...payload]);
const meta=webmAv1FrameMeta(cluster,60);
assert.deepStrictEqual(meta,{key:true,frameCount:1},'key classification copied AV1 payloads instead of reading SimpleBlock flags');
assert.strictEqual(frames[0].data.buffer,cluster.buffer,'decoded AV1 frames copied the live cluster instead of sharing its bytes');

const liveFile=process.env.KNOT_AV1_TEST_FILE;
if(liveFile&&fs.existsSync(liveFile)){
  const bytes=fs.readFileSync(liveFile),signature=Buffer.from([0x1f,0x43,0xb6,0x75]),first=bytes.indexOf(signature),second=bytes.indexOf(signature,first+4);
  assert(first>0&&second>first);const liveDescription=av1Description(bytes.subarray(0,first));assert(liveDescription);assert(webmAv1Frames(bytes.subarray(first,second),60).length>0);
}
console.log('PASS low-latency WebM AV1 parser');
