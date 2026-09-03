const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { linuxMainGpu, applyLinuxMainGpuEnvironment } = require('../linux-gpu');
const { applyGpuAccelerationPolicy } = require('../gpu-acceleration');
const { NativeScreenService } = require('../native-screen');

const gpu = linuxMainGpu();
if (!gpu || !['0x10de', '0x1002'].includes(gpu.vendor)) {
  console.log('SKIP full-app native endurance: main discrete GPU is not NVIDIA or AMD');
  process.exit(0);
}
applyLinuxMainGpuEnvironment(gpu);
applyGpuAccelerationPolicy(app, {
  platform: process.platform,
  gpu,
  wayland: !!(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY)
});
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
process.env.KNOT_NATIVE_SCREEN_TEST = '1';

const requestedSeconds = Number(process.env.KNOT_FULL_APP_TEST_SECONDS);
const durationMs = Math.max(75000, Math.min(600000, Number.isFinite(requestedSeconds) ? requestedSeconds * 1000 : 120000));
const requestedUplinkMbps = Number(process.env.KNOT_FULL_APP_UPLINK_MBPS);
// A 16 Mbps CBR stream needs about 30 Mbps nominal capacity to remain at
// 4K60 through this test's deliberate 45% twelve-second bandwidth collapse.
// Lower-rate recovery is covered separately; it cannot preserve 60 unique
// source frames when the simulated wire carries fewer bits than the encoder.
const uplinkMbps = Math.max(8, Math.min(80, Number.isFinite(requestedUplinkMbps) ? requestedUplinkMbps : 30));
const crashes = [];
const unresponsive = [];
const processSamples = [];
let service = null;
let session = null;
let senderWindow = null;
let receiverWindow = null;
let nextSegmentAck = 1;
const segmentAcks = new Map();

ipcMain.on('knot-full-segment-ack', (_event, value = {}) => {
  const pending = segmentAcks.get(value.ackId);
  if (!pending) return;
  segmentAcks.delete(value.ackId);
  clearTimeout(pending.timer);
  if (value.ok) pending.resolve();
  else pending.reject(new Error(value.error || 'renderer rejected native screen segment'));
});

function sendFullSegment(window, item) {
  const ackId = nextSegmentAck++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      segmentAcks.delete(ackId);
      reject(new Error('full-app sender did not process a native segment within 4 seconds'));
    }, 4000);
    segmentAcks.set(ackId, { resolve, reject, timer });
    window.webContents.send('knot-full-segment', item, ackId);
  });
}

app.on('child-process-gone', (_event, details) => crashes.push({
  process: String(details?.type || 'unknown'),
  reason: String(details?.reason || 'unknown'),
  exitCode: Number(details?.exitCode) || 0,
  at: Date.now()
}));

function recorderDetails(source) {
  const command = source === 'flatpak' ? '/usr/bin/flatpak' : '/usr/bin/gpu-screen-recorder';
  const args = source === 'flatpak' ? ['run', '--command=gpu-screen-recorder', 'com.dec05eba.gpu_screen_recorder', '--info'] : ['--info'];
  return execFileSync(command, args, { encoding: 'utf8', timeout: 7000 });
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a-b);
  return sorted[Math.min(sorted.length-1, Math.max(0, Math.ceil(sorted.length*ratio)-1))];
}

function attachWindowTelemetry(window, name) {
  window.webContents.on('render-process-gone', (_event, details) => crashes.push({
    process: `${name}-renderer`,
    reason: String(details?.reason || 'unknown'),
    exitCode: Number(details?.exitCode) || 0,
    at: Date.now()
  }));
  window.webContents.on('unresponsive', () => unresponsive.push({ name, at: Date.now() }));
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /failed|error|crash/i.test(message)) console.error(`[${name} renderer]`, message);
  });
}

function createFullWindow(name, x) {
  const window = new BrowserWindow({
    show: true,
    x,
    y: 40,
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 680,
    backgroundColor: '#111318',
    title: `Knot full-app endurance — ${name}`,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'full-app-preload.js')
    }
  });
  window.setMenuBarVisibility(false);
  attachWindowTelemetry(window, name);
  return window;
}

