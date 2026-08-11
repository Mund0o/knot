const fs = require('fs');
const { execFileSync, spawn } = require('child_process');

const FLATPAK_APP = 'com.dec05eba.gpu_screen_recorder';
const CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const RESUME_QUEUE_BYTES = 6 * 1024 * 1024;

function gpuScreenRecorderCommand() {
  for (const file of ['/usr/bin/gpu-screen-recorder', '/usr/local/bin/gpu-screen-recorder']) {
    if (fs.existsSync(file)) return { command: file, prefix: [], source: 'system' };
  }
  if (!fs.existsSync('/usr/bin/flatpak')) return null;
  try {
    execFileSync('/usr/bin/flatpak', ['info', FLATPAK_APP], { stdio: 'ignore', timeout: 4000 });
    return { command: '/usr/bin/flatpak', prefix: ['run', '--command=gpu-screen-recorder', FLATPAK_APP], source: 'flatpak' };
  } catch {
    return null;
  }
}

function parseInfo(output) {
  const lines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const vendor = lines.find(line => line.startsWith('vendor|'))?.slice(7) || '';
  const cardPath = lines.find(line => line.startsWith('card_path|'))?.slice(10) || '';
  const codecs = [];
  let section = '';
  for (const line of lines) {
    if (line.startsWith('section=')) { section = line.slice(8); continue; }
    if (section === 'video_codecs' && /^[a-z0-9_]+$/.test(line)) codecs.push(line);
  }
  return { vendor, cardPath, codecs };
}

function validateNativeScreenInfo(primaryGpuVendor = '', primaryGpuCard = '', info = {}, source = '') {
  const vendor = ({ '0x10de': 'nvidia', '0x1002': 'amd' })[String(primaryGpuVendor).toLowerCase()];
  if (!vendor) return { supported: false, reason: 'A discrete NVIDIA or AMD GPU is required' };
  const encoder = vendor === 'nvidia' ? 'NVENC' : 'AMD VA-API';
  if (info.vendor !== vendor) return { supported: false, reason: `${encoder} resolved to ${info.vendor || 'an unknown GPU vendor'}, not the selected ${vendor.toUpperCase()} card` };
  if (!info.codecs?.includes('av1')) return { supported: false, reason: `The selected ${vendor.toUpperCase()} card does not expose AV1 encoding` };
  if (primaryGpuCard && info.cardPath !== `/dev/dri/${primaryGpuCard}`) return { supported: false, reason: `${encoder} resolved to ${info.cardPath || 'an unknown card'}, not the selected ${primaryGpuCard}` };
  return { supported: true, source, vendor, encoder, cardPath: info.cardPath, codecs: info.codecs.filter(codec => codec === 'av1' || codec === 'h264'), latencyTargetMs: 100 };
}

function nativeScreenInfo(primaryGpuVendor = '', primaryGpuCard = '') {
  if (process.platform !== 'linux') return { supported: false, reason: 'Native GPU AV1 sharing is currently available on Linux' };
  if (!['0x10de', '0x1002'].includes(String(primaryGpuVendor).toLowerCase())) return { supported: false, reason: 'A discrete NVIDIA or AMD GPU is required' };
  const runner = gpuScreenRecorderCommand();
  if (!runner) return { supported: false, reason: 'Install GPU Screen Recorder or its Flatpak to enable GPU AV1 sharing' };
  try {
    const output = execFileSync(runner.command, [...runner.prefix, '--info'], { encoding: 'utf8', timeout: 7000 });
    return validateNativeScreenInfo(primaryGpuVendor, primaryGpuCard, parseInfo(output), runner.source);
  } catch (error) {
    return { supported: false, reason: error?.message || 'GPU Screen Recorder capability check failed' };
  }
}

