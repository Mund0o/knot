/* Knot: manual-signaling, two-person P2P chat with application-level E2EE. */
const $=s=>document.querySelector(s);const signalOut=$('#signalOut'),signalIn=$('#signalIn'),copySignal=$('#copySignal'),processSignal=$('#processSignal'),pairCodeMeta=$('#pairCodeMeta'),statusText=$('#statusText'),messages=$('#messages'),messageForm=$('#messageForm'),messageInput=$('#messageInput'),fileInput=$('#fileInput'),chooseFiles=$('#chooseFiles'),transfers=$('#transfers'),pairHint=$('#pairHint'),participantYou=$('#participantYou'),participantFriend=$('#participantFriend'),voiceLog=$('#voiceLog'),screenBtn=$('#screenBtn'),screenStatus=$('#screenStatus'),screenPreview=$('#screenPreview'),remoteScreen=$('#remoteScreen');
const updateBanner=$('#updateBanner'),updateTitle=$('#updateTitle'),updateDetails=$('#updateDetails');let updateHideTimer=null;
function renderUpdateStatus(status){if(!updateBanner||!status)return;clearTimeout(updateHideTimer);const state=String(status.state||'idle');updateBanner.className='update-banner update-'+state;updateTitle.textContent=status.message||'Checking for updates…';updateDetails.textContent=status.version?'Knot '+status.version:'';updateBanner.hidden=state==='idle'||state==='current';if(state==='current')updateHideTimer=setTimeout(()=>{updateBanner.hidden=true},1200)}
if(window.pairUpdates){window.pairUpdates.getStatus().then(renderUpdateStatus).catch(()=>{});window.pairUpdates.onStatus(renderUpdateStatus)}
let pc,chat,files,role,sharedKey,sendQueue=Promise.resolve(),receiveQueue=Promise.resolve(),pairSignalBusy=false,pairReplyAccepted=false;let CHUNK=1024*1024;const MAX=200*1024**3;
let directoryTrustedConnection=false,recordConversationMessage=()=>{},directoryProfilePush=()=>{};
// Directory/call state must exist before any asynchronous settings/profile
// restoration can render the UI. Declaring it later created a startup TDZ race
// that only showed up reliably when two complete app windows booted together.
let directorySocket=null,directoryReconnect=null,directoryBackoff=1000,directoryUserId='',directoryToken='',directorySnapshot={friends:[],servers:[],members:{},voiceStates:{}},activePeerId='',dmPeerId='',dmCallPeerId='',activeServerId='',activeChannelId='',activeConversationKey='',historyRendering=false;
let conversationHistories={},historySaveTimer=null,serverVoiceStream=null,serverScreenStream=null,serverNativeScreenSession=null,serverNativeLocalPlayer=null,serverNativeScreenAudioStream=null,serverNativeScreenInit=null,serverNativeFallbackInFlight=false,serverVoiceMuted=false,serverScreenStarting=false,serverScreenGen=0,joinedVoiceServerId='',joinedVoiceChannelId='',joinedVoiceAt=0,voiceElapsedTimer=null,draggedChannelId='';const serverPeers=new Map();
const persistentDmPeers=new Map();
let socialSidebarWidth=280,pendingServerSelection=false,pendingChannelCreation=null;
// Voice: a live two-way WebRTC audio call on the SAME peer connection. Media is
// encrypted by WebRTC's built-in DTLS-SRTP, so it reuses the existing E2EE link.
let localStream=null,micMuted=false,callActive=false,callStart=0,callTimerId=null,callStarting=false,callGen=0,reconnectCall=false;
// Screen share: video via getDisplayMedia; system audio only via native
// process-loopback / PipeWire so Knot's own call playback is never re-captured.
let screenNative=false,screenOutCtx=null,screenOutDest=null,screenCaptureCleanup=null,screenCaptureOwner=null,screenCaptureAttempt=0;
// Direct handle to the audio transceiver created in setupPeer, so startCall can
// always reuse it (never add a second m-line). Nulled on disconnect/teardown.
let audioTransceiver=null;
// Keep the interface fully usable while this build is being tested without a
// second device. Network-only actions stay local and are clearly labelled.
// Local-only controls are opt-in for development. Packaged builds must never
// present themselves as a test client or enable call/share actions before a
// real peer connection exists.
const LOCAL_TEST_MODE=new URLSearchParams(location.search).get('testMode')==='1';
// Per-connection sound flags so the chimes don't double/triple: chat+files both
// report "connected", and connection-loss/voice-leave can each fire a leave tone.
let connectSoundDone=false,friendLeftNotified=false,friendInCall=false,friendPresenceTimer=null,selfInCall=false,selfPresenceTimer=null;
let screenTransceiver=null,screenActive=false,screenStarting=false,screenSharePickerPending=false,screenStream=null,screenGen=0,screenSenders=[],screenStatsTimer=null,screenStatsLast=null,screenFallbackBitrateCapMbps=0,remoteScreenExpected=false,remoteScreenSuppressed=false,screenAudioDebug='',screenSharePickerEpoch=0,screenSharePickerCancel=null,primedScreenAudioCtx=null,primedScreenAudioTimer=null;
let nativeScreenSession=null,nativeScreenChannel=null,remoteNativeScreenChannel=null,nativeLocalPlayer=null,nativeRemotePlayer=null,nativeRemoteAudio=null,nativeScreenFallbackInFlight=false,nativeScreenAnnounced=false,nativeScreenAudioStream=null;
const callBtn=$('#callBtn'),muteBtn=$('#muteBtn'),volumeSlider=$('#volumeSlider'),volumeValue=$('#volumeValue'),callStatus=$('#callStatus'),callTimerEl=$('#callTimer'),remoteAudio=$('#remoteAudio'),connectCard=$('#connectCard'),addFriendBtn=$('#addFriend'),panelBackdrop=$('#panelBackdrop'),profileBtn=$('#profileBtn'),profileInput=$('#profileInput'),profileAdjust=$('#profileAdjust'),profileEditor=$('#profileEditor'),profileZoom=$('#profileZoom'),profileX=$('#profileX'),profileY=$('#profileY'),profileDone=$('#profileDone'),friendAvatar=$('#friendAvatar'),voicePanel=$('#voicePanel'),roomTitle=$('#roomTitle'),settingsPanel=$('#settingsPanel'),settingsAvatar=$('#settingsAvatar'),settingsChangePhoto=$('#settingsChangePhoto'),settingsAdjustPhoto=$('#settingsAdjustPhoto'),settingsRemovePhoto=$('#settingsRemovePhoto'),displayNameInput=$('#displayName'),yourNameEl=$('#yourName'),friendNameEl=$('#friendName'),inputDevice=$('#inputDevice'),outputDevice=$('#outputDevice'),voiceProcessing=$('#voiceProcessing'),voiceInputMode=$('#voiceInputMode'),pushToTalkSettings=$('#pushToTalkSettings'),pushToTalkKeyButton=$('#pushToTalkKey'),pushToTalkDelayInput=$('#pushToTalkDelay'),pushToTalkDelayValue=$('#pushToTalkDelayValue'),deviceHint=$('#deviceHint'),testMicrophone=$('#testMicrophone'),reduceMotion=$('#reduceMotion'),soundEffects=$('#soundEffects'),shareProfile=$('#shareProfile'),rememberInvite=$('#rememberInvite'),hardwareAcceleration=$('#hardwareAcceleration'),hardwareHint=$('#hardwareHint');
function renderCallButtonState(state='start',label=state==='end'?'End call':'Start call',title=label){const end=state==='end';callBtn.dataset.callState=end?'end':'start';const text=callBtn.querySelector('.call-button-label');if(text)text.textContent=label;const startIcon=callBtn.querySelector('[data-call-icon="start"]'),endIcon=callBtn.querySelector('[data-call-icon="end"]');if(startIcon)startIcon.hidden=end;if(endIcon)endIcon.hidden=!end;callBtn.title=title;callBtn.setAttribute('aria-label',title)}
renderCallButtonState('start','Start call','Start voice call');
let profileAvatar='',profileFrame={zoom:100,x:50,y:50},profileIdentity=makeProfileIdentity(),profileName='You',friendName='Friend',inputDeviceId='default',outputDeviceId='default',voiceProcessingEnabled=false,voiceInputModeValue='voice',pushToTalkKey='Space',pushToTalkDelay=0,pushToTalkHeld=false,pushToTalkCapturing=false,pushToTalkReleaseTimer=null,soundEnabled=true,profileSharing=true,rememberInviteCode=true,micTestStream=null,micTestSource=null,micTestGain=null;
// A 5 MiB source GIF expands to roughly 6.7 MiB as a data URL. This remains
// below Knot's negotiated data-channel limit while allowing proper animations.
const MAX_PROFILE_DATA=7*1024*1024;
// The call stage stays above the direct-message timeline, matching a DM call.
// Keeping it in the document flow means messages are never hidden behind it.
// Lightweight synth sound effects via Web Audio (no asset files needed). Each
// call lazily creates/resumes the AudioContext so it works after a user gesture
// and stays quiet until then.
let audioCtx=null;
function sfxCtx(){if(!audioCtx){try{audioCtx=new (window.AudioContext||window.webkitAudioContext)();if(outputDeviceId&&typeof audioCtx.setSinkId==='function')audioCtx.setSinkId(outputDeviceId).catch(()=>{})}catch{return null}}if(audioCtx.state==='suspended'){try{audioCtx.resume()}catch{}}return audioCtx}
let speakingAudioCtx=null,remoteVoiceTrack=null;const speakingMonitors=new Map();
function speakingTargets(key){if(key==='dm-self')return[participantYou.querySelector('.avatar'),$('#sidebarProfileAvatar')].filter(Boolean);if(key==='dm-friend')return[participantFriend.querySelector('.avatar'),dmCallPeerId?document.querySelector(`.friend-entry[data-id="${dmCallPeerId}"] .friend-avatar`):null].filter(Boolean);const id=key.startsWith('server:')?key.slice(7):'';return id?[...document.querySelectorAll(`[data-speaking-id="${id}"]`)]:[]}
function paintSpeaking(key,on){speakingTargets(key).forEach(node=>node.classList.toggle('speaking',on))}
function refreshSpeakingPaint(){for(const [key,monitor] of speakingMonitors)paintSpeaking(key,!!monitor.speaking)}
function stopSpeakingMonitor(key){const monitor=speakingMonitors.get(key);if(monitor){clearInterval(monitor.timer);try{monitor.track?.removeEventListener?.('ended',monitor.onEnded)}catch{}try{monitor.source.disconnect()}catch{}try{monitor.analyser.disconnect()}catch{}try{monitor.sink?.disconnect()}catch{}speakingMonitors.delete(key)}paintSpeaking(key,false);if(!speakingMonitors.size&&speakingAudioCtx){try{speakingAudioCtx.close()}catch{}speakingAudioCtx=null}}
function monitorSpeaking(key,stream){
  const track=stream?.kind==='audio'?stream:stream?.getAudioTracks?.().find(value=>value.readyState==='live')||stream?.getAudioTracks?.()[0];const current=speakingMonitors.get(key);if(current?.track===track&&track?.readyState==='live'){if(speakingAudioCtx?.state==='suspended')speakingAudioCtx.resume().catch(()=>{});return}stopSpeakingMonitor(key);if(!track)return;
  try{
    if(!speakingAudioCtx)speakingAudioCtx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000});
    if(speakingAudioCtx.state==='suspended')speakingAudioCtx.resume().catch(()=>{});
    const source=speakingAudioCtx.createMediaStreamSource(new MediaStream([track])),analyser=speakingAudioCtx.createAnalyser(),sink=speakingAudioCtx.createGain(),samples=new Float32Array(256),monitor={track,source,analyser,sink,timer:null,onEnded:null,speaking:false,noiseFloor:.003,holdUntil:0};
    analyser.fftSize=256;analyser.smoothingTimeConstant=0;sink.gain.value=0;source.connect(analyser).connect(sink).connect(speakingAudioCtx.destination);
    // A short adaptive gate reacts in one sample (~24 ms) but learns each
    // microphone's idle floor. Separate open/close thresholds stop the ring
    // flickering between syllables without keeping it lit after speech ends.
    monitor.timer=setInterval(()=>{
      analyser.getFloatTimeDomainData(samples);let energy=0,peak=0;
      for(const sample of samples){energy+=sample*sample;peak=Math.max(peak,Math.abs(sample))}
      const rms=Math.sqrt(energy/samples.length),now=performance.now(),openGate=Math.max(.0075,monitor.noiseFloor*2.7),closeGate=Math.max(.0055,monitor.noiseFloor*1.8);
      if(!monitor.speaking&&rms<openGate)monitor.noiseFloor=monitor.noiseFloor*.94+rms*.06;
      const voiced=track.enabled!==false&&track.readyState==='live'&&(rms>(monitor.speaking?closeGate:openGate)||peak>openGate*2.1);
      if(voiced)monitor.holdUntil=now+165;
      const speaking=voiced||now<monitor.holdUntil;
      if(speaking!==monitor.speaking){monitor.speaking=speaking;paintSpeaking(key,speaking)}
    },24);
    monitor.onEnded=()=>{if(speakingMonitors.get(key)===monitor)stopSpeakingMonitor(key)};speakingMonitors.set(key,monitor);track.addEventListener?.('ended',monitor.onEnded,{once:true});
  }catch{paintSpeaking(key,false)}
}
function ensureRemoteSpeakingMonitor(){const track=remoteVoiceTrack?.readyState==='live'?remoteVoiceTrack:remoteAudio?.srcObject?.getAudioTracks?.().find(value=>value.readyState==='live');if(track){remoteVoiceTrack=track;monitorSpeaking('dm-friend',track)}else stopSpeakingMonitor('dm-friend')}
// Browsers keep a freshly created AudioContext 'suspended' until a user gesture.
// The connect chime fires from async channel-open callbacks (outside a gesture),
// so pre-warm/resume the context on the first interaction anywhere on the page.
function warmAudio(){const c=sfxCtx();if(c&&c.state==='suspended'){try{c.resume()}catch{}}if(speakingAudioCtx?.state==='suspended')speakingAudioCtx.resume().catch(()=>{})}
document.addEventListener('pointerdown',warmAudio,{once:true});
document.addEventListener('keydown',warmAudio,{once:true});
function tone(ctx,freq,start,dur,type='sine',gain=0.18){const o=ctx.createOscillator(),g=ctx.createGain();o.type=type;o.frequency.setValueAtTime(freq,ctx.currentTime+start);g.gain.setValueAtTime(0,ctx.currentTime+start);g.gain.linearRampToValueAtTime(gain,ctx.currentTime+start+0.02);g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+start+dur);o.connect(g).connect(ctx.destination);o.start(ctx.currentTime+start);o.stop(ctx.currentTime+start+dur+0.02)}
function setParticipant(el,on){if(el===participantFriend){setFriendPresence(on,{sound:false});return}if(el===participantYou){setSelfPresence(on);return}const dot=el.querySelector('.indicator');if(dot)dot.classList.toggle('on',on)}
function syncVoiceStage(){voicePanel.classList.toggle('call-active',!!(callActive||friendInCall));renderDmVoiceUI()}
function setFriendPresence(on,{animate=true,sound=true}={}){
  const wasPresent=friendInCall;friendInCall=on;if(!on&&(remoteScreenExpected||remoteScreen.srcObject||!remoteScreen.hidden))clearRemoteScreenShare('Friend left the call');syncVoiceStage();const dot=participantFriend.querySelector('.indicator');if(dot)dot.classList.toggle('on',on);
  if(friendPresenceTimer){clearTimeout(friendPresenceTimer);friendPresenceTimer=null}
  if(on){
    participantFriend.classList.remove('is-absent','is-leaving');participantFriend.removeAttribute('aria-hidden');
    if(animate&&!wasPresent){participantFriend.classList.remove('is-entering');void participantFriend.offsetWidth;participantFriend.classList.add('is-entering');if(sound)playSound('friend-join')}
    return;
  }
  if(!wasPresent){participantFriend.classList.remove('is-entering','is-leaving');participantFriend.classList.add('is-absent');participantFriend.setAttribute('aria-hidden','true');return}
  participantFriend.classList.remove('is-entering');
  if(animate){participantFriend.classList.add('is-leaving');friendPresenceTimer=setTimeout(()=>{if(!friendInCall){participantFriend.classList.remove('is-leaving');participantFriend.classList.add('is-absent');participantFriend.setAttribute('aria-hidden','true')}},430)}else{participantFriend.classList.remove('is-leaving');participantFriend.classList.add('is-absent');participantFriend.setAttribute('aria-hidden','true')}
  if(sound)playSound('friend-leave');
}
function setSelfPresence(on){
  const wasPresent=selfInCall;selfInCall=on;syncVoiceStage();const dot=participantYou.querySelector('.indicator');if(dot)dot.classList.toggle('on',on);
  if(selfPresenceTimer){clearTimeout(selfPresenceTimer);selfPresenceTimer=null}
  if(on){participantYou.classList.remove('is-absent','is-leaving');participantYou.removeAttribute('aria-hidden');if(!wasPresent){participantYou.classList.remove('is-entering');void participantYou.offsetWidth;participantYou.classList.add('is-entering')}return}
  if(!wasPresent){participantYou.classList.remove('is-entering','is-leaving');participantYou.classList.add('is-absent');participantYou.setAttribute('aria-hidden','true');return}
  participantYou.classList.remove('is-entering');participantYou.classList.add('is-leaving');selfPresenceTimer=setTimeout(()=>{if(!selfInCall){participantYou.classList.remove('is-leaving');participantYou.classList.add('is-absent');participantYou.setAttribute('aria-hidden','true')}},430);
}
let localCallSessionId='',remoteCallSessionId='';
function publishCallState(active){
  if(active&&!localCallSessionId)localCallSessionId=clientHex(8);
  try{send({t:'call-state',active:!!active,session:localCallSessionId,at:Date.now()})}catch{}
  if(!active)localCallSessionId='';
}
function applyRemoteCallState(active,session=''){
  if(active){remoteCallSessionId=String(session||remoteCallSessionId||'legacy');friendLeftNotified=false;setFriendPresence(true,{animate:true,sound:false});renderCallPeerProfile();setRemoteCallAudio(callActive);if(callActive)ensureRemoteSpeakingMonitor();return}
  remoteCallSessionId='';setFriendPresence(false,{animate:false,sound:false});stopSpeakingMonitor('dm-friend');clearRemoteScreenShare('Friend left the call');if(!callActive)dmCallPeerId='';if(!friendLeftNotified){friendLeftNotified=true;playSound('leave')}callStatus.textContent='Friend left the call';callStatus.className='call-status';renderDmVoiceUI();renderFriends();
}
function logCallEvent(text){const e=document.createElement('div'),time=document.createElement('span');e.className='log-entry';time.className='log-time';time.textContent=new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});e.append(time,document.createTextNode(String(text)));voiceLog.append(e)}
function playSound(kind){
  if(!soundEnabled)return;
  const ctx=sfxCtx();if(!ctx)return;
  if(kind==='connect'){tone(ctx,659.25,0,0.16,'sine',0.16);tone(ctx,987.77,0.12,0.22,'sine',0.16)}
  else if(kind==='leave'){tone(ctx,493.88,0,0.10,'triangle',0.11);tone(ctx,293.66,0.06,0.22,'sine',0.12)}
  else if(kind==='ring'){tone(ctx,523.25,0,0.09,'sine',0.12);tone(ctx,783.99,0.065,0.18,'sine',0.15)}
}
function setupPermanentAudioSink(){
  try{
    // Receiving a WebRTC track does not mean the local user joined the call.
    // Never create a Web Audio route before they explicitly press Start call:
    // that route bypasses HTMLMediaElement.muted and previously let an incoming
    // caller be heard (and briefly leak into the screen-share mix).
    if(!callActive){
      const inactiveCtx=audioCtx;
      if(inactiveCtx?.audioSink){try{inactiveCtx.audioSink.disconnect()}catch{};delete inactiveCtx.audioSink}
      return;
    }
    const ctx=sfxCtx();const st=remoteAudio.srcObject;
    if(!ctx||!st||!st.getAudioTracks().length)return;
    if(ctx.state==='suspended'){
      // Guard against stacking listeners: only register one resume retry at a
      // time. Without this, every ontrack/call-ring before the first user
      // gesture would add another statechange listener + resume call.
      if(ctx._pairSinkArmed)return;
      ctx._pairSinkArmed=true;
      ctx.addEventListener('statechange',function h(){if(ctx.state==='running'){ctx.removeEventListener('statechange',h);ctx._pairSinkArmed=false;setupPermanentAudioSink()}});
      try{ctx.resume()}catch{}
      return
    }
    if(ctx._pairSinkArmed)ctx._pairSinkArmed=false;
    if(ctx.audioSink){try{ctx.audioSink.disconnect()}catch{}}
    if(!ctx.audioGain){ctx.audioGain=ctx.createGain();ctx.audioGain.connect(ctx.destination)}
    (async()=>{try{const saved=await ss('volume');if(saved!==null)setCallVolume(Math.round(parseFloat(saved)*100),false)}catch{}})()
    try{const src=ctx.createMediaStreamSource(st);src.connect(ctx.audioGain);ctx.audioSink=src}catch{}
  }catch{}
}
function setCallVolume(percent,persist=true){const value=Math.max(0,Math.min(100,Number(percent)||0))/100;volumeSlider.value=String(Math.round(value*100));volumeValue.textContent=Math.round(value*100)+'%';try{const ctx=sfxCtx();if(ctx&&ctx.audioGain)ctx.audioGain.gain.setValueAtTime(value,ctx.currentTime)}catch{};try{remoteAudio.volume=0;remoteAudio.muted=!callActive}catch{};if(persist)ssSet('volume',String(value));}
function enableRangeDrag(range){if(!range||range.dataset.pairDrag)return;range.dataset.pairDrag='1';let pointerId=null;const setFromPointer=e=>{const box=range.getBoundingClientRect(),min=Number(range.min)||0,max=Number(range.max)||100,step=Number(range.step)||1,ratio=Math.max(0,Math.min(1,(e.clientX-box.left)/Math.max(1,box.width))),raw=min+(max-min)*ratio,value=Math.round((raw-min)/step)*step+min;range.value=String(Math.max(min,Math.min(max,value)));range.dispatchEvent(new Event('input',{bubbles:true}))};range.addEventListener('pointerdown',e=>{if(e.button!==0)return;range.focus({preventScroll:true});pointerId=e.pointerId;range.setPointerCapture?.(pointerId);setFromPointer(e);e.preventDefault()});range.addEventListener('pointermove',e=>{if(e.pointerId===pointerId)setFromPointer(e)});const finish=e=>{if(e.pointerId!==pointerId)return;try{range.releasePointerCapture?.(pointerId)}catch{};pointerId=null;range.dispatchEvent(new Event('change',{bubbles:true}))};range.addEventListener('pointerup',finish);range.addEventListener('pointercancel',finish)}
function setRemoteCallAudio(enabled){try{if(!enabled){remoteAudio.muted=true;remoteAudio.pause();const ctx=audioCtx;if(ctx?.audioSink){ctx.audioSink.disconnect();delete ctx.audioSink}return}ensureRemoteSpeakingMonitor();remoteAudio.muted=false;remoteAudio.volume=0;remoteAudio.play().catch(()=>{});setupPermanentAudioSink()}catch{}}
remoteAudio.addEventListener('play',()=>{if(!callActive)queueMicrotask(()=>setRemoteCallAudio(false))});
// Bound file-channel backlog so a transfer cannot occupy the shared SCTP/UDP
// path for seconds and starve live screen packets. Eight MiB still fills a fast
// 100 ms path while keeping interactive traffic responsive.
const SEND_WINDOW=8*1024*1024;
const CRYPTO_AHEAD=4;
async function awaitDrain(){const f=files;if(!f||f.readyState!=='open'||f.bufferedAmount<=f.bufferedAmountLowThreshold)return;for(let i=0;i<500;i++){if(!files||files.readyState!=='open')return;if(files.bufferedAmount<=files.bufferedAmountLowThreshold)return;await new Promise(r=>setTimeout(r,20))}}
// Send a JSON control message over the WebRTC chat channel. If the channel is
// closed mid-send we throw a typed error the caller can treat as "aborted"
// rather than letting an unhandled rejection break the send chain.
async function safeSend(data){const f=files;if(!f||f.readyState!=='open')throw new Error('disconnected');for(let i=0;i<3;i++){try{f.send(data);return}catch(e){const m=String(e?.message||'').toLowerCase();if(m.includes('invalid state')||m.includes('closed')||m.includes('not connected'))throw new Error('disconnected');await awaitDrain()}}throw new Error('send failed after retries')}
// Apply backpressure to the direct WebRTC file channel so its send buffer
// remains bounded even during very large transfers.
const FILE_DRAIN_TIMEOUT=45000,busDrains=new Map();function awaitBusDrain(bus){if(!bus||bus!==fileBus())return Promise.resolve(false);if(bus.bufferedAmount<=SEND_WINDOW*0.75)return Promise.resolve(true);let waiters=busDrains.get(bus);if(!waiters){waiters=new Set();busDrains.set(bus,waiters)}return new Promise(resolve=>{let done=false;const finish=ok=>{if(done)return;done=true;clearInterval(timer);clearTimeout(timeout);try{bus.removeEventListener('bufferedamountlow',h)}catch{};waiters.delete(h);resolve(ok)};const h=()=>{if(bus!==fileBus())finish(false);else if(bus.bufferedAmount<=SEND_WINDOW*.75)finish(true)};const timer=setInterval(h,50);const timeout=setTimeout(()=>finish(false),FILE_DRAIN_TIMEOUT);try{bus.addEventListener('bufferedamountlow',h)}catch{};waiters.add(h)})}
async function busSafeSend(data){let retries=0;for(;;){const bus=fileBus();if(!bus)throw new Error('no file channel');
  // Proactively wait if the socket's send buffer is already near the window, so
  // we never overflow it (which would throw and abort the whole transfer).
  if(bus.bufferedAmount>SEND_WINDOW){if(!await awaitBusDrain(bus))throw new Error('File transfer stalled — the direct connection stopped draining');continue}
  try{bus.send(data);return}catch(e){const m=String(e?.message||'').toLowerCase();if(m.includes('send queue is full')||m.includes('buffered')||m.includes('invalid state')){retries++;if(retries>100)throw new Error('send failed after excessive retries');if(!await awaitBusDrain(bus))throw new Error('File transfer stalled — the direct connection stopped draining');continue}throw e}}}
let sendAbort=new Map(),fileSeq=0;
// Pack metadata+iv+ciphertext into one binary frame: [4B json len][json][iv 12B][ct].
// One send() per chunk (no separate control frame). JSON carries seq/last flags.
function packChunk(seq,offset,ivBuf,ctBuf,last){const hdr=JSON.stringify({t:'c',s:seq,o:offset,l:last?1:0});const h=enc.encode(hdr);const frame=new ArrayBuffer(4+h.length+12+ctBuf.byteLength);const v=new DataView(frame);v.setUint32(0,h.length);new Uint8Array(frame,4,h.length).set(h);new Uint8Array(frame,4+h.length,12).set(ivBuf);new Uint8Array(frame,4+h.length+12).set(ctBuf);return frame}
const enc=new TextEncoder(),dec=new TextDecoder();
function setStatus(text,on=false){statusText.textContent=text;$('.connection').classList.toggle('connected',on);if(connectCard)connectCard.hidden=on;if(addFriendBtn)addFriendBtn.disabled=on;  if(on){const negotiated=pc?.sctp?.maxMessageSize||16*1024*1024;CHUNK=Math.min(1024*1024,Math.max(16*1024,negotiated-4096));messageInput.disabled=false;messageForm.querySelector('.send').disabled=false;fileInput.disabled=false;$('#leaveRoom').hidden=false;$('#hostRoom').hidden=true;$('#joinRoom').hidden=true;callBtn.disabled=false;if(!connectSoundDone){playSound('connect');connectSoundDone=true}}else{messageInput.disabled=true;messageForm.querySelector('.send').disabled=true;fileInput.disabled=true;callBtn.disabled=true;endCall(true)}}
const MAX_SIGNAL_SIZE=1024*1024,MAX_MESSAGE_SIZE=64*1024,SIGNAL_COMPRESSED_PREFIX='pair1.',SIGNAL_RAW_PREFIX='pair0.';
// Dot is used instead of base64url's underscore. Discord treats underscores
// as Markdown emphasis, but dots and hyphens copy cleanly in ordinary chat.
// The decoder still accepts legacy underscores so existing invites keep working.
function base64UrlEncode(bytes){let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(binary).replace(/\+/g,'-').replace(/\//g,'.').replace(/=+$/,'')}
function base64UrlDecode(value){if(!/^[A-Za-z0-9_.-]+$/.test(value))throw new Error('Pairing code is malformed');const binary=atob(value.replace(/-/g,'+').replace(/[_.]/g,'/')+'='.repeat((4-value.length%4)%4));return Uint8Array.from(binary,c=>c.charCodeAt(0))}
async function readSignalStream(stream){const reader=stream.getReader(),chunks=[];let length=0;for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_SIGNAL_SIZE){try{await reader.cancel()}catch{}throw new Error('Pairing code expands beyond the allowed size')}chunks.push(value)}const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}return bytes}
function validPairingSignal(value){if(!value||!['offer','answer'].includes(value.type)||typeof value.sdp!=='string'||!value.sdp||value.sdp.length>MAX_SIGNAL_SIZE||!value.pub||typeof value.pub!=='object'||typeof value.pub.x!=='string'||typeof value.pub.y!=='string')throw new Error('This is not a valid Knot invite or reply');return value}
async function makeSignal(value){const raw=enc.encode(JSON.stringify(validPairingSignal(value)));if(raw.byteLength>MAX_SIGNAL_SIZE)throw new Error('Pairing code is too large');try{if(!window.CompressionStream)throw new Error('Compression unavailable');const packed=await readSignalStream(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')));if(packed.byteLength<raw.byteLength)return SIGNAL_COMPRESSED_PREFIX+base64UrlEncode(packed)}catch{}return SIGNAL_RAW_PREFIX+base64UrlEncode(raw)}
async function cleanSignal(value){const code=String(value||'').trim();if(!code||code.length>MAX_SIGNAL_SIZE)throw new Error('Pairing code is missing or too large');let bytes;if(code.startsWith(SIGNAL_COMPRESSED_PREFIX)){if(!window.DecompressionStream)throw new Error('This compact code needs a newer version of Knot');bytes=await readSignalStream(new Blob([base64UrlDecode(code.slice(SIGNAL_COMPRESSED_PREFIX.length))]).stream().pipeThrough(new DecompressionStream('deflate')))}else if(code.startsWith(SIGNAL_RAW_PREFIX))bytes=base64UrlDecode(code.slice(SIGNAL_RAW_PREFIX.length));else{try{bytes=Uint8Array.from(atob(code),c=>c.charCodeAt(0))}catch{throw new Error('This is not a Knot pairing code')}}if(bytes.byteLength>MAX_SIGNAL_SIZE)throw new Error('Pairing code is too large');try{return validPairingSignal(JSON.parse(dec.decode(bytes)))}catch(e){if(e.message?.includes('valid Knot'))throw e;throw new Error('This is not a valid Knot invite or reply')}}
function setOutgoingCode(code){signalOut.value=code;copySignal.disabled=!code;pairCodeMeta.textContent=code?'Compact private code · '+code.length+' characters':''}
async function copyOutgoingCode(){const code=signalOut.value;if(!code)return;try{await navigator.clipboard.writeText(code)}catch{signalOut.focus();signalOut.select();if(!document.execCommand('copy'))throw new Error('Copy was blocked')}copySignal.textContent='Copied';setTimeout(()=>{copySignal.textContent='Copy code'},1600)}
async function keyPair(){return crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits'])}async function exportPub(k){return crypto.subtle.exportKey('jwk',k)}async function importPub(j){return crypto.subtle.importKey('jwk',j,{name:'ECDH',namedCurve:'P-256'},false,[])}
let deriveGen=0;async function derive(local,remote){const gen=++deriveGen;const bits=await crypto.subtle.deriveBits({name:'ECDH',public:await importPub(remote)},local.privateKey,256);const hash=await crypto.subtle.digest('SHA-256',bits);const code=[...new Uint8Array(hash)].slice(0,12).map(b=>b.toString(16).padStart(2,'0')).join('').match(/.{1,4}/g).join('-');$('#fingerprint').textContent=directoryTrustedConnection?'Saved friend connection · encrypted directly':'Security code: '+code;if(gen!==deriveGen)return false;const confirmed=directoryTrustedConnection||window.confirm('Security check: compare this code with your friend over voice or another trusted channel:\n\n'+code+'\n\nOnly click OK if both codes match.');if(!confirmed||gen!==deriveGen){sharedKey=null;return false}const key=await crypto.subtle.importKey('raw',bits,{name:'AES-GCM'},false,['encrypt','decrypt']);if(gen===deriveGen){sharedKey=key;return true}return false;}
async function seal(value){const iv=crypto.getRandomValues(new Uint8Array(12));const data=typeof value==='string'?enc.encode(value):value;const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},sharedKey,data);return {iv:[...iv],data:[...new Uint8Array(ct)]}}async function sealBytes(value){const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},sharedKey,value);return {iv:[...iv],data}}
async function open(o){return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(o.iv)},sharedKey,new Uint8Array(o.data)))}
async function openBytes(iv,data){return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(iv)},sharedKey,data))}
function send(o){if(chat?.readyState==='open')chat.send(JSON.stringify(o))}
function safeExternalUrl(value){try{const u=new URL(value);return u.protocol==='https:'||u.protocol==='http:'?u.href:null}catch{return null}}
function safePreviewUrl(value){const url=safeExternalUrl(value);return url?.startsWith('https:')?url:null}
function youtubeVideoId(value){
  try{
    const u=new URL(value),host=u.hostname.toLowerCase().replace(/^www\./,'').replace(/^m\./,'');let id='';
    if(host==='youtu.be')id=u.pathname.split('/').filter(Boolean)[0]||'';
    else if(host==='youtube.com'||host==='music.youtube.com'){
      id=u.searchParams.get('v')||'';
      if(!id){const bits=u.pathname.split('/').filter(Boolean);if(['embed','shorts','live'].includes(bits[0]))id=bits[1]||''}
    }
    return /^[A-Za-z0-9_-]{6,}$/.test(id)?id:'';
  }catch{return ''}
}
function renderContent(text){
  const urlRegex=/(https?:\/\/[^\s<]+)/g;
  const parts=[];let last=0,m;
  while((m=urlRegex.exec(text))!==null){
    if(m.index>last)parts.push({t:'text',v:text.slice(last,m.index)});
    const url=safeExternalUrl(m[1]);
    if(!url){parts.push({t:'text',v:m[1]});last=m.index+m[0].length;continue}
    const imgExt=/\.(jpg|jpeg|png|gif|webp|bmp)(\?.*)?$/i;
    const youtubeId=youtubeVideoId(url);
    if(youtubeId)parts.push({t:'youtube',v:youtubeId,url});
    else if(imgExt.test(url)&&safePreviewUrl(url))parts.push({t:'image',v:url});
    else parts.push({t:'link',v:url});
    last=m.index+m[0].length;
  }
  if(last<text.length)parts.push({t:'text',v:text.slice(last)});
  return parts.map(p=>{
    if(p.t==='text')return escapeHtml(p.v);
    if(p.t==='link')return '<a href="'+escapeHtml(p.v)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(p.v)+'</a>';
    if(p.t==='image')return '<img src="'+escapeHtml(p.v)+'" loading="lazy" class="embed-img" referrerpolicy="no-referrer" />';
    if(p.t==='youtube')return '<div class="embed-yt"><iframe src="https://www.youtube-nocookie.com/embed/'+p.v+'?rel=0" title="YouTube video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>';
    return '';
  }).join('');
}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
const TEXT_EMOTICONS=[
  [/:'-?\(/g,'😢'],[/(?:x|X)-?D/g,'😆'],[/(:|=)-?D/g,'😄'],[/(:|=)-?\)/g,'🙂'],[/(:|=)-?\(/g,'🙁'],[/-?;\)/g,'😉'],[/(:|=)-?[pP]/g,'😛'],[/(:|=)-?[oO]/g,'😮'],[/:\//g,'😕'],[/<3/g,'❤️']
];
function convertEmoticons(text){return String(text||'').split(/(\s+)/).map(token=>/^https?:\/\//i.test(token)?token:TEXT_EMOTICONS.reduce((value,[pattern,replacement])=>value.replace(pattern,replacement),token)).join('')}
function chatPayload(text,gif){return JSON.stringify({t:'message',text:String(text||''),gif:gif?.url?{url:gif.url,thumb:gif.thumb||gif.url}:null})}
function readChatPayload(value){try{const p=JSON.parse(value);if(p?.t!=='message'||typeof p.text!=='string'||p.text.length>16000)return{text:String(value||''),gif:null};const url=typeof p.gif?.url==='string'&&p.gif.url.length<=4096?safePreviewUrl(p.gif.url):null;return{text:p.text,gif:url?{url,thumb:typeof p.gif.thumb==='string'?p.gif.thumb:url}:null}}catch{return{text:String(value||''),gif:null}}}
function addMessage(text,mine=false,gif=null,author=null){
  $('.empty')?.remove();
  const el=document.createElement('div');el.className='message '+(mine?'mine':'');
  const isEmoji=/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D\u20E3]+$/u.test(text.trim());
  const source=mine?profileBtn:author?null:friendAvatar,avatar=document.createElement('span'),name=mine?profileName:normalizeProfileName(author?.name,friendName);
  avatar.className='avatar message-avatar';const authorImage=!mine&&validProfileData(author?.image)?author.image:'',authorFrame=normalizeFrame(author?.frame);avatar.classList.toggle('has-image',source?source.classList.contains('has-image'):!!authorImage);avatar.style.backgroundImage=source?source.style.backgroundImage:(authorImage?'url("'+authorImage.replace(/"/g,'%22')+'")':'');avatar.style.backgroundSize=source?source.style.backgroundSize:authorFrame.zoom+'% auto';avatar.style.backgroundPositionX=source?source.style.backgroundPositionX:authorFrame.x+'%';avatar.style.backgroundPositionY=source?source.style.backgroundPositionY:authorFrame.y+'%';avatar.style.setProperty('--avatar-hue',source?source.style.getPropertyValue('--avatar-hue'):String(avatarHue(author?.id||name)));const letter=document.createElement('span');letter.className='avatar-letter';letter.textContent=name.slice(0,1).toUpperCase()||'?';avatar.append(letter);
  const content=document.createElement('div');content.className='message-content';
  const header=document.createElement('div');header.className='message-header';const sender=document.createElement('strong');sender.textContent=name;const time=document.createElement('time');const messageTime=Number(author?.time)||Date.now();time.textContent=new Date(messageTime).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});header.append(sender,time);
  const bubble=document.createElement('div');bubble.className='bubble'+(isEmoji?' emoji-only':'');bubble.innerHTML=renderContent(text);if(!text)bubble.hidden=true;
  content.append(header,bubble);
  if(gif?.url){const attachment=document.createElement('div');attachment.className='gif-attachment-message';const link=document.createElement('a');link.href=gif.url;link.target='_blank';link.rel='noopener noreferrer';const image=document.createElement('img');image.src=gif.url;image.alt='GIF attachment';image.loading='lazy';image.referrerPolicy='no-referrer';link.append(image);attachment.append(link);if(!mine){const id=gif.url;const star=document.createElement('button');star.type='button';star.className='gif-message-favorite'+(getFavs().some(f=>f.id===id)?' on':'');star.textContent=star.classList.contains('on')?'★':'☆';star.title=star.classList.contains('on')?'Remove from favorites':'Save GIF';star.onclick=()=>{const on=toggleFav(id,gif.url,gif.thumb||gif.url,{id,url:gif.url,thumb:gif.thumb||gif.url,type:'gifs'});star.classList.toggle('on',on);star.textContent=on?'★':'☆';star.title=on?'Remove from favorites':'Save GIF'};attachment.append(star)}content.append(attachment)}
  el.append(avatar,content);messages.append(el);messages.scrollTop=messages.scrollHeight;recordConversationMessage({text,mine,gif:gif?.url?{url:gif.url,thumb:gif.thumb||gif.url}:null,author:mine?null:{id:author?.id||'',name,image:'',frame:authorFrame},time:messageTime});
}
// --- Emoji Picker ------------------------------------------------------------
const EMOJI_CATS=[
  {name:'Smileys',emojis:['😀','😃','😄','😁','😅','😂','🤣','🥲','☺️','😊','😇','🙂','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥳','🤩','😏','😞','😔','😟','😕','🙁','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👹','👺','💀','☠️','👻','👽','👾','🤖','💩','😺','😸','😹','😻','😼','😽','🙀','😿','😾']},
  {name:'Gestures',emojis:['👋','🤚','🖐','✋','🖖','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁','👅','👄']},
  {name:'People',emojis:['👶','🧒','👦','👧','🧑','👱','👨','🧔','👩','🧓','👴','👵','🙍','🙎','🙅','🙆','💁','🙋','🧏','🙇','🤦','🤷','👮','🕵','💂','🥷','👷','🫅','🤴','👸','👳','👲','🧕','🤵','👰','🤰','🫃','🫄','👼','🎅','🤶','🦸','🦹','🧙','🧚','🧛','🧜','🧝','🧞','🧟','🧌','💆','💇','🚶','🧍','🧎','🏃','💃','🕺','🕴','👯','🧖','🛀','🛌','👭','👫','👬','💏','💑','👪']},
  {name:'Nature',emojis:['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🦟','🦗','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐈','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿','🦔','🐾','🐉','🐲','🌵','🎄','🌲','🌳','🌴','🌱','🌿','☘️','🍀','🎍','🎋','🍃','🍂','🍁','🪺','🪹','🍄','🐚','🪸','🌾','💐','🌷','🌹','🥀','🌺','🌸','🌼','🌻','🌞','🌝','🌛','🌜','🌚','🌕','🌖','🌗','🌘','🌑','🌒','🌓','🌔','🌙','🌎','🌍','🌏','🪐','💫','⭐','🌟','✨','⚡','☄️','💥','🔥','🌪','🌈','☀️','🌤','⛅','🌥','☁️','🌦','🌧','⛈','🌩','🌨','❄️','☃️','⛄','🌬','💨','💧','💦','🫧','🌊']},
  {name:'Food',emojis:['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🫘','🥐','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🥛','🍼','🫖','☕','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🫗','🥃','🍸','🍹','🧉','🍾','🧊','🥄','🍴','🥄','🔪','🫙','🏺']},
  {name:'Activity',emojis:['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑','🥍','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸','🥌','🎿','⛷','🏂','🪂','🏋','🤼','🤸','🤺','⛹','🤾','🏌','🏇','🧘','🏄','🏊','🤽','🚣','🧗','🚵','🚴','🎪','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🪗','🎸','🪕','🎻','🎲','♟️','🎯','🎳','🎮','🕹','🎰']},
  {name:'Travel',emojis:['🚗','🚙','🚕','🚌','🚎','🏎','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🏍','🛵','🛺','🚲','🛴','🛹','🚏','🛣','🛤','⛽','🛞','🚨','🚥','🚦','🛑','🚧','⚓','🛟','⛵','🛶','🚤','🛳','⛴','🚢','✈️','🛩','🛫','🛬','🪂','💺','🚁','🚟','🚠','🚡','🛰','🚀','🛸','🏠','🏡','🏘','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🛕','🕍','⛩','🕋','⛲','⛺','🌁','🌃','🏙','🌄','🌅','🌆','🌇','🌉','🗾','🏔','⛰','🌋','🗻','🏕','🏖','🏜','🏝','🏟']},
  {name:'Objects',emojis:['⌚','📱','💻','⌨','🖥','🖨','🖱','🖲','🕹','🗜','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽','🎞','📞','☎️','📟','📠','📺','📻','🎙','🎚','🎛','🧭','⏱','⏲','⏰','🕰','⌛','⏳','📡','🔋','🪫','🔌','💡','🔦','🕯','🪔','🧯','🗑','🛢','🪠','💸','💵','💴','💶','💷','🪙','💰','💳','💎','⚖️','🧰','🪛','🔧','🔨','⚒','🛠','⛏','🪚','🔩','⚙','🪤','🧱','⛓','🧲','🔫','💣','🧨','🪓','🔪','🗡','⚔️','🛡','🚬','⚰','🪦','⚱','🏺','🔮','📿','🧿','🪬','💈','⚗','🔭','🔬','🕳','🩻','🩼','🩺','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡','🧹','🪥','🧺','🧻','🚽','🚰','🚿','🛁','🛀','🧼','🪒','🪮','🧽','🪣','🧴','🛎','🔑','🗝','🚪','🪑','🛋','🛏','🛌','🧸','🪆','🖼','🪞','🪟','🛍','🛒','🎁','🎈','🎏','🎀','🪄','🪅','🎊','🎉','🎎','🏮','🎐','🧧','✉️','📩','📨','📧','💌','📥','📤','📦','🏷','🪧','📪','📫','📬','📭','📮','📯','📜','📃','📄','📑','🧾','📊','📈','📉','🗒','🗓','📆','📅','🗑','📇','🗃','🗳','🗄','📋','📁','📂','🗂','🗞','📰','📓','📔','📒','📕','📗','📘','📙','📚','📖','🔖','🧷','🔗','📎','🖇','📐','📏','🧮','📌','📍','✂️','🖊','🖋','✒️','🖌','🖍','📝','✏️','🔍','🔎','🔏','🔐','🔑','🔒','🔓']},
  {name:'Symbols',emojis:['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','🈯','💹','❇️','✳️','❎','🌐','💠','Ⓜ️','🌀','💤','🏧','🚾','♿','🅿️','🈳','🈂️','🛂','🛃','🛄','🛅','🛜','🚹','🚺','🚼','⚧','🚻','🚮','🎦','📶','🈁','🔣','🔤','🆡','🆢','🆣','🆤','🆥','🆦','🆧','🆨','🆩','🆪','🆫','🆬','🀄','🃏','🎴','🆒','🆓','🆕','🆖','🆗','🆙']},
  {name:'Flags',emojis:['🏳️','🏴','🏁','🚩','🎌','🏴‍☠️','🇺🇳','🇦🇫','🇦🇱','🇩🇿','🇦🇸','🇦🇩','🇦🇴','🇦🇮','🇦🇶','🇦🇬','🇦🇷','🇦🇲','🇦🇼','🇦🇺','🇦🇹','🇦🇿','🇧🇸','🇧🇭','🇧🇩','🇧🇧','🇧🇾','🇧🇪','🇧🇿','🇧🇯','🇧🇲','🇧🇹','🇧🇴','🇧🇦','🇧🇼','🇧🇷','🇧🇳','🇧🇬','🇧🇫','🇧🇮','🇨🇻','🇰🇭','🇨🇲','🇨🇦','🇨🇫','🇹🇩','🇨🇱','🇨🇳','🇨🇴','🇰🇲','🇨🇩','🇨🇬','🇨🇷','🇨🇮','🇭🇷','🇨🇺','🇨🇾','🇨🇿','🇩🇰','🇩🇯','🇩🇲','🇩🇴','🇪🇨','🇪🇬','🇸🇻','🇬🇶','🇪🇷','🇪🇪','🇸🇿','🇪🇹','🇫🇯','🇫🇮','🇫🇷','🇬🇦','🇬🇲','🇬🇪','🇩🇪','🇬🇭','🇬🇷','🇬🇩','🇬🇹','🇬🇳','🇬🇼','🇬🇾','🇭🇹','🇭🇳','🇭🇺','🇮🇸','🇮🇳','🇮🇩','🇮🇷','🇮🇶','🇮🇪','🇮🇱','🇮🇹','🇯🇲','🇯🇵','🇯🇴','🇰🇿','🇰🇪','🇰🇮','🇰🇼','🇰🇬','🇱🇦','🇱🇻','🇱🇧','🇱🇸','🇱🇷','🇱🇾','🇱🇮','🇱🇹','🇱🇺','🇲🇬','🇲🇼','🇲🇾','🇲🇻','🇲🇱','🇲🇹','🇲🇭','🇲🇷','🇲🇺','🇲🇽','🇫🇲','🇲🇩','🇲🇨','🇲🇳','🇲🇪','🇲🇦','🇲🇿','🇲🇲','🇳🇦','🇳🇷','🇳🇵','🇳🇱','🇳🇿','🇳🇮','🇳🇪','🇳🇬','🇰🇵','🇲🇰','🇳🇴','🇴🇲','🇵🇰','🇵🇼','🇵🇸','🇵🇦','🇵🇬','🇵🇾','🇵🇪','🇵🇭','🇵🇱','🇵🇹','🇶🇦','🇷🇴','🇷🇺','🇷🇼','🇰🇳','🇱🇨','🇻🇨','🇼🇸','🇸🇲','🇸🇹','🇸🇦','🇸🇳','🇷🇸','🇸🇨','🇸🇱','🇸🇬','🇸🇰','🇸🇮','🇸🇧','🇸🇴','🇿🇦','🇰🇷','🇸🇸','🇪🇸','🇱🇰','🇸🇩','🇸🇷','🇸🇪','🇨🇭','🇸🇾','🇹🇼','🇹🇯','🇹🇿','🇹🇭','🇹🇱','🇹🇬','🇹🇴','🇹🇹','🇹🇳','🇹🇷','🇹🇲','🇹🇻','🇺🇬','🇺🇦','🇦🇪','🇬🇧','🇺🇸','🇺🇾','🇺🇿','🇻🇺','🇻🇦','🇻🇪','🇻🇳','🇾🇪','🇿🇲','🇿🇼']}
];
let emojiPicker=null,emojiBtn=null,gifPicker=null,gifBtn=null,pendingGif=null,gifAttachment=null;
function setPendingGif(item){pendingGif=item?.url?{url:item.url,thumb:item.thumb||item.url,analytics:item.analytics||null}:null;if(!gifAttachment)return;gifAttachment.hidden=!pendingGif;if(!pendingGif)return;gifAttachment.querySelector('img').src=pendingGif.thumb;gifAttachment.querySelector('.gif-attachment-name').textContent='1 GIF attached';messageInput.focus()}
function buildEmojiPicker(){
  const wrap=document.createElement('div');wrap.className='emoji-picker';wrap.classList.add('hidden');
  const tabs=document.createElement('div');tabs.className='emoji-tabs';
  const body=document.createElement('div');body.className='emoji-body';
  EMOJI_CATS.forEach((cat,i)=>{
    const tab=document.createElement('button');tab.type='button';tab.className='emoji-tab'+(i===0?' active':'');tab.textContent=cat.emojis[0];tab.title=cat.name;tab.setAttribute('aria-label',cat.name);
    tab.onclick=()=>{body.querySelectorAll('.emoji-page').forEach(p=>p.classList.add('hidden'));body.children[i].classList.remove('hidden');tabs.querySelectorAll('.emoji-tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active')};
    tabs.append(tab);
    const page=document.createElement('div');page.className='emoji-page';page.classList.toggle('hidden',i!==0);
    const heading=document.createElement('div');heading.className='emoji-category-title';heading.textContent=cat.name;
    const grid=document.createElement('div');grid.className='emoji-grid';
    cat.emojis.forEach(e=>{
      const btn=document.createElement('button');btn.type='button';btn.className='emoji-item';btn.textContent=e;
      btn.onclick=()=>{const inp=messageInput;const s=inp.selectionStart;const v=inp.value;inp.value=v.slice(0,s)+e+v.slice(inp.selectionEnd);inp.selectionStart=inp.selectionEnd=s+e.length;inp.focus();wrap.classList.add('hidden')};
      grid.append(btn);
    });
    page.append(heading,grid);
    body.append(page);
  });
  wrap.append(tabs,body);
  // Close on outside click
  document.addEventListener('click',e=>{if(!wrap.contains(e.target)&&e.target!==emojiBtn)wrap.classList.add('hidden')});
  return wrap;
}
function buildGifPicker(){
  const wrap=document.createElement('div');wrap.className='gif-picker';wrap.classList.add('hidden');
  const tabs=document.createElement('div');tabs.className='gif-picker-tabs';
  const gifTab=document.createElement('button');gifTab.type='button';gifTab.className='gif-picker-tab active';gifTab.textContent='GIFs';
  const stiTab=document.createElement('button');stiTab.type='button';stiTab.className='gif-picker-tab';stiTab.textContent='Stickers';
  const favTab=document.createElement('button');favTab.type='button';favTab.className='gif-picker-tab';favTab.textContent='Favs';
  tabs.append(gifTab,stiTab,favTab);
  const searchRow=document.createElement('div');searchRow.className='gif-search-row';
  const inp=document.createElement('input');inp.className='gif-search-input';inp.placeholder='Search…';
  const results=document.createElement('div');results.className='gif-results';
  let currentType='gifs',timer=null,currentQuery='',currentOffset=0;
  function loadMore(append){
    const off=append?currentOffset:0;
    loadMerged(currentQuery,results,currentType,off,append);
    if(!append)currentOffset=24;
    else currentOffset+=24;
  }
  function loadFresh(query,type){
    currentQuery=query;currentType=type;currentOffset=24;
    if(query&&query.length<2){results._loading='waiting-for-query';results.innerHTML='<span class="gif-hint">Type at least 2 characters to search</span>';return}
    loadMerged(query,results,type,0,false);
  }
  // Infinite scroll: load next page when near bottom
  results.onscroll=()=>{
    // Favorites are local-only. Never let the remote GIF pagination loader
    // append normal search results while this tab is selected.
    if(currentType==='favs')return;
    if(results._loading)return;
    if(results.scrollTop+results.clientHeight>=results.scrollHeight-200)loadMore(true);
  };
  function setType(t){
    currentType=t;const isFav=t==='favs';
    gifTab.classList.toggle('active',t==='gifs');stiTab.classList.toggle('active',t==='stickers');favTab.classList.toggle('active',isFav);
    inp.hidden=isFav;searchRow.hidden=isFav;
    if(isFav)renderFavs(results);
    else{inp.placeholder=t==='gifs'?'Search GIFs…':'Search Stickers…';loadFresh('',t)}
  }
  gifTab.onclick=()=>setType('gifs');
  stiTab.onclick=()=>setType('stickers');
  favTab.onclick=()=>setType('favs');
  inp.oninput=()=>{
    clearTimeout(timer);const q=inp.value.trim();
    timer=setTimeout(()=>{loadFresh(q,currentType)},250);
  };
  searchRow.append(inp);wrap.append(tabs,searchRow,results);
  document.addEventListener('click',e=>{if(!wrap.contains(e.target)&&e.target!==gifBtn)wrap.classList.add('hidden')});
  return wrap;
}
function giphyFetch(endpoint,type,query,offset){
  const apiKey=window._giphyKey||'LtCRMfaqI1JFzONkJJFRJ8ktT3EdOoTL';
  const base=type==='stickers'?'stickers':'gifs';
  const off=offset?`&offset=${offset}`:'';
  if(giphyFetch._cooldown>Date.now())return Promise.resolve({data:[]});
  const url=query?`https://api.giphy.com/v1/${base}/${endpoint}?api_key=${apiKey}&q=${encodeURIComponent(query)}&limit=24&rating=r&lang=en&bundle=messaging_non_clips${off}`:`https://api.giphy.com/v1/${base}/trending?api_key=${apiKey}&limit=24&rating=r&bundle=messaging_non_clips${off}`;
  return fetch(url,{credentials:'omit'}).then(r=>{if(r.status===429){giphyFetch._cooldown=Date.now()+10000;console.warn('giphy 429, cooling 10s');return{data:[]}}if(!r.ok)throw new Error('GIPHY '+r.status);return r.json()}).catch(()=>({data:[]}));
}
function klipyFetch(type,query,offset){
  const key='wDEDuoSRgy4oajhdMGJ7gtS2cFBB3DtWULsUYodKIRhcXvHreSPr6eNM3nm0oWc1';
  const params=new URLSearchParams({key,limit:'24',contentfilter:'off',locale:'en',media_filter:'gif,tinygif,webm,tinywebm'});
  if(type==='stickers')params.set('searchfilter','sticker');
  if(offset)params.set('page',Math.floor(offset/24)+1);
  const url=query?`https://api.klipy.com/v2/search?${params}&q=${encodeURIComponent(query)}`:`https://api.klipy.com/v2/featured?${params}`;
  return fetch(url,{headers:{Accept:'application/json'},credentials:'omit'}).then(r=>{if(!r.ok){console.warn('klipy err',r.status);return{results:[]}}return r.json()}).catch(e=>{console.warn('klipy fail',e.message);return{results:[]}});
}
function klipyShare(id){try{fetch(`https://api.klipy.com/v1/registershare?key=wDEDuoSRgy4oajhdMGJ7gtS2cFBB3DtWULsUYodKIRhcXvHreSPr6eNM3nm0oWc1&id=${id}`)}catch{}}
function giphyAnalytics(giphyId,type){
  try{fetch('https://api.giphy.com/v1/analytics/action/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action_type:'SENT',action_object_type:type==='stickers'?'sticker':'gif',action_object_id:giphyId})})}catch{}
}
function getFavs(){try{const d=localStorage.getItem('pair.gifFavs');return d?JSON.parse(d):[]}catch{return[]}}
function saveFavs(f){try{localStorage.setItem('pair.gifFavs',JSON.stringify(f))}catch{}}
function toggleFav(id,url,thumb,type){
  let favs=getFavs();const i=favs.findIndex(f=>f.id===id);
  if(i===-1)favs.push({id,url,thumb,type});else favs.splice(i,1);
  saveFavs(favs);return i===-1;
}
function renderFavs(resultsEl){
  // Invalidate any pending GIPHY/Klipy request. Without this, a search that
  // started just before the Favorites tab opened could append its results here.
  resultsEl._loading='favs:'+Date.now();
  resultsEl.innerHTML='';const favs=getFavs();
  if(!favs.length){resultsEl.innerHTML='<span class="gif-hint">No favorites yet</span>';return}
  favs.forEach(f=>{
    const btn=document.createElement('button');btn.type='button';btn.className='gif-result';
    const img=document.createElement('img');img.src=f.thumb;img.loading='lazy';
    btn.append(img);
    btn.onclick=()=>{if(f.url){setPendingGif({url:f.url,thumb:f.thumb,analytics:f.type||f});resultsEl.parentElement.classList.add('hidden')}};
    const star=document.createElement('span');star.className='gif-star on';star.textContent='★';star.title='Remove from favorites';star.setAttribute('role','button');star.tabIndex=0;const remove=e=>{e.preventDefault();e.stopPropagation();toggleFav(f.id);renderFavs(resultsEl)};star.onclick=remove;star.onkeydown=e=>{if(e.key==='Enter'||e.key===' ')remove(e)};btn.append(star);
    btn.oncontextmenu=e=>{e.preventDefault();toggleFav(f.id);renderFavs(resultsEl)};
    resultsEl.append(btn);
  });
}
function analyticsShared(item){
  if(item.klipy)klipyShare(item.id);
  else giphyAnalytics(item.id,item.giphyType||'gifs');
}
function loadMerged(query,resultsEl,type,offset,append){
  if(!append)resultsEl.innerHTML='<span class="gif-hint">Loading…</span>';
  resultsEl._loading=type+':'+query+':'+(offset||0);
  Promise.all([
    giphyFetch('search',type,query,offset).then(d=>(d.data||[]).map(g=>{const im=g.images?.downsized||g.images?.fixed_width||{};const t=im.url||g.images?.original?.url;const f=g.images?.original?.url||t;return{id:g.id,thumb:t,thumbW:parseInt(im.width)||200,thumbH:parseInt(im.height)||150,fullUrl:f,klipy:false,giphyType:type}})).catch(()=>[]),
    klipyFetch(type,query,offset).then(d=>(d.results||[]).map(k=>{const fm=k.media_formats||{};const t=fm.tinygif?.url||fm.gif?.url;const f=fm.gif?.url||fm.tinygif?.url;return{id:k.id,thumb:t,thumbW:parseInt(fm.tinygif?.dims?.[0])||200,thumbH:parseInt(fm.tinygif?.dims?.[1])||150,fullUrl:f,klipy:true}})).catch(()=>[])
  ]).then(([giphyItems,klipyItems])=>{
    if(resultsEl._loading!==type+':'+query+':'+(offset||0))return;
    if(!append)resultsEl.innerHTML='';
    const maxLen=Math.max(giphyItems.length,klipyItems.length);
    let added=0;
    for(let i=0;i<maxLen;i++){
      if(i<giphyItems.length){renderItem(giphyItems[i],resultsEl);added++}
      if(i<klipyItems.length){renderItem(klipyItems[i],resultsEl);added++}
    }
    if(!added&&!append)resultsEl.innerHTML='<span class="gif-hint">No results</span>';
    resultsEl._loaded=(resultsEl._loaded||0)+added;
    resultsEl._loading=null;
  }).catch(()=>{if(!append)resultsEl.innerHTML='<span class="gif-hint">Error loading</span>';resultsEl._loading=null});
}

function renderItem(item,resultsEl){
  if(!item.thumb||!item.fullUrl)return;
  const btn=document.createElement('button');btn.type='button';btn.className='gif-result';
  const img=document.createElement('img');img.src=item.thumb;img.loading='lazy';
    // Remove inline aspectRatio — CSS `width:100%;height:auto` preserves natural ratio
    // if(item.thumbW&&item.thumbH){img.style.aspectRatio=item.thumbW+'/'+item.thumbH}
  btn.append(img);
  const isFav=getFavs().some(f=>f.id===item.id);
  const star=document.createElement('span');star.className='gif-star'+(isFav?' on':'');star.textContent=isFav?'★':'☆';star.title=isFav?'Remove favorite':'Add to favorites';star.setAttribute('role','button');star.tabIndex=0;
  const toggleStar=e=>{e.preventDefault();e.stopPropagation();const on=toggleFav(item.id,item.fullUrl,item.thumb,item);star.classList.toggle('on',on);star.textContent=on?'★':'☆';star.title=on?'Remove favorite':'Add to favorites'};star.onclick=toggleStar;star.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){toggleStar(e)}};
  btn.append(star);
  btn.onclick=()=>{if(item.fullUrl){setPendingGif({url:item.fullUrl,thumb:item.thumb,analytics:item});const wrap=resultsEl.parentElement;wrap.classList.add('hidden');const si=wrap.querySelector('.gif-search-input');if(si)si.value='';resultsEl.innerHTML=''}};
  resultsEl.append(btn);
}
// Initialise pickers once sharedKey is set (i.e. after connection).
(function initChatExtras(){
  // Replace composer: add emoji + gif + plus buttons
  const composer=messageForm;
  const existingBtns=composer.querySelectorAll('button');
  const sendBtn=existingBtns[0];
  gifAttachment=document.createElement('div');gifAttachment.className='gif-attachment';gifAttachment.hidden=true;gifAttachment.innerHTML='<img alt="GIF attachment" /><span class="gif-attachment-name"></span><button type="button" class="gif-attachment-remove" aria-label="Remove GIF attachment">×</button>';
  gifAttachment.querySelector('.gif-attachment-remove').onclick=()=>setPendingGif(null);
  composer.prepend(gifAttachment);
  // Plus button
  const plusWrap=document.createElement('div');plusWrap.style.cssText='position:relative;display:inline-flex';
  const plusBtn=document.createElement('button');plusBtn.type='button';plusBtn.className='composer-btn plus-btn';plusBtn.textContent='+';plusBtn.title='Attach';
  const plusPopup=document.createElement('div');plusPopup.className='plus-popup';plusPopup.classList.add('hidden');
  const fileOpt=document.createElement('button');fileOpt.className='plus-opt';fileOpt.textContent='📎 Send file';
  fileOpt.onclick=()=>{plusPopup.classList.add('hidden');fileInput.click()};
  plusPopup.append(fileOpt);plusWrap.append(plusBtn,plusPopup);composer.insertBefore(plusWrap,sendBtn.nextSibling);
  plusBtn.onclick=e=>{e.preventDefault();plusPopup.classList.toggle('hidden');emojiPicker&&emojiPicker.classList.add('hidden');gifPicker&&gifPicker.classList.add('hidden')};
  document.addEventListener('click',e=>{if(!plusWrap.contains(e.target))plusPopup.classList.add('hidden')});
  emojiBtn=document.createElement('button');emojiBtn.type='button';emojiBtn.className='composer-btn emoji-btn';emojiBtn.textContent='😊';emojiBtn.title='Emoji';
  emojiPicker=buildEmojiPicker();emojiPicker.style.position='absolute';emojiPicker.style.bottom='100%';emojiPicker.style.right='60px';
  composer.append(emojiPicker);
  emojiBtn.onclick=e=>{e.preventDefault();emojiPicker.classList.toggle('hidden');gifPicker&&gifPicker.classList.add('hidden');plusPopup&&plusPopup.classList.add('hidden')};
  composer.insertBefore(emojiBtn,sendBtn.nextSibling);
  // GIF button
  gifBtn=document.createElement('button');gifBtn.type='button';gifBtn.className='composer-btn gif-btn';gifBtn.textContent='GIF';gifBtn.title='GIF';
  gifPicker=buildGifPicker();gifPicker.style.position='absolute';gifPicker.style.bottom='100%';gifPicker.style.right='0';
  composer.append(gifPicker);
  gifBtn.onclick=e=>{e.preventDefault();const show=gifPicker.classList.contains('hidden');gifPicker.classList.toggle('hidden');emojiPicker&&emojiPicker.classList.add('hidden');plusPopup&&plusPopup.classList.add('hidden');if(show){const r=gifPicker.querySelector('.gif-results');const tabs=gifPicker.querySelectorAll('.gif-picker-tab');if(tabs[2]?.classList.contains('active'))renderFavs(r);else{tabs[0]?.click()}}};
  composer.insertBefore(gifBtn,sendBtn.nextSibling);
  // Enable input/button on connect
  const orig=messageInput.disabled;
  Object.defineProperty(messageInput,'disabled',{set(v){this._disabled=v;if(v){this.setAttribute('disabled','')}else{this.removeAttribute('disabled')}sendBtn.disabled=v;emojiBtn.disabled=v;gifBtn.disabled=v;plusBtn.disabled=v},get(){return this._disabled!==false}});
  messageInput.disabled=orig;
})();
function isEncryptedMessage(value){return !!value&&Array.isArray(value.iv)&&value.iv.length===12&&Array.isArray(value.data)&&value.data.length>0&&value.data.length<=MAX_MESSAGE_SIZE+32&&value.iv.every(Number.isInteger)&&value.data.every(Number.isInteger)}
function clearRemoteScreenShare(status='Not sharing'){
  const wasFocused=typeof focusedScreen!=='undefined'&&focusedScreen==='remote';
  cleanupRemoteNativeScreen();
  remoteScreenExpected=false;remoteScreenSuppressed=false;
  try{remoteScreen.srcObject?.getTracks?.().forEach(track=>{track.enabled=false})}catch{}
  remoteScreen.srcObject=null;remoteScreen.hidden=true;screenStatus.textContent=status;
  try{if(wasFocused)exitShareFullscreen({collapse:true});else updateScreenLayout()}catch{}
}
function stopWatchingRemoteShare(){
  if(remoteScreen.hidden&&!remoteScreen.srcObject)return;
  remoteScreenSuppressed=true;
  try{remoteScreen.pause();remoteScreen.muted=true;if(nativeRemoteAudio){nativeRemoteAudio.pause();nativeRemoteAudio.muted=true;nativeRemoteAudio.srcObject?.getTracks?.().forEach(track=>{track.enabled=false})}}catch{}
  screenStatus.textContent='Not watching · click the stream badge to resume';
  try{if(focusedScreen==='remote')exitShareFullscreen({collapse:true});else updateScreenLayout()}catch{}
}
function receiveDirectMessage(message,peerIdOverride=''){
  const peerId=peerIdOverride||dmPeerId||dmCallPeerId||activePeerId,key=peerId?'dm:'+peerId:'';
  if(!key||activeConversationKey===key){addMessage(message.text,false,message.gif);return}
  const friend=directoryUser(peerId),entry={text:message.text,mine:false,gif:message.gif?.url?{url:message.gif.url,thumb:message.gif.thumb||message.gif.url}:null,author:{id:peerId,name:friend?.name||'Friend',image:'',frame:normalizeFrame(friend?.frame)},time:Date.now()};
  storeConversationEntry(key,entry);
}
function setupChannels(){chat=pc.createDataChannel('chat');files=pc.createDataChannel('files');wire()}
function wire(){
  if(chat){
    chat.onopen=()=>{setStatus('Connected directly',true);announceProfile();publishCallState(callActive)};
    chat.onmessage=async event=>{
      try{
        if(typeof event.data!=='string'||event.data.length>MAX_MESSAGE_SIZE*3)return;
        const value=JSON.parse(event.data);
        if(value.t==='msg'&&isEncryptedMessage(value.v)){receiveDirectMessage(readChatPayload(dec.decode(await open(value.v))));return}
        if(value.t==='profile'){
          const profile=typeof value.v==='string'?{image:value.v}:value.v;
          if(validProfileIdentity(profile?.identity))setAvatarIdentity(friendAvatar,profile.identity);
          if(typeof profile?.image==='string'&&profile.image.length<=MAX_PROFILE_DATA){setAvatar(friendAvatar,profile.image);setAvatarFrame(friendAvatar,profile.frame)}
          return;
        }
        if(value.t==='call-state'){
          const active=value.active===true,session=String(value.session||'legacy'),wasActive=friendInCall,previousSession=remoteCallSessionId;if(active)dmCallPeerId=dmPeerId||activePeerId;
          applyRemoteCallState(active,session);logCallEvent(active?'Friend joined the call':'Friend left the call');
          // Peers may repeat their active state after an SCTP reconnect (and
          // some older clients periodically announce it). That is presence,
          // not a new call: ringing again here was the minute-ish beep.
          if(active&&(!wasActive||session!==previousSession))playSound('ring');return;
        }
        if(value.t==='call-ring'){
          if(remoteCallSessionId)return;
          dmCallPeerId=dmPeerId||activePeerId;applyRemoteCallState(true,'legacy');logCallEvent('Friend joined the call');playSound('ring');return;
        }
        if(value.t==='call-end'){
          if(!remoteCallSessionId&&!friendInCall)return;
          applyRemoteCallState(false);logCallEvent('Friend left the call');return;
        }
        if(value.t==='screen-start'){remoteScreenExpected=true;remoteScreenSuppressed=false;logCallEvent('Friend started screen sharing');remoteScreen.hidden=false;screenStatus.textContent='Friend sharing';return}
        if(value.t==='screen-end'){logCallEvent('Friend stopped screen sharing');clearRemoteScreenShare();return}
        if(value.t==='screen-codec-fallback'&&screenActive){await switchScreenCodec(compatibilityScreenCodec());return}
        if(value.t==='reneg-offer'&&typeof value.sdp==='string'&&pc){
          if(renegPending&&(role==='join'||role==='answer')){renegotiating++;renegPending=false}
          await pc.setRemoteDescription({type:'offer',sdp:value.sdp});const answer=await pc.createAnswer();await pc.setLocalDescription({type:'answer',sdp:patchSdp(answer.sdp)});await waitIce();send({t:'reneg-answer',sdp:pc.localDescription.sdp});return;
        }
        if(value.t==='reneg-answer'&&typeof value.sdp==='string'&&pc)await pc.setRemoteDescription({type:'answer',sdp:value.sdp});
      }catch(error){console.warn('direct renegotiation error',error)}
    };
  }
  if(files){files.binaryType='arraybuffer';files.bufferedAmountLowThreshold=Math.max(1*1024*1024,SEND_WINDOW-4*1024*1024);files.onmessage=event=>{receiveQueue=receiveQueue.then(()=>onFileFrame(event)).catch(()=>{})};files.onopen=()=>setStatus('Connected directly',true)}
}
// Add name handling once per data channel without disturbing the encrypted
// message/profile handler above. This also covers the channel received by the
// answering peer through `ondatachannel`.
const originalWire=wire,profileNameChannels=new WeakSet();
wire=function(){if(chat&&!profileNameChannels.has(chat)){chat.addEventListener('message',handleProfileNameMessage);profileNameChannels.add(chat)}return originalWire()}
function fileBus(){return files&&files.readyState==='open'?files:null}

// ICE servers use public STUN by default. Set PAIR_TURN to a JSON array of your
// own TURN servers when a direct route is unavailable; Electron validates that
// configuration before exposing it to the renderer.
// Direct pairing is STUN-only by default. In the desktop app, validated custom
// TURN settings are supplied by the preload bridge; browser builds retain the
// safe default rather than depending on a Node `process` global.
const DEFAULT_ICE_SERVERS=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
const ICE_SERVERS=Array.isArray(window.pairEnv?.iceServers)&&window.pairEnv.iceServers.length?window.pairEnv.iceServers:DEFAULT_ICE_SERVERS;
function viableScreenPeer(target=pc){return !!target&&target===pc&&!['failed','disconnected','closed'].includes(String(target.connectionState||''))&&target.signalingState!=='closed'}
function setupPeer(){
  // Close previous pc and associated resources if reconnecting (e.g. peer-left → peer-ready).
  // Invalidate capture first, then null pc before closing so the old connection
  // handler cannot act on the replacement peer.
  if(pc){
    abortScreenSharePicker();if(screenActive||screenStarting||screenStream||nativeScreenSession)void stopScreenShare(true);else screenGen++;
    const oldPc=pc;pc=null;const oldChat=chat;const oldFiles=files;chat=null;files=null;
    if(oldPc._connectTimer){clearTimeout(oldPc._connectTimer);oldPc._connectTimer=null}
    if(oldPc._silentAudioCtx)try{oldPc._silentAudioCtx.close()}catch{}
    if(oldChat){oldChat.onmessage=null;try{oldChat.close()}catch{}}
    if(oldFiles){oldFiles.onmessage=null;try{oldFiles.close()}catch{}}
    try{oldPc.close()}catch{}
  }
  pc=new RTCPeerConnection({iceServers:ICE_SERVERS});const peer=pc;peer.onicecandidate=()=>{};let wasEverConnected=false;
  peer.onconnectionstatechange=()=>{if(pc!==peer)return;const state=peer.connectionState;if(state==='connected'){screenBtn.disabled=false;if(peer._connectTimer){clearTimeout(peer._connectTimer);peer._connectTimer=connectTimer=null}if(!wasEverConnected){wasEverConnected=true;if(reconnectCall){reconnectCall=false;if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}callActive=false;startCall()}}else{setStatus('Connected directly',true);friendLeftNotified=false}}if(['failed','disconnected','closed'].includes(state)){screenBtn.disabled=true;abortScreenSharePicker();if(screenActive||screenStarting||screenStream||nativeScreenSession)void stopScreenShare(true);else screenGen++;if(peer._connectTimer){clearTimeout(peer._connectTimer);peer._connectTimer=connectTimer=null}applyRemoteCallState(false);setStatus(state)}if(state==='connecting'){pairHint.textContent='Negotiating peer connection (ICE '+(peer.iceConnectionState||'')+')…';armConnectTimeout()}};peer.oniceconnectionstatechange=()=>{if(pc!==peer)return;if(peer.iceConnectionState==='failed'){pairHint.textContent='Peer connection failed (ICE '+(peer.iceConnectionState||'')+'). NAT/network blocks a direct link and the TURN relay could not be reached. Both must be on v1.0.0+, and your network must allow the TURN relay.'}else if(peer.iceConnectionState==='checking'||peer.iceConnectionState==='connected'){pairHint.textContent='Negotiating peer connection (ICE '+(peer.iceConnectionState||'')+' )…'}};peer.ondatachannel=e=>{if(e.channel.label==='chat')chat=e.channel;else files=e.channel;wire()};
  const baseDirectDataChannel=pc.ondatachannel;pc.ondatachannel=event=>{if(event.channel.label==='knot-screen-native'){wireNativeScreenChannel(event.channel,{remote:true});return}baseDirectDataChannel(event)};
  // If WebRTC can't establish within ~25s (e.g. TURN unreachable / blocked
  // network), surface a clear message instead of hanging on "Connecting…" forever.
  let connectTimer=null;pc._connectTimer=null;function armConnectTimeout(){if(connectTimer||pc.connectionState==='connected')return;connectTimer=setTimeout(()=>{pc._connectTimer=null;if(pc&&pc.connectionState!=='connected'&&pc.connectionState!=='failed'&&pc.connectionState!=='closed'){pairHint.textContent='Still connecting… if this persists, one of you is behind a strict NAT/firewall that blocks the peer connection. Try a different network or add a TURN server.'}},25000);pc._connectTimer=connectTimer}
  // Negotiate a bidirectional audio transceiver up front so voice works without
  // a renegotiation round-trip once the call starts. No track is attached until
  // the user clicks Start voice, keeping the mic off until then. Keep a direct
  // reference so startCall always reuses THIS transceiver (never addTransceiver),
  // even after endCall nulls its track and the receiver track is momentarily
  // unavailable — which would otherwise fall through to a second m-line.
  // Create a silent audio track to establish a bidirectional audio transceiver
  // via addTrack (which matches by sender.track.kind) instead of addTransceiver
  // (whose receiver-based kind matching fails for createAnswer in Chrome).
  try{
    const silentCtx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000});
    const silentDst=silentCtx.createMediaStreamDestination();
    silentDst.channelCount=2;
    audioTransceiver=pc.addTrack(silentDst.stream.getAudioTracks()[0],silentDst.stream);
    // Keep a reference so we can close the AudioContext on disconnect
    pc._silentAudioCtx=silentCtx;
  }catch(e){console.warn('Silent audio track failed, using addTransceiver:',e);try{audioTransceiver=pc.addTransceiver('audio',{direction:'sendrecv'})}catch(e2){console.warn('addTransceiver also failed:',e2);audioTransceiver=null}}
  logCallEvent('Diag: setupPeer transceivers='+pc.getTransceivers().length+' audioTr='+(audioTransceiver?'ok:mid='+audioTransceiver.mid:'null'));
  let gestureGuard=false,screenGestureGuard=false;
  pc.ontrack=e=>{logCallEvent('Diag: ontrack kind='+e.track.kind);try{const stream=e.streams[0]||new MediaStream([e.track]);
    // Keep remoteScreenExpected true until screen-end so audio that arrives after
    // the video track still routes to the screen element instead of the voice sink.
    const screenStreamId=remoteScreen.srcObject?.id;
    // audioTransceiver is an RTCRtpSender immediately after setup and the
    // matched RTCRtpTransceiver after signaling. Accept both identities so a
    // renegotiation cannot mistake the friend's voice for screen audio and
    // silently detach the speaking-ring analyser.
    const isVoiceAudio=e.track.kind==='audio'&&(e.transceiver===audioTransceiver||e.transceiver?.sender===audioTransceiver);
    const bindsToScreen=!isVoiceAudio&&(stream===remoteScreen.srcObject
      ||!!(screenStreamId&&e.streams?.some(s=>s?.id===screenStreamId))
      ||stream.getVideoTracks().length>0
      ||remoteScreenExpected
      ||(e.track.kind==='audio'&&!remoteScreen.hidden&&!!remoteScreen.srcObject));
    if(e.track.kind==='audio'&&bindsToScreen){
      if(nativeRemotePlayer||remoteNativeScreenChannel){const audio=ensureNativeRemoteAudio();audio.srcObject=stream;audio.volume=remoteScreen.volume;audio.muted=remoteScreenSuppressed||!screenExpanded||focusedScreen!=='remote'||audio.volume===0;e.track.enabled=!audio.muted;e.track.onended=()=>{if(audio.srcObject===stream){audio.pause();audio.srcObject=null}};if(!audio.muted)audio.play().catch(()=>{});logCallEvent('Native screen audio received');screenAudioDebug=' · audio received';screenStatus.textContent='Friend sharing'+screenAudioDebug;updateScreenLayout();return}
      remoteScreen.hidden=false;
      if(!remoteScreen.srcObject)remoteScreen.srcObject=stream;
      else if(remoteScreen.srcObject!==stream){
        try{remoteScreen.srcObject.addTrack(e.track)}catch{
          remoteScreen.srcObject=new MediaStream([
            ...remoteScreen.srcObject.getVideoTracks(),
            ...remoteScreen.srcObject.getAudioTracks().filter(t=>t.id!==e.track.id),
            e.track
          ]);
        }
      }
      logCallEvent('Screen audio received');screenAudioDebug=' · audio received';screenStatus.textContent='Friend sharing'+screenAudioDebug;
      const play=()=>{if(!remoteScreenSuppressed&&screenExpanded&&focusedScreen==='remote'){e.track.enabled=true;if(remoteScreen.volume>0)remoteScreen.muted=false;const p=remoteScreen.play();if(p?.catch)p.catch(()=>{})}};updateScreenLayout();play();
      if(!screenGestureGuard){screenGestureGuard=true;document.addEventListener('pointerdown',play,{once:true});document.addEventListener('keydown',play,{once:true})}
      return;
    }
    if(e.track.kind==='audio'){logCallEvent('Audio track received from friend');if(remoteAudio.srcObject){try{remoteAudio.srcObject.getAudioTracks().forEach(t=>t.onended=null)}catch{}}if(remoteAudio.srcObject&&remoteAudio.srcObject!==stream){try{remoteAudio.srcObject.addTrack(e.track)}catch{}}else remoteAudio.srcObject=stream;remoteVoiceTrack=e.track;monitorSpeaking('dm-friend',e.track);e.track.onended=()=>{if(remoteVoiceTrack===e.track)remoteVoiceTrack=null;stopSpeakingMonitor('dm-friend');applyRemoteCallState(false);logCallEvent('Friend left the call')};if(!callActive){setRemoteCallAudio(false);return}setRemoteCallAudio(true);if(!gestureGuard){gestureGuard=true;document.addEventListener('pointerdown',()=>setRemoteCallAudio(callActive),{once:true});document.addEventListener('keydown',()=>setRemoteCallAudio(callActive),{once:true})}}else if(e.track.kind==='video'){const receiver=pc.getReceivers().find(value=>value.track===e.track);if(receiver)monitorRemoteScreenDecode(receiver,e.track);remoteScreen.hidden=false;try{remoteScreen.srcObject=stream;remoteScreen.playbackRate=1}catch{};updateScreenLayout();e.track.onended=()=>{if(remoteScreen.srcObject===stream)clearRemoteScreenShare()}}}catch{}};
}
function monitorRemoteScreenDecode(receiver,track,requestFallback){
  try{receiver.playoutDelayHint=.08;if('jitterBufferTarget'in receiver)receiver.jitterBufferTarget=60}catch{}
  let previousBytes=0,previousFrames=0,stalls=0,finished=false;
  const stop=()=>{finished=true;clearInterval(timer)};
  const sample=async()=>{try{
    if(finished||track.readyState==='ended')return stop();
    if(!track.enabled){stalls=0;return}
    const reports=await receiver.getStats();let inbound,codec;
    reports.forEach(report=>{if(report.type==='inbound-rtp'&&(report.kind==='video'||report.mediaType==='video')&&!report.isRemote)inbound=report});
    if(!inbound)return;
    codec=reports.get(inbound.codecId);const bytes=Number(inbound.bytesReceived)||0,frames=Number(inbound.framesDecoded)||0,received=bytes-previousBytes,decoded=frames-previousFrames;
    previousBytes=bytes;previousFrames=frames;
    if(decoded>0){stalls=0;return}
    if(received<50000)return;
    stalls++;
    if(stalls===1){try{receiver.requestKeyFrame?.()}catch{};return}
    if(stalls>=2&&/video\/AV1/i.test(codec?.mimeType||'')){
      screenStatus.textContent='AV1 decoder stalled — switching to '+compatibilityScreenCodec();
      const requested=requestFallback?requestFallback():(chat?.readyState==='open'&&send({t:'screen-codec-fallback'}));if(requested!==false)stop();
    }
  }catch{}};
  const timer=setInterval(sample,2500);track.addEventListener?.('ended',stop,{once:true});setTimeout(sample,2500);
}
async function waitIce(){if(pc.iceGatheringState==='complete')return;await new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;pc?.removeEventListener('icegatheringstatechange',f);clearTimeout(timeout);resolve()};const f=()=>{if(pc?.iceGatheringState==='complete')finish()};const timeout=setTimeout(finish,5000);pc.addEventListener('icegatheringstatechange',f)})}
function patchOpusSdp(sdp){return sdp.replace(/a=fmtp:111[^\r\n]*/g,m=>{if(!m.includes('maxaveragebitrate'))m+='; maxaveragebitrate=256000';else m=m.replace(/maxaveragebitrate=\d+/,'maxaveragebitrate=256000');if(!m.includes('maxplaybackrate'))m+='; maxplaybackrate=48000';if(!m.includes('maxptime'))m+='; maxptime=20';else m=m.replace(/maxptime=\d+/,'maxptime=20');if(!m.includes('minptime'))m+='; minptime=10';else m=m.replace(/minptime=\d+/,'minptime=10');if(!m.includes('useinbandfec'))m+='; useinbandfec=1';if(!m.includes('usedtx'))m+='; usedtx=0';if(!m.includes('stereo'))m+='; stereo=1';else m=m.replace(/stereo=[01]/,'stereo=1');if(!m.includes('sprop-stereo'))m+='; sprop-stereo=1';else m=m.replace(/sprop-stereo=[01]/,'sprop-stereo=1');return m})}
function patchSdp(sdp){return patchOpusSdp(sdp)}
$('#createOffer').onclick=async()=>{try{if(pc||signaling)disconnectRoom();pairSignalBusy=false;pairReplyAccepted=false;processSignal.disabled=false;role='offer';signalIn.value='';ssSet('savedInviteCode',null);setOutgoingCode('');processSignal.textContent='Finish connection';setupPeer();const kp=await keyPair();pc._kp=kp;setupChannels();const o=await pc.createOffer();await pc.setLocalDescription({type:'offer',sdp:patchSdp(o.sdp)});await waitIce();setOutgoingCode(await makeSignal({type:'offer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}));pairHint.textContent='Invite ready. Copy it, send it to your friend, then paste their reply in step 2.'}catch(e){pairHint.textContent='Could not create invite: '+(e?.message||e)}};
processSignal.onclick=async()=>{if(pairSignalBusy){pairHint.textContent='Still processing that code…';return}if(role==='offer'&&(pairReplyAccepted||!pc||pc.signalingState!=='have-local-offer')){const failed=pc&&['failed','disconnected','closed'].includes(pc.connectionState);pairHint.textContent=failed?'That connection attempt already ended. Click Create invite, then send the new code to your friend for a fresh try.':'That reply was already accepted. Connecting directly…';processSignal.disabled=true;return}pairSignalBusy=true;processSignal.disabled=true;try{const remote=await cleanSignal(signalIn.value);if(role==='offer'){if(remote.type!=='answer')throw new Error('Paste the reply your friend created, not another invite');await pc.setRemoteDescription({type:'answer',sdp:remote.sdp});if(!await derive(pc._kp,remote.pub))throw new Error('Security code was not confirmed');pairReplyAccepted=true;pairHint.textContent='Connecting directly…'}else if(!role){if(remote.type!=='offer')throw new Error('Paste an invite first, then create its reply');role='answer';setOutgoingCode('');setupPeer();const kp=await keyPair();pc._kp=kp;await pc.setRemoteDescription({type:'offer',sdp:remote.sdp});if(!await derive(kp,remote.pub))throw new Error('Security code was not confirmed');const a=await pc.createAnswer();await pc.setLocalDescription({type:'answer',sdp:patchSdp(a.sdp)});await waitIce();setOutgoingCode(await makeSignal({type:'answer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}));pairHint.textContent='Reply ready. Copy it and send it back to the person who invited you.';processSignal.textContent='Reply ready'}else pairHint.textContent='Your reply is already ready. Copy it and send it back to your friend.'}catch(e){processSignal.disabled=false;pairHint.textContent='Could not continue pairing: '+(e?.message||e)}finally{pairSignalBusy=false}};
copySignal.onclick=()=>copyOutgoingCode().catch(e=>{pairHint.textContent='Could not copy code: '+(e?.message||e)});
messageForm.onsubmit=async e=>{e.preventDefault();const text=convertEmoticons(messageInput.value.trim()),gif=pendingGif;if(!text&&!gif)return;const payload=chatPayload(text,gif);if(enc.encode(payload).byteLength>MAX_MESSAGE_SIZE){pairHint.textContent='Messages are limited to 64 KB.';return}if(!sharedKey){if(LOCAL_TEST_MODE){addMessage(text,true,gif);messageInput.value='';setPendingGif(null);return}return}send({t:'msg',v:await seal(payload)});addMessage(text,true,gif);messageInput.value='';setPendingGif(null);if(gif?.analytics)analyticsShared(gif.analytics)};
fileInput.onchange=()=>{const files=[...fileInput.files];fileInput.value='';files.forEach(sendFile);};
function transfer(name,size,dir){
  const el=document.createElement('div');el.className='transfer';el.innerHTML='<div class="transfer-top"><span class="transfer-name"></span><span class="transfer-status"></span></div><div class="bar"><i></i></div><div class="transfer-stats"><span class="transfer-speed"></span><span class="transfer-eta"></span></div><div class="transfer-peer"></div><div class="transfer-btns"><button class="cancel-btn text-button" hidden>Cancel</button><button class="retry-btn primary" hidden>Retry</button></div>';
  el.querySelector('.transfer-name').textContent=name+' · '+format(size);
  const msg=document.createElement('div');msg.className='message'+(dir==='out'?' mine':'');
  const bub=document.createElement('div');bub.className='bubble';bub.append(el);
  const meta=document.createElement('div');meta.className='meta';meta.textContent=new Date().toLocaleTimeString();
  msg.append(bub,meta);messages.append(msg);messages.scrollTop=messages.scrollHeight;
  return el;
}function format(n){return n<1e9?(n/1e6).toFixed(1)+' MB':(n/1e9).toFixed(2)+' GB'}function formatSpeed(bps){if(bps<1e3)return(bps).toFixed(0)+' B/s';if(bps<1e6)return(bps/1e3).toFixed(1)+' KB/s';if(bps<1e9)return(bps/1e6).toFixed(1)+' MB/s';return(bps/1e9).toFixed(2)+' GB/s'}function formatEta(sec){if(!isFinite(sec)||sec<0)return'';sec=Math.round(sec);if(sec<60)return sec+'s';const m=Math.floor(sec/60),s=sec%60;if(m<60)return m+'m '+s+'s';const h=Math.floor(m/60);return h+'h '+(m%60)+'m'}function updateStats(el,done,total,startTime){const elapsed=(performance.now()-startTime)/1000;if(elapsed<0.5)return;const speed=done/elapsed;const remaining=(total-done)/speed;el.querySelector('.transfer-speed').textContent=formatSpeed(speed);el.querySelector('.transfer-eta').textContent=formatEta(remaining)}
// Resolvers for sender-side "peer accepted/rejected" signals, keyed by seq.
const acceptWait=new Map();
async function sendFile(file,retryId){try{if(file.size>MAX)return alert('This file is larger than 200 GiB.');if(!fileBus()){if(LOCAL_TEST_MODE){const preview=transfer(file.name,file.size,'out');preview.querySelector('.transfer-status').textContent='Local preview — not sent';preview.querySelector('.bar i').style.width='100%';return}return alert('Connect first, then send a file.')}const el=transfer(file.name,file.size,'out');const cancelBtn=el.querySelector('.cancel-btn'),retryBtn=el.querySelector('.retry-btn');cancelBtn.hidden=false;retryBtn.hidden=true;const seq=retryId||++fileSeq;const ctrl={abort:false};sendAbort.set(seq,ctrl);outTransfers.set(seq,el);cancelBtn.onclick=()=>{const aw=acceptWait.get(seq);if(aw){acceptWait.delete(seq);aw.reject(new Error('Cancelled'))}ctrl.abort=true;cancelBtn.hidden=true;try{if(files&&files.readyState==='open')files.send(JSON.stringify({t:'cancel',seq}))}catch{}};const meta=await seal(JSON.stringify({name:file.name,size:file.size,type:file.type,seq}));sendQueue=sendQueue.then(async()=>{  const t0=performance.now();try{await safeSend(JSON.stringify({t:'start',v:meta}));
  // If the user already cancelled (during safeSend(start) above), bail immediately
  // rather than setting up an accept wait that would hang forever.
  if(ctrl.abort)throw new Error('Cancelled');
  // Wait for the friend to accept before streaming any bytes, so we don't push
  // a whole file into the relay before they've agreed to receive it. Time out
  // so we never hang if the peer never responds.
  await new Promise((resolve,reject)=>{const to=setTimeout(()=>{if(acceptWait.has(seq)){acceptWait.delete(seq);reject(new Error('No answer'))}},60000);acceptWait.set(seq,{resolve:()=>{clearTimeout(to);resolve()},reject:e=>{clearTimeout(to);reject(e)}});});
  if(ctrl.abort)throw new Error('Cancelled');
  // Keep several AES-GCM operations in flight. The old one-chunk look-ahead
  // serialized encryption behind every send, leaving a fast LAN underfed. Jobs
  // are still emitted in file order, so the receiver keeps its simple ordered
  // disk writer and memory remains bounded to CRYPTO_AHEAD chunks + SEND_WINDOW.
  const cryptoJobs=[];let nextOfs=0;let lastPeerSent=0,lastPctSent=-1;
  const emitPct=(done,pct)=>{el.querySelector('i').style.width=Math.min(100,done/file.size*100)+'%';el.querySelector('.transfer-status').textContent=pct+'%';updateStats(el,done,file.size,t0);const now=Date.now();if((pct!==lastPctSent&&now-lastPeerSent>250)||now-lastPeerSent>500){lastPctSent=pct;lastPeerSent=now;safeSend(JSON.stringify({t:'progress',seq,p:pct})).catch(()=>{})}};
  const queueCrypto=()=>{if(nextOfs>=file.size)return;const start=nextOfs,end=Math.min(start+CHUNK,file.size);nextOfs=end;cryptoJobs.push(file.slice(start,end).arrayBuffer().then(raw=>sealBytes(new Uint8Array(raw))).then(({iv,data})=>({frame:packChunk(seq,start,new Uint8Array(iv),new Uint8Array(data),end>=file.size),done:end}))) };
  while(cryptoJobs.length<CRYPTO_AHEAD)queueCrypto();
  while(cryptoJobs.length){
    const {frame,done}=await cryptoJobs.shift();if(ctrl.abort)throw new Error('Cancelled');
    // busSafeSend observes the transport's real bufferedAmount and waits for
    // bufferedamountlow when necessary, so it is the authoritative limiter.
    await busSafeSend(frame);
    queueCrypto();
    const pct=Math.round(done/file.size*100);emitPct(done,pct);
  }
    if(!ctrl.abort){await safeSend(JSON.stringify({t:'end',seq}));el.querySelector('.transfer-status').textContent='Sent';el.querySelector('.transfer-speed').textContent='';el.querySelector('.transfer-eta').textContent='';setPeerPct(el,100);cancelBtn.hidden=true}sendAbort.delete(seq);}catch(e){const aw=acceptWait.get(seq);if(aw){acceptWait.delete(seq);if(!ctrl.abort)aw.reject(e)}sendAbort.delete(seq);if(ctrl.abort||(e&&e.message==='Cleared')||(e&&e.message==='disconnected')){el.querySelector('.transfer-status').textContent='Cancelled'}else if(e&&e.message==='rejected'){const s=el.querySelector('.transfer-status');s.textContent='Declined by friend';s.classList.add('declined')}else{const s=el.querySelector('.transfer-status');s.textContent='Failed: '+(e?.message||e);s.classList.add('failed')}el.querySelector('.transfer-speed').textContent='';el.querySelector('.transfer-eta').textContent='';cancelBtn.hidden=true;retryBtn.hidden=false;retryBtn.onclick=()=>{el.remove();sendFile(file);};try{await safeSend(JSON.stringify({t:'end',seq,cancelled:true}))}catch{}}outTransfers.delete(seq);}).catch(()=>{});}catch{}}
// Active incoming transfers, keyed by their seq (so multiple files in flight
// are kept separate). Chunks carry seq in their frame header and route here.
const activeTransfers=new Map();
// Outgoing transfers, keyed by seq, so we can show the peer's reported progress.
const outTransfers=new Map();
// Renders the peer's mirrored progress under a transfer card.
function setPeerPct(el,pct){const p=el.querySelector('.transfer-peer');if(!p)return;p.textContent='Friend: '+pct+'%';p.style.display='';}
// Chunks that arrive on the relay before the matching 'start' is processed,
// held per-seq so nothing is dropped or misrouted.
const pendingFrames=new Map(),pendingFrameDelete=pendingFrames.delete.bind(pendingFrames);const PENDING_FRAME_LIMIT=32*1024*1024,PENDING_FRAME_TTL=30000,ACTIVE_FRAME_LIMIT=64*1024*1024;let pendingFrameBytes=0;
function dropPending(seq){const held=pendingFrames.get(seq);if(!held)return;for(const p of held)pendingFrameBytes-=p.len;pendingFrameDelete(seq);if(pendingFrameBytes<0)pendingFrameBytes=0}
// Control-frame cancellation can arrive before its encrypted metadata. Keep
// the byte budget correct even in that early-frame race.
pendingFrames.delete=seq=>{if(!pendingFrames.has(seq))return false;dropPending(seq);return true};
function clearPendingFrames(){pendingFrames.clear();pendingFrameBytes=0}
const acceptCards=new Map();
function showAcceptCard(meta,seq){const card=document.createElement('div');card.className='transfer accept-card';card.innerHTML='<div class="accept-top"><strong class="accept-name"></strong><span class="accept-size"></span></div><p class="accept-hint">Your friend wants to send you a file.</p><div class="accept-btns"><button class="accept-yes primary">Accept</button><button class="accept-no">Decline</button></div>';card.querySelector('.accept-name').textContent=meta.name;card.querySelector('.accept-size').textContent=' · '+format(meta.size);const yes=card.querySelector('.accept-yes'),no=card.querySelector('.accept-no');const msg=document.createElement('div');msg.className='message';const bub=document.createElement('div');bub.className='bubble';bub.append(card);const mta=document.createElement('div');mta.className='meta';mta.textContent=new Date().toLocaleTimeString();msg.append(bub,mta);messages.append(msg);messages.scrollTop=messages.scrollHeight;const resolve=new Promise(r=>{const done=v=>{if(acceptCards.get(seq)!==done)return;clearTimeout(acceptTimer);acceptCards.delete(seq);dropPending(seq);msg.remove();r(v)};const acceptTimer=setTimeout(()=>done(false),60000);acceptCards.set(seq,done);yes.onclick=()=>done(true);no.onclick=()=>done(false)});return resolve}
// Per-incoming-file ordered write queue so decrypted chunks hit disk in order
// even though decryption runs concurrently in a pool.
function makeWriteQueue(t){let tail=Promise.resolve();return fn=>{tail=tail.then(fn).catch(e=>{t.writeError=e});return tail}}
// Enqueue one received binary chunk frame, routed to its transfer by seq. If
// that transfer hasn't started yet (control rides the WebRTC channel and may
// arrive after relay chunks), buffer per-seq so nothing is dropped/misrouted.
// Runs synchronously and never awaits.
function enqueueChunk(buf){
  try{
  const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);const len=dv.getUint32(0);
  // Guard against corrupt/truncated frames so one bad chunk can't throw inside
  // the socket onmessage handler (which would drop the message loop frame).
  if(!(len>0&&4+len+12<=buf.byteLength))return;
  const hdr=JSON.parse(dec.decode(buf.subarray(4,4+len)));
  if(hdr.t!=='c')return;
  const seq=hdr.s||0;
  const frame={iv:buf.subarray(4+len,4+len+12),ct:buf.subarray(4+len+12),last:!!hdr.l};
  const t=activeTransfers.get(seq);
  if(t&&!t.abort){if(t.wire-t.received+buf.byteLength>ACTIVE_FRAME_LIMIT)return;t.frames.push(frame);t.wire+=buf.byteLength;if(hdr.l)t.lastSeen=true}
  else if(pendingFrameBytes+buf.byteLength<=PENDING_FRAME_LIMIT){const held=pendingFrames.get(seq)||pendingFrames.set(seq,[]).get(seq);held.push({frame,len:buf.byteLength,last:!!hdr.l});pendingFrameBytes+=buf.byteLength;if(held.length===1)setTimeout(()=>dropPending(seq),PENDING_FRAME_TTL)}
  }catch{}
}
// Control + chunk handler for the direct WebRTC data channel.
async function onFileFrame(e){
  if(e.data instanceof ArrayBuffer){enqueueChunk(new Uint8Array(e.data));return;}
  let o;try{o=JSON.parse(e.data)}catch{return;}
  try{
  if(o.t==='start'){let meta;try{meta=JSON.parse(dec.decode(await open(o.v)))}catch{try{await safeSend(JSON.stringify({t:'reject',seq:0}))}catch{};return}const seq=Number(meta.seq);if(!Number.isSafeInteger(seq)||seq<1||!Number.isSafeInteger(meta.size)||meta.size<0||meta.size>MAX||typeof meta.name!=='string'||meta.name.length>255){try{await safeSend(JSON.stringify({t:'reject',seq:0}))}catch{};return}const accepted=await showAcceptCard(meta,seq);if(!accepted){dropPending(seq);await safeSend(JSON.stringify({t:'reject',seq}));return}const t={...meta,seq,received:0,wire:0,el:transfer(meta.name,meta.size,'in'),startTime:performance.now(),frames:[],parts:[],lastSeen:false,abort:false,done:Promise.resolve(),writeError:null,saveMode:'mem',writer:null,stuck:null};t.writeQueue=makeWriteQueue(t);activeTransfers.set(seq,t);let saveErr=null;if(window.pairSave){try{const r=await window.pairSave.start(meta.name);if(r&&r.ok){t.saveMode='pair'}else saveErr='Save dialog declined'}catch(e){saveErr=e.message}}else if(window.showSaveFilePicker){try{const handle=await showSaveFilePicker({suggestedName:meta.name});t.writer=await handle.createWritable();t.saveMode='fileAccess'}catch(e){saveErr=e.message}}else saveErr='No save method available';if(saveErr&&meta.size>5*1024*1024){t.abort=true;try{await safeSend(JSON.stringify({t:'reject',seq}))}catch{};const s=t.el.querySelector('.transfer-status');s.textContent='Failed: '+saveErr;s.classList.add('failed');activeTransfers.delete(seq);return}if(t.saveMode==='mem'&&meta.size>4*1024*1024*1024){alert('No disk streaming available for files over 4 GB. The transfer will fail.');t.abort=true;try{await safeSend(JSON.stringify({t:'reject',seq}))}catch{};const s=t.el.querySelector('.transfer-status');s.textContent='Failed: File too large for memory mode';s.classList.add('failed');activeTransfers.delete(seq);return}
  // Tell the sender we accepted, so it begins streaming.
  await safeSend(JSON.stringify({t:'accept',seq}));
  // Drain any chunk frames that arrived on the relay before this 'start'.
  const held=pendingFrames.get(seq);if(held){for(const p of held){t.frames.push(p.frame);t.wire+=p.len;if(p.last)t.lastSeen=true}dropPending(seq)}
           t.done=processIncoming(t);t.done.catch(e=>{if(t.el){const s=t.el.querySelector('.transfer-status');if(s&&!s.classList.contains('failed')&&!s.classList.contains('declined')){s.textContent='Failed: '+(e?.message||e);s.classList.add('failed')}}});}else if(o.t==='cancel'){const ac=acceptCards.get(o.seq);if(ac)try{ac(false)}catch{};acceptCards.delete(o.seq);pendingFrames.delete(o.seq);}else if(o.t==='progress'){const el=outTransfers.get(o.seq)||(activeTransfers.get(o.seq)&&activeTransfers.get(o.seq).el);if(el)setPeerPct(el,o.p|0);return}else if(o.t==='reject'){const t=activeTransfers.get(o.seq);const aw=acceptWait.get(o.seq);if(aw){acceptWait.delete(o.seq);aw.reject(new Error('rejected'))}if(t){t.abort=true;if(t.saveMode==='pair')try{await window.pairSave.cancel()}catch{}if(t.writer)try{await t.writer.abort()}catch{}const s=t.el.querySelector('.transfer-status');s.textContent='Declined';s.classList.add('declined');activeTransfers.delete(o.seq)}}else if(o.t==='accept'){const aw=acceptWait.get(o.seq);if(aw){acceptWait.delete(o.seq);aw.resolve()}}else if(o.t==='end'){const t=activeTransfers.get(o.seq);if(!t){const ac=acceptCards.get(o.seq);if(ac)try{ac(false)}catch{};return}acceptWait.delete(o.seq);if(o.cancelled||t.abort){const senderCancelled=!!o.cancelled&&!t.abort;t.abort=true;if(t.saveMode==='pair')try{await window.pairSave.cancel()}catch{}if(t.writer)try{await t.writer.abort()}catch{}if(senderCancelled){const s=t.el.querySelector('.transfer-status');s.textContent='Sender cancelled';s.classList.add('declined');activeTransfers.delete(o.seq)}return}try{await t.done;if(t.saveMode==='fileAccess')await t.writer.close();else if(t.saveMode==='pair')await window.pairSave.end();else{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(t.parts||[],{type:t.type}));a.download=t.name;a.click()}t.el.querySelector('.transfer-status').textContent='Received';t.el.querySelector('.transfer-speed').textContent='';t.el.querySelector('.transfer-eta').textContent='';setPeerPct(t.el,100)}catch(e){if(t.saveMode==='pair')try{await window.pairSave.cancel()}catch{}if(t.writer)try{await t.writer.abort()}catch{}const s=t.el.querySelector('.transfer-status');s.textContent='Save failed: '+(e?.message||e);s.classList.add('failed')}finally{activeTransfers.delete(o.seq)}}
  }catch{}}
// Decrypt + write one transfer's frames concurrently (bounded pool) but commit
// bytes to disk / memory in arrival order. Updates progress + ETA for EVERY
// save mode (disk streaming on Linux included). Disk writes are batched to cut
// per-chunk IPC overhead.
const WRITE_BATCH=8*1024*1024;
// If no progress happens for this long (ms) the transfer is considered stuck and
// we surface exactly which phase it was stuck on so the user isn't left guessing.
const STALL_TIMEOUT=15000;
async function processIncoming(t){const POOL=8;const queue=t.writeQueue;let active=0;  const slot=()=>new Promise(r=>{if(active<POOL)r();else{const h=()=>{active--;if(active<POOL)r();else setTimeout(h,0)};pendingSlots.push(h)}});const pendingSlots=[];const release=()=>{const h=pendingSlots.shift();if(h)h();else active--};
  // Order-preserving reassembly: the decrypt pool resolves chunks out of arrival
  // order, so we buffer each decrypted chunk by its arrival index and only ever
  // commit a CONTIGUOUS run starting at `expected`. This guarantees bytes hit
  // disk/memory in the exact order they were sent, regardless of pool reordering.
  const buffer=new Map();let expected=0;let nextIdx=0;let batch=[];let batchLen=0;
  const emit=bytes=>{if(t.received+bytes.length>t.size)throw new Error('Sender exceeded the declared file size');batch.push(bytes);batchLen+=bytes.length;t.received+=bytes.length;touch();const frac=t.size>0?Math.min(100,t.received/t.size*100):100;const pct=Math.round(frac);t.el.querySelector('i').style.width=frac+'%';t.el.querySelector('.transfer-status').textContent=pct+'%';updateStats(t.el,t.received,t.size,t.startTime);sendPeerProgress(pct)};
  const flushBatch=async()=>{if(!batch.length)return;const all=batch;batch=[];batchLen=0;
    if(t.saveMode==='discard')return;
    if(t.saveMode==='fileAccess'){for(const b of all)await t.writer.write(b);return}
    if(t.saveMode==='pair'){for(const b of all)await window.pairSave.write(b);return}
    for(const b of all)t.parts.push(b)};
  const drainBuffer=async()=>{while(buffer.has(expected)){const bytes=buffer.get(expected);buffer.delete(expected);expected++;emit(bytes);if(batchLen>=WRITE_BATCH||t.lastSeen)await flushBatch()}};
  if(t.size===0)t.lastSeen=true;
  let phase=t.received>0?'waiting for the final chunk':'waiting for the first chunk';
  let lastProgress=Date.now();let lastPeerSent=0,lastPctSent=-1;
  const watchdog=setInterval(()=>{if(Date.now()-lastProgress>STALL_TIMEOUT){const where=active>0?'draining decrypted chunks':'waiting for the next chunk ('+phase+')';t.stuck=new Error('Transfer stalled — stuck '+where+'. Received '+format(t.received)+' of '+format(t.size)+'. The connection may have dropped; try resending.')}},STALL_TIMEOUT/3);
  const touch=()=>{lastProgress=Date.now()};
  const sendPeerProgress=pct=>{const now=Date.now();if((pct!==lastPctSent&&now-lastPeerSent>250)||now-lastPeerSent>500){lastPctSent=pct;lastPeerSent=now;safeSend(JSON.stringify({t:'progress',seq:t.seq,p:pct})).catch(()=>{})}};
  try{
  while(!(t.lastSeen&&t.frames.length===0)){
    if(t.abort)return;
    phase=t.received>0?'waiting for the final chunk':'waiting for the first chunk';
    while(t.frames.length){
      if(t.stuck)throw t.stuck;
      if(t.abort)return;
      await slot();active++;touch();
      const idx=nextIdx++;const f=t.frames.shift();
      openBytes(f.iv,f.ct).then(bytes=>queue(async()=>{if(t.saveMode==='discard')return;buffer.set(idx,bytes);await drainBuffer()})).catch(e=>{t.writeError=e||new Error('decrypt failed');t.abort=true}).finally(release);
    }
    if(t.stuck)throw t.stuck;
    if(!t.lastSeen)await new Promise(r=>setTimeout(r,4));
  }
  while(active>0)await new Promise(r=>setTimeout(r,4));
  if(t.stuck)throw t.stuck;
  if(t.writeError)throw t.writeError;
  if(t.received!==t.size)throw new Error('Received size does not match the file offer');
  await flushBatch();
  }finally{clearInterval(watchdog);try{await flushBatch()}catch{}}
}
setStatus('Not connected');
function enableLocalTestControls(){if(!LOCAL_TEST_MODE)return;messageInput.disabled=false;messageForm.querySelector('.send').disabled=false;fileInput.disabled=false;callBtn.disabled=false;screenBtn.disabled=false;statusText.textContent='Local test mode';pairHint.textContent='Test mode is on — messages stay on this device until you pair with a friend.'}
enableLocalTestControls();

async function ss(key){if(window.pairSettings){try{return await window.pairSettings.get(key)}catch{}}try{return localStorage.getItem('pair.'+key)}catch{}}
async function ssSet(key,val){if(window.pairSettings){try{await window.pairSettings.set(key,val);return}catch{}}try{if(val==null)localStorage.removeItem('pair.'+key);else localStorage.setItem('pair.'+key,val)}catch{}}
let screenCursor='always',screenContentHint='motion',screenBitrateMbps=12,screenCodec='auto',shareResolution='source',shareFrameRate=60,screenAudioOn=true;
function abortScreenSharePicker(){screenSharePickerEpoch++;const cancel=screenSharePickerCancel;screenSharePickerCancel=null;if(cancel)cancel();discardPrimedScreenAudioContext()}
function shareSourceType(source){if(source?.type==='screen'||String(source?.id||'').startsWith('screen:'))return'screen';return'application'}
function excludedScreenSource(source){return /\bnvidia\s+broadcast\b/i.test(String(source?.name||''))}
function openScreenSharePicker({sources=[],qualityOnly=false}={}){
  const dialog=$('#screenShareDialog');if(!dialog||dialog.open)return Promise.resolve(null);
  const form=$('#screenShareForm'),title=$('#screenShareDialogTitle'),description=$('#screenShareDialogDescription'),sourceStep=$('#screenShareSourceStep'),qualityStep=$('#screenShareQualityStep'),sourceGrid=$('#screenShareSourceGrid'),sourceEmpty=$('#screenShareSourceEmpty'),continueButton=$('#screenShareContinue'),goLiveButton=$('#screenShareGoLive'),backButton=$('#screenShareBack'),cancelButton=$('#screenShareCancel'),closeButton=$('#screenShareClose'),previewImage=$('#screenSharePreviewImage'),portalPreview=$('#screenSharePortalPreview'),previewName=$('#screenSharePreviewName'),audioInput=$('#screenShareAudio'),tabs=[...dialog.querySelectorAll('[data-source-tab]')],resolutionButtons=[...dialog.querySelectorAll('[data-share-resolution]')],fpsButtons=[...dialog.querySelectorAll('[data-share-fps]')],opener=document.activeElement;
  const available=(Array.isArray(sources)?sources:[]).filter(source=>!excludedScreenSource(source)).map(source=>({...source,type:shareSourceType(source)})),draft={source:null,resolution:['source','720','1080','1440','2160'].includes(shareResolution)?shareResolution:'source',fps:shareFrameRate===30?30:60,audio:!!screenAudioOn},counts={application:available.filter(source=>source.type==='application').length,screen:available.filter(source=>source.type==='screen').length};
  let activeType=counts.application?'application':'screen',settled=false;
  const paintChoices=()=>{for(const button of resolutionButtons){const selected=button.dataset.shareResolution===draft.resolution;button.type='button';button.setAttribute('role','radio');button.setAttribute('aria-checked',String(selected));button.classList.toggle('selected',selected)}for(const button of fpsButtons){const selected=Number(button.dataset.shareFps)===draft.fps;button.type='button';button.setAttribute('role','radio');button.setAttribute('aria-checked',String(selected));button.classList.toggle('selected',selected)}audioInput.checked=draft.audio};
  const paintPreview=()=>{const source=draft.source,thumbnail=String(source?.thumbnail||'');previewName.textContent=source?.name||'System screen picker';previewImage.hidden=!thumbnail;portalPreview.hidden=!!thumbnail;if(thumbnail)previewImage.src=thumbnail;else previewImage.removeAttribute('src')};
  const paintTabs=()=>{for(const tab of tabs){const type=tab.dataset.sourceTab,selected=type===activeType;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;tab.disabled=!counts[type]}}
  const paintSources=()=>{sourceGrid.replaceChildren();continueButton.disabled=!draft.source;const shown=available.filter(source=>source.type===activeType);sourceEmpty.hidden=!!shown.length;for(const source of shown){const button=document.createElement('button'),image=document.createElement('img'),name=document.createElement('span'),selected=draft.source?.id===source.id;button.type='button';button.className='screen-source-card'+(selected?' selected':'');button.dataset.sourceId=source.id;button.setAttribute('aria-pressed',String(selected));button.setAttribute('aria-label',(selected?'Selected: ':'Share ')+source.name);image.alt='';image.src=source.thumbnail||'';name.textContent=source.name;button.append(image,name);button.onclick=()=>{draft.source=source;paintSources()};sourceGrid.append(button)}};
  const showQuality=()=>{sourceStep.hidden=true;qualityStep.hidden=false;backButton.hidden=qualityOnly;continueButton.hidden=true;goLiveButton.hidden=false;title.textContent='Stream Quality';description.textContent='Your selected resolution and frame rate stay locked for this stream.';paintPreview();paintChoices();queueMicrotask(()=>goLiveButton.focus())};
  const showSources=()=>{qualityStep.hidden=true;sourceStep.hidden=false;backButton.hidden=true;continueButton.hidden=false;goLiveButton.hidden=true;title.textContent='Share Your Screen';description.textContent='Choose exactly what to stream. Nothing starts until you press Go Live.';paintTabs();paintSources();queueMicrotask(()=>tabs.find(tab=>!tab.disabled&&tab.dataset.sourceTab===activeType)?.focus())};
  return new Promise(resolve=>{
    let cancel=null;const finish=value=>{if(settled)return;settled=true;if(screenSharePickerCancel===cancel)screenSharePickerCancel=null;form.onsubmit=null;dialog.oncancel=null;closeButton.onclick=cancelButton.onclick=backButton.onclick=null;for(const tab of tabs)tab.onclick=null;for(const button of resolutionButtons)button.onclick=null;for(const button of fpsButtons)button.onclick=null;audioInput.onchange=null;if(dialog.open)dialog.close(value?'confirm':'cancel');queueMicrotask(()=>{try{opener?.focus?.({preventScroll:true})}catch{}});resolve(value)};cancel=()=>finish(null);screenSharePickerCancel=cancel;
    for(const tab of tabs)tab.onclick=()=>{if(tab.disabled)return;activeType=tab.dataset.sourceTab;paintTabs();paintSources()};
    for(const button of resolutionButtons)button.onclick=()=>{draft.resolution=button.dataset.shareResolution;paintChoices()};
    for(const button of fpsButtons)button.onclick=()=>{draft.fps=Number(button.dataset.shareFps)===30?30:60;paintChoices()};
    audioInput.onchange=()=>{draft.audio=audioInput.checked};
    closeButton.onclick=cancelButton.onclick=()=>finish(null);backButton.onclick=showSources;
    form.onsubmit=event=>{event.preventDefault();if(!sourceStep.hidden){if(draft.source)showQuality();return}finish({sourceId:draft.source?.id||null,sourceType:draft.source?.type||null,sourceName:draft.source?.name||'System screen picker',resolution:draft.resolution,fps:draft.fps,audio:draft.audio})};
    dialog.oncancel=event=>{event.preventDefault();finish(null)};
    paintChoices();if(qualityOnly)showQuality();else showSources();dialog.showModal();
  })
}
function commitScreenShareChoice(choice){if(!choice)return;shareResolution=['source','720','1080','1440','2160'].includes(choice.resolution)?choice.resolution:'source';shareFrameRate=Number(choice.fps)===30?30:60;screenAudioOn=!!choice.audio;syncScreenAudioToggle();ssSet('shareResolution',shareResolution);ssSet('shareResolutionExplicit','yes');ssSet('shareFrameRate',String(shareFrameRate));ssSet('shareSystemAudio',screenAudioOn?'on':'off')}
async function chooseScreenShare(options={}){const epoch=screenSharePickerEpoch;await screenShareSettingsReady;if(epoch!==screenSharePickerEpoch)return null;const supplied=Array.isArray(options.sources),qualityOnly=typeof options.qualityOnly==='boolean'?options.qualityOnly:(!window.pairEnv?.getSources||!!window.pairEnv.useSystemPicker);let sources=supplied?options.sources:[];if(!qualityOnly&&!supplied){sources=await window.pairEnv.getSources();if(epoch!==screenSharePickerEpoch)return null;if(!sources.length)throw new Error('No screen or window was selected')}const choice=await openScreenSharePicker({sources,qualityOnly});if(epoch!==screenSharePickerEpoch||!choice)return null;commitScreenShareChoice(choice);if(choice.sourceId&&window.pairEnv?.setPendingSource){const selected=await window.pairEnv.setPendingSource(choice.sourceId);if(epoch!==screenSharePickerEpoch)return null;if(selected===false)throw new Error('The selected screen or window is no longer available')}return epoch===screenSharePickerEpoch?choice:null}
function openSettingsTab(name){document.querySelectorAll('.settings-tab').forEach(tab=>{const active=tab.dataset.settingsTab===name;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active))});document.querySelectorAll('.settings-page').forEach(page=>{const active=page.dataset.settingsPage===name;page.classList.toggle('active',active);page.hidden=!active})}
function addScreenShareSettings(){
  const tab=document.createElement('button');tab.type='button';tab.className='settings-tab';tab.dataset.settingsTab='screen';tab.setAttribute('role','tab');tab.setAttribute('aria-selected','false');tab.textContent='Screen sharing';
  const page=document.createElement('section');page.className='settings-section settings-page';page.dataset.settingsPage='screen';page.setAttribute('role','tabpanel');page.hidden=true;
  page.innerHTML='<div><h3>Screen sharing</h3><p>Knot keeps the resolution and frame rate you choose for the entire stream. It reports connection pressure instead of silently changing either setting.</p></div><label class="settings-field"><span>Video codec</span><select id="screenCodecSetting"><option value="auto">Automatic — hardware-friendly</option><option value="H264">H.264 — widest support</option><option value="AV1">AV1 — best compression</option><option value="VP9">VP9</option><option value="VP8">VP8</option></select></label><label class="settings-field"><span>Maximum video bitrate <output id="screenBitrateValue">12 Mbps</output></span><input id="screenBitrateSetting" type="range" min="2" max="40" value="12" step="1" /></label><label class="settings-field"><span>Content optimization</span><select id="screenContentHintSetting"><option value="motion">Motion — games and video</option><option value="detail">Detail — text and documents</option></select></label><label class="settings-field"><span>Cursor</span><select id="screenCursorSetting"><option value="always">Always show</option><option value="motion">Show while moving</option><option value="never">Hide cursor</option></select></label><p class="settings-hint">Native AV1 uses the discrete NVIDIA or AMD encoder, syncs capture to the content, and discards stale video before it can stall the desktop or microphone. A sustained decoder failure switches only that viewer to a bandwidth-capped compatibility codec.</p><div class="settings-inline-actions"><button id="testScreenAudio" type="button">Test isolated computer audio</button></div><p id="screenAudioTestStatus" class="settings-hint" aria-live="polite">Checks the same isolated audio route used by a real share.</p>';
  document.querySelector('.settings-tabs').append(tab);document.querySelector('.settings-pages').append(page);tab.onclick=()=>openSettingsTab('screen');
  const bitrate=$('#screenBitrateSetting'),bitrateValue=$('#screenBitrateValue'),codec=$('#screenCodecSetting'),contentHint=$('#screenContentHintSetting'),cursor=$('#screenCursorSetting');
  const updateBitrate=()=>{screenBitrateMbps=Math.max(2,Math.min(40,Number(bitrate.value)||12));bitrateValue.textContent=screenBitrateMbps+' Mbps';bitrate.style.setProperty('--range-fill',((screenBitrateMbps-2)/38*100)+'%');ssSet('screenBitrate',String(screenBitrateMbps))};
  bitrate.oninput=updateBitrate;enableRangeDrag(bitrate);codec.onchange=()=>{screenCodec=['auto','H264','AV1','VP9','VP8'].includes(codec.value)?codec.value:'auto';ssSet('screenCodec',screenCodec)};contentHint.onchange=()=>{screenContentHint=contentHint.value==='detail'?'detail':'motion';ssSet('screenContentHint',screenContentHint)};cursor.onchange=()=>{screenCursor=['always','motion','never'].includes(cursor.value)?cursor.value:'always';ssSet('screenCursor',screenCursor)};$('#testScreenAudio').onclick=()=>testScreenAudioIsolation($('#testScreenAudio'),$('#screenAudioTestStatus'));
  return async()=>{
    const savedBitrateValue=await ss('screenBitrate'),savedBitrate=Number(savedBitrateValue);screenBitrateMbps=savedBitrateValue!==null&&savedBitrateValue!==''&&Number.isFinite(savedBitrate)?Math.max(2,Math.min(40,savedBitrate)):12;bitrate.value=String(screenBitrateMbps);updateBitrate();
    const savedCodec=await ss('screenCodec');screenCodec=['auto','H264','AV1','VP9','VP8'].includes(savedCodec)?savedCodec:'auto';codec.value=screenCodec;
    const savedHint=await ss('screenContentHint');screenContentHint=savedHint==='detail'?'detail':'motion';contentHint.value=screenContentHint;
    const savedCursor=await ss('screenCursor');screenCursor=['always','motion','never'].includes(savedCursor)?savedCursor:'always';cursor.value=screenCursor;
    const [savedResolution,explicitResolution]=await Promise.all([ss('shareResolution'),ss('shareResolutionExplicit')]);shareResolution=explicitResolution==='yes'&&['source','720','1080','1440','2160'].includes(savedResolution)?savedResolution:'source';
    const savedFps=Number(await ss('shareFrameRate'));shareFrameRate=savedFps===30?30:60;
    const savedAudio=await ss('shareSystemAudio');screenAudioOn=savedAudio==null?true:savedAudio==='on';
  };
}
const restoreScreenShareSettings=addScreenShareSettings();
document.querySelectorAll('.settings-tab').forEach(tab=>tab.onclick=()=>openSettingsTab(tab.dataset.settingsTab));
const screenShareSettingsReady=restoreScreenShareSettings();
function makeDeviceOption(value,label){const option=document.createElement('option');option.value=value;option.textContent=label;return option}
async function refreshAudioDevices(){try{const devices=await navigator.mediaDevices.enumerateDevices();const inputs=devices.filter(device=>device.kind==='audioinput'),outputs=devices.filter(device=>device.kind==='audiooutput');inputDevice.replaceChildren(makeDeviceOption('default','System default'));outputDevice.replaceChildren(makeDeviceOption('default','System default'));inputs.forEach((device,index)=>inputDevice.append(makeDeviceOption(device.deviceId,device.label||'Microphone '+(index+1))));outputs.forEach((device,index)=>outputDevice.append(makeDeviceOption(device.deviceId,device.label||'Speaker '+(index+1))));inputDevice.value=[...inputDevice.options].some(option=>option.value===inputDeviceId)?inputDeviceId:'default';outputDevice.value=[...outputDevice.options].some(option=>option.value===outputDeviceId)?outputDeviceId:'default';deviceHint.textContent=(inputs.length||outputs.length)?'Device list updated.':'Connect or allow a microphone to reveal device names.'}catch{deviceHint.textContent='Knot could not read audio devices yet.'}}
function microphoneConstraints({echoCancellation=voiceProcessingEnabled}={}){const audio={sampleRate:{ideal:48000},sampleSize:{ideal:32},channelCount:{ideal:2},latency:{ideal:.01},echoCancellation,noiseSuppression:false,autoGainControl:false,voiceIsolation:false,googEchoCancellation:echoCancellation,googAutoGainControl:false,googNoiseSuppression:false,googHighpassFilter:false,googTypingNoiseDetection:false,googAudioMirroring:false};if(inputDeviceId&&inputDeviceId!=='default')audio.deviceId={exact:inputDeviceId};return {audio,video:false}}
function screenShareOutputElements(){const elements=[remoteScreen,nativeRemoteAudio];for(const state of serverPeers.values())elements.push(state.screen,state.screenAudio);return[...new Set(elements.filter(Boolean))]}
function mediaOutputElements(){const elements=[remoteAudio,...screenShareOutputElements()];for(const state of serverPeers.values())elements.push(...(state.audios||[]));return[...new Set(elements.filter(Boolean))]}
async function applyMediaElementOutput(element,sinkId=outputDeviceId||'default'){if(!element||typeof element.setSinkId!=='function')return false;await element.setSinkId(sinkId);return true}
async function applyOutputDevice(){const sinkId=outputDeviceId||'default',tasks=[];if(audioCtx&&typeof audioCtx.setSinkId==='function')tasks.push(audioCtx.setSinkId(sinkId));for(const element of mediaOutputElements())if(typeof element.setSinkId==='function')tasks.push(element.setSinkId(sinkId));if(!tasks.length){deviceHint.textContent='Speaker selection is not supported on this system.';return}const results=await Promise.allSettled(tasks),failed=results.filter(result=>result.status==='rejected').length;if(failed===results.length)deviceHint.textContent='Could not use that speaker. Try the system default.';else if(failed)deviceHint.textContent='Speaker selection applied to available audio routes.';else deviceHint.textContent='Speaker selection applied.'}
function stopMicrophoneTest(){try{micTestSource?.disconnect()}catch{}try{micTestGain?.disconnect()}catch{}if(micTestStream)micTestStream.getTracks().forEach(track=>track.stop());micTestStream=micTestSource=micTestGain=null;testMicrophone.textContent='Test microphone'}
async function toggleMicrophoneTest(){if(micTestStream){stopMicrophoneTest();deviceHint.textContent='Microphone test stopped.';return}if(localStream){deviceHint.textContent='End the call before testing the microphone.';return}try{const ctx=sfxCtx();if(!ctx)throw new Error('Audio output unavailable');await ctx.resume();micTestStream=await navigator.mediaDevices.getUserMedia(microphoneConstraints({echoCancellation:false}));micTestSource=ctx.createMediaStreamSource(micTestStream);micTestGain=ctx.createGain();micTestGain.gain.value=1;micTestSource.connect(micTestGain).connect(ctx.destination);testMicrophone.textContent='Stop microphone test';deviceHint.textContent='Raw microphone monitor live — echo cancellation is tested during paired calls only.';await refreshAudioDevices()}catch{stopMicrophoneTest();deviceHint.textContent='Could not start the microphone test. Check the selected device and permission.'}}
function formatPushToTalkKey(code){return ({Space:'Space',Escape:'Esc',ControlLeft:'Left Ctrl',ControlRight:'Right Ctrl',AltLeft:'Left Alt',AltRight:'Right Alt',ShiftLeft:'Left Shift',ShiftRight:'Right Shift',MetaLeft:'Left Super',MetaRight:'Right Super'})[code]||code.replace(/^Key/,'').replace(/^Digit/,'')}
function updatePushToTalkUI(){const enabled=voiceInputModeValue==='ptt';pushToTalkSettings.hidden=!enabled;voiceInputMode.value=voiceInputModeValue;pushToTalkKeyButton.textContent=pushToTalkCapturing?'Press a key…':formatPushToTalkKey(pushToTalkKey);pushToTalkDelayInput.value=String(pushToTalkDelay);pushToTalkDelayValue.textContent=pushToTalkDelay+' ms'}
function applyMicTransmission(){if(!localStream)return;const open=!micMuted&&(voiceInputModeValue!=='ptt'||pushToTalkHeld);localStream.getAudioTracks().forEach(track=>track.enabled=open);if(callActive&&voiceInputModeValue==='ptt'&&!micMuted){muteBtn.textContent=pushToTalkHeld?'Talking…':'Hold '+formatPushToTalkKey(pushToTalkKey);muteBtn.title='Push to talk is enabled in Settings'}}
function releasePushToTalk(){pushToTalkReleaseTimer=null;pushToTalkHeld=false;applyMicTransmission()}
voiceInputMode.onchange=()=>{voiceInputModeValue=voiceInputMode.value==='ptt'?'ptt':'voice';ssSet('voiceInputMode',voiceInputModeValue);if(voiceInputModeValue!=='ptt'){pushToTalkHeld=false;if(pushToTalkReleaseTimer){clearTimeout(pushToTalkReleaseTimer);pushToTalkReleaseTimer=null}}updatePushToTalkUI();applyMicTransmission()};pushToTalkKeyButton.onclick=()=>{pushToTalkCapturing=true;updatePushToTalkUI();deviceHint.textContent='Press the key you want to hold for push to talk.'};pushToTalkDelayInput.oninput=()=>{pushToTalkDelay=Math.max(0,Math.min(1000,Number(pushToTalkDelayInput.value)||0));ssSet('pushToTalkDelay',String(pushToTalkDelay));updatePushToTalkUI()};
window.addEventListener('keydown',event=>{if(pushToTalkCapturing){if(event.code==='Escape'){pushToTalkCapturing=false;updatePushToTalkUI();return}event.preventDefault();pushToTalkKey=event.code;pushToTalkCapturing=false;ssSet('pushToTalkKey',pushToTalkKey);updatePushToTalkUI();return}if(voiceInputModeValue!=='ptt'||event.code!==pushToTalkKey||event.repeat)return;if(/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||''))return;event.preventDefault();if(pushToTalkReleaseTimer){clearTimeout(pushToTalkReleaseTimer);pushToTalkReleaseTimer=null}pushToTalkHeld=true;applyMicTransmission()});window.addEventListener('keyup',event=>{if(voiceInputModeValue!=='ptt'||event.code!==pushToTalkKey)return;event.preventDefault();if(pushToTalkReleaseTimer)clearTimeout(pushToTalkReleaseTimer);pushToTalkReleaseTimer=setTimeout(releasePushToTalk,pushToTalkDelay)});window.addEventListener('blur',()=>{if(pushToTalkReleaseTimer){clearTimeout(pushToTalkReleaseTimer);pushToTalkReleaseTimer=null}pushToTalkHeld=false;applyMicTransmission()});
inputDevice.onchange=()=>{inputDeviceId=inputDevice.value;ssSet('inputDevice',inputDeviceId);if(micTestStream)stopMicrophoneTest()};outputDevice.onchange=()=>{outputDeviceId=outputDevice.value;ssSet('outputDevice',outputDeviceId);applyOutputDevice()};voiceProcessing.onchange=()=>{voiceProcessingEnabled=voiceProcessing.checked;ssSet('voiceProcessing',voiceProcessingEnabled?'on':'off');if(micTestStream)stopMicrophoneTest();deviceHint.textContent=voiceProcessingEnabled?'Echo cancellation enabled; noise suppression and auto-gain stay off.':'Raw stereo microphone mode enabled for the cleanest raw sound.'};$('#refreshDevices').onclick=()=>refreshAudioDevices();$('#testSound').onclick=()=>playSound('ring');testMicrophone.onclick=()=>toggleMicrophoneTest();navigator.mediaDevices?.addEventListener?.('devicechange',refreshAudioDevices);
const THEMES=new Set(['midnight','violet','forest','ember','ocean','rose','slate','solar','frost']);
function applyTheme(theme,persist=true){const selected=THEMES.has(theme)?theme:'midnight';document.documentElement.dataset.theme=selected;document.querySelectorAll('.theme-option').forEach(button=>{const active=button.dataset.theme===selected;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active))});if(persist)ssSet('theme',selected)}
function syncPanelBackdrop(){panelBackdrop.hidden=!!settingsPanel.hidden&&!connectCard.open}
function closePanels(){if(micTestStream)stopMicrophoneTest();connectCard.open=false;settingsPanel.hidden=true;document.body.classList.remove('settings-open');syncPanelBackdrop()}
$('#addFriend').onclick=()=>{settingsPanel.hidden=true;document.body.classList.remove('settings-open');connectCard.open=true;syncPanelBackdrop();setTimeout(()=>signalIn.focus(),0)};
connectCard.addEventListener('toggle',syncPanelBackdrop);panelBackdrop.onclick=closePanels;
document.querySelectorAll('.theme-option').forEach(button=>button.onclick=()=>applyTheme(button.dataset.theme));
(async()=>{applyTheme(await ss('theme'),false)})();
reduceMotion.onchange=()=>{document.documentElement.dataset.reduceMotion=String(reduceMotion.checked);ssSet('reduceMotion',reduceMotion.checked?'on':'off')};soundEffects.onchange=()=>{soundEnabled=soundEffects.checked;ssSet('soundEffects',soundEnabled?'on':'off')};shareProfile.onchange=()=>{profileSharing=shareProfile.checked;ssSet('shareProfile',profileSharing?'on':'off');announceProfile();directoryProfilePush()};rememberInvite.onchange=()=>{rememberInviteCode=rememberInvite.checked;ssSet('rememberInvite',rememberInviteCode?'on':'off');if(!rememberInviteCode)ssSet('savedInviteCode',null)};$('#clearSavedInvite').onclick=()=>{signalIn.value='';ssSet('savedInviteCode',null);pairHint.textContent='Saved pairing code cleared from this device.'};hardwareAcceleration.onchange=()=>{const enabled=hardwareAcceleration.checked;ssSet('hardwareAcceleration',enabled?'on':'off');hardwareHint.textContent='Restart Knot to '+(enabled?'enable':'disable')+' hardware acceleration.'};$('#restartPair').onclick=()=>{if(window.pairEnv?.relaunch)window.pairEnv.relaunch();else hardwareHint.textContent='Close and reopen Knot to apply this setting.'};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&(!settingsPanel.hidden||connectCard.open))closePanels()});
function validProfileData(data){return typeof data==='string'&&data.length<=MAX_PROFILE_DATA&&/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(data)}
function setAvatar(el,data){if(!el)return;const safe=validProfileData(data)?data:'';el.classList.toggle('has-image',!!safe);el.style.backgroundImage=safe?'url("'+safe.replace(/"/g,'%22')+'")':'';}
function normalizeFrame(frame){return {zoom:Math.max(40,Math.min(180,Number(frame?.zoom)||100)),x:Math.max(0,Math.min(100,Number(frame?.x??50))),y:Math.max(0,Math.min(100,Number(frame?.y??50)))}}
function validProfileIdentity(value){return typeof value==='string'&&/^[a-z0-9]{12,32}$/i.test(value)}
function normalizeProfileName(value,fallback){if(typeof value!=='string')return fallback;const name=value.replace(/[\u0000-\u001f\u007f]/g,'').replace(/\s+/g,' ').trim().slice(0,32);return name||fallback}
function renderParticipantNames(){const callFriend=dmCallPeerId?directoryUser(dmCallPeerId):null;yourNameEl.textContent=profileName;friendNameEl.textContent=callFriend?.name||friendName;if(roomTitle&&!activeServerId)roomTitle.textContent=friendName&&friendName!=='Friend'?friendName:'Private room';displayNameInput.value=profileName;const side=$('#sidebarProfileName');if(side)side.textContent=profileName;const sideLetter=$('#sidebarProfileAvatar .avatar-letter');if(sideLetter)sideLetter.textContent=profileName.slice(0,1).toUpperCase()||'Y'}
function updateProfileName(value,{persist=true,share=true}={}){profileName=normalizeProfileName(value,'You');renderParticipantNames();if(persist)ssSet('profileName',profileName);if(share)announceProfile();directoryProfilePush()}
function handleProfileNameMessage(event){try{if(typeof event.data!=='string')return;const message=JSON.parse(event.data);if(message?.t!=='profile-name')return;const name=normalizeProfileName(message.v,'Friend'),friend=directoryUser(dmPeerId);if(friend)friend.name=name;if(activePeerId===dmPeerId){friendName=name;renderParticipantNames()}renderCallPeerProfile()}catch{}}
function makeProfileIdentity(){const bytes=crypto.getRandomValues(new Uint8Array(9));return [...bytes].map(v=>v.toString(36).padStart(2,'0')).join('')}
function avatarHue(identity){let hash=0;for(const ch of identity)hash=(hash*31+ch.charCodeAt(0))>>>0;return hash%360}
function setAvatarIdentity(el,identity){if(!el)return;const safe=validProfileIdentity(identity)?identity:'';if(safe)el.style.setProperty('--avatar-hue',String(avatarHue(safe)));else el.style.removeProperty('--avatar-hue');}
function setAvatarFrame(el,frame){if(!el)return;const f=normalizeFrame(frame);el.style.backgroundSize=f.zoom+'% auto';el.style.backgroundPositionX=f.x+'%';el.style.backgroundPositionY=f.y+'%';}
function renderProfile(){[profileBtn,settingsAvatar,$('#sidebarProfileAvatar')].forEach(el=>{setAvatar(el,profileAvatar);setAvatarFrame(el,profileFrame);setAvatarIdentity(el,profileIdentity)});renderParticipantNames();const hasPhoto=!!profileAvatar;profileAdjust.hidden=!hasPhoto;settingsAdjustPhoto.hidden=!hasPhoto;settingsRemovePhoto.hidden=!hasPhoto;directoryProfilePush()}
function announceProfile(){if(profileIdentity){send({t:'profile',v:{image:profileSharing?profileAvatar:'',frame:profileFrame,identity:profileIdentity}});send({t:'profile-name',v:profileSharing?profileName:'Friend'})}}
async function readProfileData(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=()=>reject(new Error('Could not read image'));r.readAsDataURL(blob)})}
async function resizeProfile(file){if(file.type==='image/gif'){if(file.size>5*1024*1024)throw new Error('Choose a GIF smaller than 5 MB');const data=await readProfileData(file);if(!validProfileData(data))throw new Error('Choose a valid GIF smaller than 5 MB');return data}const bitmap=await createImageBitmap(file);const size=480,scale=Math.min(size/bitmap.width,size/bitmap.height,1);const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close?.();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.72));if(!blob)throw new Error('Could not read image');const data=await readProfileData(blob);if(!validProfileData(data))throw new Error('Choose a smaller image');return data;}
function updateProfileFrame(sendUpdate=false){profileFrame=normalizeFrame({zoom:profileZoom.value,x:profileX.value,y:profileY.value});renderProfile();ssSet('profileFrame',JSON.stringify(profileFrame));if(sendUpdate)announceProfile()}
function openSettings(showPhotoEditor=false){connectCard.open=false;settingsPanel.hidden=false;document.body.classList.add('settings-open');syncPanelBackdrop();if(showPhotoEditor){openSettingsTab('profile');profileEditor.hidden=false}}
$('#openSettings').onclick=()=>openSettings();$('#closeSettings').onclick=closePanels;
profileBtn.onclick=()=>openSettings(true);profileAdjust.onclick=()=>openSettings(true);settingsChangePhoto.onclick=()=>profileInput.click();settingsAdjustPhoto.onclick=()=>{profileEditor.hidden=!profileEditor.hidden};settingsRemovePhoto.onclick=async()=>{profileAvatar='';renderProfile();profileEditor.hidden=true;await ssSet('profileAvatar',null);await ssSet('profilePhotoMode','none');announceProfile()};profileDone.onclick=()=>{profileEditor.hidden=true;updateProfileFrame(true)};[profileZoom,profileX,profileY].forEach(input=>input.oninput=()=>updateProfileFrame(false));[profileZoom,profileX,profileY].forEach(input=>input.onchange=()=>updateProfileFrame(true));profileInput.onchange=async()=>{const file=profileInput.files?.[0];profileInput.value='';if(!file)return;try{profileAvatar=await resizeProfile(file);renderProfile();await ssSet('profileAvatar',profileAvatar);await ssSet('profilePhotoMode','custom');announceProfile()}catch(e){alert(e.message||'Could not set profile photo')}};
(async()=>{updateProfileName(await ss('profileName'),{persist:false,share:false})})();displayNameInput.onchange=()=>updateProfileName(displayNameInput.value);
(async()=>{inputDeviceId=(await ss('inputDevice'))||'default';outputDeviceId=(await ss('outputDevice'))||'default';voiceProcessingEnabled=(await ss('voiceProcessing'))==='on';voiceInputModeValue=(await ss('voiceInputMode'))==='ptt'?'ptt':'voice';const savedPttKey=await ss('pushToTalkKey');pushToTalkKey=typeof savedPttKey==='string'&&savedPttKey.length<32?savedPttKey:'Space';const savedPttDelay=Number(await ss('pushToTalkDelay'));pushToTalkDelay=Number.isFinite(savedPttDelay)?Math.max(0,Math.min(1000,savedPttDelay)):0;soundEnabled=(await ss('soundEffects'))!=='off';profileSharing=(await ss('shareProfile'))!=='off';rememberInviteCode=(await ss('rememberInvite'))!=='off';const motion=(await ss('reduceMotion'))==='on';const hardware=(await ss('hardwareAcceleration'))!=='off';if(!rememberInviteCode){signalIn.value='';ssSet('savedInviteCode',null)}voiceProcessing.checked=voiceProcessingEnabled;updatePushToTalkUI();soundEffects.checked=soundEnabled;shareProfile.checked=profileSharing;rememberInvite.checked=rememberInviteCode;reduceMotion.checked=motion;hardwareAcceleration.checked=hardware;document.documentElement.dataset.reduceMotion=String(motion);hardwareHint.textContent='Hardware acceleration is '+(hardware?'enabled':'disabled')+' for the next start.';await refreshAudioDevices();await applyOutputDevice()})();signalIn.addEventListener('input',()=>{if(!rememberInviteCode)ssSet('savedInviteCode',null)});
(async()=>{const savedRoom=await ss('roomCode');const savedInvite=await ss('savedInviteCode');if(/^\d{5}$/.test(savedRoom||''))$('#roomCode').value=savedRoom;if(typeof savedInvite==='string'&&savedInvite.length<=MAX_SIGNAL_SIZE)signalIn.value=savedInvite;$('#roomCode').addEventListener('input',()=>{const code=$('#roomCode').value.replace(/\D/g,'').slice(0,5);$('#roomCode').value=code;ssSet('roomCode',code)});signalIn.addEventListener('input',()=>ssSet('savedInviteCode',signalIn.value.trim()));const savedVol=await ss('volume');if(savedVol!==null){const v=parseFloat(savedVol);if(v>=0&&v<=1)setCallVolume(Math.round(v*100),false)}const savedFrame=await ss('profileFrame');try{if(savedFrame)profileFrame=normalizeFrame(JSON.parse(savedFrame))}catch{};profileZoom.value=profileFrame.zoom;profileX.value=profileFrame.x;profileY.value=profileFrame.y;const savedAvatar=await ss('profileAvatar');if(validProfileData(savedAvatar)){profileAvatar=savedAvatar;renderProfile();announceProfile()}})();
// Every installation gets a stable generated look until the owner chooses a
// photo. The compact identity is only used to derive the avatar color.
(async()=>{const savedIdentity=await ss('profileIdentity');profileIdentity=validProfileIdentity(savedIdentity)?savedIdentity:makeProfileIdentity();renderProfile();if(profileIdentity!==savedIdentity)ssSet('profileIdentity',profileIdentity)})();
// On a fresh install, use the person's OS account picture when it is available.
// This remains local until they pair, and choosing a photo in Knot still wins.
(async()=>{if(!window.pairEnv?.getSystemAvatar)return;await new Promise(resolve=>setTimeout(resolve,0));if(profileAvatar||await ss('profilePhotoMode')==='none')return;try{const avatar=await window.pairEnv.getSystemAvatar();if(profileAvatar||!validProfileData(avatar))return;profileAvatar=avatar;renderProfile();await ssSet('profileAvatar',profileAvatar);await ssSet('profilePhotoMode','system');announceProfile()}catch{}})();
// Auto-update pulls latest.json directly from GitHub (configured in updater.js),
  // independent of the signaling server. No action needed here.

let signaling;
const PAIR_SIGNAL_SERVER='wss://pair.pair-private-link.workers.dev';
function secureSignalAddress(address){try{const u=new URL(address);const loopback=['localhost','127.0.0.1','[::1]','::1'].includes(u.hostname);return u.protocol==='wss:'||(u.protocol==='ws:'&&loopback)?u.href:null}catch{return null}}
function roomSignalAddress(address,room){const safe=secureSignalAddress(address);if(!safe)return null;const u=new URL(safe);u.searchParams.set('room',String(room).trim().toUpperCase());return u.href}
function makeInviteCode(){const range=90000,limit=Math.floor(0x100000000/range)*range,words=new Uint32Array(1);do{crypto.getRandomValues(words)}while(words[0]>=limit);return String(10000+(words[0]%range))}

// --- Friends, presence and servers ------------------------------------------
// Cloudflare is a control plane only. This socket carries identity metadata,
// presence and WebRTC setup envelopes; messages/media/files never use it.
function clientHex(bytes){const value=crypto.getRandomValues(new Uint8Array(bytes));return [...value].map(byte=>byte.toString(16).padStart(2,'0')).join('')}
function directoryAddress(){const u=new URL(PAIR_SIGNAL_SERVER);u.pathname='/directory';u.search='';return u.href}
function directorySend(value){if(directorySocket?.readyState!==WebSocket.OPEN)return false;try{directorySocket.send(JSON.stringify(value));return true}catch{return false}}
function directoryUser(id){return directorySnapshot.friends.find(friend=>friend.id===id)||directorySnapshot.members?.[id]||null}
async function derivePersistentDmKey(local,remote){const bits=await crypto.subtle.deriveBits({name:'ECDH',public:await importPub(remote)},local.privateKey,256);return crypto.subtle.importKey('raw',bits,{name:'AES-GCM'},false,['encrypt','decrypt'])}
async function sealWithKey(key,value){const iv=crypto.getRandomValues(new Uint8Array(12)),data=typeof value==='string'?enc.encode(value):value,ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,data);return{iv:[...iv],data:[...new Uint8Array(ct)]}}
async function openWithKey(key,value){return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(value.iv)},key,new Uint8Array(value.data)))}
function persistentDmReady(id){const state=persistentDmPeers.get(id);return !!(state?.key&&state.channel?.readyState==='open'&&state.pc.connectionState==='connected')}
function syncActiveDmTransport(){
  if(activeServerId||!activePeerId)return;
  const friend=directoryUser(activePeerId),ready=persistentDmReady(activePeerId),mediaReady=!!(pc&&dmPeerId===activePeerId&&pc.connectionState==='connected'),inBackgroundCall=dmCallOngoing()&&dmCallPeerId!==activePeerId;
  messageInput.disabled=!ready;messageForm.querySelector('.send').disabled=!ready;fileInput.disabled=!(mediaReady&&files?.readyState==='open');
  if(callActive||friendInCall)callBtn.disabled=false;else callBtn.disabled=!friend?.online;
  $('.connection').classList.toggle('connected',ready);
  statusText.textContent=ready?(inBackgroundCall?'Connected · call continues in background':'Connected directly'):friend?.online?'Connecting directly…':'Offline';
}
function closePersistentDmPeer(peerId,{retry=false}={}){
  const state=persistentDmPeers.get(peerId);if(!state)return;state.closing=true;persistentDmPeers.delete(peerId);
  try{state.channel?.close()}catch{}try{state.pc.close()}catch{};
  if(activePeerId===peerId){syncActiveDmTransport();renderFriends()}
  if(retry&&directoryUser(peerId)?.online)setTimeout(()=>ensurePersistentDmPeer(peerId).catch(()=>{}),900);
}
function receivePersistentDmMessage(peerId,message){receiveDirectMessage(message,peerId)}
function wirePersistentDmChannel(peerId,state,channel){
  state.channel=channel;
  channel.onopen=()=>{state.connected=true;syncActiveDmTransport();renderFriends()};
  channel.onclose=()=>{state.connected=false;syncActiveDmTransport();renderFriends()};
  channel.onerror=()=>{state.connected=false;syncActiveDmTransport()};
  channel.onmessage=async event=>{try{if(typeof event.data!=='string'||event.data.length>MAX_MESSAGE_SIZE*3||!state.key)return;const value=JSON.parse(event.data);if(value.t!=='dm-msg'||!isEncryptedMessage(value.v))return;receivePersistentDmMessage(peerId,readChatPayload(dec.decode(await openWithKey(state.key,value.v))))}catch(error){console.warn('persistent DM message',error)}};
}
async function ensurePersistentDmPeer(peerId,{initiate=directoryUserId<peerId}={}){
  if(!peerId||peerId===directoryUserId||!directoryUser(peerId)?.online)return null;
  const existing=persistentDmPeers.get(peerId);if(existing)return existing;
  const connection=new RTCPeerConnection({iceServers:ICE_SERVERS}),state={pc:connection,channel:null,key:null,keyPair:null,candidates:[],closing:false,offerStarted:false};persistentDmPeers.set(peerId,state);
  connection.onicecandidate=event=>{if(event.candidate)directorySend({type:'signal',peerId,context:{type:'dm-persistent'},payload:{kind:'candidate',candidate:event.candidate.toJSON()}})};
  connection.ondatachannel=event=>wirePersistentDmChannel(peerId,state,event.channel);
  connection.onconnectionstatechange=()=>{if(state.closing)return;if(['failed','closed'].includes(connection.connectionState))closePersistentDmPeer(peerId,{retry:true});else if(activePeerId===peerId)syncActiveDmTransport()};
  if(initiate){
    state.offerStarted=true;state.keyPair=await keyPair();const channel=connection.createDataChannel('knot-dm',{ordered:true});wirePersistentDmChannel(peerId,state,channel);
    const offer=await connection.createOffer();await connection.setLocalDescription(offer);directorySend({type:'signal',peerId,context:{type:'dm-persistent'},payload:{kind:'offer',sdp:connection.localDescription.sdp,pub:await exportPub(state.keyPair.publicKey)}});
  }
  return state;
}
async function handlePersistentDmSignal(message){
  const peerId=message.from,payload=message.payload||{};if(!directoryUser(peerId))return;
  const state=await ensurePersistentDmPeer(peerId,{initiate:false});if(!state)return;const connection=state.pc;
  if(payload.kind==='offer'&&typeof payload.sdp==='string'&&payload.pub){
    state.keyPair=await keyPair();await connection.setRemoteDescription({type:'offer',sdp:payload.sdp});state.key=await derivePersistentDmKey(state.keyPair,payload.pub);const answer=await connection.createAnswer();await connection.setLocalDescription(answer);directorySend({type:'signal',peerId,context:{type:'dm-persistent'},payload:{kind:'answer',sdp:connection.localDescription.sdp,pub:await exportPub(state.keyPair.publicKey)}});for(const candidate of state.candidates.splice(0))await connection.addIceCandidate(candidate);
  }else if(payload.kind==='answer'&&typeof payload.sdp==='string'&&payload.pub&&state.keyPair){
    await connection.setRemoteDescription({type:'answer',sdp:payload.sdp});state.key=await derivePersistentDmKey(state.keyPair,payload.pub);for(const candidate of state.candidates.splice(0))await connection.addIceCandidate(candidate);
  }else if(payload.kind==='candidate'&&payload.candidate){if(connection.remoteDescription)await connection.addIceCandidate(payload.candidate);else state.candidates.push(payload.candidate)}
}
function syncPersistentDmPeers(){
  const online=new Set((directorySnapshot.friends||[]).filter(friend=>friend.online).map(friend=>friend.id));
  for(const peerId of persistentDmPeers.keys())if(!online.has(peerId))closePersistentDmPeer(peerId);
  for(const peerId of online)ensurePersistentDmPeer(peerId).catch(error=>console.warn('persistent DM connect',peerId,error));
  syncActiveDmTransport();renderFriends();
}
async function sendPersistentDm(peerId,text,gif){
  const state=persistentDmPeers.get(peerId);if(!state?.key||state.channel?.readyState!=='open')throw new Error('Direct message connection is not ready');
  const payload=chatPayload(text,gif);if(enc.encode(payload).byteLength>MAX_MESSAGE_SIZE)throw new Error('Messages are limited to 64 KB');state.channel.send(JSON.stringify({t:'dm-msg',v:await sealWithKey(state.key,payload)}));addMessage(text,true,gif);messageInput.value='';setPendingGif(null);if(gif?.analytics)analyticsShared(gif.analytics);
}
messageForm.addEventListener('submit',async event=>{
  if(activeServerId||!activePeerId)return;event.preventDefault();event.stopImmediatePropagation();const text=convertEmoticons(messageInput.value.trim()),gif=pendingGif;if(!text&&!gif)return;
  try{await sendPersistentDm(activePeerId,text,gif)}catch(error){pairHint.textContent=error?.message||'Direct message connection is not ready'}
},true);
let directoryAvatarSource='',directoryAvatarCache='',directoryProfileTimer=null,directoryProfileGeneration=0;
async function directoryAvatar(){
  const source=profileSharing&&validProfileData(profileAvatar)?profileAvatar:'';
  if(!source)return '';
  if(source.length<=480*1024)return source;
  if(source===directoryAvatarSource)return directoryAvatarCache;
  const image=await new Promise((resolve,reject)=>{const value=new Image();value.onload=()=>resolve(value);value.onerror=()=>reject(new Error('Could not prepare profile image'));value.src=source});
  const scale=Math.min(256/image.naturalWidth,256/image.naturalHeight,1),canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.76)),data=blob?await readProfileData(blob):'';
  directoryAvatarSource=source;directoryAvatarCache=validProfileData(data)&&data.length<=480*1024?data:'';return directoryAvatarCache;
}
async function directoryProfile(){return {name:profileName,image:await directoryAvatar(),frame:normalizeFrame(profileFrame)}}
directoryProfilePush=()=>{const generation=++directoryProfileGeneration;clearTimeout(directoryProfileTimer);directoryProfileTimer=setTimeout(async()=>{try{const profile=await directoryProfile();if(generation===directoryProfileGeneration)directorySend({type:'update-profile',...profile})}catch(error){console.warn('directory profile',error)}},100)};
function setDirectoryState(online,text){$('#directoryPresence')?.classList.toggle('online',online);if($('#directoryStatus'))$('#directoryStatus').textContent=text;}
function scheduleHistorySave(){clearTimeout(historySaveTimer);historySaveTimer=setTimeout(()=>ssSet('messageHistory',JSON.stringify(conversationHistories)),180)}
function storeConversationEntry(key,entry){if(!key||!entry||typeof entry.text!=='string')return;const list=conversationHistories[key]||(conversationHistories[key]=[]);list.push(entry);if(list.length>500)list.splice(0,list.length-500);scheduleHistorySave()}
recordConversationMessage=entry=>{if(historyRendering||!activeConversationKey)return;storeConversationEntry(activeConversationKey,entry)};
function openConversation(key){activeConversationKey=key;historyRendering=true;messages.replaceChildren();const list=conversationHistories[key]||[];for(const item of list){const current=item.author?.id?directoryUser(item.author.id):null;addMessage(item.text,!!item.mine,item.gif,item.author?{...item.author,...current,time:item.time}:{time:item.time})}historyRendering=false;if(!list.length){const empty=document.createElement('div');empty.className='empty';empty.innerHTML='<span>✦</span><p>Messages stay on your devices and travel directly to online peers.</p>';messages.append(empty)}}
function applyFriendProfile(friend){if(!friend)return;friendName=normalizeProfileName(friend.name,'Friend');setAvatar(friendAvatar,friend.image||'');setAvatarFrame(friendAvatar,friend.frame);setAvatarIdentity(friendAvatar,friend.id);renderParticipantNames();roomTitle.textContent=friendName;$('#chatTitle').textContent=friendName;$('#roomContextLabel').textContent='DIRECT MESSAGE';$('#chatModePill').textContent='DIRECT';messageInput.placeholder='Message '+friendName;}
function renderCallPeerProfile(){const friend=directoryUser(dmCallPeerId);if(!friend)return;friendNameEl.textContent=normalizeProfileName(friend.name,'Friend');setAvatar(friendAvatar,friend.image||'');setAvatarFrame(friendAvatar,friend.frame);setAvatarIdentity(friendAvatar,friend.id);renderDmVoiceUI();refreshSpeakingPaint()}
function setSocialSidebarCollapsed(collapsed,persist=true){document.body.classList.toggle('social-sidebar-collapsed',!!collapsed);const toggle=$('#sidebarToggle');if(toggle){toggle.textContent=collapsed?'›':'‹';toggle.setAttribute('aria-expanded',String(!collapsed));toggle.setAttribute('aria-label',(collapsed?'Open':'Collapse')+' friends and channels panel');toggle.title=(collapsed?'Open':'Collapse')+' panel'}if(persist)ssSet('socialSidebarCollapsed',collapsed?'on':'off')}
function sidebarWidthLimit(){const rail=window.innerWidth<=670?56:window.innerWidth<=900?60:72;return Math.max(190,Math.min(420,window.innerWidth-rail-360))}
function setSocialSidebarWidth(value,persist=true){socialSidebarWidth=Math.max(190,Math.min(sidebarWidthLimit(),Number(value)||280));$('.app-shell')?.style.setProperty('--social-sidebar-width',socialSidebarWidth+'px');if(persist)ssSet('socialSidebarWidth',String(Math.round(socialSidebarWidth)))}
async function installSidebarLayout(){const toggle=$('#sidebarToggle'),handle=$('#sidebarResize');setSocialSidebarWidth(Number(await ss('socialSidebarWidth'))||280,false);setSocialSidebarCollapsed((await ss('socialSidebarCollapsed'))==='on',false);toggle.onclick=()=>setSocialSidebarCollapsed(!document.body.classList.contains('social-sidebar-collapsed'));let startX=0,startWidth=0;handle.addEventListener('pointerdown',event=>{if(document.body.classList.contains('social-sidebar-collapsed'))return;startX=event.clientX;startWidth=socialSidebarWidth;handle.setPointerCapture(event.pointerId);document.body.classList.add('sidebar-resizing')});handle.addEventListener('pointermove',event=>{if(!handle.hasPointerCapture(event.pointerId))return;setSocialSidebarWidth(startWidth+event.clientX-startX,false)});const finish=event=>{if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);if(document.body.classList.contains('sidebar-resizing')){document.body.classList.remove('sidebar-resizing');setSocialSidebarWidth(socialSidebarWidth)}};handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('dblclick',()=>setSocialSidebarWidth(280));handle.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home'].includes(event.key))return;event.preventDefault();setSocialSidebarWidth(event.key==='Home'?280:socialSidebarWidth+(event.key==='ArrowLeft'?-16:16))});window.addEventListener('resize',()=>setSocialSidebarWidth(socialSidebarWidth,false))}
function showFriendsLanding(){roomTitle.textContent='Friends';$('#chatTitle').textContent='Friends';$('#roomContextLabel').textContent='DIRECT MESSAGES';$('#chatModePill').textContent='DIRECT';messageInput.placeholder='Select a direct message';activeConversationKey='';messages.replaceChildren();const empty=document.createElement('div');empty.className='empty';empty.innerHTML='<span>✦</span><p>Choose a friend from Direct Messages, or add someone with the + button.</p>';messages.append(empty);setStatus('Select a direct message')}
function dmCallOngoing(){return !!dmCallPeerId&&(callActive||friendInCall||screenActive||remoteScreenExpected)}
function showFriends({expand=true}={}){if(expand)setSocialSidebarCollapsed(false);activeServerId='';activeChannelId='';if(!dmCallOngoing()&&!serverVoiceStream){renderCallButtonState('start','Start call','Start voice call');callStatus.textContent='Voice off';callStatus.className='call-status'}$('#friendsNavigation').hidden=false;$('#serverNavigation').hidden=true;$('#serverMemberPanel').hidden=true;document.body.classList.remove('server-view');document.querySelectorAll('#serverList .rail-button').forEach(button=>button.classList.remove('active'));$('#homeButton').classList.add('active');
  // Navigation must never be a disconnect button.  Keep the encrypted server
  // mesh alive while its view is hidden, just as a direct call stays alive in
  // the background.  Explicit Leave/room removal still calls closeServerMesh.
  if(serverVoiceStream){$('#serverVoiceStage').hidden=true;renderServerVoiceUI()}if(!activePeerId)showFriendsLanding();renderDmVoiceUI()}
async function selectFriend(id,{connect=true}={}){
  const friend=directoryUser(id);if(!friend)return;const backgroundCall=dmCallOngoing()&&dmCallPeerId&&id!==dmCallPeerId;
  showFriends();activePeerId=id;applyFriendProfile(friend);openConversation('dm:'+id);renderFriends();syncActiveDmTransport();
  if(backgroundCall){pairHint.textContent='Your call with '+(directoryUser(dmCallPeerId)?.name||'your friend')+' stays connected while you use this DM.';renderCallPeerProfile();return}
  if(pc&&dmPeerId===id){renderCallPeerProfile();return}
  if(pc&&!dmCallOngoing())disconnectRoom();
  if(connect&&friend.online){const session=clientHex(16);directorySend({type:'connect',peerId:id,session,context:{type:'dm'}});await automaticPair('host',session,id);if(activePeerId===id)applyFriendProfile(friend);renderCallPeerProfile()}
  else if(!friend.online)pairHint.textContent=friendName+' is offline. Knot will reconnect this DM as soon as they open the app.';
  syncActiveDmTransport();
}
function paintDirectoryAvatar(avatar,user){setAvatar(avatar,user?.image||'');setAvatarFrame(avatar,user?.frame);setAvatarIdentity(avatar,user?.id||'');if(!validProfileData(user?.image))avatar.textContent=(user?.name||'?').slice(0,1).toUpperCase()}
function renderFriends(){
  const list=$('#friendList');if(!list)return;const query=($('#friendSearch')?.value||'').trim().toLocaleLowerCase(),friends=(directorySnapshot.friends||[]).filter(friend=>!query||(friend.name||'Knot user').toLocaleLowerCase().includes(query));list.replaceChildren();
  for(const friend of friends){
    const inCall=friend.id===dmCallPeerId&&dmCallOngoing(),ready=persistentDmReady(friend.id),button=document.createElement('button');button.type='button';button.className='friend-entry'+(friend.id===activePeerId&&!activeServerId?' active':'')+(inCall?' in-call':'');button.dataset.id=friend.id;button.setAttribute('aria-label',(friend.name||'Knot user')+', '+(inCall?'in voice':ready?'connected':friend.online?'online':'offline'));
    const avatar=document.createElement('span');avatar.className='friend-avatar';paintDirectoryAvatar(avatar,friend);const dot=document.createElement('i');dot.classList.toggle('online',!!friend.online);avatar.append(dot);if(inCall)avatar.dataset.speakingId='dm-friend';
    const copy=document.createElement('span');copy.className='friend-copy';const name=document.createElement('strong');name.textContent=friend.name||'Knot user';const status=document.createElement('small');status.textContent=inCall?'In voice':ready?'Connected':friend.online?'Connecting…':'Offline';copy.append(name,status);button.append(avatar,copy);button.onclick=()=>selectFriend(friend.id);list.append(button)
  }
  if(!list.children.length){const empty=document.createElement('p');empty.className='social-empty';empty.textContent=query?'No direct messages match your search.':'Create a five-digit friend code to add someone.';list.append(empty)}refreshSpeakingPaint();
}
function serverInitial(server){return cleanClientName(server?.name,'S').slice(0,2).toUpperCase()}
function cleanClientName(value,fallback=''){return String(value||'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,48)||fallback}
function renderServers(){const list=$('#serverList');if(!list)return;list.replaceChildren();for(const server of directorySnapshot.servers||[]){const button=document.createElement('button');button.type='button';button.className='rail-button'+(server.id===activeServerId?' active':'');button.title=server.name;button.setAttribute('aria-label',server.name);button.textContent=serverInitial(server);if(validProfileData(server.picture)){button.style.backgroundImage='url("'+server.picture.replace(/"/g,'%22')+'")';button.textContent=''}button.onclick=()=>selectServer(server.id);list.append(button)}}
function activeServer(){return directorySnapshot.servers?.find(server=>server.id===activeServerId)||null}
function activeChannel(){return activeServer()?.channels?.find(channel=>channel.id===activeChannelId)||null}
function canEditServer(server=activeServer()){return !!server&&server.owner===directoryUserId}
function setServerStatus(text,connected=false){statusText.textContent=text;$('.connection').classList.toggle('connected',connected);callBtn.disabled=false;screenBtn.disabled=true}
function voiceChannelEntries(channelId){const entries=[...(directorySnapshot.voiceStates?.[channelId]||[])];if(channelId===joinedVoiceChannelId&&!entries.some(entry=>entry.id===directoryUserId))entries.push({id:directoryUserId,joinedAt:joinedVoiceAt||Date.now()});return entries}
function voiceElapsed(joinedAt){const seconds=Math.max(0,Math.floor((Date.now()-(Number(joinedAt)||Date.now()))/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),rest=seconds%60;return hours?hours+':'+String(minutes).padStart(2,'0')+':'+String(rest).padStart(2,'0'):minutes+':'+String(rest).padStart(2,'0')}
function refreshVoiceElapsed(){document.querySelectorAll('[data-voice-joined]').forEach(node=>{node.textContent=voiceElapsed(node.dataset.voiceJoined)});if(joinedVoiceChannelId){const value=voiceElapsed(joinedVoiceAt);$('#serverVoiceDockTime').textContent=value;$('#serverVoiceStageTime').textContent=value}renderDmVoiceUI()}
function scheduleVoiceElapsed(){clearInterval(voiceElapsedTimer);if(joinedVoiceChannelId||document.querySelector('[data-voice-joined]')){refreshVoiceElapsed();voiceElapsedTimer=setInterval(refreshVoiceElapsed,1000)}}
function renderVoiceParticipants(channelId,container){for(const entry of voiceChannelEntries(channelId)){const member=directorySnapshot.members?.[entry.id]||(entry.id===directoryUserId?directorySnapshot.self:null);if(!member)continue;const row=document.createElement('div');row.className='voice-channel-member';const avatar=document.createElement('span');avatar.className='friend-avatar';avatar.dataset.speakingId=entry.id;paintDirectoryAvatar(avatar,member);const name=document.createElement('span');name.textContent=(member.name||'Knot user')+(entry.id===directoryUserId?' (you)':'');const elapsed=document.createElement('time');elapsed.dataset.voiceJoined=String(entry.joinedAt||Date.now());row.append(avatar,name,elapsed);container.append(row)}refreshSpeakingPaint()}
function moveChannel(sourceId,targetId,after){const server=activeServer(),source=server?.channels.find(channel=>channel.id===sourceId),target=server?.channels.find(channel=>channel.id===targetId);if(!canEditServer(server)||!source||!target||source.type!==target.type||source.id===target.id)return;const channels=server.channels.filter(channel=>channel.id!==sourceId),targetIndex=channels.findIndex(channel=>channel.id===targetId);channels.splice(targetIndex+(after?1:0),0,source);server.channels=channels;renderChannels();directorySend({type:'reorder-channels',serverId:server.id,channelIds:channels.map(channel=>channel.id)})}
function createChannelRow(server,channel){const owner=canEditServer(server),item=document.createElement('div');item.className='channel-item'+(channel.id===activeChannelId?' active':'');item.dataset.id=channel.id;item.dataset.type=channel.type;item.draggable=owner;const button=document.createElement('button');button.type='button';button.className='channel-entry '+channel.type;button.textContent=channel.name;button.title=channel.type==='voice'?'Click to select · double-click to join':'Open #'+channel.name;button.onclick=()=>selectServerChannel(server.id,channel.id);if(channel.type==='voice')button.ondblclick=async event=>{event.preventDefault();await selectServerChannel(server.id,channel.id);await joinServerVoice()};item.append(button);if(owner){const controls=document.createElement('span');controls.className='channel-row-controls';const drag=document.createElement('span');drag.className='channel-drag';drag.textContent='⠇';drag.title='Drag to reorder';const remove=document.createElement('button');remove.type='button';remove.className='channel-remove';remove.textContent='×';remove.title='Delete channel';remove.setAttribute('aria-label','Delete '+channel.name);remove.onclick=event=>{event.stopPropagation();remove.disabled=true;directorySend({type:'delete-channel',serverId:server.id,channelId:channel.id})};controls.append(drag,remove);item.append(controls);item.ondragstart=event=>{draggedChannelId=channel.id;item.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',channel.id)};item.ondragend=()=>{draggedChannelId='';document.querySelectorAll('.channel-item').forEach(row=>row.classList.remove('dragging','drop-before','drop-after'))};item.ondragover=event=>{const source=server.channels.find(value=>value.id===draggedChannelId);if(!source||source.type!==channel.type||source.id===channel.id)return;event.preventDefault();const after=event.clientY>item.getBoundingClientRect().top+item.offsetHeight/2;item.classList.toggle('drop-before',!after);item.classList.toggle('drop-after',after)};item.ondrop=event=>{event.preventDefault();const after=item.classList.contains('drop-after');moveChannel(draggedChannelId,channel.id,after)}}if(channel.type==='voice'){const participants=document.createElement('div');participants.className='voice-channel-members';renderVoiceParticipants(channel.id,participants);item.append(participants)}return item}
function serverScreenSharing(){return !!(serverScreenStream||serverNativeScreenSession)}
function renderServerVoiceUI(){const server=activeServer(),channel=server?.channels?.find(item=>item.id===joinedVoiceChannelId),connected=!!(serverVoiceStream&&channel);const dock=$('#serverVoiceDock'),stage=$('#serverVoiceStage');dock.hidden=!connected;stage.hidden=!connected;document.body.classList.toggle('server-voice-connected',connected);if(!connected)return;$('#serverVoiceDockChannel').textContent=channel.name;$('#serverVoiceStageChannel').textContent=channel.name;const members=$('#serverVoiceStageMembers');members.replaceChildren();for(const entry of voiceChannelEntries(channel.id)){const member=directorySnapshot.members?.[entry.id]||(entry.id===directoryUserId?directorySnapshot.self:null);if(!member)continue;const card=document.createElement('div');card.className='server-stage-member';const avatar=document.createElement('span');avatar.className='server-stage-avatar';avatar.dataset.speakingId=entry.id;paintDirectoryAvatar(avatar,member);const name=document.createElement('strong');name.textContent=(member.name||'Knot user')+(entry.id===directoryUserId?' (you)':'');card.append(avatar,name);members.append(card)}const muted=serverVoiceMuted;for(const id of ['serverVoiceMute','serverStageMute']){const button=$('#'+id);button.classList.toggle('active',muted);button.setAttribute('aria-label',muted?'Unmute microphone':'Mute microphone');button.title=muted?'Unmute microphone':'Mute microphone'}const sharing=serverScreenSharing();for(const id of ['serverVoiceShare','serverStageShare']){const button=$('#'+id);button.classList.toggle('active',sharing);button.setAttribute('aria-label',sharing?'Stop screen sharing':'Share screen');button.title=sharing?'Stop screen sharing':'Share screen';button.disabled=serverScreenStarting}refreshSpeakingPaint();refreshVoiceElapsed()}
function renderDmVoiceUI(){const dock=$('#dmVoiceDock');if(!dock)return;const connected=callActive||friendInCall;dock.hidden=!connected;document.body.classList.toggle('dm-call-connected',connected);if(!connected)return;$('#dmVoiceDockName').textContent=directoryUser(dmCallPeerId)?.name||friendName||'Direct call';$('#dmVoiceDockTime').textContent=voiceElapsed(callStart||Date.now());$('#dmVoiceMute').classList.toggle('active',micMuted);$('#dmVoiceMute').disabled=!callActive;$('#dmVoiceShare').classList.toggle('active',screenActive||screenStarting);$('#dmVoiceShare').disabled=!callActive||!pc||screenSharePickerPending}
let serverFocusedShareId='';const serverSuppressedShares=new Set();
function serverShareVideo(peerId){if(peerId===directoryUserId)return serverScreenSharing()?$('#serverVoiceScreenPreview'):null;return serverPeers.get(peerId)?.screen||null}
function watchServerShare(peerId){const video=serverShareVideo(peerId);if(!video)return;serverSuppressedShares.delete(peerId);serverFocusedShareId=peerId;renderServerShareExperience()}
function stopWatchingServerShare(peerId=serverFocusedShareId){if(!peerId)return;serverSuppressedShares.add(peerId);const video=serverShareVideo(peerId);try{video?.pause()}catch{};if(serverFocusedShareId===peerId)serverFocusedShareId='';try{if(document.fullscreenElement===video)document.exitFullscreen().catch(()=>{})}catch{}renderServerShareExperience()}
function renderServerShareExperience(){
  const stage=$('#serverVoiceStage'),members=$('#serverVoiceStageMembers'),screens=$('#serverVoiceScreens');if(!stage||!members||!screens)return;
  if(serverFocusedShareId&&!serverShareVideo(serverFocusedShareId))serverFocusedShareId='';const active=serverFocusedShareId&&!serverSuppressedShares.has(serverFocusedShareId)?serverShareVideo(serverFocusedShareId):null;
  for(const video of screens.querySelectorAll('video')){const peerId=video.id==='serverVoiceScreenPreview'?directoryUserId:video.dataset.peerId||'',selected=!!active&&video===active,isLocal=peerId===directoryUserId,state=isLocal?null:serverPeers.get(peerId);video.hidden=!selected;if(isLocal)serverNativeLocalPlayer?.setActive(selected);else state?.nativeScreenPlayer?.setActive(selected);if(!isLocal)try{video.srcObject?.getTracks?.().forEach(track=>{track.enabled=selected})}catch{}video.volume=isLocal?0:remoteScreen.volume;video.muted=isLocal||!selected||video.volume===0;if(state?.screenAudio){state.screenAudio.volume=remoteScreen.volume;state.screenAudio.muted=!selected||state.screenAudio.volume===0;try{state.screenAudio.srcObject?.getTracks?.().forEach(track=>{track.enabled=selected})}catch{}if(selected&&!state.screenAudio.muted)state.screenAudio.play().catch(()=>{});else try{state.screenAudio.pause()}catch{}}if(selected)video.play().catch(()=>{});else try{video.pause()}catch{}if(!video.dataset.shareMenu){video.dataset.shareMenu='1';video.addEventListener('contextmenu',event=>showShareContextMenu(event,{label:isLocal?'Your stream':(directoryUser(peerId)?.name||'Stream'),volume:!isLocal,stopWatching:()=>stopWatchingServerShare(peerId)}));video.addEventListener('dblclick',()=>stage.requestFullscreen?.().catch(()=>video.requestFullscreen?.().catch(()=>{})))}}
  screens.hidden=!active;members.classList.toggle('watching-share',!!active);stage.classList.toggle('watching-share',!!active);document.body.classList.toggle('screen-share-active',!!active||!screenPreview.hidden||!remoteScreen.hidden);
  for(const card of members.querySelectorAll('.server-stage-member')){const avatar=card.querySelector('[data-speaking-id]'),peerId=avatar?.dataset.speakingId||'',video=serverShareVideo(peerId);card.querySelector('.server-share-badge')?.remove();card.classList.toggle('has-share',!!video);if(!video)continue;const button=document.createElement('button');button.type='button';button.className='server-share-badge';button.innerHTML='<span aria-hidden="true">▣</span><small>LIVE</small>';button.title='Watch '+(peerId===directoryUserId?'your stream':(directoryUser(peerId)?.name||'stream'));button.setAttribute('aria-label',button.title);button.onclick=()=>watchServerShare(peerId);card.prepend(button)}
}
const baseRenderServerVoiceUI=renderServerVoiceUI;renderServerVoiceUI=function(){baseRenderServerVoiceUI();if(serverVoiceStream&&joinedVoiceServerId&&activeServerId!==joinedVoiceServerId){const server=directorySnapshot.servers?.find(item=>item.id===joinedVoiceServerId),channel=server?.channels?.find(item=>item.id===joinedVoiceChannelId);if(channel){$('#serverVoiceDock').hidden=false;$('#serverVoiceStage').hidden=true;document.body.classList.add('server-voice-connected');$('#serverVoiceDockChannel').textContent=server.name+' · '+channel.name;$('#serverVoiceDockTime').textContent=voiceElapsed(joinedVoiceAt)}}renderServerShareExperience()};
function setMemberPanelCollapsed(collapsed,persist=true){document.body.classList.toggle('server-members-collapsed',!!collapsed);const button=$('#memberPanelToggle');if(button){button.setAttribute('aria-expanded',String(!collapsed));button.textContent=collapsed?'Show members':'Hide members'}if(persist)ssSet('serverMembersCollapsed',collapsed?'on':'off')}
function renderChannels(){const server=activeServer(),textList=$('#textChannelList'),voiceList=$('#voiceChannelList');if(!server||!textList||!voiceList)return;const owner=canEditServer(server);$('#serverPanelTitle').textContent=server.name;$('#editServerPicture').hidden=!owner;$('#addTextChannel').hidden=!owner;$('#addVoiceChannel').hidden=!owner;textList.replaceChildren();voiceList.replaceChildren();for(const channel of server.channels||[])(channel.type==='voice'?voiceList:textList).append(createChannelRow(server,channel));renderServerMembers();renderServerVoiceUI();scheduleVoiceElapsed()}
function renderServerMembers(){const server=activeServer(),list=$('#serverMemberList'),panel=$('#serverMemberPanel');if(!server||!list||!panel)return;const members=(server.members||[]).map(id=>directorySnapshot.members?.[id]||(id===directoryUserId?directorySnapshot.self:null)).filter(Boolean).sort((a,b)=>Number(b.online)-Number(a.online)||(a.name||'').localeCompare(b.name||''));$('#serverMemberCount').textContent=String(members.length);list.replaceChildren();for(const member of members){const button=document.createElement('button');button.type='button';button.className='friend-entry';button.disabled=member.id===directoryUserId;const avatar=document.createElement('span');avatar.className='friend-avatar';paintDirectoryAvatar(avatar,member);const dot=document.createElement('i');dot.classList.toggle('online',!!member.online);avatar.append(dot);const copy=document.createElement('span');copy.className='member-copy';const name=document.createElement('strong');name.textContent=(member.name||'Knot user')+(member.id===directoryUserId?' (you)':'');const status=document.createElement('small');status.textContent=member.online?'Online':'Offline';copy.append(name,status);button.append(avatar,copy);if(member.id!==directoryUserId)button.onclick=()=>selectFriend(member.id);list.append(button)}panel.hidden=false}
function selectServer(id){const server=directorySnapshot.servers?.find(item=>item.id===id);if(!server)return;setSocialSidebarCollapsed(false);
  // A server rail click is browsing, not an instruction to leave a direct or
  // server call.  The call dock remains the owner of those live P2P sessions.
  activePeerId='';activeServerId=id;document.body.classList.add('server-view');$('#friendsNavigation').hidden=true;$('#serverNavigation').hidden=false;$('#serverMemberPanel').hidden=false;$('#homeButton').classList.remove('active');renderServers();renderChannels();renderDmVoiceUI();const first=server.channels?.find(channel=>channel.type==='text')||server.channels?.[0];if(first)selectServerChannel(id,first.id)}
async function selectServerChannel(serverId,channelId){const server=directorySnapshot.servers?.find(item=>item.id===serverId),channel=server?.channels?.find(item=>item.id===channelId);if(!server||!channel)return;activeServerId=serverId;activeChannelId=channelId;activePeerId='';roomTitle.textContent=channel.name;$('#chatTitle').textContent=channel.name;$('#roomContextLabel').textContent=server.name.toUpperCase();$('#chatModePill').textContent=channel.type==='voice'?'VOICE':'P2P MESH';messageInput.placeholder='Message #'+channel.name;openConversation('server:'+serverId+':'+channelId);renderChannels();if(channel.type==='voice'&&!serverVoiceStream){setServerStatus('Double-click '+channel.name+' to join voice');renderCallButtonState('start','Join voice','Join voice channel')}else{setServerStatus('Connecting to online server members…');renderCallButtonState(serverVoiceStream?'end':'start',serverVoiceStream?'Leave voice':'Start call',serverVoiceStream?'Leave voice channel':'Start voice call')}syncServerMesh();messageInput.disabled=false;messageForm.querySelector('.send').disabled=false;fileInput.disabled=true}
function serverOnlineMembers(serverId=joinedVoiceServerId||activeServerId){const server=directorySnapshot.servers?.find(item=>item.id===serverId);return server?(server.members||[]).filter(id=>id!==directoryUserId&&directorySnapshot.members?.[id]?.online):[]}
function serverHistoryKey(serverId,channelId){return 'server:'+serverId+':'+channelId}
function normalizeServerHistoryEntry(raw,server,forcedAuthorId=''){if(!raw||typeof raw.text!=='string'||raw.text.length>16000)return null;const authorId=forcedAuthorId||raw.author?.id||(raw.mine?directoryUserId:'');if(!/^[a-f0-9]{32}$/.test(authorId)||!server?.members?.includes(authorId))return null;const gifUrl=typeof raw.gif?.url==='string'&&raw.gif.url.length<=4096?safePreviewUrl(raw.gif.url):null,time=Number(raw.time),id=/^[a-f0-9]{32}$/.test(raw.id||'')?raw.id:clientHex(16),member=directoryUser(authorId);return{id,text:raw.text,gif:gifUrl?{url:gifUrl,thumb:typeof raw.gif.thumb==='string'&&safePreviewUrl(raw.gif.thumb)?raw.gif.thumb:gifUrl}:null,author:{id:authorId,name:normalizeProfileName(member?.name||raw.author?.name||raw.name,'Server member'),image:'',frame:normalizeFrame(member?.frame||raw.author?.frame||raw.frame)},time:Number.isFinite(time)&&time>0&&time<Date.now()+86400000?time:Date.now(),mine:authorId===directoryUserId}}
function storeServerHistory(serverId,channelId,entries,{render=true}={}){const server=directorySnapshot.servers?.find(item=>item.id===serverId),channel=server?.channels?.find(item=>item.id===channelId);if(!server||!channel)return 0;const key=serverHistoryKey(serverId,channelId),list=conversationHistories[key]||(conversationHistories[key]=[]),ids=new Set(list.map(item=>item.id).filter(Boolean));let added=0;for(const raw of entries||[]){const entry=normalizeServerHistoryEntry(raw,server);if(!entry||ids.has(entry.id))continue;ids.add(entry.id);list.push(entry);added++}if(!added)return 0;list.sort((a,b)=>(Number(a.time)||0)-(Number(b.time)||0)||String(a.id||'').localeCompare(String(b.id||'')));if(list.length>500)list.splice(0,list.length-500);scheduleHistorySave();if(render&&activeConversationKey===key)openConversation(key);return added}
function localServerHistory(server,channel){const key=serverHistoryKey(server.id,channel.id),list=conversationHistories[key]||(conversationHistories[key]=[]);let changed=false;const normalized=[];for(const raw of list){const entry=normalizeServerHistoryEntry(raw,server);if(!entry)continue;if(!raw.id||!raw.author?.id||raw.mine!==entry.mine)changed=true;normalized.push(entry)}if(changed||normalized.length!==list.length){conversationHistories[key]=normalized.slice(-500);scheduleHistorySave()}return conversationHistories[key]}
function sendServerHistory(channel,serverId){const server=directorySnapshot.servers?.find(item=>item.id===serverId);if(!server||channel.readyState!=='open')return;for(const serverChannel of server.channels||[]){const entries=localServerHistory(server,serverChannel);let batch=[],size=0;const flush=()=>{if(!batch.length||channel.readyState!=='open')return;channel.send(JSON.stringify({t:'server-history',serverId,channelId:serverChannel.id,entries:batch}));batch=[];size=0};for(const entry of entries){const wire={id:entry.id,text:entry.text,gif:entry.gif,author:entry.author,time:entry.time},bytes=JSON.stringify(wire).length;if(batch.length&&size+bytes>32000)flush();batch.push(wire);size+=bytes}flush()}}
function wireServerChannel(peerId,channel,serverId=activeServerId){channel.onopen=()=>{setServerStatus('Connected directly to '+serverPeers.size+' server peer'+(serverPeers.size===1?'':'s'),true);channel.send(JSON.stringify({t:'server-history-request',serverId}))};channel.onmessage=event=>{try{const value=JSON.parse(event.data),server=directorySnapshot.servers?.find(item=>item.id===serverId);if(!server||!server.members?.includes(peerId)||value.serverId!==serverId)return;if(value.t==='screen-codec-fallback'){switchServerScreenCodec(peerId,serverPeers.get(peerId),compatibilityScreenCodec()).catch(()=>{});return}if(value.t==='server-history-request')return sendServerHistory(channel,serverId);if(value.t==='server-history'&&Array.isArray(value.entries)){storeServerHistory(serverId,value.channelId,value.entries);return}if(value.t!=='server-msg'||typeof value.text!=='string')return;const entry=normalizeServerHistoryEntry(value,server,peerId);if(entry)storeServerHistory(serverId,value.channelId,[entry])}catch{}}}
function voicePeerAllowed(peerId){return !!serverVoiceStream&&voiceChannelEntries(joinedVoiceChannelId).some(entry=>entry.id===peerId)}
function addServerVoiceAudio(peerId,state,track,stream){
  const audio=document.createElement('audio');audio.autoplay=true;audio.srcObject=stream;audio.hidden=true;document.body.append(audio);state.audios.push(audio);applyMediaElementOutput(audio).catch(()=>{});monitorSpeaking('server:'+peerId,stream);audio.play().catch(()=>{});track.onended=()=>{stopSpeakingMonitor('server:'+peerId);audio.remove();state.audios=state.audios.filter(item=>item!==audio)};
}
function addServerScreenVideo(peerId,state,track,stream){
  clearServerNativeScreen(state,{keepChannel:true});
  try{state.screen?.remove()}catch{}
  const video=document.createElement('video');video.autoplay=false;video.playsInline=true;video.srcObject=stream;video.dataset.peerId=peerId;video.muted=true;$('#serverVoiceScreens').append(video);state.screen=video;state.screenStreamId=stream.id;applyMediaElementOutput(video).catch(()=>{});
  const receiver=state.pc.getReceivers().find(value=>value.track===track);if(receiver)monitorRemoteScreenDecode(receiver,track,()=>{if(state.channel?.readyState!=='open')return false;state.channel.send(JSON.stringify({t:'screen-codec-fallback',serverId:state.context.serverId}));return true});
  renderServerVoiceUI();track.onended=()=>{video.pause();video.remove();if(state.screen===video){state.screen=null;state.screenStreamId=''}renderServerVoiceUI()};
}
function clearServerNativeScreen(state,{keepChannel=false}={}){
  if(!state)return;state.nativeScreenPlayer?.destroy();state.nativeScreenPlayer=null;state.nativeScreenAudioExpected=false;if(state.nativeReceiveChannel)clearNativeScreenReceiveState(state.nativeReceiveChannel);if(state.screenAudio){try{state.screenAudio.pause();state.screenAudio.srcObject=null;state.screenAudio.remove()}catch{}state.screenAudio=null}if(state.screen&&!state.screen.srcObject){try{state.screen.pause();state.screen.remove()}catch{}state.screen=null}if(!keepChannel&&state.nativeReceiveChannel){try{state.nativeReceiveChannel.onmessage=null;state.nativeReceiveChannel.close()}catch{}state.nativeReceiveChannel=null}
}
function beginServerNativeScreen(peerId,state,meta,channel){
  if(meta.serverId!==state.context.serverId)return false;clearServerNativeScreen(state,{keepChannel:true});try{state.screen?.pause();state.screen?.remove()}catch{}const video=document.createElement('video');video.autoplay=false;video.playsInline=true;video.dataset.peerId=peerId;video.muted=true;$('#serverVoiceScreens').append(video);state.screen=video;state.screenStreamId='native';state.nativeScreenAudioExpected=!!meta.audio;applyMediaElementOutput(video).catch(()=>{});
  let fallbackRequested=false;const fallback=()=>{if(fallbackRequested)return;fallbackRequested=true;try{if(channel.readyState==='open')channel.send(JSON.stringify({t:'native-screen-fallback',serverId:state.context.serverId}))}catch{}};try{state.nativeScreenPlayer=createNativeScreenPlayer(video,meta.codec||'AV1',fallback,meta)}catch(error){fallback();clearServerNativeScreen(state,{keepChannel:true});setServerStatus(error.message);return false}channel._nativeReceive=nativeScreenReceiveState(state.nativeScreenPlayer,meta,fallback);drainNativeScreenPreMeta(channel);try{channel.send(JSON.stringify({t:'native-screen-ready',serverId:state.context.serverId,transportVersion:NATIVE_SCREEN_PROTOCOL}))}catch{}renderServerVoiceUI();return true
}
function addServerNativeScreenAudio(state,track,stream){
  if(state.screenAudio){try{state.screenAudio.remove()}catch{}}const audio=document.createElement('audio');audio.autoplay=true;audio.hidden=true;audio.srcObject=stream;audio.volume=remoteScreen.volume;audio.muted=serverFocusedShareId!==stream._knotPeerId&&serverFocusedShareId!==state.screen?.dataset.peerId;document.body.append(audio);state.screenAudio=audio;state.nativeScreenAudioExpected=false;applyMediaElementOutput(audio).catch(()=>{});track.onended=()=>{if(state.screenAudio===audio){audio.remove();state.screenAudio=null}};renderServerShareExperience()
}
function wireServerNativeScreenChannel(peerId,state,channel,{remote=false}={}){
  channel.binaryType='arraybuffer';if(remote){state.nativeReceiveChannel=channel;channel._nativePreMeta=[];channel.onmessage=event=>{if(typeof event.data==='string'){try{const value=JSON.parse(event.data);if(value.t==='native-screen-meta')beginServerNativeScreen(peerId,state,value,channel);else if(value.t==='native-screen-audio'&&value.serverId===state.context.serverId)state.nativeScreenAudioExpected=!!value.active;else if(value.t==='native-screen-end')clearServerNativeScreen(state,{keepChannel:true})}catch{}return}if(!channel._nativeReceive)holdNativeScreenPreMeta(channel,event.data);else receiveNativeScreenPacket(channel,event.data)};channel.onclose=()=>{channel._nativePreMeta=[];if(state.nativeReceiveChannel===channel){clearServerNativeScreen(state,{keepChannel:true});state.nativeReceiveChannel=null;renderServerVoiceUI()}};return}
  state.nativeSendChannel=channel;channel.onmessage=event=>{if(typeof event.data!=='string')return;try{const value=JSON.parse(event.data);if(value.t==='native-screen-ready'&&value.serverId===state.context.serverId){channel._nativePeerProtocol=Number(value.transportVersion)||0;clearTimeout(channel._nativeProtocolTimer)}else if(value.t==='native-screen-fallback'&&value.serverId===state.context.serverId)fallbackServerNativeToWebRtc(channel._nativeSend?.sessionId)}catch{}};channel.onopen=()=>announceServerNativeChannel(channel);channel.onclose=()=>{clearTimeout(channel._nativeProtocolTimer);if(channel._serverNativeQueue)channel._serverNativeQueue.length=0;if(state.nativeSendChannel===channel)state.nativeSendChannel=null}
}
async function ensureServerPeer(peerId,context={type:'server',serverId:activeServerId,channelId:activeChannelId}){
  if(serverPeers.has(peerId))return serverPeers.get(peerId);
  const connection=new RTCPeerConnection({iceServers:ICE_SERVERS}),state={pc:connection,channel:null,candidates:[],audios:[],voiceSender:null,screen:null,screenAudio:null,screenStreamId:'',screenSenders:[],nativeScreenPlayer:null,nativeSendChannel:null,nativeReceiveChannel:null,nativeScreenAudioExpected:false,context};serverPeers.set(peerId,state);
  connection.onicecandidate=event=>{if(event.candidate)directorySend({type:'signal',peerId,context:state.context,payload:{kind:'candidate',candidate:event.candidate.toJSON()}})};
  connection.onconnectionstatechange=()=>{if(connection.connectionState==='connected'&&serverNativeScreenSession)ensureServerNativeChannel(peerId,state).catch(()=>{});if(['failed','closed'].includes(connection.connectionState)){stopSpeakingMonitor('server:'+peerId);state.audios.forEach(audio=>audio.remove());clearServerNativeScreen(state);try{state.nativeSendChannel?.close()}catch{}try{state.screen?.remove()}catch{}serverPeers.delete(peerId)}};
  connection.ondatachannel=event=>{if(event.channel.label==='knot-server-screen-native'){wireServerNativeScreenChannel(peerId,state,event.channel,{remote:true});return}state.channel=event.channel;wireServerChannel(peerId,state.channel,state.context.serverId)};
  connection.ontrack=event=>{if(!voicePeerAllowed(peerId))return;const stream=event.streams[0]||new MediaStream([event.track]),isVoiceAudio=event.track.kind==='audio'&&event.transceiver?.sender===state.voiceSender;if(event.track.kind==='video'){addServerScreenVideo(peerId,state,event.track,stream);return}if(isVoiceAudio){addServerVoiceAudio(peerId,state,event.track,stream);return}if(state.nativeScreenAudioExpected&&state.nativeScreenPlayer){stream._knotPeerId=peerId;addServerNativeScreenAudio(state,event.track,stream);return}const screenAudio=stream.getVideoTracks().length>0||!!(state.screenStreamId&&stream.id===state.screenStreamId);if(screenAudio){if(state.screen&&state.screen.srcObject!==stream)try{state.screen.srcObject.addTrack(event.track)}catch{}renderServerShareExperience();return}addServerVoiceAudio(peerId,state,event.track,stream)};
  if(voicePeerAllowed(peerId)){
    for(const track of serverVoiceStream.getTracks()){state.voiceSender=connection.addTrack(track,serverVoiceStream);try{const parameters=state.voiceSender.getParameters();if(!parameters.encodings?.length)parameters.encodings=[{}];parameters.encodings[0].maxBitrate=256000;parameters.encodings[0].priority='high';parameters.encodings[0].networkPriority='high';await state.voiceSender.setParameters(parameters)}catch{}}
    if(serverScreenStream)for(const track of serverScreenStream.getTracks()){
      const sender=connection.addTrack(track,serverScreenStream);state.screenSenders.push(sender);if(track.kind==='video'){applyScreenCodecPreference(connection,sender);await configureScreenVideoSender(sender,track,shareFrameRate,Math.max(1,serverOnlineMembers().length))}
    }
  }
  if(directoryUserId<peerId){state.channel=connection.createDataChannel('pair-server-chat');wireServerChannel(peerId,state.channel,state.context.serverId);const offer=await connection.createOffer();await connection.setLocalDescription(offer);directorySend({type:'signal',peerId,context:state.context,payload:{kind:'offer',sdp:connection.localDescription.sdp}})}return state;
}
async function handleServerSignal(message){const context=message.context||{},payload=message.payload||{};if(context.serverId!==activeServerId&&context.serverId!==joinedVoiceServerId)return;const state=await ensureServerPeer(message.from,context),connection=state.pc;if(payload.kind==='offer'){await connection.setRemoteDescription({type:'offer',sdp:payload.sdp});const answer=await connection.createAnswer();await connection.setLocalDescription(answer);directorySend({type:'signal',peerId:message.from,context:state.context,payload:{kind:'answer',sdp:connection.localDescription.sdp}});for(const candidate of state.candidates.splice(0))await connection.addIceCandidate(candidate)}else if(payload.kind==='answer'){await connection.setRemoteDescription({type:'answer',sdp:payload.sdp});for(const candidate of state.candidates.splice(0))await connection.addIceCandidate(candidate)}else if(payload.kind==='candidate'){if(connection.remoteDescription)await connection.addIceCandidate(payload.candidate);else state.candidates.push(payload.candidate)}}
function closeServerPeer(peerId,state=serverPeers.get(peerId)){if(!state)return;stopSpeakingMonitor('server:'+peerId);try{state.channel?.close()}catch{}clearServerNativeScreen(state);try{state.nativeSendChannel?.close()}catch{}try{state.pc.close()}catch{}for(const audio of state.audios||[])try{audio.remove()}catch{}try{state.screen?.remove()}catch{}serverPeers.delete(peerId)}
function closeServerMesh(){for(const [peerId,state] of [...serverPeers])closeServerPeer(peerId,state)}
function syncServerMesh(){
  // Reconcile instead of close-and-recreate.  The old implementation ran on
  // every channel click and directory snapshot, which needlessly interrupted
  // WebRTC text, voice and screen tracks.
  const serverId=joinedVoiceServerId||activeServerId||[...serverPeers.values()][0]?.context?.serverId;if(!serverId)return;
  const online=new Set(serverOnlineMembers(serverId));
  for(const [peerId,state] of [...serverPeers])if(state.context?.serverId!==serverId||!online.has(peerId))closeServerPeer(peerId,state);
  const context={type:'server',serverId,channelId:joinedVoiceServerId===serverId?joinedVoiceChannelId:activeChannelId};
  for(const peerId of online)ensureServerPeer(peerId,context).catch(()=>{});
  if(!online.size)setServerStatus('No other server members online')
}
function toggleServerVoiceMute(){if(!serverVoiceStream)return;serverVoiceMuted=!serverVoiceMuted;serverVoiceStream.getAudioTracks().forEach(track=>track.enabled=!serverVoiceMuted);renderServerVoiceUI()}
async function waitForServerPeerStable(connection,timeoutMs=5000){if(connection.signalingState==='stable')return true;return new Promise(resolve=>{let settled=false;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);connection.removeEventListener('signalingstatechange',changed);resolve(value)};const changed=()=>{if(connection.signalingState==='stable')finish(true);else if(connection.signalingState==='closed')finish(false)};const timer=setTimeout(()=>finish(false),timeoutMs);connection.addEventListener('signalingstatechange',changed)})}
async function renegotiateServerPeer(peerId,state){
  if(!state||state.pc.signalingState==='closed')return false;state.renegotiateRequested=true;if(state.renegotiatePromise)return state.renegotiatePromise;
  state.renegotiatePromise=(async()=>{let sent=false;while(state.renegotiateRequested&&state.pc.signalingState!=='closed'){state.renegotiateRequested=false;if(!await waitForServerPeerStable(state.pc))break;const offer=await state.pc.createOffer();await state.pc.setLocalDescription(offer);directorySend({type:'signal',peerId,context:state.context,payload:{kind:'offer',sdp:state.pc.localDescription.sdp}});sent=true}return sent})().finally(()=>{state.renegotiatePromise=null});return state.renegotiatePromise;
}
async function switchServerScreenCodec(peerId,state,codec){const sender=state?.screenSenders?.find(value=>value.track?.kind==='video');if(!sender||!applyScreenCodecPreference(state.pc,sender,codec))return false;return renegotiateServerPeer(peerId,state)}
function announceServerNativeChannel(channel){const session=serverNativeScreenSession;if(channel.readyState!=='open'||!session)return false;if(channel._nativeSend?.sessionId===session.id)return true;try{initializeNativeScreenSender(channel,{t:'native-screen-meta',serverId:joinedVoiceServerId,codec:'AV1',fps:session.fps,width:session.width,height:session.height,encoder:session.encoder,latencyTargetMs:session.latencyTargetMs,audio:false},session.id,()=>fallbackServerNativeToWebRtc(session.id));return true}catch{return false}}
async function sendServerNativeItem(channel,item){
  if(channel.readyState!=='open'||!serverNativeScreenSession)return false;if(!announceServerNativeChannel(channel))return false;if(item.kind!=='init'&&!channel._nativeSend.init&&serverNativeScreenInit)await sendNativeScreenLiveItem(channel,{kind:'init',data:serverNativeScreenInit});return sendNativeScreenLiveItem(channel,item)
}
function dropQueuedServerNativeItem(channel,item){if(!item)return;const state=channel._nativeSend;if(state)markNativeScreenCongested(channel,state,!!item.key,Math.max(0,Number(item.frameCount)||0))}
function drainServerNativeQueue(channel){if(channel._serverNativeDraining||channel.readyState!=='open'||!serverNativeScreenSession)return;channel._serverNativeDraining=true;const sessionId=serverNativeScreenSession.id;void(async()=>{try{while(channel.readyState==='open'&&serverNativeScreenSession?.id===sessionId){const next=channel._serverNativeQueue?.shift();if(!next)break;if(!await sendServerNativeItem(channel,next)){try{channel.close()}catch{};break}}}catch{try{channel.close()}catch{}}finally{channel._serverNativeDraining=false;if(channel._serverNativeQueue?.length&&channel.readyState==='open'&&serverNativeScreenSession?.id===sessionId)drainServerNativeQueue(channel)}})()}
function queueServerNativeItem(channel,item){if(channel.readyState!=='open'||!serverNativeScreenSession)return false;const queue=channel._serverNativeQueue||(channel._serverNativeQueue=[]);if(item.kind==='cluster'&&item.key){for(let index=queue.length-1;index>=0;index--)if(queue[index].kind==='cluster')dropQueuedServerNativeItem(channel,queue.splice(index,1)[0])}while(queue.length>=4){const deltaIndex=queue.findIndex(value=>value.kind==='cluster'&&!value.key),clusterIndex=queue.findIndex(value=>value.kind==='cluster'),index=deltaIndex>=0?deltaIndex:clusterIndex;if(index<0)return true;dropQueuedServerNativeItem(channel,queue.splice(index,1)[0])}queue.push(item);drainServerNativeQueue(channel);return true}
async function ensureServerNativeChannel(peerId,state){
  if(!serverNativeScreenSession||!state||state.pc.connectionState!=='connected')return null;let channel=state.nativeSendChannel;if(!channel||channel.readyState==='closed'){channel=state.pc.createDataChannel('knot-server-screen-native',nativeScreenChannelOptions());wireServerNativeScreenChannel(peerId,state,channel)}if(!await waitNativeScreenChannel(channel))return null;announceServerNativeChannel(channel);if(serverNativeScreenInit)await sendServerNativeItem(channel,{kind:'init',data:serverNativeScreenInit});if(serverNativeScreenAudioStream&&!state.screenSenders.some(sender=>sender.track===serverNativeScreenAudioStream.getAudioTracks()[0]))try{await attachServerNativeAudioToPeer(peerId,state)}catch{try{channel.send(JSON.stringify({t:'native-screen-audio',serverId:state.context.serverId,active:false}))}catch{}}return channel
}
async function attachServerNativeAudioToPeer(peerId,state){const track=serverNativeScreenAudioStream?.getAudioTracks?.()[0];if(!track)throw new Error('screen audio ended');if(state.nativeSendChannel?.readyState==='open')state.nativeSendChannel.send(JSON.stringify({t:'native-screen-audio',serverId:state.context.serverId,active:true}));const sender=state.pc.addTrack(track,serverNativeScreenAudioStream);state.screenSenders.push(sender);try{const parameters=sender.getParameters();if(!parameters.encodings?.length)parameters.encodings=[{}];parameters.encodings[0].maxBitrate=192000;parameters.encodings[0].priority='medium';parameters.encodings[0].networkPriority='medium';await sender.setParameters(parameters);if(!await renegotiateServerPeer(peerId,state))throw new Error('screen audio negotiation did not start');return sender}catch(error){try{state.pc.removeTrack(sender)}catch{}state.screenSenders=state.screenSenders.filter(value=>value!==sender);throw error}}
async function attachServerNativeScreenAudio(gen){
  if(!screenAudioOn||!serverNativeScreenSession||gen!==serverScreenGen)return;const track=await linuxShareAudioTrack();if(!track||!serverNativeScreenSession||gen!==serverScreenGen){try{track?.stop()}catch{}if(track)cleanupNativeScreenCapture(track._knotCaptureOwner);return}const audioStream=new MediaStream([track]);serverNativeScreenAudioStream=audioStream;try{track.contentHint='music'}catch{};const peers=[...serverPeers].filter(([peerId])=>voicePeerAllowed(peerId)),results=await Promise.allSettled(peers.map(([peerId,state])=>attachServerNativeAudioToPeer(peerId,state))),failed=results.some(result=>result.status==='rejected')||serverNativeScreenAudioStream!==audioStream||!serverNativeScreenSession||gen!==serverScreenGen,label=serverNativeScreenSession?.encoder||'GPU';if(failed){for(const [peerId,state] of peers){const sender=state.screenSenders.find(value=>value.track===track);if(sender){try{state.pc.removeTrack(sender)}catch{}state.screenSenders=state.screenSenders.filter(value=>value!==sender)}if(state.nativeSendChannel?.readyState==='open')try{state.nativeSendChannel.send(JSON.stringify({t:'native-screen-audio',serverId:state.context.serverId,active:false}))}catch{}renegotiateServerPeer(peerId,state).catch(()=>{})}try{track.stop()}catch{}if(serverNativeScreenAudioStream===audioStream)serverNativeScreenAudioStream=null;cleanupNativeScreenCapture(track._knotCaptureOwner);if(gen===serverScreenGen)setServerStatus('Sharing · '+label+' AV1 · computer sound unavailable',true)}else setServerStatus('Sharing · '+label+' AV1 · computer sound live',true)
}
async function pumpServerNativeScreen(gen,session){
  let audioStarted=false;while(serverNativeScreenSession?.id===session.id&&gen===serverScreenGen){const item=await window.pairNativeScreen.read(session.id);if(serverNativeScreenSession?.id!==session.id||gen!==serverScreenGen)break;if(item?.data){if(item.kind==='init')serverNativeScreenInit=item.data instanceof Uint8Array?item.data.slice():new Uint8Array(item.data);serverNativeLocalPlayer?.append(item.data);const channels=[...serverPeers.values()].map(state=>state.nativeSendChannel).filter(channel=>channel?.readyState==='open');for(const channel of channels)if(!queueServerNativeItem(channel,item))try{channel.close()}catch{};if(!audioStarted){audioStarted=true;void attachServerNativeScreenAudio(gen)}continue}if(!item?.active){if(item?.error)setServerStatus('Native share stopped: '+item.error);break}}
  if(serverNativeScreenSession?.id===session.id&&gen===serverScreenGen)await stopServerScreenShare()
}
async function startServerNativeScreenShare(expectedVoiceStream=serverVoiceStream,expectedServerId=joinedVoiceServerId,expectedChannelId=joinedVoiceChannelId){
  const ownsVoice=()=>!!expectedVoiceStream&&serverVoiceStream===expectedVoiceStream&&joinedVoiceServerId===expectedServerId&&joinedVoiceChannelId===expectedChannelId;
  if(!ownsVoice())return false;
  serverScreenStarting=true;const gen=++serverScreenGen;let session=null,player=null;const preview=$('#serverVoiceScreenPreview');renderServerVoiceUI();
  const abandon=()=>{if(session)try{window.pairNativeScreen?.stop(session.id)}catch{};if(serverNativeScreenSession?.id===session?.id)serverNativeScreenSession=null;if(player){try{player.destroy()}catch{}if(serverNativeLocalPlayer===player)serverNativeLocalPlayer=null}if(gen===serverScreenGen&&!serverNativeScreenSession&&!serverScreenStream)preview.hidden=true};
  try{const [width,height]=selectedNativeDimensions(),fps=shareFrameRate===30?30:60,viewers=Math.max(1,[...serverPeers].filter(([peerId])=>voicePeerAllowed(peerId)).length);session=await window.pairNativeScreen.start({codec:'av1',fps,width,height,bitrateKbps:targetNativeAv1BitrateKbps(width,height,fps,viewers),cursor:screenCursor});if(!session||session.error)throw new Error(session?.error||'GPU AV1 capture did not start');if(gen!==serverScreenGen||!ownsVoice()){abandon();return false}serverNativeScreenSession=session;serverNativeScreenInit=null;preview.hidden=false;preview.muted=true;player=createNativeScreenPlayer(preview,'AV1',()=>{}, {...session,decode:false});serverNativeLocalPlayer=player;await Promise.all([...serverPeers].filter(([peerId])=>voicePeerAllowed(peerId)).map(([peerId,state])=>ensureServerNativeChannel(peerId,state)));if(gen!==serverScreenGen||!ownsVoice()||serverNativeScreenSession?.id!==session.id){abandon();return false}setServerStatus('Choose a display · starting '+(session.encoder||'GPU')+' AV1…',true);serverFocusedShareId=directoryUserId;renderServerVoiceUI();void pumpServerNativeScreen(gen,session);return true}catch(error){const stale=gen!==serverScreenGen||!ownsVoice();abandon();if(!stale)setServerStatus('Native AV1 unavailable: '+(error?.message||error));return false}finally{if(gen===serverScreenGen)serverScreenStarting=false;renderServerVoiceUI()}
}
async function fallbackServerNativeToWebRtc(expectedSessionId=serverNativeScreenSession?.id){
  const expectedSession=serverNativeScreenSession,expectedVoiceStream=serverVoiceStream,expectedServerId=joinedVoiceServerId,expectedChannelId=joinedVoiceChannelId,previous=screenCodec,compatibility=compatibilityScreenCodec(),beforeStopGen=serverScreenGen;
  if(serverNativeFallbackInFlight||!expectedSession||expectedSession.id!==expectedSessionId||!expectedVoiceStream)return;serverNativeFallbackInFlight=true;
  try{setServerStatus('AV1 playback unavailable · switching to bandwidth-capped '+compatibility);await stopServerScreenShare();if(serverScreenGen!==beforeStopGen+1||serverVoiceStream!==expectedVoiceStream||joinedVoiceServerId!==expectedServerId||joinedVoiceChannelId!==expectedChannelId)return;screenFallbackBitrateCapMbps=compatibility==='VP9'?6:8;screenCodec=compatibility;await startServerScreenShare({skipPicker:true,expectedVoiceStream,expectedServerId,expectedChannelId})}finally{screenCodec=previous;serverNativeFallbackInFlight=false}
}
async function startServerScreenShare({skipPicker=false,expectedVoiceStream:ownedVoiceStream=null,expectedServerId:ownedServerId='',expectedChannelId:ownedChannelId=''}={}){
  if(!serverVoiceStream||serverScreenSharing()||serverScreenStarting)return;
  const expectedVoiceStream=ownedVoiceStream||serverVoiceStream,expectedServerId=ownedServerId||joinedVoiceServerId,expectedChannelId=ownedChannelId||joinedVoiceChannelId,requestGen=serverScreenGen,ownsVoice=()=>!!expectedVoiceStream&&serverVoiceStream===expectedVoiceStream&&joinedVoiceServerId===expectedServerId&&joinedVoiceChannelId===expectedChannelId,ownsRequest=()=>ownsVoice()&&serverScreenGen===requestGen;
  if(!ownsVoice())return;
  primeScreenAudioContext();
  if(!skipPicker)screenFallbackBitrateCapMbps=0;
  if(!skipPicker){serverScreenStarting=true;renderServerVoiceUI();try{setServerStatus(window.pairEnv?.useSystemPicker?'Choose stream quality…':'Choose a screen or window…');const choice=await chooseScreenShare();if(!choice){if(ownsRequest())setServerStatus('Screen share canceled');return}if(!ownsRequest())return}catch(error){if(ownsRequest())setServerStatus('Screen share failed: '+(error?.message||error));return}finally{serverScreenStarting=false;renderServerVoiceUI()}}
  if(!ownsRequest())return;
  if(!skipPicker&&window.pairNativeScreen&&window.pairEnv?.platform==='linux'&&['0x10de','0x1002'].includes(window.pairEnv.primaryGpuVendor)&&(screenCodec==='auto'||screenCodec==='AV1')){const info=await window.pairNativeScreen.info();if(!ownsRequest())return;if(info?.supported){const started=await startServerNativeScreenShare(expectedVoiceStream,expectedServerId,expectedChannelId);if(started||!ownsVoice())return}}
  if(!ownsVoice())return;
  serverScreenStarting=true;const gen=++serverScreenGen;let startupStream=null;renderServerVoiceUI();
  try{
    const fps=shareFrameRate===30?30:60;
    const stream=await captureDisplayStream();startupStream=stream;if(gen!==serverScreenGen){stream.getTracks().forEach(track=>track.stop());return}
    const track=stream.getVideoTracks()[0];if(!track)throw new Error('No screen was selected');
    await tuneDisplayTrack(track);setServerStatus('Checking screen video…');const captured=await waitForDisplayFrames(track);if(gen!==serverScreenGen){stream.getTracks().forEach(value=>value.stop());return}
    try{track.contentHint=screenContentHint}catch{}
    serverScreenStream=stream;startupStream=null;const preview=$('#serverVoiceScreenPreview');preview.srcObject=null;preview.hidden=false;preview.muted=true;serverNativeLocalPlayer?.destroy();serverNativeLocalPlayer=createNativeScreenPlaceholder(preview,{width:captured.width,height:captured.height});track.onended=()=>{if(serverScreenStream===stream)stopServerScreenShare()};
    const viewers=Math.max(1,[...serverPeers].filter(([peerId])=>voicePeerAllowed(peerId)).length),starts=[];for(const [peerId,state] of serverPeers){if(!voicePeerAllowed(peerId))continue;starts.push((async()=>{const sender=state.pc.addTrack(track,stream);state.screenSenders.push(sender);applyScreenCodecPreference(state.pc,sender);await configureScreenVideoSender(sender,track,fps,viewers);await renegotiateServerPeer(peerId,state)})())}await Promise.allSettled(starts);if(gen!==serverScreenGen||serverScreenStream!==stream)return;
    setServerStatus('Sharing · '+captured.width+'×'+captured.height+(captured.fps?' · '+captured.fps+'fps':''),true);renderServerVoiceUI();setTimeout(renderServerShareExperience,250);
    if(screenAudioOn)void attachServerScreenAudio(gen,stream);
  }catch(error){try{startupStream?.getTracks().forEach(track=>track.stop())}catch{}const ownsFailure=gen===serverScreenGen&&ownsVoice();if(ownsFailure&&serverScreenStream){serverScreenStream.getTracks().forEach(track=>track.stop());serverScreenStream=null}if(ownsFailure){cleanupNativeScreenCapture();if(error?.name!=='NotAllowedError')setServerStatus('Screen share failed: '+(error?.message||error))}}
  finally{if(gen===serverScreenGen)serverScreenStarting=false;renderServerVoiceUI()}
}
async function attachServerScreenAudio(gen,stream){
  let audioTrack=null;const created=[];try{audioTrack=window.pairEnv?.platform==='linux'?await linuxShareAudioTrack():await setupNativeScreenCapture()}catch(error){console.warn('[AUDIO] server screen capture failed:',error?.message||error)}
  const discard=()=>{for(const [peerId,state,sender] of created){try{state.pc.removeTrack(sender)}catch{}state.screenSenders=state.screenSenders.filter(value=>value!==sender);renegotiateServerPeer(peerId,state).catch(()=>{})}try{audioTrack?.stop()}catch{};try{stream.removeTrack(audioTrack)}catch{};cleanupNativeScreenCapture(audioTrack?._knotCaptureOwner)};if(!audioTrack)return;if(gen!==serverScreenGen||serverScreenStream!==stream){discard();return}
  try{audioTrack.enabled=true;try{audioTrack.contentHint='music'}catch{}stream.addTrack(audioTrack);const starts=[];for(const [peerId,state] of serverPeers){if(!voicePeerAllowed(peerId))continue;const sender=state.pc.addTrack(audioTrack,stream);state.screenSenders.push(sender);created.push([peerId,state,sender]);starts.push((async()=>{const parameters=sender.getParameters();if(!parameters.encodings?.length)parameters.encodings=[{}];parameters.encodings[0].maxBitrate=192000;parameters.encodings[0].priority='medium';parameters.encodings[0].networkPriority='medium';await sender.setParameters(parameters);await renegotiateServerPeer(peerId,state)})())}const results=await Promise.allSettled(starts);if(results.some(result=>result.status==='rejected'))throw results.find(result=>result.status==='rejected').reason;if(gen!==serverScreenGen||serverScreenStream!==stream)discard();else setServerStatus('Sharing · computer sound live',true)}catch(error){console.warn('[AUDIO] server screen attach failed:',error?.message||error);discard()}
}
async function stopServerScreenShare(){const stream=serverScreenStream,nativeSession=serverNativeScreenSession;serverScreenGen++;serverScreenStarting=false;if(!stream&&!nativeSession)return;serverScreenStream=null;serverNativeScreenSession=null;if(nativeSession)window.pairNativeScreen?.stop(nativeSession.id);serverNativeLocalPlayer?.destroy();serverNativeLocalPlayer=null;serverNativeScreenInit=null;if(serverNativeScreenAudioStream){serverNativeScreenAudioStream.getTracks().forEach(track=>track.stop());serverNativeScreenAudioStream=null}stream?.getTracks().forEach(track=>track.stop());cleanupNativeScreenCapture();const preview=$('#serverVoiceScreenPreview');preview.pause();preview.srcObject=null;try{preview.removeAttribute('src');preview.load()}catch{}preview.hidden=true;serverFocusedShareId=serverFocusedShareId===directoryUserId?'':serverFocusedShareId;const stops=[];for(const [peerId,state] of serverPeers){if(state.nativeSendChannel){if(state.nativeSendChannel.readyState==='open')try{state.nativeSendChannel.send(JSON.stringify({t:'native-screen-end',serverId:state.context.serverId}))}catch{}try{state.nativeSendChannel.close()}catch{}state.nativeSendChannel=null}for(const sender of state.screenSenders||[])try{state.pc.removeTrack(sender)}catch{}state.screenSenders=[];stops.push(renegotiateServerPeer(peerId,state))}await Promise.allSettled(stops);renderServerVoiceUI()}
async function joinServerVoice(){const channel=activeChannel();if(!channel||channel.type!=='voice')return callStatus.textContent='Select a voice channel first.';if(dmCallOngoing()){callStatus.textContent='Leave your direct call before joining server voice.';return}if(serverVoiceStream&&joinedVoiceChannelId===channel.id)return;stopServerVoice();try{serverVoiceStream=await navigator.mediaDevices.getUserMedia(microphoneConstraints());serverVoiceMuted=false;serverVoiceStream.getAudioTracks().forEach(track=>track.enabled=true);joinedVoiceServerId=activeServerId;joinedVoiceChannelId=channel.id;joinedVoiceAt=Date.now();monitorSpeaking('server:'+directoryUserId,serverVoiceStream);directorySend({type:'voice-state',serverId:joinedVoiceServerId,channelId:channel.id,joined:true});callStatus.textContent='Joined '+channel.name;callStatus.className='call-status live';renderCallButtonState('end','Leave voice','Leave voice channel');renderChannels();syncServerMesh()}catch(error){callStatus.textContent='Could not join voice: '+(error?.message||error);callStatus.className='call-status';syncServerMesh();renderServerVoiceUI()}}
function stopServerVoice(){abortScreenSharePicker();serverScreenGen++;serverScreenStarting=false;stopSpeakingMonitor('server:'+directoryUserId);const serverId=joinedVoiceServerId||activeServerId,channelId=joinedVoiceChannelId;if(channelId&&serverId)directorySend({type:'voice-state',serverId,channelId,joined:false});if(serverScreenSharing())stopServerScreenShare();if(serverVoiceStream){serverVoiceStream.getTracks().forEach(track=>track.stop());serverVoiceStream=null}joinedVoiceServerId='';joinedVoiceChannelId='';joinedVoiceAt=0;serverVoiceMuted=false;serverFocusedShareId='';serverSuppressedShares.clear();clearInterval(voiceElapsedTimer);closeServerMesh();renderServerVoiceUI();if(activeServerId){const voice=activeChannel()?.type==='voice';renderCallButtonState('start',voice?'Join voice':'Start call',voice?'Join voice channel':'Start voice call');callStatus.textContent='Voice off';callStatus.className='call-status';renderChannels()}}
function sendServerMessage(text,gif){const server=activeServer(),channel=activeChannel();if(!server||!channel)return;const value={t:'server-msg',serverId:server.id,channelId:channel.id,id:clientHex(16),text,gif:gif?.url?{url:gif.url,thumb:gif.thumb||gif.url}:null,author:{id:directoryUserId,name:profileName,image:'',frame:normalizeFrame(profileFrame)},time:Date.now()};const entry=normalizeServerHistoryEntry(value,server,directoryUserId);if(!entry)return;storeServerHistory(server.id,channel.id,[entry]);let sent=0;for(const state of serverPeers.values())if(state.channel?.readyState==='open'){state.channel.send(JSON.stringify(value));sent++}if(!sent)pairHint.textContent='No server members are online. The message is saved locally and will sync when a member connects.'}
function profileSnapshotSignature(snapshot){const profiles=[...(snapshot?.friends||[]),...Object.values(snapshot?.members||{})];return JSON.stringify(profiles.map(user=>[user.id,user.name,user.image,user.frame]))}
function updateDirectorySnapshot(snapshot){
  const previous=directorySnapshot,profilesChanged=profileSnapshotSignature(previous)!==profileSnapshotSignature(snapshot),oldServerIds=new Set((previous.servers||[]).map(server=>server.id)),newServer=pendingServerSelection?(snapshot.servers||[]).find(server=>!oldServerIds.has(server.id)):null,pendingServer=pendingChannelCreation?(snapshot.servers||[]).find(server=>server.id===pendingChannelCreation.serverId):null,newChannel=pendingServer?.channels?.find(channel=>channel.type===pendingChannelCreation?.type&&!pendingChannelCreation.beforeIds.has(channel.id));
  snapshot.voiceStates=snapshot.voiceStates||{};directorySnapshot=snapshot;renderServers();syncPersistentDmPeers();
  if(activePeerId){const friend=directoryUser(activePeerId);if(friend)applyFriendProfile(friend)}if(dmCallPeerId)renderCallPeerProfile();
  if(activeServerId){const server=activeServer();if(joinedVoiceChannelId&&!server?.channels?.some(channel=>channel.id===joinedVoiceChannelId))stopServerVoice();if(activeChannelId&&!server?.channels?.some(channel=>channel.id===activeChannelId)){const fallback=server?.channels?.find(channel=>channel.type==='text')||server?.channels?.[0];if(fallback)selectServerChannel(server.id,fallback.id)}else{renderChannels();syncServerMesh()}}
  if(newServer){pendingServerSelection=false;const dialog=$('#serverDialog');if(dialog?.open)dialog.close();selectServer(newServer.id)}if(newChannel){pendingChannelCreation=null;const dialog=$('#channelDialog');if(dialog?.open)dialog.close();selectServerChannel(pendingServer.id,newChannel.id)}if(profilesChanged&&activeConversationKey)openConversation(activeConversationKey)
}
async function connectDirectory(){
  clearTimeout(directoryReconnect);const saved=await Promise.all([ss('directoryUserId'),ss('directoryToken'),ss('messageHistory')]);directoryUserId=/^[a-f0-9]{32}$/.test(saved[0]||'')?saved[0]:clientHex(16);directoryToken=/^[a-f0-9]{64}$/.test(saved[1]||'')?saved[1]:clientHex(32);if(directoryUserId!==saved[0])await ssSet('directoryUserId',directoryUserId);if(directoryToken!==saved[1])await ssSet('directoryToken',directoryToken);try{const parsed=JSON.parse(saved[2]||'{}');if(parsed&&typeof parsed==='object')conversationHistories=parsed}catch{}
  setDirectoryState(false,'Connecting…');const socket=new WebSocket(directoryAddress());directorySocket=socket;
  socket.onopen=async()=>{directoryBackoff=1000;try{const profile=await directoryProfile();if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'hello',userId:directoryUserId,token:directoryToken,...profile}))}catch(error){console.warn('directory profile',error);if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'hello',userId:directoryUserId,token:directoryToken,name:profileName,image:'',frame:normalizeFrame(profileFrame)}))}};
  socket.onmessage=event=>{try{
    const value=JSON.parse(event.data);
    if(value.type==='authenticated'){setDirectoryState(true,'Online');directoryProfilePush()}
    else if(value.type==='snapshot')updateDirectorySnapshot(value);
    else if(value.type==='invite-created'){if(value.kind==='friend'){const input=$('#roomCode');input.value=value.code;pairHint.textContent='Friend code '+value.code+' is ready for 15 minutes.'}else alert('Server invite code: '+value.code+'\n\nThis code expires in 15 minutes.')}
    else if(value.type==='connect-request'){const friend=directoryUser(value.from);if(friend&&!dmCallOngoing())automaticPair('join',value.session,value.from).then(()=>{if(activePeerId===value.from)applyFriendProfile(friend)})}
    else if(value.type==='peer-signal'){const task=value.context?.type==='dm-persistent'?handlePersistentDmSignal(value):handleServerSignal(value);task.catch(error=>console.warn('peer signal',error))}
    else if(value.type==='error'){const message=value.message||'Knot directory request failed';pairHint.textContent=message;const dialog=$('#serverDialog');if(dialog?.open&&['create-server','redeem-invite'].includes(value.action)){pendingServerSelection=false;$('#serverDialogStatus').textContent=message;dialog.querySelectorAll('form button').forEach(button=>button.disabled=false)}}
  }catch(error){console.warn('directory message',error)}};
  socket.onclose=()=>{if(directorySocket!==socket)return;directorySocket=null;setDirectoryState(false,'Offline — retrying');for(const peerId of [...persistentDmPeers.keys()])closePersistentDmPeer(peerId);directoryReconnect=setTimeout(connectDirectory,directoryBackoff);directoryBackoff=Math.min(30000,directoryBackoff*2)};socket.onerror=()=>setDirectoryState(false,'Connection error');
}
function installFriendNavigation(){const search=$('#friendSearch');search.oninput=renderFriends;search.onkeydown=event=>{if(event.key!=='Enter')return;const first=$('#friendList .friend-entry');if(first){event.preventDefault();first.click()}};$('#friendsHome').onclick=()=>{search.value='';renderFriends();search.focus()}}
function installChannelDialog(){const dialog=$('#channelDialog'),form=$('#channelForm'),input=$('#newChannelName'),kind=$('#channelDialogKind'),status=$('#channelDialogStatus'),submit=form.querySelector('.primary');let channelType='text';const open=type=>{if(!canEditServer())return;channelType=type==='voice'?'voice':'text';kind.textContent=channelType.toUpperCase()+' CHANNEL';input.placeholder=channelType==='voice'?'New voice':'new-channel';input.value=channelType==='voice'?'New voice':'new-channel';status.textContent='';submit.disabled=false;dialog.showModal();setTimeout(()=>input.select(),0)};$('#addTextChannel').onclick=()=>open('text');$('#addVoiceChannel').onclick=()=>open('voice');$('#closeChannelDialog').onclick=()=>dialog.close();dialog.addEventListener('click',event=>{const box=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom))dialog.close()});form.onsubmit=event=>{event.preventDefault();const server=activeServer(),name=cleanClientName(input.value,channelType==='voice'?'New voice':'new-channel');if(!canEditServer(server)){dialog.close();return}if(!directorySend({type:'create-channel',serverId:server.id,channelType,name})){status.textContent='Knot is offline. Reconnect before creating a channel.';return}pendingChannelCreation={serverId:server.id,type:channelType,beforeIds:new Set(server.channels.map(channel=>channel.id))};status.textContent='Creating '+name+'…';submit.disabled=true}}
function installServerDialog(){const dialog=$('#serverDialog'),status=$('#serverDialogStatus'),createForm=$('#createServerForm'),joinForm=$('#joinServerForm'),name=$('#newServerName'),code=$('#serverInviteCode'),buttons=[...dialog.querySelectorAll('form button')];const setBusy=text=>{status.textContent=text;buttons.forEach(button=>button.disabled=true)};const open=()=>{status.textContent='';buttons.forEach(button=>button.disabled=false);dialog.showModal();setTimeout(()=>name.select(),0)};$('#addServer').onclick=open;$('#closeServerDialog').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{buttons.forEach(button=>button.disabled=false);if(!pendingServerSelection)status.textContent=''});dialog.addEventListener('click',event=>{const box=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom))dialog.close()});code.addEventListener('input',()=>{code.value=code.value.replace(/\D/g,'').slice(0,5)});createForm.onsubmit=event=>{event.preventDefault();const serverName=cleanClientName(name.value,'New server');if(!directorySend({type:'create-server',name:serverName})){status.textContent='Knot is offline. Reconnect before creating a server.';return}pendingServerSelection=true;setBusy('Creating '+serverName+'…')};joinForm.onsubmit=event=>{event.preventDefault();const invite=code.value.trim();if(!/^\d{5}$/.test(invite)){status.textContent='Enter the five-digit server invite code.';code.focus();return}if(!directorySend({type:'redeem-invite',code:invite})){status.textContent='Knot is offline. Reconnect before joining a server.';return}pendingServerSelection=true;setBusy('Joining server…')}}
  function installDirectoryUI(){const originalSubmit=messageForm.onsubmit;messageForm.onsubmit=async event=>{if(!activeServerId)return originalSubmit(event);event.preventDefault();const text=convertEmoticons(messageInput.value.trim()),gif=pendingGif;if(!text&&!gif)return;sendServerMessage(text,gif);messageInput.value='';setPendingGif(null)};$('#homeButton').onclick=()=>{showFriends();if(activePeerId)selectFriend(activePeerId,{connect:false})};$('#addFriend').onclick=()=>{settingsPanel.hidden=true;document.body.classList.remove('settings-open');connectCard.open=true;syncPanelBackdrop();pairHint.textContent='Create a friend code, or enter the five digits your friend sent you.';$('#hostRoom').textContent='Create friend code';$('#joinRoom').textContent='Add friend';setTimeout(()=>$('#roomCode').focus(),0)};$('#hostRoom').onclick=()=>{if(!directorySend({type:'create-invite',kind:'friend'}))pairHint.textContent='Knot presence is offline. Reconnect before creating a friend code.'};$('#joinRoom').onclick=()=>{const code=$('#roomCode').value.trim();if(!/^\d{5}$/.test(code))return pairHint.textContent='Enter a five-digit friend code.';directorySend({type:'redeem-invite',code});pairHint.textContent='Adding friend…'};$('#inviteServer').onclick=()=>activeServerId&&directorySend({type:'create-invite',kind:'server',serverId:activeServerId});$('#editServerPicture').onclick=()=>{if(canEditServer())$('#serverPictureInput').click()};$('#serverPictureInput').onchange=async()=>{const file=$('#serverPictureInput').files?.[0];$('#serverPictureInput').value='';if(!file||!canEditServer())return;try{const picture=await resizeProfile(file);if(picture.length>512*1024)throw new Error('Choose a server image smaller than about 380 KB');directorySend({type:'update-server',serverId:activeServerId,picture})}catch(error){alert(error?.message||'Could not use that server picture')}};const directCall=callBtn.onclick;callBtn.onclick=()=>{if(!activeServerId)return directCall();if(serverVoiceStream)stopServerVoice();else if(activeChannel()?.type==='voice')joinServerVoice();else callStatus.textContent='Select a voice channel first.'};$('#serverStageLeave').onclick=stopServerVoice;$('#serverVoiceMute').onclick=$('#serverStageMute').onclick=toggleServerVoiceMute;const toggleServerShare=()=>serverScreenSharing()?stopServerScreenShare():startServerScreenShare();$('#serverVoiceShare').onclick=$('#serverStageShare').onclick=toggleServerShare;installSidebarLayout();installFriendNavigation();installServerDialog();showFriends({expand:false});connectDirectory()}
queueMicrotask(async()=>{installDirectoryUI();installChannelDialog();$('#serverVoiceHangup').onclick=stopServerVoice;$('#dmVoiceHangup').onclick=()=>{setParticipant(participantFriend,false);endCall(false)};$('#dmVoiceMute').onclick=toggleMute;$('#dmVoiceShare').onclick=()=>screenBtn.click();const toggleMembers=()=>setMemberPanelCollapsed(!document.body.classList.contains('server-members-collapsed'));$('#memberPanelToggle').onclick=toggleMembers;$('#serverMembersClose').onclick=()=>setMemberPanelCollapsed(true);setMemberPanelCollapsed((await ss('serverMembersCollapsed'))==='on',false)});
async function automaticPair(kind,explicitRoom='',expectedPeerId=''){
  // Tear down any prior session so a second Host/Join click (or host→leave→host)
  // doesn't leak an old pc/signaling whose handlers fire stale signals.
  reconnectCall=callActive;if(pc||signaling)disconnectRoom();
  role=kind;directoryTrustedConnection=!!expectedPeerId;dmPeerId=expectedPeerId||activePeerId;const baseAddress=PAIR_SIGNAL_SERVER; const room=String(explicitRoom||$('#roomCode').value).trim().toUpperCase();
  if(!/^(?:\d{5}|[A-Z0-9_-]{16,64})$/.test(room))return pairHint.textContent='Enter the five-digit invite code.';
  const address=roomSignalAddress(baseAddress,room);
  pairHint.textContent='Connecting to signaling server…'; signaling=new WebSocket(address);
  signaling.onopen=()=>{try{signaling.send(JSON.stringify({type:'join',room}))}catch{}pairHint.textContent=kind==='host'?'Invite code '+room+' is ready — send it to your friend.':'Joining with invite code '+room+'…'};
  signaling.onerror=()=>pairHint.textContent='Could not reach Knot signaling. Check your internet connection.';
  signaling.onmessage=async event=>{try{const message=JSON.parse(event.data);
    if(message.type==='full'){pairHint.textContent='That invite code is already in use. Create a new code or check the number.';try{signaling?.close()}catch{}signaling=null;return}
    if(message.type==='peer-ready'&&role==='host'){
      reconnectCall=callActive;setupPeer();const kp=await keyPair();if(!pc)return;pc._kp=kp;setupChannels();
      const offer=await pc.createOffer();if(!pc)return;await pc.setLocalDescription({type:'offer',sdp:patchSdp(offer.sdp)});if(!pc)return;await waitIce();if(!signaling)return;
      logCallEvent('Diag: offer has m=audio=' + (pc.localDescription.sdp.includes('m=audio')?'yes':'NO'));
      signaling.send(JSON.stringify({type:'signal',payload:{kind:'offer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}}));
      pairHint.textContent='Offer sent. Connecting…';
      // If the friend never answers (wrong role, different room, or an old build
      // without TURN), don't hang silently — tell them what to check.
      setTimeout(()=>{if(pc&&pc.connectionState!=='connected'){pairHint.textContent='No answer after 20s. Check that your friend entered '+room+' and clicked Join.'}},20000)
    }
    if(message.type==='signal'){const remote=message.payload;
      // Both clicked Host: each receives the other's offer but role==='host', so
      // neither branch matches. Surface it instead of hanging.
      if(remote.kind==='offer'&&role==='host'){pairHint.textContent='Both of you clicked Host. One of you must click Leave, then that person clicks Join instead.';return}
      if(remote.kind==='offer'&&role==='join'){
        setupPeer();const kp=await keyPair();if(!pc)return;pc._kp=kp;
        await pc.setRemoteDescription({type:'offer',sdp:remote.sdp});if(!pc)return;if(!await derive(kp,remote.pub)){disconnectRoom();pairHint.textContent='Security code was not confirmed.';return}if(!pc)return;
        // Ensure the audio transceiver's direction is sendrecv so the answer
        // includes a sender — the browser may have created a recvonly transceiver
        // for the offer's audio m-line when no local sender track was attached yet.
        // Force audio transceiver direction to sendrecv so the answer includes a
        // sender. Also update audioTransceiver to the MATCHED transceiver (with
        // non-null mid) so startCall uses it — the one from addTransceiver in
        // setupPeer has mid=null and would send on an un-negotiated path.
        pc.getTransceivers().filter(t=>t.receiver.track?.kind==='audio').forEach(t=>{try{if(t.direction!=='sendrecv'){t.setDirection('sendrecv');logCallEvent('Diag: set audioTr direction to sendrecv (was '+t.direction+')')}}catch(e){logCallEvent('Diag: setDirection error: '+e.message)}});
        const matched=pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio'&&t.mid);if(matched)audioTransceiver=matched;
        logCallEvent('Diag: before createAnswer transceivers='+pc.getTransceivers().length+' audioTr='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio')?'ok:dir='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio').direction):'null'));
        const a=await pc.createAnswer();if(!pc)return;await pc.setLocalDescription({type:'answer',sdp:patchSdp(a.sdp)});if(!pc)return;await waitIce();if(!signaling)return;
        logCallEvent('Diag: answer has m=audio=' + (pc.localDescription.sdp.includes('m=audio')?'yes':'NO'));
        signaling.send(JSON.stringify({type:'signal',payload:{kind:'answer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}}));
        pairHint.textContent='Answer sent. Connecting…'
      }else if(remote.kind==='answer'&&role==='host'){
        logCallEvent('Diag: before setRD(answer) transceivers='+pc.getTransceivers().length+' audioTr='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio')?'ok:dir='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio').direction):'null'));
        await pc.setRemoteDescription({type:'answer',sdp:remote.sdp});if(!pc)return;if(!await derive(pc._kp,remote.pub)){disconnectRoom();pairHint.textContent='Security code was not confirmed.';return}
        logCallEvent('Diag: after setRD(answer)');
        const matched=pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio'&&t.mid);if(matched)audioTransceiver=matched;
        const cd=matched?matched.currentDirection:'none';
        logCallEvent('Diag: audio currentDir='+cd);
        // If the friend's answer didn't include an audio sender, startCall will
        // add a transceiver and renegotiate instead of relying on the unmatched one.
        pairHint.textContent='Secure connection established.'
      }else if(remote.kind==='reneg-offer'){
        // Either peer can initiate screen share, so both roles must be able to
        // answer a reneg-offer.
        // Glare handling: if we have our own reneg pending, the joiner defers
        // (supersede its offer and answer the host's instead). role is always
        // opposite across the two peers, so this is a deterministic tiebreak.
        if(renegPending&&role==='join'){renegotiating++;renegPending=false}
        try{if(!pc)return;await pc.setRemoteDescription({type:'offer',sdp:remote.sdp});if(!pc)return;const a=await pc.createAnswer();if(!pc)return;await pc.setLocalDescription({type:'answer',sdp:patchSdp(a.sdp)});if(!pc)return;await waitIce();if(signaling)signaling.send(JSON.stringify({type:'signal',payload:{kind:'reneg-answer',sdp:pc.localDescription.sdp}}))}catch(e){console.warn('reneg-offer error',e)}
      }else if(remote.kind==='reneg-answer'){
        try{if(!pc)return;await pc.setRemoteDescription({type:'answer',sdp:remote.sdp})}catch(e){console.warn('reneg-answer error',e)}
      }
    }
  }catch(e){console.warn('signaling message error',e);pairHint.textContent='Connection setup failed: '+(e&&e.message||e)}};
}
$('#hostRoom').onclick=()=>{const code=makeInviteCode();$('#roomCode').value=code;ssSet('roomCode',code);automaticPair('host')}; $('#joinRoom').onclick=()=>automaticPair('join');
function disconnectRoom(){abortScreenSharePicker();if(pc&&pc._connectTimer){clearTimeout(pc._connectTimer);pc._connectTimer=null}
  // Tear down an active share before closing the peer connection so WASAPI
  // capture and local MediaStream tracks do not keep running after leave.
  screenGen++;
  screenStarting=false;
  if(nativeScreenSession)try{window.pairNativeScreen?.stop(nativeScreenSession.id)}catch{}nativeScreenSession=null;if(nativeScreenChannel)try{nativeScreenChannel.close()}catch{}nativeScreenChannel=null;nativeLocalPlayer?.destroy();nativeLocalPlayer=null;nativeScreenAnnounced=false;if(nativeScreenAudioStream){nativeScreenAudioStream.getTracks().forEach(track=>track.stop());nativeScreenAudioStream=null}
  if(window.pairEnv?.platform==='linux')try{window.pairEnv.stopLinuxShareAudio?.()}catch{}
  screenActive=false;screenAudioDebug='';
  if(screenStatsTimer){clearInterval(screenStatsTimer);screenStatsTimer=null}screenStatsLast=null;
  cleanupNativeScreenCapture();
  if(screenStream){try{screenStream.getTracks().forEach(t=>t.stop())}catch{}screenStream=null}
  screenSenders=[];
  try{screenPreview.srcObject=null;screenPreview.removeAttribute('src');screenPreview.load()}catch{};screenPreview.hidden=true;
  screenBtn.textContent='Share screen';screenBtn.title='Share screen';screenBtn.disabled=true;
  screenStatus.textContent='Not sharing';
  clearRemoteScreenShare();
  try{if(chat){chat.onmessage=null;chat.close()}}catch{}try{if(files){files.onmessage=null;files.close()}}catch{}try{if(pc)pc.close()}catch{}if(pc&&pc._silentAudioCtx)try{pc._silentAudioCtx.close()}catch{}pc=chat=files=null;if(signaling){try{signaling.onopen=null;signaling.onerror=null;signaling.onmessage=null;signaling.close()}catch{}signaling=null}sharedKey=null;setAvatar(friendAvatar,'');setAvatarIdentity(friendAvatar,'');remoteVoiceTrack=null;stopSpeakingMonitor('dm-friend');try{remoteAudio.srcObject=null}catch{};try{if(audioCtx&&audioCtx.audioSink){audioCtx.audioSink.disconnect();delete audioCtx.audioSink}}catch{}
  // Release any pending backpressure waiters so in-flight sends don't hang
  // forever after the bus is closed. They'll re-check fileBus(), find it gone,
  // and the send loop will abort cleanly.
  busDrains.forEach(set=>set.forEach(h=>{try{h()}catch{}}));busDrains.clear();
  sendAbort.forEach(c=>c.abort=true);sendAbort.clear();acceptWait.forEach(w=>{try{w.reject(new Error('Disconnected'))}catch{}});acceptWait.clear();
  acceptCards.forEach(done=>{try{done(false)}catch{}});acceptCards.clear();  activeTransfers.forEach(t=>t.abort=true);activeTransfers.clear();pendingFrames.clear();outTransfers.clear();sendQueue=Promise.resolve();receiveQueue=Promise.resolve();connectSoundDone=false;friendLeftNotified=false;role=null;audioTransceiver=null;dmPeerId='';dmCallPeerId='';localCallSessionId='';remoteCallSessionId='';deriveGen++;setParticipant(participantYou,false);setFriendPresence(false,{animate:false,sound:false});voiceLog.innerHTML='';setStatus('Not connected');$('#leaveRoom').hidden=true;$('#hostRoom').hidden=false;$('#joinRoom').hidden=false;pairHint.textContent='Disconnected from room.'}
const disconnectRoomWithoutPendingReset=disconnectRoom;
disconnectRoom=function(){clearPendingFrames();return disconnectRoomWithoutPendingReset()};
$('#leaveRoom').onclick=()=>disconnectRoom();
function clearTransfers(){
  sendAbort.forEach(c=>c.abort=true);sendAbort.clear();
  acceptWait.forEach(w=>{try{w.reject(new Error('Cleared'))}catch{}});acceptWait.clear();
  acceptCards.forEach(done=>{try{done(false)}catch{}});acceptCards.clear();
  activeTransfers.forEach(t=>{t.abort=true;if(t.saveMode==='pair')try{window.pairSave.cancel()}catch{}if(t.writer)try{t.writer.abort()}catch{}});activeTransfers.clear();
  pendingFrames.clear();outTransfers.clear();
  pendingFrameBytes=0;
  transfers.innerHTML='';
  messages.querySelectorAll('.message .bubble > .transfer,.message .bubble > .accept-card').forEach(el=>el.closest('.message').remove());
}

// --- Voice call ---------------------------------------------------------------
// Start/stop a two-way audio call over the existing peer connection. The audio
// transceiver was negotiated during setup, so we only attach the mic here.
async function startLocalTestCall(){
  callStarting=true;
  if(micTestStream)stopMicrophoneTest();
  try{
    callStatus.textContent='Requesting mic…';callStatus.className='call-status ringing';
    localStream=await navigator.mediaDevices.getUserMedia(microphoneConstraints());
    monitorSpeaking('dm-self',localStream);
    dmCallPeerId=dmPeerId||activePeerId;callActive=true;callStart=Date.now();renderCallButtonState('end','End call','End local mic test');callBtn.disabled=false;muteBtn.hidden=false;micMuted=false;muteBtn.textContent='Mute';applyMicTransmission();setParticipant(participantYou,true);playSound('ring');callStatus.textContent='Testing microphone locally';callStatus.className='call-status live';
    callTimerId=setInterval(()=>{const s=Math.floor((Date.now()-callStart)/1000);callTimerEl.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');renderDmVoiceUI()},1000);
  }catch(e){callStatus.textContent='Mic test unavailable';callStatus.className='call-status'}finally{callStarting=false}
}
async function startCall(){
  // Guard against re-entry: a second click during getUserMedia or replaceTrack
  // would leak a MediaStream and drive concurrent instances through the state
  // machine. The flag is cleared in the finally block below.
  if(callActive||callStarting)return;if(!pc){if(LOCAL_TEST_MODE)return startLocalTestCall();return}if(micTestStream)stopMicrophoneTest();
  callStarting=true;
  friendLeftNotified=false;
  const gen=callGen;
  try{
    callStatus.textContent='Requesting mic…';callStatus.className='call-status ringing';
    localStream=await navigator.mediaDevices.getUserMedia(microphoneConstraints());
    if(!pc){localStream.getTracks().forEach(t=>t.stop());localStream=null;return}
    const track=localStream.getAudioTracks()[0];
    const allTransceivers=pc.getTransceivers();
    const tr=audioTransceiver||allTransceivers.find(t=>t.receiver.track?.kind==='audio'&&t.mid)||allTransceivers.find(t=>t.receiver.track?.kind==='audio')||(function(){try{return pc.addTransceiver('audio',{direction:'sendrecv'})}catch{return null}})();
    // audioTransceiver may be an RTCRtpSender (from addTrack) which has no .sender.
    // Resolve to the transceiver that owns it so sender.sender is correct.
    const resolvedTr=tr&&tr.mid===undefined&&!tr.sender?allTransceivers.find(t=>t.sender===tr)||tr:tr;
    const sender=resolvedTr?resolvedTr.sender:null;
    logCallEvent('Diag: startCall transceivers='+allTransceivers.length+' audioTr='+(tr?'ok:mid='+tr.mid+' dir='+tr.direction:'null')+' sender='+(sender?'ok':'null'));
    if(!sender){try{send({t:'call-end'})}catch{};endCall(true);callStatus.textContent='No audio sender available';callStatus.className='call-status';return}
    try{await sender.replaceTrack(track)}catch(e){try{send({t:'call-end'})}catch{};endCall(true);callStatus.textContent='Failed to attach mic: '+(e?.message||e);callStatus.className='call-status';return}
    // Voice must be scheduled ahead of a busy screen encoder. Restrict Opus to
    // 10–20 ms packets; the old 120 ms maximum made microphone delay obvious
    // whenever the renderer was under CPU pressure from a high-resolution share.
    try{const p=sender.getParameters();if(p){if(!p.encodings||!p.encodings.length)p.encodings=[{}];p.encodings[0].maxBitrate=256000;p.encodings[0].priority='high';p.encodings[0].networkPriority='high';if(p.codecs)p.codecs.forEach(c=>{if(c.mimeType.toLowerCase()==='audio/opus'){c.maxptime=20;c.ptime=10;if(c.parameters){c.parameters.maxaveragebitrate=256000;c.parameters.maxplaybackrate=48000;c.parameters.maxptime=20;c.parameters.minptime=10;c.parameters.useinbandfec=1;c.parameters.usedtx=0;c.parameters.cbr=1;c.parameters.stereo=1;c.parameters['sprop-stereo']=1;c.parameters.spropmaxcapturerate=48000}}});await sender.setParameters(p)}}catch(e){console.warn('opus params:',e)}
    // endCall may have run while we were awaiting getUserMedia or replaceTrack
    // (e.g. user clicked Stop Voice or the connection dropped). The generation
    // counter callGen is incremented by every endCall call. If it changed, bail.
    if(gen!==callGen||!pc){try{sender.replaceTrack(null)}catch{};if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}return}
    // endCall/disconnectRoom may have run during a nested await; if pc is gone bail.
    if(!pc){try{sender.replaceTrack(null)}catch{};if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}return}
    dmCallPeerId=dmPeerId||activePeerId;callActive=true;callStart=Date.now();monitorSpeaking('dm-self',localStream);setRemoteCallAudio(true);renderCallButtonState('end','End call','End voice call');callBtn.disabled=false;muteBtn.hidden=false;micMuted=false;muteBtn.textContent='Mute';muteBtn.title='Mute microphone';applyMicTransmission();
    try{remoteAudio.volume=0}catch{};setCallVolume(volumeSlider.value,false);volumeSlider.hidden=false;volumeValue.hidden=false;
    setParticipant(participantYou,true);logCallEvent('You joined the call');
    playSound('ring');publishCallState(true);try{send({t:'call-ring'})}catch{}
    callStatus.textContent='Voice live';callStatus.className='call-status live';
    callTimerId=setInterval(()=>{const s=Math.floor((Date.now()-callStart)/1000);const m=Math.floor(s/60),sec=s%60;callTimerEl.textContent=m+':'+String(sec).padStart(2,'0');renderDmVoiceUI()},1000);
  }catch(e){try{send({t:'call-end'})}catch{};endCall(true);const m=String(e?.message||e||'');if(/not\s*found/i.test(m))callStatus.textContent='No mic found — check your microphone connection';else if(/permission|denied|not\s*allowed/i.test(m))callStatus.textContent='Mic access blocked — allow microphone in browser/app settings';else callStatus.textContent='Mic error — '+(e?.message||e);callStatus.className='call-status';
  }finally{callStarting=false}
}
// Tear down the call and release the mic. `silent` skips UI churn when called
// from a disconnect.
async function endCall(silent){
  callGen++;abortScreenSharePicker();screenGen++;
  if(callActive&&!silent)publishCallState(false);
  stopSpeakingMonitor('dm-self');
  if(!silent){setParticipant(participantYou,false);logCallEvent('You left the call')}
  if(screenActive||screenStarting||screenStream)await stopScreenShare(true);
  if(callTimerId){clearInterval(callTimerId);callTimerId=null}
  callTimerEl.textContent='';
  // Stopping the local track silences our outgoing audio WITHOUT touching the
  // negotiated transceiver, so no renegotiation is triggered (the app doesn't
  // handle mid-call renegotiation). The peer's receiver just gets silence.
  if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}
  // Drop our sender's track so a stopped track doesn't linger on the transceiver
  // (which would otherwise keep matching in startCall and complicate reconnects).
  if(pc){try{pc.getSenders().forEach(s=>{if(s.track&&s.track.kind==='audio'){try{s.replaceTrack(null)}catch{}}})}catch{}}
  // Only clear the remote audio element's source when the room is left
  // (disconnectRoom), NOT on endCall. A temporary ICE drop would otherwise
  // null the srcObject and ontrack never fires again for the same transceiver,
  // permanently killing audio for the session.
  callActive=false;micMuted=false;syncVoiceStage();setRemoteCallAudio(false);
  if(!friendInCall)dmCallPeerId='';
  renderCallButtonState('start','Start call','Start voice call');muteBtn.hidden=true;volumeSlider.hidden=true;volumeValue.hidden=true;callStatus.textContent='Voice off';callStatus.className='call-status';
  if(!silent){callBtn.disabled=!pc&&!LOCAL_TEST_MODE;playSound('leave');try{send({t:'call-end'})}catch{}}
}
function toggleMute(){
  if(!localStream)return;
  micMuted=!micMuted;
  applyMicTransmission();
  if(micMuted){muteBtn.textContent='Unmute';muteBtn.title='Unmute microphone'}else if(voiceInputModeValue!=='ptt'){muteBtn.textContent='Mute';muteBtn.title='Mute microphone'}renderDmVoiceUI()
}
enableRangeDrag(volumeSlider);
callBtn.onclick=()=>{if(callActive)endCall(false);else{warmAudio();startCall()}};
muteBtn.onclick=toggleMute;
volumeSlider.oninput=()=>setCallVolume(volumeSlider.value);

// --- Screen share -------------------------------------------------------------
// Either peer can start/stop screen share, so either peer can drive a
// renegotiation. `renegotiating` is a generation counter: each call increments
// it and only the most-recent call is allowed to send its offer. That way a
// quick stop→start (or a preset change) supersedes any in-flight reneg.
let renegotiating=0;
// Glare guard: if we receive the peer's reneg-offer while we have one pending,
// we resolve it by role. The joiner defers (answers the host's offer instead of
// insisting on its own); the host wins. role is deterministic across peers.
let renegPending=false;
// A screen share has two negotiations: video immediately, then audio once the
// clean capture route is ready.  Do not create the latter offer while the
// former is still awaiting its answer.  Chrome rejects createOffer in
// have-local-offer, which made the audio sender local-only and resulted in a
// silent share.
function waitForStablePeer(target=pc,timeout=10000){
  if(!target||target.signalingState==='closed')return Promise.resolve(false);
  if(target.signalingState==='stable')return Promise.resolve(true);
  return new Promise(resolve=>{
    let finished=false;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);target.removeEventListener('signalingstatechange',check);target.removeEventListener('connectionstatechange',closed);resolve(value)};
    const check=()=>{if(target.signalingState==='stable')finish(true)};
    const closed=()=>{if(['closed','failed'].includes(target.connectionState)||target.signalingState==='closed')finish(false)};
    const timer=setTimeout(()=>finish(false),timeout);
    target.addEventListener('signalingstatechange',check);target.addEventListener('connectionstatechange',closed);
    check();
  });
}
async function renegotiate(){
  if(!pc||(!signaling&&chat?.readyState!=='open'))return;
  const target=pc;
  if(!await waitForStablePeer(target)){
    console.warn('renegotiate skipped: peer did not return to stable');
    return false;
  }
  if(!pc||pc!==target||target.signalingState!=='stable')return false;
  const myId=++renegotiating;
  renegPending=true;
  try{
    const offer=await pc.createOffer({iceRestart:false});
    if(!pc||pc!==target||myId!==renegotiating){renegPending=false;return false}
    await pc.setLocalDescription({type:'offer',sdp:patchSdp(offer.sdp)});
    if(!pc||pc!==target||myId!==renegotiating){renegPending=false;return false}
    await waitIce();
    if(!pc||pc!==target||myId!==renegotiating){renegPending=false;return false}
    if(signaling)signaling.send(JSON.stringify({type:'signal',payload:{kind:'reneg-offer',sdp:pc.localDescription.sdp}}));
    else if(chat?.readyState==='open')send({t:'reneg-offer',sdp:pc.localDescription.sdp});
    else{renegPending=false;return false}
    return true;
  }catch(e){console.warn('renegotiate error',e);return false}
  finally{if(myId===renegotiating)renegPending=false}
}
// Capture desktop sound for screen share while keeping Knot voice out of that
// mix. Windows uses process-loopback that excludes Knot's process tree; Linux
// uses a dedicated PipeWire sink. The voice call stays on its own WebRTC track.
function discardPrimedScreenAudioContext(){clearTimeout(primedScreenAudioTimer);primedScreenAudioTimer=null;const ctx=primedScreenAudioCtx;primedScreenAudioCtx=null;if(ctx)try{ctx.close()}catch{}}
function primeScreenAudioContext(){
  if(!['win32','linux'].includes(window.pairEnv?.platform))return;
  if(!primedScreenAudioCtx||primedScreenAudioCtx.state==='closed'){try{primedScreenAudioCtx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000})}catch{return}}
  try{primedScreenAudioCtx.resume()}catch{}
  clearTimeout(primedScreenAudioTimer);primedScreenAudioTimer=setTimeout(discardPrimedScreenAudioContext,120000);
}
function takeScreenAudioContext(){const ctx=primedScreenAudioCtx;primedScreenAudioCtx=null;clearTimeout(primedScreenAudioTimer);primedScreenAudioTimer=null;return ctx&&ctx.state!=='closed'?ctx:new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000})}
async function attemptAudioContextResume(ctx,timeoutMs=300){
  let timer;try{await Promise.race([Promise.resolve(ctx.resume()),new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs)})])}catch{}finally{clearTimeout(timer)}
}
async function ensureCaptureAudioContextRunning(ctx){
  if(ctx.state==='running')return;
  if(ctx.state==='closed')throw new Error('screen audio context closed before capture started');
  await attemptAudioContextResume(ctx);
  if(ctx.state==='running')return;
  // The display picker can consume the click activation that opened it. Give a
  // follow-up pointer/key gesture a short chance to unlock Web Audio, and never
  // label a suspended, permanently silent MediaStream track as healthy.
  await new Promise(resolve=>{
    let timer=null,done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);ctx.removeEventListener?.('statechange',changed);document.removeEventListener('pointerdown',unlock,true);document.removeEventListener('keydown',unlock,true);resolve()};
    const changed=()=>{if(ctx.state==='running'||ctx.state==='closed')finish()};
    const unlock=()=>{ctx.resume().then(changed).catch(()=>{})};
    ctx.addEventListener?.('statechange',changed);document.addEventListener('pointerdown',unlock,true);document.addEventListener('keydown',unlock,true);timer=setTimeout(finish,1800);
  });
  if(ctx.state!=='running')await attemptAudioContextResume(ctx);
  if(ctx.state!=='running')throw new Error('screen audio is waiting for an audio-output gesture');
}
async function setupNativeScreenCapture(){
  if(!window.pairCapture){
    console.warn('[AUDIO] isolated desktop capture unavailable; refusing full-mix loopback');
    return null;
  }

  if(screenCaptureOwner||screenCaptureCleanup)cleanupNativeScreenCapture();const attempt=++screenCaptureAttempt,isCurrent=()=>attempt===screenCaptureAttempt;let ctx,dest,op,unsubClean,unsubError,unsubFormat,addonData=false,captureClosed=false,captureFailure='',outputTrack=null;const captureOwner={};
  const dispose=(stopCapture=isCurrent())=>{captureClosed=true;if(unsubClean)unsubClean();if(unsubError)unsubError();if(unsubFormat)unsubFormat();if(stopCapture)try{window.pairCapture.stop()}catch{}try{op?.port.close()}catch{}try{op?.disconnect()}catch{}};
  try{
    ctx=takeScreenAudioContext();
    await ensureCaptureAudioContextRunning(ctx);
    dest=ctx.createMediaStreamDestination();dest.channelCount=2;
    await ctx.audioWorklet.addModule(new URL('screen-audio-worklet.js',location.href));
    op=new AudioWorkletNode(ctx,'knot-screen-audio',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
    op.connect(dest);
    unsubClean=window.pairCapture.onCleanAudio((buf,frames,metadata)=>{
      if(captureClosed||!isCurrent())return;
      const capturedAt=Number(metadata?.capturedAt);if(Number.isFinite(capturedAt)&&Date.now()-capturedAt>250)return;
      const arr=new Float32Array(buf),count=Math.max(0,Math.min(Math.floor(Number(frames)||0),arr.length));if(!count)return;
      const samples=new Float32Array(count*2);
      if(arr.length>=count*2)samples.set(arr.subarray(0,count*2));
      else for(let i=0;i<count;i++){const sample=arr[i]||0;samples[i*2]=sample;samples[i*2+1]=sample}
      try{op.port.postMessage(samples,[samples.buffer]);addonData=true}catch(error){captureFailure='audio worklet input failed: '+(error?.message||error)}
    });
    unsubError=window.pairCapture.onError(msg=>{
      if(!isCurrent())return;captureFailure=String(msg||'native capture failed');
      console.warn('[AUDIO] capture error:',captureFailure);
      // A failure after attachment must not leave a silent track labelled as
      // healthy. End it, release native capture, and expose the actual stage in
      // the same live status used for video quality diagnostics.
      if(outputTrack&&outputTrack.readyState==='live'){
        try{outputTrack.stop()}catch{}
        screenAudioDebug=' · sound capture stopped';
        if(screenActive)screenStatus.textContent='Sharing'+screenAudioDebug;
        queueMicrotask(()=>cleanupNativeScreenCapture(captureOwner));
      }
    });
    // The format notification means WASAPI initialized successfully. Do not
    // require audible samples to be playing during this short startup window;
    // an idle but valid loopback stream should still be attached to WebRTC.
    unsubFormat=window.pairCapture.onFormat?.(fmt=>{if(isCurrent()&&fmt?.available===false)captureFailure='WASAPI process-loopback format unavailable'});
    if(!isCurrent()){dispose(false);try{ctx.close()}catch{};return null}window.pairCapture.start();
    // Require one real PCM callback. A format-only notification can describe a
    // successfully initialized endpoint whose worker never actually delivers;
    // attaching that as "live" made receivers see a permanently silent track.
    const deadline=Date.now()+2500;
    while(isCurrent()&&!addonData&&!captureFailure&&Date.now()<deadline)await new Promise(r=>setTimeout(r,40));
    if(!isCurrent()||captureFailure||!addonData){
      console.warn('[AUDIO] isolated desktop capture did not initialize; sharing video only',captureFailure);
      dispose(isCurrent());
      if(ctx)try{ctx.close()}catch{}
      return null;
    }
    screenOutCtx=ctx;screenOutDest=dest;screenCaptureOwner=captureOwner;
    screenNative=true;
    outputTrack=dest.stream.getAudioTracks()[0];if(outputTrack)outputTrack._knotCaptureOwner=captureOwner;
    try{if(outputTrack)outputTrack.contentHint='music'}catch{}
    screenCaptureCleanup=()=>dispose(true);if(!outputTrack){cleanupNativeScreenCapture(captureOwner);return null}return outputTrack;
  }catch(e){
    console.warn('[AUDIO] isolated desktop capture failed:',e?.message||e);
    dispose(isCurrent());
    if(ctx)try{ctx.close()}catch{}
    return null;
  }
}
function cleanupNativeScreenCapture(owner=null){
  if(owner&&owner!==screenCaptureOwner)return false;
  screenCaptureAttempt++;
  screenNative=false;
  if(screenCaptureCleanup){try{screenCaptureCleanup()}catch{};screenCaptureCleanup=null}
  if(screenOutDest){screenOutDest=null}
  if(screenOutCtx){try{screenOutCtx.close()}catch{};screenOutCtx=null}
  screenCaptureOwner=null;return true
}
async function testScreenAudioIsolation(button,status){
  if(screenActive||screenStarting){status.dataset.state='error';status.textContent='Stop the current screen share before testing its audio route.';return}
  button.disabled=true;status.dataset.state='testing';status.textContent='Testing the isolated OS audio route…';
  const unsubs=[];
  try{
    if(window.pairEnv?.platform==='linux'){
      let chunks=0,bytes=0,error='';
      unsubs.push(window.pairEnv.onLinuxShareAudio?.(buf=>{chunks++;bytes+=buf?.byteLength||0}));
      unsubs.push(window.pairEnv.onLinuxShareAudioError?.(message=>{error=String(message||'capture failed')}));
      const route=await window.pairEnv.startLinuxShareAudio?.();
      if(!route)throw new Error('PipeWire isolation route could not be created');
      const deadline=Date.now()+2000;while(!chunks&&!error&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,40));
      if(error)throw new Error(error);if(!chunks)throw new Error('PipeWire monitor returned no PCM packets');
      status.dataset.state='ready';status.textContent=`Ready — isolated 48 kHz stereo route delivered ${chunks} packet${chunks===1?'':'s'} (${bytes.toLocaleString()} bytes).`;
    }else if(window.pairEnv?.platform==='win32'){
      let format=null,frames=0,error='';
      unsubs.push(window.pairCapture?.onFormat?.(value=>{if(value?.available!==false)format=value}));
      unsubs.push(window.pairCapture?.onCleanAudio?.((_buf,count)=>{frames+=Number(count)||0}));
      unsubs.push(window.pairCapture?.onError?.(message=>{error=String(message||'capture failed')}));
      window.pairCapture?.start?.();
      const deadline=Date.now()+2500;while(!frames&&!error&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,40));
      if(error)throw new Error(error);if(!frames)throw new Error('WASAPI process-loopback initialized but delivered no PCM packets');
      status.dataset.state='ready';status.textContent=`Ready — WASAPI process isolation delivered ${frames.toLocaleString()} frames${format?.sampleRate?' at '+format.sampleRate.toLocaleString()+' Hz':''}${format?.channels?' · '+format.channels+' channels':''}.`;
    }else throw new Error('isolated computer-audio capture is available in the Windows and Linux apps');
  }catch(error){
    const message=String(error?.message||error||'unknown error').replace(/\s+/g,' ').slice(0,240);
    status.dataset.state='error';status.textContent='Unavailable — '+message+'. Screen video remains safe; Knot will not fall back to an echoing whole-system mix.';
  }finally{
    if(window.pairEnv?.platform==='linux')try{window.pairEnv.stopLinuxShareAudio?.()}catch{}
    else try{window.pairCapture?.stop?.()}catch{}
    unsubs.forEach(unsub=>{try{unsub?.()}catch{}});button.disabled=false;
  }
}
async function linuxShareAudioTrack(){
  if(!window.pairEnv?.startLinuxShareAudio||!window.pairEnv?.onLinuxShareAudio)return null;
  if(screenCaptureOwner||screenCaptureCleanup)cleanupNativeScreenCapture();const attempt=++screenCaptureAttempt,isCurrent=()=>attempt===screenCaptureAttempt;let ctx,dest,op,unsubData,unsubError,received=false,captureError='';const captureOwner={};
  const dispose=(stopCapture=isCurrent())=>{if(unsubData)unsubData();if(unsubError)unsubError();if(stopCapture)window.pairEnv.stopLinuxShareAudio?.();try{op?.port.close()}catch{}try{op?.disconnect()}catch{}};
  try{
    ctx=takeScreenAudioContext();
    await ensureCaptureAudioContextRunning(ctx);
    dest=ctx.createMediaStreamDestination();dest.channelCount=2;
    // ScriptProcessor callbacks run on the renderer main thread and glitch when
    // a high-resolution share makes Chromium busy. The AudioWorklet owns its
    // jitter buffer on the real-time audio thread, independent of UI/encoding.
    await ctx.audioWorklet.addModule(new URL('screen-audio-worklet.js',location.href));
    op=new AudioWorkletNode(ctx,'knot-screen-audio',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
    unsubData=window.pairEnv.onLinuxShareAudio(buf=>{if(!isCurrent())return;
      const arr=new Float32Array(buf);if(!arr.length)return;received=true;
      try{op.port.postMessage(arr,[arr.buffer])}catch{op.port.postMessage(arr)}
    });
    unsubError=window.pairEnv.onLinuxShareAudioError?.(message=>{if(!isCurrent())return;captureError=String(message||'capture failed');console.warn('[AUDIO] PipeWire capture error:',captureError)});
    const share=await window.pairEnv.startLinuxShareAudio();if(!isCurrent()){dispose(false);try{ctx.close()}catch{};return null}if(!share)throw new Error('PipeWire share route could not be created');
    const deadline=Date.now()+2500;while(isCurrent()&&!received&&!captureError&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,40));if(!isCurrent()){dispose(false);try{ctx.close()}catch{};return null}
    if(!received)throw new Error(captureError||'PipeWire monitor produced no samples');
    op.connect(dest);screenOutCtx=ctx;screenOutDest=dest;screenNative=true;screenCaptureOwner=captureOwner;
    const track=dest.stream.getAudioTracks()[0]||null;if(track)track._knotCaptureOwner=captureOwner;try{if(track)track.contentHint='music'}catch{}
    screenCaptureCleanup=()=>dispose(true);if(!track){cleanupNativeScreenCapture(captureOwner);return null}return track;
  }catch(e){
    console.warn('[AUDIO] direct PipeWire capture failed:',e?.message||e);
    screenAudioDebug=' · PipeWire capture unavailable';
    dispose(isCurrent());try{ctx?.close()}catch{};return null;
  }
}
function displayCaptureRequest(){return{video:true}}
async function captureDisplayStream(){
  try{return await navigator.mediaDevices.getDisplayMedia(displayCaptureRequest())}
  catch(error){if(!/invalid capture constraints/i.test(String(error?.message||error)))throw error;return navigator.mediaDevices.getDisplayMedia({video:{}})}
}
async function tuneDisplayTrack(track){
  if(!track?.applyConstraints)return;
  const fps=shareFrameRate===30?30:60,heights={720:720,1080:1080,1440:1440,2160:2160},height=heights[shareResolution],width=height?Math.round(height*16/9):null,constraints={frameRate:{ideal:fps,max:fps}};
  // The selected preset is a contract. Using ideal/max let Chromium silently
  // start a 4K share at 1080p, while sender-side recovery scaled it again.
  // Apply dimensions after source selection and fail clearly when the source
  // cannot provide them instead of changing quality behind the user's back.
  if(width&&height){constraints.width={exact:width};constraints.height={exact:height}}
  try{if(navigator.mediaDevices.getSupportedConstraints?.().cursor)constraints.cursor=screenCursor}catch{}
  const maximumFps=Number(track.getCapabilities?.().frameRate?.max);if(Number.isFinite(maximumFps)&&maximumFps>0&&maximumFps<fps-1)throw new Error(`The selected source supports up to ${maximumFps.toFixed(1)} fps; ${fps} fps was selected`);
  try{await track.applyConstraints(constraints)}catch(error){const preset=width&&height?`${width}×${height} at ${fps} fps`:`source resolution at ${fps} fps`;throw new Error(`The selected source cannot capture ${preset}: ${error?.message||error}`)}
}
function validateDisplayCaptureSettings({width=0,height=0,frameRate=0}={}){
  const requestedHeight={720:720,1080:1080,1440:1440,2160:2160}[shareResolution],requestedWidth=requestedHeight?Math.round(requestedHeight*16/9):0,requestedFps=shareFrameRate===30?30:60,configuredFps=Number(frameRate)||0;
  if(requestedWidth&&(width!==requestedWidth||height!==requestedHeight))throw new Error(`Capture returned ${width}×${height}; ${requestedWidth}×${requestedHeight} was selected`);
  // 59.94/29.97 desktop clocks are the selected 60/30 targets in practice.
  // A missing setting is tolerated because some portals omit it; live sender
  // and receiver statistics still report the actual delivered cadence.
  if(configuredFps&&Math.abs(configuredFps-requestedFps)>1)throw new Error(`Capture configured ${configuredFps.toFixed(1)} fps; ${requestedFps} fps was selected`);
  return{width,height,fps:configuredFps?Math.round(configuredFps):0}
}
async function waitForDisplayFrames(track,timeoutMs=4000){
  if(!track||track.readyState==='ended')throw new Error('The selected screen capture ended before it produced video');
  const video=document.createElement('video');video.muted=true;video.playsInline=true;video.srcObject=new MediaStream([track]);let timer;
  try{
    await video.play();
    await new Promise((resolve,reject)=>{let settled=false;const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve()};timer=setTimeout(()=>finish(new Error('Screen capture produced no video frames')),timeoutMs);if(typeof video.requestVideoFrameCallback==='function')video.requestVideoFrameCallback(()=>finish());else video.addEventListener('loadeddata',()=>finish(),{once:true});track.addEventListener('ended',()=>finish(new Error('The selected screen capture ended')),{once:true})});
    const settings=track.getSettings?.()||{},width=settings.width||video.videoWidth||0,height=settings.height||video.videoHeight||0;if(!width||!height)throw new Error('Screen capture returned an empty video target');return validateDisplayCaptureSettings({width,height,frameRate:settings.frameRate});
  }finally{clearTimeout(timer);video.pause();video.srcObject=null}
}
function compatibilityScreenCodec(){return window.pairEnv?.platform==='linux'?'VP9':'H264'}
function orderedScreenCodecs(caps,selectedCodec=screenCodec){
  const compatibility=compatibilityScreenCodec(),automatic=compatibility==='VP9'?['VP9','VP8','H264','AV1']:['H264','VP9','VP8','AV1'],requested=selectedCodec==='auto'?automatic:[selectedCodec,...automatic],order=[...new Set(requested.map(name=>name.toUpperCase()))],seen=new Set(),result=[];
  for(const name of order)for(const codec of caps?.codecs||[]){if(codec.mimeType?.toUpperCase()!==`VIDEO/${name}`||seen.has(codec))continue;seen.add(codec);result.push(codec)}
  for(const codec of caps?.codecs||[]){if(!seen.has(codec)&&/^video\/(?:rtx|red|ulpfec|flexfec)/i.test(codec.mimeType||'')){seen.add(codec);result.push(codec)}}
  return result;
}
function applyScreenCodecPreference(connection,sender,selectedCodec=screenCodec){
  try{const transceiver=connection?.getTransceivers?.().find(value=>value.sender===sender),caps=RTCRtpSender.getCapabilities?.('video'),codecs=orderedScreenCodecs(caps,selectedCodec);if(transceiver&&codecs.length)transceiver.setCodecPreferences(codecs);return codecs.some(codec=>codec.mimeType?.toUpperCase()===`VIDEO/${selectedCodec}`)}catch(error){console.warn('[VIDEO] codec preference unavailable:',error?.message||error);return false}
}
async function switchScreenCodec(codec){
  if(!pc||!screenActive)return false;const sender=screenSenders.find(value=>value.track?.kind==='video');if(!sender||!applyScreenCodecPreference(pc,sender,codec))return false;
  try{if(!await renegotiate())throw new Error('codec renegotiation did not start');screenStatus.textContent='Sharing · switched to '+codec+' for compatibility'+screenAudioDebug;return true}catch(error){console.warn('[VIDEO] codec fallback failed:',error?.message||error);return false}
}
function targetScreenBitrate(width,height,fps){
  const pixels=Math.max(1,(Number(width)||1920)*(Number(height)||1080)),cadence=Number(fps)===30?.62:1,ratio=pixels/(1920*1080),selected=String(screenCodec||'auto').toUpperCase(),codec=selected==='AUTO'?compatibilityScreenCodec():selected,base1080=codec==='AV1'?5.5:codec==='VP9'?6.5:8,base=base1080*Math.pow(ratio,.65)*cadence;
  const compatibilityCap=screenFallbackBitrateCapMbps>0?screenFallbackBitrateCapMbps:Infinity;
  return Math.round(Math.min(screenBitrateMbps,compatibilityCap,Math.max(2,base))*1000000);
}
async function configureScreenVideoSender(sender,track,fps,viewers=1){
  const settings=track?.getSettings?.()||{},requestedFps=fps===30?30:60,maxBitrate=Math.max(2000000,Math.round(targetScreenBitrate(settings.width,settings.height,requestedFps)/Math.max(1,Number(viewers)||1)));
  const parameters=sender.getParameters();if(!parameters.encodings?.length)parameters.encodings=[{}];const encoding=parameters.encodings[0];encoding.maxBitrate=maxBitrate;delete encoding.minBitrate;encoding.maxFramerate=requestedFps;encoding.scaleResolutionDownBy=1;encoding.priority='medium';encoding.networkPriority='low';parameters.degradationPreference='maintain-resolution';await sender.setParameters(parameters);
}
function startScreenStats(sender){
  if(screenStatsTimer)clearInterval(screenStatsTimer);screenStatsLast=null;
  const sample=async()=>{try{
    if(!screenActive)return;const reports=await sender.getStats();let out,codec,remote,candidatePair,localCandidate,remoteCandidate;
    reports.forEach(report=>{if(report.type==='outbound-rtp'&&(report.kind==='video'||report.mediaType==='video')&&!report.isRemote)out=report;if(report.type==='remote-inbound-rtp'&&(report.kind==='video'||report.mediaType==='video'))remote=report;if(report.type==='candidate-pair'&&report.state==='succeeded'&&(report.nominated||!candidatePair))candidatePair=report});if(!out)return;
    codec=reports.get(out.codecId);if(candidatePair){localCandidate=reports.get(candidatePair.localCandidateId);remoteCandidate=reports.get(candidatePair.remoteCandidateId)}
    const now=performance.now(),previous=screenStatsLast,bytes=Number(out.bytesSent)||0,frames=Number(out.framesEncoded)||0,totalEncode=Number(out.totalEncodeTime)||0;let mbps='…',encodeMs=0,encodedDelta=0;
    if(previous&&now>previous.at){mbps=(((bytes-previous.bytes)*8)/(now-previous.at)/1000).toFixed(1);encodedDelta=frames-previous.frames;encodeMs=encodedDelta>0?(totalEncode-previous.totalEncode)/encodedDelta*1000:0}
    screenStatsLast={bytes,frames,totalEncode,at:now};const fps=Math.round(out.framesPerSecond||0),w=out.frameWidth||0,h=out.frameHeight||0,reason=out.qualityLimitationReason||'';
    const route=candidatePair?.currentRoundTripTime??remote?.roundTripTime,available=candidatePair?.availableOutgoingBitrate,network=(localCandidate&&remoteCandidate?' · '+(localCandidate.candidateType||'?')+'→'+(remoteCandidate.candidateType||'?'):'')+(Number.isFinite(route)?' · '+Math.round(route*1000)+'ms':'')+(Number.isFinite(available)?' · '+(available/1e6).toFixed(0)+' Mbps available':'');
    const limitation=reason&&reason!=='none'?` · ${reason} limited (resolution locked)`:'';const status='Sharing'+(w&&h?' · '+w+'×'+h:'')+(fps?' · '+fps+'fps':'')+(mbps!=='…'?' · '+mbps+' Mbps':'')+(codec?.mimeType?' · '+codec.mimeType.replace('video/',''):'')+(encodeMs?' · '+encodeMs.toFixed(1)+'ms encode':'')+network+limitation+screenAudioDebug;screenStatus.textContent=status;screenBtn.title=status;
  }catch{}};
  sample();screenStatsTimer=setInterval(sample,2000);
}
const NATIVE_SCREEN_PACKET=0x4b4e5331,NATIVE_SCREEN_PART=60*1024,NATIVE_SCREEN_BUFFER_HIGH=512*1024,NATIVE_SCREEN_BUFFER_LOW=96*1024,NATIVE_SCREEN_MAX_SEGMENT=4*1024*1024,NATIVE_SCREEN_BUFFER_HARD=NATIVE_SCREEN_MAX_SEGMENT+128*1024,NATIVE_SCREEN_GAP_WAIT=80,NATIVE_SCREEN_PROTOCOL=2,NATIVE_SCREEN_STALE_MS=300;
// A 4K60 AV1 key cluster is routinely larger than the old fixed 320 KiB
// watermark. Admission now includes the entire segment and grants legitimate
// keyframe bursts more room, while small delta frames still meet the tighter
// steady-state watermark so a truly slow peer cannot build seconds of latency.
function nativeScreenBufferBudget(segmentBytes=0){return Math.min(NATIVE_SCREEN_BUFFER_HARD,Math.max(NATIVE_SCREEN_BUFFER_HIGH,Math.max(0,Number(segmentBytes)||0)*2+NATIVE_SCREEN_BUFFER_LOW))}
// 4K60 AV1 requires level 6.1 high tier. Advertising main tier made Chromium
// accept the WebM container but hand an incompatible profile to VA-API, which
// produced a black frame and then fell back to CPU decoding on NVIDIA/AMD.
function nativeScreenMime(codec='AV1'){return codec.toUpperCase()==='AV1'?'video/webm; codecs="av01.0.13H.08"':''}
function createNativeScreenPlaceholder(video,options={}){
  let canvas=null,context=null,destroyed=false,active=true;try{canvas=document.createElement('canvas');canvas.className='native-screen-canvas';canvas.setAttribute('aria-hidden','true');canvas.width=960;canvas.height=540;context=canvas.getContext('2d',{alpha:false,desynchronized:true});if(!context)return null;video.after(canvas);video.style.opacity='0';try{video.pause();video.removeAttribute('src');video.srcObject=null}catch{}context.fillStyle='#050609';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='#d8dbe4';context.font='600 24px system-ui';context.textAlign='center';context.fillText('Share is live',canvas.width/2,canvas.height/2-8);context.fillStyle='#8e95a5';context.font='16px system-ui';context.fillText('Local preview paused to protect voice and game performance',canvas.width/2,canvas.height/2+25)}catch{return null}
  return{mode:'placeholder',append(){return !destroyed},reset(){return !destroyed},setActive(value){active=!!value;if(canvas)canvas.hidden=!active},destroy(){if(destroyed)return;destroyed=true;canvas?.remove();video.style.opacity='';try{video.pause();video.srcObject=null;video.removeAttribute('src');video.load()}catch{}},stats(){return{decodedFrames:0,paintedFrames:0,width:Number(options.width)||0,height:Number(options.height)||0,decodeQueueSize:0,softwareFallback:false,hardwareUnavailable:false,decodeDisabled:true}}}
}
function createWebCodecsNativeScreenPlayer(video,codec,onError=()=>{},options={}){
  if(options.decode===false)return createNativeScreenPlaceholder(video,options);
  const parser=window.KnotNativeVideo;if(codec.toUpperCase()!=='AV1'||!parser||typeof VideoDecoder!=='function')return null;
  const allowSoftwareFallback=options.allowSoftwareFallback!==false,preferSoftware=options.preferSoftware===true,enforceLatencyTarget=options.enforceLatencyTarget!==false,fps=Number(options.fps)||60,configuredWidth=Number(options.width)||0,configuredHeight=Number(options.height)||0;
  const frameIntervalMs=1000/Math.max(1,fps),maxPresentationFrames=Math.max(4,Math.ceil(fps*.1));
  let canvas=null,context=null,trackGenerator=null,frameWriter=null,frameWriterBusy=false,presentationQueue=[],presentationTimer=null,presentationClockTimestamp=null,presentationClockAt=0,presentationGeneration=0,presentationMode='canvas',presentationDroppedFrames=0,renderedFrames=0,lastRenderedAt=0,decoder=null,config=null,configured=false,destroyed=false,decoderDisabled=false,failureReported=false,latencyExceeded=false,latencyViolationWindows=0,playbackActive=true,decodedFrames=0,paintedFrames=0,firstPaintAt=0,frameWidth=0,frameHeight=0,softwareFallback=preferSoftware,hardwareUnavailable=false,replay=[],queuedSinceOutput=0,configuredAt=0,lastOutputAt=0,needsKeyframe=true;const arrivalTimes=new Map(),latencySamples=[],renderIntervals=[];
  const closeDecoderSoon=value=>{if(!value)return;queueMicrotask(()=>{try{value.close()}catch{}})};
  const resetPresentation=()=>{clearTimeout(presentationTimer);presentationTimer=null;for(const frame of presentationQueue){arrivalTimes.delete(frame.timestamp);try{frame.close()}catch{}}presentationQueue=[];presentationClockTimestamp=null;presentationClockAt=0};
  const fail=error=>{if(destroyed||failureReported)return;failureReported=true;decoderDisabled=true;resetPresentation();const failed=decoder;decoder=null;closeDecoderSoon(failed);const reason=error instanceof Error?error:new Error(String(error||'Native AV1 low-latency decode failed'));queueMicrotask(()=>{if(!destroyed)onError(reason)})};
  const drawPreviewUnavailable=()=>{if(!canvas||!context)return;canvas.width=960;canvas.height=540;context.fillStyle='#050609';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='#d8dbe4';context.font='600 24px system-ui';context.textAlign='center';context.fillText('Share is live',canvas.width/2,canvas.height/2-8);context.fillStyle='#8e95a5';context.font='16px system-ui';context.fillText('Local AV1 preview paused to protect performance',canvas.width/2,canvas.height/2+25)};
  const recordPresentation=(timestamp,paintedAt)=>{
    paintedFrames++;if(!firstPaintAt)firstPaintAt=paintedAt;const arrivedAt=arrivalTimes.get(timestamp);arrivalTimes.delete(timestamp);if(arrivedAt===undefined)return;
    latencySamples.push(paintedAt-arrivedAt);if(latencySamples.length>360)latencySamples.shift();
    // A single scheduling/driver spike used to tear down a healthy AV1 share,
    // recapture the desktop, and jump to a much larger H.264 stream. Enforce the
    // same 100 ms target only after eight consecutive bad one-second windows;
    // healthy windows reset the streak immediately.
    if(enforceLatencyTarget&&latencySamples.length>=120&&paintedFrames%15===0){const recent=latencySamples.slice(-60).sort((a,b)=>a-b),p95=recent[Math.ceil(recent.length*.95)-1];if(p95>100)latencyViolationWindows++;else latencyViolationWindows=0;if(latencyViolationWindows>=8){latencyViolationWindows=0;latencySamples.length=0;if(!softwareFallback)startSoftwareDecoder(new Error('Hardware AV1 decode remained above the 100ms latency target'));else{latencyExceeded=true;fail(new Error('AV1 software decode remained above the 100ms latency target'))}}}
  };
  const noteRendered=now=>{renderedFrames++;if(lastRenderedAt){renderIntervals.push(now-lastRenderedAt);if(renderIntervals.length>360)renderIntervals.shift()}lastRenderedAt=now};
  const presentFrame=frame=>{
    if(destroyed||decoderDisabled||!playbackActive){arrivalTimes.delete(frame.timestamp);try{frame.close()}catch{};return}
    const timestamp=frame.timestamp,generation=presentationGeneration;
    if(frameWriter){if(frameWriterBusy){arrivalTimes.delete(timestamp);presentationDroppedFrames++;try{frame.close()}catch{};return}frameWriterBusy=true;Promise.resolve(frameWriter.ready).then(()=>{if(destroyed||generation!==presentationGeneration||!playbackActive)return false;return Promise.resolve(frameWriter.write(frame)).then(()=>true)}).then(written=>{if(written&&!destroyed&&generation===presentationGeneration&&playbackActive)recordPresentation(timestamp,performance.now());else arrivalTimes.delete(timestamp)}).catch(error=>{arrivalTimes.delete(timestamp);if(!destroyed)fail(error)}).finally(()=>{try{frame.close()}catch{}frameWriterBusy=false;schedulePresentation()});return}
    if(canvas.width!==frameWidth||canvas.height!==frameHeight){canvas.width=frameWidth;canvas.height=frameHeight}
    try{context.drawImage(frame,0,0,canvas.width,canvas.height);const now=performance.now();recordPresentation(timestamp,now);noteRendered(now)}catch(error){fail(error)}finally{try{frame.close()}catch{}}
  };
  const schedulePresentation=()=>{
    if(presentationTimer||frameWriterBusy||destroyed||decoderDisabled||!playbackActive||!presentationQueue.length)return;
    let frame=presentationQueue[0],now=performance.now();
    if(presentationClockTimestamp===null){presentationClockTimestamp=frame.timestamp;presentationClockAt=now+Math.min(20,frameIntervalMs)}
    let due=presentationClockAt+(frame.timestamp-presentationClockTimestamp)/1000;
    if(now-due>Math.max(35,frameIntervalMs*2)){
      while(presentationQueue.length>1){const nextDue=presentationClockAt+(presentationQueue[1].timestamp-presentationClockTimestamp)/1000;if(nextDue>now-frameIntervalMs)break;const stale=presentationQueue.shift();arrivalTimes.delete(stale.timestamp);try{stale.close()}catch{}presentationDroppedFrames++}
      frame=presentationQueue[0];presentationClockTimestamp=frame.timestamp;presentationClockAt=now;due=now;
    }
    const run=()=>{presentationTimer=null;if(destroyed||decoderDisabled||!playbackActive){resetPresentation();return}const next=presentationQueue.shift();if(next)presentFrame(next);schedulePresentation()};
    const delay=due-now;if(delay>1)presentationTimer=setTimeout(run,delay);else{presentationTimer=-1;queueMicrotask(run)}
  };
  const output=frame=>{
    if(destroyed||decoderDisabled){frame.close();return}decodedFrames++;queuedSinceOutput=0;lastOutputAt=performance.now();frameWidth=frame.displayWidth||frame.codedWidth;frameHeight=frame.displayHeight||frame.codedHeight;
    if(!playbackActive){arrivalTimes.delete(frame.timestamp);frame.close();return}
    presentationQueue.push(frame);if(presentationQueue.length>maxPresentationFrames){clearTimeout(presentationTimer);presentationTimer=null;const stale=presentationQueue.shift();arrivalTimes.delete(stale.timestamp);try{stale.close()}catch{}presentationDroppedFrames++;presentationClockTimestamp=null}schedulePresentation()
  };
  const startSoftwareDecoder=error=>{
    if(destroyed||decoderDisabled)return false;
    if(!allowSoftwareFallback){hardwareUnavailable=true;fail(error);return false}
    if(softwareFallback){fail(error);return false}
    const previous=decoder;let next=null;softwareFallback=true;presentationGeneration++;resetPresentation();latencySamples.length=0;latencyViolationWindows=0;
    try{next=makeDecoder('prefer-software');next.configure({...config,hardwareAcceleration:'prefer-software'});decoder=next;closeDecoderSoon(previous);configuredAt=performance.now();lastOutputAt=configuredAt;queuedSinceOutput=0;needsKeyframe=true;for(const frame of replay){if(needsKeyframe&&frame.type!=='key')continue;if(frame.type==='key')needsKeyframe=false;arrivalTimes.set(frame.timestamp,performance.now());queuedSinceOutput++;decoder.decode(new EncodedVideoChunk(frame))}return true}catch(fallbackError){closeDecoderSoon(next);decoder=previous;fail(fallbackError);return false}
  };
  const makeDecoder=hardwareAcceleration=>{
    const instance=new VideoDecoder({output:frame=>{if(destroyed||decoder!==instance){frame.close();return}output(frame)},error:error=>{
      if(destroyed||decoder!==instance)return;
      // Chromium/NVIDIA VA-API can advertise AV1 but reject the first picture.
      // Retry only after that concrete hardware failure. AMD VA-API and native
      // Windows decoders remain on hardware and never enter this branch.
      if(hardwareAcceleration==='prefer-hardware'&&!softwareFallback&&config){startSoftwareDecoder(error);return}
      fail(error);
    }});return instance;
  };
  try{
    try{video.pause();video.removeAttribute('src');video.srcObject=null}catch{}
    if(typeof MediaStreamTrackGenerator==='function')try{trackGenerator=new MediaStreamTrackGenerator({kind:'video'});frameWriter=trackGenerator.writable.getWriter();video.srcObject=new MediaStream([trackGenerator]);video.autoplay=true;video.playsInline=true;video.style.opacity='';presentationMode='track';video.play().catch(()=>{});if(typeof video.requestVideoFrameCallback==='function'){const rendered=(now)=>{if(destroyed)return;if(playbackActive)noteRendered(now);video.requestVideoFrameCallback(rendered)};video.requestVideoFrameCallback(rendered)}}catch{try{frameWriter?.abort()}catch{}try{trackGenerator?.stop()}catch{}frameWriter=null;trackGenerator=null}
    if(!frameWriter){canvas=document.createElement('canvas');canvas.className='native-screen-canvas';canvas.setAttribute('aria-hidden','true');context=canvas.getContext('2d',{alpha:false,desynchronized:true});if(!context)return null;video.after(canvas);video.style.opacity='0';presentationMode='canvas'}
    decoder=makeDecoder(preferSoftware?'prefer-software':'prefer-hardware');lastOutputAt=performance.now();
  }catch{return null}
  const stallTimer=setInterval(()=>{if(destroyed||decoderDisabled||!configured||queuedSinceOutput<18)return;const now=performance.now();if(now-Math.max(lastOutputAt,configuredAt)<750)return;if(!softwareFallback)startSoftwareDecoder(new Error('Hardware AV1 decoder produced no frames'));else fail(new Error('AV1 decoder produced no frames'))},200);
  return{
    mode:'webcodecs',
    append(data){
      if(destroyed)return false;if(decoderDisabled)return !failureReported;const bytes=data instanceof Uint8Array?data:new Uint8Array(data);
      try{
        if(bytes.length>=4&&bytes[0]===0x1f&&bytes[1]===0x43&&bytes[2]===0xb6&&bytes[3]===0x75){
          if(!configured)throw new Error('Native AV1 decoder received frames before configuration');
          for(const frame of parser.webmAv1Frames(bytes,fps)){if(frame.type==='key'){replay=[];needsKeyframe=false}if(needsKeyframe)continue;replay.push(frame);if(replay.length>Math.max(120,fps*2))replay.shift();arrivalTimes.set(frame.timestamp,performance.now());queuedSinceOutput++;decoder.decode(new EncodedVideoChunk(frame))}
          if(decoder?.decodeQueueSize>180)throw new Error('Native AV1 hardware decoder fell behind');
        }else if(!configured){
          const description=parser.av1Description(bytes);if(!description)throw new Error('Native AV1 configuration was not found');
          // AV1 WebCodecs consumes the low-overhead bitstream carried by WebM;
          // unlike H.264, its registration explicitly leaves `description`
          // unused. CodecPrivate is inspected only to build the exact profile,
          // level, tier, and bit-depth string.
          config={codec:parser.av1Codec(description),hardwareAcceleration:preferSoftware?'prefer-software':'prefer-hardware',optimizeForLatency:true};if(configuredWidth&&configuredHeight){config.codedWidth=configuredWidth;config.codedHeight=configuredHeight;config.displayAspectWidth=configuredWidth;config.displayAspectHeight=configuredHeight}try{decoder.configure(config)}catch(error){if(!startSoftwareDecoder(error))throw error}configured=true;needsKeyframe=true;configuredAt=performance.now();lastOutputAt=configuredAt;
        }
        return true;
      }catch(error){fail(error);return false}
    },
    reset(){if(destroyed||decoderDisabled||!decoder)return false;presentationGeneration++;resetPresentation();replay=[];arrivalTimes.clear();latencySamples.length=0;latencyViolationWindows=0;queuedSinceOutput=0;needsKeyframe=true;try{decoder.reset();if(config)decoder.configure({...config,hardwareAcceleration:softwareFallback?'prefer-software':'prefer-hardware'});configured=!!config;configuredAt=performance.now();lastOutputAt=configuredAt;return true}catch(error){fail(error);return false}},
    setActive(active){playbackActive=!!active;if(canvas)canvas.hidden=!playbackActive;try{if(trackGenerator)trackGenerator.enabled=playbackActive}catch{}if(!playbackActive){presentationGeneration++;resetPresentation();try{video.pause()}catch{}}else{presentationClockTimestamp=null;if(frameWriter)video.play().catch(()=>{});schedulePresentation()}},
    destroy(){if(destroyed)return;destroyed=true;presentationGeneration++;clearInterval(stallTimer);resetPresentation();try{decoder?.close()}catch{}try{const aborted=frameWriter?.abort(new Error('AV1 player closed'));aborted?.catch?.(()=>{})}catch{}try{trackGenerator?.stop()}catch{}canvas?.remove();video.style.opacity='';try{video.pause();video.srcObject=null;video.removeAttribute('src');video.load()}catch{}},
    stats(){const steady=latencySamples.slice(-120).sort((a,b)=>a-b),p95=steady.length?steady[Math.min(steady.length-1,Math.ceil(steady.length*.95)-1)]:0,cadence=[...renderIntervals.slice(-120)].sort((a,b)=>a-b),cadenceP95=cadence.length?cadence[Math.min(cadence.length-1,Math.ceil(cadence.length*.95)-1)]:0,mean=renderIntervals.slice(-120).reduce((sum,value)=>sum+value,0)/Math.max(1,Math.min(120,renderIntervals.length)),actualRendered=presentationMode==='track'?renderedFrames:paintedFrames;return{decodedFrames,paintedFrames:actualRendered,submittedFrames:paintedFrames,renderedFrames:actualRendered,renderFps:mean?1000/mean:0,renderCadenceP95Ms:cadenceP95,firstPaintAt,width:frameWidth,height:frameHeight,decodeQueueSize:decoderDisabled?0:decoder?.decodeQueueSize||0,softwareFallback,hardwareUnavailable,latencyExceeded,latencyViolationWindows,steadyStateP95Ms:p95,latencySamples:steady.length,presentationMode,presentationDroppedFrames,presentationQueueFrames:presentationQueue.length+(frameWriterBusy?1:0)}}
  };
}
function createMseNativeScreenPlayer(video,codec,onError=()=>{},options={}){
  const mime=nativeScreenMime(codec);if(!mime||!window.MediaSource?.isTypeSupported?.(mime))throw new Error('Native '+codec+' playback is not supported');
  const configuredWidth=Number(options.width)||0,configuredHeight=Number(options.height)||0,targetLag=.25,startLag=.18,hardCatchupLag=.6;
  let source=null,url='',buffer=null,queue=[],queuedBytes=0,latestInit=null,destroyed=false,failed=false,cleaning=false,playbackStarted=false,playbackActive=true,replayPending=false,recoverAfterSerial=0,appendSerial=0,appendingSerial=0,completedAppendSerial=0,pipelineGeneration=0,renderedFrames=0,firstPaintAt=0,lastRenderedAt=0,powerKnown=false,powerEfficient=false;const renderIntervals=[],latencySamples=[];
  const fail=error=>{if(destroyed||failed)return;failed=true;onError(error instanceof Error?error:new Error(String(error||'Native screen playback failed')))};
  const closePipeline=()=>{pipelineGeneration++;try{buffer?.abort()}catch{}buffer=null;source=null;cleaning=false;try{video.pause();video.removeAttribute('src');video.load()}catch{}if(url)URL.revokeObjectURL(url);url=''};
  // Packet-loss recovery can leave an older buffered island behind. Playback
  // decisions must use the newest contiguous range, never span that gap.
  const liveRange=()=>{try{const index=video.buffered.length-1;if(index<0)return null;return{start:video.buffered.start(index),end:video.buffered.end(index)}}catch{return null}};
  const synchronizePlayback=()=>{
    const range=liveRange();if(!range)return;
    if(!playbackActive){video.pause();video.playbackRate=1;if(range.end-range.start>.9&&!buffer?.updating){cleaning=true;buffer.remove(range.start,Math.max(range.start,range.end-.55))}return}
    // A fallback backend receives the current GOP synchronously, but each MSE
    // append completes asynchronously. Hold playback until the replay barrier
    // has actually reached SourceBuffer, then make one live-edge seek. The
    // serial barrier also prevents reset() from seeking on the stale append
    // that happened to be in flight when a recovery keyframe arrived.
    if(replayPending||(recoverAfterSerial&&completedAppendSerial<recoverAfterSerial)){video.pause();video.playbackRate=1;return}
    if(recoverAfterSerial){recoverAfterSerial=0;video.currentTime=Math.max(range.start,range.end-targetLag);playbackStarted=true}
    if(!playbackStarted){if(range.end-range.start<startLag)return;video.currentTime=Math.max(range.start,range.end-targetLag);playbackStarted=true}
    const lag=range.end-video.currentTime;if(video.currentTime<range.start||video.currentTime>range.end||lag>hardCatchupLag)video.currentTime=Math.max(range.start,range.end-targetLag);
    // Faster-than-1x playback necessarily drops 4K60 presentation frames on a
    // 60 Hz display. Preserve exact cadence and use the bounded seek above only
    // when the viewer has accumulated a real live-edge debt.
    video.playbackRate=1;try{source?.setLiveSeekableRange?.(range.start,range.end)}catch{}video.play().catch(()=>{});
  };
  const drain=()=>{
    if(destroyed||failed||!buffer||buffer.updating)return;
    try{
      const range=liveRange();if(range&&video.currentTime>7&&range.start<video.currentTime-4&&!cleaning){cleaning=true;buffer.remove(range.start,video.currentTime-3);return}
      const next=queue.shift();if(!next)return;queuedBytes-=next.data.byteLength;appendingSerial=next.serial;buffer.appendBuffer(next.data)
    }catch(error){fail(error)}
  };
  const openPipeline=()=>{
    const generation=++pipelineGeneration;source=new MediaSource();url=URL.createObjectURL(source);try{video.pause();video.srcObject=null;video.src=url;video.playbackRate=1;video.autoplay=true;video.playsInline=true;video.style.opacity=''}catch{}
    source.addEventListener('sourceopen',()=>{if(destroyed||failed||generation!==pipelineGeneration)return;try{buffer=source.addSourceBuffer(mime);buffer.addEventListener('error',()=>{if(generation===pipelineGeneration)fail(new Error('Native AV1 SourceBuffer failed'))});buffer.addEventListener('updateend',()=>{if(destroyed||failed||generation!==pipelineGeneration)return;if(appendingSerial){completedAppendSerial=Math.max(completedAppendSerial,appendingSerial);appendingSerial=0}cleaning=false;synchronizePlayback();drain()});drain()}catch(error){fail(error)}},{once:true})
  };
  const noteFrame=(now,metadata={})=>{if(!playbackActive)return;renderedFrames++;if(!firstPaintAt)firstPaintAt=now;if(lastRenderedAt){renderIntervals.push(now-lastRenderedAt);if(renderIntervals.length>360)renderIntervals.shift()}lastRenderedAt=now;const range=liveRange(),mediaTime=Number(metadata.mediaTime);if(range&&Number.isFinite(mediaTime)){const latency=(range.end-mediaTime)*1000;if(latency>=0&&Number.isFinite(latency)){latencySamples.push(latency);if(latencySamples.length>360)latencySamples.shift()}}};
  if(typeof video.requestVideoFrameCallback==='function'){const rendered=(now,metadata)=>{if(destroyed)return;noteFrame(now,metadata);video.requestVideoFrameCallback(rendered)};video.requestVideoFrameCallback(rendered)}else video.addEventListener('loadeddata',()=>{if(!firstPaintAt)firstPaintAt=performance.now()});
  try{navigator.mediaCapabilities?.decodingInfo?.({type:'media-source',video:{contentType:mime,width:configuredWidth||3840,height:configuredHeight||2160,bitrate:Number(options.bitrate)||10000000,framerate:Number(options.fps)||60}}).then(result=>{powerKnown=true;powerEfficient=!!result?.powerEfficient}).catch(()=>{})}catch{}
  openPipeline();
  return{
    mode:'mse',
    append(data,info={}){if(destroyed||failed)return false;const bytes=data instanceof Uint8Array?data:new Uint8Array(data);if(!bytes.byteLength)return true;const copy=bytes.slice().buffer,kind=info.kind||(bytes.length>=4&&bytes[0]===0x1f&&bytes[1]===0x43&&bytes[2]===0xb6&&bytes[3]===0x75?'cluster':'init');if(kind==='init')latestInit=copy.slice(0);if(queuedBytes+copy.byteLength>12*1024*1024){fail(new Error('Native screen decoder fell behind its real-time queue'));return false}queue.push({data:copy,serial:++appendSerial});queuedBytes+=copy.byteLength;drain();return true},
    beginReplay(){if(destroyed||failed)return false;replayPending=true;try{video.pause();video.playbackRate=1}catch{}return true},
    finishReplay(){if(destroyed||failed)return false;replayPending=false;if(appendSerial>completedAppendSerial)recoverAfterSerial=Math.max(recoverAfterSerial,appendSerial);synchronizePlayback();return true},
    // A missing delta frame does not invalidate a fragmented WebM stream when
    // the next admitted cluster starts with a keyframe. Recreating MediaSource
    // for every WAN loss repeatedly reinitialized VA-API and produced one-frame
    // black flashes. Drop only not-yet-appended stale clusters, keep the decoder
    // and init segment, then seek to the new keyframe after it is appended.
    reset(){if(destroyed||failed||!latestInit)return false;queue.length=0;queuedBytes=0;recoverAfterSerial=Math.max(recoverAfterSerial,appendSerial+1);try{video.pause();video.playbackRate=1}catch{}return true},
    setActive(active){playbackActive=!!active;if(destroyed)return;if(!playbackActive){video.pause();video.playbackRate=1}else{recoverAfterSerial=Math.max(recoverAfterSerial,appendSerial);synchronizePlayback()}},
    destroy(){if(destroyed)return;destroyed=true;queue.length=0;queuedBytes=0;closePipeline()},
    stats(){const quality=video.getVideoPlaybackQuality?.()||{},cadence=[...renderIntervals.slice(-120)].sort((a,b)=>a-b),latency=[...latencySamples.slice(-120)].sort((a,b)=>a-b),mean=renderIntervals.slice(-120).reduce((sum,value)=>sum+value,0)/Math.max(1,Math.min(120,renderIntervals.length));return{decodedFrames:Number(quality.totalVideoFrames)||renderedFrames,paintedFrames:renderedFrames,submittedFrames:renderedFrames,renderedFrames,renderFps:mean?1000/mean:0,renderCadenceP95Ms:cadence.length?cadence[Math.min(cadence.length-1,Math.ceil(cadence.length*.95)-1)]:0,firstPaintAt,width:video.videoWidth||configuredWidth,height:video.videoHeight||configuredHeight,decodeQueueSize:queue.length,softwareFallback:powerKnown&&!powerEfficient,hardwareUnavailable:powerKnown&&!powerEfficient,powerEfficient,powerKnown,latencyExceeded:false,latencyViolationWindows:0,steadyStateP95Ms:latency.length?latency[Math.min(latency.length-1,Math.ceil(latency.length*.95)-1)]:0,latencySamples:latency.length,presentationMode:'video',presentationDroppedFrames:Number(quality.droppedVideoFrames)||0,presentationQueueFrames:queue.length}}
  };
}
function createNativeScreenPlayer(video,codec,onError=()=>{},options={}){
  if(options.decode===false)return createWebCodecsNativeScreenPlayer(video,codec,onError,options);
  let backend=null,backendIndex=-1,generation=0,destroyed=false,playbackActive=true,finalFailure=false,backendFailures=0,lastError=null,latestInit=null,replay=[],replayBytes=0;const fps=Number(options.fps)||60;
  // Use the explicit hardware WebCodecs path for sub-100 ms playback. A driver
  // rejection moves to Chromium's independent MediaSource pipeline, which kept
  // substantially more real frames under bursty WAN recovery than replacing
  // the active generated track. Software WebCodecs remains the final safety net.
  const factories=[callback=>createWebCodecsNativeScreenPlayer(video,codec,callback,{...options,allowSoftwareFallback:false}),callback=>createMseNativeScreenPlayer(video,codec,callback,options),callback=>createWebCodecsNativeScreenPlayer(video,codec,callback,{...options,allowSoftwareFallback:true,preferSoftware:true,enforceLatencyTarget:false})];
  const reportFinal=error=>{if(finalFailure||destroyed)return;finalFailure=true;const reason=error instanceof Error?error:new Error(String(error||'Native AV1 playback failed'));queueMicrotask(()=>{if(!destroyed)onError(reason)})};
  const startBackend=(from=0)=>{for(let index=from;index<factories.length;index++){const token=++generation;try{const candidate=factories[index](error=>handleBackendFailure(token,error));if(!candidate)continue;backend=candidate;backendIndex=index;backend.setActive?.(playbackActive);return true}catch(error){lastError=error}}backend=null;backendIndex=factories.length;return false};
  const replayIntoBackend=()=>{const target=backend,token=generation;if(target?.beginReplay?.()===false&&token===generation){handleBackendFailure(token,new Error('Native AV1 fallback decoder could not begin buffered recovery'));return false}for(const entry of replay){if(target?.append(entry.data,entry.info)===false&&token===generation){handleBackendFailure(token,new Error('Native AV1 fallback decoder rejected buffered video'));return false}}if(token===generation&&target?.finishReplay?.()===false){handleBackendFailure(token,new Error('Native AV1 fallback decoder could not finish buffered recovery'));return false}return !!backend};
  function handleBackendFailure(token,error){if(destroyed||finalFailure||token!==generation)return;lastError=error;backendFailures++;const failed=backend;backend=null;try{failed?.destroy()}catch{}if(!startBackend(backendIndex+1)){reportFinal(lastError);return}replayIntoBackend()}
  const remember=(bytes,info={})=>{const kind=info.kind||(bytes.length>=4&&bytes[0]===0x1f&&bytes[1]===0x43&&bytes[2]===0xb6&&bytes[3]===0x75?'cluster':'init'),details=kind==='cluster'&&info.key===undefined?nativeScreenSegmentInfo(bytes,fps):info,copy=bytes.slice();if(kind==='init'){latestInit=copy;replay=[{data:copy,info:{...details,kind:'init'}}];replayBytes=copy.byteLength;return}if(details.key){replay=latestInit?[{data:latestInit,info:{kind:'init'}},{data:copy,info:{...details,kind}}]:[{data:copy,info:{...details,kind}}];replayBytes=replay.reduce((sum,value)=>sum+value.data.byteLength,0);return}replay.push({data:copy,info:{...details,kind}});replayBytes+=copy.byteLength;if(replayBytes>12*1024*1024){replay=latestInit?[{data:latestInit,info:{kind:'init'}}]:[];replayBytes=latestInit?.byteLength||0}};
  if(!startBackend())throw lastError||new Error('Native '+codec+' playback is not supported');
  return{
    get mode(){return backend?.mode||'failed'},
    append(data,info={}){if(destroyed||finalFailure)return false;const bytes=data instanceof Uint8Array?data:new Uint8Array(data);remember(bytes,info);const token=generation,result=backend?.append(bytes,info);if(result===false&&token===generation)handleBackendFailure(token,new Error('Native AV1 decoder rejected a segment'));return !finalFailure},
    reset(){if(destroyed||finalFailure)return false;const token=generation,result=backend?.reset?.();if(result===false&&token===generation)handleBackendFailure(token,new Error('Native AV1 decoder could not recover after packet loss'));return !finalFailure},
    setActive(active){playbackActive=!!active;backend?.setActive?.(playbackActive)},
    destroy(){if(destroyed)return;destroyed=true;generation++;replay=[];replayBytes=0;try{backend?.destroy()}catch{}backend=null},
    stats(){return{...(backend?.stats?.()||{}),backend:backend?.mode||'',backendFailures}}
  };
}
function nativeScreenSegmentInfo(data,fps=60){const bytes=data instanceof Uint8Array?data:new Uint8Array(data),cluster=bytes.byteLength>=4&&bytes[0]===0x1f&&bytes[1]===0x43&&bytes[2]===0xb6&&bytes[3]===0x75;if(!cluster)return{kind:'init',key:false,frameCount:0};let frames=[];try{frames=window.KnotNativeVideo?.webmAv1Frames?.(bytes,fps)||[]}catch{}return{kind:'cluster',key:frames.some(frame=>frame.type==='key'),frameCount:frames.length}}
function nativeScreenReceiveState(player,meta={},onGap=()=>{}){return{fragments:new Map(),complete:new Map(),nextSeq:0,pendingBytes:0,player,fps:Number(meta.fps)||60,haveInit:false,latestInit:null,resetBeforeKey:false,gapSince:0,gapTimer:null,fallbackRequested:false,onGap}}
function requestNativeReceiveFallback(state,error){if(!state||state.fallbackRequested)return;state.fallbackRequested=true;state.onGap?.(error)}
function clearNativeScreenReceiveState(channel){const state=channel?._nativeReceive;if(!state)return;clearTimeout(state.gapTimer);state.gapTimer=null;state.fragments?.clear();state.complete?.clear();state.pendingBytes=0;channel._nativeReceive=null}
function holdNativeScreenPreMeta(channel,data){
  const bytes=data instanceof ArrayBuffer?data.slice(0):ArrayBuffer.isView(data)?data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength):null;if(!bytes)return;
  if(!channel._nativePreMeta)channel._nativePreMeta=[];let total=channel._nativePreMeta.reduce((sum,value)=>sum+value.byteLength,0);if(channel._nativePreMeta.length>=32||total+bytes.byteLength>2*1024*1024)channel._nativePreMeta.shift();channel._nativePreMeta.push(bytes)
}
function drainNativeScreenPreMeta(channel){for(const packet of channel._nativePreMeta?.splice(0)||[])receiveNativeScreenPacket(channel,packet)}
function ensureNativeRemoteAudio(){if(nativeRemoteAudio)return nativeRemoteAudio;nativeRemoteAudio=document.createElement('audio');nativeRemoteAudio.autoplay=true;nativeRemoteAudio.hidden=true;document.body.append(nativeRemoteAudio);applyMediaElementOutput(nativeRemoteAudio).catch(()=>{});return nativeRemoteAudio}
function cleanupRemoteNativeScreen({keepChannel=false}={}){
  nativeRemotePlayer?.destroy();nativeRemotePlayer=null;if(remoteNativeScreenChannel)clearNativeScreenReceiveState(remoteNativeScreenChannel);if(!keepChannel&&remoteNativeScreenChannel){try{remoteNativeScreenChannel.onmessage=null;remoteNativeScreenChannel.close()}catch{}remoteNativeScreenChannel=null}if(nativeRemoteAudio){try{nativeRemoteAudio.pause();nativeRemoteAudio.srcObject=null}catch{}}try{remoteScreen.removeAttribute('src');remoteScreen.load()}catch{}
}
function beginRemoteNativeScreen(meta,channel){
  cleanupRemoteNativeScreen({keepChannel:true});remoteNativeScreenChannel=channel;remoteScreenExpected=true;remoteScreenSuppressed=false;remoteScreen.hidden=false;remoteScreen.srcObject=null;let fallbackRequested=false;const requestFallback=()=>{if(fallbackRequested)return;fallbackRequested=true;try{if(channel.readyState==='open')channel.send(JSON.stringify({t:'native-screen-fallback'}))}catch{}};
  try{nativeRemotePlayer=createNativeScreenPlayer(remoteScreen,meta.codec||'AV1',requestFallback,meta)}catch(error){screenStatus.textContent=error.message;requestFallback();return false}channel._nativeReceive=nativeScreenReceiveState(nativeRemotePlayer,meta,requestFallback);drainNativeScreenPreMeta(channel);try{channel.send(JSON.stringify({t:'native-screen-ready',transportVersion:NATIVE_SCREEN_PROTOCOL}))}catch{}screenStatus.textContent='Friend sharing · '+(meta.codec||'AV1')+' · '+(meta.width||'source')+'×'+(meta.height||'source')+' · '+(meta.fps||60)+'fps';updateScreenLayout();return true;
}
function removeNativeReceiveSequence(state,seq){const complete=state.complete.get(seq);if(complete){state.pendingBytes=Math.max(0,state.pendingBytes-complete.data.byteLength);state.complete.delete(seq)}const fragment=state.fragments.get(seq);if(fragment){state.pendingBytes=Math.max(0,state.pendingBytes-fragment.bytes);state.fragments.delete(seq)}}
function appendNativeReceiveEntry(state,entry){
  if(entry.kind==='init'){state.latestInit=entry.data;if(state.haveInit){state.resetBeforeKey=true;return true}state.haveInit=true;return state.player?.append(entry.data,entry)!==false}
  if(state.resetBeforeKey){if(!entry.key)return true;state.resetBeforeKey=false;if(typeof state.player?.reset!=='function'||state.player.reset()===false)return false}
  return state.player?.append(entry.data,entry)!==false
}
function drainNativeScreenReceive(channel){
  const state=channel?._nativeReceive;if(!state)return;
  clearTimeout(state.gapTimer);state.gapTimer=null;
  while(state.complete.has(state.nextSeq)){
    const entry=state.complete.get(state.nextSeq);state.complete.delete(state.nextSeq++);state.pendingBytes=Math.max(0,state.pendingBytes-entry.data.byteLength);state.gapSince=0;
    if(!appendNativeReceiveEntry(state,entry)){requestNativeReceiveFallback(state,new Error('Native AV1 decoder rejected a segment'));return}
  }
  if(!state.complete.size)return;
  const later=[...state.complete.entries()].filter(([seq])=>seq>state.nextSeq).sort((a,b)=>a[0]-b[0]);if(!later.length)return;const recovery=later.find(([,entry])=>entry.kind==='cluster'&&entry.key);if(!recovery)return;
  const now=performance.now();if(!state.gapSince)state.gapSince=now;if(now-state.gapSince<NATIVE_SCREEN_GAP_WAIT){state.gapTimer=setTimeout(()=>drainNativeScreenReceive(channel),NATIVE_SCREEN_GAP_WAIT-(now-state.gapSince)+1);return}
  const [keySeq,keyEntry]=recovery,initEntry=[...state.complete.entries()].filter(([seq,entry])=>seq<keySeq&&entry.kind==='init').sort((a,b)=>b[0]-a[0])[0]?.[1]||null;
  if(state.haveInit){if(typeof state.player?.reset!=='function'||state.player.reset()===false){requestNativeReceiveFallback(state,new Error('Native AV1 packet loss could not be recovered'));return}}
  else if(!initEntry&&!state.latestInit){requestNativeReceiveFallback(state,new Error('Native AV1 initialization was lost'));return}
  for(const seq of [...state.fragments.keys()])if(seq<=keySeq)removeNativeReceiveSequence(state,seq);for(const seq of [...state.complete.keys()])if(seq<=keySeq)removeNativeReceiveSequence(state,seq);
  if(!state.haveInit){const init=initEntry?.data||state.latestInit;state.haveInit=true;state.latestInit=init;if(state.player?.append(init,{kind:'init'})===false){requestNativeReceiveFallback(state,new Error('Native AV1 initialization failed'));return}}
  if(state.player?.append(keyEntry.data,keyEntry)===false){requestNativeReceiveFallback(state,new Error('Native AV1 keyframe recovery failed'));return}
  state.nextSeq=keySeq+1;state.gapSince=0;drainNativeScreenReceive(channel)
}
function receiveNativeScreenPacket(channel,data){
  const state=channel._nativeReceive,bytes=data instanceof ArrayBuffer?new Uint8Array(data):ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):null;if(!state||!bytes||bytes.byteLength<12)return;const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);if(view.getUint32(0)!==NATIVE_SCREEN_PACKET)return;const seq=view.getUint32(4),part=view.getUint16(8),total=view.getUint16(10);if(!total||total>128||part>=total||seq<state.nextSeq||seq>state.nextSeq+4096)return;state.pendingBytes=Number(state.pendingBytes)||0;let entry=state.fragments.get(seq);if(!entry){if(state.fragments.size>=64){const oldest=[...state.fragments.keys()].sort((a,b)=>a-b)[0];removeNativeReceiveSequence(state,oldest)}entry={parts:new Array(total),count:0,bytes:0,receivedAt:performance.now()};state.fragments.set(seq,entry)}if(entry.parts.length!==total||entry.parts[part])return;entry.parts[part]=bytes.slice(12);entry.count++;entry.bytes+=bytes.byteLength-12;state.pendingBytes+=bytes.byteLength-12;if(entry.bytes>NATIVE_SCREEN_MAX_SEGMENT||state.pendingBytes>12*1024*1024){state.fragments.clear();state.complete.clear();state.pendingBytes=0;requestNativeReceiveFallback(state,new Error('Native AV1 receive queue exceeded its real-time limit'));return}if(entry.count===total){const joined=new Uint8Array(entry.bytes);let offset=0;for(const value of entry.parts){joined.set(value,offset);offset+=value.byteLength}state.fragments.delete(seq);const info=nativeScreenSegmentInfo(joined,state.fps);state.complete.set(seq,{data:joined,...info,receivedAt:entry.receivedAt});drainNativeScreenReceive(channel)}
}
function wireNativeScreenChannel(channel,{remote=false}={}){
  channel.binaryType='arraybuffer';if(remote){remoteNativeScreenChannel=channel;channel._nativePreMeta=[];channel.onmessage=event=>{if(typeof event.data==='string'){try{const value=JSON.parse(event.data);if(value.t==='native-screen-meta')beginRemoteNativeScreen(value,channel);else if(value.t==='native-screen-end')clearRemoteScreenShare()}catch{}return}if(!channel._nativeReceive)holdNativeScreenPreMeta(channel,event.data);else receiveNativeScreenPacket(channel,event.data)};channel.onclose=()=>{channel._nativePreMeta=[];clearNativeScreenReceiveState(channel);if(remoteNativeScreenChannel===channel&&remoteScreenExpected)clearRemoteScreenShare()};return}
  nativeScreenChannel=channel;channel.onmessage=event=>{if(typeof event.data!=='string')return;try{const value=JSON.parse(event.data);if(value.t==='native-screen-ready'){channel._nativePeerProtocol=Number(value.transportVersion)||0;clearTimeout(channel._nativeProtocolTimer)}else if(value.t==='native-screen-fallback')fallbackNativeScreenToWebRtc(channel._nativeSend?.sessionId)}catch{}};channel.onclose=()=>{clearTimeout(channel._nativeProtocolTimer)};
}
async function waitNativeScreenChannel(channel){if(channel.readyState==='open')return true;return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);channel.removeEventListener('open',opened);channel.removeEventListener('close',closed);resolve(value)};const opened=()=>finish(true),closed=()=>finish(false),timer=setTimeout(()=>finish(false),5000);channel.addEventListener('open',opened,{once:true});channel.addEventListener('close',closed,{once:true})})}
function initializeNativeScreenSender(channel,meta,sessionId,onFallback=()=>{}){
  clearTimeout(channel._nativeProtocolTimer);channel._nativePeerProtocol=0;channel._nativeSend={sessionId,seq:0,init:null,fps:Number(meta.fps)||60,dropping:false,droppedSegments:0,droppedFrames:0,sourceFrames:0,sentFrames:0,discontinuities:0,missedKeys:0,congestedSince:0,fallbackRequested:false,onFallback};channel.bufferedAmountLowThreshold=NATIVE_SCREEN_BUFFER_LOW;
  channel.send(JSON.stringify({...meta,transportVersion:NATIVE_SCREEN_PROTOCOL}));channel._nativeProtocolTimer=setTimeout(()=>{const state=channel._nativeSend;if(channel.readyState!=='open'||state?.sessionId!==sessionId||channel._nativePeerProtocol>=NATIVE_SCREEN_PROTOCOL||state?.fallbackRequested)return;state.fallbackRequested=true;Promise.resolve(onFallback(new Error('The other Knot client does not support recoverable AV1 transport'))).catch(()=>{})},3000);return channel._nativeSend
}
async function nativeChannelBackpressure(channel,segmentBytes=0,waitMs=0){const admitted=()=>channel.readyState==='open'&&(Number(channel.bufferedAmount)||0)+Math.max(0,Number(segmentBytes)||0)<=nativeScreenBufferBudget(segmentBytes);if(channel.readyState!=='open')return false;if(admitted())return true;if(!waitMs||typeof channel.addEventListener!=='function')return false;channel.bufferedAmountLowThreshold=NATIVE_SCREEN_BUFFER_LOW;return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);channel.removeEventListener('bufferedamountlow',low);channel.removeEventListener('close',closed);resolve(value)};const low=()=>finish(admitted()),closed=()=>finish(false),timer=setTimeout(()=>finish(admitted()),waitMs);channel.addEventListener('bufferedamountlow',low,{once:true});channel.addEventListener('close',closed,{once:true})})}
async function sendNativeScreenSegment(channel,item){
  const data=item.data instanceof Uint8Array?item.data:new Uint8Array(item.data);if(!data.byteLength||data.byteLength>NATIVE_SCREEN_MAX_SEGMENT||channel.readyState!=='open')return false;const total=Math.max(1,Math.ceil(data.byteLength/NATIVE_SCREEN_PART)),waitMs=Number(item.waitMs)||0;if(total>128||(!item.admitted&&!await nativeChannelBackpressure(channel,data.byteLength,waitMs)))return false;try{for(let part=0;part<total;part++){const start=part*NATIVE_SCREEN_PART,end=Math.min(data.byteLength,start+NATIVE_SCREEN_PART),packet=new Uint8Array(12+end-start),view=new DataView(packet.buffer);view.setUint32(0,NATIVE_SCREEN_PACKET);view.setUint32(4,item.seq);view.setUint16(8,part);view.setUint16(10,total);packet.set(data.subarray(start,end),12);channel.send(packet.buffer)}return true}catch{return false}
}
function requestNativeScreenFallback(channel,state,error){if(state.fallbackRequested)return;state.fallbackRequested=true;clearTimeout(channel._nativeProtocolTimer);Promise.resolve(state.onFallback?.(error)).catch(()=>{})}
function markNativeScreenCongested(channel,state,key,frameCount=0){state.dropping=true;state.droppedSegments++;state.droppedFrames+=Math.max(0,Number(frameCount)||0);if(!state.congestedSince)state.congestedSince=performance.now();if(key)state.missedKeys++;const peerProtocol=Number(channel._nativePeerProtocol)||0;if(peerProtocol>0&&peerProtocol<NATIVE_SCREEN_PROTOCOL)requestNativeScreenFallback(channel,state,new Error('AV1 congestion requires a compatible receiver'))}
async function sendNativeScreenLiveItem(channel,item){
  const state=channel._nativeSend;if(!state||channel.readyState!=='open')return false;const data=item.data instanceof Uint8Array?item.data:new Uint8Array(item.data);
  if(item.kind==='init'){state.init=data.slice();if(!await nativeChannelBackpressure(channel,data.byteLength,100)){markNativeScreenCongested(channel,state,false);return true}const seq=state.seq,sent=await sendNativeScreenSegment(channel,{kind:'init',seq,data,admitted:true});state.seq++;if(!sent)markNativeScreenCongested(channel,state,false);return channel.readyState==='open'}
  const parsed=item.key===undefined||item.frameCount===undefined?nativeScreenSegmentInfo(data,state.fps):null,key=item.key===true||!!parsed?.key,frameCount=Math.max(0,Number(item.frameCount??parsed?.frameCount)||0),capturedAt=Number(item.capturedAt)||0;state.sourceFrames+=frameCount;
  if(item.discontinuity){state.dropping=true;state.discontinuities++}
  if((capturedAt&&Date.now()-capturedAt>NATIVE_SCREEN_STALE_MS&&!key)||(state.dropping&&!key)){markNativeScreenCongested(channel,state,false,frameCount);return true}
  if(!await nativeChannelBackpressure(channel,data.byteLength,key?160:0)){markNativeScreenCongested(channel,state,key,frameCount);return true}
  const recovering=state.dropping;
  // A duplicate init is sent only at an intentional recovery boundary. The
  // receiver treats it as an immediate decoder reset before the following key,
  // avoiding the artificial sequence gap and visible 80 ms pause used before.
  if(recovering&&key&&state.init){const initSeq=state.seq,initSent=await sendNativeScreenSegment(channel,{kind:'init',seq:initSeq,data:state.init,admitted:true});state.seq++;if(!initSent){markNativeScreenCongested(channel,state,true,frameCount);return channel.readyState==='open'}}
  const seq=state.seq,sent=await sendNativeScreenSegment(channel,{kind:'cluster',seq,data,admitted:true});state.seq++;if(!sent){markNativeScreenCongested(channel,state,key,frameCount);return channel.readyState==='open'}
  state.sentFrames+=frameCount;if(key){state.dropping=false;state.missedKeys=0;state.congestedSince=0}return true
}
function nativeScreenChannelOptions(){return{ordered:false,maxRetransmits:1,priority:'low'}}
function selectedNativeDimensions(){const dimensions={720:[1280,720],1080:[1920,1080],1440:[2560,1440],2160:[3840,2160]};return dimensions[Number(shareResolution)]||[0,0]}
function targetNativeAv1BitrateKbps(width,height,fps,viewers=1){const selectedPixels=Number(width)>0&&Number(height)>0?Number(width)*Number(height):3840*2160,pixels=Math.max(1,selectedPixels),cadence=Number(fps)===30?.62:1,ratio=pixels/(1920*1080),targetMbps=Math.max(2.5,3.5*Math.pow(ratio,.62)*cadence),uploadBudget=Math.max(2,screenBitrateMbps/Math.max(1,Number(viewers)||1));return Math.round(Math.min(uploadBudget,targetMbps)*1000)}
async function attachNativeShareAudio(gen){
  if(!screenAudioOn||!screenActive||gen!==screenGen)return;const track=await linuxShareAudioTrack();if(!track||!screenActive||gen!==screenGen){try{track?.stop()}catch{}if(track)cleanupNativeScreenCapture(track._knotCaptureOwner);return}const audioStream=new MediaStream([track]);nativeScreenAudioStream=audioStream;try{track.contentHint='music'}catch{};let sender=null;try{sender=pc.addTrack(track,audioStream);screenSenders.push(sender);const parameters=sender.getParameters();if(!parameters.encodings?.length)parameters.encodings=[{}];parameters.encodings[0].maxBitrate=192000;parameters.encodings[0].priority='medium';parameters.encodings[0].networkPriority='medium';await sender.setParameters(parameters);if(!await renegotiate())throw new Error('screen audio negotiation did not start');if(nativeScreenAudioStream!==audioStream||!screenActive||gen!==screenGen)throw new Error('screen share ended during audio negotiation');screenAudioDebug=' · sound live';screenStatus.textContent='Sharing · '+(nativeScreenSession?.encoder||'GPU')+' AV1'+screenAudioDebug}catch(error){console.warn('[AUDIO] native share audio failed:',error?.message||error);if(sender){try{pc?.removeTrack(sender)}catch{}screenSenders=screenSenders.filter(value=>value!==sender);renegotiate().catch(()=>{})}try{track.stop()}catch{}if(nativeScreenAudioStream===audioStream)nativeScreenAudioStream=null;cleanupNativeScreenCapture(track._knotCaptureOwner);if(screenActive&&gen===screenGen){screenAudioDebug=' · sound unavailable';screenStatus.textContent='Sharing · '+(nativeScreenSession?.encoder||'GPU')+' AV1'+screenAudioDebug}}
}
async function pumpNativeScreen(gen,session,channel){
  let audioStarted=false;while(screenActive&&gen===screenGen&&nativeScreenSession?.id===session.id){const item=await window.pairNativeScreen.read(session.id);if(!screenActive||gen!==screenGen||nativeScreenSession?.id!==session.id)break;if(item?.data){if(!nativeScreenAnnounced){nativeScreenAnnounced=true;try{send({t:'screen-start',native:true,codec:'AV1',encoder:session.encoder})}catch{};logCallEvent('You started '+(session.encoder||'GPU')+' AV1 screen sharing')}nativeLocalPlayer?.append(item.data);if(!await sendNativeScreenLiveItem(channel,item))break;if(!audioStarted){audioStarted=true;void attachNativeShareAudio(gen)}continue}if(!item?.active){if(item?.error)screenStatus.textContent='Native share stopped: '+item.error;break}}
  if(screenActive&&gen===screenGen&&nativeScreenSession?.id===session.id)await stopScreenShare();
}
async function startNativeScreenShare(expectedPc=pc,expectedCallGen=callGen){
  const ownsCall=()=>pc===expectedPc&&callGen===expectedCallGen&&viableScreenPeer(expectedPc);if(!ownsCall())return false;
  screenStarting=true;const gen=++screenGen;let channel=null,session=null;
  const abandon=()=>{if(session)try{window.pairNativeScreen?.stop(session.id)}catch{}if(nativeScreenSession?.id===session?.id){nativeScreenSession=null;nativeLocalPlayer?.destroy();nativeLocalPlayer=null;screenPreview.hidden=true}if(channel){try{channel.close()}catch{}if(nativeScreenChannel===channel)nativeScreenChannel=null}};
  try{channel=expectedPc.createDataChannel('knot-screen-native',nativeScreenChannelOptions());wireNativeScreenChannel(channel);if(!await waitNativeScreenChannel(channel))throw new Error('Native screen channel did not open');if(gen!==screenGen||!ownsCall()){abandon();return false}const [width,height]=selectedNativeDimensions(),fps=shareFrameRate===30?30:60;session=await window.pairNativeScreen.start({codec:'av1',fps,width,height,bitrateKbps:targetNativeAv1BitrateKbps(width,height,fps),cursor:screenCursor});if(!session||session.error)throw new Error(session?.error||'GPU AV1 capture did not start');if(gen!==screenGen||!ownsCall()){abandon();return false}nativeScreenSession=session;nativeScreenAnnounced=false;screenActive=true;screenSenders=[];screenAudioDebug=screenAudioOn?' · starting sound capture':' · sound off';screenPreview.hidden=false;screenPreview.muted=true;nativeLocalPlayer=createNativeScreenPlayer(screenPreview,'AV1',()=>{}, {...session,decode:false});initializeNativeScreenSender(channel,{t:'native-screen-meta',codec:'AV1',fps:session.fps,width:session.width,height:session.height,encoder:session.encoder,latencyTargetMs:session.latencyTargetMs},session.id,()=>fallbackNativeScreenToWebRtc(session.id));screenBtn.textContent='Stop sharing';screenBtn.title='Stop screen sharing';screenStatus.textContent='Choose a display · starting '+(session.encoder||'GPU')+' AV1…';focusedScreen='local';screenExpanded=false;updateScreenLayout();void pumpNativeScreen(gen,session,channel);return true}catch(error){const stale=gen!==screenGen||!ownsCall();if(!stale){console.warn('[VIDEO] native screen start failed:',error?.message||error);screenStatus.textContent='Native AV1 unavailable: '+(error?.message||error)}abandon();return false}finally{if(gen===screenGen)screenStarting=false}}
async function fallbackNativeScreenToWebRtc(expectedSessionId=nativeScreenSession?.id){
  const expectedSession=nativeScreenSession,expectedPc=pc,expectedCallGen=callGen,previous=screenCodec,compatibility=compatibilityScreenCodec(),beforeStopGen=screenGen;
  if(nativeScreenFallbackInFlight||!expectedSession||expectedSession.id!==expectedSessionId||!screenActive||!viableScreenPeer(expectedPc))return;nativeScreenFallbackInFlight=true;screenStatus.textContent='AV1 playback unavailable · switching to bandwidth-capped '+compatibility;
  try{await stopScreenShare();if(screenGen!==beforeStopGen+1||pc!==expectedPc||callGen!==expectedCallGen||!viableScreenPeer(expectedPc))return;screenFallbackBitrateCapMbps=compatibility==='VP9'?6:8;screenCodec=compatibility;await startScreenShare({skipPicker:true,expectedPc,expectedCallGen})}finally{screenCodec=previous;nativeScreenFallbackInFlight=false}
}
function recoverFromGpuProcessLoss(details={}){
  const reason=String(details.reason||'GPU process restarted');let requested=false;if(nativeRemotePlayer&&remoteNativeScreenChannel?.readyState==='open'){try{remoteNativeScreenChannel.send(JSON.stringify({t:'native-screen-fallback'}));requested=true}catch{}}
  for(const state of serverPeers.values())if(state.nativeScreenPlayer&&state.nativeReceiveChannel?.readyState==='open')try{state.nativeReceiveChannel.send(JSON.stringify({t:'native-screen-fallback',serverId:state.context.serverId}));requested=true}catch{}
  if(requested)screenStatus.textContent='GPU video process restarted ('+reason+') · recovering the affected AV1 viewer'
}
window.pairEnv?.onGpuProcessGone?.(recoverFromGpuProcessLoss);
async function startScreenShare({skipPicker=false,expectedPc:ownedPc=null,expectedCallGen:ownedCallGen=null}={}){
  if(screenActive||screenStarting||screenSharePickerPending||!pc)return;
  const expectedPc=ownedPc||pc,expectedCallGen=Number.isInteger(ownedCallGen)?ownedCallGen:callGen,requestGen=screenGen,ownsCall=()=>pc===expectedPc&&callGen===expectedCallGen&&viableScreenPeer(expectedPc),ownsRequest=()=>ownsCall()&&screenGen===requestGen;
  if(!ownsCall())return;
  primeScreenAudioContext();
  if(!skipPicker)screenFallbackBitrateCapMbps=0;
  if(!skipPicker){screenSharePickerPending=true;screenBtn.disabled=true;renderDmVoiceUI();try{screenStatus.textContent=window.pairEnv?.useSystemPicker?'Choose stream quality…':'Choose a screen or window…';const choice=await chooseScreenShare();if(!choice){if(ownsRequest())screenStatus.textContent='Screen share canceled';return}if(!ownsRequest())return}catch(error){if(ownsRequest())screenStatus.textContent='Share failed: '+(error?.message||error);return}finally{screenSharePickerPending=false;screenBtn.disabled=!pc;renderDmVoiceUI()}}
  if(!ownsRequest())return;
  if(!skipPicker&&window.pairNativeScreen&&window.pairEnv?.platform==='linux'&&['0x10de','0x1002'].includes(window.pairEnv.primaryGpuVendor)&&(screenCodec==='auto'||screenCodec==='AV1')){const info=await window.pairNativeScreen.info();if(!ownsRequest())return;if(info?.supported){const started=await startNativeScreenShare(expectedPc,expectedCallGen);if(started||!ownsCall())return}}
  if(!ownsCall())return;
  screenStarting=true;const gen=++screenGen;let startupStream=null;
  try{
    const fps=shareFrameRate===30?30:60,stream=await captureDisplayStream();startupStream=stream;
    if(gen!==screenGen||!pc){stream.getTracks().forEach(track=>track.stop());return}
    const track=stream.getVideoTracks()[0];if(!track)throw new Error('No video track was captured');
    await tuneDisplayTrack(track);screenStatus.textContent='Checking screen video…';const captured=await waitForDisplayFrames(track);
    if(gen!==screenGen||!pc){stream.getTracks().forEach(value=>value.stop());return}
    screenStream=stream;
    // Desktop capture defaults to text/detail on some Chromium builds. Motion
    // tells the encoder to preserve changing game/action content instead.
    try{track.contentHint=screenContentHint}catch{}
    const sender=pc.addTrack(track,stream);screenSenders=[sender];applyScreenCodecPreference(pc,sender);await configureScreenVideoSender(sender,track,fps);
    // Audio attachment can take a moment while native capture warms up. Start
    // video first, then renegotiate again only if a clean audio track is ready.
    const attachShareAudio=async()=>{
      if(!screenAudioOn)return;
      let audioTrack=null;
      if(window.pairEnv?.platform==='linux'){
        audioTrack=await linuxShareAudioTrack();
      }else{
        // Drop any Chromium loopback that may have been granted unexpectedly.
        try{stream.getAudioTracks().forEach(t=>{try{t.stop()}catch{};try{stream.removeTrack(t)}catch{}})}catch{}
        try{audioTrack=await setupNativeScreenCapture()}catch(e){
          console.warn('[AUDIO] clean capture failed:',e?.message||e);
          audioTrack=null;
        }
      }
      if(!audioTrack){
        console.warn('[AUDIO] computer sound unavailable without echo risk; sharing video only');
        if(gen===screenGen&&screenActive){
          screenAudioDebug=' · sound unavailable';screenStatus.textContent=(screenStatus.textContent||'Sharing')+screenAudioDebug;
          logCallEvent('Computer sound unavailable — sharing video only');
        }
        return;
      }
      const discardShareAudio=()=>{
        try{audioTrack?.stop()}catch{}
        try{stream.removeTrack(audioTrack)}catch{}
        // A canceled/failed Linux attach must restore the desktop default sink
        // immediately; otherwise a late async result can leave audio routed to
        // an orphaned Knot Share sink after the user has already stopped.
        cleanupNativeScreenCapture(audioTrack?._knotCaptureOwner);
      };
      if(gen!==screenGen||!screenActive||!pc){discardShareAudio();return}
      try{
        audioTrack.enabled=true;
        try{audioTrack.contentHint='music'}catch{}
        try{stream.addTrack(audioTrack)}catch{}
        const audioSender=pc.addTrack(audioTrack,stream);
        screenSenders.push(audioSender);
        try{
          const p=audioSender.getParameters();
          if(p){
            if(!p.encodings||!p.encodings.length)p.encodings=[{}];
            // Prefer higher bitrate stereo for game/music desktop sound; voice
            // remains on the separate call track at its own Opus settings.
            p.encodings[0].maxBitrate=192000;
            p.encodings[0].priority='medium';
            p.encodings[0].networkPriority='medium';
            await audioSender.setParameters(p);
          }
        }catch{}
        if(!await renegotiate())throw new Error('audio negotiation did not start');
        if(gen!==screenGen||!screenActive||!pc)throw new Error('screen share ended during audio negotiation');
        logCallEvent('Computer sound sharing started');screenAudioDebug=' · sound live';screenStatus.textContent='Sharing'+screenAudioDebug;
      }catch(e){
        console.warn('[AUDIO] addTrack failed:',e);if(gen===screenGen&&screenActive){screenAudioDebug=' · sound failed';screenStatus.textContent='Sharing'+screenAudioDebug}
        const sender=screenSenders.find(s=>s.track===audioTrack);
        if(sender){try{pc?.removeTrack(sender)}catch{};screenSenders=screenSenders.filter(s=>s!==sender)}
        discardShareAudio();
      }
    };
    if(gen!==screenGen||!pc){screenSenders.forEach(s=>{try{pc.removeTrack(s)}catch{}});screenSenders=[];stream.getTracks().forEach(t=>t.stop());return}
    screenActive=true;screenAudioDebug=screenAudioOn?' · starting sound capture':' · sound off';startupStream=null;screenPreview.muted=true;
    // Do not make Knot composite its own full-resolution capture while it is
    // already capturing and encoding that surface. A lightweight local tile
    // confirms the share without duplicating the sender's 4K GPU workload.
    screenPreview.srcObject=null;screenPreview.hidden=false;nativeLocalPlayer?.destroy();nativeLocalPlayer=createNativeScreenPlaceholder(screenPreview,{width:captured.width,height:captured.height});
    screenBtn.textContent='Stop sharing';screenBtn.title='Stop screen sharing';screenStatus.textContent='Sharing · '+captured.width+'×'+captured.height+(captured.fps?' · '+captured.fps+'fps':'')+screenAudioDebug;
    startScreenStats(sender);
    try{send({t:'screen-start'})}catch{};
    logCallEvent('You started screen sharing');
    track.onended=()=>{if(screenActive)stopScreenShare()};
    const negotiated=await renegotiate();if(gen!==screenGen)return;if(negotiated)await configureScreenVideoSender(sender,track,fps);void attachShareAudio();
  }catch(e){try{startupStream?.getTracks().forEach(track=>track.stop())}catch{};if(screenStream===startupStream)screenStream=null;const message=e?.message||String(e);screenStatus.textContent=e?.name==='NotAllowedError'?'Screen share canceled':'Share failed: '+message;console.error('[VIDEO] screen share failed:',e);if(e.name!=='NotAllowedError')logCallEvent('Screen share error: '+message)}
  finally{if(gen===screenGen)screenStarting=false}
}
async function stopScreenShare(fromEnd){
  if(!screenActive&&!screenStarting&&!fromEnd&&!screenStream&&!nativeScreenSession)return;
  const wasFocused=typeof focusedScreen!=='undefined'&&focusedScreen==='local';
  screenGen++;
  screenStarting=false;
  const nativeSession=nativeScreenSession;nativeScreenSession=null;if(nativeSession)window.pairNativeScreen?.stop(nativeSession.id);if(nativeScreenChannel){try{if(nativeScreenChannel.readyState==='open')nativeScreenChannel.send(JSON.stringify({t:'native-screen-end'}));nativeScreenChannel.close()}catch{}nativeScreenChannel=null}nativeLocalPlayer?.destroy();nativeLocalPlayer=null;nativeScreenAnnounced=false;if(nativeScreenAudioStream){nativeScreenAudioStream.getTracks().forEach(track=>track.stop());nativeScreenAudioStream=null}
  if(window.pairEnv?.platform==='linux')window.pairEnv.stopLinuxShareAudio?.();
  screenActive=false;screenAudioDebug='';
  if(screenStatsTimer){clearInterval(screenStatsTimer);screenStatsTimer=null}screenStatsLast=null;
  cleanupNativeScreenCapture();
  if(screenStream){screenStream.getTracks().forEach(t=>t.stop());screenStream=null}
  if(pc){
    // Remove every sender created for this share, including audio. Leaving the
    // audio sender behind made each new share keep an old system-audio m-line
    // alive, which amplified echo and eventually made sharing unstable.
    screenSenders.forEach(s=>{try{pc.removeTrack(s)}catch{}});screenSenders=[];
    // Await so a rapid Share→preset-change→Share can't start a second reneg
    // before the removal reneg has been signaled (which would otherwise race
    // two offers and leave a dangling localDescription).
    await renegotiate();
  }
  screenPreview.srcObject=null;try{screenPreview.removeAttribute('src');screenPreview.load()}catch{}screenPreview.hidden=true;
  if(wasFocused)try{exitShareFullscreen({collapse:true})}catch{}
  screenBtn.textContent='Share screen';screenBtn.title='Share screen';screenBtn.disabled=!pc;
  if(!fromEnd){screenStatus.textContent='Not sharing';try{send({t:'screen-end'})}catch{};logCallEvent('You stopped screen sharing')}
}
screenBtn.onclick=()=>{if(screenActive||screenStarting)stopScreenShare();else if(!pc&&LOCAL_TEST_MODE){screenStatus.textContent='Connect with a friend to start screen sharing';screenStatus.className='screen-status';}else startScreenShare()};
// Screen share computer-sound toggle. Voice always stays on the call track;
// this only controls whether desktop/game sound rides with the share.
const audioToggleBtn=document.createElement('button');audioToggleBtn.textContent='Sound on';audioToggleBtn.className='audio-toggle is-on';
function syncScreenAudioToggle(){audioToggleBtn.textContent=screenAudioOn?'Sound on':'Sound off';audioToggleBtn.classList.toggle('is-on',screenAudioOn);audioToggleBtn.title=screenAudioOn?'Share computer sound with the screen (not the voice call)':'Computer sound will not be shared';audioToggleBtn.setAttribute('aria-pressed',String(screenAudioOn))}
audioToggleBtn.onclick=()=>{screenAudioOn=!screenAudioOn;syncScreenAudioToggle();ssSet('shareSystemAudio',screenAudioOn?'on':'off')};screenBtn.parentElement.insertBefore(audioToggleBtn,screenStatus);syncScreenAudioToggle();screenShareSettingsReady.then(syncScreenAudioToggle).catch(()=>{});
const syncAudioToggleAvailability=()=>{audioToggleBtn.disabled=screenBtn.disabled};new MutationObserver(syncAudioToggleAvailability).observe(screenBtn,{attributes:true,attributeFilter:['disabled']});syncAudioToggleAvailability();
// Screen watching is separate from share availability. A stream stays
// discoverable beside its owner's avatar after Stop Watching, just like a
// Discord stream badge, and only the selected stream enters the viewer.
const screenVolWrap=document.createElement('label');screenVolWrap.className='screen-volume';
const screenVolLabel=document.createElement('span');screenVolLabel.textContent='Stream volume';
const screenVol=document.createElement('input');screenVol.type='range';screenVol.min=0;screenVol.max=100;screenVol.value=100;screenVol.setAttribute('aria-label','Stream volume');
screenVol.oninput=()=>{const v=Math.max(0,Math.min(100,Number(screenVol.value)||0))/100;remoteScreen.volume=v;remoteScreen.muted=v===0;if(nativeRemoteAudio){nativeRemoteAudio.volume=v;nativeRemoteAudio.muted=v===0}ssSet('screenVol',String(v))};enableRangeDrag(screenVol);
(async()=>{try{const saved=await ss('screenVol');if(saved!==null){const v=parseFloat(saved);if(v>=0&&v<=1){remoteScreen.volume=v;remoteScreen.muted=v===0;screenVol.value=Math.round(v*100)}}}catch{}})();screenVolWrap.append(screenVolLabel,screenVol);
const shareContextMenu=document.createElement('div');shareContextMenu.className='share-context-menu';shareContextMenu.hidden=true;shareContextMenu.setAttribute('role','menu');document.body.append(shareContextMenu);
function hideShareContextMenu(){shareContextMenu.hidden=true;shareContextMenu.replaceChildren()}
function showShareContextMenu(event,{stopWatching,volume=false,label='Stream'}={}){event.preventDefault();event.stopPropagation();hideShareContextMenu();const title=document.createElement('span');title.className='share-context-title';title.textContent=label;if(volume)shareContextMenu.append(title,screenVolWrap);else shareContextMenu.append(title);const stop=document.createElement('button');stop.type='button';stop.className='share-context-stop';stop.textContent='Stop Watching';stop.setAttribute('role','menuitem');stop.onclick=()=>{hideShareContextMenu();stopWatching?.()};shareContextMenu.append(stop);shareContextMenu.hidden=false;const box=shareContextMenu.getBoundingClientRect();shareContextMenu.style.left=Math.max(8,Math.min(event.clientX,innerWidth-box.width-8))+'px';shareContextMenu.style.top=Math.max(8,Math.min(event.clientY,innerHeight-box.height-8))+'px'}
document.addEventListener('pointerdown',event=>{if(!shareContextMenu.hidden&&!shareContextMenu.contains(event.target))hideShareContextMenu()});window.addEventListener('blur',hideShareContextMenu);
const screenVideos=screenPreview.parentElement;let screenExpanded=false,focusedScreen='remote';
function makeScreenTile(video,label,kind){const tile=document.createElement('article');tile.className='screen-tile '+kind;tile.dataset.screenTile=kind;const name=document.createElement('span');name.className='screen-tile-name';name.textContent=label;tile.append(video,name);return tile}
function makeDmShareBadge(kind,label){const button=document.createElement('button');button.type='button';button.className='participant-share-badge';button.dataset.shareOwner=kind;button.innerHTML='<span aria-hidden="true">▣</span><small>'+label+'</small>';button.title='Watch '+label.toLowerCase();button.setAttribute('aria-label','Watch '+label.toLowerCase());button.onclick=event=>{event.stopPropagation();watchDmShare(kind)};return button}
const localScreenTile=makeScreenTile(screenPreview,'Your stream','local'),remoteScreenTile=makeScreenTile(remoteScreen,'Friend’s stream','remote'),localShareBadge=makeDmShareBadge('local','Your stream'),remoteShareBadge=makeDmShareBadge('remote','Watch stream');screenVideos.replaceChildren(localScreenTile,remoteScreenTile);participantYou.prepend(localShareBadge);participantFriend.prepend(remoteShareBadge);
const screenViewBar=document.createElement('div');screenViewBar.className='screen-view-bar';screenViewBar.innerHTML='<button type="button" data-screen-return title="Return to call" aria-label="Return to call">‹</button><button type="button" data-screen-volume title="Stream volume" aria-label="Stream volume">♫</button><button type="button" data-screen-fullscreen title="Fullscreen" aria-label="Fullscreen">⛶</button>';screenVideos.after(screenViewBar);
const fsBtn=screenViewBar.querySelector('[data-screen-fullscreen]'),screenStage=screenVideos.parentElement;screenStage.classList.add('screen-stage');let nativeShareFullscreen=false;
const screenAudioBadge=document.createElement('span');screenAudioBadge.className='screen-audio-badge';screenStage.appendChild(screenAudioBadge);const syncScreenAudioBadge=()=>{screenAudioBadge.textContent=screenStatus.textContent||'Sharing';screenAudioBadge.hidden=!screenExpanded};new MutationObserver(syncScreenAudioBadge).observe(screenStatus,{childList:true,characterData:true,subtree:true});
function screenIsActive(){return !screenPreview.hidden||!remoteScreen.hidden}
function watchDmShare(kind){const available=kind==='local'?!screenPreview.hidden:!remoteScreen.hidden;if(!available)return;if(kind==='remote'){remoteScreenSuppressed=false;try{remoteScreen.srcObject?.getTracks?.().forEach(track=>{track.enabled=true});nativeRemoteAudio?.srcObject?.getTracks?.().forEach(track=>{track.enabled=true})}catch{}if(remoteScreen.volume>0){remoteScreen.muted=false;if(nativeRemoteAudio)nativeRemoteAudio.muted=false}}focusedScreen=kind;screenExpanded=true;updateScreenLayout()}
function syncScreenPlayback(){const localAvailable=screenPreview.srcObject||nativeLocalPlayer,localSelected=screenExpanded&&focusedScreen==='local';nativeLocalPlayer?.setActive(localSelected);if(!screenPreview.hidden&&localAvailable&&screenPreview.readyState>=2){if(localSelected)screenPreview.play().catch(()=>{});else screenPreview.pause()}const remoteAvailable=remoteScreen.srcObject||nativeRemotePlayer;if(!remoteScreen.hidden&&remoteAvailable){const selected=screenExpanded&&focusedScreen==='remote'&&!remoteScreenSuppressed;nativeRemotePlayer?.setActive(selected);try{remoteScreen.srcObject?.getTracks?.().forEach(track=>{track.enabled=selected});nativeRemoteAudio?.srcObject?.getTracks?.().forEach(track=>{track.enabled=selected})}catch{}if(selected){if(remoteScreen.volume>0)remoteScreen.muted=false;remoteScreen.play().catch(()=>{});if(nativeRemoteAudio){nativeRemoteAudio.volume=remoteScreen.volume;nativeRemoteAudio.muted=remoteScreen.volume===0;if(!nativeRemoteAudio.muted)nativeRemoteAudio.play().catch(()=>{})}}else{remoteScreen.pause();remoteScreen.muted=true;if(nativeRemoteAudio){nativeRemoteAudio.pause();nativeRemoteAudio.muted=true}}}}
function updateScreenLayout(){
  const hasLocal=!screenPreview.hidden,hasRemote=!remoteScreen.hidden,fullscreen=document.fullscreenElement===screenStage||screenStage.classList.contains('fs');if(!hasRemote&&focusedScreen==='remote')focusedScreen='local';if(!hasLocal&&focusedScreen==='local')focusedScreen='remote';if(!hasLocal&&!hasRemote)screenExpanded=false;if(focusedScreen==='remote'&&remoteScreenSuppressed)screenExpanded=false;
  document.body.classList.toggle('screen-share-active',hasLocal||hasRemote||!!document.querySelector('#serverVoiceStage.watching-share'));
  voicePanel.classList.toggle('screen-sharing',hasLocal||hasRemote);voicePanel.classList.toggle('screen-expanded',screenExpanded&&(hasLocal||hasRemote));screenStage.classList.toggle('screen-expanded-local',focusedScreen==='local');
  participantYou.classList.toggle('has-share',hasLocal);participantFriend.classList.toggle('has-share',hasRemote);
  localShareBadge.hidden=!hasLocal;remoteShareBadge.hidden=!hasRemote;localScreenTile.hidden=!screenExpanded||!hasLocal||focusedScreen!=='local';remoteScreenTile.hidden=!screenExpanded||!hasRemote||focusedScreen!=='remote'||remoteScreenSuppressed;screenViewBar.hidden=!screenExpanded;screenViewBar.querySelector('[data-screen-volume]').hidden=focusedScreen!=='remote';fsBtn.textContent=fullscreen?'✕':'⛶';fsBtn.title=fullscreen?'Exit fullscreen':'Fullscreen';syncScreenPlayback();syncScreenAudioBadge();renderDmVoiceUI();
}
function returnToSharePreview(){screenExpanded=false;updateScreenLayout()}
function exitShareFullscreen({collapse=false}={}){nativeShareFullscreen=false;screenStage.classList.remove('fs');document.body.classList.remove('screen-fullscreen');try{if(document.fullscreenElement===screenStage)document.exitFullscreen().catch(()=>{})}catch{}if(collapse)screenExpanded=false;updateScreenLayout()}
async function toggleRemoteFs(){const target=focusedScreen==='local'?screenPreview:remoteScreen;if(screenStage.classList.contains('fs')||document.fullscreenElement===screenStage){exitShareFullscreen();return}if(!screenExpanded||target.hidden)return;
  // Fullscreen the stage, not the <video>.  A video-only request is routinely
  // rejected by Electron's compositor and, when accepted, leaves the call
  // container's insets around it.  The stage owns the selected tile and its
  // controls, so it can fill the physical display reliably.
  try{if(!screenStage.requestFullscreen)throw new Error('stage fullscreen unavailable');await screenStage.requestFullscreen()}catch{screenStage.classList.add('fs');document.body.classList.add('screen-fullscreen')}updateScreenLayout()}
remoteScreenTile.addEventListener('contextmenu',event=>showShareContextMenu(event,{label:'Friend’s stream',volume:true,stopWatching:stopWatchingRemoteShare}));
screenViewBar.onclick=event=>{if(event.target.closest('[data-screen-return]'))returnToSharePreview();else if(event.target.closest('[data-screen-volume]'))showShareContextMenu(event,{label:'Friend’s stream',volume:true,stopWatching:stopWatchingRemoteShare});else if(event.target.closest('[data-screen-fullscreen]'))toggleRemoteFs()};
const screenLayoutObserver=new MutationObserver(updateScreenLayout);screenLayoutObserver.observe(screenPreview,{attributes:true,attributeFilter:['hidden']});screenLayoutObserver.observe(remoteScreen,{attributes:true,attributeFilter:['hidden']});updateScreenLayout();
document.addEventListener('fullscreenchange',()=>{const is=document.fullscreenElement===screenStage;document.body.classList.toggle('screen-fullscreen',is);if(!is)screenStage.classList.remove('fs');updateScreenLayout()});document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(!shareContextMenu.hidden){hideShareContextMenu();return}if(document.fullscreenElement===screenStage||screenStage.classList.contains('fs'))exitShareFullscreen();else if(screenExpanded)returnToSharePreview()});