async function installFullUi(window, role) {
  const result = await window.webContents.executeJavaScript(`(()=>{
    const role=${JSON.stringify(role)},selfId=role==='sender'?'11111111111111111111111111111111':'22222222222222222222222222222222',friendId=role==='sender'?'22222222222222222222222222222222':'11111111111111111111111111111111';
    const friends=Array.from({length:64},(_,index)=>({id:(index+16).toString(16).padStart(32,index===0?'2':'a').slice(-32),name:index===0?(role==='sender'?'AMD Friend':'NVIDIA Friend'):'Friend '+String(index+1).padStart(2,'0'),image:'',online:index%3!==0}));friends[0].id=friendId;
    directoryUserId=selfId;directorySnapshot={self:{id:selfId,name:role==='sender'?'NVIDIA Sender':'AMD Receiver',image:'',online:true},friends,members:{[selfId]:{id:selfId,name:role==='sender'?'NVIDIA Sender':'AMD Receiver',image:'',online:true},[friendId]:friends[0]},voiceStates:{},servers:Array.from({length:4},(_,serverIndex)=>({id:(serverIndex+1).toString(16).padStart(32,'b'),name:'Load Server '+(serverIndex+1),picture:'',owner:selfId,members:[selfId,friendId],channels:[{id:(serverIndex*3+1).toString(16).padStart(32,'c'),type:'text',name:'general'},{id:(serverIndex*3+2).toString(16).padStart(32,'c'),type:'text',name:'screens'},{id:(serverIndex*3+3).toString(16).padStart(32,'c'),type:'voice',name:'Voice'}]}))};
    directorySend=()=>true;activePeerId=friendId;dmCallPeerId=friendId;friendName=friends[0].name;profileName=directorySnapshot.self.name;renderServers();showFriends({expand:false});renderFriends();applyFriendProfile(friends[0]);
    const key='dm:'+friendId;conversationHistories[key]=Array.from({length:240},(_,index)=>({id:(index+1).toString(16).padStart(32,'d'),text:'Full application workload message '+(index+1)+' — screen sharing and voice remain responsive.',mine:index%2===0,author:{id:index%2===0?selfId:friendId,name:index%2===0?directorySnapshot.self.name:friends[0].name},time:Date.now()-(240-index)*15000}));openConversation(key);
    callActive=true;friendInCall=true;callStart=Date.now()-65000;setParticipant(participantYou,true);setParticipant(participantFriend,true);syncVoiceStage();
    const metrics={loop:[],raf:[],longTasks:[],heapMin:performance.memory?.usedJSHeapSize||0,heapMax:performance.memory?.usedJSHeapSize||0,uiTicks:0,speakingSeen:false,startedAt:performance.now()};let last=performance.now(),tick=0;
    metrics.loopTimer=setInterval(()=>{const now=performance.now();metrics.loop.push(Math.max(0,now-last-16));if(metrics.loop.length>45000)metrics.loop.shift();last=now;const heap=performance.memory?.usedJSHeapSize||0;if(heap){metrics.heapMin=Math.min(metrics.heapMin||heap,heap);metrics.heapMax=Math.max(metrics.heapMax,heap)}},16);
    metrics.rafTimer=setInterval(()=>{const started=performance.now();requestAnimationFrame(()=>{metrics.raf.push(performance.now()-started);if(metrics.raf.length>12000)metrics.raf.shift()})},100);
    try{metrics.observer=new PerformanceObserver(list=>{for(const entry of list.getEntries()){metrics.longTasks.push(entry.duration);if(metrics.longTasks.length>4000)metrics.longTasks.shift()}});metrics.observer.observe({entryTypes:['longtask']})}catch{}
    metrics.uiTimer=setInterval(()=>{tick++;metrics.uiTicks++;messageInput.value='UI probe '+tick;messageInput.dispatchEvent(new Event('input',{bubbles:true}));renderDmVoiceUI();refreshSpeakingPaint();if(document.querySelector('.speaking'))metrics.speakingSeen=true;messages.scrollTop=messages.scrollHeight;if(tick%20===0)renderFriends();screenStatus.dataset.probe=String(tick)},250);
    const summary=()=>({eventLoopP95:(${percentile.toString()})(metrics.loop,.95),eventLoopMax:Math.max(0,...metrics.loop),rafP95:(${percentile.toString()})(metrics.raf,.95),rafMax:Math.max(0,...metrics.raf),longTaskCount:metrics.longTasks.length,longTaskP95:(${percentile.toString()})(metrics.longTasks,.95),longTaskMax:Math.max(0,...metrics.longTasks),heapGrowth:Math.max(0,metrics.heapMax-metrics.heapMin),heapMax:metrics.heapMax,uiTicks:metrics.uiTicks,speakingSeen:metrics.speakingSeen,uptimeMs:performance.now()-metrics.startedAt});
    window.__fullUiMetrics=metrics;window.__fullUiSummary=summary;
    return{role,bodyChildren:document.body.children.length,messages:document.querySelectorAll('#messages .message').length,friends:document.querySelectorAll('#friendList .friend-entry').length,mediaStreamTrackGenerator:typeof MediaStreamTrackGenerator,videoTrackGenerator:typeof VideoTrackGenerator,videoDecoder:typeof VideoDecoder};
  })()`, true);
  return result;
}