function spawnRecorder(runner, args) {
  // gpu-screen-recorder reopens /dev/stdout. Node implements child stdout with
  // a socketpair, which cannot be reopened on Linux (ENXIO), so place a real
  // kernel pipe between the recorder and a byte-for-byte bridge to Electron.
  return spawn('/bin/bash', ['-o', 'pipefail', '-c', '"$@" | /bin/cat', 'knot-native-screen', runner.command, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
}

function signalRecorder(child, signal) {
  try { process.kill(-child.pid, signal);return; } catch {}
  try { child.kill(signal); } catch {}
}

class WebmClusterSegmenter {
  constructor() { this.buffer = Buffer.alloc(0); this.started = false; }
  clusterLength() {
    if (this.buffer.length < CLUSTER.length+1 || !this.buffer.subarray(0, CLUSTER.length).equals(CLUSTER)) return 0;
    const first = this.buffer[CLUSTER.length];let mask=0x80,sizeBytes=1;while(sizeBytes<=8&&!(first&mask)){mask>>=1;sizeBytes++;}
    if(sizeBytes>8||this.buffer.length<CLUSTER.length+sizeBytes)return 0;let size=first&(mask-1),unknown=size===mask-1;for(let index=1;index<sizeBytes;index++){const byte=this.buffer[CLUSTER.length+index];size=size*256+byte;unknown=unknown&&byte===0xff}if(unknown)return -1;const total=CLUSTER.length+sizeBytes+size;if(!Number.isSafeInteger(total)||total>64*1024*1024)throw new Error('Invalid WebM cluster size');return total;
  }
  push(chunk, flush = false) {
    if (chunk?.length) this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const output = [];
    if (!this.started) {
      const first = this.buffer.indexOf(CLUSTER);
      if (first < 0) return output;
      if (first) output.push({ kind: 'init', data: this.buffer.subarray(0, first) });
      this.buffer = this.buffer.subarray(first);this.started = true;
    }
    for (;;) {const length=this.clusterLength();if(length===-1){const next=this.buffer.indexOf(CLUSTER,CLUSTER.length);if(next<0)break;output.push({kind:'cluster',data:this.buffer.subarray(0,next)});this.buffer=this.buffer.subarray(next);continue}if(!length||this.buffer.length<length)break;output.push({kind:'cluster',data:this.buffer.subarray(0,length)});this.buffer=this.buffer.subarray(length);if(this.buffer.length&&!this.buffer.subarray(0,CLUSTER.length).equals(CLUSTER))break}
    if (flush && this.buffer.length) { output.push({ kind: this.started ? 'cluster' : 'init', data: this.buffer });this.buffer = Buffer.alloc(0); }
    return output;
  }
}

class NativeScreenService {
  constructor({ primaryGpuVendor = '', primaryGpuCard = '', onError = () => {} } = {}) {
    this.primaryGpuVendor = primaryGpuVendor;this.primaryGpuCard = primaryGpuCard;this.onError = onError;this.session = null;this.nextId = 1;
  }

  info() { return nativeScreenInfo(this.primaryGpuVendor, this.primaryGpuCard); }

  start(options = {}) {
    if (this.session) throw new Error('A native screen capture is already active');
    const info = this.info();if (!info.supported) throw new Error(info.reason);
    const runner = gpuScreenRecorderCommand();if (!runner) throw new Error('GPU Screen Recorder is unavailable');
    const codec = options.codec === 'h264' ? 'h264' : 'av1';
    const fps = Number(options.fps) === 30 ? 30 : 60;
    const width = [1280, 1920, 2560, 3840].includes(Number(options.width)) ? Number(options.width) : 3840;
    const height = [720, 1080, 1440, 2160].includes(Number(options.height)) ? Number(options.height) : 2160;
    const bitrateKbps = Math.max(8000, Math.min(80000, Math.round(Number(options.bitrateKbps) || 56000)));
    const cursor = options.cursor === 'never' ? 'no' : 'yes';
    const testCapture = process.env.KNOT_NATIVE_SCREEN_TEST === '1' && /^[A-Za-z0-9_.-]{1,64}$/.test(options.captureSource || '') ? options.captureSource : '';
    const args = [...runner.prefix, '-w', testCapture || 'portal', '-s', `${width}x${height}`, '-k', codec, '-encoder', 'gpu', '-f', String(fps), '-fm', 'cfr', '-bm', 'cbr', '-q', String(bitrateKbps), '-tune', 'performance', '-keyint', '1', '-cursor', cursor, '-fallback-cpu-encoding', 'no', '-c', 'webm'];
    const child = spawnRecorder(runner, args);
    const session = { id: this.nextId++, child, codec, fps, width, height, queue: [], queueBytes: 0, waiters: [], error: '', active: true, stopping: false, stderr: '', seq: 0, paused: false, segmenter: new WebmClusterSegmenter() };
    this.session = session;
    const enqueue = segment => {
      const item = { kind: segment.kind, seq: session.seq++, data: Buffer.from(segment.data) };
      const waiter = session.waiters.shift();if (waiter) waiter(item);else { session.queue.push(item);session.queueBytes += item.data.length; }
      if (!session.paused && session.queueBytes > MAX_QUEUE_BYTES) { child.stdout.pause();session.paused = true; }
    };
    child.stdout.on('data', chunk => { for (const segment of session.segmenter.push(chunk)) enqueue(segment); });
    child.stderr.on('data', chunk => { session.stderr = (session.stderr + chunk.toString()).slice(-8192); });
    child.on('error', error => { session.error = error?.message || String(error);this.onError(session.error); });
    child.on('close', code => {
      for (const segment of session.segmenter.push(null, true)) enqueue(segment);
      session.active = false;if (code && !session.stopping && !session.error) session.error = session.stderr.trim().split('\n').at(-1) || `GPU Screen Recorder exited with code ${code}`;
      while (session.waiters.length) session.waiters.shift()(null);
      if (session.error) this.onError(session.error);
    });
    return { id: session.id, codec, fps, width, height, source: info.source, vendor: info.vendor, encoder: info.encoder, latencyTargetMs: info.latencyTargetMs };
  }

  async read(id, timeoutMs = 1500) {
    const session = this.session;if (!session || session.id !== id) return { active: false, error: 'Native screen session ended' };
    let item = session.queue.shift();
    if (item) {
      session.queueBytes -= item.data.length;
      if (session.paused && session.queueBytes < RESUME_QUEUE_BYTES) { session.child.stdout.resume();session.paused = false; }
    } else if (session.active) {
      item = await new Promise(resolve => { const timer = setTimeout(() => { const index = session.waiters.indexOf(done);if (index >= 0) session.waiters.splice(index, 1);resolve(null); }, timeoutMs);const done = value => { clearTimeout(timer);resolve(value); };session.waiters.push(done); });
    }
    return item ? { active: true, kind: item.kind, seq: item.seq, data: item.data } : { active: session.active, error: session.error };
  }

  stop(id) {
    const session = this.session;if (!session || (id && session.id !== id)) return false;this.session = null;session.active = false;session.stopping = true;
    while (session.waiters.length) session.waiters.shift()(null);
    signalRecorder(session.child, 'SIGINT');
    const child = session.child;setTimeout(() => { if (child.exitCode === null && child.signalCode === null) signalRecorder(child, 'SIGTERM'); }, 1500).unref?.();return true;
  }
}

module.exports = { gpuScreenRecorderCommand, parseInfo, validateNativeScreenInfo, nativeScreenInfo, WebmClusterSegmenter, NativeScreenService };
