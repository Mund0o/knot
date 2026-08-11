const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { linuxMainGpu, applyLinuxMainGpuEnvironment } = require('../linux-gpu');
const { applyGpuAccelerationPolicy } = require('../gpu-acceleration');
const { NativeScreenService } = require('../native-screen');

const gpu = linuxMainGpu();
if (!gpu || !['0x10de', '0x1002'].includes(gpu.vendor)) {
  console.log('SKIP native screen transport: main discrete GPU is not NVIDIA or AMD');
  process.exit(0);
}
applyLinuxMainGpuEnvironment(gpu);
applyGpuAccelerationPolicy(app, { platform: process.platform, gpu, wayland: !!(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) });
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
process.env.KNOT_NATIVE_SCREEN_TEST = '1';

function recorderDetails(source) {
  const command = source === 'flatpak' ? '/usr/bin/flatpak' : '/usr/bin/gpu-screen-recorder';
  const args = source === 'flatpak' ? ['run', '--command=gpu-screen-recorder', 'com.dec05eba.gpu_screen_recorder', '--info'] : ['--info'];
  return execFileSync(command, args, { encoding: 'utf8', timeout: 7000 });
}

async function main() {
  const service = new NativeScreenService({ primaryGpuVendor: gpu.vendor, primaryGpuCard: gpu.card });
  const info = service.info();
  if (!info.supported) return console.log('SKIP native screen transport: '+info.reason);
  const details = recorderDetails(info.source);
  const monitor = details.split(/\r?\n/).find(line => /^[A-Za-z0-9_.-]+\|3840x2160$/.test(line))?.split('|')[0];
  if (!monitor) return console.log('SKIP native screen transport: no 3840x2160 monitor');

  const window = new BrowserWindow({
    show: true,
    width: 1280,
    height: 720,
    webPreferences: { contextIsolation: false, nodeIntegration: true, backgroundThrottling: false }
  });
  await window.loadFile(path.join(__dirname, '..', 'index.html'));
  await window.webContents.executeJavaScript(`(()=>{
    const {ipcRenderer}=require('electron');
    const senderPc=new RTCPeerConnection({iceServers:[]}),receiverPc=new RTCPeerConnection({iceServers:[]});
    senderPc.onicecandidate=event=>event.candidate&&receiverPc.addIceCandidate(event.candidate).catch(()=>{});
    receiverPc.onicecandidate=event=>event.candidate&&senderPc.addIceCandidate(event.candidate).catch(()=>{});
    const senderChannel=senderPc.createDataChannel('knot-native-transport',{ordered:true});
    let player,video,localPlayer,localVideo,decoderError='',firstSegmentAt=0,firstFrameAt=0,renderedFrames=0,chain=Promise.resolve();
    window._nativeTransportReady=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('native transport channel did not open')),8000);
      receiverPc.ondatachannel=event=>{
        const channel=event.channel;channel.binaryType='arraybuffer';video=document.createElement('video');video.muted=true;video.playsInline=true;video.autoplay=true;Object.assign(video.style,{position:'fixed',inset:'0',width:'100vw',height:'100vh',zIndex:'99999',objectFit:'contain',background:'#000'});document.body.append(video);
        player=createNativeScreenPlayer(video,'AV1',error=>{if(!decoderError)decoderError=error.message},{width:3840,height:2160,fps:60});localVideo=document.createElement('video');localVideo.muted=true;localVideo.hidden=true;document.body.append(localVideo);localPlayer=createNativeScreenPlayer(localVideo,'AV1',()=>{},{width:3840,height:2160,fps:60,allowSoftwareFallback:false});localPlayer.setActive(false);channel._nativeReceive={fragments:new Map(),complete:new Map(),nextSeq:0,player};channel.onmessage=message=>receiveNativeScreenPacket(channel,message.data);
        const countFrame=()=>{renderedFrames++;if(!firstFrameAt)firstFrameAt=performance.now();video.requestVideoFrameCallback(countFrame)};video.requestVideoFrameCallback(countFrame)
      };
      senderChannel.onopen=()=>{clearTimeout(timer);resolve(true)};
      (async()=>{const offer=await senderPc.createOffer();await senderPc.setLocalDescription(offer);await receiverPc.setRemoteDescription(offer);const answer=await receiverPc.createAnswer();await receiverPc.setLocalDescription(answer);await senderPc.setRemoteDescription(answer)})().catch(reject)
    });
    ipcRenderer.on('knot-native-segment',(_event,item)=>{if(!firstSegmentAt)firstSegmentAt=performance.now();const data=item.data instanceof Uint8Array?item.data:new Uint8Array(item.data);localPlayer?.append(data);chain=chain.then(()=>sendNativeScreenSegment(senderChannel,{kind:item.kind,seq:item.seq,data}))});
    window._nativeTransportResult=new Promise((resolve,reject)=>ipcRenderer.once('knot-native-finish',()=>{chain.then(async()=>{const deadline=performance.now()+10000;while(performance.now()<deadline){const stats=player?.stats?.()||{},quality=video.getVideoPlaybackQuality?.()||{};if((stats.width||video.videoWidth)===3840&&(stats.height||video.videoHeight)===2160&&(stats.decodedFrames||quality.totalVideoFrames||0)>=90)break;await new Promise(done=>setTimeout(done,50))}const stats=player?.stats?.()||{},localStats=localPlayer?.stats?.()||{},quality=video.getVideoPlaybackQuality?.()||{},totalFrames=stats.decodedFrames||quality.totalVideoFrames||0,painted=stats.paintedFrames||renderedFrames;resolve({mode:player?.mode||'mse',width:stats.width||video.videoWidth,height:stats.height||video.videoHeight,currentTime:video.currentTime,renderedFrames:painted,totalFrames,droppedFrames:Math.max(0,totalFrames-painted),decoderError,firstFrameMs:stats.firstPaintAt&&firstSegmentAt?stats.firstPaintAt-firstSegmentAt:firstFrameAt&&firstSegmentAt?firstFrameAt-firstSegmentAt:0,steadyStateP95Ms:stats.steadyStateP95Ms||0,latencySamples:stats.latencySamples||0,buffered:video.buffered.length?video.buffered.end(video.buffered.length-1)-video.buffered.start(0):0,softwareFallback:!!stats.softwareFallback,localSoftwareFallback:!!localStats.softwareFallback,localHardwareUnavailable:!!localStats.hardwareUnavailable,localDecodeQueueSize:localStats.decodeQueueSize||0});player?.destroy();localPlayer?.destroy();senderChannel.close();senderPc.close();receiverPc.close()}).catch(reject)}));
  })()`, true);
  await window.webContents.executeJavaScript('window._nativeTransportReady', true);

  const session = service.start({ codec: 'av1', fps: 60, width: 3840, height: 2160, bitrateKbps: 56000, captureSource: monitor });
  let firstClusterAt = 0,clusters = 0;
  const startupDeadline = Date.now()+10000;
  while (Date.now()<startupDeadline && (!firstClusterAt || Date.now()-firstClusterAt<4000)) {
    const item = await service.read(session.id, 2000);
    if (item.data) {
      window.webContents.send('knot-native-segment', { kind: item.kind, seq: item.seq, data: new Uint8Array(item.data) });
      if (item.kind === 'cluster') { clusters++;if (!firstClusterAt) firstClusterAt=Date.now(); }
    } else if (!item.active) throw new Error(item.error || 'native recorder stopped');
  }
  service.stop(session.id);
  window.webContents.send('knot-native-finish');
  const result = await window.webContents.executeJavaScript('window._nativeTransportResult', true);
  console.log('Native AV1 transport metrics', JSON.stringify({ ...result, clusters }));
  assert.deepStrictEqual({ width: result.width, height: result.height }, { width: 3840, height: 2160 });
  assert(result.totalFrames >= 90, `only decoded ${result.totalFrames} frames`);
  const latencyFallback = /100ms latency target/.test(result.decoderError);
  assert(!result.decoderError || latencyFallback, result.decoderError);
  assert(result.firstFrameMs > 0, 'first frame latency was not measured');
  if (!result.softwareFallback) assert(result.firstFrameMs <= 100, `hardware first frame took ${result.firstFrameMs.toFixed(0)}ms (target: 100ms)`);
  assert(result.latencySamples >= 60, `only measured ${result.latencySamples} steady-state frames`);
  if (latencyFallback) assert(result.softwareFallback, 'latency fallback occurred on a hardware decoder');
  else assert(result.steadyStateP95Ms > 0 && result.steadyStateP95Ms <= 100, `steady-state p95 was ${result.steadyStateP95Ms.toFixed(0)}ms (target: 100ms)`);
  assert.strictEqual(result.localSoftwareFallback, false, 'sender preview used CPU AV1 decode');
  assert(result.localDecodeQueueSize < 30, `sender preview queued ${result.localDecodeQueueSize} frames`);
  assert(result.droppedFrames <= Math.max(3, result.totalFrames*0.08), `dropped ${result.droppedFrames}/${result.totalFrames} frames`);
  console.log('PASS native AV1 transport', JSON.stringify({ ...result, clusters }));
  window.destroy();
}

app.whenReady().then(main).then(()=>app.quit()).catch(error=>{console.error('Native screen transport test failed:',error?.stack||error);app.exit(1)});