async function prepareReceiver(window, offer) {
  return window.webContents.executeJavaScript(`(async()=>{
    window.__fullDecodeErrors=[];window.__fullLastPlayerStats={};const originalCreateNativeScreenPlayer=createNativeScreenPlayer;createNativeScreenPlayer=(video,codec,onError,options)=>originalCreateNativeScreenPlayer(video,codec,error=>{window.__fullDecodeErrors.push({message:String(error?.message||error),at:performance.now(),stats:nativeRemotePlayer?.stats?.()||window.__fullLastPlayerStats});onError(error)},options);
    pc=new RTCPeerConnection({iceServers:[]});
    pc.ondatachannel=event=>{if(event.channel.label==='knot-screen-native')wireNativeScreenChannel(event.channel,{remote:true})};
    pc.ontrack=event=>{if(event.track.kind!=='audio')return;const stream=event.streams[0]||new MediaStream([event.track]);remoteAudio.srcObject=stream;remoteAudio.volume=.65;remoteAudio.muted=false;monitorSpeaking('dm-friend',stream);remoteAudio.play().catch(()=>{})};
    const waitIce=connection=>connection.iceGatheringState==='complete'?Promise.resolve():new Promise(resolve=>{const done=()=>{if(connection.iceGatheringState==='complete'){connection.removeEventListener('icegatheringstatechange',done);resolve()}};connection.addEventListener('icegatheringstatechange',done);setTimeout(resolve,5000)});
    await pc.setRemoteDescription({type:'offer',sdp:${JSON.stringify(offer)}});const answer=await pc.createAnswer();await pc.setLocalDescription(answer);await waitIce(pc);focusedScreen='remote';screenExpanded=true;remoteScreenSuppressed=false;
    return pc.localDescription.sdp;
  })()`, true);
}

async function prepareSender(window) {
  return window.webContents.executeJavaScript(`(async()=>{
    pc=new RTCPeerConnection({iceServers:[]});
    const audioContext=new AudioContext({sampleRate:48000,latencyHint:'interactive'}),tone=audioContext.createOscillator(),gain=audioContext.createGain(),destination=audioContext.createMediaStreamDestination();tone.frequency.value=337;gain.gain.value=.08;tone.connect(gain).connect(destination);tone.start();await audioContext.resume().catch(()=>{});const voiceTrack=destination.stream.getAudioTracks()[0],voiceSender=pc.addTrack(voiceTrack,destination.stream);try{const parameters=voiceSender.getParameters();if(!parameters.encodings?.length)parameters.encodings=[{}];parameters.encodings[0].maxBitrate=256000;parameters.encodings[0].priority='high';parameters.encodings[0].networkPriority='high';await voiceSender.setParameters(parameters)}catch{}monitorSpeaking('dm-self',destination.stream);
    const channel=pc.createDataChannel('knot-screen-native',nativeScreenChannelOptions());wireNativeScreenChannel(channel);window.__fullFallbackMessages=[];channel.addEventListener('message',event=>{if(typeof event.data==='string')window.__fullFallbackMessages.push({message:event.data,at:performance.now()})});fallbackNativeScreenToWebRtc=async()=>{window.__fullFallbacks=(window.__fullFallbacks||0)+1};window.__fullVoice={audioContext,tone,voiceTrack,voiceSender};window.__fullNativeChannel=channel;
    const waitIce=connection=>connection.iceGatheringState==='complete'?Promise.resolve():new Promise(resolve=>{const done=()=>{if(connection.iceGatheringState==='complete'){connection.removeEventListener('icegatheringstatechange',done);resolve()}};connection.addEventListener('icegatheringstatechange',done);setTimeout(resolve,5000)});
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);await waitIce(pc);return pc.localDescription.sdp;
  })()`, true);
}

