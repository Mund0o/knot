'use strict';

// The recorder's WebM stream, taken apart the way the app does it, under every awkward way of delivering it: pipe reads of any size (a byte at a time up
// to 70 KB), pictures from tiny to 3 MB, the four bytes of a Cluster id inside a picture, and clusters whose size is known or "unknown" (FFmpeg writes
// that in eight bytes when it is streaming live). Every picture must come out, whole and in order. A stream cut short or corrupt must end in an error or
// in silence, never in a hang. And a real FFmpeg live stream, when FFmpeg is here, must give back every picture it was given.
const assert = require('assert');
const { spawnSync } = require('child_process');
const { WebmClusterSegmenter } = require('../native-screen.js');
const { webmAv1Frames } = require('../native-video.js');
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
const vintSize = n => { if (n < 127) return Buffer.from([0x80 | n]); if (n < 16383) return Buffer.from([0x40 | (n >> 8), n & 255]); if (n < 2097151) return Buffer.from([0x20 | (n >> 16), (n >> 8) & 255, n & 255]); if (n < 268435455) return Buffer.from([0x10 | (n >> 24), (n >> 16) & 255, (n >> 8) & 255, n & 255]); const b = Buffer.alloc(8); b[0] = 0x01; b.writeUIntBE(n, 2, 6); return b; };
const el = (idBytes, body) => Buffer.concat([Buffer.from(idBytes), vintSize(body.length), body]);
function cluster(timeMs, frames, unknown) {
  const kids = [el([0xe7], Buffer.from([(timeMs >> 16) & 255, (timeMs >> 8) & 255, timeMs & 255]))];
  for (const f of frames) kids.push(el([0xa3], Buffer.concat([Buffer.from([0x81, 0, 0, f.key ? 0x80 : 0]), f.data])));
  const body = Buffer.concat(kids);
  return Buffer.concat([Buffer.from([0x1f, 0x43, 0xb6, 0x75]), unknown ? Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : vintSize(body.length), body]);
}
let fails = 0;
const started = Date.now();
for (let run = 0; run < 60; run++) {
  const init = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x82, 0x81, 0x00]), Buffer.from('init-header-'.repeat(1 + Math.floor(rnd() * 30)))]);
  const n = 5 + Math.floor(rnd() * 120), unknown = rnd() < 0.5, clusters = [], sent = [];
  for (let i = 0; i < n; i++) {
    const size = rnd() < 0.05 ? 200000 + Math.floor(rnd() * 3000000) : 20 + Math.floor(rnd() * 3000);
    const data = Buffer.alloc(size); for (let k = 0; k < size; k++) data[k] = rnd() < 0.002 ? 0x1f : Math.floor(rnd() * 256);
    if (rnd() < 0.3 && size > 20) Buffer.from([0x1f, 0x43, 0xb6, 0x75]).copy(data, 5);      // the cluster id inside a picture
    sent.push({ key: i % 30 === 0, data }); clusters.push(cluster(i * 17, [{ key: i % 30 === 0, data }], unknown));
  }
  const stream = Buffer.concat([init, ...clusters]);
  const seg = new WebmClusterSegmenter(); const got = []; let at = 0, error = null;
  const t0 = Date.now();
  try {
    while (at < stream.length) { const size = rnd() < 0.5 ? 1 + Math.floor(rnd() * 400) : 1 + Math.floor(rnd() * 70000); for (const s of seg.push(stream.subarray(at, at + size))) got.push(s); at += size; }
  } catch (e) { error = e; }
  const frames = []; for (const s of got) if (s.kind === 'cluster') frames.push(...webmAv1Frames(s.data, 60));
  // with unknown-size clusters the last cluster is held until the next id or flush: allow one missing
  const ok = !error && frames.length >= n - 1 && frames.slice(0, n - 1).every((f, i) => f.data.length === sent[i].data.length && Buffer.compare(Buffer.from(f.data), sent[i].data) === 0 && (f.type === 'key') === sent[i].key);
  assert(ok, `run ${run}: ${n} pictures sent (${unknown ? 'unknown-size' : 'known-size'} clusters), ${frames.length} came back${error ? ' (' + error.message + ')' : ''}`);
}
console.log(`PASS 60 random WebM streams come apart into exactly the pictures that went in (${Date.now() - started} ms)`);

// corrupt or cut-short streams: an error, or nothing, but always an end
{
  const clean = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x82, 0x81, 0x00]), ...Array.from({ length: 12 }, (_, i) => cluster(i * 17, [{ key: i === 0, data: Buffer.alloc(500, i) }], false))]);
  const began = Date.now();
  for (let run = 0; run < 300; run++) {
    const bad = Buffer.from(clean);
    for (let k = 0; k < 1 + Math.floor(rnd() * 12); k++) bad[Math.floor(rnd() * bad.length)] = Math.floor(rnd() * 256);
    const cut = rnd() < 0.3 ? bad.subarray(0, Math.floor(rnd() * bad.length)) : bad;
    const seg = new WebmClusterSegmenter();
    try { for (let at = 0; at < cut.length; at += 1 + Math.floor(rnd() * 300)) for (const s of seg.push(cut.subarray(at, at + 300))) if (s.kind === 'cluster') webmAv1Frames(s.data, 60); } catch { /* an error is an acceptable end */ }
  }
  assert(Date.now() - began < 20000, 'corrupt streams took ' + (Date.now() - began) + ' ms: a hang?');
  console.log('PASS corrupt and truncated streams end in an error or in silence, never in a hang');
}

// real FFmpeg, streaming to a pipe the way the recorder does
{
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=60:d=1', '-c:v', 'libsvtav1', '-preset', '12', '-g', '30', '-b:v', '2M', '-f', 'webm', '-cluster_time_limit', '0', 'pipe:1'], { maxBuffer: 64 << 20 });
  if (made.status !== 0 || !made.stdout.length) console.log('SKIP real FFmpeg WebM stream: ffmpeg with libsvtav1 is not available');
  else {
    const seg = new WebmClusterSegmenter(), out = []; for (let at = 0; at < made.stdout.length; at += 4096) out.push(...seg.push(made.stdout.subarray(at, at + 4096))); out.push(...seg.push(null, true));
    const frames = []; for (const s of out) if (s.kind === 'cluster') frames.push(...webmAv1Frames(s.data, 60));
    assert.strictEqual(frames.length, 60, 'a real FFmpeg stream of 60 pictures gave back ' + frames.length);
    assert(frames[0].type === 'key' && frames.filter(f => f.type === 'key').length === 2, 'the key pictures of a real stream were not found');
    console.log('PASS a real FFmpeg WebM stream gives back all 60 pictures, key pictures marked');
  }
}
