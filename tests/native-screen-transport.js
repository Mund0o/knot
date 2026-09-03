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

const requestedSeconds = Number(process.env.KNOT_NATIVE_SCREEN_TEST_SECONDS);
const enduranceMs = Math.max(35000, Math.min(90000, Number.isFinite(requestedSeconds) ? requestedSeconds*1000 : 45000));
let gpuProcessGone = 0;
app.on('child-process-gone', (_event, details) => { if (String(details?.type).toLowerCase() === 'gpu') gpuProcessGone++; });

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
    const senderChannel=senderPc.createDataChannel('knot-native-transport',nativeScreenChannelOptions());window._nativeChannelReliability={maxRetransmits:senderChannel.maxRetransmits,maxPacketLifeTime:senderChannel.maxPacketLifeTime};
    const audioContext=new AudioContext({sampleRate:48000,latencyHint:'interactive'}),tone=audioContext.createOscillator(),toneGain=audioContext.createGain(),voiceDestination=audioContext.createMediaStreamDestination();tone.frequency.value=337;toneGain.gain.value=.08;tone.connect(toneGain).connect(voiceDestination);tone.start();audioContext.resume().catch(()=>{});
    const voiceTrack=voiceDestination.stream.getAudioTracks()[0],voiceSender=senderPc.addTrack(voiceTrack,voiceDestination.stream);try{const parameters=voiceSender.getParameters();if(!parameters.encodings?.length)parameters.encodings=[{}];parameters.encodings[0].maxBitrate=128000;parameters.encodings[0].priority='high';parameters.encodings[0].networkPriority='high';voiceSender.setParameters(parameters).catch(()=>{})}catch{}
    let player,video,localPlayer,localVideo,decoderError='',firstSegmentAt=0,firstFrameAt=0,renderedFrames=0,chain=Promise.resolve(),nativeFallbacks=0,maxBufferedAmount=0,maxHeap=performance.memory?.usedJSHeapSize||0,minHeap=maxHeap,receiverWired=false,senderOpened=false,readyAckSent=false,binaryBeforeReady=false;
    const eventLoopDelays=[],health=[];let lastTick=performance.now();const loopTimer=setInterval(()=>{const now=performance.now();eventLoopDelays.push(Math.max(0,now-lastTick-20));if(eventLoopDelays.length>6000)eventLoopDelays.shift();lastTick=now;maxBufferedAmount=Math.max(maxBufferedAmount,senderChannel.bufferedAmount||0);const heap=performance.memory?.usedJSHeapSize||0;if(heap){maxHeap=Math.max(maxHeap,heap);minHeap=Math.min(minHeap||heap,heap)}},20);
    const inboundAudio=async()=>{let audio=null;for(const report of (await receiverPc.getStats()).values())if(report.type==='inbound-rtp'&&(report.kind==='audio'||report.mediaType==='audio')&&!report.isRemote)audio=report;return audio||{}};
    const sampleHealth=async()=>{const audio=await inboundAudio(),stats=player?.stats?.()||{};health.push({at:performance.now(),frames:stats.decodedFrames||0,audioPackets:Number(audio.packetsReceived)||0,audioBytes:Number(audio.bytesReceived)||0,concealed:Number(audio.concealedSamples)||0,samples:Number(audio.totalSamplesReceived)||0,jitter:Number(audio.jitter)||0});if(health.length>20)health.shift()};const healthTimer=setInterval(()=>sampleHealth().catch(()=>{}),5000);
    receiverPc.ontrack=event=>{if(event.track.kind!=='audio')return;const audio=document.createElement('audio');audio.autoplay=true;audio.hidden=true;audio.srcObject=event.streams[0]||new MediaStream([event.track]);document.body.append(audio);audio.play().catch(()=>{})};
    window._nativeTransportReady=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('native transport channel did not open')),8000),ready=()=>{if(!senderOpened||!receiverWired)return;clearTimeout(timer);resolve(true)};
      receiverPc.ondatachannel=event=>{
        const channel=event.channel;channel.binaryType='arraybuffer';video=document.createElement('video');video.muted=true;video.playsInline=true;video.autoplay=true;Object.assign(video.style,{position:'fixed',inset:'0',width:'100vw',height:'100vh',zIndex:'99999',objectFit:'contain',background:'#000'});document.body.append(video);
        player=createNativeScreenPlayer(video,'AV1',error=>{if(!decoderError)decoderError=error.message},{width:3840,height:2160,fps:60,enforceLatencyTarget:false});localVideo=document.createElement('video');localVideo.muted=true;localVideo.hidden=true;document.body.append(localVideo);localPlayer=createNativeScreenPlayer(localVideo,'AV1',()=>{},{width:3840,height:2160,fps:60,decode:false});localPlayer.setActive(false);channel._nativeReceive=nativeScreenReceiveState(player,{fps:60},error=>{if(!decoderError)decoderError=error.message});channel.onmessage=message=>{if(typeof message.data==='string'){const value=JSON.parse(message.data);if(value.t==='native-screen-meta')setTimeout(()=>{readyAckSent=true;channel.send(JSON.stringify({t:'native-screen-ready',transportVersion:NATIVE_SCREEN_PROTOCOL}))},150);return}if(!readyAckSent)binaryBeforeReady=true;receiveNativeScreenPacket(channel,message.data)};
        const countFrame=()=>{renderedFrames++;if(!firstFrameAt)firstFrameAt=performance.now();video.requestVideoFrameCallback(countFrame)};video.requestVideoFrameCallback(countFrame);receiverWired=true;ready()
      };
      senderChannel.onmessage=event=>{if(typeof event.data!=='string')return;const value=JSON.parse(event.data);if(value.t==='native-screen-ready'){senderChannel._nativePeerProtocol=Number(value.transportVersion)||0;settleNativeScreenReady(senderChannel,senderChannel._nativePeerProtocol>=NATIVE_SCREEN_PROTOCOL)}};
      senderChannel.onopen=()=>{senderOpened=true;ready()};
      (async()=>{const offer=await senderPc.createOffer();await senderPc.setLocalDescription(offer);await receiverPc.setRemoteDescription(offer);const answer=await receiverPc.createAnswer();await receiverPc.setLocalDescription(answer);await senderPc.setRemoteDescription(answer)})().catch(reject)
    });
    ipcRenderer.on('knot-native-segment',(_event,item)=>{if(!firstSegmentAt)firstSegmentAt=performance.now();const data=item.data instanceof Uint8Array?item.data:new Uint8Array(item.data);localPlayer?.append(data);chain=chain.then(()=>sendNativeScreenLiveItem(senderChannel,{kind:item.kind,key:item.key,frameCount:item.frameCount,capturedAt:item.capturedAt,discontinuity:item.discontinuity,data}));maxBufferedAmount=Math.max(maxBufferedAmount,senderChannel.bufferedAmount||0)});
    window._startNativeTransport=()=>{initializeNativeScreenSender(senderChannel,{t:'native-screen-meta',codec:'AV1',fps:60,width:3840,height:2160,encoder:'test',latencyTargetMs:110},77,()=>{nativeFallbacks++});return true};
    window._nativeTransportResult=new Promise((resolve,reject)=>ipcRenderer.once('knot-native-finish',()=>{chain.then(async()=>{const deadline=performance.now()+12000;let previous=-1,stable=0;while(performance.now()<deadline){const frames=player?.stats?.().decodedFrames||0;if(frames===previous)stable++;else stable=0;previous=frames;if(stable>=6)break;await new Promise(done=>setTimeout(done,100))}await sampleHealth();const stats=player?.stats?.()||{},localStats=localPlayer?.stats?.()||{},quality=video.getVideoPlaybackQuality?.()||{},totalFrames=stats.decodedFrames||quality.totalVideoFrames||0,painted=stats.paintedFrames||renderedFrames,audio=await inboundAudio(),sortedLoop=[...eventLoopDelays].sort((a,b)=>a-b),eventLoopP95=sortedLoop.length?sortedLoop[Math.ceil(sortedLoop.length*.95)-1]:0;clearInterval(loopTimer);clearInterval(healthTimer);resolve({mode:player?.mode||'mse',backend:stats.backend||player?.mode||'',backendFailures:stats.backendFailures||0,presentationMode:stats.presentationMode||'',width:stats.width||video.videoWidth,height:stats.height||video.videoHeight,currentTime:video.currentTime,renderedFrames:painted,totalFrames,droppedFrames:Math.max(0,totalFrames-painted),presentationDroppedFrames:stats.presentationDroppedFrames||0,renderFps:stats.renderFps||0,renderCadenceP95Ms:stats.renderCadenceP95Ms||0,decoderError,firstFrameMs:stats.firstPaintAt&&firstSegmentAt?stats.firstPaintAt-firstSegmentAt:firstFrameAt&&firstSegmentAt?firstFrameAt-firstSegmentAt:0,steadyStateP95Ms:stats.steadyStateP95Ms||0,latencySamples:stats.latencySamples||0,softwareFallback:!!stats.softwareFallback,localMode:localPlayer?.mode,localDecodeDisabled:!!localStats.decodeDisabled,localDecodeQueueSize:localStats.decodeQueueSize||0,maxBufferedAmount,nativeDroppedSegments:senderChannel._nativeSend?.droppedSegments||0,nativeFallbacks,audioPackets:Number(audio.packetsReceived)||0,audioBytes:Number(audio.bytesReceived)||0,audioConcealedSamples:Number(audio.concealedSamples)||0,audioTotalSamples:Number(audio.totalSamplesReceived)||0,audioJitter:Number(audio.jitter)||0,health,eventLoopP95,eventLoopMax:sortedLoop.at(-1)||0,heapGrowth:Math.max(0,maxHeap-minHeap),channelLifetime:senderChannel.maxPacketLifeTime,channelOrdered:senderChannel.ordered});player?.destroy();localPlayer?.destroy();tone.stop();voiceTrack.stop();audioContext.close().catch(()=>{});senderChannel.close();senderPc.close();receiverPc.close()}).catch(reject)}));
  })()`, true);
  await window.webContents.executeJavaScript('window._nativeTransportReady', true);
  await window.webContents.executeJavaScript('window._startNativeTransport()', true);

  const session = service.start({ codec: 'av1', fps: 60, width: 3840, height: 2160, bitrateKbps: 10000, captureSource: monitor });
  let firstClusterAt = 0,clusters = 0,segments = 0,sourceFrames = 0,maxSegmentBytes = 0;
  const startupDeadline = Date.now()+10000;
  while (Date.now()<startupDeadline || (firstClusterAt && Date.now()-firstClusterAt<enduranceMs)) {
    const item = await service.read(session.id, 2000);
    if (item.data) {
      window.webContents.send('knot-native-segment', { kind: item.kind, key: item.key, frameCount: item.frameCount, capturedAt: item.capturedAt, discontinuity: item.discontinuity, data: new Uint8Array(item.data) });
      segments++;sourceFrames+=Number(item.frameCount)||0;maxSegmentBytes=Math.max(maxSegmentBytes,item.data.length);
      if (item.kind === 'cluster') { clusters++;if (!firstClusterAt) firstClusterAt=Date.now(); }
    } else if (!item.active) throw new Error(item.error || 'native recorder stopped');
    if (!firstClusterAt && Date.now()>=startupDeadline) throw new Error('native recorder produced no AV1 clusters');
  }
  service.stop(session.id);
  window.webContents.send('knot-native-finish');
  const result = await window.webContents.executeJavaScript('window._nativeTransportResult', true);
  const channelReliability = await window.webContents.executeJavaScript('window._nativeChannelReliability', true);
  const metrics = { ...result, channelReliability, durationSeconds: enduranceMs/1000, clusters, segments, sourceFrames, maxSegmentBytes, gpuProcessGone };
  console.log('Native AV1 endurance metrics', JSON.stringify(metrics));
  assert.deepStrictEqual({ width: result.width, height: result.height }, { width: 3840, height: 2160 });
  assert(result.totalFrames >= Math.floor(enduranceMs/1000*35), `only decoded ${result.totalFrames} frames during ${enduranceMs/1000}s`);
  assert(!result.decoderError, result.decoderError);
  assert(result.firstFrameMs > 0 && result.firstFrameMs <= (result.backendFailures?500:150), `first frame took ${result.firstFrameMs.toFixed(0)}ms`);
  if (result.backend === 'webcodecs' && !result.softwareFallback) {
    assert(result.steadyStateP95Ms > 0 && result.steadyStateP95Ms <= 110, `hardware steady-state p95 was ${result.steadyStateP95Ms.toFixed(0)}ms (target: 110ms)`);
  }
  // Off-screen/occluded Electron windows receive fewer compositor callbacks
  // even while the decoder and generated track sustain 60 fps. Hardware must
  // remain close to display cadence; the deliberate software safety path has a
  // lower floor but may never trigger a codec or transport fallback.
  const minimumDisplayed=result.backendFailures?Math.floor(enduranceMs/1000*25):Math.floor(sourceFrames*(result.softwareFallback?.5:.85));
  assert(result.renderedFrames >= minimumDisplayed, `displayed only ${result.renderedFrames}/${sourceFrames} captured frames`);
  const droppedRatio=result.droppedFrames/Math.max(1,result.totalFrames);assert(droppedRatio<.1,`receiver dropped ${(droppedRatio*100).toFixed(1)}% of decoded frames`);
  if(result.renderFps)assert(result.renderFps>=50,`receiver presentation averaged only ${result.renderFps.toFixed(1)} fps`);
  if(result.renderCadenceP95Ms)assert(result.renderCadenceP95Ms<=40,`receiver presentation cadence p95 was ${result.renderCadenceP95Ms.toFixed(1)} ms`);
  if(result.backend==='mse'&&result.steadyStateP95Ms)assert(result.steadyStateP95Ms<=180.000001,`MediaSource live latency exceeded the 180ms ceiling: ${result.steadyStateP95Ms.toFixed(0)}ms`);
  assert.strictEqual(result.localMode, 'placeholder', 'sender created a local AV1 decoder');
  assert.strictEqual(result.localDecodeDisabled, true, 'sender preview decode was not disabled');
  assert(result.localDecodeQueueSize === 0, `sender preview queued ${result.localDecodeQueueSize} frames`);
  assert.deepStrictEqual(channelReliability, { maxRetransmits: 1, maxPacketLifeTime: null }, 'native channel does not make one RTT-bounded repair attempt');
  assert.strictEqual(result.channelOrdered, false, 'native channel still has cross-frame head-of-line blocking');
  assert(['track','video'].includes(result.presentationMode), 'receiver copied every 4K frame through a renderer canvas');
  assert.strictEqual(result.nativeFallbacks, 0, 'healthy loopback transport requested a WebRTC codec fallback');
  assert(result.maxBufferedAmount <= 5*1024*1024, `native channel buffered ${(result.maxBufferedAmount/1024/1024).toFixed(1)} MiB`);
  assert(result.audioPackets >= Math.floor(enduranceMs/1000*30), `voice delivered only ${result.audioPackets} packets`);
  assert(result.audioBytes > 100000, `voice delivered only ${result.audioBytes} bytes`);
  if (result.audioTotalSamples) assert(result.audioConcealedSamples/result.audioTotalSamples < 0.05, `voice concealment was ${(result.audioConcealedSamples/result.audioTotalSamples*100).toFixed(1)}%`);
  assert(result.audioJitter < 0.05, `voice jitter reached ${(result.audioJitter*1000).toFixed(1)}ms`);
  const usefulHealth=result.health.filter(sample=>sample.audioPackets>0);assert(usefulHealth.length>=6,'voice health was not sampled across the endurance run');
  for(let index=1;index<usefulHealth.length;index++)assert(usefulHealth[index].audioPackets>usefulHealth[index-1].audioPackets,'voice packets stopped during AV1 sharing');
  assert(usefulHealth.at(-1).frames>usefulHealth.at(-2).frames,'AV1 frames stopped before the endurance run ended');
  assert(result.eventLoopP95 < 100, `renderer event-loop p95 reached ${result.eventLoopP95.toFixed(0)}ms`);
  assert(result.heapGrowth < 256*1024*1024, `renderer heap grew ${(result.heapGrowth/1024/1024).toFixed(0)} MiB`);
  assert.strictEqual(gpuProcessGone, 0, 'Chromium GPU process crashed during native sharing');
  console.log('PASS native AV1 4K60 endurance with concurrent voice', JSON.stringify(metrics));
  window.destroy();
}

app.whenReady().then(main).then(()=>app.quit()).catch(error=>{console.error('Native screen transport test failed:',error?.stack||error);app.exit(1)});