async function startSender(window, answer, info) {
  return window.webContents.executeJavaScript(`(async()=>{
    await pc.setRemoteDescription({type:'answer',sdp:${JSON.stringify(answer)}});const channel=window.__fullNativeChannel;await new Promise((resolve,reject)=>{if(channel.readyState==='open')return resolve();const timer=setTimeout(()=>reject(new Error('native channel did not open')),8000);channel.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true})});
    const makeConstrainedUplink=(real,rateMbps)=>{const events=new EventTarget(),queue=[];let queuedBytes=0,tokens=0,last=performance.now(),startedAt=last,threshold=NATIVE_SCREEN_BUFFER_LOW,lastBuffered=0,closed=false,ticks=0;const bytesPerMs=rateMbps*125;const transport={get readyState(){return real.readyState},get bufferedAmount(){return queuedBytes+(Number(real.bufferedAmount)||0)},get ordered(){return real.ordered},get maxPacketLifeTime(){return real.maxPacketLifeTime},get binaryType(){return real.binaryType},set binaryType(value){real.binaryType=value},get bufferedAmountLowThreshold(){return threshold},set bufferedAmountLowThreshold(value){threshold=Math.max(0,Number(value)||0)},addEventListener(type,listener,options){(type==='bufferedamountlow'?events:real).addEventListener(type,listener,options)},removeEventListener(type,listener,options){(type==='bufferedamountlow'?events:real).removeEventListener(type,listener,options)},send(value){if(typeof value==='string'){real.send(value);return}const data=value instanceof ArrayBuffer?value.slice(0):ArrayBuffer.isView(value)?value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength):value,size=Number(data?.byteLength)||0;if(!size)return;queue.push({data,size});queuedBytes+=size;transport._maxBuffered=Math.max(transport._maxBuffered||0,transport.bufferedAmount)},close(){closed=true;clearInterval(timer);queue.length=0;queuedBytes=0;real.close()}};const timer=setInterval(()=>{if(closed||real.readyState!=='open')return;const now=performance.now(),elapsed=Math.min(120,now-last);last=now;ticks++;const phase=Math.floor((now-startedAt)/12000)%4,multiplier=phase===1 ? 0.55 : phase===2 ? 1.2 : 1;tokens=Math.min(bytesPerMs*180,tokens+elapsed*bytesPerMs*multiplier);if(ticks%17!==0)while(queue.length&&queue[0].size<=tokens&&real.readyState==='open'){const item=queue.shift();queuedBytes-=item.size;tokens-=item.size;real.send(item.data)}const buffered=transport.bufferedAmount;if(lastBuffered>threshold&&buffered<=threshold)events.dispatchEvent(new Event('bufferedamountlow'));lastBuffered=buffered},20);return transport};
    const transport=makeConstrainedUplink(channel,${JSON.stringify(uplinkMbps)});channel.addEventListener('message',event=>{if(typeof event.data!=='string')return;try{const value=JSON.parse(event.data);if(value.t==='native-screen-ready'){transport._nativePeerProtocol=Number(value.transportVersion)||0;if(transport._nativePeerProtocol>=NATIVE_SCREEN_PROTOCOL)settleNativeScreenReady(transport,true)}}catch{}});
    nativeScreenSession={id:77,codec:'av1',fps:60,width:3840,height:2160,encoder:${JSON.stringify(info.encoder)},latencyTargetMs:110};nativeScreenChannel=channel;nativeScreenAnnounced=false;screenActive=true;screenPreview.hidden=false;screenPreview.muted=true;nativeLocalPlayer=createNativeScreenPlayer(screenPreview,'AV1',()=>{},{...nativeScreenSession,decode:false});initializeNativeScreenSender(transport,{t:'native-screen-meta',codec:'AV1',fps:60,width:3840,height:2160,encoder:${JSON.stringify(info.encoder)},latencyTargetMs:110},77,()=>{window.__fullFallbacks=(window.__fullFallbacks||0)+1});screenStatus.textContent='Full-app constrained-uplink test · sharing 3840×2160 · 60fps';focusedScreen='local';screenExpanded=false;updateScreenLayout();window.__fullNativeTransport=transport;
    window.__fullSendChain=Promise.resolve();window.__fullSegments=0;window.__fullBytes=0;window.__fullMaxBuffered=0;window.__fullPressureEvents=0;window.__fullStaleInputs=0;window.__fullDiscontinuities=0;window.__knotFullSegment=item=>{const data=item.data instanceof Uint8Array?item.data:new Uint8Array(item.data);window.__fullSegments++;window.__fullBytes+=data.byteLength;nativeLocalPlayer?.append(data);window.__fullSendChain=window.__fullSendChain.then(()=>{if(item.kind!=='init'&&item.key!==true){if((Number(transport.bufferedAmount)||0)+data.byteLength>nativeScreenBufferBudget(data.byteLength))window.__fullPressureEvents++;if(item.capturedAt&&Date.now()-Number(item.capturedAt)>NATIVE_SCREEN_STALE_MS)window.__fullStaleInputs++;if(item.discontinuity)window.__fullDiscontinuities++}return sendNativeScreenLiveItem(transport,{kind:item.kind,key:item.key,frameCount:item.frameCount,capturedAt:item.capturedAt,discontinuity:item.discontinuity,data})}).then(result=>{window.__fullMaxBuffered=Math.max(window.__fullMaxBuffered,transport._maxBuffered||0,transport.bufferedAmount||0);return result});return window.__fullSendChain};window.__knotFullFinish=()=>{window.__fullFinished=true};return true;
  })()`, true);
}

