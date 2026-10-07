const fs = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');
const { webmAv1FrameMeta } = require('./native-video');

const FLATPAK_APP = 'com.dec05eba.gpu_screen_recorder';
const CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const MAX_SEGMENT_BUFFER_BYTES = 64 * 1024 * 1024;
let recorderRunnerResolved = false;
let recorderRunner = null;
let recorderRunnerPending = null;
const nativeInfoCache = new Map();
const nativeInfoPending = new Map();

function directRecorderRunner() {
  for (const file of ['/usr/bin/gpu-screen-recorder', '/usr/local/bin/gpu-screen-recorder']) {
    if (fs.existsSync(file)) return { command: file, prefix: [], source: 'system' };
  }
  return null;
}

function gpuScreenRecorderCommand() {
  if (recorderRunnerResolved) return recorderRunner;
  recorderRunnerResolved = true;
  const direct = directRecorderRunner();
  if (direct) return recorderRunner = direct;
  if (!fs.existsSync('/usr/bin/flatpak')) return null;
  try {
    execFileSync('/usr/bin/flatpak', ['info', FLATPAK_APP], { stdio: 'ignore', timeout: 4000 });
    return recorderRunner = { command: '/usr/bin/flatpak', prefix: ['run', '--command=gpu-screen-recorder', FLATPAK_APP], source: 'flatpak' };
  } catch {
    return null;
  }
}

function execFileOutput(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => error ? reject(error) : resolve(String(stdout || '')));
  });
}

async function gpuScreenRecorderCommandAsync() {
  if (recorderRunnerResolved) return recorderRunner;
  const direct = directRecorderRunner();
  if (direct) {
    recorderRunnerResolved = true;
    return recorderRunner = direct;
  }
  if (!fs.existsSync('/usr/bin/flatpak')) {
    recorderRunnerResolved = true;
    recorderRunner = null;
    return null;
  }
  if (!recorderRunnerPending) {
    recorderRunnerPending = execFileOutput('/usr/bin/flatpak', ['info', FLATPAK_APP], { timeout: 4000 })
      .then(() => ({ command: '/usr/bin/flatpak', prefix: ['run', '--command=gpu-screen-recorder', FLATPAK_APP], source: 'flatpak' }))
      .catch(() => null)
      .then(runner => {
        recorderRunner = runner;
        recorderRunnerResolved = true;
        recorderRunnerPending = null;
        return runner;
      });
  }
  return recorderRunnerPending;
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
  // Flatpak remaps DRM node names inside its device namespace (for example the
  // host card1 can legitimately appear as card9). Vendor validation plus the
  // DRI_PRIME environment still pins the discrete GPU; comparing sandbox and
  // host card names incorrectly disabled native AV1 and sent users through the
  // much heavier Chromium fallback path.
  if (source !== 'flatpak' && primaryGpuCard && info.cardPath !== `/dev/dri/${primaryGpuCard}`) return { supported: false, reason: `${encoder} resolved to ${info.cardPath || 'an unknown card'}, not the selected ${primaryGpuCard}` };
  return { supported: true, source, vendor, encoder, cardPath: info.cardPath, codecs: info.codecs.filter(codec => codec === 'av1' || codec === 'h264'), latencyTargetMs: 110 };
}

function nativeScreenInfo(primaryGpuVendor = '', primaryGpuCard = '') {
  if (process.platform !== 'linux') return { supported: false, reason: 'Native GPU AV1 sharing is currently available on Linux' };
  if (!['0x10de', '0x1002'].includes(String(primaryGpuVendor).toLowerCase())) return { supported: false, reason: 'A discrete NVIDIA or AMD GPU is required' };
  const cacheKey = `${String(primaryGpuVendor).toLowerCase()}|${primaryGpuCard}`;
  if (nativeInfoCache.has(cacheKey)) return nativeInfoCache.get(cacheKey);
  const runner = gpuScreenRecorderCommand();
  if (!runner) return { supported: false, reason: 'Install GPU Screen Recorder or its Flatpak to enable GPU AV1 sharing' };
  try {
    const output = execFileSync(runner.command, [...runner.prefix, '--info'], { encoding: 'utf8', timeout: 7000 });
    const result = validateNativeScreenInfo(primaryGpuVendor, primaryGpuCard, parseInfo(output), runner.source);nativeInfoCache.set(cacheKey, result);return result;
  } catch (error) {
    return { supported: false, reason: error?.message || 'GPU Screen Recorder capability check failed' };
  }
}

