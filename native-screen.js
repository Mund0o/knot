const fs = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');
const { webmAv1Frames } = require('./native-video');

const FLATPAK_APP = 'com.dec05eba.gpu_screen_recorder';
const CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
// Always drain the recorder and discard stale GOP data instead of pausing its
// stdout. Pausing back-pressures the capture/encoder pipeline and makes the
// desktop and Knot compositor visibly stutter when a WAN peer cannot keep up.
const MAX_QUEUE_BYTES = 1024 * 1024;
const MAX_SEGMENT_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_READ_WAITERS = 4;
const STOP_TERM_DELAY_MS = 1500;
const STOP_KILL_DELAY_MS = 4500;
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
  return { supported: true, source, vendor, encoder, cardPath: info.cardPath, codecs: info.codecs.filter(codec => codec === 'av1' || codec === 'h264'), latencyTargetMs: 100 };
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

function spawnRecorder(runner, args) {
  // gpu-screen-recorder reopens /dev/stdout. Node implements child stdout with
  // a socketpair, which cannot be reopened on Linux (ENXIO), so place a real
  // kernel pipe between the recorder and a byte-for-byte bridge to Electron.
  // Encoding is fully GPU-backed. Keep the capture/mux process at normal
  // priority: lowering it made portal frame acquisition starve behind games and
  // produced a visibly low-cadence stream even while NVENC/VA-API was healthy.
  return spawn('/bin/bash', ['-o', 'pipefail', '-c', '"$@" | /bin/cat', 'knot-native-screen', runner.command, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
}

function signalRecorder(child, signal) {
  try { process.kill(-child.pid, signal);return; } catch {}
  try { child.kill(signal); } catch {}
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

class NativeScreenService {
  constructor({ primaryGpuVendor = '', primaryGpuCard = '', onError = () => {}, _spawnRecorder = spawnRecorder, _recorderRunner = gpuScreenRecorderCommand, _stopDelays = null } = {}) {
    this.primaryGpuVendor = primaryGpuVendor;this.primaryGpuCard = primaryGpuCard;this.onError = onError;this.spawnRecorder = _spawnRecorder;this.recorderRunner = _recorderRunner;this.stopDelays = _stopDelays || { term: STOP_TERM_DELAY_MS, kill: STOP_KILL_DELAY_MS };this.session = null;this.retiring = null;this.nextId = 1;
  }

  info() { return nativeScreenInfo(this.primaryGpuVendor, this.primaryGpuCard); }

  infoAsync() { return nativeScreenInfoAsync(this.primaryGpuVendor, this.primaryGpuCard); }

  async startAsync(options = {}, isCurrent = () => true) {
    // stop() remains synchronous for IPC/API compatibility, but a replacement
    // capture must not overlap the detached recorder process being reaped.
    if(this.retiring)await this.retiring;
    if(!isCurrent())throw new Error('The screen-share document changed before capture started');
    const info=await this.infoAsync();
    if(this.retiring)await this.retiring;
    // The capability probe may take several seconds on a cold Flatpak start.
    // Re-check ownership afterwards so a reload cannot resurrect capture for
    // the document whose request began the probe.
    if(!isCurrent())throw new Error('The screen-share document changed before capture started');
    return this.start(options,info);
  }

  start(options = {},knownInfo=null) {
    if (this.retiring) throw new Error('The previous native screen capture is still stopping');
    if (this.session) throw new Error('A native screen capture is already active');
    const info = knownInfo||this.info();if (!info.supported) throw new Error(info.reason);
    const runner = this.recorderRunner();if (!runner) throw new Error('GPU Screen Recorder is unavailable');
    const codec = options.codec === 'h264' ? 'h264' : 'av1';
    const fps = Number(options.fps) === 30 ? 30 : 60;
    const requestedWidth = Number(options.width),requestedHeight = Number(options.height),sourceSize = requestedWidth === 0 && requestedHeight === 0;
    const width = sourceSize ? 0 : [1280, 1920, 2560, 3840].includes(requestedWidth) ? requestedWidth : 3840;
    const height = sourceSize ? 0 : [720, 1080, 1440, 2160].includes(requestedHeight) ? requestedHeight : 2160;
    // A native group share encodes once but fans the same stream to every peer.
    // Allow the renderer's total-upload budget to fall below 2 Mbps per viewer;
    // the old floor multiplied into an 18+ Mbps minimum for a full group.
    const bitrateKbps = Math.max(350, Math.min(40000, Math.round(Number(options.bitrateKbps) || 6000)));
    const cursor = options.cursor === 'never' ? 'no' : 'yes';
    const testCapture = process.env.KNOT_NATIVE_SCREEN_TEST === '1' && /^[A-Za-z0-9_.-]{1,64}$/.test(options.captureSource || '') ? options.captureSource : '';
    // FFmpeg's streaming WebM default may retain several encoded frames in one
    // Cluster. At 4K60 that created repeatable 8-frame / ~133 ms bursts before
    // bytes even reached Knot. One frame per Cluster keeps capture delivery at
    // display cadence; the lossy SCTP lane can then discard an individual stale
    // frame instead of an entire burst. The 150 ms key interval remains the
    // recovery bound after packet loss.
    // Spatial AQ improves perceptual allocation in flat regions where block
    // boundaries are easiest to see. Keep lookahead disabled so that quality
    // work does not add frames of latency. These are NVENC-specific options;
    // AMD VA-API keeps its proven low-latency defaults.
    const videoOptions=info.vendor==='nvidia'?['-ffmpeg-video-opts','spatial-aq=1;aq-strength=8;rc-lookahead=0;strict_gop=1']:[];
    const args = [...runner.prefix, '-w', testCapture || 'portal', '-s', `${width}x${height}`, '-k', codec, '-encoder', 'gpu', '-f', String(fps), '-fm', 'content', '-bm', 'cbr', '-q', String(bitrateKbps), '-tune', 'performance', '-keyint', '0.15', '-cursor', cursor, '-fallback-cpu-encoding', 'no', '-c', 'webm', ...videoOptions, '-ffmpeg-opts', 'cluster_time_limit=0'];
    const child = this.spawnRecorder(runner, args);
    const session = { id: this.nextId++, child, codec, fps, width, height, queue: [], queueBytes: 0, waiters: [], error: '', errorReported: false, active: true, stopping: false, stderr: '', seq: 0, discontinuity: false, droppedSegments: 0, segmenter: new WebmClusterSegmenter() };
    this.session = session;
    const reportSessionError=()=>{if(session.error&&!session.errorReported){session.errorReported=true;this.onError(session.error)}};
    const enqueue = segment => {
      const data = Buffer.from(segment.data);
      const frames = segment.kind === 'cluster' ? webmAv1Frames(data, fps) : [];
      const key = frames.some(frame => frame.type === 'key');
      const item = { kind: segment.kind, key, frameCount: frames.length, seq: session.seq++, capturedAt: Date.now(), data };
      const waiter = session.waiters.shift();if (waiter) waiter(item);else { session.queue.push(item);session.queueBytes += item.data.length; }
      if (session.queueBytes > MAX_QUEUE_BYTES && session.queue.length > 1) {
        const original=session.queue,latestInit=original.findLast(value=>value.kind==='init'),latestKey=original.findLastIndex(value=>value.kind==='cluster'&&value.key);let keep=[];
        if(latestInit)keep.push(latestInit);
        if(latestKey>0)keep.push(...original.slice(latestKey));
        else if(latestKey===0&&original.length===1)keep.push(original[0]);
        let keepBytes=keep.reduce((total,value)=>total+value.data.length,0);
        if(keepBytes>MAX_QUEUE_BYTES&&keep.filter(value=>value.kind==='cluster').length>1){keep=latestInit?[latestInit]:[];keepBytes=keep.reduce((total,value)=>total+value.data.length,0)}
        const retained=new Set(keep);for(const stale of original)if(!retained.has(stale))session.droppedSegments++;
        session.queue=keep;session.queueBytes=keepBytes;
        session.discontinuity = true;
      }
    };
    child.stdout.on('data', chunk => {
      if(!session.active||session.stopping)return;
      try { for (const segment of session.segmenter.push(chunk)) enqueue(segment); }
      catch(error){if(!session.error)session.error=error?.message||String(error);reportSessionError();this.stop(session.id)}
    });
    child.stderr.on('data', chunk => { session.stderr = (session.stderr + chunk.toString()).slice(-8192); });
    child.on('error', error => { session.error = error?.message || String(error);session.active=false;reportSessionError(); });
    child.on('close', code => {
      for(const timer of session.stopTimers||[])clearTimeout(timer);
      if(!session.stopping)try{for (const segment of session.segmenter.push(null, true)) enqueue(segment)}catch(error){if(!session.error)session.error=error?.message||String(error)}
      session.active = false;if (code && !session.stopping && !session.error) session.error = session.stderr.trim().split('\n').at(-1) || `GPU Screen Recorder exited with code ${code}`;
      while (session.waiters.length) session.waiters.shift()(null);
      if(this.session===session)this.session=null;
      session.resolveStopped?.();
      reportSessionError();
    });
    return { id: session.id, codec, fps, width, height, source: info.source, vendor: info.vendor, encoder: info.encoder, latencyTargetMs: info.latencyTargetMs };
  }

  async read(id, timeoutMs = 1500) {
    const session = this.session;if (!session || session.id !== id) return { active: false, error: 'Native screen session ended' };
    let item = session.queue.shift();
    if (item) {
      session.queueBytes -= item.data.length;
    } else if (session.active) {
      if(session.waiters.length>=MAX_READ_WAITERS)return{active:true,error:'Too many pending native screen reads'};
      item = await new Promise(resolve => { const timer = setTimeout(() => { const index = session.waiters.indexOf(done);if (index >= 0) session.waiters.splice(index, 1);resolve(null); }, timeoutMs);const done = value => { clearTimeout(timer);resolve(value); };session.waiters.push(done); });
    }
    if (item && session.discontinuity) { item.discontinuity = true;session.discontinuity = false; }
    return item ? { active: true, kind: item.kind, key: item.key, frameCount: item.frameCount, seq: item.seq, capturedAt: item.capturedAt, discontinuity: !!item.discontinuity, droppedSegments: session.droppedSegments, data: item.data } : { active: session.active, error: session.error };
  }

  stop(id) {
    const session = this.session;if (!session || (id && session.id !== id) || session.stopping) return false;session.active = false;session.stopping = true;
    while (session.waiters.length) session.waiters.shift()(null);session.queue.length=0;session.queueBytes=0;session.segmenter.queue.clear();
    const stopped=new Promise(resolve=>{session.resolveStopped=resolve});
    const retiring=stopped.finally(()=>{if(this.retiring===retiring)this.retiring=null});
    this.retiring=retiring;
    signalRecorder(session.child, 'SIGINT');
    const child = session.child,term=setTimeout(() => { if (child.exitCode === null && child.signalCode === null) signalRecorder(child, 'SIGTERM'); }, this.stopDelays.term),kill=setTimeout(() => { if (child.exitCode === null && child.signalCode === null) signalRecorder(child, 'SIGKILL'); }, this.stopDelays.kill);term.unref?.();kill.unref?.();session.stopTimers=[term,kill];return true;
  }

  async stopAsync(id) {
    const initiated=this.stop(id),retiring=this.retiring;
    if(retiring)await retiring;
    return initiated;
  }
}

module.exports = { gpuScreenRecorderCommand, gpuScreenRecorderCommandAsync, parseInfo, validateNativeScreenInfo, nativeScreenInfo, nativeScreenInfoAsync, ByteQueue, WebmClusterSegmenter, NativeScreenService };