async function collectSender(window) {
  return window.webContents.executeJavaScript(`(async()=>{await window.__fullSendChain;let audio={};if(pc)for(const report of (await pc.getStats()).values())if(report.type==='outbound-rtp'&&(report.kind==='audio'||report.mediaType==='audio')&&!report.isRemote)audio=report;const transport=window.__fullNativeTransport,state=transport?._nativeSend||{},local=nativeLocalPlayer?.stats?.()||{};return{...window.__fullUiSummary(),segments:window.__fullSegments||0,bytes:window.__fullBytes||0,maxBufferedAmount:Math.max(window.__fullMaxBuffered||0,transport?._maxBuffered||0,transport?.bufferedAmount||0),pressureEvents:window.__fullPressureEvents||0,staleInputs:window.__fullStaleInputs||0,inputDiscontinuities:window.__fullDiscontinuities||0,droppedSegments:state.droppedSegments||0,droppedFrames:state.droppedFrames||0,sourceFrames:state.sourceFrames||0,sentFrames:state.sentFrames||0,discontinuities:state.discontinuities||0,fallbacks:window.__fullFallbacks||0,fallbackMessages:window.__fullFallbackMessages||[],channelOrdered:transport?.ordered,channelLifetime:transport?.maxPacketLifeTime,localMode:nativeLocalPlayer?.mode,localDecodeDisabled:!!local.decodeDisabled,audioPackets:Number(audio.packetsSent)||0,audioBytes:Number(audio.bytesSent)||0,audioTotalEncodeTime:Number(audio.totalEncodeTime)||0,connectionState:pc?.connectionState||'closed'}})()`, true);
}

async function collectReceiver(window) {
  return window.webContents.executeJavaScript(`(async()=>{let audio={};if(pc)for(const report of (await pc.getStats()).values())if(report.type==='inbound-rtp'&&(report.kind==='audio'||report.mediaType==='audio')&&!report.isRemote)audio=report;const player=nativeRemotePlayer?.stats?.()||window.__fullLastPlayerStats||{};if(nativeRemotePlayer?.stats)window.__fullLastPlayerStats=player;return{...window.__fullUiSummary(),playerMode:nativeRemotePlayer?.mode||'',backend:player.backend||nativeRemotePlayer?.mode||'',backendFailures:player.backendFailures||0,presentationMode:player.presentationMode||'',presentationDroppedFrames:player.presentationDroppedFrames||0,decodedFrames:player.decodedFrames||0,paintedFrames:player.paintedFrames||0,renderFps:player.renderFps||0,renderCadenceP95Ms:player.renderCadenceP95Ms||0,width:player.width||remoteScreen.videoWidth||0,height:player.height||remoteScreen.videoHeight||0,decodeQueueSize:player.decodeQueueSize||0,softwareFallback:!!player.softwareFallback,latencyExceeded:!!player.latencyExceeded,latencyViolationWindows:player.latencyViolationWindows||0,steadyStateP95Ms:player.steadyStateP95Ms||0,decoderLive:!!nativeRemotePlayer,decodeErrors:window.__fullDecodeErrors||[],audioPackets:Number(audio.packetsReceived)||0,audioBytes:Number(audio.bytesReceived)||0,audioConcealedSamples:Number(audio.concealedSamples)||0,audioTotalSamples:Number(audio.totalSamplesReceived)||0,audioJitter:Number(audio.jitter)||0,connectionState:pc?.connectionState||'closed',screenStatus:document.querySelector('#screenStatus')?.textContent||''}})()`, true);
}

