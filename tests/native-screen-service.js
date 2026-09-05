const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { parseInfo, validateNativeScreenInfo, WebmClusterSegmenter, nativeScreenInfo, nativeScreenInfoAsync, NativeScreenService } = require('../native-screen');

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
  console.log(`PASS native screen service framing and ${live.source} ${live.encoder} capability`);
} else {
  console.log('PASS native screen service framing and AMD capability fixture (live GPU AV1 unavailable: '+live.reason+')');
}

(async () => {
  assert.strictEqual((await nativeScreenInfoAsync('0x8086')).supported, false);
  const service = new NativeScreenService({ primaryGpuVendor: '0x8086' });
  assert.strictEqual((await service.infoAsync()).supported, false);
  await assert.rejects(service.startAsync({}), /discrete NVIDIA or AMD GPU/);
  assert.strictEqual(typeof service.startAsync, 'function');
  assert.deepStrictEqual(service.readMany(1), { active: false, items: [] }, 'idle native screen drain invented live clusters');
  console.log('PASS non-blocking native screen capability API');
})().catch(error => { console.error(error);process.exitCode = 1; });

(async () => {
  // Fake children do not hold the event loop open like real OS processes do.
  const keepAlive = setTimeout(() => {}, 1000);
  const children = [];
  const spawnFake = (_runner,args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    child.args = args;
    child.kill = signal => {
      child.signals.push(signal);
      if (signal === 'SIGKILL') setImmediate(() => {
        child.signalCode = signal;
        child.emit('close', null, signal);
      });
      return true;
    };
    children.push(child);
    return child;
  };
  const supported = { supported: true, source: 'fixture', vendor: 'nvidia', encoder: 'NVENC', latencyTargetMs: 110 };
  const service = new NativeScreenService({
    _spawnRecorder: spawnFake,
    _recorderRunner: () => ({ command: '/fixture/recorder', prefix: [], source: 'fixture' }),
    _stopDelays: { term: 10, kill: 20 }
  });
  service.infoAsync = async () => supported;
  await assert.rejects(service.startAsync({},()=>false), /document changed/);
  assert.strictEqual(children.length,0,'a stale screen document started a recorder before its capability probe');
  let resolveProbe,current=true;
  service.infoAsync=()=>new Promise(resolve=>{resolveProbe=resolve});
  const staleAfterProbe=service.startAsync({},()=>current);
  await new Promise(resolve=>setImmediate(resolve));current=false;resolveProbe(supported);
  await assert.rejects(staleAfterProbe,/document changed/);
  assert.strictEqual(children.length,0,'a reload during the capability probe resurrected native capture');
  service.infoAsync = async () => supported;
  const first = service.start({bitrateKbps:100}, supported);
  assert.strictEqual(children[0].args[children[0].args.indexOf('-q')+1],'350','native group bitrate floor ignored the aggregate upload budget');
  assert.strictEqual(children[0].args[children[0].args.indexOf('-bm')+1],'cbr','native capture left constant bitrate, which is the only GPU Screen Recorder mode that honors a kbps ceiling');
  assert.strictEqual(children[0].args[children[0].args.indexOf('-fm')+1],'content','native capture stopped synchronizing encode work to changing content');
  assert.strictEqual(children[0].args[children[0].args.indexOf('-ffmpeg-video-opts')+1],'spatial-aq=1;aq-strength=8;rc-lookahead=0;strict_gop=1','NVENC perceptual quality, zero-lookahead, or bounded-GOP tuning was lost');
  assert.strictEqual(children[0].args[children[0].args.indexOf('-ffmpeg-opts')+1],'cluster_time_limit=0','native WebM muxing reintroduced multi-frame latency bursts');
  const oldSession = service.session;
  assert.strictEqual(service.stop(first.id), true);
  assert.strictEqual(service.stop(first.id), false);
  oldSession.child.stdout.write(Buffer.from('stale recorder output'));
  assert.strictEqual(oldSession.queue.length, 0, 'stdout emitted after stop must be discarded');
  assert.throws(() => service.start({}, supported), /still stopping/);
  const replacementPromise = service.startAsync({});
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.strictEqual(children.length, 1, 'replacement must wait while the old recorder is alive');
  await new Promise(resolve => setTimeout(resolve, 20));
  const replacement = await replacementPromise;
  assert.deepStrictEqual(children[0].signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.strictEqual(children.length, 2, 'replacement starts only after the old child close event');
  assert.notStrictEqual(replacement.id, first.id);
  await service.stopAsync(replacement.id);

  const classify = new NativeScreenService({
    _spawnRecorder: spawnFake,
    _recorderRunner: () => ({ command: '/fixture/recorder', prefix: [], source: 'fixture' }),
    _stopDelays: { term: 10, kill: 20 }
  });
  classify.infoAsync = async () => supported;
  const live = classify.start({bitrateKbps:100}, supported);
  const payload=Buffer.from([1,2,3,4]),simpleBlock=Buffer.concat([Buffer.from([0x81,0x00,0x02,0x80]),payload]);
  const body=Buffer.concat([Buffer.from([0xe7,0x81,0x05,0xa3,0x80|simpleBlock.length]),simpleBlock]);
  const cluster=Buffer.concat([Buffer.from([0x1f,0x43,0xb6,0x75,0x80|body.length]),body]);
  children.at(-1).stdout.write(Buffer.concat([Buffer.from('init-bytes'), cluster]));
  await new Promise(resolve=>setImmediate(resolve));
  const drained=classify.readMany(live.id);
  assert.strictEqual(drained.items.length,2,'native classify drain lost the init or key cluster');
  assert.strictEqual(drained.items[0].kind,'init');
  assert.strictEqual(drained.items[1].kind,'cluster');
  assert.strictEqual(drained.items[1].key,true,'native enqueue no longer classifies AV1 key clusters without copying payloads');
  assert.strictEqual(drained.items[1].frameCount,1);

  children.at(-1).emit('error', new Error('recorder stdin closed'));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert(children.at(-1).signals.includes('SIGINT')||children.at(-1).signals.includes('SIGKILL'),'a spawn/recorder error left the detached GPU recorder running');
  await classify.stopAsync(live.id);
  clearTimeout(keepAlive);
  console.log('PASS native screen recorder stop escalation and serialized restart');
})().catch(error => { console.error(error);process.exitCode = 1; });