async function nativeScreenInfoAsync(primaryGpuVendor = '', primaryGpuCard = '') {
  if (process.platform !== 'linux') return { supported: false, reason: 'Native GPU AV1 sharing is currently available on Linux' };
  if (!['0x10de', '0x1002'].includes(String(primaryGpuVendor).toLowerCase())) return { supported: false, reason: 'A discrete NVIDIA or AMD GPU is required' };
  const cacheKey = `${String(primaryGpuVendor).toLowerCase()}|${primaryGpuCard}`;
  if (nativeInfoCache.has(cacheKey)) return nativeInfoCache.get(cacheKey);
  if (nativeInfoPending.has(cacheKey)) return nativeInfoPending.get(cacheKey);
  const pending = (async () => {
    const runner = await gpuScreenRecorderCommandAsync();
    if (!runner) return { supported: false, reason: 'Install GPU Screen Recorder or its Flatpak to enable GPU AV1 sharing' };
    try {
      const output = await execFileOutput(runner.command, [...runner.prefix, '--info'], { encoding: 'utf8', timeout: 7000, maxBuffer: 4 * 1024 * 1024 });
      const result = validateNativeScreenInfo(primaryGpuVendor, primaryGpuCard, parseInfo(output), runner.source);
      // Cache only a confirmed capability result. A transient Flatpak, driver,
      // or recorder timeout must not disable native sharing until Knot exits;
      // the next user-initiated share should be allowed to probe again.
      if(result.supported)nativeInfoCache.set(cacheKey, result);
      return result;
    } catch (error) {
      return { supported: false, reason: error?.message || 'GPU Screen Recorder capability check failed' };
    } finally {
      nativeInfoPending.delete(cacheKey);
    }
  })();
  nativeInfoPending.set(cacheKey, pending);
  return pending;
}

// Recorder stdout commonly splits a WebM cluster across many pipe reads. A
// repeated Buffer.concat for every read recopies the whole partial cluster and
// makes large 4K keyframes quadratic. This queue retains the original chunks
// and copies only once when a complete segment crosses chunk boundaries.
class ByteQueue {
  constructor() { this.chunks = [];this.head = 0;this.offset = 0;this.length = 0; }
  push(value) { if (value?.length) { const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);this.chunks.push(chunk);this.length+=chunk.length; } }
  clear() { this.chunks=[];this.head=0;this.offset=0;this.length=0; }
  compact() { if(this.head>32&&this.head*2>=this.chunks.length){this.chunks=this.chunks.slice(this.head);this.head=0} }
  byteAt(index) {
    if(!Number.isInteger(index)||index<0||index>=this.length)return undefined;let remaining=index;
    for(let position=this.head;position<this.chunks.length;position++){const chunk=this.chunks[position],start=position===this.head?this.offset:0,available=chunk.length-start;if(remaining<available)return chunk[start+remaining];remaining-=available}
    return undefined;
  }
  startsWith(pattern) { if(this.length<pattern.length)return false;for(let index=0;index<pattern.length;index++)if(this.byteAt(index)!==pattern[index])return false;return true; }
  indexOf(pattern,from=0) {
    const startAt=Math.max(0,Math.floor(Number(from)||0));if(!pattern?.length||startAt>=this.length)return-1;let absolute=0,matched=0;
    for(let position=this.head;position<this.chunks.length;position++)for(let index=position===this.head?this.offset:0;index<this.chunks[position].length;index++,absolute++){
      if(absolute<startAt)continue;const byte=this.chunks[position][index];if(byte===pattern[matched])matched++;else matched=byte===pattern[0]?1:0;if(matched===pattern.length)return absolute-pattern.length+1;
    }
    return-1;
  }
  take(size) {
    if(!Number.isInteger(size)||size<0||size>this.length)return null;if(!size)return Buffer.alloc(0);const first=this.chunks[this.head],available=first.length-this.offset;
    if(size<=available){const output=first.subarray(this.offset,this.offset+size);this.offset+=size;this.length-=size;if(this.offset===first.length){this.head++;this.offset=0;this.compact()}return output}
    const output=Buffer.allocUnsafe(size);let written=0;while(written<size){const chunk=this.chunks[this.head],count=Math.min(size-written,chunk.length-this.offset);chunk.copy(output,written,this.offset,this.offset+count);written+=count;this.offset+=count;if(this.offset===chunk.length){this.head++;this.offset=0}}
    this.length-=size;this.compact();return output;
  }
}