async function main() {
  service = new NativeScreenService({ primaryGpuVendor: gpu.vendor, primaryGpuCard: gpu.card });
  const info = service.info();
  if (!info.supported) return console.log('SKIP full-app native endurance: '+info.reason);
  const details = recorderDetails(info.source);
  const monitor = details.split(/\r?\n/).find(line => /^[A-Za-z0-9_.-]+\|3840x2160$/.test(line))?.split('|')[0];
  if (!monitor) return console.log('SKIP full-app native endurance: no 3840x2160 monitor');

  senderWindow = createFullWindow('NVIDIA sender', 20);
  receiverWindow = createFullWindow('AMD receiver workload', 1220);
  await Promise.all([
    senderWindow.loadFile(path.join(__dirname, '..', 'index.html'), { query: { testMode: '1' } }),
    receiverWindow.loadFile(path.join(__dirname, '..', 'index.html'), { query: { testMode: '1' } })
  ]);
  // Let Knot's asynchronous settings/profile initialization settle before the
  // test installs a populated directory snapshot and active call.
  await wait(1800);
  const ui = await Promise.all([installFullUi(senderWindow, 'sender'), installFullUi(receiverWindow, 'receiver')]);
  console.log('Full app instances ready', JSON.stringify(ui));

  const offer = await prepareSender(senderWindow);
  const answer = await prepareReceiver(receiverWindow, offer);
  await startSender(senderWindow, answer, info);
  session = service.start({ codec: 'av1', fps: 60, width: 3840, height: 2160, bitrateKbps: 16000, captureSource: monitor });

  const processTimer=setInterval(()=>{try{processSamples.push(app.getAppMetrics().map(metric=>({pid:metric.pid,type:metric.type,cpu:Number(metric.cpu?.percentCPUUsage)||0,workingSetKb:Number(metric.memory?.workingSetSize)||0})));if(processSamples.length>durationMs/500+20)processSamples.shift()}catch{}},500);
  const healthTimer=setInterval(async()=>{try{const [sender,receiver]=await Promise.all([collectSender(senderWindow),collectReceiver(receiverWindow)]);console.log('Full app health',JSON.stringify({seconds:Math.round((sender.uptimeMs||0)/1000),sender:{loopP95:sender.eventLoopP95,rafP95:sender.rafP95,segments:sender.segments,buffer:sender.maxBufferedAmount,dropped:sender.droppedSegments,fallbacks:sender.fallbacks,audio:sender.audioPackets},receiver:{loopP95:receiver.eventLoopP95,rafP95:receiver.rafP95,frames:receiver.decodedFrames,queue:receiver.decodeQueueSize,audio:receiver.audioPackets,software:receiver.softwareFallback,errors:receiver.decodeErrors},crashes:crashes.length,unresponsive:unresponsive.length}))}catch(error){console.error('Full app health failed:',error.message)}},30000);
  let firstClusterAt=0,clusters=0,segments=0,sourceFrames=0,bytes=0,maxSegmentBytes=0;
  const startupDeadline=Date.now()+12000;
  while(Date.now()<startupDeadline||(firstClusterAt&&Date.now()-firstClusterAt<durationMs)){
    if(senderWindow.isDestroyed()||receiverWindow.isDestroyed()||crashes.some(value=>/-renderer$/.test(value.process)))break;
    const item=await service.read(session.id,2000);
    if(item.data){const payload={kind:item.kind,key:item.key,frameCount:item.frameCount,capturedAt:item.capturedAt,discontinuity:item.discontinuity,data:new Uint8Array(item.data)};await sendFullSegment(senderWindow,payload);segments++;sourceFrames+=Math.max(0,Number(item.frameCount)||0);bytes+=item.data.length;maxSegmentBytes=Math.max(maxSegmentBytes,item.data.length);if(item.kind==='cluster'){clusters++;if(!firstClusterAt)firstClusterAt=Date.now()}}
    else if(!item.active)throw new Error(item.error||'native recorder stopped');
    if(!firstClusterAt&&Date.now()>=startupDeadline)throw new Error('native recorder produced no AV1 clusters');
  }
  clearInterval(healthTimer);clearInterval(processTimer);const liveReceiver=await collectReceiver(receiverWindow);service.stop(session.id);session=null;senderWindow.webContents.send('knot-full-finish');await wait(3000);
  const [sender,receiver]=await Promise.all([collectSender(senderWindow),collectReceiver(receiverWindow)]);
  const flat=processSamples.flat(),byType={};for(const sample of flat){const key=sample.type||'unknown',current=byType[key]||(byType[key]={maxCpu:0,maxWorkingSetKb:0});current.maxCpu=Math.max(current.maxCpu,sample.cpu);current.maxWorkingSetKb=Math.max(current.maxWorkingSetKb,sample.workingSetKb)}
  const sourceMbps=bytes*8/durationMs/1000,cadenceReceiver=liveReceiver.decodedFrames?liveReceiver:receiver;
  const metrics={durationSeconds:durationMs/1000,simulatedUplinkMbps:uplinkMbps,sourceSegments:segments,sourceClusters:clusters,sourceFrames,sourceBytes:bytes,sourceMbps,maxSegmentBytes,sender,receiver,liveReceiver,processes:byType,crashes,unresponsive};
  console.log('Full app endurance metrics',JSON.stringify(metrics));

  assert.strictEqual(crashes.length,0,'a Knot renderer/GPU process crashed: '+JSON.stringify(crashes));
  assert.strictEqual(unresponsive.length,0,'a full Knot window became unresponsive');
  assert.strictEqual(sender.localMode,'placeholder','sender decoded its own AV1 stream');
  assert.strictEqual(sender.localDecodeDisabled,true,'sender preview decode was not disabled');
  assert.strictEqual(sender.channelOrdered,false,'full-app AV1 channel retained cross-frame head-of-line blocking');
  assert.strictEqual(sender.channelLifetime,null,'full-app AV1 channel unexpectedly uses a wall-clock packet lifetime');
  const segmentAwareBudget=Math.min(4*1024*1024+1024*1024,Math.max(1024*1024,maxSegmentBytes*3+192*1024));
  assert(sender.maxBufferedAmount<=segmentAwareBudget+2*60*1024,`bounded AV1 uplink queued ${(sender.maxBufferedAmount/1024).toFixed(0)} KiB for a ${(maxSegmentBytes/1024).toFixed(0)} KiB segment`);
  assert(sourceFrames>=Math.floor(durationMs/1000*55),`content-synchronized capture produced only ${(sourceFrames/(durationMs/1000)).toFixed(1)} source fps`);
  assert.strictEqual(sender.sourceFrames,sourceFrames,`sender accounted for ${sender.sourceFrames} of ${sourceFrames} captured frames`);
  assert.strictEqual(sender.sentFrames+sender.droppedFrames,sourceFrames,`sender lost frame accounting between ${sender.sentFrames} admitted and ${sender.droppedFrames} intentionally dropped frames`);
  const dropDemand=sender.pressureEvents+sender.staleInputs+sender.inputDiscontinuities;
  if(dropDemand)assert(sender.droppedSegments>0,`sender ignored ${dropDemand} non-key congestion/staleness events`);
  assert.strictEqual(sender.fallbacks,0,'healthy full-app sender requested fallback: '+JSON.stringify({messages:sender.fallbackMessages,decodeErrors:receiver.decodeErrors}));
  assert(receiver.decoderLive,'receiver AV1 player stopped');
  assert(['track','video'].includes(receiver.presentationMode),'receiver copied every 4K frame through the app renderer');
  assert.strictEqual(receiver.latencyExceeded,false,'receiver remained above the AV1 180ms processing ceiling');
  if(receiver.backend==='webcodecs'&&!receiver.softwareFallback&&receiver.steadyStateP95Ms)assert(receiver.steadyStateP95Ms<=110,`receiver AV1 processing p95 reached ${receiver.steadyStateP95Ms.toFixed(0)}ms`);
  assert(receiver.decodedFrames>=Math.floor(durationMs/1000*45),`receiver decoded only ${receiver.decodedFrames} frames`);
  assert(receiver.paintedFrames>=Math.floor(durationMs/1000*45),`receiver displayed only ${receiver.paintedFrames} frames`);
  assert(receiver.decodedFrames>=Math.floor(sender.sentFrames*.9),`receiver decoded ${receiver.decodedFrames} of ${sender.sentFrames} admitted frames`);
  assert(receiver.paintedFrames>=Math.floor(sender.sentFrames*.82),`receiver displayed ${receiver.paintedFrames} of ${sender.sentFrames} admitted frames`);
  assert((receiver.decodedFrames-receiver.paintedFrames)/receiver.decodedFrames<.08,`receiver lost ${(((receiver.decodedFrames-receiver.paintedFrames)/receiver.decodedFrames)*100).toFixed(1)}% of decoded frames before presentation`);
  assert(receiver.presentationDroppedFrames/receiver.decodedFrames<.08,`receiver presentation dropped ${(receiver.presentationDroppedFrames/receiver.decodedFrames*100).toFixed(1)}% of frames`);
  if(cadenceReceiver.renderFps)assert(cadenceReceiver.renderFps>=50,`receiver live presentation averaged only ${cadenceReceiver.renderFps.toFixed(1)} fps`);
  if(cadenceReceiver.renderCadenceP95Ms)assert(cadenceReceiver.renderCadenceP95Ms<=40,`receiver live presentation cadence p95 was ${cadenceReceiver.renderCadenceP95Ms.toFixed(1)}ms`);
  if(cadenceReceiver.backend==='mse'&&cadenceReceiver.steadyStateP95Ms)assert(cadenceReceiver.steadyStateP95Ms<=180.000001,`MediaSource live latency exceeded the 180ms ceiling: ${cadenceReceiver.steadyStateP95Ms.toFixed(0)}ms`);
  assert.deepStrictEqual({width:receiver.width,height:receiver.height},{width:3840,height:2160});
  assert(sender.audioPackets>=Math.floor(durationMs/1000*30),`sender voice produced only ${sender.audioPackets} packets`);
  assert(receiver.audioPackets>=Math.floor(durationMs/1000*30),`receiver voice received only ${receiver.audioPackets} packets`);
  if(receiver.audioTotalSamples)assert(receiver.audioConcealedSamples/receiver.audioTotalSamples<.05,`voice concealment reached ${(receiver.audioConcealedSamples/receiver.audioTotalSamples*100).toFixed(1)}%`);
  assert(receiver.audioJitter<.05,`voice jitter reached ${(receiver.audioJitter*1000).toFixed(1)}ms`);
  assert(sender.speakingSeen&&receiver.speakingSeen,'the live green speaking outline was not painted in both complete app windows');
  assert(sender.eventLoopP95<50,`sender full-app event-loop p95 reached ${sender.eventLoopP95.toFixed(1)}ms`);
  assert(sender.rafP95<100,`sender UI response p95 reached ${sender.rafP95.toFixed(1)}ms`);
  assert(receiver.eventLoopP95<75,`receiver full-app event-loop p95 reached ${receiver.eventLoopP95.toFixed(1)}ms`);
  assert(receiver.rafP95<120,`receiver UI response p95 reached ${receiver.rafP95.toFixed(1)}ms`);
  assert(sender.heapGrowth<256*1024*1024,`sender heap grew ${(sender.heapGrowth/1024/1024).toFixed(0)} MiB`);
  assert(receiver.heapGrowth<384*1024*1024,`receiver heap grew ${(receiver.heapGrowth/1024/1024).toFixed(0)} MiB`);
  console.log('PASS two complete Knot app instances sustained AV1 4K60 and voice',JSON.stringify(metrics));
}

app.whenReady().then(main).then(()=>app.quit()).catch(error=>{console.error('Full-app screen endurance failed:',error?.stack||error);try{if(session)service?.stop(session.id)}catch{};try{senderWindow?.destroy()}catch{};try{receiverWindow?.destroy()}catch{};app.exit(1)});
