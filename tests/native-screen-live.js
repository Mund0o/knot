const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { linuxMainGpu } = require('../linux-gpu');
const { NativeScreenService, nativeScreenInfo } = require('../native-screen');

async function main() {
  const gpu = linuxMainGpu();
  if (!gpu || !['0x10de', '0x1002'].includes(gpu.vendor)) return console.log('SKIP live native screen test: main discrete GPU is not NVIDIA or AMD');
  const info = nativeScreenInfo(gpu.vendor, gpu.card);
  if (!info.supported) return console.log('SKIP live native screen test: '+info.reason);
  const details = execFileSync(info.source === 'flatpak' ? '/usr/bin/flatpak' : '/usr/bin/gpu-screen-recorder', info.source === 'flatpak' ? ['run', '--command=gpu-screen-recorder', 'com.dec05eba.gpu_screen_recorder', '--info'] : ['--info'], { encoding: 'utf8', timeout: 7000 });
  const monitor = details.split(/\r?\n/).find(line => /^[A-Za-z0-9_.-]+\|3840x2160$/.test(line))?.split('|')[0];
  if (!monitor) return console.log('SKIP live native screen test: no 3840x2160 monitor');
  process.env.KNOT_NATIVE_SCREEN_TEST = '1';
  const errors = [],service = new NativeScreenService({ primaryGpuVendor: gpu.vendor, primaryGpuCard: gpu.card, onError: error => errors.push(error) });
  const session = service.start({ codec: 'av1', fps: 60, width: 3840, height: 2160, bitrateKbps: 56000, captureSource: monitor });
  const chunks = [],startupDeadline = Date.now()+10000;let clusters=0,captureStartedAt=0,terminalError='';
  while (Date.now()<startupDeadline && (!captureStartedAt || Date.now()-captureStartedAt<4000)) {
    const item = await service.read(session.id, 2000);
    if (item.data) {
      chunks.push(Buffer.from(item.data));
      if (item.kind === 'cluster') { clusters++;if (!captureStartedAt) captureStartedAt=Date.now(); }
    } else if (!item.active) { terminalError=item.error || '';break; }
  }
  service.stop(session.id);
  assert(captureStartedAt, `received no WebM clusters: ${terminalError || errors.join('; ')}`);
  assert(clusters >= 30, `only received ${clusters} complete WebM clusters in the capture window`);
  const file = path.join(os.tmpdir(), `knot-native-${process.pid}.webm`);fs.writeFileSync(file, Buffer.concat(chunks));
  try {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_read_packets', '-of', 'json', file], { encoding: 'utf8', timeout: 12000 }));
    const stream = probe.streams?.[0];assert.deepStrictEqual({ codec: stream?.codec_name, width: stream?.width, height: stream?.height, fps: stream?.r_frame_rate }, { codec: 'av1', width: 3840, height: 2160, fps: '60/1' });
    assert(Number(stream.nb_read_packets) >= 120, `only encoded ${stream.nb_read_packets || 0} video packets in the capture window`);
    assert.strictEqual(errors.length, 0, errors.join('; '));
    console.log(`PASS live ${info.encoder} AV1 ${stream.width}x${stream.height} ${stream.r_frame_rate}, ${stream.nb_read_packets} packets across ${clusters} complete clusters`);
  } finally { try { fs.unlinkSync(file); } catch {} }
}

main().catch(error => { console.error('Live native screen test failed:', error?.stack || error);process.exitCode=1; });