class WebmClusterSegmenter {
  constructor() { this.queue = new ByteQueue(); this.started = false; }
  element(offset, keepMarker = false) {
    if (offset >= this.queue.length) return null;
    const first=this.queue.byteAt(offset);let mask=0x80,length=1;
    while(length<=8&&!(first&mask)){mask>>=1;length++}
    if(length>8||offset+length>this.queue.length)return null;
    let value=keepMarker?first:first&(mask-1),unknown=!keepMarker&&value===mask-1;
    for(let index=1;index<length;index++){
      const byte=this.queue.byteAt(offset+index);value=value*256+byte;
      if(!Number.isSafeInteger(value))throw new Error('Invalid WebM element value');
      if(!keepMarker)unknown=unknown&&byte===0xff;
    }
    return{length,value,unknown};
  }
  clusterLength() {
    if (this.queue.length < CLUSTER.length+1 || !this.queue.startsWith(CLUSTER)) return 0;
    const clusterSize=this.element(CLUSTER.length);if(!clusterSize)return 0;
    if(!clusterSize.unknown){const total=CLUSTER.length+clusterSize.length+clusterSize.value;if(!Number.isSafeInteger(total)||total>MAX_SEGMENT_BUFFER_BYTES)throw new Error('Invalid WebM cluster size');return total}
    // FFmpeg may stream an unknown-sized Cluster. Searching its raw AV1 bytes
    // for the next Cluster ID can split on an identical four-byte sequence in
    // a frame payload. Walk the Cluster's EBML children instead, so only an ID
    // at a real element boundary can terminate it.
    let offset=CLUSTER.length+clusterSize.length;
    for(;;){
      const id=this.element(offset,true);if(!id)return 0;
      if(id.length===CLUSTER.length&&id.value===0x1f43b675)return offset;
      const size=this.element(offset+id.length);if(!size)return 0;
      if(size.unknown)throw new Error('Unknown-sized WebM Cluster child is unsupported');
      const end=offset+id.length+size.length+size.value;
      if(!Number.isSafeInteger(end)||end>MAX_SEGMENT_BUFFER_BYTES)throw new Error('Invalid WebM Cluster child size');
      if(end>this.queue.length)return 0;
      offset=end;
    }
  }
  push(chunk, flush = false) {
    this.queue.push(chunk);
    if (this.queue.length > MAX_SEGMENT_BUFFER_BYTES) throw new Error('WebM segment exceeded the native capture buffer');
    const output = [];
    if (!this.started) {
      const first = this.queue.indexOf(CLUSTER);
      if (first < 0) { if(flush&&this.queue.length)output.push({kind:'init',data:this.queue.take(this.queue.length)});return output; }
      if (first) output.push({ kind: 'init', data: this.queue.take(first) });
      this.started = true;
    }
    for (;;) {const length=this.clusterLength();if(!length||this.queue.length<length)break;output.push({kind:'cluster',data:this.queue.take(length)});if(this.queue.length&&!this.queue.startsWith(CLUSTER))break}
    if (flush && this.queue.length) output.push({ kind: this.started ? 'cluster' : 'init', data: this.queue.take(this.queue.length) });
    return output;
  }
}
module.exports = { gpuScreenRecorderCommand, gpuScreenRecorderCommandAsync, parseInfo, validateNativeScreenInfo, nativeScreenInfo, nativeScreenInfoAsync, WebmClusterSegmenter };
