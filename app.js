/* Knot: encrypted direct/group chat with on-demand peer-to-peer media and files. */
const PAIR_SIGNAL_SERVER='wss://pair.pair-private-link.workers.dev';
const $=s=>document.querySelector(s);const signalOut=$('#signalOut'),signalIn=$('#signalIn'),copySignal=$('#copySignal'),processSignal=$('#processSignal'),pairCodeMeta=$('#pairCodeMeta'),statusText=$('#statusText'),messages=$('#messages'),messageForm=$('#messageForm'),messageInput=$('#messageInput'),fileInput=$('#fileInput'),chooseFiles=$('#chooseFiles'),transfers=$('#transfers'),pairHint=$('#pairHint'),participantYou=$('#participantYou'),participantFriend=$('#participantFriend'),voiceLog=$('#voiceLog'),screenBtn=$('#screenBtn'),screenStatus=$('#screenStatus'),screenPreview=$('#screenPreview'),remoteScreen=$('#remoteScreen');
const recordMetric=(name,value,tags)=>{try{window.pairMetrics?.record?.(name,Number(value),tags||{})}catch{}};
recordMetric('app.renderer_ready_ms',performance.now());
try{const longTaskObserver=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(entry.duration>=50)recordMetric('renderer.long_task_ms',entry.duration)});longTaskObserver.observe({entryTypes:['longtask']})}catch{}
const updateBanner=$('#updateBanner'),updateTitle=$('#updateTitle'),updateDetails=$('#updateDetails'),updateChanges=$('#updateChanges'),updateChangesList=$('#updateChangesList'),updateActions=$('#updateActions'),acceptUpdate=$('#acceptUpdate');let updateHideTimer=null;
function renderUpdateStatus(status){if(!updateBanner||!status)return;clearTimeout(updateHideTimer);const state=String(status.state||'idle'),canAccept=state==='available'&&status.canInstall!==false,showNotes=state==='available',notes=Array.isArray(status.notes)?status.notes.filter(note=>typeof note==='string'&&note.trim()).slice(0,8):[];updateBanner.className='update-banner update-'+state;updateTitle.textContent=status.message||'Checking for updates…';updateDetails.textContent=status.version?'Knot '+status.version:'';updateBanner.hidden=state==='idle'||state==='current';if(updateChanges&&updateChangesList){updateChangesList.replaceChildren(...notes.map(note=>{const item=document.createElement('li');item.textContent=note;return item}));updateChanges.hidden=!showNotes||!notes.length}if(updateActions)updateActions.hidden=!canAccept;if(acceptUpdate)acceptUpdate.disabled=!canAccept;if(state==='current')updateHideTimer=setTimeout(()=>{updateBanner.hidden=true},1200)}
if(window.pairUpdates){window.pairUpdates.getStatus().then(renderUpdateStatus).catch(()=>{});window.pairUpdates.onStatus(renderUpdateStatus)}
if(acceptUpdate)acceptUpdate.onclick=async()=>{if(!window.pairUpdates?.accept)return;acceptUpdate.disabled=true;await window.pairUpdates.accept().catch(()=>{acceptUpdate.disabled=false})};
let pc,chat,files,role,sharedKey,directFileKey=null,directFileId='',sendQueue=Promise.resolve(),receiveQueue=Promise.resolve(),pairSignalBusy=false,pairReplyAccepted=false;let CHUNK=1024*1024,fileSessionEpoch=0,remoteFileProtocol=1;const MAX=200*1024**3,MAX_DIRECT_CONTROL_BYTES=512*1024,MAX_DIRECT_PROFILE_DATA=128*1024,MAX_FILE_CONTROL_BYTES=64*1024,MAX_OUTGOING_FILE_QUEUE=64;
const peerNetBudgets=new Map(),shareBudgetApplied=new Map();
let netBudgetTimer=null,networkReceiveCongested=false,networkLiveReceiveMbps=NaN;
let directoryTrustedConnection=false,recordConversationMessage=()=>{},directoryProfilePush=()=>{},syncFileAttachmentUi=()=>{},syncComposerAvailability=disabled=>{messageInput.disabled=!!disabled};
// Directory/call state must exist before any asynchronous settings/profile
// restoration can render the UI. Declaring it later created a startup TDZ race
// that only showed up reliably when two complete app windows booted together.
let directorySocket=null,directoryReconnect=null,directoryBackoff=1000,directoryConnectGeneration=0,directoryStateRestored=false,directoryRevision=0,directoryEmptySnapshotRetry=false,directoryFeatures={groupSfu:false,encryptedFileRelay:false},accountAuthGeneration=0,directoryUserId='',directoryToken='',directoryAccountName='',transientDirectorySession=false,pendingAccountRemember=true,directorySnapshot={friends:[],servers:[],groupDms:[],members:{},voiceStates:{}},activePeerId='',dmPeerId='',dmCallPeerId='',activeServerId='',activeGroupDmId='',activeChannelId='',activeConversationKey='',historyRendering=false,dmConnectingPeerId='',pendingVoiceStartPeerId='',conversationScrollEpoch=0,conversationScrollObserver=null,conversationScrollTimer=null,conversationScrollLoadListener=null;
let conversationHistories={},conversationRenderState=null,conversationLoadGeneration=0,serverVoiceStream=null,serverVoiceRawStream=null,serverVoiceNoisePipeline=null,serverVoiceAttempt=null,serverVoiceStarting=false,serverVoiceGen=0,serverScreenStream=null,serverNativeScreenSession=null,serverNativeLocalPlayer=null,serverNativeScreenAudioStream=null,serverNativeScreenInit=null,serverNativeFallbackInFlight=false,serverVoiceMuted=false,serverScreenStarting=false,serverScreenGen=0,joinedVoiceServerId='',joinedVoiceChannelId='',joinedVoiceScope='',joinedVoiceAt=0,voiceElapsedTimer=null,draggedChannelId='';const serverPeers=new Map(),conversationDrafts=new Map(),HISTORY_PAGE_SIZE=80,HISTORY_DOM_LIMIT=120,HISTORY_CACHE_LIMIT=2000;
let serverSilentAudioCtx=null,serverSilentAudioStream=null,serverSilentScreenAudioTrack=null;
let groupSfuPilotEnabled=false,groupSfuPilot=null,groupSfuStarting=false;const groupSfuPending=new Map(),groupSfuAudios=new Map();
let encryptedFileRelayEnabled=false,fileRelayBatchActive=false;const fileRelayPending=new Map(),fileRelayReceiving=new Set();
let socialSidebarWidth=280,pendingServerSelection=false,pendingChannelCreation=null,pendingGroupSelection=null,pendingGroupUpdateId='';
let closedDmIds=new Set();
let unreadDmCounts={};
const GROUP_DM_MAX_MEMBERS=20;
const lanNeighbors=new Map(),lanSockets=new Map(),lanFingerprints=new Map();
let lanStarted=false,lanSelfFp='',lanNonce='',lanPairing=null;
let watchSession=null,watchSeq=0,watchApplying=false,watchLeader=false,watchTimer=null,watchObjectUrl='';
// Voice: a live two-way WebRTC audio call on the SAME peer connection. Media is
// encrypted by WebRTC's built-in DTLS-SRTP, so it reuses the existing E2EE link.
let localStream=null,localMicrophoneStream=null,voiceNoisePipeline=null,activeNoiseProcessor='raw',rnnoiseModulePromise=null,deepFilterModulePromise=null,micMuted=false,callActive=false,callStart=0,callTimerId=null,callStarting=false,callGen=0,reconnectCall=false;
// Screen share: video via getDisplayMedia; system audio only via native
// process-loopback / PipeWire so Knot's own call playback is never re-captured.
let screenNative=false,screenOutCtx=null,screenOutDest=null,screenCaptureCleanup=null,screenCaptureOwner=null,screenCaptureAttempt=0,remoteScreenDecodeStop=null;
// Direct handle to the audio transceiver created in setupPeer, so startCall can
// always reuse it (never add a second m-line). Nulled on disconnect/teardown.
let audioTransceiver=null,screenAudioTransceiver=null;
// Keep the interface fully usable while this build is being tested without a
// second device. Network-only actions stay local and are clearly labelled.
// Local-only controls are opt-in for development. Packaged builds must never
// present themselves as a test client or enable call/share actions before a
// real peer connection exists.
const LOCAL_TEST_MODE=new URLSearchParams(location.search).get('testMode')==='1';
// Per-connection sound flags so the chimes don't double/triple: chat+files both
// report "connected", and connection-loss/voice-leave can each fire a leave tone.
let connectSoundDone=false,friendLeftNotified=false,friendInCall=false,friendPresenceTimer=null,friendHeartbeatTimer=null,selfInCall=false,selfPresenceTimer=null,callPresenceTimer=null,callToneTimer=null;
let screenTransceiver=null,screenActive=false,screenStarting=false,screenSharePickerPending=false,screenStream=null,screenGen=0,screenSenders=[],screenStatsTimer=null,screenStatsLast=null,screenStatsGeneration=0,screenFallbackBitrateCapMbps=0,remoteScreenExpected=false,remoteNativeScreenExpected=false,remoteScreenSuppressed=false,remoteScreenWatchAnnounced=false,friendWatchingScreen=false,screenAudioDebug='',screenSharePickerEpoch=0,screenSharePickerCancel=null,primedScreenAudioCtx=null,primedScreenAudioTimer=null;
let nativeScreenSession=null,nativeScreenChannel=null,remoteNativeScreenChannel=null,nativeLocalPlayer=null,nativeRemotePlayer=null,nativeRemoteAudio=null,nativeScreenFallbackInFlight=false,nativeScreenAnnounced=false,nativeScreenAudioStream=null;
const callBtn=$('#callBtn'),muteBtn=$('#muteBtn'),volumeSlider=$('#volumeSlider'),volumeValue=$('#volumeValue'),callStatus=$('#callStatus'),callTimerEl=$('#callTimer'),remoteAudio=$('#remoteAudio'),connectCard=$('#connectCard'),addFriendBtn=$('#addFriend'),panelBackdrop=$('#panelBackdrop'),profileBtn=$('#profileBtn'),profileInput=$('#profileInput'),profileAdjust=$('#profileAdjust'),profileEditor=$('#profileEditor'),profileZoom=$('#profileZoom'),profileX=$('#profileX'),profileY=$('#profileY'),profileDone=$('#profileDone'),friendAvatar=$('#friendAvatar'),voicePanel=$('#voicePanel'),roomTitle=$('#roomTitle'),settingsPanel=$('#settingsPanel'),settingsAvatar=$('#settingsAvatar'),settingsChangePhoto=$('#settingsChangePhoto'),settingsAdjustPhoto=$('#settingsAdjustPhoto'),settingsRemovePhoto=$('#settingsRemovePhoto'),displayNameInput=$('#displayName'),yourNameEl=$('#yourName'),friendNameEl=$('#friendName'),inputDevice=$('#inputDevice'),outputDevice=$('#outputDevice'),voiceProcessing=$('#voiceProcessing'),noiseReduction=$('#noiseReduction'),noiseHardware=$('#noiseHardware'),noiseProcessingHint=$('#noiseProcessingHint'),voiceInputMode=$('#voiceInputMode'),pushToTalkSettings=$('#pushToTalkSettings'),pushToTalkKeyButton=$('#pushToTalkKey'),pushToTalkDelayInput=$('#pushToTalkDelay'),pushToTalkDelayValue=$('#pushToTalkDelayValue'),deviceHint=$('#deviceHint'),testMicrophone=$('#testMicrophone'),reduceMotion=$('#reduceMotion'),soundEffects=$('#soundEffects'),shareProfile=$('#shareProfile'),rememberInvite=$('#rememberInvite'),hardwareAcceleration=$('#hardwareAcceleration'),hardwareHint=$('#hardwareHint'),transferSetupStatus=$('#transferSetupStatus'),fileTransportSetting=$('#fileTransport'),tcpListenPortInput=$('#tcpListenPort');
function renderCallButtonState(state='start',label=state==='end'?'End call':'Start call',title=label){const end=state==='end';callBtn.dataset.callState=end?'end':'start';const text=callBtn.querySelector('.call-button-label');if(text)text.textContent=label;const startIcon=callBtn.querySelector('[data-call-icon="start"]'),endIcon=callBtn.querySelector('[data-call-icon="end"]');if(startIcon)startIcon.hidden=end;if(endIcon)endIcon.hidden=!end;callBtn.title=title;callBtn.setAttribute('aria-label',title)}
renderCallButtonState('start','Start call','Start voice call');
let profileAvatar='',profileFrame={zoom:100,x:50,y:50},profileIdentity=makeProfileIdentity(),profileName='You',friendName='Friend',inputDeviceId='default',outputDeviceId='default',voiceProcessingEnabled=false,noiseReductionMode='rnnoise',noiseHardwareMode='auto',voiceInputModeValue='voice',pushToTalkKey='Space',pushToTalkDelay=0,pushToTalkHeld=false,pushToTalkCapturing=false,pushToTalkReleaseTimer=null,soundEnabled=true,profileSharing=true,rememberInviteCode=true,micTestStream=null,micTestRawStream=null,micTestNoisePipeline=null,micTestSource=null,micTestGain=null,directProfileGeneration=0,directAvatarSource='',directAvatarCache='',profileSettingsReady=Promise.resolve();
// A 5 MiB source GIF expands to roughly 6.7 MiB as a data URL. This remains
// available for local display while transport-specific thumbnails stay bounded.
const MAX_PROFILE_DATA=7*1024*1024;
// The call stage stays above the direct-message timeline, matching a DM call.
// Keeping it in the document flow means messages are never hidden behind it.
// Lightweight synth sound effects via Web Audio (no asset files needed). Each
// call lazily creates/resumes the AudioContext so it works after a user gesture
// and stays quiet until then.
let audioCtx=null;
function sfxCtx(){if(!audioCtx){try{audioCtx=new (window.AudioContext||window.webkitAudioContext)();if(outputDeviceId&&typeof audioCtx.setSinkId==='function')audioCtx.setSinkId(outputDeviceId).catch(()=>{})}catch{return null}}if(audioCtx.state==='suspended'){try{audioCtx.resume()}catch{}}return audioCtx}
let speakingAudioCtx=null,speakingMonitorTimer=null,remoteVoiceTrack=null,remoteVoiceTransceiver=null;const speakingMonitors=new Map();
function speakingTargets(key){if(key==='dm-self')return[participantYou.querySelector('.avatar'),$('#sidebarProfileAvatar')].filter(Boolean);if(key==='dm-friend')return[participantFriend.querySelector('.avatar'),dmCallPeerId?document.querySelector(`.friend-entry[data-id="${dmCallPeerId}"] .friend-avatar`):null].filter(Boolean);const id=key.startsWith('server:')?key.slice(7):'';return id?[...document.querySelectorAll(`[data-speaking-id="${id}"]`)]:[]}
function paintSpeaking(key,on){speakingTargets(key).forEach(node=>node.classList.toggle('speaking',on))}
function refreshSpeakingPaint(){for(const [key,monitor] of speakingMonitors)paintSpeaking(key,!!monitor.speaking)}
function sampleSpeakingMonitors(){const now=performance.now();for(const [key,monitor] of speakingMonitors)try{const{track,analyser,samples}=monitor;if(track.readyState!=='live'){stopSpeakingMonitor(key);continue}analyser.getFloatTimeDomainData(samples);let energy=0,peak=0;for(const sample of samples){energy+=sample*sample;peak=Math.max(peak,Math.abs(sample))}const rms=Math.sqrt(energy/samples.length),openGate=Math.max(.0075,monitor.noiseFloor*2.7),closeGate=Math.max(.0055,monitor.noiseFloor*1.8);if(!monitor.speaking&&rms<openGate)monitor.noiseFloor=monitor.noiseFloor*.94+rms*.06;const voiced=track.enabled!==false&&(rms>(monitor.speaking?closeGate:openGate)||peak>openGate*2.1);if(voiced)monitor.holdUntil=now+165;const speaking=voiced||now<monitor.holdUntil;if(speaking!==monitor.speaking){monitor.speaking=speaking;paintSpeaking(key,speaking)}}catch{stopSpeakingMonitor(key)}}
function ensureSpeakingMonitorTimer(){if(!speakingMonitorTimer)speakingMonitorTimer=setInterval(sampleSpeakingMonitors,24)}
function stopSpeakingMonitor(key){const monitor=speakingMonitors.get(key);if(monitor){try{monitor.track?.removeEventListener?.('ended',monitor.onEnded)}catch{}try{monitor.source.disconnect()}catch{}try{monitor.analyser.disconnect()}catch{}try{monitor.sink?.disconnect()}catch{}speakingMonitors.delete(key)}paintSpeaking(key,false);if(!speakingMonitors.size){clearInterval(speakingMonitorTimer);speakingMonitorTimer=null;if(speakingAudioCtx){try{speakingAudioCtx.close()}catch{}speakingAudioCtx=null}}}
function monitorSpeaking(key,stream){
  const track=stream?.kind==='audio'?stream:stream?.getAudioTracks?.().find(value=>value.readyState==='live')||stream?.getAudioTracks?.()[0];const current=speakingMonitors.get(key);if(current?.track===track&&track?.readyState==='live'){if(speakingAudioCtx?.state==='suspended')speakingAudioCtx.resume().catch(()=>{});return}stopSpeakingMonitor(key);if(!track)return;
  try{
    if(!speakingAudioCtx)speakingAudioCtx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000});
    if(speakingAudioCtx.state==='suspended')speakingAudioCtx.resume().catch(()=>{});
    const source=speakingAudioCtx.createMediaStreamSource(new MediaStream([track])),analyser=speakingAudioCtx.createAnalyser(),sink=speakingAudioCtx.createGain(),samples=new Float32Array(256),monitor={track,source,analyser,sink,samples,onEnded:null,speaking:false,noiseFloor:.003,holdUntil:0};
    analyser.fftSize=256;analyser.smoothingTimeConstant=0;sink.gain.value=0;source.connect(analyser).connect(sink).connect(speakingAudioCtx.destination);
    // One shared 24 ms clock samples every participant. Each track retains its
    // own adaptive gate, but group calls no longer create ten independent UI
    // timers that wake the renderer at slightly different times.
    monitor.onEnded=()=>{if(speakingMonitors.get(key)===monitor)stopSpeakingMonitor(key)};speakingMonitors.set(key,monitor);track.addEventListener?.('ended',monitor.onEnded,{once:true});ensureSpeakingMonitorTimer();
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
function mallet(ctx,freq,start,dur,gain=0.1){tone(ctx,freq,start,dur,'triangle',gain);tone(ctx,freq*2,start,Math.min(.08,dur*.4),'sine',gain*.32)}
function setParticipant(el,on){if(el===participantFriend){setFriendPresence(on,{sound:false});return}if(el===participantYou){setSelfPresence(on);return}const dot=el.querySelector('.indicator');if(dot)dot.classList.toggle('on',on)}
function syncVoiceStage(){
  const active=!!(callActive||friendInCall),waiting=!!(callActive&&!friendInCall),incoming=!!(!callActive&&friendInCall),together=!!(callActive&&friendInCall),waitingCard=$('#callWaiting');
  voicePanel.classList.toggle('call-active',active);voicePanel.classList.toggle('call-waiting-peer',waiting);voicePanel.classList.toggle('call-incoming',incoming);voicePanel.classList.toggle('call-together',together);
  if(waitingCard){waitingCard.hidden=!waiting;const title=$('#callWaitingTitle'),peer=directoryUser(dmCallPeerId||dmPeerId||activePeerId)?.name||friendName||'your friend';if(title)title.textContent='Waiting for '+peer}
  renderDmVoiceUI()
}
function setFriendPresence(on,{animate=true,sound=true}={}){
  const wasPresent=friendInCall;friendInCall=on;if(!on&&(remoteScreenExpected||remoteScreen.srcObject||!remoteScreen.hidden))clearRemoteScreenShare('Friend left the call');syncVoiceStage();const dot=participantFriend.querySelector('.indicator');if(dot)dot.classList.toggle('on',on);
  if(friendPresenceTimer){clearTimeout(friendPresenceTimer);friendPresenceTimer=null}
  if(on){
    participantFriend.classList.remove('is-absent','is-leaving');participantFriend.removeAttribute('aria-hidden');
    if(animate&&!wasPresent){participantFriend.classList.remove('is-entering');void participantFriend.offsetWidth;participantFriend.classList.add('is-entering');setTimeout(()=>{if(friendInCall)participantFriend.classList.remove('is-entering')},620);if(sound)playSound('friend-join')}
    return;
  }
  if(!wasPresent){participantFriend.classList.remove('is-entering','is-leaving');participantFriend.classList.add('is-absent');participantFriend.setAttribute('aria-hidden','true');return}
  participantFriend.classList.remove('is-entering');
  if(animate){participantFriend.classList.add('is-leaving');friendPresenceTimer=setTimeout(()=>{if(!friendInCall){participantFriend.classList.remove('is-leaving');participantFriend.classList.add('is-absent');participantFriend.setAttribute('aria-hidden','true')}},520)}else{participantFriend.classList.remove('is-leaving');participantFriend.classList.add('is-absent');participantFriend.setAttribute('aria-hidden','true')}
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
function stopCallTone(){if(callToneTimer){clearInterval(callToneTimer);callToneTimer=null}}
function startCallTone(kind,maxPulses=5){stopCallTone();let pulses=0;const pulse=()=>{const valid=kind==='ring'?friendInCall&&!callActive:callActive&&!friendInCall;if(!valid||pulses>=maxPulses){stopCallTone();return}pulses++;playSound(kind)};pulse();callToneTimer=setInterval(pulse,3200)}
function publishCallState(active){
  if(active&&!localCallSessionId)localCallSessionId=clientHex(8);
  try{send({t:'call-state',active:!!active,session:localCallSessionId,at:Date.now()})}catch{}
  const peerId=dmCallPeerId||dmPeerId||activePeerId;if(peerId)directorySend({type:'call-presence',peerId,active:!!active,session:localCallSessionId});
  clearInterval(callPresenceTimer);callPresenceTimer=null;if(active)callPresenceTimer=setInterval(()=>publishCallState(true),4000);
  if(!active)localCallSessionId='';
}
function applyRemoteCallState(active,session=''){
  if(friendHeartbeatTimer){clearTimeout(friendHeartbeatTimer);friendHeartbeatTimer=null}
  if(active){const wasPresent=friendInCall;remoteCallSessionId=String(session||remoteCallSessionId||'legacy');friendLeftNotified=false;setFriendPresence(true,{animate:true,sound:callActive});renderCallPeerProfile();setRemoteCallAudio(callActive);if(callActive){stopCallTone();ensureRemoteSpeakingMonitor()}else if(!wasPresent)startCallTone('ring',6);friendHeartbeatTimer=setTimeout(()=>{friendHeartbeatTimer=null;if(friendInCall)applyRemoteCallState(false,'heartbeat-expired')},12000);return}
  const wasPresent=friendInCall;remoteCallSessionId='';stopCallTone();setFriendPresence(false,{animate:true,sound:false});stopSpeakingMonitor('dm-friend');clearRemoteScreenShare('Friend left the call');if(!callActive)dmCallPeerId='';if(wasPresent&&!friendLeftNotified){friendLeftNotified=true;playSound(callActive?'friend-leave':'leave')}if(callActive){callStatus.textContent='Waiting for your friend';callStatus.className='call-status ringing';startCallTone('calling',3)}else{callStatus.textContent='Friend left the call';callStatus.className='call-status'}renderDmVoiceUI();renderFriends();
}
function logCallEvent(text){const e=document.createElement('div'),time=document.createElement('span');e.className='log-entry';time.className='log-time';time.textContent=new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});e.append(time,document.createTextNode(String(text)));voiceLog.append(e)}
function playSound(kind){
  if(!soundEnabled)return;
  const ctx=sfxCtx();if(!ctx)return;
  if(kind==='connect'){tone(ctx,440,0,.12,'sine',.07);tone(ctx,659.25,.07,.17,'sine',.09);tone(ctx,987.77,.15,.25,'sine',.08)}
  else if(kind==='connecting'){tone(ctx,293.66,0,.13,'sine',.065);tone(ctx,369.99,.13,.13,'sine',.065);tone(ctx,440,.26,.2,'sine',.07)}
  else if(kind==='calling'){mallet(ctx,392,0,.12,.09);mallet(ctx,523.25,.13,.12,.1);mallet(ctx,659.25,.28,.22,.12)}
  else if(kind==='ring'){mallet(ctx,523.25,0,.11,.1);mallet(ctx,659.25,.11,.11,.11);mallet(ctx,783.99,.22,.12,.12);mallet(ctx,1046.5,.36,.2,.14);mallet(ctx,659.25,.6,.1,.09);mallet(ctx,783.99,.72,.3,.12);tone(ctx,392,.72,.3,'sine',.05)}
  else if(kind==='friend-join'){tone(ctx,523.25,0,.12,'sine',.08);tone(ctx,659.25,.06,.2,'sine',.09);tone(ctx,1046.5,.16,.28,'triangle',.07)}
  else if(kind==='screen-watch'){tone(ctx,783.99,0,.10,'sine',.055);tone(ctx,1046.5,.09,.18,'triangle',.06)}
  else if(kind==='friend-leave'){tone(ctx,659.25,0,.12,'triangle',.075);tone(ctx,493.88,.08,.17,'sine',.075);tone(ctx,329.63,.18,.25,'sine',.065)}
  else if(kind==='hangup'){tone(ctx,440,0,.11,'triangle',.085);tone(ctx,349.23,.07,.14,'sine',.08);tone(ctx,261.63,.16,.24,'sine',.07)}
  else if(kind==='leave'){tone(ctx,493.88,0,.10,'triangle',.07);tone(ctx,293.66,.06,.22,'sine',.075)}
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
    (async()=>{try{const saved=parseFloat(await ss('volume'));setCallVolume(saved>0&&saved<=1?Math.round(saved*100):100,false)}catch{setCallVolume(100,false)}})()
    try{const src=ctx.createMediaStreamSource(st);src.connect(ctx.audioGain);ctx.audioSink=src}catch{}
  }catch{}
}
function setCallVolume(percent,persist=true){const value=Math.max(0,Math.min(100,Number(percent)||0))/100,display=Math.round(value*100);volumeSlider.value=String(display);volumeSlider.style.setProperty('--range-fill',display+'%');volumeValue.textContent=display+'%';try{const ctx=sfxCtx();if(ctx&&ctx.audioGain)ctx.audioGain.gain.setValueAtTime(value,ctx.currentTime)}catch{};try{remoteAudio.volume=0;remoteAudio.muted=!callActive}catch{};if(persist)ssSet('volume',String(value));}
setCallVolume(100,false);
function enableRangeDrag(range){if(!range||range.dataset.pairDrag)return;range.dataset.pairDrag='1';let pointerId=null;const setFromPointer=e=>{const box=range.getBoundingClientRect(),min=Number(range.min)||0,max=Number(range.max)||100,step=Number(range.step)||1,ratio=Math.max(0,Math.min(1,(e.clientX-box.left)/Math.max(1,box.width))),raw=min+(max-min)*ratio,value=Math.round((raw-min)/step)*step+min;range.value=String(Math.max(min,Math.min(max,value)));range.dispatchEvent(new Event('input',{bubbles:true}))};range.addEventListener('pointerdown',e=>{if(e.button!==0)return;range.focus({preventScroll:true});pointerId=e.pointerId;range.setPointerCapture?.(pointerId);setFromPointer(e);e.preventDefault()});range.addEventListener('pointermove',e=>{if(e.pointerId===pointerId)setFromPointer(e)});const finish=e=>{if(e.pointerId!==pointerId)return;try{range.releasePointerCapture?.(pointerId)}catch{};pointerId=null;range.dispatchEvent(new Event('change',{bubbles:true}))};range.addEventListener('pointerup',finish);range.addEventListener('pointercancel',finish)}
function setRemoteCallAudio(enabled){try{if(!enabled){remoteAudio.muted=true;remoteAudio.pause();const ctx=audioCtx;if(ctx?.audioSink){ctx.audioSink.disconnect();delete ctx.audioSink}return}ensureRemoteSpeakingMonitor();remoteAudio.muted=false;remoteAudio.volume=0;remoteAudio.play().catch(()=>{});setupPermanentAudioSink()}catch{}}
remoteAudio.addEventListener('play',()=>{if(!callActive)queueMicrotask(()=>setRemoteCallAudio(false))});
// Keep enough encrypted data queued to fill fast LAN and broadband paths from
// the first packet.  The file channel still has real SCTP backpressure, so this
// is a high-throughput window rather than an unsafe unbounded queue.
// Start with the high-throughput window used by fast paths, then learn a lower
// safe value only if this particular browser reports a full RTCDataChannel
// queue. That retains LAN/broadband speed without treating queue pressure as a
// transfer failure on smaller Chromium queues.
const MAX_SEND_WINDOW=48*1024*1024,MIN_SEND_WINDOW=8*1024*1024;let sendWindow=MAX_SEND_WINDOW;
const MIN_FILE_CHUNK_BYTES=16*1024,FILE_FRAME_RESERVE_BYTES=4096;
function negotiatedFileChunkSize(maxMessageSize){const negotiated=Number(maxMessageSize)||16*1024*1024;return Math.min(4*1024*1024,Math.max(MIN_FILE_CHUNK_BYTES,negotiated-FILE_FRAME_RESERVE_BYTES))}
const CRYPTO_AHEAD_BYTES=32*1024*1024,MAX_CRYPTO_AHEAD=32;
function cryptoAhead(chunkSize=CHUNK){return Math.max(2,Math.min(MAX_CRYPTO_AHEAD,Math.ceil(CRYPTO_AHEAD_BYTES/Math.max(1,chunkSize))))}
function currentFileSession(expectedPeerId){const bus=fileBus();if(!bus||!pc||!sharedKey)return null;if(expectedPeerId&&dmPeerId!==expectedPeerId)return null;return{epoch:fileSessionEpoch,peerId:dmPeerId||'',pc,bus,key:sharedKey}}
function liveFileSession(session){return !!session&&session.epoch===fileSessionEpoch&&session.pc===pc&&session.bus===files&&session.key===sharedKey&&session.bus?.readyState==='open'&&(!session.peerId||session.peerId===dmPeerId)}
function assertFileSession(session){if(!liveFileSession(session))throw new Error('File connection changed or disconnected')}
function announceFileCapabilities(epoch=fileSessionEpoch,attempt=0){if(epoch!==fileSessionEpoch)return;const session=currentFileSession();if(session){void safeSend(JSON.stringify({t:'file-capabilities',v:2,offsets:true,receipt:true}),session).catch(()=>{});return}if(attempt<6)setTimeout(()=>announceFileCapabilities(epoch,attempt+1),100*(attempt+1))}
// Every offer/accept/progress/cancel/end packet stays on the ordered WebRTC
// control channel. The optional TCP lane carries binary chunk envelopes only;
// treating its Buffer frames as control JSON was the root cause of TCP offers
// timing out without ever reaching the receiver.
async function safeSend(data,session=currentFileSession()){if(typeof data!=='string'||data.length>MAX_FILE_CONTROL_BYTES)throw new Error('invalid file control message');assertFileSession(session);return webRtcSafeSend(session.bus,data,session)}
// Apply backpressure to the direct WebRTC file channel so its send buffer
// remains bounded even during very large transfers.
const FILE_DRAIN_TIMEOUT=45000,busDrains=new Map();function awaitBusDrain(bus,session,afterSendError=false){if(!bus||bus.readyState!=='open'||session&&!liveFileSession(session))return Promise.resolve(false);const low=sendWindow*.5,starting=bus.bufferedAmount,goal=afterSendError?Math.min(low,Math.max(0,starting-Math.max(CHUNK,1024*1024))):low;if(bus.bufferedAmount<=goal)return Promise.resolve(true);let waiters=busDrains.get(bus);if(!waiters){waiters=new Set();busDrains.set(bus,waiters)}return new Promise(resolve=>{let done=false;const finish=ok=>{if(done)return;done=true;clearInterval(timer);clearTimeout(timeout);try{bus.removeEventListener('bufferedamountlow',h)}catch{};waiters.delete(h);resolve(ok)};const h=()=>{if(bus.readyState!=='open'||session&&!liveFileSession(session))finish(false);else if(bus.bufferedAmount<=goal)finish(true)};const timer=setInterval(h,30);const timeout=setTimeout(()=>finish(false),FILE_DRAIN_TIMEOUT);try{bus.addEventListener('bufferedamountlow',h)}catch{};waiters.add(h)})}
async function webRtcSafeSend(bus,data,session){let retries=0;for(;;){if(!bus||bus.readyState!=='open'||session&&!liveFileSession(session))throw new Error('disconnected');
  // Proactively wait if the socket's send buffer is already near the window, so
  // we never overflow it (which would throw and abort the whole transfer).
  if(bus.bufferedAmount>=sendWindow){if(!await awaitBusDrain(bus,session))throw new Error('File transfer stalled — the direct connection stopped draining');continue}
  try{bus.send(data);return}catch(e){const m=String(e?.message||'').toLowerCase();if(m.includes('closed')||m.includes('not connected')||(m.includes('invalid state')&&bus.readyState!=='open'))throw new Error('disconnected');if(m.includes('send queue is full')||m.includes('buffered')||m.includes('invalid state')){sendWindow=Math.min(sendWindow,Math.max(MIN_SEND_WINDOW,bus.bufferedAmount-Math.max(CHUNK,1024*1024)));try{bus.bufferedAmountLowThreshold=Math.max(1024*1024,sendWindow*.5)}catch{}retries++;if(retries>8)throw new Error('File transfer stalled — the direct connection send queue stayed full');if(!await awaitBusDrain(bus,session,true))throw new Error('File transfer stalled — the direct connection stopped draining');continue}throw e}}}
async function busSafeSend(data,session,tcpId=''){assertFileSession(session);if(typeof data==='string')throw new Error('file controls cannot use the TCP chunk lane');const candidate=activeDirectFileId(session,tcpId);if(candidate&&window.pairDirectFile){try{await window.pairDirectFile.send(candidate,data);assertFileSession(session);return'tcp'}catch{retireDirectFilePeer(candidate)}}await webRtcSafeSend(session.bus,data,session);return'webrtc'}
// Both peers used to start at sequence 1. Simultaneous uploads therefore
// collided in the shared control maps. Start in a random safe-integer range so
// each endpoint has a practically unique transfer namespace, while keeping the
// numeric wire format compatible with older app versions.
const fileSeqSeed=crypto.getRandomValues(new Uint32Array(2));let sendAbort=new Map(),fileSeq=fileSeqSeed[0]*0x100000+(fileSeqSeed[1]&0xffff);
// Pack metadata+iv+ciphertext into one binary frame: [4B json len][json][iv 12B][ct].
// One send() per chunk (no separate control frame). JSON carries seq/last flags.
function packChunk(seq,offset,ivBuf,ctBuf,last){const hdr=JSON.stringify({t:'c',s:seq,o:offset,l:last?1:0});const h=enc.encode(hdr);const frame=new ArrayBuffer(4+h.length+12+ctBuf.byteLength);const v=new DataView(frame);v.setUint32(0,h.length);new Uint8Array(frame,4,h.length).set(h);new Uint8Array(frame,4+h.length,12).set(ivBuf);new Uint8Array(frame,4+h.length+12).set(ctBuf);return frame}
const enc=new TextEncoder(),dec=new TextDecoder();
function setStatus(text,on=false){statusText.textContent=text;$('.connection').classList.toggle('connected',on);if(connectCard)connectCard.hidden=on;if(addFriendBtn)addFriendBtn.disabled=on;  if(on){CHUNK=negotiatedFileChunkSize(pc?.sctp?.maxMessageSize);syncComposerAvailability(false);messageForm.querySelector('.send').disabled=false;fileInput.disabled=relayVoiceMode||!!(activePeerId&&dmPeerId!==activePeerId);syncFileAttachmentUi();$('#leaveRoom').hidden=false;$('#hostRoom').hidden=true;$('#joinRoom').hidden=true;callBtn.disabled=false;if(!connectSoundDone){playSound('connect');connectSoundDone=true}queueMicrotask(()=>{if(activePeerId&&!activeServerId)syncActiveDmTransport()})}else{syncComposerAvailability(true);messageForm.querySelector('.send').disabled=true;fileInput.disabled=true;syncFileAttachmentUi();callBtn.disabled=true;endCall(true);queueMicrotask(()=>{if(activePeerId&&!activeServerId)syncActiveDmTransport()})}}
const MAX_SIGNAL_SIZE=1024*1024,MAX_PEER_SDP_SIZE=512*1024,MAX_MESSAGE_SIZE=64*1024,SIGNAL_COMPRESSED_PREFIX='pair1.',SIGNAL_RAW_PREFIX='pair0.';
function validPeerSdp(value){return typeof value==='string'&&value.length>0&&value.length<=MAX_PEER_SDP_SIZE&&/^v=0(?:\r?\n|$)/.test(value)?value:null}
function cleanIceCandidate(value){if(!value||typeof value!=='object'||typeof value.candidate!=='string'||value.candidate.length>4096)return null;const mid=value.sdpMid==null?null:String(value.sdpMid),line=value.sdpMLineIndex==null?null:Number(value.sdpMLineIndex),username=value.usernameFragment==null?undefined:String(value.usernameFragment);if(mid!==null&&mid.length>64||line!==null&&(!Number.isInteger(line)||line<0||line>255)||username!==undefined&&username.length>256)return null;return{candidate:value.candidate,sdpMid:mid,sdpMLineIndex:line,...(username===undefined?{}:{usernameFragment:username})}}
// Dot is used instead of base64url's underscore. Discord treats underscores
// as Markdown emphasis, but dots and hyphens copy cleanly in ordinary chat.
// The decoder still accepts legacy underscores so existing invites keep working.
function base64UrlEncode(bytes){let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(binary).replace(/\+/g,'-').replace(/\//g,'.').replace(/=+$/,'')}
function base64UrlDecode(value){if(!/^[A-Za-z0-9_.-]+$/.test(value))throw new Error('Pairing code is malformed');const binary=atob(value.replace(/-/g,'+').replace(/[_.]/g,'/')+'='.repeat((4-value.length%4)%4));return Uint8Array.from(binary,c=>c.charCodeAt(0))}
async function readSignalStream(stream){const reader=stream.getReader(),chunks=[];let length=0;for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_SIGNAL_SIZE){try{await reader.cancel()}catch{}throw new Error('Pairing code expands beyond the allowed size')}chunks.push(value)}const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}return bytes}
function validPairingSignal(value){if(!value||!['offer','answer'].includes(value.type)||!validPeerSdp(value.sdp)||!validDevicePublicKey(value.pub))throw new Error('This is not a valid Knot invite or reply');return value}
async function makeSignal(value){const raw=enc.encode(JSON.stringify(validPairingSignal(value)));if(raw.byteLength>MAX_SIGNAL_SIZE)throw new Error('Pairing code is too large');try{if(!window.CompressionStream)throw new Error('Compression unavailable');const packed=await readSignalStream(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')));if(packed.byteLength<raw.byteLength)return SIGNAL_COMPRESSED_PREFIX+base64UrlEncode(packed)}catch{}return SIGNAL_RAW_PREFIX+base64UrlEncode(raw)}
async function cleanSignal(value){const code=String(value||'').trim();if(!code||code.length>MAX_SIGNAL_SIZE)throw new Error('Pairing code is missing or too large');let bytes;if(code.startsWith(SIGNAL_COMPRESSED_PREFIX)){if(!window.DecompressionStream)throw new Error('This compact code needs a newer version of Knot');bytes=await readSignalStream(new Blob([base64UrlDecode(code.slice(SIGNAL_COMPRESSED_PREFIX.length))]).stream().pipeThrough(new DecompressionStream('deflate')))}else if(code.startsWith(SIGNAL_RAW_PREFIX))bytes=base64UrlDecode(code.slice(SIGNAL_RAW_PREFIX.length));else{try{bytes=Uint8Array.from(atob(code),c=>c.charCodeAt(0))}catch{throw new Error('This is not a Knot pairing code')}}if(bytes.byteLength>MAX_SIGNAL_SIZE)throw new Error('Pairing code is too large');try{return validPairingSignal(JSON.parse(dec.decode(bytes)))}catch(e){if(e.message?.includes('valid Knot'))throw e;throw new Error('This is not a valid Knot invite or reply')}}
function setOutgoingCode(code){signalOut.value=code;copySignal.disabled=!code;pairCodeMeta.textContent=code?'Compact private code · '+code.length+' characters':''}
async function copyOutgoingCode(){const code=signalOut.value;if(!code)return;try{await navigator.clipboard.writeText(code)}catch{signalOut.focus();signalOut.select();if(!document.execCommand('copy'))throw new Error('Copy was blocked')}copySignal.textContent='Copied';setTimeout(()=>{copySignal.textContent='Copy code'},1600)}
async function keyPair(){return crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits'])}async function exportPub(k){return crypto.subtle.exportKey('jwk',k)}async function importPub(j){return crypto.subtle.importKey('jwk',j,{name:'ECDH',namedCurve:'P-256'},false,[])}
let deriveGen=0;async function derive(local,remote){const gen=++deriveGen;const bits=await crypto.subtle.deriveBits({name:'ECDH',public:await importPub(remote)},local.privateKey,256);const hash=await crypto.subtle.digest('SHA-256',bits);const code=[...new Uint8Array(hash)].slice(0,12).map(b=>b.toString(16).padStart(2,'0')).join('').match(/.{1,4}/g).join('-');$('#fingerprint').textContent=directoryTrustedConnection?'Saved friend connection · encrypted directly':'Security code: '+code;if(gen!==deriveGen)return false;const confirmed=directoryTrustedConnection||window.confirm('Security check: compare this code with your friend over voice or another trusted channel:\n\n'+code+'\n\nOnly click OK if both codes match.');if(!confirmed||gen!==deriveGen){sharedKey=null;directFileKey=null;return false}const key=await crypto.subtle.importKey('raw',bits,{name:'AES-GCM'},false,['encrypt','decrypt']);if(gen===deriveGen){sharedKey=key;directFileKey=new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array([...new Uint8Array(bits),...enc.encode('Knot TCP file lane v1')])));announceFileCapabilities(fileSessionEpoch);return true}return false;}
async function seal(value,key=sharedKey){if(!key)throw new Error('Encryption key is unavailable');const iv=crypto.getRandomValues(new Uint8Array(12));const data=typeof value==='string'?enc.encode(value):value;const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,data);return {iv:[...iv],data:[...new Uint8Array(ct)]}}async function sealBytes(value,key=sharedKey){if(!key)throw new Error('Encryption key is unavailable');const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,value);return {iv:[...iv],data}}
async function open(o,key=sharedKey){if(!key)throw new Error('Encryption key is unavailable');return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(o.iv)},key,new Uint8Array(o.data)))}
async function openBytes(iv,data,key=sharedKey){if(!key)throw new Error('Encryption key is unavailable');return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(iv)},key,data))}
function send(o){if(chat?.readyState!=='open')return false;try{const payload=JSON.stringify(o);if(payload.length>MAX_DIRECT_CONTROL_BYTES)return false;chat.send(payload);return true}catch{return false}}
function safeExternalUrl(value){try{const u=new URL(value),host=u.hostname.toLowerCase().replace(/^\[|\]$/g,'');if(u.protocol!=='https:')return null;if(host==='localhost'||host.endsWith('.localhost')||host==='127.0.0.1'||host==='::1'||host==='0.0.0.0'||/^127\.\d+\.\d+\.\d+$/.test(host)||/^169\.254\.\d+\.\d+$/.test(host))return null;return u.href}catch{return null}}
function safePreviewUrl(value){const raw=String(value||'');if(/^emoji:\/\/(?:\/)?[0-9a-f]{2}\/[0-9a-f]{64}\.(gif|png|webp|jpg)$/.test(raw))return raw;const url=safeExternalUrl(value);return url?.startsWith('https:')?url:null}
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
function vimeoVideoId(value){try{const u=new URL(value),host=u.hostname.toLowerCase().replace(/^www\./,'');if(host!=='vimeo.com'&&host!=='player.vimeo.com')return '';const id=u.pathname.split('/').filter(Boolean).find(bit=>/^\d{6,}$/.test(bit))||'';return id}catch{return ''}}
function linkEmbedDetails(value){try{const u=new URL(value),host=u.hostname.replace(/^www\./i,''),path=decodeURIComponent((u.pathname==='/'?'':u.pathname).replace(/^\//,'')).replace(/[-_]+/g,' ').trim();return{host,title:path||host}}catch{return{host:'Link',title:value}}}
function renderLinkCard(url,{kind='link',title='',body=''}={}){const info=linkEmbedDetails(url),label=title||info.title;return '<a class="link-embed link-embed-'+kind+'" href="'+escapeHtml(url)+'" target="_blank" rel="noopener noreferrer"><span class="link-embed-site">'+escapeHtml(info.host)+'</span><strong>'+escapeHtml(label)+'</strong><span class="link-embed-url">'+escapeHtml(url)+'</span>'+(body?'<small>'+escapeHtml(body)+'</small>':'')+'</a>'}
function renderContent(text){
  const urlRegex=/(https?:\/\/[^\s<]+)/g;
  const parts=[];let last=0,m;
  while((m=urlRegex.exec(text))!==null){
    if(m.index>last)parts.push({t:'text',v:text.slice(last,m.index)});
    const url=safeExternalUrl(m[1]);
    if(!url){parts.push({t:'text',v:m[1]});last=m.index+m[0].length;continue}
    const imgExt=/\.(jpg|jpeg|png|gif|webp|bmp)(\?.*)?$/i,videoExt=/\.(mp4|webm|ogv|mov)(\?.*)?$/i,audioExt=/\.(mp3|m4a|aac|wav|ogg|opus|flac)(\?.*)?$/i;
    const youtubeId=youtubeVideoId(url);
    const vimeoId=vimeoVideoId(url);
    if(youtubeId)parts.push({t:'youtube',v:youtubeId,url});
    else if(vimeoId)parts.push({t:'vimeo',v:vimeoId,url});
    else if(imgExt.test(url)&&safePreviewUrl(url))parts.push({t:'image',v:url});
    else if(videoExt.test(url)&&safePreviewUrl(url))parts.push({t:'video',v:url});
    else if(audioExt.test(url)&&safePreviewUrl(url))parts.push({t:'audio',v:url});
    else parts.push({t:'link',v:url});
    last=m.index+m[0].length;
  }
  if(last<text.length)parts.push({t:'text',v:text.slice(last)});
  return parts.map(p=>{
    if(p.t==='text')return escapeHtml(p.v);
    if(p.t==='link')return '<a class="message-link" href="'+escapeHtml(p.v)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(p.v)+'</a>'+renderLinkCard(p.v,{body:'Open in browser'});
    if(p.t==='image')return '<a class="message-link" href="'+escapeHtml(p.v)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(p.v)+'</a><img src="'+escapeHtml(p.v)+'" loading="lazy" class="embed-img" referrerpolicy="no-referrer" />';
    if(p.t==='video')return '<a class="message-link" href="'+escapeHtml(p.v)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(p.v)+'</a><video class="embed-media" controls playsinline preload="metadata" src="'+escapeHtml(p.v)+'"></video>';
    if(p.t==='audio')return '<a class="message-link" href="'+escapeHtml(p.v)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(p.v)+'</a><audio class="embed-audio" controls preload="metadata" src="'+escapeHtml(p.v)+'"></audio>';
    if(p.t==='youtube')return renderLinkCard(p.url,{kind:'video',title:'YouTube video',body:'Watch in Knot'})+'<div class="embed-yt"><iframe src="https://www.youtube-nocookie.com/embed/'+p.v+'?rel=0" title="YouTube video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>';
    if(p.t==='vimeo')return renderLinkCard(p.url,{kind:'video',title:'Vimeo video',body:'Watch in Knot'})+'<div class="embed-yt"><iframe src="https://player.vimeo.com/video/'+p.v+'?title=0&byline=0&portrait=0" title="Vimeo video" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>';
    return '';
  }).join('');
}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
const TEXT_EMOTICONS=[
  [/:'-?\(/g,'😢'],[/(?:x|X)-?D/g,'😆'],[/(:|=)-?D/g,'😄'],[/(:|=)-?\)/g,'🙂'],[/(:|=)-?\(/g,'🙁'],[/-?;\)/g,'😉'],[/(:|=)-?[pP]/g,'😛'],[/(:|=)-?[oO]/g,'😮'],[/:\//g,'😕'],[/<3/g,'❤️']
];
function convertEmoticons(text){return String(text||'').split(/(\s+)/).map(token=>/^https?:\/\//i.test(token)?token:TEXT_EMOTICONS.reduce((value,[pattern,replacement])=>value.replace(pattern,replacement),token)).join('')}
function chatPayload(text,gif){const fallbackUrl=safeExternalUrl(gif?.fallbackUrl);return JSON.stringify({t:'message',text:String(text||''),gif:gif?.url?{url:gif.url,thumb:gif.thumb||gif.url,fallbackUrl:fallbackUrl?.startsWith('https:')?fallbackUrl:undefined,emoji:gif.emoji===true||undefined}:null})}
function readChatPayload(value){try{const p=JSON.parse(value);if(p?.t!=='message'||typeof p.text!=='string'||p.text.length>16000)return{text:String(value||''),gif:null};const url=typeof p.gif?.url==='string'&&p.gif.url.length<=4096?safePreviewUrl(p.gif.url):null;const fallbackUrl=safeExternalUrl(p.gif?.fallbackUrl);return{text:p.text,gif:url?{url,thumb:typeof p.gif.thumb==='string'?p.gif.thumb:url,fallbackUrl:fallbackUrl?.startsWith('https:')?fallbackUrl:null,emoji:p.gif.emoji===true}:null}}catch{return{text:String(value||''),gif:null}}}
function addMessage(text,mine=false,gif=null,author=null,options={}){
  const target=options.target||messages,liveTarget=target===messages,stayAtLatest=liveTarget&&(mine||(!historyRendering&&messages.scrollHeight-messages.scrollTop-messages.clientHeight<96));
  if(liveTarget)$('.empty')?.remove();
  const el=document.createElement('div');el.className='message '+(mine?'mine':'');
  const isEmoji=/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D\u20E3]+$/u.test(text.trim());
  const source=mine?profileBtn:author?null:friendAvatar,avatar=document.createElement('span'),name=mine?profileName:normalizeProfileName(author?.name,friendName);
  avatar.className='avatar message-avatar';const authorImage=!mine&&validProfileData(author?.image)?author.image:'',authorFrame=normalizeFrame(author?.frame);avatar.classList.toggle('has-image',source?source.classList.contains('has-image'):!!authorImage);avatar.style.backgroundImage=source?source.style.backgroundImage:(authorImage?'url("'+authorImage.replace(/"/g,'%22')+'")':'');avatar.style.backgroundSize=source?source.style.backgroundSize:authorFrame.zoom+'% auto';avatar.style.backgroundPositionX=source?source.style.backgroundPositionX:authorFrame.x+'%';avatar.style.backgroundPositionY=source?source.style.backgroundPositionY:authorFrame.y+'%';avatar.style.setProperty('--avatar-hue',source?source.style.getPropertyValue('--avatar-hue'):String(avatarHue(author?.id||name)));const letter=document.createElement('span');letter.className='avatar-letter';letter.textContent=name.slice(0,1).toUpperCase()||'?';avatar.append(letter);
  const content=document.createElement('div');content.className='message-content';
  const header=document.createElement('div');header.className='message-header';const sender=document.createElement('strong');sender.textContent=name;const time=document.createElement('time');const messageTime=Number(author?.time)||Date.now(),messageDate=new Date(messageTime);time.dateTime=messageDate.toISOString();time.title=messageDate.toLocaleString();time.textContent=messageDate.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});header.append(sender,time);
  const bubble=document.createElement('div');bubble.className='bubble'+(isEmoji?' emoji-only':'');bubble.innerHTML=renderContent(text);if(!text)bubble.hidden=true;
  content.append(header,bubble);
  if(gif?.url){const attachment=document.createElement('div');attachment.className='gif-attachment-message'+(gif.emoji?' gif-emoji':'');const link=document.createElement('a');link.href=gif.fallbackUrl||gif.url;link.target='_blank';link.rel='noopener noreferrer';const image=document.createElement('img');image.src=gif.url;image.alt='GIF attachment';image.loading='lazy';image.referrerPolicy='no-referrer';if(gif.fallbackUrl)image.onerror=()=>{image.onerror=null;image.src=gif.fallbackUrl;link.href=gif.fallbackUrl};link.append(image);attachment.append(link);if(!mine&&!gif.emoji){const id=gif.url;const star=document.createElement('button');star.type='button';star.className='gif-message-favorite'+(getFavs().some(f=>f.id===id)?' on':'');star.textContent=star.classList.contains('on')?'★':'☆';star.title=star.classList.contains('on')?'Remove from favorites':'Save GIF';star.onclick=()=>{const on=toggleFav(id,gif.url,gif.thumb||gif.url,{id,url:gif.url,thumb:gif.thumb||gif.url,type:'gifs'});star.classList.toggle('on',on);star.textContent=on?'★':'☆';star.title=on?'Remove from favorites':'Save GIF'};attachment.append(star)}content.append(attachment)}
  el.append(avatar,content);target.append(el);if(stayAtLatest){messages.scrollTop=messages.scrollHeight;el.querySelectorAll('img,video').forEach(media=>media.addEventListener('load',()=>{messages.scrollTop=messages.scrollHeight},{once:true}))}if(options.persist!==false)recordConversationMessage({text,mine,gif:gif?.url?{url:gif.url,thumb:gif.thumb||gif.url,fallbackUrl:gif.fallbackUrl||null,emoji:gif.emoji===true}:null,author:mine?null:{id:author?.id||'',name,image:'',frame:authorFrame},time:messageTime});return el;
}
// --- Emoji Picker ------------------------------------------------------------
const EMOJI_CATS=[
  {name:'Smileys',emojis:['😀','😃','😄','😁','😅','😂','🤣','🥲','☺️','😊','😇','🙂','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥳','🤩','😏','😞','😔','😟','😕','🙁','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👹','👺','💀','☠️','👻','👽','👾','🤖','💩','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🫠','🫢','🫣','🫡','🫥','🫤','🥹','😶‍🌫️','😮‍💨','😵‍💫']},
  {name:'Gestures',emojis:['👋','🤚','🖐','✋','🖖','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁','👅','👄','🫱','🫲','🫳','🫴','🫷','🫸']},
  {name:'People',emojis:['👶','🧒','👦','👧','🧑','👱','👨','🧔','👩','🧓','👴','👵','🙍','🙎','🙅','🙆','💁','🙋','🧏','🙇','🤦','🤷','👮','🕵','💂','🥷','👷','🫅','🤴','👸','👳','👲','🧕','🤵','👰','🤰','🫃','🫄','👼','🎅','🤶','🦸','🦹','🧙','🧚','🧛','🧜','🧝','🧞','🧟','🧌','💆','💇','🚶','🧍','🧎','🏃','💃','🕺','🕴','👯','🧖','🛀','🛌','👭','👫','👬','💏','💑','👪','🫂','🧑‍🎄','👩‍🍼','👨‍🍼','🧑‍🍼','🧑‍🦰','🧑‍🦱','🧑‍🦳','🧑‍🦲']},
  {name:'Nature',emojis:['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🦟','🦗','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐈','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿','🦔','🐾','🐉','🐲','🌵','🎄','🌲','🌳','🌴','🌱','🌿','☘️','🍀','🎍','🎋','🍃','🍂','🍁','🪺','🪹','🍄','🐚','🪸','🌾','💐','🌷','🌹','🥀','🌺','🌸','🌼','🌻','🌞','🌝','🌛','🌜','🌚','🌕','🌖','🌗','🌘','🌑','🌒','🌓','🌔','🌙','🌎','🌍','🌏','🪐','💫','⭐','🌟','✨','⚡','☄️','💥','🔥','🌪','🌈','☀️','🌤','⛅','🌥','☁️','🌦','🌧','⛈','🌩','🌨','❄️','☃️','⛄','🌬','💨','💧','💦','🫧','🌊','🪽','🐦‍⬛','🫎','🪰','🪳','🪴','🪻']},
  {name:'Food',emojis:['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🫘','🥐','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🥛','🍼','🫖','☕','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🫗','🥃','🍸','🍹','🧉','🍾','🧊','🥄','🍴','🔪','🫙','🏺','🫚']},
  {name:'Activity',emojis:['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑','🥍','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸','🥌','🎿','⛷','🏂','🪂','🏋','🤼','🤸','🤺','⛹','🤾','🏌','🏇','🧘','🏄','🏊','🤽','🚣','🧗','🚵','🚴','🎪','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🪗','🎸','🪕','🎻','🎲','♟️','🎯','🎳','🎮','🕹','🎰']},
  {name:'Travel',emojis:['🚗','🚙','🚕','🚌','🚎','🏎','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🏍','🛵','🛺','🚲','🛴','🛹','🚏','🛣','🛤','⛽','🛞','🚨','🚥','🚦','🛑','🚧','⚓','🛟','⛵','🛶','🚤','🛳','⛴','🚢','✈️','🛩','🛫','🛬','🪂','💺','🚁','🚟','🚠','🚡','🛰','🚀','🛸','🏠','🏡','🏘','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🛕','🕍','⛩','🕋','⛲','⛺','🌁','🌃','🏙','🌄','🌅','🌆','🌇','🌉','🗾','🏔','⛰','🌋','🗻','🏕','🏖','🏜','🏝','🏟']},
  {name:'Objects',emojis:['⌚','📱','💻','⌨','🖥','🖨','🖱','🖲','🕹','🗜','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽','🎞','📞','☎️','📟','📠','📺','📻','🎙','🎚','🎛','🧭','⏱','⏲','⏰','🕰','⌛','⏳','📡','🔋','🪫','🔌','💡','🔦','🕯','🪔','🧯','🗑','🛢','🪠','💸','💵','💴','💶','💷','🪙','💰','💳','💎','⚖️','🧰','🪛','🔧','🔨','⚒','🛠','⛏','🪚','🔩','⚙','🪤','🧱','⛓','🧲','🔫','💣','🧨','🪓','🔪','🗡','⚔️','🛡','🚬','⚰','🪦','⚱','🏺','🔮','📿','🧿','🪬','💈','⚗','🔭','🔬','🕳','🩻','🩼','🩺','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡','🧹','🪥','🧺','🧻','🚽','🚰','🚿','🛁','🛀','🧼','🪒','🪮','🧽','🪣','🧴','🛎','🔑','🗝','🚪','🪑','🛋','🛏','🛌','🧸','🪆','🖼','🪞','🪟','🛍','🛒','🎁','🎈','🎏','🎀','🪄','🪅','🎊','🎉','🎎','🏮','🎐','🧧','✉️','📩','📨','📧','💌','📥','📤','📦','🏷','🪧','📪','📫','📬','📭','📮','📯','📜','📃','📄','📑','🧾','📊','📈','📉','🗒','🗓','📆','📅','📇','🗃','🗳','🗄','📋','📁','📂','🗂','🗞','📰','📓','📔','📒','📕','📗','📘','📙','📚','📖','🔖','🧷','🔗','📎','🖇','📐','📏','🧮','📌','📍','✂️','🖊','🖋','✒️','🖌','🖍','📝','✏️','🔍','🔎','🔏','🔐','🔒','🔓','🪩','🪭']},
  {name:'Symbols',emojis:['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','🈯','💹','❇️','✳️','❎','🌐','💠','Ⓜ️','🌀','💤','🏧','🚾','♿','🅿️','🈳','🈂️','🛂','🛃','🛄','🛅','🛜','🚹','🚺','🚼','⚧','🚻','🚮','🎦','📶','🈁','🔣','🔤','🆡','🆢','🆣','🆤','🆥','🆦','🆧','🆨','🆩','🆪','🆫','🆬','🀄','🃏','🎴','🆒','🆓','🆕','🆖','🆗','🆙','♾️','➕','➖','➗','🟰','🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫','⚪','▶️','◀️','⏸️','⏹️','⏺️','⏭️','⏮️','⏩','⏪','⏫','⏬']},
  {name:'Flags',emojis:['🏳️','🏴','🏁','🚩','🎌','🏴‍☠️','🇺🇳','🇦🇫','🇦🇱','🇩🇿','🇦🇸','🇦🇩','🇦🇴','🇦🇮','🇦🇶','🇦🇬','🇦🇷','🇦🇲','🇦🇼','🇦🇺','🇦🇹','🇦🇿','🇧🇸','🇧🇭','🇧🇩','🇧🇧','🇧🇾','🇧🇪','🇧🇿','🇧🇯','🇧🇲','🇧🇹','🇧🇴','🇧🇦','🇧🇼','🇧🇷','🇧🇳','🇧🇬','🇧🇫','🇧🇮','🇨🇻','🇰🇭','🇨🇲','🇨🇦','🇨🇫','🇹🇩','🇨🇱','🇨🇳','🇨🇴','🇰🇲','🇨🇩','🇨🇬','🇨🇷','🇨🇮','🇭🇷','🇨🇺','🇨🇾','🇨🇿','🇩🇰','🇩🇯','🇩🇲','🇩🇴','🇪🇨','🇪🇬','🇸🇻','🇬🇶','🇪🇷','🇪🇪','🇸🇿','🇪🇹','🇫🇯','🇫🇮','🇫🇷','🇬🇦','🇬🇲','🇬🇪','🇩🇪','🇬🇭','🇬🇷','🇬🇩','🇬🇹','🇬🇳','🇬🇼','🇬🇾','🇭🇹','🇭🇳','🇭🇺','🇮🇸','🇮🇳','🇮🇩','🇮🇷','🇮🇶','🇮🇪','🇮🇱','🇮🇹','🇯🇲','🇯🇵','🇯🇴','🇰🇿','🇰🇪','🇰🇮','🇰🇼','🇰🇬','🇱🇦','🇱🇻','🇱🇧','🇱🇸','🇱🇷','🇱🇾','🇱🇮','🇱🇹','🇱🇺','🇲🇬','🇲🇼','🇲🇾','🇲🇻','🇲🇱','🇲🇹','🇲🇭','🇲🇷','🇲🇺','🇲🇽','🇫🇲','🇲🇩','🇲🇨','🇲🇳','🇲🇪','🇲🇦','🇲🇿','🇲🇲','🇳🇦','🇳🇷','🇳🇵','🇳🇱','🇳🇿','🇳🇮','🇳🇪','🇳🇬','🇰🇵','🇲🇰','🇳🇴','🇴🇲','🇵🇰','🇵🇼','🇵🇸','🇵🇦','🇵🇬','🇵🇾','🇵🇪','🇵🇭','🇵🇱','🇵🇹','🇶🇦','🇷🇴','🇷🇺','🇷🇼','🇰🇳','🇱🇨','🇻🇨','🇼🇸','🇸🇲','🇸🇹','🇸🇦','🇸🇳','🇷🇸','🇸🇨','🇸🇱','🇸🇬','🇸🇰','🇸🇮','🇸🇧','🇸🇴','🇿🇦','🇰🇷','🇸🇸','🇪🇸','🇱🇰','🇸🇩','🇸🇷','🇸🇪','🇨🇭','🇸🇾','🇹🇼','🇹🇯','🇹🇿','🇹🇭','🇹🇱','🇹🇬','🇹🇴','🇹🇹','🇹🇳','🇹🇷','🇹🇲','🇹🇻','🇺🇬','🇺🇦','🇦🇪','🇬🇧','🇺🇸','🇺🇾','🇺🇿','🇻🇺','🇻🇦','🇻🇪','🇻🇳','🇾🇪','🇿🇲','🇿🇼']}
];
let emojiPicker=null,emojiBtn=null,gifPicker=null,gifBtn=null,pendingGif=null,gifAttachment=null;
function saveConversationDraft(key=activeConversationKey){if(!key)return;const text=messageInput.value,pending=pendingGif?{...pendingGif}:null;if(text||pending)conversationDrafts.set(key,{text,pending});else conversationDrafts.delete(key)}
function restoreConversationDraft(key){const draft=conversationDrafts.get(key);messageInput.value=draft?.text||'';setPendingGif(draft?.pending||null)}
function setPendingGif(item){pendingGif=item?.url?{url:item.url,thumb:item.thumb||item.url,fallbackUrl:item.fallbackUrl||null,analytics:item.analytics||null,emoji:item.emoji===true,name:String(item.name||'').trim().slice(0,120)}:null;if(pendingGif){gifPicker?.classList.add('hidden');emojiPicker?.classList.add('hidden')}if(!gifAttachment){saveConversationDraft();return}gifAttachment.hidden=!pendingGif;gifAttachment.classList.toggle('emoji-attachment',!!pendingGif?.emoji);if(pendingGif){const image=gifAttachment.querySelector('img'),remove=gifAttachment.querySelector('.gif-attachment-remove');image.src=pendingGif.thumb;image.alt=pendingGif.emoji?(pendingGif.name||'Emoji')+' attachment':'GIF attachment';gifAttachment.querySelector('.gif-attachment-name').textContent=pendingGif.emoji?(pendingGif.name?'Emoji attached · '+pendingGif.name:'Emoji attached'):'1 GIF attached';remove.setAttribute('aria-label',pendingGif.emoji?'Remove emoji attachment':'Remove GIF attachment')}saveConversationDraft();if(!messageInput.disabled)messageInput.focus()}
function buildEmojiPicker(){
  const wrap=document.createElement('div');wrap.className='emoji-picker';wrap.classList.add('hidden');
  const searchRow=document.createElement('div');searchRow.className='emoji-picker-search-row';
  const searchInput=document.createElement('input');searchInput.type='search';searchInput.className='emoji-picker-search';searchInput.placeholder='Search emojis…';searchInput.setAttribute('aria-label','Search emojis');
  searchRow.append(searchInput);
  const tabs=document.createElement('div');tabs.className='emoji-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Emoji sections');
  const pagesWrap=document.createElement('div');pagesWrap.className='emoji-pages';
  const body=document.createElement('div');body.className='emoji-body';
  body.append(tabs,pagesWrap);
  const pageRegistry=[];
  let activePage=null,prefsLoaded=false,catalogAvailable=false;

  function registerPage(tabLabel,tabTitle,pageBuilder,{onShow=null}={}){
    const index=pageRegistry.length,tabId='emoji-tab-'+index,pageId='emoji-page-'+index;
    const tab=document.createElement('button');tab.type='button';tab.className='emoji-tab';tab.id=tabId;tab.textContent=tabLabel;tab.title=tabTitle;tab.setAttribute('aria-label',tabTitle);tab.setAttribute('role','tab');tab.setAttribute('aria-controls',pageId);tab.setAttribute('aria-selected','false');tab.tabIndex=-1;
    const page=document.createElement('div');page.className='emoji-page hidden';page.id=pageId;page.setAttribute('role','tabpanel');page.setAttribute('aria-labelledby',tabId);
    tabs.append(tab);pagesWrap.append(page);
    const entry={tab,page,onShow};
    tab.onclick=()=>activatePage(entry);
    pageRegistry.push(entry);
    if(pageBuilder)pageBuilder(page,entry);
    return entry;
  }
  function activatePage(entry){
    pageRegistry.forEach(p=>p.page.classList.add('hidden'));
    pageRegistry.forEach(p=>{if(p.tab){p.tab.classList.remove('active');p.tab.setAttribute('aria-selected','false');p.tab.tabIndex=-1}});
    entry.page.classList.remove('hidden');if(entry.tab){entry.tab.classList.add('active');entry.tab.setAttribute('aria-selected','true');entry.tab.tabIndex=0}activePage=entry;
    if(entry.onShow)entry.onShow();
  }
  tabs.addEventListener('keydown',event=>{
    if(!event.target.classList.contains('emoji-tab'))return;
    const available=pageRegistry.filter(entry=>entry.tab),current=available.findIndex(entry=>entry.tab===event.target);let next=current;
    if(event.key==='ArrowDown'||event.key==='ArrowRight')next=(current+1)%available.length;
    else if(event.key==='ArrowUp'||event.key==='ArrowLeft')next=(current-1+available.length)%available.length;
    else if(event.key==='Home')next=0;
    else if(event.key==='End')next=available.length-1;
    else return;
    event.preventDefault();activatePage(available[next]);available[next].tab.focus();
  });

  // --- Recent -----------------------------------------------------------------
  const recentGrid=document.createElement('div');recentGrid.className='emoji-grid';
  registerPage('🕘','Recent',page=>{
    const heading=document.createElement('div');heading.className='emoji-category-title';heading.textContent='Recently used';
    page.append(heading,recentGrid);
  });

  // --- Unicode categories ---------------------------------------------------------
  EMOJI_CATS.forEach((cat,i)=>{
    registerPage(cat.emojis[0],cat.name,page=>{
      const heading=document.createElement('div');heading.className='emoji-category-title';heading.textContent=cat.name;
      const grid=document.createElement('div');grid.className='emoji-grid';
      cat.emojis.forEach(e=>{
        const btn=document.createElement('button');btn.type='button';btn.className='emoji-item';btn.textContent=e;
        btn.onclick=()=>{const inp=messageInput;const s=inp.selectionStart;const v=inp.value;inp.value=v.slice(0,s)+e+v.slice(inp.selectionEnd);inp.selectionStart=inp.selectionEnd=s+e.length;inp.focus();recordEmojiUse({t:'u',c:e});wrap.classList.add('hidden')};
        grid.append(btn);
      });
      page.append(heading,grid);
    });
  });

  // --- Animated sticker loops -------------------------------------------------------
  registerPage('🎞','Animated',(animPage,animatedEntry)=>{
    const animSearch=document.createElement('input');animSearch.className='animated-search';animSearch.placeholder='Search animated…';animSearch.autocomplete='off';animSearch.setAttribute('aria-label','Search animated emoji');
    const animGrid=document.createElement('div');animGrid.className='animated-emoji-grid';animGrid.innerHTML='<span class="gif-hint">Loading…</span>';
    let animQuery='',animOffset=0,animTimer=null;
    const loadAnim=append=>{
      const token=animQuery+'|'+(append?animOffset:0);
      animGrid._loading=token;if(!append)animGrid.innerHTML='<span class="gif-hint">Loading…</span>';
      Promise.all([
        giphyFetch('search','stickers',animQuery,append?animOffset:0).then(d=>(d.data||[]).map(g=>{const im=g.images?.fixed_width_small||g.images?.fixed_width||g.images?.downsized||{};const thumb=im.url||g.images?.original?.url;return{id:g.id,thumb,url:g.images?.original?.url||thumb,klipy:false,giphyType:'stickers'}})).catch(()=>[]),
        klipyFetch('stickers',animQuery,append?animOffset:0).then(d=>(d.results||[]).map(k=>{const fm=k.media_formats||{};return{id:k.id,thumb:fm.tinygif?.url||fm.gif?.url,url:fm.gif?.url||fm.tinygif?.url,klipy:true}})).catch(()=>[])
      ]).then(([a,b])=>{
        if(animGrid._loading!==token)return;
        if(!append)animGrid.innerHTML='';
        const items=[];for(let i=0;i<Math.max(a.length,b.length);i++){if(a[i])items.push(a[i]);if(b[i])items.push(b[i])}
        if(!items.length&&!append){animGrid.innerHTML='<span class="gif-hint">No results</span>';return}
        for(const item of items){
          if(!item.thumb||!item.url)continue;
          const btn=document.createElement('button');btn.type='button';btn.className='animated-emoji-item';btn.title='Send animated emoji';
          const img=document.createElement('img');img.src=item.thumb;img.loading='lazy';img.alt='';
          btn.append(img);
          btn.onclick=()=>{
            setPendingGif({url:item.url,thumb:item.thumb,analytics:item,emoji:true});
            wrap.classList.add('hidden');
            animSearch.value='';animQuery='';animOffset=0;loadAnim(false);
            messageForm.requestSubmit();
          };
          animGrid.append(btn);
        }
      });
    };
    animSearch.oninput=()=>{clearTimeout(animTimer);const q=animSearch.value.trim();animTimer=setTimeout(()=>{animQuery=q;animOffset=0;if(q&&q.length<2){animGrid.innerHTML='<span class="gif-hint">Type at least 2 characters to search</span>';return}loadAnim(false)},250)};
    animSearch.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation()}};
    animGrid.onscroll=()=>{if(animGrid._loading)return;if(animGrid.scrollTop+animGrid.clientHeight>=animGrid.scrollHeight-60){animOffset+=24;loadAnim(true)}};
    animPage.append(animSearch,animGrid);
    animatedEntry.onShow=()=>{if(!animGrid.querySelector('.animated-emoji-item')&&!animGrid._loading)loadAnim(false)};
  });

  // --- Emoji.gg API (Discover) ---------------------------------------------------
  const catChipRow=document.createElement('div');catChipRow.className='catalog-chip-row';
  const catChips={all:['All',true],animated:['Animated'],static:['Static']};
  let catType='all';
  for(const [value,[label,selected]] of Object.entries(catChips)){
    const chip=document.createElement('button');chip.type='button';chip.className='catalog-chip'+(selected?' selected':'');chip.textContent=label;
    chip.onclick=()=>{catType=value;catChipRow.querySelectorAll('.catalog-chip').forEach(c=>c.classList.remove('selected'));chip.classList.add('selected');runCatalogQuery()};
    catChipRow.append(chip);
  }
  const catalogStatus=document.createElement('span');catalogStatus.className='catalog-status';
  catChipRow.append(catalogStatus);
  const catalogGrid=document.createElement('div');catalogGrid.className='catalog-grid';
  const catalogSentinel=document.createElement('div');catalogSentinel.className='catalog-sentinel';
  catalogGrid.append(catalogSentinel);
  const catalogEntry=registerPage('🗂','Discover — Emoji.gg API',page=>{
    page.append(catChipRow,catalogGrid);
  });
  catalogEntry.onShow=async()=>{
    if(!catalogAvailable){catalogStatus.textContent='Connecting to Emoji.gg…';catalogAvailable=await window.pairEmojiCatalog?.available?.().catch(()=>false)}
    if(!catalogAvailable){catalogStatus.textContent='Offline — Unicode emojis still work';return}
    if(!catalogGrid.querySelector('.catalog-tile'))runCatalogQuery();
  };

  let catalogCursor=null,catalogBusy=false,catalogToken=0,catalogQuery='';
  function catalogTile(item){
    const btn=document.createElement('button');btn.type='button';btn.className='catalog-tile';btn.dataset.id=String(item.id);
    btn.title='Add '+item.name+' to message';btn.setAttribute('aria-label','Add '+item.name+' to message');
    const img=document.createElement('img');img.src=item.url;img.loading='lazy';img.alt=item.name;img.decoding='async';if(item.fallbackUrl)img.onerror=()=>{img.onerror=null;img.src=item.fallbackUrl};
    btn.append(img);
    bindCatalogTile(btn,item);
    return btn;
  }
  function bindCatalogTile(btn,item){
    btn.onclick=()=>{
      setPendingGif({url:item.url,thumb:item.url,fallbackUrl:item.fallbackUrl,analytics:null,emoji:true,name:item.name});
      wrap.classList.add('hidden');
      recordEmojiUse({t:'cat',id:String(item.id),name:item.name,url:item.url,fallbackUrl:item.fallbackUrl||null,animated:item.animated});
    };
  }
  async function runCatalogQuery(){
    if(!window.pairEmojiCatalog)return;
    const token=++catalogToken;
    catalogCursor=null;catalogBusy=true;
    catalogGrid.querySelectorAll('.catalog-tile').forEach(el=>el.remove());
    catalogStatus.textContent='';
    await appendCatalogBatch(token,true);
    if(token===catalogToken)catalogBusy=false;
  }
  async function appendCatalogBatch(token,reset){
    const cursor=reset?0:(catalogCursor??0);
    const res=await window.pairEmojiCatalog.search({q:catalogQuery,type:catType,cursor,limit:60}).catch(()=>null);
    if(token!==catalogToken)return false;
    if(res){
      catalogCursor=res.nextCursor;
      if(res.items.length){
        const frag=document.createDocumentFragment();
        for(const item of res.items)frag.append(catalogTile(item));
        catalogGrid.insertBefore(frag,catalogSentinel);
      } else if(reset){
        catalogStatus.textContent=catalogQuery?'No results':'Emoji.gg is unavailable — Unicode emojis still work offline';
      }
    }
    return true;
  }
  const catalogSentinelObserver=new IntersectionObserver(entries=>{
    if(!entries.some(e=>e.isIntersecting)||catalogBusy||catalogCursor===null||catalogEntry.page.classList.contains('hidden'))return;
    catalogBusy=true;const token=catalogToken;
    appendCatalogBatch(token,false).finally(()=>{if(token===catalogToken)catalogBusy=false});
  },{root:catalogEntry.page,rootMargin:'300px'});
  catalogSentinelObserver.observe(catalogSentinel);

  // --- Recent -----------------------------------------------------------------------
  function renderRecentPage(){
    recentGrid.replaceChildren();
    if(!emojiRecents.length){const p=document.createElement('p');p.className='social-empty';p.textContent='Emojis you use appear here.';recentGrid.append(p);return}
    for(const entry of emojiRecents){
      if(entry.t==='u'){
        const btn=document.createElement('button');btn.type='button';btn.className='emoji-item';btn.textContent=entry.c;
        btn.onclick=()=>{const inp=messageInput;const s=inp.selectionStart;inp.value=inp.value.slice(0,s)+entry.c+inp.value.slice(inp.selectionEnd);inp.selectionStart=inp.selectionEnd=s+entry.c.length;inp.focus();recordEmojiUse(entry);wrap.classList.add('hidden')};
        recentGrid.append(btn);
      } else {
        const btn=document.createElement('button');btn.type='button';btn.className='catalog-tile';btn.title=entry.name||'';
        const img=document.createElement('img');img.src=entry.url;img.loading='lazy';img.alt=entry.name||'';img.decoding='async';
        btn.append(img);bindCatalogTile(btn,entry);recentGrid.append(btn);
      }
    }
  }
  // --- Search ---------------------------------------------------------------------------
  let searchDebounce=null,lastBrowsePage=null;
  const searchResultsPage=document.createElement('div');searchResultsPage.className='emoji-page hidden';searchResultsPage.setAttribute('role','region');searchResultsPage.setAttribute('aria-label','Emoji search results');
  const searchResultsGrid=document.createElement('div');searchResultsGrid.className='catalog-grid';
  const searchStatusLabel=document.createElement('span');searchStatusLabel.className='catalog-status';
  searchResultsPage.append(searchStatusLabel,searchResultsGrid);
  const searchEntry={tab:null,page:searchResultsPage,onShow:null};pageRegistry.push(searchEntry);pagesWrap.append(searchResultsPage);

  searchInput.addEventListener('input',()=>{
    clearTimeout(searchDebounce);
    const q=searchInput.value.trim();
    if(q.length<2){
      if(lastBrowsePage)activatePage(lastBrowsePage);
      lastBrowsePage=null;return;
    }
    if(!lastBrowsePage)lastBrowsePage=activePage||pageRegistry[1];
    searchDebounce=setTimeout(async()=>{
      const token=++catalogToken;
      pageRegistry.forEach(p=>p.page.classList.add('hidden'));
      pageRegistry.forEach(p=>{if(p.tab){p.tab.classList.remove('active');p.tab.setAttribute('aria-selected','false')}});
      searchResultsPage.classList.remove('hidden');activePage=searchEntry;
      searchStatusLabel.textContent='Searching…';
      const res=await window.pairEmojiCatalog.search({q,type:catType,cursor:0,limit:120}).catch(()=>null);
      if(token!==catalogToken)return;
      searchResultsGrid.querySelectorAll('.catalog-tile').forEach(el=>el.remove());
      searchStatusLabel.textContent=res?(res.items.length?'':'No results — try another word'):'Search failed';
      if(res)for(const item of res.items)searchResultsGrid.append(catalogTile(item));
    },150);
  });
  searchInput.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation()}if(e.key==='Escape'){searchInput.value='';if(lastBrowsePage)activatePage(lastBrowsePage)}};

  const mainRow=document.createElement('div');mainRow.className='emoji-main';mainRow.append(tabs,pagesWrap);
  wrap.append(searchRow,mainRow);
  document.addEventListener('click',e=>{if(!wrap.contains(e.target)&&e.target!==emojiBtn)wrap.classList.add('hidden')});

  // Async prep: preferences + catalog availability decide Recent/Discover.
  (async()=>{
    await loadEmojiPrefs();
    renderRecentPage();
    catalogAvailable=await window.pairEmojiCatalog?.available?.().catch(()=>false);
    activatePage(pageRegistry[1]); // default: first unicode category
  })();
  return wrap;
}function buildGifPicker(){
  const wrap=document.createElement('div');wrap.className='gif-picker';wrap.classList.add('hidden');
  const tabs=document.createElement('div');tabs.className='gif-picker-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','GIF picker sections');
  const gifTab=document.createElement('button');gifTab.type='button';gifTab.className='gif-picker-tab active';gifTab.textContent='GIFs';
  const stiTab=document.createElement('button');stiTab.type='button';stiTab.className='gif-picker-tab';stiTab.textContent='Stickers';
  const favTab=document.createElement('button');favTab.type='button';favTab.className='gif-picker-tab';favTab.textContent='Favs';
  tabs.append(gifTab,stiTab,favTab);
  const searchRow=document.createElement('div');searchRow.className='gif-search-row';
  const inp=document.createElement('input');inp.type='search';inp.className='gif-search-input';inp.placeholder='Search…';inp.setAttribute('aria-label','Search GIFs');
  const results=document.createElement('div');results.className='gif-results';results.id='gif-picker-results';results.setAttribute('role','tabpanel');
  const pickerTabs=[[gifTab,'gifs'],[stiTab,'stickers'],[favTab,'favs']];pickerTabs.forEach(([tab],index)=>{tab.id='gif-picker-tab-'+index;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',results.id);tab.setAttribute('aria-selected',String(index===0));tab.tabIndex=index===0?0:-1});results.setAttribute('aria-labelledby',gifTab.id);
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
    pickerTabs.forEach(([tab,type])=>{const active=t===type;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;if(active)results.setAttribute('aria-labelledby',tab.id)});
    inp.hidden=isFav;searchRow.hidden=isFav;
    if(isFav)renderFavs(results);
    else{inp.placeholder=t==='gifs'?'Search GIFs…':'Search Stickers…';inp.setAttribute('aria-label',inp.placeholder);loadFresh('',t)}
  }
  gifTab.onclick=()=>setType('gifs');
  stiTab.onclick=()=>setType('stickers');
  favTab.onclick=()=>setType('favs');
  tabs.onkeydown=event=>{const index=pickerTabs.findIndex(([tab])=>tab===event.target);if(index<0)return;let next=index;if(event.key==='ArrowRight'||event.key==='ArrowDown')next=(index+1)%pickerTabs.length;else if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=(index-1+pickerTabs.length)%pickerTabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=pickerTabs.length-1;else return;event.preventDefault();const [tab,type]=pickerTabs[next];setType(type);tab.focus()};
  inp.oninput=()=>{
    clearTimeout(timer);const q=inp.value.trim();
    timer=setTimeout(()=>{loadFresh(q,currentType)},250);
  };
  inp.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation()}};
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
// Recent emoji choices persist locally beside the existing settings
// conventions (message history lives in the same store).
let emojiRecents=null;
async function loadEmojiPrefs(){
  if(!Array.isArray(emojiRecents)){try{emojiRecents=JSON.parse(await ss('emojiRecents')||'[]')}catch{}if(!Array.isArray(emojiRecents))emojiRecents=[]}
}
function recordEmojiUse(entry){
  if(!Array.isArray(emojiRecents))return;
  const key=entry.t==='u'?'u:'+entry.c:'cat:'+entry.id;
  const existing=emojiRecents.findIndex(e=>(e.t==='u'?'u:'+e.c:'cat:'+e.id)===key);
  if(existing>-1)emojiRecents.splice(existing,1);
  emojiRecents.unshift({...entry,at:Date.now()});
  if(emojiRecents.length>48)emojiRecents.length=48;
  ssSet('emojiRecents',JSON.stringify(emojiRecents));
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
    const card=document.createElement('div');card.className='gif-result';
    const btn=document.createElement('button');btn.type='button';btn.className='gif-result-select';btn.setAttribute('aria-label','Attach favorite GIF');
    const img=document.createElement('img');img.src=f.thumb;img.loading='lazy';img.alt='';
    btn.append(img);btn.onclick=()=>{if(f.url){setPendingGif({url:f.url,thumb:f.thumb,analytics:f.type||f});resultsEl.parentElement.classList.add('hidden')}};
    const star=document.createElement('button');star.type='button';star.className='gif-star on';star.textContent='★';star.title='Remove from favorites';star.setAttribute('aria-label','Remove from GIF favorites');star.onclick=e=>{e.preventDefault();e.stopPropagation();toggleFav(f.id);renderFavs(resultsEl)};card.append(btn,star);
    card.oncontextmenu=e=>{e.preventDefault();toggleFav(f.id);renderFavs(resultsEl)};
    resultsEl.append(card);
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
  const card=document.createElement('div');card.className='gif-result';
  const btn=document.createElement('button');btn.type='button';btn.className='gif-result-select';btn.setAttribute('aria-label','Attach '+(item.giphyType==='stickers'?'sticker':'GIF'));
  const img=document.createElement('img');img.src=item.thumb;img.loading='lazy';img.alt='';
    // Remove inline aspectRatio — CSS `width:100%;height:auto` preserves natural ratio
    // if(item.thumbW&&item.thumbH){img.style.aspectRatio=item.thumbW+'/'+item.thumbH}
  btn.append(img);
  const isFav=getFavs().some(f=>f.id===item.id);
  const star=document.createElement('button');star.type='button';star.className='gif-star'+(isFav?' on':'');star.textContent=isFav?'★':'☆';star.title=isFav?'Remove favorite':'Add to favorites';star.setAttribute('aria-label',star.title);
  const toggleStar=e=>{e.preventDefault();e.stopPropagation();const on=toggleFav(item.id,item.fullUrl,item.thumb,item);star.classList.toggle('on',on);star.textContent=on?'★':'☆';star.title=on?'Remove favorite':'Add to favorites';star.setAttribute('aria-label',star.title)};star.onclick=toggleStar;
  btn.onclick=()=>{if(item.fullUrl){setPendingGif({url:item.fullUrl,thumb:item.thumb,analytics:item});const wrap=resultsEl.parentElement;wrap.classList.add('hidden');const si=wrap.querySelector('.gif-search-input');if(si)si.value='';resultsEl.innerHTML=''}};
  card.append(btn,star);resultsEl.append(card);
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
  const plusBtn=document.createElement('button');plusBtn.type='button';plusBtn.className='composer-btn plus-btn';plusBtn.textContent='+';plusBtn.title='Attach a file';plusBtn.setAttribute('aria-label','Attach a file');
  const plusPopup=document.createElement('div');plusPopup.className='plus-popup';plusPopup.classList.add('hidden');
  const fileOpt=document.createElement('button');fileOpt.type='button';fileOpt.className='plus-opt';fileOpt.textContent='📎 Send file';
  // Upload stays visually in the composer, but its availability belongs only
  // to the file transport. A media retry must never disable text, emojis, or
  // the attachment affordance as a side effect.
  const syncFileAttachment=()=>{const available=!fileInput.disabled,reason=fileInput.dataset.unavailableReason||'File transfer is unavailable until your friend is online';fileOpt.disabled=!available;fileOpt.title=available?'':reason;plusBtn.classList.toggle('file-unavailable',!available)};
  syncFileAttachmentUi=syncFileAttachment;
  fileOpt.onclick=()=>{if(fileInput.disabled)return;plusPopup.classList.add('hidden');fileInput.click()};
  plusPopup.append(fileOpt);plusWrap.append(plusBtn,plusPopup);composer.insertBefore(plusWrap,sendBtn.nextSibling);
  plusBtn.onclick=e=>{e.preventDefault();plusPopup.classList.toggle('hidden');emojiPicker&&emojiPicker.classList.add('hidden');gifPicker&&gifPicker.classList.add('hidden')};
  document.addEventListener('click',e=>{if(!plusWrap.contains(e.target))plusPopup.classList.add('hidden')});
  emojiBtn=document.createElement('button');emojiBtn.type='button';emojiBtn.className='composer-btn emoji-btn';emojiBtn.textContent='😊';emojiBtn.title='Insert emoji';emojiBtn.setAttribute('aria-label','Insert emoji');
  emojiPicker=buildEmojiPicker();emojiPicker.style.position='absolute';emojiPicker.style.bottom='100%';emojiPicker.style.right='0';
  composer.append(emojiPicker);
  emojiBtn.onclick=e=>{e.preventDefault();emojiPicker.classList.toggle('hidden');gifPicker&&gifPicker.classList.add('hidden');plusPopup&&plusPopup.classList.add('hidden')};
  composer.insertBefore(emojiBtn,sendBtn.nextSibling);
  // GIF button
  gifBtn=document.createElement('button');gifBtn.type='button';gifBtn.className='composer-btn gif-btn';gifBtn.textContent='GIF';gifBtn.title='Insert GIF';gifBtn.setAttribute('aria-label','Insert GIF');
  gifPicker=buildGifPicker();gifPicker.style.position='absolute';gifPicker.style.bottom='100%';gifPicker.style.right='0';
  composer.append(gifPicker);
  gifBtn.onclick=e=>{e.preventDefault();const show=gifPicker.classList.contains('hidden');gifPicker.classList.toggle('hidden');emojiPicker&&emojiPicker.classList.add('hidden');plusPopup&&plusPopup.classList.add('hidden');if(show){const r=gifPicker.querySelector('.gif-results');const tabs=gifPicker.querySelectorAll('.gif-picker-tab');if(tabs[2]?.classList.contains('active'))renderFavs(r);else{tabs[0]?.click()}}};
  composer.insertBefore(gifBtn,sendBtn.nextSibling);
  // Enable input/button on connect
  const initiallyDisabled=messageInput.disabled;
  syncComposerAvailability=disabled=>{const value=!!disabled;messageInput.disabled=value;sendBtn.disabled=value;emojiBtn.disabled=value;gifBtn.disabled=value};
  syncComposerAvailability(initiallyDisabled);syncFileAttachment();
  messageInput.addEventListener('input',()=>saveConversationDraft());
})();
function isEncryptedMessage(value){return !!value&&Array.isArray(value.iv)&&value.iv.length===12&&Array.isArray(value.data)&&value.data.length>0&&value.data.length<=MAX_MESSAGE_SIZE+32&&value.iv.every(Number.isInteger)&&value.data.every(Number.isInteger)}
function clearRemoteScreenShare(status='Not sharing'){
  const wasFocused=typeof focusedScreen!=='undefined'&&focusedScreen==='remote';
  if(networkReceiveCongested||Number.isFinite(networkLiveReceiveMbps)){networkReceiveCongested=false;networkLiveReceiveMbps=NaN;announceNetBudget()}
  remoteScreenDecodeStop?.();remoteScreenDecodeStop=null;
  setRemoteScreenWatching(false);
  cleanupRemoteNativeScreen();
  remoteScreenExpected=false;remoteNativeScreenExpected=false;remoteScreenSuppressed=false;
  // Never disable a receive track. Screen senders use replaceTrack on the same
  // negotiated transceiver, and a disabled receiver can stay silent after the
  // remote peer starts a new share. Playback is suppressed at the media element.
  try{remoteScreen.srcObject?.getTracks?.().forEach(track=>{track.enabled=true})}catch{}
  remoteScreen.srcObject=null;remoteScreen.hidden=true;screenStatus.textContent=status;
  try{if(wasFocused)exitShareFullscreen({collapse:true});else updateScreenLayout()}catch{}
}
function stopWatchingRemoteShare(){
  if(remoteScreen.hidden&&!remoteScreen.srcObject)return;
  setRemoteScreenWatching(false);
  remoteScreenSuppressed=true;
  try{remoteScreen.pause();remoteScreen.muted=true;if(nativeRemoteAudio){nativeRemoteAudio.pause();nativeRemoteAudio.muted=true;nativeRemoteAudio.srcObject?.getTracks?.().forEach(track=>{track.enabled=true})}}catch{}
  screenStatus.textContent='Not watching · click the stream badge to resume';
  try{if(focusedScreen==='remote')exitShareFullscreen({collapse:true});else updateScreenLayout()}catch{}
}
function receiveDirectMessage(message,peerIdOverride=''){
  const peerId=peerIdOverride||dmPeerId||dmCallPeerId||activePeerId,key=peerId?'dm:'+peerId:'';
  if(peerId)markDmUnread(peerId,message);
  const friend=directoryUser(peerId),entry={text:message.text,mine:false,gif:message.gif?.url?{url:message.gif.url,thumb:message.gif.thumb||message.gif.url,fallbackUrl:message.gif.fallbackUrl||null,emoji:message.gif.emoji===true}:null,author:{id:peerId,name:friend?.name||'Friend',image:'',frame:normalizeFrame(friend?.frame)},time:Date.now()};
  if(!key||activeConversationKey===key){addMessage(message.text,false,message.gif,{id:peerId,name:friend?.name||'Friend',image:friend?.image||'',frame:normalizeFrame(friend?.frame)});return}
  storeConversationEntry(key,entry);
}
function setupChannels(){chat=pc.createDataChannel('chat');if(!relayVoiceMode)files=pc.createDataChannel('files');wire()}
function wire(){
  if(chat){
    chat.onopen=()=>{setStatus(relayVoiceMode?'Voice relay active · files and screen share stay P2P':(pc?._lan?'Connected on this Wi-Fi':'Connected directly'),true);announceProfile();publishCallState(callActive);requestWatchState();announceNetBudget();startNetBudgetPulse()};
    chat.onmessage=async event=>{
      try{
        if(typeof event.data!=='string'||event.data.length>MAX_DIRECT_CONTROL_BYTES)return;
        const value=JSON.parse(event.data);
        if(value.t==='msg'&&isEncryptedMessage(value.v)){receiveDirectMessage(readChatPayload(dec.decode(await open(value.v))));return}
        if(value.t==='profile'){
          const profile=typeof value.v==='string'?{image:value.v}:value.v;
          if(validProfileIdentity(profile?.identity))setAvatarIdentity(friendAvatar,profile.identity);
          if(typeof profile?.image==='string'&&profile.image.length<=MAX_PROFILE_DATA){setAvatar(friendAvatar,profile.image);setAvatarFrame(friendAvatar,profile.frame)}
          return;
        }
        if(value.t==='call-state'){
          const active=value.active===true,session=String(value.session||'legacy');if(active)dmCallPeerId=dmPeerId||activePeerId;
          applyRemoteCallState(active,session);logCallEvent(active?'Friend joined the call':'Friend left the call');
          // Peers repeat their active state as a heartbeat. The centralized
          // presence transition only rings or animates on a genuine join.
          return;
        }
        if(value.t==='call-ring'){
          if(remoteCallSessionId)return;
          dmCallPeerId=dmPeerId||activePeerId;applyRemoteCallState(true,'legacy');logCallEvent('Friend joined the call');return;
        }
        if(value.t==='call-end'){
          if(!remoteCallSessionId&&!friendInCall)return;
          applyRemoteCallState(false);logCallEvent('Friend left the call');return;
        }
        if(value.t==='screen-start'){remoteScreenExpected=true;remoteNativeScreenExpected=value.native===true;remoteScreenSuppressed=false;logCallEvent('Friend started '+(value.native===true?'native AV1 ':'')+'screen sharing');remoteScreen.hidden=false;screenStatus.textContent='Friend sharing';return}
        if(value.t==='screen-watch'&&screenActive){const watching=value.active===true;if(watching===friendWatchingScreen)return;friendWatchingScreen=watching;const status=watching?'Sharing · friend is watching':'Sharing · waiting for friend';screenStatus.textContent=status+screenAudioDebug;screenBtn.title=status;if(watching){playSound('screen-watch');logCallEvent('Friend started watching your screen')}else logCallEvent('Friend stopped watching your screen');return}
        if(value.t==='screen-end'){logCallEvent('Friend stopped screen sharing');clearRemoteScreenShare();return}
        if(value.t==='watch'){receiveWatchMessage(value);return}
        if(value.t==='net-budget'){rememberPeerNetBudget(directBudgetKey(),value,{aliasDirect:true});return}
        if(value.t==='screen-codec-fallback'&&screenActive){await switchScreenCodec(compatibilityScreenCodec());return}
        if(value.t==='reneg-offer'){await answerDirectRenegotiation(value.sdp,sdp=>send({t:'reneg-answer',sdp}));return}
        if(value.t==='reneg-answer')await applyDirectRenegotiationAnswer(value.sdp);
      }catch(error){console.warn('direct renegotiation error',error)}
    };
  }
  if(files){const channel=files,epoch=fileSessionEpoch;channel.binaryType='arraybuffer';sendWindow=MAX_SEND_WINDOW;channel.bufferedAmountLowThreshold=Math.max(4*1024*1024,sendWindow*.5);channel.onmessage=event=>dispatchFileChannelFrame(event,{epoch,bus:channel});channel.onopen=()=>{if(channel!==files||epoch!==fileSessionEpoch)return;setStatus('Connected directly',true);announceFileCapabilities(epoch)}}
}
// Add name handling once per data channel without disturbing the encrypted
// message/profile handler above. This also covers the channel received by the
// answering peer through `ondatachannel`.
const originalWire=wire,profileNameChannels=new WeakSet();
wire=function(){if(chat&&!profileNameChannels.has(chat)){chat.addEventListener('message',handleProfileNameMessage);profileNameChannels.add(chat)}return originalWire()}
function fileBus(){return files&&files.readyState==='open'?files:null}
let tcpFilePort=8787,fileTransportMode='auto',tcpAutoRetryEpoch=-1,tcpAutoRetryAt=0;const TCP_AUTO_RETRY_DELAY=5*60*1000,MAX_DIRECT_FILE_PEERS=8,MAX_TCP_TOKEN_EPOCHS=16,tcpLaneWait=new Map(),directFilePeers=new Map(),tcpTokenEpochs=new Map();
function normalizedTransferLane(value){return value==='tcp'?'tcp':value==='webrtc'?'webrtc':value==='relay'?'relay':'waiting'}
function transferLaneText(value){const lane=normalizedTransferLane(value);return lane==='tcp'?'TCP DIRECT · port '+tcpFilePort:lane==='webrtc'?'WEBRTC DIRECT · fallback':lane==='relay'?'ENCRYPTED OBJECT RELAY · expires automatically':'CHECKING TCP ROUTE…'}
function setTransferRoute(el,value){const route=el?.querySelector('.transfer-route');if(!route)return;const lane=normalizedTransferLane(value);route.dataset.lane=lane;route.textContent=transferLaneText(lane)}
function refreshTransferRouteUi(){const lane=directFileId?'tcp':'webrtc';try{outTransfers.forEach(el=>setTransferRoute(el,lane));activeTransfers.forEach(t=>setTransferRoute(t.el,lane))}catch{}renderTransferSetupStatus()}
// Pairing codes deliberately use dots so chat apps do not italicize them. TCP
// credentials use a separate hexadecimal alphabet accepted by main and the
// native listener on every generation (the shared encoder caused ~40% random
// TCP authorization failures whenever a generated token contained a dot).
function tcpToken(){return[...crypto.getRandomValues(new Uint8Array(24))].map(byte=>byte.toString(16).padStart(2,'0')).join('')}
function validTcpHost(address){const value=String(address||'');if(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value))return !value.startsWith('169.254.');// Unscoped link-local v6 has no interface scope here and cannot be routed.
  return /^[0-9a-f:]+$/i.test(value)&&!/^fe[89ab]/i.test(value)}
function tcpHostRank(address){if(/^\d+\.\d+\.\d+\.\d+$/.test(address)){const parts=address.split('.').map(Number);if(parts[0]===10||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168))return 0}return 1}
// One ICE address is rarely the whole story: mDNS hiding, firewalls and NAT
// loopback make the selected pair's remote address unreliable for TCP even
// when other exchanged candidates are directly reachable on the LAN. Collect
// every remote candidate the pairs actually used, private ranges first.
async function remoteTcpAddresses(){
  if(!pc?.getStats)return [];const stats=await pc.getStats();let pair=null;const remoteIds=new Set();
  stats.forEach(r=>{if(r.type!=='candidate-pair'||r.state!=='succeeded'||!r.remoteCandidateId)return;remoteIds.add(r.remoteCandidateId);if((r.selected||r.nominated)&&!pair)pair=r});
  const remotes=[];stats.forEach(r=>{if((r.type==='remote-candidate'||r.type==='candidate')&&remoteIds.has(r.id)&&validTcpHost(r.address||r.ip))remotes.push(String(r.address||r.ip))});
  const selected=pair&&stats.get(pair.remoteCandidateId),first=selected&&validTcpHost(selected.address||selected.ip)?String(selected.address||selected.ip):null;
  const seen=new Set(first?[first]:[]);
  const rest=[];
  for(const address of remotes.sort((a,b)=>tcpHostRank(a)-tcpHostRank(b))){
    const key=address.toLowerCase();if(seen.has(key))continue;seen.add(key);rest.push(address);
  }
  return [...(first?[first]:[]),...rest].slice(0,5)
}
function registerDirectFilePeer(id,epoch=fileSessionEpoch){if(typeof id!=='string'||!id||epoch!==fileSessionEpoch||!directFilePeers.has(id)&&directFilePeers.size>=MAX_DIRECT_FILE_PEERS)return false;directFilePeers.set(id,epoch);if(!directFileId||directFilePeers.get(directFileId)!==epoch)directFileId=id;refreshTransferRouteUi();return true}
function activeDirectFileId(session,preferred=''){if(!liveFileSession(session))return'';if(preferred&&directFilePeers.get(preferred)===session.epoch)return preferred;if(directFileId&&directFilePeers.get(directFileId)===session.epoch)return directFileId;for(const[id,epoch]of directFilePeers)if(epoch===session.epoch){directFileId=id;return id}directFileId='';return''}
function retireDirectFilePeer(id,{notify=true}={}){if(typeof id!=='string'||!id)return;directFilePeers.delete(id);if(notify)try{window.pairDirectFile?.close(id)}catch{}if(directFileId===id){directFileId='';for(const[peerId,epoch]of directFilePeers)if(epoch===fileSessionEpoch){directFileId=peerId;break}}refreshTransferRouteUi()}
function closeTcpLane(){for(const id of[...directFilePeers.keys()])retireDirectFilePeer(id);directFilePeers.clear();directFileId='';for(const entry of tcpTokenEpochs.values())clearTimeout(entry.timer);tcpTokenEpochs.clear();try{window.pairDirectFile?.reset?.()}catch{}refreshTransferRouteUi()}
if(window.pairDirectFile){window.pairDirectFile.onOpen?.((id,token)=>{const entry=tcpTokenEpochs.get(token);if(!entry||entry.epoch!==fileSessionEpoch){try{window.pairDirectFile.close(id)}catch{}return}clearTimeout(entry.timer);tcpTokenEpochs.delete(token);if(!registerDirectFilePeer(id,entry.epoch))try{window.pairDirectFile.close(id)}catch{}});window.pairDirectFile.onFrame((id,data)=>{const epoch=directFilePeers.get(id);if(epoch!==fileSessionEpoch){try{window.pairDirectFile.ack(id,data?.byteLength||0);window.pairDirectFile.close(id)}catch{}return}const source=data instanceof ArrayBuffer?new Uint8Array(data):ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):Uint8Array.from(data||[]);const bytes=source.slice().buffer;receiveQueue=receiveQueue.then(()=>onFileFrame({data:bytes},false,{epoch,bus:files,tcpId:id})).catch(error=>{console.warn('TCP file frame rejected',error);retireDirectFilePeer(id)}).finally(()=>{try{window.pairDirectFile.ack(id,bytes.byteLength)}catch{}})});window.pairDirectFile.onClose(id=>retireDirectFilePeer(id,{notify:false}))}
function friendlyTcpLaneError(error){const raw=String(error?.message||error).replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,'');if(/timed out|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|unreachable|EACCES/i.test(raw))return 'Could not reach your friend on TCP port '+tcpFilePort+'. Their firewall must allow Knot, or that port must be forwarded.';return raw}
async function prepareTcpLane(session){assertFileSession(session);if(fileTransportMode==='webrtc')return'';const existing=activeDirectFileId(session);if(existing)return existing;if(fileTransportMode==='auto'&&tcpAutoRetryEpoch===session.epoch&&Date.now()<tcpAutoRetryAt)return'';if(!window.pairDirectFile||!directFileKey){if(fileTransportMode==='tcp')throw new Error('TCP fast transfer is unavailable for this connection');return''}if(tcpTokenEpochs.size>=MAX_TCP_TOKEN_EPOCHS){if(fileTransportMode==='tcp')throw new Error('Too many TCP file connections are pending');return''}const token=tcpToken();const tokenTimer=setTimeout(()=>tcpTokenEpochs.delete(token),65000);tcpTokenEpochs.set(token,{epoch:session.epoch,timer:tokenTimer});const ready=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{tcpLaneWait.delete(token);reject(new Error('TCP port did not respond'))},5000),finish=(callback,value)=>{clearTimeout(timeout);tcpLaneWait.delete(token);callback(value)};tcpLaneWait.set(token,{epoch:session.epoch,resolve:port=>finish(resolve,port),reject:error=>finish(reject,error)})});ready.catch(()=>{});try{await safeSend(JSON.stringify({t:'tcp-prepare',token,port:tcpFilePort}),session);const port=await ready;assertFileSession(session);const hosts=await remoteTcpAddresses();assertFileSession(session);if(!hosts.length)throw new Error('Could not determine your friend’s direct address');let lastError=null,id='';for(const host of hosts){try{id=await window.pairDirectFile.connect(host,port,token,directFileKey,{timeout:2000});assertFileSession(session);break}catch(error){lastError=error}}if(!id)throw lastError||new Error('Your friend did not answer on their TCP port');if(!registerDirectFilePeer(id,session.epoch)){try{window.pairDirectFile.close(id)}catch{}throw new Error('File connection changed during TCP setup')}tcpAutoRetryEpoch=-1;tcpAutoRetryAt=0;pairHint.textContent='Fast direct TCP file connection ready.';return id}catch(error){tcpLaneWait.delete(token);const entry=tcpTokenEpochs.get(token);if(entry){clearTimeout(entry.timer);tcpTokenEpochs.delete(token)}if(fileTransportMode==='tcp')throw new Error(friendlyTcpLaneError(error));tcpAutoRetryEpoch=session.epoch;tcpAutoRetryAt=Date.now()+TCP_AUTO_RETRY_DELAY;if(liveFileSession(session))pairHint.textContent='TCP fast path unavailable; using direct WebRTC.';refreshTransferRouteUi();return''}}

// ICE servers use public STUN by default. Set PAIR_TURN to a JSON array of your
// own TURN servers when a direct route is unavailable; Electron validates that
// configuration before exposing it to the renderer.
// Direct pairing is STUN-only by default. In the desktop app, validated custom
// TURN settings are supplied by the preload bridge; browser builds retain the
// safe default rather than depending on a Node `process` global.
const DEFAULT_ICE_SERVERS=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
const CONFIGURED_ICE_SERVERS=Array.isArray(window.pairEnv?.iceServers)?window.pairEnv.iceServers:[];
const ICE_SERVERS=CONFIGURED_ICE_SERVERS.length?CONFIGURED_ICE_SERVERS:DEFAULT_ICE_SERVERS;
function iceUrls(item){return Array.isArray(item?.urls)?item.urls:[item?.urls]}
function hasTurnUrl(item){return iceUrls(item).some(url=>typeof url==='string'&&/^(?:turn|turns):/i.test(url))}
function directIceServers(){const stun=ICE_SERVERS.map(item=>{const urls=iceUrls(item).filter(url=>typeof url==='string'&&/^stun:/i.test(url));return urls.length?{urls}:null}).filter(Boolean);return stun.length?stun:DEFAULT_ICE_SERVERS}
let dmIceServers=directIceServers(),turnIceServers=CONFIGURED_ICE_SERVERS.filter(hasTurnUrl),turnCredentialWaiter=null,turnCredentialPending=null,relayVoiceMode=false,dmMediaPlan=null;
function viableScreenPeer(target=pc){return !!target&&target===pc&&!['failed','disconnected','closed'].includes(String(target.connectionState||''))&&target.signalingState!=='closed'}
function setupPeer(){
  abortCurrentFileSession('Connection replaced');
  settleDirectRenegotiation();renegotiating++;
  // Close previous pc and associated resources if reconnecting (e.g. peer-left → peer-ready).
  // Invalidate capture first, then null pc before closing so the old connection
  // handler cannot act on the replacement peer.
  if(pc){
    const resumeCall=reconnectCall||callActive;
    if(callActive||localStream||localMicrophoneStream)suspendDirectCallForPeerReplacement();
    reconnectCall=resumeCall;
    abortScreenSharePicker();if(screenActive||screenStarting||screenStream||nativeScreenSession)void stopScreenShare(true);else screenGen++;
    const oldPc=pc;pc=null;const oldChat=chat;const oldFiles=files;chat=null;files=null;
    if(oldPc._connectTimer){clearTimeout(oldPc._connectTimer);oldPc._connectTimer=null}
    if(oldPc._silentAudioCtx)try{oldPc._silentAudioCtx.close()}catch{}
    if(oldChat){oldChat.onmessage=null;try{oldChat.close()}catch{}}
    if(oldFiles){oldFiles.onmessage=null;try{oldFiles.close()}catch{}}
    try{oldPc.close()}catch{}
  }
  pc=new RTCPeerConnection({iceServers:dmIceServers,iceTransportPolicy:relayVoiceMode?'relay':'all'});const peer=pc;peer.onicecandidate=()=>{};let wasEverConnected=false;
  peer.onconnectionstatechange=()=>{if(pc!==peer)return;const state=peer.connectionState;if(state==='connected'){if(peer._disconnectGrace){clearTimeout(peer._disconnectGrace);peer._disconnectGrace=null}if(dmConnectingPeerId===dmPeerId)dmConnectingPeerId='';screenBtn.disabled=relayVoiceMode;if(peer._connectTimer){clearTimeout(peer._connectTimer);peer._connectTimer=connectTimer=null}if(callActive)publishCallState(true);if(!wasEverConnected){wasEverConnected=true;if(reconnectCall){reconnectCall=false;releaseCallMicrophone();callActive=false;startCall()}}else{setStatus(relayVoiceMode?'Voice relay active · files and screen share stay P2P':'Connected directly',true);friendLeftNotified=false}}if(state==='disconnected'){if(!peer._disconnectGrace)peer._disconnectGrace=setTimeout(()=>{if(pc===peer&&['disconnected','failed'].includes(peer.connectionState))setStatus('disconnected')},6000);return}if(['failed','closed'].includes(state)){if(peer._disconnectGrace){clearTimeout(peer._disconnectGrace);peer._disconnectGrace=null}if(callActive)publishCallState(false);if(dmConnectingPeerId===dmPeerId)dmConnectingPeerId='';screenBtn.disabled=true;abortScreenSharePicker();if(screenActive||screenStarting||screenStream||nativeScreenSession)void stopScreenShare(true);else screenGen++;if(peer._connectTimer){clearTimeout(peer._connectTimer);peer._connectTimer=connectTimer=null}applyRemoteCallState(false);if(directFileId)closeTcpLane();setStatus(state)}if(state==='connecting'){pairHint.textContent=(relayVoiceMode?'Connecting low-bandwidth voice relay':'Negotiating peer connection')+' (ICE '+(peer.iceConnectionState||'')+')…';armConnectTimeout()}};peer.oniceconnectionstatechange=()=>{if(pc!==peer)return;if(peer.iceConnectionState==='failed'){pairHint.textContent=relayVoiceMode?'Voice relay failed. Text will keep working, but this network cannot reach the relay.':'Direct peer connection failed; retrying before the low-bandwidth voice relay.'}else if(peer.iceConnectionState==='checking'||peer.iceConnectionState==='connected'){pairHint.textContent=(relayVoiceMode?'Connecting voice relay':'Negotiating peer connection')+' (ICE '+(peer.iceConnectionState||'')+')…'}};peer.ondatachannel=e=>{if(e.channel.label==='chat')chat=e.channel;else if(!relayVoiceMode)files=e.channel;wire()};
  peer.addEventListener('connectionstatechange',()=>{if(pc!==peer||peer.connectionState!=='connected'||callActive||callStarting||pendingVoiceStartPeerId!==dmPeerId)return;pendingVoiceStartPeerId='';startCall()});
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
    const silentDst=silentCtx.createMediaStreamDestination(),silentScreenDst=silentCtx.createMediaStreamDestination();
    silentDst.channelCount=1;silentScreenDst.channelCount=2;
    audioTransceiver=pc.addTrack(silentDst.stream.getAudioTracks()[0],silentDst.stream);
    screenAudioTransceiver=pc.addTrack(silentScreenDst.stream.getAudioTracks()[0],silentScreenDst.stream);
    pc._silentScreenAudioTrack=silentScreenDst.stream.getAudioTracks()[0];
    // Keep a reference so we can close the AudioContext on disconnect
    pc._silentAudioCtx=silentCtx;
    preferVoiceAudioCodecs(pc.getTransceivers().find(value=>value.sender===audioTransceiver));
  }catch(e){console.warn('Silent audio tracks failed, using transceivers:',e);try{audioTransceiver=pc.addTransceiver('audio',{direction:'sendrecv'});screenAudioTransceiver=pc.addTransceiver('audio',{direction:'sendrecv'});preferVoiceAudioCodecs(audioTransceiver)}catch(e2){console.warn('addTransceiver also failed:',e2);audioTransceiver=null;screenAudioTransceiver=null}}
  logCallEvent('Diag: setupPeer transceivers='+pc.getTransceivers().length+' voice='+(audioTransceiver?'ready':'null')+' screenAudio='+(screenAudioTransceiver?'ready':'null'));
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
    const isReservedScreenAudio=e.track.kind==='audio'&&(e.transceiver===screenAudioTransceiver||e.transceiver?.sender===screenAudioTransceiver);
    // Windows attaches computer sound in a later renegotiation. Data-channel
    // screen-start metadata and that new audio m-line can arrive in either
    // order, so a second audio transceiver after the established call track is
    // unambiguously screen sound even before the metadata reaches Linux.
    const isAdditionalScreenAudio=e.track.kind==='audio'&&!!remoteVoiceTransceiver&&!!e.transceiver&&e.transceiver!==remoteVoiceTransceiver;
    const bindsToScreen=!isVoiceAudio&&(isReservedScreenAudio||stream===remoteScreen.srcObject
      ||!!(screenStreamId&&e.streams?.some(s=>s?.id===screenStreamId))
      ||stream.getVideoTracks().length>0
      ||remoteScreenExpected
      ||isAdditionalScreenAudio
      ||(e.track.kind==='audio'&&!remoteScreen.hidden&&!!remoteScreen.srcObject));
    if(e.track.kind==='audio'&&bindsToScreen){
      // Keep screen sound out of the video element for every share backend.
      // On Linux a WebRTC video element can retain an old/muted audio sink
      // after its video track is replaced, leaving Windows standard shares
      // visibly live but silent. The dedicated element gives standard and AV1
      // shares the same reliable playback, output-device, and volume route.
      const audio=ensureNativeRemoteAudio();audio.srcObject=stream;audio.volume=remoteScreen.volume;audio.muted=remoteScreenSuppressed||!screenExpanded||focusedScreen!=='remote'||audio.volume===0;e.track.enabled=true;e.track.onended=()=>{if(audio.srcObject===stream){audio.pause();audio.srcObject=null}};
      const play=()=>{if(!remoteScreenSuppressed&&screenExpanded&&focusedScreen==='remote'&&audio.srcObject===stream){e.track.enabled=true;audio.volume=remoteScreen.volume;audio.muted=audio.volume===0;if(!audio.muted)audio.play().catch(()=>{})}};
      logCallEvent((remoteNativeScreenExpected||nativeRemotePlayer||remoteNativeScreenChannel)?'Native screen audio received':'Screen audio received');screenAudioDebug=' · audio received';screenStatus.textContent='Friend sharing'+screenAudioDebug;updateScreenLayout();play();
      if(!screenGestureGuard){screenGestureGuard=true;document.addEventListener('pointerdown',play,{once:true});document.addEventListener('keydown',play,{once:true})}
      return;
    }
    if(e.track.kind==='audio'){logCallEvent('Audio track received from friend');if(remoteAudio.srcObject){try{remoteAudio.srcObject.getAudioTracks().forEach(t=>t.onended=null)}catch{}}if(remoteAudio.srcObject&&remoteAudio.srcObject!==stream){try{remoteAudio.srcObject.addTrack(e.track)}catch{}}else remoteAudio.srcObject=stream;remoteVoiceTrack=e.track;remoteVoiceTransceiver=e.transceiver||remoteVoiceTransceiver;try{remoteVoicePlayoutStop?.()}catch{};remoteVoicePlayoutStop=monitorVoicePlayout(e.transceiver?.receiver||pc.getReceivers().find(value=>value.track===e.track),e.track);monitorSpeaking('dm-friend',e.track);e.track.onended=()=>{if(remoteVoiceTrack===e.track){remoteVoiceTrack=null;remoteVoiceTransceiver=null}try{remoteVoicePlayoutStop?.()}catch{};remoteVoicePlayoutStop=null;stopSpeakingMonitor('dm-friend');applyRemoteCallState(false);logCallEvent('Friend left the call')};if(!callActive){setRemoteCallAudio(false);return}setRemoteCallAudio(true);if(!gestureGuard){gestureGuard=true;document.addEventListener('pointerdown',()=>setRemoteCallAudio(callActive),{once:true});document.addEventListener('keydown',()=>setRemoteCallAudio(callActive),{once:true})}}else if(e.track.kind==='video'){const receiver=pc.getReceivers().find(value=>value.track===e.track);remoteScreenDecodeStop?.();remoteScreenDecodeStop=receiver?monitorRemoteScreenDecode(receiver,e.track,null,()=>!remoteScreen.hidden&&!remoteScreenSuppressed&&!remoteScreen.paused):null;remoteScreen.hidden=false;try{remoteScreen.srcObject=stream;remoteScreen.playbackRate=1}catch{};updateScreenLayout();e.track.onended=()=>{if(remoteScreen.srcObject===stream)clearRemoteScreenShare()}}}catch{}};
}
function monitorRemoteScreenDecode(receiver,track,requestFallback,isActive){
  let latencyTargetMs=45;const applyLatencyTarget=value=>{latencyTargetMs=Math.min(180,value);try{receiver.playoutDelayHint=latencyTargetMs/1000}catch{}try{if('jitterBufferTarget'in receiver)receiver.jitterBufferTarget=latencyTargetMs}catch{}};applyLatencyTarget(latencyTargetMs);
  let previousBytes=0,previousFrames=0,previousLost=0,previousFreezes=0,previousJitterDelay=0,previousJitterCount=0,stableWindows=0,stalls=0,finished=false,sampleInFlight=false;
  const stop=()=>{if(finished)return;finished=true;clearInterval(timer);try{track.removeEventListener?.('ended',stop)}catch{}};
  const sample=async()=>{if(sampleInFlight||finished)return;sampleInFlight=true;try{
    if(finished||track.readyState==='ended')return stop();
    if(!track.enabled||(typeof isActive==='function'&&!isActive())){stalls=0;return}
    const reports=await receiver.getStats();if(finished||track.readyState==='ended')return stop();let inbound,codec;
    reports.forEach(report=>{if(report.type==='inbound-rtp'&&(report.kind==='video'||report.mediaType==='video')&&!report.isRemote)inbound=report});
    if(!inbound)return;
    codec=reports.get(inbound.codecId);const bytes=Number(inbound.bytesReceived)||0,frames=Number(inbound.framesDecoded)||0,lost=Number(inbound.packetsLost)||0,freezes=Number(inbound.freezeCount)||0,jitterDelay=Number(inbound.jitterBufferDelay)||0,jitterCount=Number(inbound.jitterBufferEmittedCount)||0,received=bytes-previousBytes,decoded=frames-previousFrames,jitterDelta=jitterDelay-previousJitterDelay,jitterCountDelta=jitterCount-previousJitterCount,playoutMs=jitterCountDelta>0?Math.max(0,jitterDelta/jitterCountDelta*1000):0,pressure=lost>previousLost||freezes>previousFreezes||Number(inbound.jitter)>.03;
    previousBytes=bytes;previousFrames=frames;previousLost=lost;previousFreezes=freezes;previousJitterDelay=jitterDelay;previousJitterCount=jitterCount;if(playoutMs)recordMetric('screen.playout_ms',playoutMs,{codec:String(codec?.mimeType||'unknown').replace('video/','').toLowerCase()});
    const wasCongested=networkReceiveCongested;
    if(pressure){networkReceiveCongested=true;if(received>0)networkLiveReceiveMbps=Math.max(1.5,(received*8)/2500/1000);if(!wasCongested)announceNetBudget();stableWindows=0;if(latencyTargetMs<80)applyLatencyTarget(80)}
    else {if(wasCongested){networkReceiveCongested=false;networkLiveReceiveMbps=NaN;announceNetBudget()}if(decoded>0&&++stableWindows>=3&&latencyTargetMs>45)applyLatencyTarget(45)}
    if(decoded>0){stalls=0;return}
    if(received<50000)return;
    stalls++;
    if(stalls===1){try{receiver.requestKeyFrame?.()}catch{};return}
    if(stalls>=2&&/video\/AV1/i.test(codec?.mimeType||'')){
      screenStatus.textContent='AV1 decoder stalled — switching to '+compatibilityScreenCodec();
      const requested=requestFallback?requestFallback():(chat?.readyState==='open'&&send({t:'screen-codec-fallback'}));if(requested!==false)stop();
    }
  }catch{}finally{sampleInFlight=false}};
  const timer=setInterval(sample,2500);track.addEventListener?.('ended',stop,{once:true});setTimeout(sample,2500);return stop;
}
async function waitIce(target=pc){if(!target||target.iceGatheringState==='complete')return;await new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;target.removeEventListener('icegatheringstatechange',changed);clearTimeout(timeout);resolve()};const changed=()=>{if(target.iceGatheringState==='complete'||target.signalingState==='closed')finish()};const timeout=setTimeout(finish,5000);target.addEventListener('icegatheringstatechange',changed)})}
function networkMath(){return window.KnotNetworkCapacity||null}
function probedUploadMbps(){return Number(networkCapacity?.uploadMbps)}
function screenShareHasProbe(){return Number.isFinite(probedUploadMbps())&&probedUploadMbps()>0}
function effectiveUploadCapMbps(){return networkMath()?.effectiveUploadCapMbps(probedUploadMbps(),Infinity)??Infinity}
function targetVoiceBitrate(){return networkMath()?.voiceBitrateBps({relay:relayVoiceMode,uploadMbps:probedUploadMbps()})||(relayVoiceMode?24000:48000)}
function effectiveScreenBitrateCeiling(){const math=networkMath();if(lanSharePath())return math?.MAX_NATIVE_SHARE_MBPS||250;return math?math.autoShareCeilingMbps(probedUploadMbps(),{explicit:screenBitrateExplicit,slider:screenBitrateMbps}):screenBitrateMbps}
function screenShareCanRaiseBitrate(){return hardwareScreenCodec==='AV1'||hardwareScreenCodec==='H264'}
function sliderBitrateMaxMbps(){return networkMath()?.MAX_SLIDER_MBPS||250}
function encoderShareCapMbps(options){return networkMath()?.encoderShareCapMbps(options)||(options?.native?250:options?.hardware?80:20)}
function parseNetworkCapacity(value){
  if(!value)return null;
  try{const parsed=typeof value==='string'?JSON.parse(value):value;return networkMath()?.cachedCapacityFresh(parsed)?parsed:null}catch{return null}
}
function lanSharePath(){return !!(pc&&pc._lan&&!serverVoiceStream&&!relayVoiceMode)}
function receivingRemoteShare(){return !!(nativeRemotePlayer||remoteScreenExpected||[...serverPeers.values()].some(state=>state.screen||state.nativeScreenPlayer))}
function directBudgetKey(){return dmCallPeerId||dmPeerId||activePeerId||'direct'}
function receiveBudgetForCap(budget){return budget?{downloadMbps:budget.downloadMbps,liveMbps:budget.congested?budget.liveMbps:undefined}:null}
function lookupPeerBudget(peerId){
  return peerNetBudgets.get(peerId)||(!serverVoiceStream&&peerId&&peerId!=='direct'&&peerNetBudgets.get('direct'))||null;
}
function peerReceiveCapMbps(peerId){
  if(lanSharePath())return Infinity;
  const math=networkMath(),budget=lookupPeerBudget(peerId);
  if(!math?.viewerReceiveCapMbps||!budget)return Infinity;
  return math.viewerReceiveCapMbps(budget.downloadMbps,budget.congested?budget.liveMbps:Infinity);
}
function currentViewerReceiveCapMbps(){
  if(lanSharePath())return Infinity;
  const math=networkMath();
  if(!math?.minViewerReceiveCapMbps)return Infinity;
  const viewers=[];
  if(serverVoiceStream){for(const [peerId,state] of serverPeers){if(state.closing||!voicePeerAllowed(peerId))continue;const budget=receiveBudgetForCap(lookupPeerBudget(peerId));if(budget)viewers.push(budget)}}
  else {const budget=receiveBudgetForCap(lookupPeerBudget(directBudgetKey()));if(budget)viewers.push(budget)}
  return math.minViewerReceiveCapMbps(viewers);
}
function localNetBudgetMessage(){
  const parsed=networkMath()?.normalizeNetBudget?.({
    downloadMbps:networkCapacity?.downloadMbps,
    uploadMbps:networkCapacity?.uploadMbps,
    liveMbps:networkLiveReceiveMbps,
    congested:networkReceiveCongested,
    at:networkCapacity?.at||Date.now()
  });
  return parsed?{t:'net-budget',...parsed}:null;
}
function announceNetBudget(){
  const message=localNetBudgetMessage();if(!message)return;
  send(message);
  for(const state of serverPeers.values()){
    if(state.closing||state.channel?.readyState!=='open')continue;
    try{state.channel.send(JSON.stringify({...message,serverId:state.context.serverId}))}catch{}
  }
}
function stopNetBudgetPulse(){if(!netBudgetTimer)return;clearInterval(netBudgetTimer);netBudgetTimer=null}
function startNetBudgetPulse(){
  if(netBudgetTimer)return;
  netBudgetTimer=setInterval(()=>{
    if(!(chat?.readyState==='open'||[...serverPeers.values()].some(state=>!state.closing&&state.channel?.readyState==='open'))){stopNetBudgetPulse();return}
    announceNetBudget();
    void maybeAdoptLiveShareBudget();
  },networkMath()?.SHARE_BUDGET_INTERVAL_MS||20000);
}
function rememberPeerNetBudget(peerId,value,{aliasDirect=false}={}){
  const parsed=networkMath()?.normalizeNetBudget?.(value);if(!parsed||!peerId)return false;
  const previous=peerNetBudgets.get(peerId)||{};
  const merged={...previous,...parsed};
  if(parsed.congested===false){merged.congested=false;delete merged.liveMbps}
  peerNetBudgets.set(peerId,merged);
  if(aliasDirect){const dm=directBudgetKey();if(dm)peerNetBudgets.set(dm,merged);if(dm!=='direct')peerNetBudgets.delete('direct')}
  void maybeAdoptLiveShareBudget();
  return true;
}
function shareStatsCongested({nackRate,remote}={}){
  // qualityLimitationReason==='bandwidth' is normal once maxBitrate is the cap.
  // Treating it as congestion ratcheted a healthy 37 Mbps share down to the floor.
  if(Number(nackRate)>2)return true;
  const lost=Number(remote?.fractionLost);
  return Number.isFinite(lost)&&lost>0.02;
}
function abortInFlightNetworkProbe(){try{window.pairEnv?.abortNetworkProbe?.()}catch{}}
async function maybeAdoptLiveShareBudget({force=false,congested=false}={}){
  if(nativeScreenSession||serverNativeScreenSession)return;
  const math=networkMath();
  const adopt=(key,desired)=>{
    const current=shareBudgetApplied.get(key);
    if(!force&&math?.shouldAdoptShareBudget&&!math.shouldAdoptShareBudget(current?.mbps,desired,{lastChangeAt:current?.at||0}))return false;
    shareBudgetApplied.set(key,{mbps:desired,at:Date.now()});
    return true;
  };
  if(screenActive){
    const sender=screenSenders.find(value=>value.track?.kind==='video');
    if(sender?.track){
      const settings=sender.track.getSettings?.()||{},key=directBudgetKey(),viewer=peerReceiveCapMbps(key);
      const current=shareBudgetApplied.get(key)?.mbps,peerCongested=congested||lookupPeerBudget(key)?.congested===true;
      const desired=math?.nextShareBudgetMbps?.(current,{senderMbps:targetScreenBitrate(settings.width,settings.height,shareFrameRate)/1e6,viewerMbps:viewer,congested:peerCongested})??Math.min(targetScreenBitrate(settings.width,settings.height,shareFrameRate)/1e6,Number.isFinite(viewer)?viewer:Infinity);
      if(adopt(key,desired))await configureScreenVideoSender(sender,sender.track,shareFrameRate,1,desired,key);
    }
  }
  if(serverScreenStream){
    const viewers=serverMediaPeerCount();
    for(const [peerId,state] of serverPeers){
      if(state.closing||!voicePeerAllowed(peerId))continue;
      for(const sender of state.screenSenders||[]){
        if(sender.track?.kind!=='video')continue;
        const settings=sender.track.getSettings?.()||{},viewer=peerReceiveCapMbps(peerId);
        const current=shareBudgetApplied.get(peerId)?.mbps,peerCongested=lookupPeerBudget(peerId)?.congested===true;
        const desired=math?.nextShareBudgetMbps?.(current,{senderMbps:targetScreenBitrate(settings.width,settings.height,shareFrameRate)/1e6/viewers,viewerMbps:viewer,congested:peerCongested})??Math.min(targetScreenBitrate(settings.width,settings.height,shareFrameRate)/1e6/viewers,Number.isFinite(viewer)?viewer:Infinity);
        if(adopt(peerId,desired))await configureScreenVideoSender(sender,sender.track,shareFrameRate,viewers,desired,peerId);
      }
    }
  }
}
async function startNetworkCapacityProbe(){
  try{const cached=parseNetworkCapacity(await ss('networkCapacity'));if(cached){networkCapacity=cached;announceNetBudget();return}}catch{}
  if(screenActive||serverScreenSharing()||receivingRemoteShare()||screenStarting||serverScreenStarting)return;
  const probe=window.pairEnv?.networkProbe;if(typeof probe!=='function')return;
  try{const result=await probe();if(screenActive||serverScreenSharing()||receivingRemoteShare())return;if(result&&Number(result.uploadMbps)>0&&Number(result.downloadMbps)>0){networkCapacity={uploadMbps:Number(result.uploadMbps),downloadMbps:Number(result.downloadMbps),probeVersion:Number(result.probeVersion)||networkMath()?.PROBE_VERSION||2,at:Number(result.at)||Date.now()};ssSet('networkCapacity',JSON.stringify(networkCapacity));announceNetBudget()}}catch{}
}
async function waitForViewerBudgets(timeoutMs=400){
  const deadline=Date.now()+Math.max(0,Number(timeoutMs)||0);
  while(Date.now()<deadline){
    if(serverVoiceStream){const peers=[...serverPeers].filter(([id,state])=>!state.closing&&voicePeerAllowed(id));if(!peers.length||peers.every(([id])=>lookupPeerBudget(id)))return}
    else if(!chat||chat.readyState!=='open'||lookupPeerBudget(directBudgetKey()))return;
    await new Promise(resolve=>setTimeout(resolve,40));
  }
}
async function probeHardwareScreenCodec(){
  if(hardwareScreenCodec)return hardwareScreenCodec;
  hardwareScreenCodec='none';
  if(typeof navigator==='undefined'||!navigator.mediaCapabilities||typeof navigator.mediaCapabilities.encodingInfo!=='function')return hardwareScreenCodec;
  const probe=async(contentType,extras)=>{try{const info=await navigator.mediaCapabilities.encodingInfo({type:'webrtc',video:Object.assign({contentType,width:1920,height:1080,bitrate:8e6,framerate:60},extras||{})});return !!(info&&info.supported&&info.powerEfficient)}catch{return false}};
  if(await probe('video/AV1',{scalabilityMode:'L1T2'}))hardwareScreenCodec='AV1';
  else if(await probe('video/H264'))hardwareScreenCodec='H264';
  return hardwareScreenCodec;
}
function preferVoiceAudioCodecs(transceiver){
  try{
    const caps=RTCRtpSender.getCapabilities?.('audio');if(!caps?.codecs?.length||!transceiver?.setCodecPreferences)return;
    const red=[],opus=[],rest=[];
    for(const codec of caps.codecs){const mime=String(codec.mimeType||'').toLowerCase();if(mime==='audio/red')red.push(codec);else if(mime==='audio/opus')opus.push(codec);else rest.push(codec)}
    const useRed=networkMath()?.preferAudioRed(probedUploadMbps())!==false;
    const ordered=(useRed?red:[]).concat(opus,rest);if(ordered.length)transceiver.setCodecPreferences(ordered);
  }catch{}
}
function patchOpusSection(section,kind){
  const voice=kind==='voice',bitrate=relayVoiceMode?24000:voice?targetVoiceBitrate():256000,playback=relayVoiceMode?16000:48000,stereo=relayVoiceMode||voice?0:1,dtx=relayVoiceMode||voice?1:0;
  return section.replace(/a=fmtp:111[^\r\n]*/g,m=>{if(!m.includes('maxaveragebitrate'))m+='; maxaveragebitrate='+bitrate;else m=m.replace(/maxaveragebitrate=\d+/,'maxaveragebitrate='+bitrate);if(!m.includes('maxplaybackrate'))m+='; maxplaybackrate='+playback;else m=m.replace(/maxplaybackrate=\d+/,'maxplaybackrate='+playback);if(!m.includes('maxptime'))m+='; maxptime=20';else m=m.replace(/maxptime=\d+/,'maxptime=20');if(!m.includes('minptime'))m+='; minptime=10';else m=m.replace(/minptime=\d+/,'minptime=10');if(!m.includes('useinbandfec'))m+='; useinbandfec=1';if(!m.includes('usedtx'))m+='; usedtx='+dtx;else m=m.replace(/usedtx=[01]/,'usedtx='+dtx);if(!m.includes('cbr'))m+='; cbr=1';if(!m.includes('stereo'))m+='; stereo='+stereo;else m=m.replace(/stereo=[01]/,'stereo='+stereo);if(!m.includes('sprop-stereo'))m+='; sprop-stereo='+stereo;else m=m.replace(/sprop-stereo=[01]/,'sprop-stereo='+stereo);return m});
}
function patchOpusSdp(sdp){let audioIndex=0;return String(sdp||'').split(/(?=^m=)/m).map(part=>part.startsWith('m=audio')?patchOpusSection(part,audioIndex++===0?'voice':'music'):part).join('')}
function patchSdp(sdp){return patchOpusSdp(sdp)}
function monitorVoicePlayout(receiver,track){
  if(!receiver||!track)return ()=>{};
  let latencyTargetMs=28,stableWindows=0,finished=false,sampleInFlight=false;
  const apply=value=>{latencyTargetMs=Math.max(20,Math.min(80,Number(value)||28));try{receiver.playoutDelayHint=latencyTargetMs/1000}catch{}try{if('jitterBufferTarget'in receiver)receiver.jitterBufferTarget=latencyTargetMs}catch{}};
  apply(28);
  const stop=()=>{if(finished)return;finished=true;clearInterval(timer);try{track.removeEventListener?.('ended',stop)}catch{}};
  const sample=async()=>{if(finished)return;if(track.readyState==='ended')return stop();if(sampleInFlight)return;sampleInFlight=true;try{
    const reports=await receiver.getStats();if(finished)return;let inbound;
    reports.forEach(report=>{if(report.type==='inbound-rtp'&&(report.kind==='audio'||report.mediaType==='audio')&&!report.isRemote)inbound=report});
    if(!inbound)return;
    const pressure=Number(inbound.packetsLost)>0&&Number(inbound.fractionLost)>0.02||Number(inbound.jitter)>0.02;
    if(pressure){stableWindows=0;if(latencyTargetMs<60)apply(60)}else if(++stableWindows>=3&&latencyTargetMs>28)apply(28);
  }catch{}finally{sampleInFlight=false}};
  const timer=setInterval(sample,2500);track.addEventListener?.('ended',stop,{once:true});setTimeout(sample,1200);return stop;
}
$('#createOffer').onclick=async()=>{try{if(pc||signaling)disconnectRoom();pairSignalBusy=false;pairReplyAccepted=false;processSignal.disabled=false;role='offer';signalIn.value='';ssSet('savedInviteCode',null);setOutgoingCode('');processSignal.textContent='Finish connection';setupPeer();const kp=await keyPair();pc._kp=kp;setupChannels();const o=await pc.createOffer();await pc.setLocalDescription({type:'offer',sdp:patchSdp(o.sdp)});await waitIce();setOutgoingCode(await makeSignal({type:'offer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}));pairHint.textContent='Invite ready. Copy it, send it to your friend, then paste their reply in step 2.'}catch(e){pairHint.textContent='Could not create invite: '+(e?.message||e)}};
processSignal.onclick=async()=>{if(pairSignalBusy){pairHint.textContent='Still processing that code…';return}if(role==='offer'&&(pairReplyAccepted||!pc||pc.signalingState!=='have-local-offer')){const failed=pc&&['failed','disconnected','closed'].includes(pc.connectionState);pairHint.textContent=failed?'That connection attempt already ended. Click Create invite, then send the new code to your friend for a fresh try.':'That reply was already accepted. Connecting directly…';processSignal.disabled=true;return}pairSignalBusy=true;processSignal.disabled=true;try{const remote=await cleanSignal(signalIn.value);if(role==='offer'){if(remote.type!=='answer')throw new Error('Paste the reply your friend created, not another invite');await pc.setRemoteDescription({type:'answer',sdp:remote.sdp});if(!await derive(pc._kp,remote.pub))throw new Error('Security code was not confirmed');pairReplyAccepted=true;pairHint.textContent='Connecting directly…'}else if(!role){if(remote.type!=='offer')throw new Error('Paste an invite first, then create its reply');role='answer';setOutgoingCode('');setupPeer();const kp=await keyPair();pc._kp=kp;await pc.setRemoteDescription({type:'offer',sdp:remote.sdp});if(!await derive(kp,remote.pub))throw new Error('Security code was not confirmed');const a=await pc.createAnswer();await pc.setLocalDescription({type:'answer',sdp:patchSdp(a.sdp)});await waitIce();setOutgoingCode(await makeSignal({type:'answer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}));pairHint.textContent='Reply ready. Copy it and send it back to the person who invited you.';processSignal.textContent='Reply ready'}else pairHint.textContent='Your reply is already ready. Copy it and send it back to your friend.'}catch(e){processSignal.disabled=false;pairHint.textContent='Could not continue pairing: '+(e?.message||e)}finally{pairSignalBusy=false}};
copySignal.onclick=()=>copyOutgoingCode().catch(e=>{pairHint.textContent='Could not copy code: '+(e?.message||e)});
messageForm.onsubmit=async e=>{e.preventDefault();const text=convertEmoticons(messageInput.value.trim()),gif=pendingGif;if(!text&&!gif)return;const payload=chatPayload(text,gif);if(enc.encode(payload).byteLength>MAX_MESSAGE_SIZE){pairHint.textContent='Messages are limited to 64 KB.';return}if(!sharedKey){if(LOCAL_TEST_MODE){addMessage(text,true,gif);messageInput.value='';setPendingGif(null);return}return}send({t:'msg',v:await seal(payload)});addMessage(text,true,gif);messageInput.value='';setPendingGif(null);if(gif?.analytics)analyticsShared(gif.analytics)};
async function waitForDirectFileChannel(peerId,timeoutMs=30000){const until=Date.now()+timeoutMs;while(Date.now()<until){if(fileBus()&&pc?.connectionState==='connected'&&dmPeerId===peerId)return true;await new Promise(resolve=>setTimeout(resolve,100))}return false}
fileInput.onchange=async()=>{const chosen=[...fileInput.files],selected=chosen.slice(0,MAX_OUTGOING_FILE_QUEUE),targetPeerId=activePeerId;fileInput.value='';if(!selected.length)return;if(fileRelayBatchActive){pairHint.textContent='Wait for the current encrypted relay batch to finish or cancel it first.';return}if(chosen.length>selected.length)pairHint.textContent='Knot queued the first 64 files. Send the remaining files in another batch.';
  const relayAvailable=fileRelayReady(targetPeerId),friend=directoryUser(targetPeerId);if(relayVoiceMode&&!relayAvailable){pairHint.textContent='File transfer needs a direct connection. This call is using the voice relay, so your call stays active.';return}
  if(targetPeerId&&friend?.online&&!relayVoiceMode&&(!fileBus()||dmPeerId!==targetPeerId)&&!LOCAL_TEST_MODE){try{pairHint.textContent='Connecting directly for file transfer…';await ensureDmMediaConnection(targetPeerId,{requireFileChannel:true});if(!await waitForDirectFileChannel(targetPeerId))throw new Error('Direct file connection timed out');if(activePeerId!==targetPeerId)throw new Error('File selection cancelled because you changed conversations');pairHint.textContent='Direct file connection ready.'}catch(error){if(!relayAvailable){pairHint.textContent=(error?.message||'Could not connect for file transfer')+'.';return}pairHint.textContent='Direct transfer unavailable · using your encrypted object-relay fallback.'}}
  const session=currentFileSession(targetPeerId||undefined);if(session&&!relayVoiceMode){selected.forEach(file=>sendFile(file,session,targetPeerId));return}if(relayAvailable){fileRelayBatchActive=true;try{for(const file of selected)try{await sendEncryptedFileRelay(file,targetPeerId)}catch(error){pairHint.textContent=error?.message||'Encrypted object relay failed'}}finally{fileRelayBatchActive=false;syncActiveDmTransport()}return}if(!LOCAL_TEST_MODE){pairHint.textContent='The direct file connection is not ready. Try again.';return}selected.forEach(file=>sendFile(file,session,targetPeerId));};
function transfer(name,size,dir,lane='waiting'){
  const el=document.createElement('div');el.className='transfer';el.innerHTML='<div class="transfer-top"><span class="transfer-name"></span><span class="transfer-status"></span></div><span class="transfer-route" data-lane="waiting"></span><div class="bar"><i></i></div><div class="transfer-stats"><span class="transfer-speed"></span><span class="transfer-eta"></span></div><div class="transfer-peer"></div><div class="transfer-btns"><button class="cancel-btn text-button" hidden>Cancel</button><button class="retry-btn primary" hidden>Retry</button><button class="close-btn text-button" hidden>Close</button></div>';
  el.querySelector('.transfer-name').textContent=name+' · '+format(size);
  setTransferRoute(el,lane);
  const msg=document.createElement('div');msg.className='message'+(dir==='out'?' mine':'');
  const bub=document.createElement('div');bub.className='bubble';bub.append(el);
  const meta=document.createElement('div');meta.className='meta';meta.textContent=new Date().toLocaleTimeString();
  msg.append(bub,meta);messages.append(msg);messages.scrollTop=messages.scrollHeight;
  return el;
}function closeTransferCard(el){const close=el?.querySelector('.close-btn');if(!close)return;close.hidden=false;close.onclick=()=>el.closest('.message')?.remove()}function format(n){return n<1e9?(n/1e6).toFixed(1)+' MB':(n/1e9).toFixed(2)+' GB'}function formatSpeed(bps){if(bps<1e3)return(bps).toFixed(0)+' B/s';if(bps<1e6)return(bps/1e3).toFixed(1)+' KB/s';if(bps<1e9)return(bps/1e6).toFixed(1)+' MB/s';return(bps/1e9).toFixed(2)+' GB/s'}function formatEta(sec){if(!isFinite(sec)||sec<0)return'';sec=Math.round(sec);if(sec<60)return sec+'s';const m=Math.floor(sec/60),s=sec%60;if(m<60)return m+'m '+s+'s';const h=Math.floor(m/60);return h+'h '+(m%60)+'m'}function updateStats(el,done,total,startTime){const elapsed=(performance.now()-startTime)/1000;if(elapsed<0.25)return;const speed=done/elapsed;const remaining=(total-done)/speed;el.querySelector('.transfer-speed').textContent=formatSpeed(speed);el.querySelector('.transfer-eta').textContent=formatEta(remaining)}
// Resolvers for sender-side acceptance and durable receiver save confirmation.
// These include time for a human Save As choice and a slow final fsync/antivirus
// scan. Both phases stay explicitly cancellable from the transfer card.
const FILE_ACCEPT_TIMEOUT=5*60*1000,FILE_RECEIPT_TIMEOUT=10*60*1000;
const acceptWait=new Map(),completionWait=new Map();
function transferWait(map,seq,timeout,message){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{if(map.get(seq)?.reject===fail){map.delete(seq);reject(new Error(message))}},timeout),finish=value=>{clearTimeout(timer);map.delete(seq);resolve(value)},fail=error=>{clearTimeout(timer);map.delete(seq);reject(error instanceof Error?error:new Error(String(error||message)))};map.set(seq,{resolve:finish,reject:fail})})}
function safeTransferName(value){return String(value||'file').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'_').trim().slice(0,255)||'file'}
async function sendFile(file,session=currentFileSession(),targetPeerId=activePeerId){try{const size=Number(file?.size),name=safeTransferName(file?.name),type=typeof file?.type==='string'?file.type.slice(0,255):'';if(!Number.isSafeInteger(size)||size<0||typeof file?.slice!=='function')return alert('That file could not be read safely.');if(size>MAX)return alert('This file is larger than 200 GiB.');if(!session){if(LOCAL_TEST_MODE){const preview=transfer(name,size,'out');preview.querySelector('.transfer-status').textContent='Local preview — not sent';preview.querySelector('.bar i').style.width='100%';return}return alert('Connect to this friend first, then send the file.')}assertFileSession(session);if(targetPeerId&&session.peerId!==targetPeerId)throw new Error('The file connection belongs to a different friend');if(sendAbort.size>=MAX_OUTGOING_FILE_QUEUE)throw new Error('The 64-file transfer queue is full. Wait for or cancel an existing transfer.');const el=transfer(name,size,'out');const cancelBtn=el.querySelector('.cancel-btn'),retryBtn=el.querySelector('.retry-btn');el.querySelector('.transfer-status').textContent='Queued';cancelBtn.hidden=false;retryBtn.hidden=true;const seq=++fileSeq;if(!Number.isSafeInteger(seq))throw new Error('File sequence exhausted');const ctrl={abort:false,remoteCancelled:false,session,peerId:targetPeerId||session.peerId,expectedSize:size};sendAbort.set(seq,ctrl);outTransfers.set(seq,el);cancelBtn.onclick=()=>{const aw=acceptWait.get(seq),cw=completionWait.get(seq);if(aw)aw.reject(new Error('Cancelled'));if(cw)cw.reject(new Error('Cancelled'));ctrl.abort=true;cancelBtn.hidden=true;void safeSend(JSON.stringify({t:'cancel',seq,by:'sender'}),session).catch(()=>{})};sendQueue=sendQueue.then(async()=>{let t0=0;try{if(ctrl.abort)throw new Error('Cancelled');assertFileSession(session);let tcpId='',tcpReady=null;if(fileTransportMode==='auto'){tcpId=activeDirectFileId(session);if(!tcpId){tcpReady=prepareTcpLane(session);tcpReady.catch(()=>{})}}else tcpId=await prepareTcpLane(session);if(ctrl.abort)throw new Error('Cancelled');assertFileSession(session);let lane=tcpId?'tcp':tcpReady?'waiting':'webrtc';setTransferRoute(el,lane);const wantsReceipt=remoteFileProtocol>=2,chunkSize=CHUNK,meta=await seal(JSON.stringify({name,size,type,seq,transport:lane,protocol:2,receipt:wantsReceipt,chunkSize}),session.key);if(ctrl.abort)throw new Error('Cancelled');assertFileSession(session);
  // Install the waiter before emitting start. A fast receiver can accept in the
  // same turn; installing it afterwards loses that response until timeout.
  const accepted=transferWait(acceptWait,seq,FILE_ACCEPT_TIMEOUT,'No answer');accepted.catch(()=>{});await safeSend(JSON.stringify({t:'start',v:meta}),session);await accepted;
  if(tcpReady){tcpId=await tcpReady;assertFileSession(session);const resolvedLane=tcpId?'tcp':'webrtc';if(resolvedLane!==lane){lane=resolvedLane;setTransferRoute(el,lane);await safeSend(JSON.stringify({t:'route',seq,transport:lane}),session)}}
  if(ctrl.abort)throw new Error('Cancelled');assertFileSession(session);t0=performance.now();
  // Keep several AES-GCM operations in flight. The old one-chunk look-ahead
  // serialized encryption behind every send, leaving a fast LAN underfed. Jobs
  // are still emitted in file order, so the receiver keeps its simple ordered
  // disk writer and memory remain bounded to a 32 MiB encryption look-ahead
  // (with extra small-chunk jobs only when their combined bytes remain low)
  // plus the
  // transport's adaptive send window.
  const cryptoJobs=[];let nextOfs=0;let lastPeerSent=0,lastPctSent=-1;
  const emitPct=(done,pct)=>{el.querySelector('i').style.width=Math.min(100,done/Math.max(1,size)*100)+'%';el.querySelector('.transfer-status').textContent=pct+'%';updateStats(el,done,size,t0);const now=Date.now();if((pct!==lastPctSent&&now-lastPeerSent>250)||now-lastPeerSent>500){lastPctSent=pct;lastPeerSent=now;safeSend(JSON.stringify({t:'progress',seq,p:pct}),session).catch(()=>{})}};
  const queueCrypto=()=>{if(nextOfs>=size)return;const start=nextOfs,end=Math.min(start+chunkSize,size);nextOfs=end;const job=file.slice(start,end).arrayBuffer().then(raw=>{assertFileSession(session);if(ctrl.abort)throw new Error('Cancelled');return sealBytes(new Uint8Array(raw),session.key)}).then(({iv,data})=>({frame:packChunk(seq,start,new Uint8Array(iv),new Uint8Array(data),end>=size),done:end}));job.catch(()=>{});cryptoJobs.push(job)};
  while(nextOfs<size&&cryptoJobs.length<cryptoAhead(chunkSize))queueCrypto();
  while(cryptoJobs.length){
    const {frame,done}=await cryptoJobs.shift();if(ctrl.abort)throw new Error('Cancelled');
    // busSafeSend observes the transport's real bufferedAmount and waits for
    // bufferedamountlow when necessary, so it is the authoritative limiter.
    const usedLane=await busSafeSend(frame,session,tcpId);if(usedLane!==lane){lane=usedLane;setTransferRoute(el,lane);void safeSend(JSON.stringify({t:'route',seq,transport:lane}),session).catch(()=>{})}
    queueCrypto();
    const pct=Math.round(done/Math.max(1,size)*100);emitPct(done,pct);
  }
    if(size>0){const transportSeconds=Math.max(.001,(performance.now()-t0)/1000);recordMetric('file.throughput_mbps',size*8/transportSeconds/1e6,{lane})}
    if(!ctrl.abort){let delivered=null;if(wantsReceipt){delivered=transferWait(completionWait,seq,FILE_RECEIPT_TIMEOUT,'Friend did not confirm that the file was saved');delivered.catch(()=>{})}el.querySelector('.transfer-status').textContent=wantsReceipt?'Uploaded · friend is saving…':'Sent';await safeSend(JSON.stringify({t:'end',seq}),session);if(delivered)await delivered;el.querySelector('.transfer-status').textContent=wantsReceipt?'Delivered':'Sent';el.querySelector('.transfer-speed').textContent='';el.querySelector('.transfer-eta').textContent='';setPeerPct(el,100);cancelBtn.hidden=true;closeTransferCard(el)}sendAbort.delete(seq);}catch(e){acceptWait.get(seq)?.reject(e);completionWait.get(seq)?.reject(e);sendAbort.delete(seq);if(ctrl.remoteCancelled){el.querySelector('.transfer-status').textContent='Friend cancelled'}else if(ctrl.abort||(e&&['Cleared','disconnected','Cancelled'].includes(e.message))){el.querySelector('.transfer-status').textContent='Cancelled'}else if(e&&e.message==='rejected'){const s=el.querySelector('.transfer-status');s.textContent='Declined by friend';s.classList.add('declined')}else{const s=el.querySelector('.transfer-status');s.textContent='Failed: '+(e?.message||e);s.classList.add('failed')}el.querySelector('.transfer-speed').textContent='';el.querySelector('.transfer-eta').textContent='';cancelBtn.hidden=true;retryBtn.hidden=false;retryBtn.onclick=()=>{el.closest('.message')?.remove();const retrySession=currentFileSession(ctrl.peerId||undefined);if(!retrySession){pairHint.textContent='Reopen the original friend’s DM and reconnect before retrying this file.';return}sendFile(file,retrySession,ctrl.peerId)};closeTransferCard(el);try{await safeSend(JSON.stringify({t:'end',seq,cancelled:true}),session)}catch{}}outTransfers.delete(seq)}).catch(error=>console.warn('file send queue failed',error))}catch(error){pairHint.textContent=error?.message||'Could not send that file'}}
// Active incoming transfers, keyed by their seq (so multiple files in flight
// are kept separate). Chunks carry seq in their frame header and route here.
const activeTransfers=new Map();
// Outgoing transfers, keyed by seq, so we can show the peer's reported progress.
const outTransfers=new Map();
const FileTransferProtocol=window.KnotFileTransferProtocol;if(!FileTransferProtocol)throw new Error('File-transfer protocol module did not load');const{IncomingRangeTracker,parseChunkFrame,validSequence:validTransferSequence}=FileTransferProtocol;
function abortCurrentFileSession(reason='Disconnected'){fileSessionEpoch++;remoteFileProtocol=1;closeTcpLane();busDrains.forEach(set=>set.forEach(wake=>{try{wake()}catch{}}));busDrains.clear();tcpLaneWait.forEach(wait=>{try{wait.reject(new Error(reason))}catch{}});tcpLaneWait.clear();sendAbort.forEach(control=>{control.abort=true});acceptWait.forEach(wait=>{try{wait.reject(new Error(reason))}catch{}});acceptWait.clear();completionWait.forEach(wait=>{try{wait.reject(new Error(reason))}catch{}});completionWait.clear();acceptCards.forEach(done=>{try{done(false)}catch{}});acceptCards.clear();activeTransfers.forEach(t=>{t.abort=true;wakeIncomingTransfer(t);void disposeIncomingTransfer(t);const status=t.el?.querySelector('.transfer-status');if(status&&!status.classList.contains('failed'))status.textContent=reason});activeTransfers.clear();clearPendingFrames();sendQueue=Promise.resolve();receiveQueue=Promise.resolve()}
// Renders the peer's mirrored progress under a transfer card.
function setPeerPct(el,pct){const p=el.querySelector('.transfer-peer');if(!p)return;p.textContent='Friend: '+pct+'%';p.style.display='';}
// Chunks that arrive on the relay before the matching 'start' is processed,
// held per-seq so nothing is dropped or misrouted.
const pendingFrames=new Map();const PENDING_FRAME_LIMIT=32*1024*1024,PENDING_FRAME_TTL=30000,MAX_PENDING_TRANSFERS=128,MAX_PENDING_FRAMES_PER_TRANSFER=64,MAX_ACTIVE_RANGES_PER_TRANSFER=1024,ACTIVE_FRAME_LIMIT=64*1024*1024,ACTIVE_TOTAL_FRAME_LIMIT=96*1024*1024,MAX_INCOMING_OFFERS=16,MAX_FILE_HEADER_BYTES=256,MAX_FILE_CHUNK_BYTES=4*1024*1024,MAX_FILE_FRAME_BYTES=MAX_FILE_CHUNK_BYTES+MAX_FILE_HEADER_BYTES+32;let pendingFrameBytes=0;
function dropPending(seq){const held=pendingFrames.get(seq);if(!held)return;clearTimeout(held._timer);for(const p of held)pendingFrameBytes-=p.len;pendingFrames.delete(seq);if(pendingFrameBytes<0)pendingFrameBytes=0}
function clearPendingFrames(){for(const seq of [...pendingFrames.keys()])dropPending(seq);pendingFrameBytes=0}
function activeIncomingBufferedBytes(){let total=0;for(const transfer of activeTransfers.values())total+=Math.max(0,Number(transfer.bufferedBytes)||0);return total}
function wakeIncomingTransfer(transfer){for(const wake of [...(transfer?._waiters||[])])wake()}
function waitForIncomingTransfer(transfer,timeout=1000){return new Promise(resolve=>{let timer=null,settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);transfer?._waiters?.delete(finish);resolve()};(transfer._waiters||(transfer._waiters=new Set())).add(finish);if(timeout>0)timer=setTimeout(finish,timeout)})}
const acceptCards=new Map(),cancelledOffers=new Map();const CANCELLED_OFFER_TTL=65000,CANCELLED_OFFER_LIMIT=128;
function rememberCancelledOffer(seq){if(!Number.isSafeInteger(seq)||seq<1)return;cancelledOffers.set(seq,Date.now()+CANCELLED_OFFER_TTL);if(cancelledOffers.size>CANCELLED_OFFER_LIMIT)cancelledOffers.delete(cancelledOffers.keys().next().value)}
function isCancelledOffer(seq){const expires=cancelledOffers.get(seq);if(!Number.isFinite(expires)||expires<=Date.now()){cancelledOffers.delete(seq);return false}return true}
function takeCancelledOffer(seq){const expires=cancelledOffers.get(seq);cancelledOffers.delete(seq);return Number.isFinite(expires)&&expires>Date.now()}
function showAcceptCard(meta,seq){const card=document.createElement('div');card.className='transfer accept-card';card.innerHTML='<div class="accept-top"><strong class="accept-name"></strong><span class="accept-size"></span></div><span class="transfer-route" data-lane="waiting"></span><p class="accept-hint">Your friend wants to send you a file.</p><div class="accept-btns"><button class="accept-yes primary">Accept</button><button class="accept-no">Decline</button></div>';card.querySelector('.accept-name').textContent=meta.name;card.querySelector('.accept-size').textContent=' · '+format(meta.size);setTransferRoute(card,meta.transport);const yes=card.querySelector('.accept-yes'),no=card.querySelector('.accept-no');const msg=document.createElement('div');msg.className='message';const bub=document.createElement('div');bub.className='bubble';bub.append(card);const mta=document.createElement('div');mta.className='meta';mta.textContent=new Date().toLocaleTimeString();msg.append(bub,mta);messages.append(msg);messages.scrollTop=messages.scrollHeight;const resolve=new Promise(r=>{const done=v=>{if(acceptCards.get(seq)!==done)return;clearTimeout(acceptTimer);acceptCards.delete(seq);if(!v)dropPending(seq);msg.remove();r(v)};const acceptTimer=setTimeout(()=>done(false),FILE_ACCEPT_TIMEOUT);acceptCards.set(seq,done);yes.onclick=()=>done(true);no.onclick=()=>done(false)});return resolve}
// Per-incoming-file ordered write queue so decrypted chunks hit disk in order
// even though decryption runs concurrently in a pool.
function makeWriteQueue(t){let tail=Promise.resolve();return fn=>{tail=tail.then(fn).catch(e=>{t.writeError=e;t.abort=true;wakeIncomingTransfer(t)});return tail}}
// Reserve byte ranges before decrypting them. Exact duplicate frames are a
// normal consequence of an ambiguous TCP write retried over WebRTC and are
// ignored; any partial overlap or out-of-range frame fails the transfer.
function reserveIncomingFrame(t,frame){let accepted;try{if(t.protocol===2){const expected=Math.min(t.chunkSize,t.size-frame.offset);if(frame.plainBytes!==expected)throw new Error('File chunk does not match the negotiated chunk size')}const newRange=frame.offset>=t.tracker.committed&&!t.tracker.ranges.has(frame.offset);if(newRange&&t.tracker.ranges.size>=MAX_ACTIVE_RANGES_PER_TRANSFER)throw new Error('File transfer has too many pending chunk ranges');accepted=t.tracker.reserve(frame)}catch(error){t.writeError=error;t.abort=true;wakeIncomingTransfer(t);throw error}if(!accepted)return false;t.frames.push(frame);t.bufferedBytes+=frame.plainBytes;t.lastActivity=Date.now();wakeIncomingTransfer(t);return true}
async function enqueueChunk(buf,session){assertFileSession(session);const frame=parseChunkFrame(buf,{maxFileSize:MAX,maxHeaderBytes:MAX_FILE_HEADER_BYTES,maxChunkBytes:MAX_FILE_CHUNK_BYTES}),seq=frame.sequence;if(isCancelledOffer(seq))return;let t=activeTransfers.get(seq);
  // A TCP acknowledgement is withheld until the decrypt/write window has
  // capacity. This closes the native socket's receive window instead of ever
  // dropping a chunk under memory pressure.
  while(t&&!t.abort&&(t.bufferedBytes+frame.plainBytes>ACTIVE_FRAME_LIMIT||activeIncomingBufferedBytes()+frame.plainBytes>ACTIVE_TOTAL_FRAME_LIMIT)){await waitForIncomingTransfer(t);t=activeTransfers.get(seq)}
  if(t&&!t.abort){if(t.session.epoch!==session.epoch||!liveFileSession(t.session))return;reserveIncomingFrame(t,frame);return}
  if(pendingFrameBytes+buf.byteLength>PENDING_FRAME_LIMIT)return;let held=pendingFrames.get(seq);if(held&&held._epoch!==session.epoch){dropPending(seq);held=null}if(!held){if(pendingFrames.size>=MAX_PENDING_TRANSFERS)return;held=[];held._epoch=session.epoch;pendingFrames.set(seq,held)}if(held.length>=MAX_PENDING_FRAMES_PER_TRANSFER)return;
  const duplicate=held.some(item=>item.frame.offset===frame.offset&&item.frame.plainBytes===frame.plainBytes);if(duplicate)return;held.push({frame,len:buf.byteLength});pendingFrameBytes+=buf.byteLength;if(held.length===1)held._timer=setTimeout(()=>dropPending(seq),PENDING_FRAME_TTL)
}
function fileSessionFromContext(context){if(!context||context.epoch!==fileSessionEpoch||context.bus!==files)return null;const session=currentFileSession();return session&&session.epoch===context.epoch&&session.bus===context.bus?session:null}
// A binary frame may pause at the bounded receive window while disk catches up.
// Control packets must remain independently responsive so Cancel, end and TCP
// negotiation cannot sit behind that backpressure.
function dispatchFileChannelFrame(event,context){if(typeof event?.data==='string'){void onFileFrame(event,false,context).catch(error=>console.warn('file control rejected',error));return}receiveQueue=receiveQueue.then(()=>onFileFrame(event,false,context)).catch(error=>console.warn('file frame rejected',error))}
function validEncryptedFileMeta(value){return !!value&&Array.isArray(value.iv)&&value.iv.length===12&&Array.isArray(value.data)&&value.data.length>0&&value.data.length<=4096&&value.iv.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255)&&value.data.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255)}
async function disposeIncomingTransfer(t){t.abort=true;wakeIncomingTransfer(t);if(t.saveMode==='pair')try{await window.pairSave.cancel(t.seq)}catch{}if(t.writer)try{await t.writer.abort()}catch{}}
function markIncomingFailure(t,error){if(!t||t.failureShown)return;t.failureShown=true;t.abort=true;wakeIncomingTransfer(t);dropPending(t.seq);const status=t.el?.querySelector('.transfer-status');if(status&&!status.classList.contains('declined')){status.textContent='Failed: '+(error?.message||error);status.classList.add('failed')}const cancel=t.el?.querySelector('.cancel-btn');if(cancel)cancel.hidden=true;closeTransferCard(t.el);void disposeIncomingTransfer(t);rememberCancelledOffer(t.seq);if(activeTransfers.get(t.seq)===t)activeTransfers.delete(t.seq);if(liveFileSession(t.session))void safeSend(JSON.stringify({t:'cancel',seq:t.seq,by:'receiver'}),t.session).catch(()=>{})}
async function finalizeIncomingTransfer(t){if(t.finalizing)return t.finalizing;t.finalizing=(async()=>{try{await t.done;if(t.abort)throw t.writeError||new Error('Transfer cancelled');if(t.saveMode==='fileAccess')await t.writer.close();else if(t.saveMode==='pair'){const committed=await window.pairSave.end(t.seq,t.size);if(committed!==true)throw new Error('Destination could not be committed')}else{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(t.parts||[],{type:t.type}));a.download=t.name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),0)}const status=t.el.querySelector('.transfer-status');status.textContent='Received';t.el.querySelector('.transfer-speed').textContent='';t.el.querySelector('.transfer-eta').textContent='';t.el.querySelector('.cancel-btn').hidden=true;setPeerPct(t.el,100);closeTransferCard(t.el);if(liveFileSession(t.session))await safeSend(JSON.stringify({t:'complete',seq:t.seq,size:t.size}),t.session)}catch(error){await disposeIncomingTransfer(t);const status=t.el?.querySelector('.transfer-status');if(status){status.textContent='Save failed: '+(error?.message||error);status.classList.add('failed')}const cancel=t.el?.querySelector('.cancel-btn');if(cancel)cancel.hidden=true;closeTransferCard(t.el);if(liveFileSession(t.session))await safeSend(JSON.stringify({t:'save-failed',seq:t.seq,reason:'The destination could not be committed'}),t.session).catch(()=>{})}finally{if(activeTransfers.get(t.seq)===t)activeTransfers.delete(t.seq)}})();return t.finalizing}
let incomingOfferTasks=0;
async function handleIncomingOffer(o,session){if(incomingOfferTasks>=MAX_INCOMING_OFFERS)return;incomingOfferTasks++;let acceptedTransfer=null;try{if(!validEncryptedFileMeta(o.v))throw new Error('Invalid encrypted file offer');const meta=JSON.parse(dec.decode(await open(o.v,session.key)));assertFileSession(session);const seq=Number(meta?.seq),size=Number(meta?.size),name=safeTransferName(meta?.name),protocol=meta?.protocol===2?2:1,transport=normalizedTransferLane(meta?.transport),type=typeof meta?.type==='string'?meta.type.slice(0,255):'',chunkSize=Number(meta?.chunkSize);if(!validTransferSequence(seq)||!Number.isSafeInteger(size)||size<0||size>MAX||typeof meta?.name!=='string'||!meta.name.length||meta.name.length>255||activeTransfers.has(seq)||acceptCards.has(seq)||activeTransfers.size+acceptCards.size>=MAX_INCOMING_OFFERS||protocol===2&&(!Number.isSafeInteger(chunkSize)||chunkSize<MIN_FILE_CHUNK_BYTES||chunkSize>MAX_FILE_CHUNK_BYTES)){await safeSend(JSON.stringify({t:'reject',seq:validTransferSequence(seq)?seq:0}),session).catch(()=>{});return}if(takeCancelledOffer(seq))return;const accepted=await showAcceptCard({...meta,name,size,type,transport},seq);assertFileSession(session);if(!accepted){dropPending(seq);await safeSend(JSON.stringify({t:'reject',seq}),session);return}if(takeCancelledOffer(seq)){dropPending(seq);return}const hasStreamingSave=!!window.pairSave||!!window.showSaveFilePicker;if(!hasStreamingSave&&size>64*1024*1024){dropPending(seq);await safeSend(JSON.stringify({t:'reject',seq}),session);return}const t={name,size,type,seq,protocol,receipt:meta.receipt===true,transport,chunkSize,session,received:0,bufferedBytes:0,el:transfer(name,size,'in',transport),startTime:performance.now(),frames:[],parts:[],tracker:new IncomingRangeTracker(size),abort:false,done:Promise.resolve(),writeError:null,saveMode:'mem',writer:null,stuck:null,endSeen:false,finalizing:null,failureShown:false,_waiters:new Set()};acceptedTransfer=t;t.writeQueue=makeWriteQueue(t);activeTransfers.set(seq,t);const cancelBtn=t.el.querySelector('.cancel-btn');cancelBtn.hidden=false;cancelBtn.onclick=()=>{if(t.abort)return;void disposeIncomingTransfer(t);rememberCancelledOffer(seq);if(activeTransfers.get(seq)===t)activeTransfers.delete(seq);cancelBtn.hidden=true;const status=t.el.querySelector('.transfer-status');status.textContent='Cancelled';status.classList.add('declined');closeTransferCard(t.el);if(liveFileSession(session))void safeSend(JSON.stringify({t:'cancel',seq,by:'receiver'}),session).catch(()=>{})};let saveErr='';if(window.pairSave){try{const result=await window.pairSave.start(seq,name,size);if(result?.ok)t.saveMode='pair';else saveErr=result?.error||'Save dialog declined'}catch(error){saveErr=error?.message||'Could not open a save destination'}}else if(window.showSaveFilePicker){try{const handle=await showSaveFilePicker({suggestedName:name});t.writer=await handle.createWritable();t.saveMode='fileAccess'}catch(error){saveErr=error?.name==='AbortError'?'Save dialog declined':error?.message||'Could not open a save destination'}}if(t.abort||takeCancelledOffer(seq)||!liveFileSession(session)){await disposeIncomingTransfer(t);if(activeTransfers.get(seq)===t)activeTransfers.delete(seq);return}if(saveErr){await disposeIncomingTransfer(t);await safeSend(JSON.stringify({t:'reject',seq}),session).catch(()=>{});const status=t.el.querySelector('.transfer-status');status.textContent=saveErr;status.classList.toggle('failed',saveErr!=='Save dialog declined');cancelBtn.hidden=true;closeTransferCard(t.el);activeTransfers.delete(seq);return}const held=pendingFrames.get(seq);if(held){if(held._epoch===session.epoch)for(const item of held)reserveIncomingFrame(t,item.frame);dropPending(seq)}t.done=processIncoming(t);t.done.catch(error=>markIncomingFailure(t,error));await safeSend(JSON.stringify({t:'accept',seq}),session)}catch(error){if(acceptedTransfer)markIncomingFailure(acceptedTransfer,error);else if(liveFileSession(session))console.warn('incoming file offer rejected',error)}finally{incomingOfferTasks--}}
// Control dispatcher never awaits a user's Save dialog or a transfer finalizer.
// This keeps Cancel and unrelated transfers responsive even when TCP chunks and
// the WebRTC end marker cross in flight.
async function onFileFrame(e,_offerInBackground=false,context=null){const session=fileSessionFromContext(context);if(!session)return;if(e.data instanceof ArrayBuffer){await enqueueChunk(new Uint8Array(e.data),session);return}if(typeof e.data!=='string'||e.data.length>MAX_FILE_CONTROL_BYTES)return;let o;try{o=JSON.parse(e.data)}catch{return}if(!o||typeof o!=='object'||Array.isArray(o)||typeof o.t!=='string')return;
  if(o.t==='file-capabilities'){if(Number.isInteger(o.v)&&o.v>=1&&o.v<=2)remoteFileProtocol=Math.max(remoteFileProtocol,o.v);return}
  if(o.t==='tcp-prepare'){if(!window.pairDirectFile||!directFileKey||typeof o.token!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(o.token))return;const token=o.token;if(tcpTokenEpochs.has(token)||tcpTokenEpochs.size>=MAX_TCP_TOKEN_EPOCHS){await safeSend(JSON.stringify({t:'tcp-unavailable',token}),session).catch(()=>{});return}const entry={epoch:session.epoch,timer:setTimeout(()=>tcpTokenEpochs.delete(token),65000)};tcpTokenEpochs.set(token,entry);try{const listening=await window.pairDirectFile.listen(tcpFilePort);assertFileSession(session);if(!listening?.ok||!validTcpPort(listening.port))throw new Error(listening?.error||'Could not listen');if(!await window.pairDirectFile.register(token,directFileKey,session.epoch))throw new Error('Could not authorize TCP connection');assertFileSession(session);await safeSend(JSON.stringify({t:'tcp-ready',token,port:listening.port}),session)}catch{clearTimeout(entry.timer);tcpTokenEpochs.delete(token);if(liveFileSession(session))await safeSend(JSON.stringify({t:'tcp-unavailable',token}),session).catch(()=>{})}return}
  if(o.t==='tcp-ready'||o.t==='tcp-unavailable'){if(typeof o.token!=='string')return;const wait=tcpLaneWait.get(o.token);if(!wait||wait.epoch!==session.epoch)return;const port=validTcpPort(o.port);o.t==='tcp-ready'&&port?wait.resolve(port):wait.reject(new Error('Friend TCP listener unavailable'));return}
  if(o.t==='start'){void handleIncomingOffer(o,session);return}
  const seq=Number(o.seq);if(!validTransferSequence(seq))return;if(o.t==='cancel'||o.t==='end'&&o.cancelled)rememberCancelledOffer(seq);
  if(o.t==='cancel'){const outgoing=sendAbort.get(seq);if(outgoing){outgoing.abort=true;outgoing.remoteCancelled=o.by==='receiver';acceptWait.get(seq)?.reject(new Error('Friend cancelled'));completionWait.get(seq)?.reject(new Error('Friend cancelled'))}acceptCards.get(seq)?.(false);dropPending(seq);const t=activeTransfers.get(seq);if(t){void disposeIncomingTransfer(t);const status=t.el?.querySelector('.transfer-status');if(status){status.textContent=o.by==='receiver'?'Friend cancelled':'Sender cancelled';status.classList.add('declined')}const cancel=t.el?.querySelector('.cancel-btn');if(cancel)cancel.hidden=true;closeTransferCard(t.el);activeTransfers.delete(seq)}return}
  if(o.t==='progress'){const percent=Number(o.p);if(!Number.isInteger(percent)||percent<0||percent>100)return;const el=outTransfers.get(seq)||activeTransfers.get(seq)?.el;if(el)setPeerPct(el,percent);return}
  if(o.t==='route'){const lane=normalizedTransferLane(o.transport);const el=outTransfers.get(seq)||activeTransfers.get(seq)?.el;if(el)setTransferRoute(el,lane);return}
  if(o.t==='reject'){acceptWait.get(seq)?.reject(new Error('rejected'));completionWait.get(seq)?.reject(new Error('rejected'));return}
  if(o.t==='accept'){acceptWait.get(seq)?.resolve();return}
  if(o.t==='complete'){const outgoing=sendAbort.get(seq),size=Number(o.size);if(outgoing&&Number.isSafeInteger(size)&&size===outgoing.expectedSize)completionWait.get(seq)?.resolve();return}
  if(o.t==='save-failed'){completionWait.get(seq)?.reject(new Error('Friend could not save the file'));return}
  if(o.t==='end'){const t=activeTransfers.get(seq);if(!t){acceptCards.get(seq)?.(false);return}if(o.cancelled||t.abort){void disposeIncomingTransfer(t);activeTransfers.delete(seq);return}t.endSeen=true;t.endAt=Date.now();wakeIncomingTransfer(t);void finalizeIncomingTransfer(t)}
}
// Decrypt concurrently, but commit by declared byte offset rather than arrival
// order. TCP and WebRTC are independent transports, so a fallback can legally
// deliver final-first or duplicate an ambiguously written TCP frame.
const WRITE_BATCH=8*1024*1024;
// Disk IPC may itself wait 30 seconds for a saturated filesystem. A 90-second
// inactivity window avoids false failures on slow disks or brief system sleep,
// while an end marker with missing bytes gets a fresh inactivity grace after
// every late chunk. A completed byte range also has a bounded wait for the
// sender's ordered end control so abandoned temporary files cannot live forever.
const STALL_TIMEOUT=90000,END_GAP_GRACE=90000,END_MARKER_GRACE=90000;
function incomingGapExpired(t,active,now=Date.now()){return !!(t.endSeen&&!t.tracker.complete&&active===0&&t.frames.length===0&&now-Math.max(t.endAt||0,t.lastActivity||0)>END_GAP_GRACE)}
async function processIncoming(t){const POOL=8;const queue=t.writeQueue;let active=0;const slot=()=>new Promise(resolve=>{if(active<POOL)resolve();else pendingSlots.push(resolve)}),pendingSlots=[];const release=()=>{active=Math.max(0,active-1);const next=pendingSlots.shift();if(next)next();wakeIncomingTransfer(t)};
  let batch=[],batchLen=0;t.lastActivity=Date.now();
  const touch=()=>{t.lastActivity=Date.now()};
  const emit=(bytes,end)=>{batch.push(bytes);batchLen+=bytes.length;t.received=end;t.bufferedBytes=Math.max(0,t.bufferedBytes-bytes.length);wakeIncomingTransfer(t);touch();const frac=t.size>0?Math.min(100,t.received/t.size*100):100,pct=Math.round(frac);t.el.querySelector('i').style.width=frac+'%';t.el.querySelector('.transfer-status').textContent=pct+'%';updateStats(t.el,t.received,t.size,t.startTime);sendPeerProgress(pct)};
  const flushBatch=async()=>{if(!batch.length)return;const all=batch;batch=[];batchLen=0;
    touch();if(t.saveMode==='fileAccess'){for(const b of all)await t.writer.write(b)}else if(t.saveMode==='pair'){for(const b of all)await window.pairSave.write(t.seq,b)}else for(const b of all)t.parts.push(b);touch()};
  const drainReady=async()=>{for(const item of t.tracker.takeContiguous()){emit(item.bytes,item.end);if(batchLen>=WRITE_BATCH||item.last)await flushBatch()}};
  let lastPeerSent=0,lastPctSent=-1;
  const sendPeerProgress=pct=>{const now=Date.now();if((pct!==lastPctSent&&now-lastPeerSent>250)||now-lastPeerSent>500){lastPctSent=pct;lastPeerSent=now;safeSend(JSON.stringify({t:'progress',seq:t.seq,p:pct}),t.session).catch(()=>{})}};
  const watchdog=setInterval(()=>{const now=Date.now(),missingAfterEnd=incomingGapExpired(t,active,now),stalled=!t.tracker.complete&&now-t.lastActivity>STALL_TIMEOUT;if(missingAfterEnd||stalled){const phase=active>0?'decrypting or writing chunks':t.received?'waiting for a missing chunk':'waiting for the first chunk';t.stuck=new Error('Transfer stalled — '+phase+'. Received '+format(t.received)+' of '+format(t.size)+'.');wakeIncomingTransfer(t)}},5000);
  try{
  while(!t.tracker.complete){
    if(t.abort){if(t.writeError)throw t.writeError;return}
    while(t.frames.length){
      if(t.stuck)throw t.stuck;
      if(t.abort){if(t.writeError)throw t.writeError;return}
      await slot();active++;touch();
      const f=t.frames.shift();
      openBytes(f.iv,f.ciphertext,t.session.key).then(bytes=>queue(async()=>{if(t.abort)return;t.tracker.resolve(f,bytes);await drainReady()})).catch(error=>{t.writeError=error||new Error('File chunk could not be decrypted');t.abort=true;wakeIncomingTransfer(t)}).finally(release);
    }
    if(t.stuck)throw t.stuck;
    if(!t.tracker.complete)await waitForIncomingTransfer(t);
  }
  while(active>0)await waitForIncomingTransfer(t);
  if(t.stuck)throw t.stuck;
  if(t.writeError)throw t.writeError;
  if(!t.tracker.complete||t.received!==t.size)throw new Error('Received bytes do not form the complete offered file');
  await flushBatch();
  const completedAt=Date.now();while(!t.endSeen){if(t.abort){if(t.writeError)throw t.writeError;return}if(Date.now()-completedAt>END_MARKER_GRACE)throw new Error('Transfer stalled — sender did not finish the completed file');await waitForIncomingTransfer(t)}
  }finally{clearInterval(watchdog)}
}
setStatus('Not connected');
function enableLocalTestControls(){if(!LOCAL_TEST_MODE)return;syncComposerAvailability(false);messageForm.querySelector('.send').disabled=false;fileInput.disabled=false;syncFileAttachmentUi();callBtn.disabled=false;screenBtn.disabled=false;statusText.textContent='Local test mode';pairHint.textContent='Test mode is on — messages stay on this device until you pair with a friend.'}
enableLocalTestControls();

async function ss(key){if(window.pairSettings){try{return await window.pairSettings.get(key)}catch{}}try{return localStorage.getItem('pair.'+key)}catch{}}
async function ssHas(key){if(window.pairSettings?.has){try{return !!await window.pairSettings.has(key)}catch{return false}}try{return localStorage.getItem('pair.'+key)!=null}catch{return false}}
async function ssSet(key,val){if(window.pairSettings){try{const ok=await window.pairSettings.set(key,val);if(ok===false)return false;return true}catch{return false}}try{if(val==null)localStorage.removeItem('pair.'+key);else localStorage.setItem('pair.'+key,val);return true}catch{return false}}
function validTcpPort(value){const port=Number(value);return Number.isInteger(port)&&port>=1024&&port<=65535?port:0}
function renderTransferSetupStatus(){const badge=$('#transferRouteBadge'),setBadge=(lane,title,detail)=>{if(!badge)return;badge.dataset.lane=lane;badge.querySelector('strong').textContent=title;badge.querySelector('small').textContent=detail};if(relayVoiceMode){if(fileRelayReady()){if(transferSetupStatus)transferSetupStatus.textContent='Direct files are paused by the voice relay. Your explicitly enabled encrypted object relay is available for files up to 64 MB.';setBadge('relay','ENCRYPTED OBJECT RELAY AVAILABLE','File bytes are encrypted locally and move directly through short-lived presigned URLs.');return}if(transferSetupStatus)transferSetupStatus.textContent='File transfer is unavailable: this call is using the low-bandwidth voice relay.';setBadge('unavailable','FILE TRANSFERS UNAVAILABLE','This call is using the voice relay, which intentionally does not carry files.');return}if(fileTransportMode==='webrtc'){if(transferSetupStatus)transferSetupStatus.textContent='WEBRTC DIRECT is selected. No TCP port-forward is needed.';setBadge('webrtc','WEBRTC DIRECT','Every transfer will use the encrypted WebRTC data channel.');return}if(directFileId){if(transferSetupStatus)transferSetupStatus.textContent='TCP DIRECT is active on port '+tcpFilePort+'.';setBadge('tcp','TCP DIRECT ACTIVE · port '+tcpFilePort,'New file transfers are using the authenticated native TCP lane.');return}if(fileBus()&&pc?.connectionState==='connected'){if(transferSetupStatus)transferSetupStatus.textContent='WEBRTC DIRECT is ready. Auto will test TCP when you send a file.';setBadge('webrtc','WEBRTC DIRECT READY','Auto will try TCP port '+tcpFilePort+' for the next transfer, then clearly label the result.');return}if(transferSetupStatus)transferSetupStatus.textContent=fileRelayReady()?'No direct connection yet. The encrypted object relay is available only as your opted-in fallback.':'No direct file connection yet. Open the chat with your friend and wait for “Connected directly.”';setBadge(fileRelayReady()?'relay':'waiting',fileRelayReady()?'ENCRYPTED OBJECT RELAY AVAILABLE':'WAITING FOR A DIRECT CONNECTION',fileRelayReady()?'Direct TCP/WebRTC will still be tried first.':'Connect to your friend to use TCP or WebRTC file transfer.')}
function saveTcpSettings(){const port=validTcpPort(tcpListenPortInput?.value);if(!port){tcpListenPortInput.value=String(tcpFilePort);return}tcpFilePort=port;fileTransportMode=['auto','webrtc','tcp'].includes(fileTransportSetting?.value)?fileTransportSetting.value:'auto';tcpAutoRetryEpoch=-1;tcpAutoRetryAt=0;if(fileTransportMode==='webrtc'&&directFileId)closeTcpLane();ssSet('tcpListenPort',String(port));ssSet('fileTransport',fileTransportMode);renderTransferSetupStatus()}
if(fileTransportSetting&&tcpListenPortInput){fileTransportSetting.onchange=saveTcpSettings;tcpListenPortInput.onchange=saveTcpSettings}
$('#checkTransferSetup')?.addEventListener('click',renderTransferSetupStatus);
let screenCursor='always',screenContentHint='motion',screenBitrateMbps=20,screenBitrateExplicit=false,screenCodec='auto',shareResolution='source',shareFrameRate=60,screenAudioOn=true,networkCapacity=null,networkLiveUploadMbps=NaN,hardwareScreenCodec='',remoteVoicePlayoutStop=null;
function abortScreenSharePicker(){screenSharePickerEpoch++;const cancel=screenSharePickerCancel;screenSharePickerCancel=null;if(cancel)cancel();discardPrimedScreenAudioContext();try{window.pairEnv?.setPendingSource?.(null)}catch{}}
function shareSourceType(source){if(source?.type==='screen'||String(source?.id||'').startsWith('screen:'))return'screen';return'application'}
function excludedScreenSource(source){return /\bnvidia\s+broadcast\b/i.test(String(source?.name||''))}
function openScreenSharePicker({sources=[],qualityOnly=false}={}){
  const dialog=$('#screenShareDialog');if(!dialog||dialog.open)return Promise.resolve(null);
  const form=$('#screenShareForm'),title=$('#screenShareDialogTitle'),description=$('#screenShareDialogDescription'),sourceStep=$('#screenShareSourceStep'),qualityStep=$('#screenShareQualityStep'),sourceGrid=$('#screenShareSourceGrid'),sourceEmpty=$('#screenShareSourceEmpty'),continueButton=$('#screenShareContinue'),goLiveButton=$('#screenShareGoLive'),backButton=$('#screenShareBack'),cancelButton=$('#screenShareCancel'),closeButton=$('#screenShareClose'),previewImage=$('#screenSharePreviewImage'),portalPreview=$('#screenSharePortalPreview'),previewName=$('#screenSharePreviewName'),audioInput=$('#screenShareAudio'),capacityHint=$('#screenShareCapacityHint'),tabs=[...dialog.querySelectorAll('[data-source-tab]')],resolutionButtons=[...dialog.querySelectorAll('[data-share-resolution]')],fpsButtons=[...dialog.querySelectorAll('[data-share-fps]')],contentButtons=[...dialog.querySelectorAll('[data-share-content]')],opener=document.activeElement;
  const available=(Array.isArray(sources)?sources:[]).filter(source=>!excludedScreenSource(source)).map(source=>({...source,type:shareSourceType(source)})),draft={source:null,resolution:['source','720','1080','1440','2160'].includes(shareResolution)?shareResolution:'source',fps:shareFrameRate===30?30:60,contentHint:screenContentHint==='detail'?'detail':'motion',audio:!!screenAudioOn},counts={application:available.filter(source=>source.type==='application').length,screen:available.filter(source=>source.type==='screen').length};
  let activeType=counts.application?'application':'screen',settled=false;
  const paintChoices=()=>{for(const button of resolutionButtons){const selected=button.dataset.shareResolution===draft.resolution;button.type='button';button.setAttribute('role','radio');button.setAttribute('aria-checked',String(selected));button.classList.toggle('selected',selected)}for(const button of fpsButtons){const selected=Number(button.dataset.shareFps)===draft.fps;button.type='button';button.setAttribute('role','radio');button.setAttribute('aria-checked',String(selected));button.classList.toggle('selected',selected)}for(const button of contentButtons){const selected=button.dataset.shareContent===draft.contentHint;button.type='button';button.setAttribute('role','radio');button.setAttribute('aria-checked',String(selected));button.classList.toggle('selected',selected)}audioInput.checked=draft.audio;if(capacityHint){const upload=probedUploadMbps(),viewer=currentViewerReceiveCapMbps(),budget=Math.min(effectiveScreenBitrateCeiling(),Number.isFinite(viewer)?viewer:Infinity),uploadLabel=upload>=100?upload.toFixed(0):upload.toFixed(1),budgetLabel=Number.isFinite(budget)?(budget>=100?budget.toFixed(0):budget.toFixed(1)):'',viewerLabel=Number.isFinite(viewer)?(viewer>=100?viewer.toFixed(0):viewer.toFixed(1)):'';if(Number.isFinite(upload)&&upload>0){capacityHint.hidden=false;capacityHint.textContent=Number.isFinite(viewer)&&viewer<effectiveScreenBitrateCeiling()?'Your friend can take about '+viewerLabel+' Mbps right now, so this share will stay at or under '+budgetLabel+' Mbps.':'Your upload is about '+uploadLabel+' Mbps. This share will stay at or under '+budgetLabel+' Mbps so the encoder, voice, and the path to your friend stay clear.';const fourK=resolutionButtons.find(button=>button.dataset.shareResolution==='2160');if(fourK)fourK.title=budget<12?'4K stays available, but this path is below a smooth 4K budget.':'4K on the measured path'}else capacityHint.hidden=true}};
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
    for(const button of contentButtons)button.onclick=()=>{draft.contentHint=button.dataset.shareContent==='detail'?'detail':'motion';paintChoices()};
    audioInput.onchange=()=>{draft.audio=audioInput.checked};
    closeButton.onclick=cancelButton.onclick=()=>finish(null);backButton.onclick=showSources;
    form.onsubmit=event=>{event.preventDefault();if(!sourceStep.hidden){if(draft.source)showQuality();return}finish({sourceId:draft.source?.id||null,sourceType:draft.source?.type||null,sourceName:draft.source?.name||'System screen picker',sourceDisplayId:String(draft.source?.display_id||draft.source?.displayId||''),resolution:draft.resolution,fps:draft.fps,contentHint:draft.contentHint,audio:draft.audio})};
    dialog.oncancel=event=>{event.preventDefault();finish(null)};
    paintChoices();if(qualityOnly)showQuality();else showSources();dialog.showModal();
  })
}
function commitScreenShareChoice(choice){if(!choice)return;shareResolution=['source','720','1080','1440','2160'].includes(choice.resolution)?choice.resolution:'source';shareFrameRate=Number(choice.fps)===30?30:60;if(choice.contentHint==='detail'||choice.contentHint==='motion'){screenContentHint=choice.contentHint;ssSet('screenContentHint',screenContentHint);const hint=$('#screenContentHintSetting');if(hint)hint.value=screenContentHint}screenAudioOn=!!choice.audio;syncScreenAudioToggle();ssSet('shareResolution',shareResolution);ssSet('shareResolutionExplicit','yes');ssSet('shareFrameRate',String(shareFrameRate));ssSet('shareSystemAudio',screenAudioOn?'on':'off')}
async function chooseScreenShare(options={}){const epoch=screenSharePickerEpoch;await screenShareSettingsReady;if(epoch!==screenSharePickerEpoch)return null;const supplied=Array.isArray(options.sources),qualityOnly=typeof options.qualityOnly==='boolean'?options.qualityOnly:(!window.pairEnv?.getSources||!!window.pairEnv.useSystemPicker);let sources=supplied?options.sources:[];if(!qualityOnly&&!supplied){sources=await window.pairEnv.getSources();if(epoch!==screenSharePickerEpoch)return null;if(!sources.length)throw new Error('No screen or window was selected')}const choice=await openScreenSharePicker({sources,qualityOnly});if(epoch!==screenSharePickerEpoch||!choice){try{window.pairEnv?.setPendingSource?.(null)}catch{}return null}commitScreenShareChoice(choice);if(choice.sourceId&&window.pairEnv?.setPendingSource){const selected=await window.pairEnv.setPendingSource({id:choice.sourceId,type:choice.sourceType,displayId:choice.sourceDisplayId});if(epoch!==screenSharePickerEpoch){try{window.pairEnv?.setPendingSource?.(null)}catch{}return null}if(selected===false)throw new Error('The selected screen or window is no longer available')}return epoch===screenSharePickerEpoch?choice:null}
function openSettingsTab(name){document.querySelectorAll('.settings-tab').forEach(tab=>{const active=tab.dataset.settingsTab===name;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1});document.querySelectorAll('.settings-page').forEach(page=>{const active=page.dataset.settingsPage===name;page.classList.toggle('active',active);page.hidden=!active})}
function addScreenShareSettings(){
  const tab=document.createElement('button');tab.type='button';tab.className='settings-tab';tab.dataset.settingsTab='screen';tab.setAttribute('role','tab');tab.setAttribute('aria-selected','false');tab.textContent='Screen sharing';
  const page=document.createElement('section');page.className='settings-section settings-page';page.dataset.settingsPage='screen';page.setAttribute('role','tabpanel');page.hidden=true;
  const maxSlider=sliderBitrateMaxMbps();
  page.innerHTML='<div><h3>Screen sharing</h3><p>Your source resolution and frame-rate choice stay fixed. Motion mode may temporarily reduce encoded resolution under real network pressure to preserve smooth cadence; Detail mode preserves pixels instead.</p></div><label class="settings-field"><span>Video codec</span><select id="screenCodecSetting"><option value="auto">Automatic — hardware-friendly</option><option value="H264">H.264 — widest support</option><option value="AV1">AV1 — best compression</option><option value="VP9">VP9</option><option value="VP8">VP8</option></select></label><label class="settings-field"><span>Maximum video bitrate <output id="screenBitrateValue">20 Mbps</output></span><input id="screenBitrateSetting" type="range" min="2" max="'+maxSlider+'" value="20" step="1" /></label><label class="settings-field"><span>Content optimization</span><select id="screenContentHintSetting"><option value="motion">Motion — preserve smooth games/video</option><option value="detail">Detail — preserve text resolution</option></select></label><label class="settings-field"><span>Cursor</span><select id="screenCursorSetting"><option value="always">Always show</option><option value="motion">Show while moving</option><option value="never">Hide cursor</option></select></label><p class="settings-hint">Native AV1 uses the discrete NVIDIA or AMD encoder, syncs capture to content, keeps lookahead off, targets about 110 ms, and discards stale work by 180 ms. A launch speed probe raises the budget toward the GPU encoder’s useful ceiling (about 250 Mbps at 4K60 on NVIDIA) when your upload can carry it; software encode stays on the conservative curve. A sustained decoder failure switches only that viewer to a capped compatibility codec.</p><div class="settings-inline-actions"><button id="testScreenAudio" type="button">Test isolated computer audio</button></div><p id="screenAudioTestStatus" class="settings-hint" aria-live="polite">Checks the same isolated audio route used by a real share.</p>';
  document.querySelector('.settings-tabs').append(tab);document.querySelector('.settings-pages').append(page);tab.onclick=()=>openSettingsTab('screen');
  const bitrate=$('#screenBitrateSetting'),bitrateValue=$('#screenBitrateValue'),codec=$('#screenCodecSetting'),contentHint=$('#screenContentHintSetting'),cursor=$('#screenCursorSetting');
  const updateBitrate=()=>{const max=sliderBitrateMaxMbps();screenBitrateMbps=Math.max(2,Math.min(max,Number(bitrate.value)||20));bitrateValue.textContent=screenBitrateMbps+' Mbps';bitrate.style.setProperty('--range-fill',((screenBitrateMbps-2)/Math.max(1,max-2)*100)+'%');ssSet('screenBitrate',String(screenBitrateMbps))};
  bitrate.oninput=()=>{screenBitrateExplicit=true;ssSet('screenBitrateExplicit','yes');updateBitrate()};enableRangeDrag(bitrate);codec.onchange=()=>{screenCodec=['auto','H264','AV1','VP9','VP8'].includes(codec.value)?codec.value:'auto';ssSet('screenCodec',screenCodec)};contentHint.onchange=()=>{screenContentHint=contentHint.value==='detail'?'detail':'motion';ssSet('screenContentHint',screenContentHint)};cursor.onchange=()=>{screenCursor=['always','motion','never'].includes(cursor.value)?cursor.value:'always';ssSet('screenCursor',screenCursor)};$('#testScreenAudio').onclick=()=>testScreenAudioIsolation($('#testScreenAudio'),$('#screenAudioTestStatus'));
  return async()=>{
    const [savedBitrateValue,bitrateExplicit]=await Promise.all([ss('screenBitrate'),ss('screenBitrateExplicit')]),savedBitrate=Number(savedBitrateValue),legacyDefault=bitrateExplicit!=='yes'&&savedBitrate===12;screenBitrateExplicit=bitrateExplicit==='yes';screenBitrateMbps=savedBitrateValue!==null&&savedBitrateValue!==''&&Number.isFinite(savedBitrate)&&!legacyDefault?Math.max(2,Math.min(sliderBitrateMaxMbps(),savedBitrate)):20;bitrate.value=String(screenBitrateMbps);updateBitrate();
    const savedCodec=await ss('screenCodec');screenCodec=['auto','H264','AV1','VP9','VP8'].includes(savedCodec)?savedCodec:'auto';codec.value=screenCodec;
    const savedHint=await ss('screenContentHint');screenContentHint=savedHint==='detail'?'detail':'motion';contentHint.value=screenContentHint;
    const savedCursor=await ss('screenCursor');screenCursor=['always','motion','never'].includes(savedCursor)?savedCursor:'always';cursor.value=screenCursor;
    const [savedResolution,explicitResolution]=await Promise.all([ss('shareResolution'),ss('shareResolutionExplicit')]);shareResolution=explicitResolution==='yes'&&['source','720','1080','1440','2160'].includes(savedResolution)?savedResolution:'source';
    const savedFps=Number(await ss('shareFrameRate'));shareFrameRate=savedFps===30?30:60;
    const savedAudio=await ss('shareSystemAudio');screenAudioOn=savedAudio==null?true:savedAudio==='on';
  };
}
const restoreScreenShareSettings=addScreenShareSettings();
const settingsTabs=[...document.querySelectorAll('.settings-tab')];
settingsTabs.forEach((tab,index)=>{const name=tab.dataset.settingsTab,page=document.querySelector('.settings-page[data-settings-page="'+name+'"]'),tabId='settings-tab-'+name,pageId='settings-page-'+name;tab.id=tabId;tab.setAttribute('aria-controls',pageId);tab.tabIndex=tab.classList.contains('active')?0:-1;if(page){page.id=pageId;page.setAttribute('aria-labelledby',tabId)}tab.onclick=()=>openSettingsTab(name);tab.onkeydown=event=>{let next=index;if(event.key==='ArrowDown'||event.key==='ArrowRight')next=(index+1)%settingsTabs.length;else if(event.key==='ArrowUp'||event.key==='ArrowLeft')next=(index-1+settingsTabs.length)%settingsTabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=settingsTabs.length-1;else return;event.preventDefault();const target=settingsTabs[next];openSettingsTab(target.dataset.settingsTab);target.focus()}});
let emojiCacheStatsLoaded=false;
async function renderLocalMetricsSummary(){
  const output=$('#localMetricsSummary');if(!output)return;output.textContent='Reading local samples…';
  const summary=await window.pairMetrics?.summary?.(24).catch(()=>null);if(!summary?.samples){output.textContent='No samples yet. Use Knot normally, then refresh this summary.';return}
  const labels={'app.main_ready_ms':'Main ready','app.renderer_ready_ms':'Renderer ready','renderer.long_task_ms':'UI long task','history.read_ms':'History read','history.append_ms':'History append','history.render_ms':'History render','directory.snapshot_bytes':'Directory snapshot','directory.delta_bytes':'Directory delta','screen.rtt_ms':'Screen RTT','screen.encode_ms':'Screen encode','screen.sent_fps':'Screen FPS','file.throughput_mbps':'File throughput'};
  const lines=['Last 24 hours · '+summary.samples+' local numeric samples'];for(const [name,metric] of Object.entries(summary.metrics||{})){const unit=name.endsWith('_bytes')?' bytes':name.endsWith('_mbps')?' Mbps':name.endsWith('_fps')?' fps':' ms';lines.push((labels[name]||name)+': p95 '+Number(metric.p95||0).toFixed(name.endsWith('_bytes')?0:1)+unit+' · '+metric.count+' samples')};output.textContent=lines.join('\n');
}
$('#refreshLocalMetrics')?.addEventListener('click',renderLocalMetricsSummary);
const originalOpenSettingsTab=openSettingsTab;
openSettingsTab=function(name){
  originalOpenSettingsTab(name);
  if(name==='emojis'&&!emojiCacheStatsLoaded){
    emojiCacheStatsLoaded=true;
    (async()=>{
      const statsEl=$('#emojiCatalogStats');if(!statsEl)return;
      if(!window.pairEmojiCatalog){statsEl.textContent='Emoji.gg API integration is unavailable in this build.';return}
      const details=await window.pairEmojiCatalog.stats().catch(()=>null);
      if(!details?.total){statsEl.textContent='Emoji.gg is currently unavailable. The built-in Unicode picker still works offline.';return}
      const cacheMb=(Number(details.cacheBytes||0)/1024/1024).toFixed(1),updated=details.updatedAt?new Date(details.updatedAt).toLocaleString():'not yet';
      statsEl.textContent=details.total.toLocaleString()+' API entries indexed locally · '+details.cacheFiles+' viewed images cached ('+cacheMb+' MB of 64 MB) · refreshed '+updated+'.';
    })();
  }
  if(name==='advanced')void renderLocalMetricsSummary();
};
const screenShareSettingsReady=restoreScreenShareSettings();
void screenShareSettingsReady.then(()=>{startNetworkCapacityProbe();probeHardwareScreenCodec()});
function makeDeviceOption(value,label){const option=document.createElement('option');option.value=value;option.textContent=label;return option}
async function refreshAudioDevices(){try{const devices=await navigator.mediaDevices.enumerateDevices();const inputs=devices.filter(device=>device.kind==='audioinput'),outputs=devices.filter(device=>device.kind==='audiooutput');inputDevice.replaceChildren(makeDeviceOption('default','System default'));outputDevice.replaceChildren(makeDeviceOption('default','System default'));inputs.forEach((device,index)=>inputDevice.append(makeDeviceOption(device.deviceId,device.label||'Microphone '+(index+1))));outputs.forEach((device,index)=>outputDevice.append(makeDeviceOption(device.deviceId,device.label||'Speaker '+(index+1))));inputDevice.value=[...inputDevice.options].some(option=>option.value===inputDeviceId)?inputDeviceId:'default';outputDevice.value=[...outputDevice.options].some(option=>option.value===outputDeviceId)?outputDeviceId:'default';deviceHint.textContent=(inputs.length||outputs.length)?'Device list updated.':'Connect or allow a microphone to reveal device names.'}catch{deviceHint.textContent='Knot could not read audio devices yet.'}}
function deepFilterBackendAvailable(){return !!(window.pairDeepFilter&&typeof window.pairDeepFilter.getAsset==='function'&&typeof AudioWorkletNode!=='undefined'&&(window.AudioContext||window.webkitAudioContext))}
function renderNoiseProcessingUI(){
  if(!noiseReduction||!noiseHardware||!noiseProcessingHint)return;
  noiseReduction.value=noiseReductionMode;
  if(noiseReductionMode==='rnnoise'){
    noiseHardware.value='cpu';noiseHardware.disabled=true;
    noiseProcessingHint.textContent='RNNoise runs locally on the CPU for stable low-latency calls. Your audio never leaves Knot before WebRTC encryption.';
  }else if(noiseReductionMode==='deepfilter'){
    noiseHardware.value=noiseHardwareMode==='gpu'?'auto':noiseHardwareMode;noiseHardware.disabled=!deepFilterBackendAvailable();
    noiseProcessingHint.textContent=deepFilterBackendAvailable()?'DeepFilterNet3 runs entirely on this device in CPU/WASM. The bundled model is loaded locally; no microphone audio or model request is sent to a service. GPU is not available in this backend.':'DeepFilterNet3 is unavailable in this build. Choose RNNoise or raw microphone.';
  }else{
    noiseHardware.value='auto';noiseHardware.disabled=true;
    noiseProcessingHint.textContent='Raw microphone mode sends no Knot noise filter. Echo cancellation remains available separately.';
  }
}
renderNoiseProcessingUI();
// Give the real-time filter a 30 ms scheduling budget. This keeps the full
// 48 kHz DeepFilterNet3 model intact while preventing short UI/typing bursts
// from starving the audio worklet. The browser may choose a lower value.
function microphoneConstraints({echoCancellation=voiceProcessingEnabled}={}){const knotNoiseFilter=noiseReductionMode==='rnnoise'||noiseReductionMode==='deepfilter'&&deepFilterBackendAvailable(),audio={sampleRate:{ideal:48000},sampleSize:{ideal:32},channelCount:{ideal:1},latency:{ideal:.03},echoCancellation,noiseSuppression:!knotNoiseFilter&&noiseReductionMode==='deepfilter',autoGainControl:false,voiceIsolation:false,googEchoCancellation:echoCancellation,googAutoGainControl:false,googNoiseSuppression:!knotNoiseFilter&&noiseReductionMode==='deepfilter',googHighpassFilter:false,googTypingNoiseDetection:false,googAudioMirroring:false};if(inputDeviceId&&inputDeviceId!=='default')audio.deviceId={exact:inputDeviceId};return {audio,video:false}}
function voiceInputTracks(){return localMicrophoneStream?.getAudioTracks?.().length?localMicrophoneStream.getAudioTracks():localStream?.getAudioTracks?.()||[]}
function stopVoiceNoisePipeline(pipeline=voiceNoisePipeline){
  if(pipeline===voiceNoisePipeline)voiceNoisePipeline=null;
  if(!pipeline)return;
  try{pipeline.node?.update(false)}catch{}try{pipeline.source?.disconnect()}catch{}try{pipeline.node?.disconnect()}catch{}try{pipeline.destination?.disconnect()}catch{}try{pipeline.processor?.destroy()}catch{}for(const url of pipeline.urls||[])try{URL.revokeObjectURL(url)}catch{}try{pipeline.context?.close()}catch{}
}
async function rnnoiseLibrary(){
  if(!rnnoiseModulePromise){const root=new URL('./node_modules/simple-rnnoise-wasm/dist/',location.href);rnnoiseModulePromise=import(new URL('rnnoise.mjs',root).href).then(module=>({module,root})).catch(error=>{rnnoiseModulePromise=null;throw error})}
  return rnnoiseModulePromise;
}
async function deepFilterLibrary(){
  if(!deepFilterModulePromise)deepFilterModulePromise=import('./node_modules/deepfilternet3-noise-filter/dist/index.esm.js').catch(error=>{deepFilterModulePromise=null;throw error});
  return deepFilterModulePromise;
}
function deepFilterBytes(value,name){
  if(value instanceof ArrayBuffer)return value;
  if(ArrayBuffer.isView(value))return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);
  throw new Error('The bundled DeepFilterNet '+name+' asset was unavailable');
}
async function createDeepFilterMicrophone(rawStream){
  if(!deepFilterBackendAvailable())throw new Error('DeepFilterNet3 is not available in this build');
    const context=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000,latencyHint:0.03});let urls=[];
  try{
    await context.resume();const [wasmAsset,modelAsset]=await Promise.all([window.pairDeepFilter.getAsset('wasm'),window.pairDeepFilter.getAsset('model')]);
    const wasmBytes=deepFilterBytes(wasmAsset,'WASM'),modelBytes=deepFilterBytes(modelAsset,'model');
    urls=[URL.createObjectURL(new Blob([wasmBytes],{type:'application/wasm'})),URL.createObjectURL(new Blob([modelBytes],{type:'application/gzip'}))];
    const {DeepFilterNet3Core}=await deepFilterLibrary(),processor=new DeepFilterNet3Core({sampleRate:48000,noiseReductionLevel:80});
    processor.assetLoader.getAssetUrls=()=>({wasm:urls[0],model:urls[1]});await processor.initialize();
    const source=context.createMediaStreamSource(rawStream),node=await processor.createAudioWorkletNode(context),destination=context.createMediaStreamDestination();source.connect(node).connect(destination);
    const track=destination.stream.getAudioTracks()[0];if(!track)throw new Error('DeepFilterNet3 did not create a microphone track');
    return {context,source,node,destination,processor,urls,stream:new MediaStream([track])};
  }catch(error){for(const url of urls)try{URL.revokeObjectURL(url)}catch{}try{await context.close()}catch{}throw error}
}
async function createRnnoiseMicrophone(rawStream){
  if(typeof AudioWorkletNode==='undefined'||!(window.AudioContext||window.webkitAudioContext))throw new Error('AudioWorklet is not available in this build');
  const context=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000,latencyHint:0.03});
  try{
    await context.resume();const {module,root}=await rnnoiseLibrary(),assets=module.rnnoise_loadAssets({scriptSrc:new URL('rnnoise.worklet.js',root).href,moduleSrc:new URL('rnnoise.wasm',root).href});
    await module.RNNoiseNode.register(context,assets);
    const source=context.createMediaStreamSource(rawStream),node=new module.RNNoiseNode(context),destination=context.createMediaStreamDestination();source.connect(node).connect(destination);
    const track=destination.stream.getAudioTracks()[0];if(!track)throw new Error('RNNoise did not create a microphone track');
    return {context,source,node,destination,stream:new MediaStream([track])};
  }catch(error){try{await context.close()}catch{}throw error}
}
async function acquireCallMicrophone(){
  const raw=await navigator.mediaDevices.getUserMedia(microphoneConstraints());localMicrophoneStream=raw;activeNoiseProcessor=noiseReductionMode==='off'?'raw':noiseReductionMode==='deepfilter'?'browser':'raw';
  if(noiseReductionMode==='off')return raw;
  try{const pipeline=noiseReductionMode==='deepfilter'?await createDeepFilterMicrophone(raw):await createRnnoiseMicrophone(raw);voiceNoisePipeline=pipeline;activeNoiseProcessor=noiseReductionMode;return pipeline.stream}catch(error){const name=noiseReductionMode==='deepfilter'?'DeepFilterNet3':'RNNoise';deviceHint.textContent=name+' could not start, so Knot is using your raw microphone for this call.';console.warn(name+' microphone filter unavailable:',error);return raw}
}
function releaseCallMicrophone(){
  const streams=[localStream,localMicrophoneStream];localStream=null;localMicrophoneStream=null;
  for(const stream of new Set(streams.filter(Boolean)))try{stream.getTracks().forEach(track=>track.stop())}catch{}
  stopVoiceNoisePipeline();activeNoiseProcessor='raw';
}
function suspendDirectCallForPeerReplacement(){
  callGen++;stopCallTone();if(callActive)publishCallState(false);stopSpeakingMonitor('dm-self');
  if(callTimerId){clearInterval(callTimerId);callTimerId=null}callTimerEl.textContent='';
  releaseCallMicrophone();callActive=false;micMuted=false;setParticipant(participantYou,false);syncVoiceStage();setRemoteCallAudio(false);
  renderCallButtonState('start','Start call','Start voice call');callBtn.disabled=true;muteBtn.hidden=true;volumeSlider.hidden=true;volumeValue.hidden=true;callStatus.textContent='Reconnecting voice…';callStatus.className='call-status ringing';renderDmVoiceUI();
}
function screenShareOutputElements(){const elements=[remoteScreen,nativeRemoteAudio];for(const state of serverPeers.values())elements.push(state.screen,state.screenAudio);return[...new Set(elements.filter(Boolean))]}
function mediaOutputElements(){const elements=[remoteAudio,...screenShareOutputElements()];for(const state of serverPeers.values())elements.push(...(state.audios||[]));return[...new Set(elements.filter(Boolean))]}
async function applyMediaElementOutput(element,sinkId=outputDeviceId||'default'){if(!element||typeof element.setSinkId!=='function')return false;await element.setSinkId(sinkId);return true}
async function applyOutputDevice(){const sinkId=outputDeviceId||'default',tasks=[];if(audioCtx&&typeof audioCtx.setSinkId==='function')tasks.push(audioCtx.setSinkId(sinkId));for(const element of mediaOutputElements())if(typeof element.setSinkId==='function')tasks.push(element.setSinkId(sinkId));if(!tasks.length){deviceHint.textContent='Speaker selection is not supported on this system.';return}const results=await Promise.allSettled(tasks),failed=results.filter(result=>result.status==='rejected').length;if(failed===results.length)deviceHint.textContent='Could not use that speaker. Try the system default.';else if(failed)deviceHint.textContent='Speaker selection applied to available audio routes.';else deviceHint.textContent='Speaker selection applied.'}
function stopMicrophoneTest(){try{micTestSource?.disconnect()}catch{}try{micTestGain?.disconnect()}catch{}const streams=[micTestStream,micTestRawStream];micTestStream=null;micTestRawStream=null;for(const stream of new Set(streams.filter(Boolean)))try{stream.getTracks().forEach(track=>track.stop())}catch{}stopVoiceNoisePipeline(micTestNoisePipeline);micTestNoisePipeline=null;micTestSource=micTestGain=null;testMicrophone.textContent='Test microphone'}
async function toggleMicrophoneTest(){if(micTestStream){stopMicrophoneTest();deviceHint.textContent='Microphone test stopped.';return}if(localStream||serverVoiceStream){deviceHint.textContent='Leave voice before testing the microphone.';return}try{const ctx=sfxCtx();if(!ctx)throw new Error('Audio output unavailable');await ctx.resume();const raw=await navigator.mediaDevices.getUserMedia(microphoneConstraints({echoCancellation:false}));micTestRawStream=raw;micTestStream=raw;let mode='Raw microphone';if(noiseReductionMode!=='off')try{const pipeline=noiseReductionMode==='deepfilter'?await createDeepFilterMicrophone(raw):await createRnnoiseMicrophone(raw);micTestNoisePipeline=pipeline;micTestStream=pipeline.stream;mode=noiseReductionMode==='deepfilter'?'DeepFilterNet3':'RNNoise'}catch(error){const name=noiseReductionMode==='deepfilter'?'DeepFilterNet3':'RNNoise';console.warn(name+' microphone test filter unavailable:',error);deviceHint.textContent=name+' could not start for the test, so you are hearing the raw microphone.'}micTestSource=ctx.createMediaStreamSource(micTestStream);micTestGain=ctx.createGain();micTestGain.gain.value=1;micTestSource.connect(micTestGain).connect(ctx.destination);testMicrophone.textContent='Stop microphone test';if(!deviceHint.textContent.includes('could not start'))deviceHint.textContent=mode+' monitor live. This is the same noise-reduction mode used in calls; use headphones to avoid feedback.';await refreshAudioDevices()}catch{stopMicrophoneTest();deviceHint.textContent='Could not start the microphone test. Check the selected device and permission.'}}
function formatPushToTalkKey(code){return ({Space:'Space',Escape:'Esc',ControlLeft:'Left Ctrl',ControlRight:'Right Ctrl',AltLeft:'Left Alt',AltRight:'Right Alt',ShiftLeft:'Left Shift',ShiftRight:'Right Shift',MetaLeft:'Left Super',MetaRight:'Right Super'})[code]||code.replace(/^Key/,'').replace(/^Digit/,'')}
function updatePushToTalkUI(){const enabled=voiceInputModeValue==='ptt';pushToTalkSettings.hidden=!enabled;voiceInputMode.value=voiceInputModeValue;pushToTalkKeyButton.textContent=pushToTalkCapturing?'Press a key…':formatPushToTalkKey(pushToTalkKey);pushToTalkDelayInput.value=String(pushToTalkDelay);pushToTalkDelayValue.textContent=pushToTalkDelay+' ms'}
function applyMicTransmission(){if(!localStream)return;const open=!micMuted&&(voiceInputModeValue!=='ptt'||pushToTalkHeld);voiceInputTracks().forEach(track=>track.enabled=open);if(callActive&&voiceInputModeValue==='ptt'&&!micMuted){muteBtn.textContent=pushToTalkHeld?'Talking…':'Hold '+formatPushToTalkKey(pushToTalkKey);muteBtn.title='Push to talk is enabled in Settings'}}
function releasePushToTalk(){pushToTalkReleaseTimer=null;pushToTalkHeld=false;applyMicTransmission()}
voiceInputMode.onchange=()=>{voiceInputModeValue=voiceInputMode.value==='ptt'?'ptt':'voice';ssSet('voiceInputMode',voiceInputModeValue);if(voiceInputModeValue!=='ptt'){pushToTalkHeld=false;if(pushToTalkReleaseTimer){clearTimeout(pushToTalkReleaseTimer);pushToTalkReleaseTimer=null}}updatePushToTalkUI();applyMicTransmission()};pushToTalkKeyButton.onclick=()=>{pushToTalkCapturing=true;updatePushToTalkUI();deviceHint.textContent='Press the key you want to hold for push to talk.'};pushToTalkDelayInput.oninput=()=>{pushToTalkDelay=Math.max(0,Math.min(1000,Number(pushToTalkDelayInput.value)||0));ssSet('pushToTalkDelay',String(pushToTalkDelay));updatePushToTalkUI()};
window.addEventListener('keydown',event=>{if(pushToTalkCapturing){if(event.code==='Escape'){pushToTalkCapturing=false;updatePushToTalkUI();return}event.preventDefault();pushToTalkKey=event.code;pushToTalkCapturing=false;ssSet('pushToTalkKey',pushToTalkKey);updatePushToTalkUI();return}if(voiceInputModeValue!=='ptt'||event.code!==pushToTalkKey||event.repeat)return;if(/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||''))return;event.preventDefault();if(pushToTalkReleaseTimer){clearTimeout(pushToTalkReleaseTimer);pushToTalkReleaseTimer=null}pushToTalkHeld=true;applyMicTransmission()});window.addEventListener('keyup',event=>{if(voiceInputModeValue!=='ptt'||event.code!==pushToTalkKey)return;event.preventDefault();if(pushToTalkReleaseTimer)clearTimeout(pushToTalkReleaseTimer);pushToTalkReleaseTimer=setTimeout(releasePushToTalk,pushToTalkDelay)});window.addEventListener('blur',()=>{if(pushToTalkReleaseTimer){clearTimeout(pushToTalkReleaseTimer);pushToTalkReleaseTimer=null}pushToTalkHeld=false;applyMicTransmission()});
inputDevice.onchange=()=>{inputDeviceId=inputDevice.value;ssSet('inputDevice',inputDeviceId);if(micTestStream)stopMicrophoneTest()};outputDevice.onchange=()=>{outputDeviceId=outputDevice.value;ssSet('outputDevice',outputDeviceId);applyOutputDevice()};voiceProcessing.onchange=()=>{voiceProcessingEnabled=voiceProcessing.checked;ssSet('voiceProcessing',voiceProcessingEnabled?'on':'off');if(micTestStream)stopMicrophoneTest();deviceHint.textContent=voiceProcessingEnabled?'Echo cancellation enabled.':'Echo cancellation disabled.'};noiseReduction.onchange=()=>{noiseReductionMode=['rnnoise','deepfilter','off'].includes(noiseReduction.value)?noiseReduction.value:'rnnoise';ssSet('noiseReduction',noiseReductionMode);if(micTestStream)stopMicrophoneTest();renderNoiseProcessingUI();deviceHint.textContent=localStream||serverVoiceStream?'Noise-reduction changes apply to your next call.':micTestStream?'Restart the microphone test to hear the new setting.':'Noise-reduction preference saved.'};noiseHardware.onchange=()=>{noiseHardwareMode=['auto','cpu','gpu'].includes(noiseHardware.value)?noiseHardware.value:'auto';ssSet('noiseHardware',noiseHardwareMode);renderNoiseProcessingUI();deviceHint.textContent='Processing hardware preference saved for DeepFilterNet.'};$('#refreshDevices').onclick=()=>refreshAudioDevices();$('#testSound').onclick=()=>playSound('ring');testMicrophone.onclick=()=>toggleMicrophoneTest();navigator.mediaDevices?.addEventListener?.('devicechange',refreshAudioDevices);
const THEME_CONCEPTS=[
  ['bento','Bento','Modular cards','Modular card-based workspace'],
  ['brutalist','Brutalist','Loud & direct','Raw high-contrast interface'],
  ['cozy','Cozy','Soft & spacious','Soft spacious comfort theme'],
  ['cyberdeck','Cyberdeck','Angular sci-fi','Angular sci-fi control deck'],
  ['minimal','Minimal','Quiet & clean','Quiet distraction-free light theme'],
  ['retro','Retro','Classic desktop','Classic desktop window theme'],
  ['comic','Comic','Ink & bubbles','Ink and speech-bubble theme'],
  ['library','Library','Literary dark','Dark literary reading room'],
  ['studio','Studio','Horizontal dock','Creative studio with a top dock'],
  ['noir','Noir','Cinematic mono','Monochrome cinematic theme'],
  ['onyx','Onyx','Modern black','Crisp black and cobalt'],
  ['graphite','Graphite','Dense charcoal','Quiet dense workspace'],
  ['cobalt','Cobalt','Navy modern','Clean deep-blue workspace'],
  ['crimson','Crimson','Deep red','Bold wine-red control room'],
  ['evergreen','Evergreen','Deep green','Calm green ledger'],
  ['amethyst','Amethyst','Purple dark','Refined violet rhythm'],
  ['copper','Copper','Industrial dark','Copper workshop'],
  ['volt','Volt','Electric lime','High-energy dark tech'],
  ['fathom','Fathom','Deep ocean','Dark ocean current'],
  ['synth','Synth','Neon night','Modern neon grid'],
  ['nordic','Nordic','Cool slate','Low-contrast blue gray'],
  ['cinder','Cinder','Charcoal ember','Smoky orange accent'],
  ['horizon','Horizon','Bottom dock','Dark bottom navigation'],
  ['ribbon','Ribbon','Side ribbon','Compact vertical ribbon'],
  ['focus','Focus','Centered chat','Distraction-free dark'],
  ['atlas','Atlas','Wide canvas','Layered dark workspace'],
  ['ivory','Ivory','Clean light','Bright editorial minimal'],
  ['seaglass','Seaglass','Cool light','Soft ocean daylight'],
  ['blossom','Blossom','Soft light','Modern rosy daylight'],
  ['sunrise','Sunrise','Warm light','Bold warm daylight'],
  ['lumen','Lumen','Modern OLED','Luminous modern daily driver'],
  ['gazette','Gazette','Night newsroom','Editorial serif newsroom'],
  ['carbon','Carbon','Machined dark','Industrial instrument cluster'],
  ['orbit','Orbit','Circular night','Circular rail and bowed call'],
  ['afterhours','Afterhours','Nightclub','Neon mixer call HUD'],
  ['halo','Halo','Speaker first','Giant live portrait call'],
  ['vector','Vector','Sharp product','Hairline developer workspace'],
  ['dune','Dune','Desert dark','Warm oval desert stage'],
  ['zenith','Zenith','Quiet ink','Restrained hairline discs'],
  ['pulp','Pulp','Dark comic','Ink and cream speech balloons'],
];
const themeGrid=document.querySelector('.theme-grid');
for(const [theme,name,summary,title] of THEME_CONCEPTS){
  if(themeGrid?.querySelector(`[data-theme="${theme}"]`))continue;
  const button=document.createElement('button');button.className='theme-option theme-concept';button.type='button';button.dataset.theme=theme;button.title=title;button.setAttribute('aria-pressed','false');
  const preview=document.createElement('i'),label=document.createElement('span'),detail=document.createElement('small');label.textContent=name;detail.textContent=summary;button.append(preview,label,detail);themeGrid.append(button);
}
const THEMES=new Set(['midnight','violet','forest','ember','ocean','rose','slate','solar','frost','paper','terminal','aurora','blueprint','arcade',...THEME_CONCEPTS.map(([theme])=>theme)]);
function applyTheme(theme,persist=true){const selected=THEMES.has(theme)?theme:'midnight';document.documentElement.dataset.theme=selected;document.querySelectorAll('.theme-option').forEach(button=>{const active=button.dataset.theme===selected;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active))});if(persist)ssSet('theme',selected)}
const FONTS=new Set(['modern','rounded','humanist','easy-read','classic','mono']);
function applyFont(font,persist=true){const selected=FONTS.has(font)?font:'modern';document.documentElement.dataset.font=selected;const select=$('#fontFamily');if(select)select.value=selected;if(persist)ssSet('fontFamily',selected)}
let settingsReturnFocus=null;
function syncPanelBackdrop(){panelBackdrop.hidden=!!settingsPanel.hidden&&!connectCard.open}
function closePanels(){const restore=!settingsPanel.hidden?settingsReturnFocus:null;if(micTestStream)stopMicrophoneTest();connectCard.open=false;settingsPanel.hidden=true;document.body.classList.remove('settings-open');syncPanelBackdrop();settingsReturnFocus=null;if(restore?.isConnected)setTimeout(()=>restore.focus(),0)}
$('#addFriend').onclick=()=>{settingsPanel.hidden=true;document.body.classList.remove('settings-open');connectCard.open=true;syncPanelBackdrop();setTimeout(()=>signalIn.focus(),0)};
connectCard.addEventListener('toggle',syncPanelBackdrop);panelBackdrop.onclick=closePanels;
document.querySelectorAll('.theme-option').forEach(button=>button.onclick=()=>applyTheme(button.dataset.theme));
(async()=>{applyTheme(await ss('theme'),false)})();
$('#fontFamily').onchange=()=>applyFont($('#fontFamily').value);
(async()=>{applyFont(await ss('fontFamily'),false)})();
reduceMotion.onchange=()=>{document.documentElement.dataset.reduceMotion=String(reduceMotion.checked);ssSet('reduceMotion',reduceMotion.checked?'on':'off')};soundEffects.onchange=()=>{soundEnabled=soundEffects.checked;ssSet('soundEffects',soundEnabled?'on':'off')};shareProfile.onchange=()=>{profileSharing=shareProfile.checked;ssSet('shareProfile',profileSharing?'on':'off');announceProfile();directoryProfilePush()};rememberInvite.onchange=()=>{rememberInviteCode=rememberInvite.checked;ssSet('rememberInvite',rememberInviteCode?'on':'off');if(!rememberInviteCode)ssSet('savedInviteCode',null)};$('#clearSavedInvite').onclick=()=>{signalIn.value='';ssSet('savedInviteCode',null);pairHint.textContent='Saved pairing code cleared from this device.'};hardwareAcceleration.onchange=()=>{const enabled=hardwareAcceleration.checked;ssSet('hardwareAcceleration',enabled?'on':'off');hardwareHint.textContent='Restart Knot to '+(enabled?'enable':'disable')+' hardware acceleration.'};const groupSfuPilotInput=$('#groupSfuPilot');if(groupSfuPilotInput)groupSfuPilotInput.onchange=()=>{groupSfuPilotEnabled=groupSfuPilotInput.checked;ssSet('groupSfuPilot',groupSfuPilotEnabled?'on':'off');if(serverVoiceStream&&joinedVoiceScope==='group-dm')setServerStatus('SFU preference saved · rejoin this group call to apply it')};const encryptedFileRelayInput=$('#encryptedFileRelay');if(encryptedFileRelayInput)encryptedFileRelayInput.onchange=()=>{encryptedFileRelayEnabled=encryptedFileRelayInput.checked;ssSet('encryptedFileRelay',encryptedFileRelayEnabled?'on':'off');renderTransferSetupStatus();syncActiveDmTransport()};$('#restartPair').onclick=()=>{if(window.pairEnv?.relaunch)window.pairEnv.relaunch();else hardwareHint.textContent='Close and reopen Knot to apply this setting.'};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&(!settingsPanel.hidden||connectCard.open))closePanels()});
function directoryMediaUrl(value){
  if(value&&typeof value==='object'&&Number(value.v)===1&&/^[a-f0-9]{64}$/.test(String(value.hash||''))&&/^image\/(?:png|jpeg|gif|webp)$/.test(String(value.mime||''))&&Number(value.size)>0&&Number(value.size)<=384*1024){const origin=new URL(PAIR_SIGNAL_SERVER);origin.protocol=origin.protocol==='wss:'?'https:':'http:';origin.pathname='/media/'+value.hash;origin.search='';origin.hash='';return origin.href}
  if(typeof value!=='string')return '';if(value.length<=MAX_PROFILE_DATA&&/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value))return value;
  if(value.length>2048)return '';try{const candidate=new URL(value),origin=new URL(PAIR_SIGNAL_SERVER),loopback=['localhost','127.0.0.1','[::1]','::1'].includes(origin.hostname);origin.protocol=origin.protocol==='wss:'?'https:':'http:';return candidate.origin===origin.origin&&/^\/media\/[a-f0-9]{64}$/.test(candidate.pathname)&&(candidate.protocol==='https:'||loopback&&candidate.protocol==='http:')?candidate.href:''}catch{return ''}
}
function validProfileData(data){return !!directoryMediaUrl(data)}
function setAvatar(el,data){if(!el)return;const safe=directoryMediaUrl(data);el.classList.toggle('has-image',!!safe);el.style.backgroundImage=safe?'url("'+safe.replace(/"/g,'%22')+'")':'';}
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
function renderProfile({push=true}={}){[profileBtn,settingsAvatar,$('#sidebarProfileAvatar')].forEach(el=>{setAvatar(el,profileAvatar);setAvatarFrame(el,profileFrame);setAvatarIdentity(el,profileIdentity)});renderParticipantNames();const hasPhoto=!!profileAvatar;profileAdjust.hidden=!hasPhoto;settingsAdjustPhoto.hidden=!hasPhoto;settingsRemovePhoto.hidden=!hasPhoto;if(push)directoryProfilePush()}
function announceProfile(){
  if(!profileIdentity)return;const generation=++directProfileGeneration;
  send({t:'profile-name',v:profileSharing?profileName:'Friend'});
  if(!profileSharing){send({t:'profile',v:{image:'',frame:profileFrame,identity:profileIdentity}});return}
  // RTCDataChannel implementations commonly cap one message near 256 KiB. Keep
  // animated originals locally, but send a safe thumbnail so profile updates can
  // never throw from the chat channel or suppress the following call-state frame.
  void directAvatar().then(image=>{if(generation===directProfileGeneration)send({t:'profile',v:{image,frame:profileFrame,identity:profileIdentity}})}).catch(()=>{if(generation===directProfileGeneration)send({t:'profile',v:{image:'',frame:profileFrame,identity:profileIdentity}})});
}
async function readProfileData(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=()=>reject(new Error('Could not read image'));r.readAsDataURL(blob)})}
async function resizeProfile(file){if(file.type==='image/gif'){if(file.size>5*1024*1024)throw new Error('Choose a GIF smaller than 5 MB');const data=await readProfileData(file);if(!validProfileData(data))throw new Error('Choose a valid GIF smaller than 5 MB');return data}const bitmap=await createImageBitmap(file);const size=480,scale=Math.min(size/bitmap.width,size/bitmap.height,1);const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close?.();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.72));if(!blob)throw new Error('Could not read image');const data=await readProfileData(blob);if(!validProfileData(data))throw new Error('Choose a smaller image');return data;}
function updateProfileFrame(sendUpdate=false){profileFrame=normalizeFrame({zoom:profileZoom.value,x:profileX.value,y:profileY.value});renderProfile();ssSet('profileFrame',JSON.stringify(profileFrame));if(sendUpdate)announceProfile()}
function openSettings(showPhotoEditor=false){settingsReturnFocus=document.activeElement;connectCard.open=false;settingsPanel.hidden=false;document.body.classList.add('settings-open');syncPanelBackdrop();if(showPhotoEditor){openSettingsTab('profile');profileEditor.hidden=false}setTimeout(()=>$('#closeSettings')?.focus(),0)}
settingsPanel.addEventListener('keydown',event=>{if(event.key!=='Tab')return;const focusable=[...settingsPanel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')].filter(element=>!element.hidden&&element.getClientRects().length);if(!focusable.length){event.preventDefault();settingsPanel.focus();return}const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}});
$('#openSettings').onclick=()=>openSettings();$('#closeSettings').onclick=closePanels;
profileBtn.onclick=()=>openSettings(true);profileAdjust.onclick=()=>openSettings(true);settingsChangePhoto.onclick=()=>profileInput.click();settingsAdjustPhoto.onclick=()=>{profileEditor.hidden=!profileEditor.hidden};settingsRemovePhoto.onclick=async()=>{profileAvatar='';renderProfile();profileEditor.hidden=true;await ssSet('profileAvatar',null);await ssSet('profilePhotoMode','none');announceProfile()};profileDone.onclick=()=>{profileEditor.hidden=true;updateProfileFrame(true)};[profileZoom,profileX,profileY].forEach(input=>input.oninput=()=>updateProfileFrame(false));[profileZoom,profileX,profileY].forEach(input=>input.onchange=()=>updateProfileFrame(true));profileInput.onchange=async()=>{const file=profileInput.files?.[0];profileInput.value='';if(!file)return;try{const next=await resizeProfile(file);const saved=await ssSet('profileAvatar',next);if(saved===false)throw new Error('Knot could not save that photo on this device. Try a smaller image.');profileAvatar=next;renderProfile();await ssSet('profilePhotoMode','custom');announceProfile()}catch(e){alert(e.message||'Could not set profile photo')}};
profileSettingsReady=(async()=>{const[savedName,savedFrame,savedAvatar,savedSharing]=await Promise.all([ss('profileName'),ss('profileFrame'),ss('profileAvatar'),ss('shareProfile')]);profileName=normalizeProfileName(savedName,'You');try{if(savedFrame)profileFrame=normalizeFrame(JSON.parse(savedFrame))}catch{}profileAvatar=validProfileData(savedAvatar)?savedAvatar:'';profileSharing=savedSharing!=='off';profileZoom.value=profileFrame.zoom;profileX.value=profileFrame.x;profileY.value=profileFrame.y;shareProfile.checked=profileSharing;renderProfile({push:false})})();displayNameInput.onchange=()=>updateProfileName(displayNameInput.value);
(async()=>{inputDeviceId=(await ss('inputDevice'))||'default';outputDeviceId=(await ss('outputDevice'))||'default';voiceProcessingEnabled=(await ss('voiceProcessing'))==='on';const savedNoiseReduction=await ss('noiseReduction'),savedNoiseHardware=await ss('noiseHardware');noiseReductionMode=['rnnoise','deepfilter','off'].includes(savedNoiseReduction)?savedNoiseReduction:'rnnoise';noiseHardwareMode=['auto','cpu','gpu'].includes(savedNoiseHardware)?savedNoiseHardware:'auto';voiceInputModeValue=(await ss('voiceInputMode'))==='ptt'?'ptt':'voice';const savedPttKey=await ss('pushToTalkKey');pushToTalkKey=typeof savedPttKey==='string'&&savedPttKey.length<32?savedPttKey:'Space';const savedPttDelay=Number(await ss('pushToTalkDelay'));pushToTalkDelay=Number.isFinite(savedPttDelay)?Math.max(0,Math.min(1000,savedPttDelay)):0;soundEnabled=(await ss('soundEffects'))!=='off';profileSharing=(await ss('shareProfile'))!=='off';rememberInviteCode=(await ss('rememberInvite'))!=='off';groupSfuPilotEnabled=(await ss('groupSfuPilot'))==='on';encryptedFileRelayEnabled=(await ss('encryptedFileRelay'))==='on';const motion=(await ss('reduceMotion'))==='on';const hardware=(await ss('hardwareAcceleration'))!=='off';const savedPort=validTcpPort(await ss('tcpListenPort')),savedTransport=await ss('fileTransport');tcpFilePort=savedPort||8787;fileTransportMode=['auto','webrtc','tcp'].includes(savedTransport)?savedTransport:'auto';if(!rememberInviteCode){signalIn.value='';ssSet('savedInviteCode',null)}voiceProcessing.checked=voiceProcessingEnabled;renderNoiseProcessingUI();updatePushToTalkUI();soundEffects.checked=soundEnabled;shareProfile.checked=profileSharing;rememberInvite.checked=rememberInviteCode;reduceMotion.checked=motion;hardwareAcceleration.checked=hardware;if(fileTransportSetting)fileTransportSetting.value=fileTransportMode;if(tcpListenPortInput)tcpListenPortInput.value=String(tcpFilePort);renderTransferSetupStatus();syncGroupSfuSettingUi();syncFileRelaySettingUi();document.documentElement.dataset.reduceMotion=String(motion);hardwareHint.textContent='Hardware acceleration is '+(hardware?'enabled':'disabled')+' for the next start.';await refreshAudioDevices();await applyOutputDevice()})();signalIn.addEventListener('input',()=>{if(!rememberInviteCode)ssSet('savedInviteCode',null)});
(async()=>{const savedRoom=await ss('roomCode');const savedInvite=await ss('savedInviteCode');if(/^\d{5}$/.test(savedRoom||''))$('#roomCode').value=savedRoom;if(typeof savedInvite==='string'&&savedInvite.length<=MAX_SIGNAL_SIZE)signalIn.value=savedInvite;$('#roomCode').addEventListener('input',()=>{const code=$('#roomCode').value.replace(/\D/g,'').slice(0,5);$('#roomCode').value=code;ssSet('roomCode',code)});signalIn.addEventListener('input',()=>ssSet('savedInviteCode',signalIn.value.trim()));const savedVol=parseFloat(await ss('volume'));setCallVolume(savedVol>0&&savedVol<=1?Math.round(savedVol*100):100,false);const savedFrame=await ss('profileFrame');try{if(savedFrame)profileFrame=normalizeFrame(JSON.parse(savedFrame))}catch{};profileZoom.value=profileFrame.zoom;profileX.value=profileFrame.x;profileY.value=profileFrame.y;const savedAvatar=await ss('profileAvatar');if(validProfileData(savedAvatar)){profileAvatar=savedAvatar;renderProfile();announceProfile()}})();
// Every installation gets a stable generated look until the owner chooses a
// photo. The compact identity is only used to derive the avatar color.
(async()=>{const savedIdentity=await ss('profileIdentity');profileIdentity=validProfileIdentity(savedIdentity)?savedIdentity:makeProfileIdentity();renderProfile();if(profileIdentity!==savedIdentity)ssSet('profileIdentity',profileIdentity)})();
// On a fresh install, use the person's OS account picture when it is available.
// This remains local until they pair, and choosing a photo in Knot still wins.
(async()=>{if(!window.pairEnv?.getSystemAvatar)return;await profileSettingsReady;if(profileAvatar||await ss('profilePhotoMode')==='none')return;try{const avatar=await window.pairEnv.getSystemAvatar();if(profileAvatar||!validProfileData(avatar))return;profileAvatar=avatar;renderProfile();await ssSet('profileAvatar',profileAvatar);await ssSet('profilePhotoMode','system');announceProfile()}catch{}})();
// Auto-update pulls latest.json directly from GitHub (configured in updater.js),
  // independent of the signaling server. No action needed here.

let signaling;
function secureSignalAddress(address){try{const u=new URL(address);const loopback=['localhost','127.0.0.1','[::1]','::1'].includes(u.hostname);return u.protocol==='wss:'||(u.protocol==='ws:'&&loopback)?u.href:null}catch{return null}}
function roomSignalAddress(address,room){const safe=secureSignalAddress(address);if(!safe)return null;const u=new URL(safe);u.searchParams.set('room',String(room).trim().toUpperCase());return u.href}
function makeInviteCode(){return clientHex(16)}

// --- Friends, presence and servers ------------------------------------------
// The directory carries encrypted text plus presence and WebRTC setup. It never
// receives plaintext, group keys, voice, video, screen-share bytes, or proxied
// file bytes. An explicitly enabled object relay uses direct presigned URLs for
// locally encrypted file ciphertext; direct P2P remains the default.
function clientHex(bytes){const value=crypto.getRandomValues(new Uint8Array(bytes));return [...value].map(byte=>byte.toString(16).padStart(2,'0')).join('')}
function directoryAddress(){const u=new URL(PAIR_SIGNAL_SERVER);u.pathname='/directory';u.search='';return u.href}
function normalizeDirectoryProfile(profile){return profile&&typeof profile==='object'?{...profile,image:directoryMediaUrl(profile.image)}:profile}
function normalizeDirectoryEntity(entity){if(!entity||typeof entity!=='object')return entity;return entity.kind==='group-dm'?{...entity}:{...entity,picture:directoryMediaUrl(entity.picture)}}
function normalizeDirectorySnapshotWire(snapshot){
  if(!snapshot||typeof snapshot!=='object')return snapshot;const members={};for(const[id,profile]of Object.entries(snapshot.members||{}))members[id]=normalizeDirectoryProfile(profile);
  const next={...snapshot,self:normalizeDirectoryProfile(snapshot.self),members};
  if(Array.isArray(snapshot.friends))next.friends=snapshot.friends.map(normalizeDirectoryProfile);
  if(Array.isArray(snapshot.servers))next.servers=snapshot.servers.map(normalizeDirectoryEntity);
  if(Array.isArray(snapshot.groupDms))next.groupDms=snapshot.groupDms.map(normalizeDirectoryEntity);
  return next;
}
function directorySend(value){if(directorySocket?.readyState!==WebSocket.OPEN)return false;try{directorySocket.send(JSON.stringify(value));return true}catch{return false}}
function renderAccountSummary(){const summary=$('#accountSummary'),username=$('#accountUsername');if(summary)summary.textContent=directoryAccountName?'Signed in as @'+directoryAccountName+'. Your profile, friends, and servers can now be recovered on another computer.':'This identity currently exists only on this device. Create an account to recover your profile and friends after reinstalling or changing operating systems.';if(username&&directoryAccountName)username.value=directoryAccountName}
function accountShouldRemember(){return $('#authRemember')?.checked!==false}
async function persistAccountSession({userId=directoryUserId,token=directoryToken,username='',remember=true}={}){directoryUserId=userId;directoryToken=token;directoryAccountName=username;transientDirectorySession=!remember;await ssSet('rememberAccount',remember?'yes':'no');if(remember)await Promise.all([ssSet('directoryUserId',userId),ssSet('directoryToken',token),ssSet('directoryAccountName',username),ssSet('accountOnboardingDismissed','yes')]);else await Promise.all([ssSet('directoryUserId',null),ssSet('directoryToken',null),ssSet('directoryAccountName',null),ssSet('accountOnboardingDismissed',null)])}
async function loadDirectoryIdentity(){
  const savedId=await ss('directoryUserId'),savedToken=await ss('directoryToken'),savedName=await ss('directoryAccountName'),validId=/^[a-f0-9]{32}$/.test(savedId||''),validToken=/^[a-f0-9]{64}$/.test(savedToken||''),accountName=/^[a-z0-9][a-z0-9_.-]{2,23}$/.test(savedName||'')?savedName:'';
  let storedToken=false;if(!validToken)try{storedToken=!!await ssHas('directoryToken')}catch{}
  if(validId&&validToken)return{userId:savedId,token:savedToken,accountName,needsLogin:false,minted:false};
  if(validId)return{userId:savedId,token:'',accountName,needsLogin:!!accountName||storedToken,minted:false};
  return{userId:clientHex(16),token:clientHex(32),accountName:'',needsLogin:false,minted:true};
}
function hasCustomizedLocalProfile(){const frame=normalizeFrame(profileFrame);return !!profileAvatar||(profileName!=='You'&&profileName!=='Knot user')||frame.zoom!==100||frame.x!==50||frame.y!==50}
async function restoreAccountProfile(value,userId,{keepLocalLegacy=false}={}){
  const id=String(value?.id||'').toLowerCase();if(!/^[a-f0-9]{32}$/.test(id)||id!==String(userId||'').toLowerCase())return false;
  // An older account has no private recovery record yet. If this is the same
  // identity and this device still has a customized profile, keep it so the
  // authenticated update after reconnect migrates the better local copy.
  if(keepLocalLegacy&&hasCustomizedLocalProfile())return false;
  const incomingImage=directoryMediaUrl(value.image),localPhoto=typeof profileAvatar==='string'&&profileAvatar.startsWith('data:image/'),incomingIsRemote=!!incomingImage&&!String(incomingImage).startsWith('data:image/'),keepLocalPhoto=localPhoto&&(!incomingImage||incomingIsRemote);
  profileName=normalizeProfileName(value.name,'Knot user');if(!keepLocalPhoto)profileAvatar=incomingImage;profileFrame=normalizeFrame(value.frame);
  directAvatarSource='';directAvatarCache='';directoryAvatarSource='';directoryAvatarCache='';
  profileZoom.value=profileFrame.zoom;profileX.value=profileFrame.x;profileY.value=profileFrame.y;renderProfile({push:false});
  await Promise.all([ssSet('profileName',profileName),ssSet('profileAvatar',profileAvatar||null),ssSet('profileFrame',JSON.stringify(profileFrame)),ssSet('profilePhotoMode',profileAvatar?(keepLocalPhoto?'custom':'account'):'none')]);
  return true;
}
function accountCredentials(usernameElement=$('#accountUsername'),passwordElement=$('#accountPassword'),status=$('#accountStatus')){const username=usernameElement.value.trim().toLowerCase(),password=passwordElement.value;if(!/^[a-z0-9][a-z0-9_.-]{2,23}$/.test(username)){status.textContent='Use 3–24 letters, numbers, dots, dashes, or underscores.';return null}if(password.length<8||password.length>128){status.textContent='Use a password between 8 and 128 characters.';return null}passwordElement.value='';return{username,password,status}}
async function accountPasswordVerifier(password,passwordSalt){if(!/^[A-Za-z0-9_.-]{22,64}$/.test(passwordSalt))throw new Error('The sign-in challenge was invalid.');const material=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']),salt=base64UrlDecode(passwordSalt),bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000},material,256);return base64UrlEncode(new Uint8Array(bits))}
async function createKnotAccount(usernameElement,passwordElement,status){const input=accountCredentials(usernameElement,passwordElement,status);if(!input)return;pendingAccountRemember=accountShouldRemember();if(directorySocket?.readyState!==WebSocket.OPEN){input.status.textContent='Knot is offline. Reconnect and try again.';return}try{input.status.textContent='Securing password on this device…';const passwordSalt=base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),verifier=await accountPasswordVerifier(input.password,passwordSalt),profile=await accountRecoveryProfile();input.status.textContent='Creating account…';if(!directorySend({type:'create-account',username:input.username,passwordSalt,verifier,profile}))input.status.textContent='Knot is offline. Reconnect and try again.'}catch(error){input.status.textContent=error?.message||'Could not secure the password.'}}
async function signInKnotAccount(usernameElement,passwordElement,status){
  const input=accountCredentials(usernameElement,passwordElement,status);if(!input)return;const generation=++accountAuthGeneration,remember=accountShouldRemember();pendingAccountRemember=remember;input.status.textContent='Contacting Knot…';const socket=new WebSocket(directoryAddress());let finished=false,loginSent=false;
  const finishError=message=>{if(finished)return;finished=true;clearTimeout(timer);try{socket.close()}catch{}if(generation===accountAuthGeneration)input.status.textContent=message};
  const timer=setTimeout(()=>finishError('Sign-in timed out. Try again.'),20000);
  socket.onopen=()=>{if(!finished&&generation===accountAuthGeneration)socket.send(JSON.stringify({type:'account-challenge',username:input.username,directoryVersion:2}));else try{socket.close()}catch{}};
  socket.onmessage=async event=>{
    if(finished||generation!==accountAuthGeneration){try{socket.close()}catch{};return}let value;try{value=JSON.parse(event.data)}catch{return}
    if(value.type==='error'){finishError(value.message||'Sign-in failed.');return}
    if(value.type==='account-challenge'&&!loginSent){loginSent=true;try{input.status.textContent='Securing password on this device…';const verifier=await accountPasswordVerifier(input.password,value.passwordSalt);if(finished||generation!==accountAuthGeneration)return;input.status.textContent='Signing in…';socket.send(JSON.stringify({type:'account-login',username:input.username,verifier,directoryVersion:2}))}catch(error){finishError(error?.message||'Could not secure the password.')}return}
    if(value.type!=='account-session'||value.mode!=='login')return;
    finished=true;clearTimeout(timer);const changed=value.userId!==directoryUserId,previousDirectorySocket=directorySocket;directorySocket=null;clearTimeout(directoryProfileTimer);directoryProfileGeneration++;try{previousDirectorySocket?.close()}catch{}
    await persistAccountSession({userId:value.userId,token:value.token,username:value.username,remember});
    await restoreAccountProfile(value.profile,value.userId,{keepLocalLegacy:value.profileMigrated===true&&!changed});
    if(generation!==accountAuthGeneration)return;
    if(changed){conversationHistories={};conversationRenderState=null;conversationLoadGeneration++;closedDmIds.clear();await ssSet('closedDmIds','[]');unreadDmCounts={};await ssSet('unreadDmCounts','{}');directoryRevision=0;directoryEmptySnapshotRetry=false;directorySnapshot={friends:[],servers:[],groupDms:[],members:{},voiceStates:{}};await ssSet('directoryRosterCache',null);renderUnreadBadges();renderServers();renderFriends()}
    input.status.textContent='Signed in as @'+value.username+'. Restored your profile and reconnecting…';renderAccountSummary();$('#accountDialog')?.close();socket.close();void connectDirectory()
  };
  socket.onerror=()=>finishError('Could not reach Knot to sign in.');socket.onclose=()=>{if(!finished)finishError('Sign-in connection closed. Try again.')}
}
async function maybeShowAccountOnboarding(){const dialog=$('#accountDialog');if(!window.pairEnv?.isApp||!dialog||dialog.open||directoryAccountName||(await ss('accountOnboardingDismissed'))==='yes')return;dialog.showModal();setTimeout(()=>$('#authUsername')?.focus(),0)}
function installAccountOnboarding(){const dialog=$('#accountDialog'),signup=$('#authSignupTab'),signin=$('#authSigninTab'),submit=$('#authSubmit'),username=$('#authUsername'),password=$('#authPassword'),status=$('#authStatus'),remember=$('#authRemember');if(!dialog)return;let mode='signup';ss('rememberAccount').then(value=>{if(remember)remember.checked=value!=='no'});const paint=next=>{mode=next==='signin'?'signin':'signup';submit.disabled=false;signup.classList.toggle('active',mode==='signup');signin.classList.toggle('active',mode==='signin');signup.setAttribute('aria-selected',String(mode==='signup'));signin.setAttribute('aria-selected',String(mode==='signin'));password.autocomplete=mode==='signup'?'new-password':'current-password';submit.textContent=mode==='signup'?'Create secure account':'Sign in securely';status.textContent=mode==='signup'?'Usernames are unique. The 600,000-round password protection runs on this device; only a derived verifier crosses WSS/TLS.':'Sign in to restore the same profile, identity, friends, and servers on this computer. Your password never leaves this device.';$('#authContinueLocal').textContent='Continue with a device-only identity'};signup.onclick=()=>paint('signup');signin.onclick=()=>paint('signin');submit.onclick=()=>mode==='signup'?createKnotAccount(username,password,status):signInKnotAccount(username,password,status);password.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();submit.click()}});$('#authContinueLocal').onclick=async()=>{if(directoryAccountName&&!/^[a-f0-9]{64}$/.test(directoryToken)){status.textContent='Sign in to restore this account. Continuing locally would create a new device identity.';paint('signin');return}if(!directoryAccountName)await ssSet('accountOnboardingDismissed','yes');if(!/^[a-f0-9]{64}$/.test(directoryToken)){directoryUserId=clientHex(16);directoryToken=clientHex(32);await ssSet('directoryUserId',directoryUserId);await ssSet('directoryToken',directoryToken)}dialog.close();void connectDirectory()};dialog.addEventListener('cancel',event=>event.preventDefault());paint('signup')}
function directoryUser(id){return (directorySnapshot.friends||[]).find(friend=>friend.id===id)||directorySnapshot.members?.[id]||(id===directoryUserId?directorySnapshot.self:null)||null}
function friendOnLan(id){return lanNeighbors.get(id)||null}
function friendReachable(id){const friend=directoryUser(id);return !!(friend&&(friend.online||friendOnLan(id)))}
function directoryDisplayUser(id,{online=false}={}){return directoryUser(id)||(/^[a-f0-9]{32}$/.test(String(id||''))?{id,name:'Knot member',username:'',image:'',frame:normalizeFrame(),deviceKey:null,online}:null)}
function groupDm(id){return (directorySnapshot.groupDms||[]).find(group=>group.id===id)||null}
function conversationEntity(id){return (directorySnapshot.servers||[]).find(server=>server.id===id)||groupDm(id)||null}
function isGroupDm(entity){return entity?.kind==='group-dm'||!!groupDm(entity?.id)}
function groupDmMembers(group,{includeSelf=true}={}){return (group?.members||[]).filter(id=>includeSelf||id!==directoryUserId).map(id=>directoryUser(id)).filter(Boolean)}
let deviceIdentityPromise=null,serverTextKeysLoaded=false,serverTextKeys={},serverTextMembershipLoaded=false,serverTextMembership={},serverTextSyncing=false,serverTextSyncQueued=false;
const seenRelayMessages=new Set(),pendingServerKeyRequests=new Set(),pendingGroupKeyRequests=new Map(),pendingGroupEnvelopes=new Map();
function validDevicePublicKey(value){return !!value&&value.kty==='EC'&&value.crv==='P-256'&&typeof value.x==='string'&&/^[A-Za-z0-9_-]{40,80}$/.test(value.x)&&typeof value.y==='string'&&/^[A-Za-z0-9_-]{40,80}$/.test(value.y)}
async function deviceIdentity(){if(deviceIdentityPromise)return deviceIdentityPromise;deviceIdentityPromise=(async()=>{let saved;try{saved=JSON.parse(await ss('deviceIdentityPrivate')||'null')}catch{};try{if(validDevicePublicKey(saved)&&typeof saved.d==='string'){const privateKey=await crypto.subtle.importKey('jwk',saved,{name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);const publicKey=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:saved.x,y:saved.y,ext:true},{name:'ECDH',namedCurve:'P-256'},true,[]);return{privateKey,publicKey}}}catch{}const generated=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);const privateJwk=await crypto.subtle.exportKey('jwk',generated.privateKey);await ssSet('deviceIdentityPrivate',JSON.stringify(privateJwk));return generated})();return deviceIdentityPromise}
async function devicePublicKey(){return crypto.subtle.exportKey('jwk',(await deviceIdentity()).publicKey)}
function relayBytes(value){return enc.encode(String(value))}
function relayAad(scope,id,from,to='',serverId='',channelId=''){const peers=[String(from||''),String(to||'')].filter(Boolean).sort().join(':');return relayBytes(['knot-live-v1',scope,id,peers,serverId,channelId].join('|'))}
async function relayPairKey(peerId){const peer=directoryUser(peerId);if(!validDevicePublicKey(peer?.deviceKey))throw new Error('Your friend is updating secure chat keys. Try again in a moment.');const identity=await deviceIdentity(),remote=await importPub(peer.deviceKey),bits=await crypto.subtle.deriveBits({name:'ECDH',public:remote},identity.privateKey,256),label=relayBytes('knot-live-pair-v1|'+[directoryUserId,peerId].sort().join('|')),material=new Uint8Array(bits.byteLength+label.byteLength);material.set(new Uint8Array(bits));material.set(label,new Uint8Array(bits).byteLength);const digest=await crypto.subtle.digest('SHA-256',material);return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['encrypt','decrypt'])}
async function sealRelay(key,value,aad){const iv=crypto.getRandomValues(new Uint8Array(12)),data=enc.encode(typeof value==='string'?value:JSON.stringify(value)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,data);return{iv:base64UrlEncode(iv),data:base64UrlEncode(new Uint8Array(cipher))}}
async function openRelay(key,value,aad){if(!value||typeof value.iv!=='string'||typeof value.data!=='string'||value.data.length>MAX_MESSAGE_SIZE*2)return null;try{return dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:base64UrlDecode(value.iv),additionalData:aad},key,base64UrlDecode(value.data)))}catch{return null}}
function syncFileRelaySettingUi(){const input=$('#encryptedFileRelay'),hint=$('#encryptedFileRelayHint');if(!input)return;input.checked=encryptedFileRelayEnabled;input.disabled=!directoryFeatures.encryptedFileRelay;if(hint)hint.textContent=directoryFeatures.encryptedFileRelay?'Available as an explicit last resort after direct transfer fails. Knot encrypts locally, uploads/downloads with short-lived presigned URLs, and the host confirms lifecycle deletion. 64 MB maximum.':'No lifecycle-confirmed object store is configured on this Knot server. Files remain direct TCP/WebRTC and require no storage account.'}
function fileRelayReady(peerId=activePeerId){return !!(encryptedFileRelayEnabled&&directoryFeatures.encryptedFileRelay&&/^[a-f0-9]{32}$/.test(peerId)&&secureRelayReady(peerId))}
function fileRelayRpc(action,payload={}){return new Promise((resolve,reject)=>{if(!directorySocket||directorySocket.readyState!==WebSocket.OPEN)return reject(new Error('Knot signaling is offline'));const requestId=clientHex(16),timer=setTimeout(()=>{fileRelayPending.delete(requestId);reject(new Error('Encrypted file relay request timed out'))},12000);fileRelayPending.set(requestId,{action,resolve:value=>{clearTimeout(timer);if(value?.action!==action)reject(new Error('Encrypted file relay returned a mismatched response'));else resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});if(!directorySend({type:'file-relay-'+action,requestId,...payload})){clearTimeout(timer);fileRelayPending.delete(requestId);reject(new Error('Could not send the encrypted file relay request'))}})}
function safePresignedObjectUrl(value){try{const url=new URL(String(value||'')),loopback=['localhost','127.0.0.1','[::1]','::1'].includes(url.hostname);return url.protocol==='https:'||loopback&&url.protocol==='http:'?url.href:''}catch{return ''}}
async function readExactResponseBytes(response,expected){if(!Number.isSafeInteger(expected)||expected<16||expected>64*1024*1024+16)throw new Error('Encrypted object size is outside the relay limit');const declared=response.headers?.get?.('content-length');if(declared!==null&&declared!==undefined&&declared!==''&&Number(declared)!==expected)throw new Error('Encrypted object length did not match');if(!response.body?.getReader){const fallback=new Uint8Array(await response.arrayBuffer());if(fallback.byteLength!==expected)throw new Error('Encrypted object size did not match');return fallback}const bytes=new Uint8Array(expected),reader=response.body.getReader();let offset=0;try{for(;;){const{done,value}=await reader.read();if(done)break;const chunk=value instanceof Uint8Array?value:new Uint8Array(value||0);if(offset+chunk.byteLength>expected){await reader.cancel('encrypted object exceeded declared size').catch(()=>{});throw new Error('Encrypted object exceeded its size limit')}bytes.set(chunk,offset);offset+=chunk.byteLength}}finally{try{reader.releaseLock()}catch{}}if(offset!==expected)throw new Error('Encrypted object ended before its declared size');return bytes}
async function abandonEncryptedFileRelay(id){if(!/^[a-f0-9]{32}$/.test(String(id||'')))return false;try{const response=await fileRelayRpc('abort',{id}),deleteUrl=safePresignedObjectUrl(response.deleteUrl);if(!deleteUrl)return false;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);try{const deleted=await fetch(deleteUrl,{method:'DELETE',signal:controller.signal,redirect:'error'});return deleted.ok||deleted.status===404}finally{clearTimeout(timer)}}catch{return false}}
function fileObjectAad(id,from,to,size){return relayBytes(['knot-file-object-v1',id,from,to,String(size)].join('|'))}
async function sendEncryptedFileRelay(file,peerId=activePeerId){
  const size=Number(file?.size),name=safeTransferName(file?.name),type=typeof file?.type==='string'?file.type.slice(0,255):'';if(!fileRelayReady(peerId))throw new Error('Encrypted object relay is not available');if(!Number.isSafeInteger(size)||size<0||size>64*1024*1024)throw new Error('Encrypted object relay is limited to 64 MB');const el=transfer(name,size,'out','relay'),status=el.querySelector('.transfer-status'),cancel=el.querySelector('.cancel-btn'),retry=el.querySelector('.retry-btn'),controller=new AbortController(),started=performance.now();let id='',notified=false,rawKey=null,plainBytes=null;cancel.hidden=false;cancel.onclick=()=>{controller.abort();cancel.hidden=true;status.textContent='Cancelling…'};
  try{status.textContent='Preparing encrypted upload…';const created=await fileRelayRpc('create',{peerId,size}),uploadUrl=safePresignedObjectUrl(created.uploadUrl),signedHeaders=uploadUrl?new URL(uploadUrl).searchParams.get('X-Amz-SignedHeaders')||'':'';id=String(created.id||'');if(!/^[a-f0-9]{32}$/.test(id)||!uploadUrl||created.uploadHeaders?.['content-type']!=='application/octet-stream'||signedHeaders!=='content-length;content-type;host'||Number(created.objectExpiresAt)<=Date.now())throw new Error('The file relay returned an unbounded upload');if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');rawKey=crypto.getRandomValues(new Uint8Array(32));const key=await crypto.subtle.importKey('raw',rawKey,{name:'AES-GCM'},false,['encrypt']),iv=crypto.getRandomValues(new Uint8Array(12));status.textContent='Reading and encrypting locally…';plainBytes=new Uint8Array(await file.arrayBuffer());if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:fileObjectAad(id,directoryUserId,peerId,size)},key,plainBytes);plainBytes.fill(0);plainBytes=null;if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');status.textContent='Uploading encrypted bytes directly…';const uploaded=await fetch(uploadUrl,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:cipher,signal:controller.signal,redirect:'error'});if(!uploaded.ok)throw new Error('Object storage rejected the encrypted upload');const pairKey=await relayPairKey(peerId),manifest={v:1,id,name,size,type,key:base64UrlEncode(rawKey),iv:base64UrlEncode(iv),expiresAt:Number(created.objectExpiresAt)||0},wrapped=await sealRelay(pairKey,manifest,relayAad('file',id,directoryUserId,peerId));rawKey.fill(0);rawKey=null;manifest.key='';iv.fill(0);await fileRelayRpc('notify',{id,cipher:wrapped});notified=true;const seconds=Math.max(.001,(performance.now()-started)/1000);recordMetric('file.throughput_mbps',size*8/seconds/1e6,{lane:'relay'});el.querySelector('.bar i').style.width='100%';status.textContent='Encrypted relay uploaded · automatic expiry scheduled';el.querySelector('.transfer-speed').textContent=formatSpeed(size/seconds);cancel.hidden=true;closeTransferCard(el)
  }catch(error){try{rawKey?.fill(0);plainBytes?.fill(0)}catch{}if(id&&!notified)void abandonEncryptedFileRelay(id);if(error?.name==='AbortError')status.textContent='Cancelled';else{status.textContent='Relay failed: '+(error?.message||error);status.classList.add('failed');retry.hidden=false;retry.onclick=()=>{el.closest('.message')?.remove();sendEncryptedFileRelay(file,peerId).catch(value=>{pairHint.textContent=value?.message||'Encrypted relay failed'})}}cancel.hidden=true;closeTransferCard(el);throw error}
}
async function receiveEncryptedFileRelay(value){
  const from=String(value?.from||'').toLowerCase(),id=String(value?.id||'').toLowerCase();if(!/^[a-f0-9]{32}$/.test(from)||!/^[a-f0-9]{32}$/.test(id)||(directorySnapshot.friends||[]).every(friend=>friend.id!==from))return;if(seenRelayMessages.has(id)){directorySend({type:'relay-ack',id});return}if(fileRelayReceiving.has(id))return;fileRelayReceiving.add(id);let card=null,controller=null,keyRaw=null,acknowledged=false;const discard=()=>{if(acknowledged)return;acknowledged=true;rememberRelayMessage(id);directorySend({type:'relay-ack',id})};
  try{const pairKey=await relayPairKey(from),plain=await openRelay(pairKey,value.cipher,relayAad('file',id,from,directoryUserId));if(!plain){discard();return}let manifest;try{manifest=JSON.parse(plain)}catch{discard();return}const size=Number(manifest?.size),name=safeTransferName(manifest?.name),type=typeof manifest?.type==='string'?manifest.type.slice(0,255):'';let iv;try{keyRaw=base64UrlDecode(String(manifest?.key||''));iv=base64UrlDecode(String(manifest?.iv||''))}catch{discard();return}if(manifest?.v!==1||manifest.id!==id||!Number.isSafeInteger(size)||size<0||size>64*1024*1024||keyRaw.length!==32||iv.length!==12||Number(manifest.expiresAt)<=Date.now()){discard();return}const seq=++fileSeq,accepted=await showAcceptCard({name,size,type,transport:'relay'},seq);if(!accepted){discard();return}const response=await fileRelayRpc('download',{id}),downloadUrl=safePresignedObjectUrl(response.downloadUrl),cipherSize=Number(response.cipherSize);if(!downloadUrl||cipherSize!==size+16)throw new Error('The encrypted download reference is invalid');card=transfer(name,size,'in','relay');const status=card.querySelector('.transfer-status'),cancel=card.querySelector('.cancel-btn');controller=new AbortController();cancel.hidden=false;cancel.onclick=()=>{discard();controller.abort();cancel.hidden=true;status.textContent='Cancelled'};status.textContent='Downloading encrypted bytes directly…';const downloaded=await fetch(downloadUrl,{method:'GET',signal:controller.signal,redirect:'error'});if(!downloaded.ok)throw new Error('Encrypted object download failed');const cipher=await readExactResponseBytes(downloaded,cipherSize);if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');status.textContent='Decrypting locally…';const key=await crypto.subtle.importKey('raw',keyRaw,{name:'AES-GCM'},false,['decrypt']),bytes=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:fileObjectAad(id,from,directoryUserId,size)},key,cipher));keyRaw.fill(0);keyRaw=null;if(bytes.byteLength!==size)throw new Error('Decrypted file size did not match');if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');if(window.pairSave){const started=await window.pairSave.start(seq,name,size);if(!started?.ok){discard();throw new Error(started?.error||'Save dialog declined')}try{for(let offset=0;offset<bytes.length;offset+=4*1024*1024){if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');await window.pairSave.write(seq,bytes.slice(offset,offset+4*1024*1024))}if(!await window.pairSave.end(seq,size))throw new Error('Destination could not be committed')}catch(error){await window.pairSave.cancel(seq).catch(()=>{});throw error}}else{const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([bytes],{type}));link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),0)}discard();card.querySelector('.bar i').style.width='100%';status.textContent='Received · decrypted locally';cancel.hidden=true;closeTransferCard(card)
  }catch(error){try{keyRaw?.fill(0)}catch{}if(card){const status=card.querySelector('.transfer-status');status.textContent=error?.name==='AbortError'?'Cancelled':'Relay failed: '+(error?.message||error);status.classList.toggle('failed',error?.name!=='AbortError');card.querySelector('.cancel-btn').hidden=true;closeTransferCard(card)}else pairHint.textContent=error?.message||'Encrypted file relay failed'}finally{fileRelayReceiving.delete(id)}
}
async function loadServerTextKeys(){if(serverTextKeysLoaded)return;serverTextKeysLoaded=true;try{const parsed=JSON.parse(await ss('serverTextKeys')||'{}');if(parsed&&typeof parsed==='object')serverTextKeys=parsed}catch{serverTextKeys={}}}
async function saveServerTextKeys(){await ssSet('serverTextKeys',JSON.stringify(serverTextKeys))}
async function importServerTextKey(raw){return crypto.subtle.importKey('raw',base64UrlDecode(raw),{name:'AES-GCM'},false,['encrypt','decrypt'])}
function validServerTextKeyRaw(value){return typeof value==='string'&&/^[A-Za-z0-9_.-]{40,64}$/.test(value)}
function groupTextKeyRaw(stored,epoch){if(!stored||typeof stored!=='object')return null;if(Number(stored.epoch)===epoch&&validServerTextKeyRaw(stored.key))return stored.key;const historical=stored.history?.[String(epoch)];return validServerTextKeyRaw(historical)?historical:null}
function groupTextKeyRecord(stored,epoch,currentRaw=null){
  const history={};if(stored&&typeof stored==='object'){for(const [key,value] of Object.entries(stored.history||{})){const keyEpoch=Number(key);if(Number.isInteger(keyEpoch)&&keyEpoch>0&&validServerTextKeyRaw(value))history[String(keyEpoch)]=value}const storedEpoch=Number(stored.epoch);if(Number.isInteger(storedEpoch)&&storedEpoch>0&&storedEpoch!==epoch&&validServerTextKeyRaw(stored.key))history[String(storedEpoch)]=stored.key}
  const ordered=Object.keys(history).map(Number).sort((a,b)=>b-a);for(const oldEpoch of ordered.slice(32))delete history[String(oldEpoch)];delete history[String(epoch)];
  const inherited=Number(stored?.epoch)===epoch&&validServerTextKeyRaw(stored?.key)?stored.key:'';return{key:validServerTextKeyRaw(currentRaw)?currentRaw:inherited,epoch,history}
}
async function serverTextKey(server,{create=false,epoch=null}={}){
  if(!server)return null;await loadServerTextKeys();const groupDmEntity=isGroupDm(server),currentEpoch=groupDmEntity?Number(server.keyEpoch)||1:0,requestedEpoch=groupDmEntity?(Number(epoch)||currentEpoch):0,stored=serverTextKeys[server.id];let raw=groupDmEntity?groupTextKeyRaw(stored,requestedEpoch):stored;
  if(validServerTextKeyRaw(raw))try{return{raw,key:await importServerTextKey(raw),epoch:requestedEpoch}}catch{}
  if(groupDmEntity&&requestedEpoch!==currentEpoch)return null;
  const canCreate=groupDmEntity?(server.keySteward||server.owner)===directoryUserId:server.owner===directoryUserId;
  if(!create||!canCreate){if(groupDmEntity&&Number(stored?.epoch)!==currentEpoch){serverTextKeys[server.id]=groupTextKeyRecord(stored,currentEpoch);await saveServerTextKeys()}return null}
  raw=base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));serverTextKeys[server.id]=groupDmEntity?groupTextKeyRecord(stored,currentEpoch,raw):raw;await saveServerTextKeys();if(!groupDmEntity)void distributeServerTextKey(server,raw);return{raw,key:await importServerTextKey(raw),epoch:currentEpoch}
}
async function sendServerTextKey(server,peerId,raw,request=null){
  if(!server?.members?.includes(peerId)||peerId===directoryUserId)return false;
  try{
    const groupDmEntity=isGroupDm(server),id=groupDmEntity?String(request?.id||''):clientHex(16),epoch=Number(server.keyEpoch)||1;if(groupDmEntity&&(!/^[a-f0-9]{32}$/.test(id)||Number(request?.keyEpoch)!==epoch))return false;
    const pair=await relayPairKey(peerId),body=JSON.stringify(groupDmEntity?{groupId:server.id,key:raw,keyEpoch:epoch}:{serverId:server.id,key:raw}),aad=relayAad(groupDmEntity?'group-key':'key',id,directoryUserId,peerId,server.id,groupDmEntity?String(epoch):''),cipher=await sealRelay(pair,body,aad);
    return directorySend(groupDmEntity?{type:'relay-key',scope:'group-dm',mode:'deliver',id,groupId:server.id,keyEpoch:epoch,peerId,cipher}:{type:'relay-key',mode:'deliver',id,serverId:server.id,peerId,cipher})
  }catch{return false}
}
async function distributeServerTextKey(server,raw){if(isGroupDm(server))return;for(const peerId of server?.members||[])if(peerId!==directoryUserId&&directoryUser(peerId)?.online)await sendServerTextKey(server,peerId,raw)}
async function requestServerTextKey(server){
  if(!server)return;const groupDmEntity=isGroupDm(server);
  if(groupDmEntity){const current=pendingGroupKeyRequests.get(server.id);if(current&&current.keyEpoch===Number(server.keyEpoch)&&current.expires>Date.now())return;const request={id:clientHex(16),keyEpoch:Number(server.keyEpoch)||1,expires:Date.now()+12000};pendingGroupKeyRequests.set(server.id,request);if(!directorySend({type:'relay-key',scope:'group-dm',mode:'request',id:request.id,groupId:server.id,keyEpoch:request.keyEpoch}))pendingGroupKeyRequests.delete(server.id);setTimeout(async()=>{if(pendingGroupKeyRequests.get(server.id)?.id!==request.id)return;pendingGroupKeyRequests.delete(server.id);const currentGroup=groupDm(server.id);if(currentGroup&&!await serverTextKey(currentGroup))requestServerTextKey(currentGroup)},12000);return}
  if(pendingServerKeyRequests.has(server.id))return;pendingServerKeyRequests.add(server.id);const id=clientHex(16);directorySend({type:'relay-key',mode:'request',id,serverId:server.id});setTimeout(()=>pendingServerKeyRequests.delete(server.id),5000)
}
async function serverTextMembershipSync(){
  if(serverTextSyncing){serverTextSyncQueued=true;return}serverTextSyncing=true;
  try{
    if(!serverTextMembershipLoaded){serverTextMembershipLoaded=true;try{const parsed=JSON.parse(await ss('serverTextMembership')||'{}');if(parsed&&typeof parsed==='object')serverTextMembership=parsed}catch{serverTextMembership={}}}
    await loadServerTextKeys();let keysChanged=false;const entities=[...(directorySnapshot.servers||[]),...(directorySnapshot.groupDms||[])],allowed=new Set(entities.map(entity=>entity.id));
    if(entities.length||!Object.keys(serverTextMembership).length&&!Object.keys(serverTextKeys).length){
      for(const id of Object.keys(serverTextKeys))if(!allowed.has(id)){delete serverTextKeys[id];keysChanged=true}
      for(const id of Object.keys(serverTextMembership))if(!allowed.has(id))delete serverTextMembership[id];
    }
    for(const server of directorySnapshot.servers||[]){const signature=(server.members||[]).slice().sort().join(','),previous=serverTextMembership[server.id];serverTextMembership[server.id]=signature;if(previous&&previous!==signature&&server.owner===directoryUserId){const raw=base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));serverTextKeys[server.id]=raw;keysChanged=true;void distributeServerTextKey(server,raw)}}
    for(const group of directorySnapshot.groupDms||[]){const epoch=Number(group.keyEpoch)||1,stored=serverTextKeys[group.id];if(!groupTextKeyRaw(stored,epoch)){const raw=(group.keySteward||group.owner)===directoryUserId?base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))):null;serverTextKeys[group.id]=groupTextKeyRecord(stored,epoch,raw);keysChanged=true}}
    if(keysChanged)await saveServerTextKeys();await ssSet('serverTextMembership',JSON.stringify(serverTextMembership))
  }finally{serverTextSyncing=false;if(serverTextSyncQueued){serverTextSyncQueued=false;queueMicrotask(()=>serverTextMembershipSync().catch(error=>console.warn('secure membership sync',error)))}}
}
function validTurnIceServers(value){return Array.isArray(value)&&value.length>0&&value.length<=8&&value.every(item=>item&&typeof item==='object'&&iceUrls(item).length>0&&iceUrls(item).every(url=>typeof url==='string'&&/^(?:stun|turn|turns):/i.test(url)))&&value.some(hasTurnUrl)}
async function requestTurnCredentials(){
  if(turnIceServers.length)return turnIceServers;
  if(turnCredentialWaiter)return turnCredentialWaiter;
  if(!directorySocket||directorySocket.readyState!==WebSocket.OPEN)throw new Error('Knot signaling is offline');
  let resolveWait,rejectWait;
  const wait=turnCredentialWaiter=new Promise((resolve,reject)=>{resolveWait=resolve;rejectWait=reject});
  const finish=(error,value)=>{const pending=turnCredentialPending;turnCredentialPending=null;turnCredentialWaiter=null;clearTimeout(pending?.timeout);error?rejectWait(error):resolveWait(value)};
  turnCredentialPending={timeout:setTimeout(()=>finish(new Error('Voice relay credential timed out')),10000),resolve:value=>finish(null,value),reject:error=>finish(error)};
  if(!directorySend({type:'turn-credentials'}))finish(new Error('Could not request a voice relay'));
  return wait;
}
function acceptTurnCredentials(value){if(!validTurnIceServers(value?.iceServers)){turnCredentialPending?.reject(new Error('Voice relay returned invalid credentials'));return}turnIceServers=value.iceServers;turnCredentialPending?.resolve(turnIceServers)}
function secureRelayReady(id){return !!(directorySocket?.readyState===WebSocket.OPEN&&validDevicePublicKey(directoryUser(id)?.deviceKey))}
function syncActiveDmTransport(){
  if(activeServerId||!activePeerId)return;
  const friend=directoryUser(activePeerId),ready=secureRelayReady(activePeerId),inBackgroundCall=dmCallOngoing()&&dmCallPeerId!==activePeerId;
  syncComposerAvailability(!ready);messageForm.querySelector('.send').disabled=!ready;
  // Choosing a file is allowed before the media peer exists. The selected file
  // waits for the on-demand direct connection; it is never sent via Cloudflare.
  const fileBlockedByOtherCall=inBackgroundCall,relayAvailable=fileRelayReady(activePeerId),signalingOffline=directorySocket?.readyState!==WebSocket.OPEN;fileInput.disabled=signalingOffline||!relayAvailable&&(relayVoiceMode||fileBlockedByOtherCall||!friend?.online);fileInput.dataset.unavailableReason=signalingOffline?'File transfer is unavailable while signaling is offline.':fileBlockedByOtherCall&&!relayAvailable?'End the call with '+(directoryUser(dmCallPeerId)?.name||'your friend')+' before sending a file to this DM.':relayVoiceMode&&!relayAvailable?'Files need a direct connection and are unavailable on the voice relay.':!friend?.online&&!relayAvailable?'Your friend must be online to receive a direct file.':'Encrypted object relay is available as your explicit fallback.';syncFileAttachmentUi();
  if(callActive||friendInCall)callBtn.disabled=false;else callBtn.disabled=!friendReachable(activePeerId);
  $('.connection').classList.toggle('connected',ready);
  statusText.textContent=ready?(friend?.online?(relayVoiceMode?'Encrypted text · low-bandwidth voice relay':inBackgroundCall?'Encrypted text · call continues in background':pc?._lan?'Encrypted text · on this Wi-Fi':'Encrypted live text'):friendOnLan(activePeerId)?'On this Wi-Fi · call them without Knot cloud':'Encrypted text · offline delivery ready'):dmConnectingPeerId===activePeerId?'Connecting media…':friendReachable(activePeerId)?'Preparing encrypted text…':friendOnLan(activePeerId)?'On this Wi-Fi':'Offline · waiting for secure device key';
}
function receivePersistentDmMessage(peerId,message){receiveDirectMessage(message,peerId)}
async function sendPersistentDm(peerId,text,gif){
  const payload=chatPayload(text,gif);if(enc.encode(payload).byteLength>MAX_MESSAGE_SIZE)throw new Error('Messages are limited to 64 KB');
  if(directorySocket?.readyState!==WebSocket.OPEN){
    if(chat?.readyState==='open'&&sharedKey&&(dmPeerId===peerId||activePeerId===peerId)){
      if(!send({t:'msg',v:await seal(payload)}))throw new Error('Could not send on this Wi-Fi link');
      addMessage(text,true,gif);messageInput.value='';setPendingGif(null);if(gif?.analytics)analyticsShared(gif.analytics);return;
    }
    throw new Error('Knot is offline. If they are on this Wi-Fi, start a call with them first.');
  }
  if(!secureRelayReady(peerId))throw new Error('Secure text is not ready');
  const id=clientHex(16),key=await relayPairKey(peerId),cipher=await sealRelay(key,payload,relayAad('dm',id,directoryUserId,peerId));
  if(!directorySend({type:'relay-text',scope:'dm',id,peerId,cipher}))throw new Error('Encrypted text relay is offline');
  addMessage(text,true,gif);messageInput.value='';setPendingGif(null);if(gif?.analytics)analyticsShared(gif.analytics);
}
function rememberRelayMessage(id){if(!/^[a-f0-9]{32}$/.test(id||'')||seenRelayMessages.has(id))return false;seenRelayMessages.add(id);if(seenRelayMessages.size>2000)seenRelayMessages.delete(seenRelayMessages.values().next().value);return true}
async function receiveRelayText(value){
  const from=String(value?.from||'').toLowerCase(),id=String(value?.id||'').toLowerCase(),acknowledged=value.scope==='dm'||value.scope==='group-dm';if(!/^[a-f0-9]{32}$/.test(id))return;
  if(seenRelayMessages.has(id)){if(acknowledged)directorySend({type:'relay-ack',id});return}
  if(value.scope==='dm'){
    if(!(directorySnapshot.friends||[]).some(friend=>friend.id===from)){if(acknowledged)directorySend({type:'relay-ack',id});return}const key=await relayPairKey(from),payload=await openRelay(key,value.cipher,relayAad('dm',id,from,directoryUserId));if(!payload)return;if(!rememberRelayMessage(id)){directorySend({type:'relay-ack',id});return}receivePersistentDmMessage(from,readChatPayload(payload));directorySend({type:'relay-ack',id});return
  }
  if(value.scope==='group-dm'){
    const group=groupDm(value.groupId),channel=group?.channels?.find(item=>item.id===value.channelId&&item.type==='text'),epoch=Number(value.keyEpoch),currentEpoch=Number(group?.keyEpoch)||1;if(!group||!channel||!group.members.includes(from)||!Number.isInteger(epoch)||epoch<1||epoch>currentEpoch)return;
    const key=await serverTextKey(group,{epoch});if(!key){if(epoch<currentEpoch){directorySend({type:'relay-ack',id});return}const queued=pendingGroupEnvelopes.get(group.id)||[];if(!queued.some(item=>item.id===id)){queued.push(value);if(queued.length>256)queued.shift();pendingGroupEnvelopes.set(group.id,queued)}await requestServerTextKey(group);if(activeGroupDmId===group.id)pairHint.textContent='Waiting for a group member to share this group’s current secure key.';return}
    const payload=await openRelay(key.key,value.cipher,relayAad('group-dm',id,from,'',group.id,channel.id+'@'+epoch));if(!payload)return;if(!rememberRelayMessage(id)){directorySend({type:'relay-ack',id});return}let message;try{message=JSON.parse(payload)}catch{directorySend({type:'relay-ack',id});return}const chat=readChatPayload(message.payload),entry=normalizeServerHistoryEntry({id,text:chat.text,gif:chat.gif,time:message.time,author:{id:from}},group,from);if(entry){storeServerHistory(group.id,channel.id,[entry]);markGroupUnread(group.id,chat,from)}directorySend({type:'relay-ack',id});return
  }
  if(value.scope!=='server')return;const server=(directorySnapshot.servers||[]).find(item=>item.id===value.serverId),channel=server?.channels?.find(item=>item.id===value.channelId&&item.type==='text');if(!server||!channel||!server.members.includes(from))return;const groupKey=await serverTextKey(server);if(!groupKey){await requestServerTextKey(server);if(activeServerId===server.id)pairHint.textContent='Waiting for an online member to share this server’s secure text key.';return}const payload=await openRelay(groupKey.key,value.cipher,relayAad('server',id,from,'',server.id,channel.id));if(!payload||!rememberRelayMessage(id))return;let message;try{message=JSON.parse(payload)}catch{return}const chat=readChatPayload(message.payload),entry=normalizeServerHistoryEntry({id,text:chat.text,gif:chat.gif,time:message.time,author:{id:from}},server,from);if(entry)storeServerHistory(server.id,channel.id,[entry])
}
async function receiveRelayKey(value){
  const from=String(value?.from||'').toLowerCase(),groupDmRelay=value.scope==='group-dm'||!!value.groupId,server=groupDmRelay?groupDm(value.groupId):(directorySnapshot.servers||[]).find(item=>item.id===value.serverId);if(!server||!server.members.includes(from)||from===directoryUserId)return;
  if(value.mode==='request'){
    if(groupDmRelay&&(Number(value.keyEpoch)!==Number(server.keyEpoch)||!/^[a-f0-9]{32}$/.test(String(value.id||''))))return;const groupKey=await serverTextKey(server);if(groupKey)await sendServerTextKey(server,from,groupKey.raw,groupDmRelay?{id:String(value.id),keyEpoch:Number(value.keyEpoch)}:null);return
  }
  if(value.mode!=='deliver')return;const steward=groupDmRelay?(server.keySteward||server.owner):server.owner;if(from!==steward&&from!==server.owner)return;const id=String(value?.id||'').toLowerCase();if(groupDmRelay){const pending=pendingGroupKeyRequests.get(server.id);if(!pending||pending.id!==id||pending.keyEpoch!==Number(value.keyEpoch)||pending.expires<=Date.now())return}else if(!pendingServerKeyRequests.has(server.id)&&from!==server.owner)return;
  if(seenRelayMessages.has(id))return;const epoch=Number(server.keyEpoch)||1,key=await relayPairKey(from),plain=await openRelay(key,value.cipher,relayAad(groupDmRelay?'group-key':'key',id,from,directoryUserId,server.id,groupDmRelay?String(epoch):''));if(!plain)return;let delivered;try{delivered=JSON.parse(plain)}catch{return}const valid=groupDmRelay?delivered?.groupId===server.id&&Number(delivered.keyEpoch)===epoch:delivered?.serverId===server.id;if(!valid||!validServerTextKeyRaw(delivered.key))return;try{await importServerTextKey(delivered.key)}catch{return}if(!rememberRelayMessage(id))return;await loadServerTextKeys();serverTextKeys[server.id]=groupDmRelay?groupTextKeyRecord(serverTextKeys[server.id],epoch,delivered.key):delivered.key;await saveServerTextKeys();pendingServerKeyRequests.delete(server.id);pendingGroupKeyRequests.delete(server.id);if(activeServerId===server.id){pairHint.textContent='Encrypted text is ready.';setServerStatus(groupDmRelay?'Encrypted group text · offline delivery ready':'Encrypted live text is ready.',true)}if(groupDmRelay){const queued=pendingGroupEnvelopes.get(server.id)||[];pendingGroupEnvelopes.delete(server.id);for(const envelope of queued)await receiveRelayText(envelope)}
}
messageForm.addEventListener('submit',async event=>{
  if(!activeServerId&&!activePeerId)return;event.preventDefault();event.stopImmediatePropagation();const text=convertEmoticons(messageInput.value.trim()),gif=pendingGif;if(!text&&!gif)return;
  try{const sent=activeServerId?await sendServerMessage(text,gif):(await sendPersistentDm(activePeerId,text,gif),true);if(sent&&activeServerId){messageInput.value='';setPendingGif(null)}}catch(error){pairHint.textContent=error?.message||'Encrypted text is not ready'}
},true);
let directoryAvatarSource='',directoryAvatarCache='',directoryProfileTimer=null,directoryProfileGeneration=0;
async function avatarThumbnail(source,{limit,dimension,quality}){
  if(!source||!validProfileData(source))return '';
  if(source.length<=limit)return source;
  const image=await new Promise((resolve,reject)=>{const value=new Image();value.crossOrigin='anonymous';value.onload=()=>resolve(value);value.onerror=()=>reject(new Error('Could not prepare profile image'));value.src=source});
  const scale=Math.min(dimension/image.naturalWidth,dimension/image.naturalHeight,1),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality)),data=blob?await readProfileData(blob):'';return validProfileData(data)&&data.length<=limit?data:''
}
async function directAvatar(){
  const source=profileSharing&&validProfileData(profileAvatar)?profileAvatar:'';if(!source)return '';
  if(source===directAvatarSource)return directAvatarCache;
  const data=await avatarThumbnail(source,{limit:MAX_DIRECT_PROFILE_DATA,dimension:192,quality:.72});directAvatarSource=source;directAvatarCache=data;return data
}
async function directoryAvatar({includeHidden=false}={}){
  const source=(includeHidden||profileSharing)&&validProfileData(profileAvatar)?profileAvatar:'';
  if(!source)return '';
  if(source===directoryAvatarSource)return directoryAvatarCache;
  const data=await avatarThumbnail(source,{limit:480*1024,dimension:256,quality:.76});directoryAvatarSource=source;directoryAvatarCache=data;return data;
}
async function accountRecoveryProfile(){await profileSettingsReady;return{name:profileName,image:await directoryAvatar({includeHidden:true}),frame:normalizeFrame(profileFrame)}}
async function directoryProfile(){const accountProfile=await accountRecoveryProfile(),image=profileSharing?accountProfile.image:'';return {name:profileName,image,frame:normalizeFrame(profileFrame),deviceKey:await devicePublicKey(),accountProfile:{name:accountProfile.name,frame:accountProfile.frame,imageFromPublic:profileSharing,...(!profileSharing?{image:accountProfile.image}:{})}}}
directoryProfilePush=()=>{const generation=++directoryProfileGeneration;clearTimeout(directoryProfileTimer);directoryProfileTimer=setTimeout(async()=>{try{await profileSettingsReady;const profile=await directoryProfile();if(generation===directoryProfileGeneration)directorySend({type:'update-profile',...profile})}catch(error){console.warn('directory profile',error)}},100)};
function setDirectoryState(online,text){const lan=lanNeighbors.size,presence=$('#directoryPresence');presence?.classList.toggle('online',online||lan>0);presence?.classList.toggle('lan',!online&&lan>0);if($('#directoryStatus'))$('#directoryStatus').textContent=!online&&lan?((text&&text!=='Online'?text:'House is local')+' · '+lan+' on this Wi-Fi'):text;}
function storeConversationEntry(key,entry,{persist=true}={}){
  if(!key||!entry||typeof entry.text!=='string')return false;const list=conversationHistories[key]||(conversationHistories[key]=[]);if(entry.id&&list.some(item=>item.id===entry.id))return false;list.push(entry);list.sort((a,b)=>(Number(a.time)||0)-(Number(b.time)||0)||String(a.id||'').localeCompare(String(b.id||'')));if(list.length>HISTORY_CACHE_LIMIT){const removed=list.length-HISTORY_CACHE_LIMIT;list.splice(0,removed);if(conversationRenderState?.key===key){conversationRenderState.first=Math.max(0,conversationRenderState.first-removed);conversationRenderState.last=Math.max(0,conversationRenderState.last-removed)}}
  if(persist&&window.pairHistory&&/^[a-f0-9]{32}$/.test(directoryUserId))window.pairHistory.append(directoryUserId,key,entry).catch(error=>console.warn('[history] append failed:',error?.message||error));return true
}
recordConversationMessage=entry=>{if(historyRendering||!activeConversationKey)return;const key=activeConversationKey;if(storeConversationEntry(key,entry))syncLiveHistoryWindow(key,entry,{alreadyRendered:true})};
function persistUnreadDms(){ssSet('unreadDmCounts',JSON.stringify(unreadDmCounts))}
function unreadDmCount(id){return Math.max(0,Math.floor(Number(unreadDmCounts[id])||0))}
function groupDmDisplayName(group){return cleanClientName(group?.name,'Group DM')}
function makeStackedAvatars(group,{compact=false}={}){const stack=document.createElement('span');stack.className='stacked-avatars'+(compact?' compact':'');const members=groupDmMembers(group,{includeSelf:false}).slice(0,3);for(const member of members){const avatar=document.createElement('span');avatar.className='friend-avatar stacked-avatar';paintDirectoryAvatar(avatar,member);stack.append(avatar)}if(!members.length){const avatar=document.createElement('span');avatar.className='friend-avatar stacked-avatar';avatar.textContent='G';stack.append(avatar)}return stack}
function renderUnreadBadges(){
  const total=Object.values(unreadDmCounts).reduce((sum,value)=>sum+Math.max(0,Math.floor(Number(value)||0)),0),badge=$('#totalUnreadBadge'),home=$('#homeButton'),dock=$('#unreadDmDock');
  if(badge){badge.textContent=total>99?'99+':String(total);badge.hidden=!total;badge.setAttribute('aria-label',total?total+' unread '+(total===1?'message':'messages'):'No unread messages')}
  if(home)home.title=total?'Knot home · '+total+' unread':'Knot home';
  if(dock){
    dock.replaceChildren();
    const targets=[...(directorySnapshot.groupDms||[]).map(group=>({kind:'group',id:group.id,name:groupDmDisplayName(group),group})),...(directorySnapshot.friends||[]).map(friend=>({kind:'friend',id:friend.id,name:friend.name||'Knot user',friend}))].filter(target=>unreadDmCount(target.id)>0);
    for(const target of targets){
      const unread=unreadDmCount(target.id),button=document.createElement('button'),active=target.kind==='group'?target.id===activeGroupDmId:target.id===activePeerId&&!activeServerId;button.type='button';button.className='rail-button unread-dm-rail-button'+(active?' active':'');button.title=target.name+(unread?' · '+unread+' unread':'');button.setAttribute('aria-label',target.name+(unread?', '+unread+' unread '+(unread===1?'message':'messages'):''));
      if(target.kind==='group'){const avatar=makeStackedAvatars(target.group,{compact:true});avatar.classList.add('unread-dm-rail-avatar');button.append(avatar);button.onclick=()=>selectGroupDm(target.id)}else{const avatar=document.createElement('span');avatar.className='unread-dm-rail-avatar';paintDirectoryAvatar(avatar,target.friend);avatar.style.backgroundSize='cover';avatar.style.backgroundPosition='center';button.append(avatar);button.onclick=()=>selectFriend(target.id)}const count=document.createElement('span');count.className='unread-dm-rail-badge';count.textContent=unread>99?'99+':String(unread);count.setAttribute('aria-hidden','true');button.append(count);dock.append(button);
    }
  }
  document.title=(total?'('+total+') ':'')+'Knot '+(window.pairEnv?.version||'')+' — private P2P chat';
}
function clearDmUnread(id,{render=true}={}){if(!unreadDmCount(id))return;delete unreadDmCounts[id];persistUnreadDms();renderUnreadBadges();if(render)renderFriends()}
function showMessageNotification(peerId,message){
  if(typeof Notification==='undefined')return;const friend=directoryUser(peerId),title=(friend?.name||'A friend')+' sent you a message',body=String(message?.text||'').trim().slice(0,180)||((message?.gif?.url)?'Sent a GIF':'New encrypted message');
  const show=()=>{try{const note=new Notification(title,{body,icon:validProfileData(friend?.image)?friend.image:'build/icon.png',tag:'dm-'+peerId,silent:false});note.onclick=()=>{window.focus();selectFriend(peerId);note.close()}}catch{}};
  if(Notification.permission==='granted')show();else if(Notification.permission==='default')Notification.requestPermission().then(permission=>permission==='granted'&&show()).catch(()=>{});
}
function markDmUnread(peerId,message){
  const key='dm:'+peerId,isReading=activeConversationKey===key&&document.visibilityState==='visible'&&document.hasFocus();if(isReading)return false;
  unreadDmCounts[peerId]=Math.min(9999,unreadDmCount(peerId)+1);closedDmIds.delete(peerId);persistClosedDms();persistUnreadDms();renderUnreadBadges();renderFriends();showMessageNotification(peerId,message);return true;
}
function markGroupUnread(groupId,message,from){
  const group=groupDm(groupId),channel=group?.channels?.find(item=>item.type==='text'),key=channel?serverHistoryKey(groupId,channel.id):'';if(!group||activeConversationKey===key&&document.visibilityState==='visible'&&document.hasFocus())return false;
  unreadDmCounts[groupId]=Math.min(9999,unreadDmCount(groupId)+1);closedDmIds.delete(groupId);persistClosedDms();persistUnreadDms();renderUnreadBadges();renderFriends();showGroupNotification(group,message,from);return true
}
function showGroupNotification(group,message,from){
  if(typeof Notification==='undefined')return;const author=directoryUser(from),title=(author?.name||'A group member')+' in '+groupDmDisplayName(group),body=String(message?.text||'').trim().slice(0,180)||(message?.gif?.url?(message.gif.emoji?'Sent an emoji':'Sent a GIF'):'New encrypted message'),show=()=>{try{const note=new Notification(title,{body,icon:validProfileData(author?.image)?author.image:'build/icon.png',tag:'group-dm-'+group.id,silent:false});note.onclick=()=>{window.focus();selectGroupDm(group.id);note.close()}}catch{}};if(Notification.permission==='granted')show();else if(Notification.permission==='default')Notification.requestPermission().then(permission=>permission==='granted'&&show()).catch(()=>{})
}
function scrollConversationToLatest(){
  // Restored messages, link cards, and images can change the scroll height
  // after the DM click has already rendered. Keep this one navigation pinned
  // to its newest entry through those layout passes instead of leaving the
  // conversation at its former top position.
  const epoch=++conversationScrollEpoch,scroll=()=>{if(epoch!==conversationScrollEpoch)return;messages.scrollTop=Math.max(0,messages.scrollHeight-messages.clientHeight)};
  clearTimeout(conversationScrollTimer);conversationScrollObserver?.disconnect();conversationScrollObserver=null;if(conversationScrollLoadListener)messages.removeEventListener('load',conversationScrollLoadListener,true);conversationScrollLoadListener=null;
  scroll();requestAnimationFrame(()=>{scroll();requestAnimationFrame(scroll)});setTimeout(scroll,0);setTimeout(scroll,80);setTimeout(scroll,260);
  if(typeof ResizeObserver!=='undefined'){
    conversationScrollObserver=new ResizeObserver(scroll);conversationScrollObserver.observe(messages);
  }
  conversationScrollLoadListener=()=>scroll();messages.addEventListener('load',conversationScrollLoadListener,true);
  conversationScrollTimer=setTimeout(()=>{if(epoch===conversationScrollEpoch){conversationScrollObserver?.disconnect();conversationScrollObserver=null}if(conversationScrollLoadListener){messages.removeEventListener('load',conversationScrollLoadListener,true);conversationScrollLoadListener=null}},900);
}
function renderHistoryItem(item,target=messages){const current=item.author?.id?directoryUser(item.author.id):null;return addMessage(item.text,!!item.mine,item.gif,item.author?{...item.author,...current,time:item.time}:{time:item.time},{target,persist:false})}
function historyEmptyState(text='Messages are encrypted on this device. Local history stays on your devices.') { const empty=document.createElement('div');empty.className='empty';empty.innerHTML='<span>✦</span><p></p>';empty.querySelector('p').textContent=text;messages.append(empty) }
function trimVirtualStart(state=conversationRenderState){while(state&&state.key===activeConversationKey&&messages.querySelectorAll(':scope > .message').length>HISTORY_DOM_LIMIT){const first=messages.querySelector(':scope > .message');if(!first)break;first.remove();state.first++}}
function syncLiveHistoryWindow(key,entry,{alreadyRendered=false}={}){
  const state=conversationRenderState,list=conversationHistories[key]||[];if(!state||state.key!==key||activeConversationKey!==key)return;const wasAtNewest=state.last>=Math.max(0,list.length-1);
  if(!wasAtNewest){if(alreadyRendered)messages.querySelector(':scope > .message:last-of-type')?.remove();return}
  if(!alreadyRendered){historyRendering=true;renderHistoryItem(entry);historyRendering=false}state.last=list.length;trimVirtualStart(state)
}
function paintConversationWindow(state,{pinLatest=true}={}){
  const started=performance.now(),fragment=document.createDocumentFragment();historyRendering=true;for(let index=state.first;index<state.last;index++)renderHistoryItem(state.items[index],fragment);historyRendering=false;messages.replaceChildren(fragment);if(!state.items.length)historyEmptyState();recordMetric('history.render_ms',performance.now()-started);if(pinLatest)scrollConversationToLatest()
}
function createConversationState(key,items,{nextBefore=null,hasOlder=false}={}){const list=Array.isArray(items)?items:[];conversationHistories[key]=list;const state={key,items:list,first:Math.max(0,list.length-HISTORY_DOM_LIMIT),last:list.length,nextBefore,hasOlder:!!hasOlder,loading:false,generation:conversationLoadGeneration};conversationRenderState=state;paintConversationWindow(state);return state}
async function loadOlderConversation(){
  const state=conversationRenderState;if(!state||state.loading||state.key!==activeConversationKey)return;const oldHeight=messages.scrollHeight,oldTop=messages.scrollTop;
  if(state.first>0){const next=Math.max(0,state.first-Math.min(40,HISTORY_DOM_LIMIT)),fragment=document.createDocumentFragment();historyRendering=true;for(let index=next;index<state.first;index++)renderHistoryItem(state.items[index],fragment);historyRendering=false;messages.prepend(fragment);state.first=next;while(messages.querySelectorAll(':scope > .message').length>HISTORY_DOM_LIMIT){messages.querySelector(':scope > .message:last-of-type')?.remove();state.last--}messages.scrollTop=oldTop+messages.scrollHeight-oldHeight;return}
  if(!state.hasOlder||!state.nextBefore||!window.pairHistory||!/^[a-f0-9]{32}$/.test(directoryUserId))return;if(state.items.length>=HISTORY_CACHE_LIMIT){state.hasOlder=false;return}state.loading=true;
  try{const result=await window.pairHistory.list(directoryUserId,state.key,{before:state.nextBefore,limit:Math.min(HISTORY_PAGE_SIZE,HISTORY_CACHE_LIMIT-state.items.length)});if(conversationRenderState!==state||state.key!==activeConversationKey)return;const existingRows=new Set(state.items.map(item=>item._historyRowId).filter(Boolean)),older=(result.items||[]).filter(item=>!existingRows.has(item.rowId)).map(item=>({...item.entry,_historyRowId:item.rowId}));if(!older.length){state.hasOlder=false;state.nextBefore=null;return}const fragment=document.createDocumentFragment();historyRendering=true;for(const item of older)renderHistoryItem(item,fragment);historyRendering=false;state.items.unshift(...older);conversationHistories[state.key]=state.items;state.last+=older.length;messages.prepend(fragment);state.nextBefore=result.nextBefore;state.hasOlder=!!result.hasOlder&&state.items.length<HISTORY_CACHE_LIMIT;while(messages.querySelectorAll(':scope > .message').length>HISTORY_DOM_LIMIT){messages.querySelector(':scope > .message:last-of-type')?.remove();state.last--}messages.scrollTop=oldTop+messages.scrollHeight-oldHeight}catch(error){console.warn('[history] older page failed:',error?.message||error)}finally{state.loading=false}
}
function showNewerConversation(){
  const state=conversationRenderState;if(!state||state.key!==activeConversationKey||state.last>=state.items.length)return;const beforeHeight=messages.scrollHeight,beforeTop=messages.scrollTop,next=Math.min(state.items.length,state.last+40),fragment=document.createDocumentFragment();historyRendering=true;for(let index=state.last;index<next;index++)renderHistoryItem(state.items[index],fragment);historyRendering=false;messages.append(fragment);state.last=next;while(messages.querySelectorAll(':scope > .message').length>HISTORY_DOM_LIMIT){messages.querySelector(':scope > .message')?.remove();state.first++}messages.scrollTop=Math.max(0,beforeTop-(beforeHeight-messages.scrollHeight))
}
let historyScrollFrame=0;messages.addEventListener('scroll',()=>{if(historyScrollFrame)return;historyScrollFrame=requestAnimationFrame(()=>{historyScrollFrame=0;const state=conversationRenderState;if(!state||state.key!==activeConversationKey)return;if(messages.scrollTop<90)void loadOlderConversation();if(messages.scrollHeight-messages.scrollTop-messages.clientHeight<90)showNewerConversation()})});
function openConversation(key){
  saveConversationDraft();activeConversationKey=key;const generation=++conversationLoadGeneration,cached=conversationHistories[key];restoreConversationDraft(key);
  if(!window.pairHistory||!/^[a-f0-9]{32}$/.test(directoryUserId)){createConversationState(key,cached||[]);return Promise.resolve(conversationRenderState)}
  messages.replaceChildren();historyEmptyState('Loading encrypted history…');
  return window.pairHistory.list(directoryUserId,key,{limit:HISTORY_DOM_LIMIT}).then(result=>{if(generation!==conversationLoadGeneration||activeConversationKey!==key)return null;const items=(result.items||[]).map(item=>({...item.entry,_historyRowId:item.rowId})),pending=conversationHistories[key]||[];for(const entry of pending)if(!items.some(item=>entry.id&&item.id===entry.id||!entry.id&&item.time===entry.time&&item.text===entry.text))items.push(entry);items.sort((a,b)=>(Number(a.time)||0)-(Number(b.time)||0)||String(a.id||'').localeCompare(String(b.id||'')));return createConversationState(key,items,{nextBefore:result.nextBefore,hasOlder:result.hasOlder})}).catch(error=>{if(generation!==conversationLoadGeneration||activeConversationKey!==key)return null;console.warn('[history] open failed:',error?.message||error);return createConversationState(key,cached||[])})
}
function applyFriendProfile(friend){if(!friend)return;friendName=normalizeProfileName(friend.name,'Friend');setAvatar(friendAvatar,friend.image||'');setAvatarFrame(friendAvatar,friend.frame);setAvatarIdentity(friendAvatar,friend.id);renderParticipantNames();roomTitle.textContent=friendName;$('#chatTitle').textContent=friendName;$('#roomContextLabel').textContent='DIRECT MESSAGE';$('#chatModePill').textContent='DIRECT';messageInput.placeholder='Message '+friendName;messageInput.setAttribute('aria-label','Message '+friendName);}
function renderCallPeerProfile(){const friend=directoryUser(dmCallPeerId);if(!friend)return;friendNameEl.textContent=normalizeProfileName(friend.name,'Friend');setAvatar(friendAvatar,friend.image||'');setAvatarFrame(friendAvatar,friend.frame);setAvatarIdentity(friendAvatar,friend.id);renderDmVoiceUI();refreshSpeakingPaint()}
function setSocialSidebarCollapsed(collapsed,persist=true){document.body.classList.toggle('social-sidebar-collapsed',!!collapsed);const toggle=$('#sidebarToggle');if(toggle){toggle.textContent=collapsed?'›':'‹';toggle.setAttribute('aria-expanded',String(!collapsed));toggle.setAttribute('aria-label',(collapsed?'Open':'Collapse')+' friends and channels panel');toggle.title=(collapsed?'Open':'Collapse')+' panel'}if(persist)ssSet('socialSidebarCollapsed',collapsed?'on':'off')}
function collapseNavigationOnMobile(){if(window.innerWidth<=670)setSocialSidebarCollapsed(true,false)}
function sidebarWidthLimit(){const rail=window.innerWidth<=670?56:window.innerWidth<=900?60:72;return Math.max(190,Math.min(420,window.innerWidth-rail-360))}
function setSocialSidebarWidth(value,persist=true){socialSidebarWidth=Math.max(190,Math.min(sidebarWidthLimit(),Number(value)||280));$('.app-shell')?.style.setProperty('--social-sidebar-width',socialSidebarWidth+'px');if(persist)ssSet('socialSidebarWidth',String(Math.round(socialSidebarWidth)))}
async function installSidebarLayout(){const toggle=$('#sidebarToggle'),handle=$('#sidebarResize');setSocialSidebarWidth(Number(await ss('socialSidebarWidth'))||280,false);setSocialSidebarCollapsed((await ss('socialSidebarCollapsed'))==='on',false);toggle.onclick=()=>setSocialSidebarCollapsed(!document.body.classList.contains('social-sidebar-collapsed'));let startX=0,startWidth=0;handle.addEventListener('pointerdown',event=>{if(document.body.classList.contains('social-sidebar-collapsed'))return;startX=event.clientX;startWidth=socialSidebarWidth;handle.setPointerCapture(event.pointerId);document.body.classList.add('sidebar-resizing')});handle.addEventListener('pointermove',event=>{if(!handle.hasPointerCapture(event.pointerId))return;setSocialSidebarWidth(startWidth+event.clientX-startX,false)});const finish=event=>{if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);if(document.body.classList.contains('sidebar-resizing')){document.body.classList.remove('sidebar-resizing');setSocialSidebarWidth(socialSidebarWidth)}};handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('dblclick',()=>setSocialSidebarWidth(280));handle.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home'].includes(event.key))return;event.preventDefault();setSocialSidebarWidth(event.key==='Home'?280:socialSidebarWidth+(event.key==='ArrowLeft'?-16:16))});window.addEventListener('resize',()=>setSocialSidebarWidth(socialSidebarWidth,false))}
async function installVoicePanelResize(){const handle=$('#voicePanelResize');if(!handle)return;let height=Math.max(260,Math.min(innerHeight-150,Number(await ss('dmCallPanelHeight'))||430)),startY=0,startHeight=height;const apply=(value,persist=false)=>{height=Math.max(260,Math.min(innerHeight-150,Number(value)||430));voicePanel.style.setProperty('--dm-call-height',height+'px');if(persist)ssSet('dmCallPanelHeight',String(Math.round(height)))};apply(height);handle.addEventListener('pointerdown',event=>{if(event.button!==0)return;startY=event.clientY;startHeight=voicePanel.getBoundingClientRect().height;handle.setPointerCapture(event.pointerId);voicePanel.classList.add('resizing')});handle.addEventListener('pointermove',event=>{if(handle.hasPointerCapture(event.pointerId))apply(startHeight+event.clientY-startY)});const finish=event=>{if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);if(voicePanel.classList.contains('resizing')){voicePanel.classList.remove('resizing');apply(height,true)}};handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('dblclick',()=>apply(430,true));handle.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown','Home'].includes(event.key))return;event.preventDefault();apply(event.key==='Home'?430:height+(event.key==='ArrowUp'?-24:24),true)});window.addEventListener('resize',()=>apply(height))}
function persistClosedDms(){ssSet('closedDmIds',JSON.stringify([...closedDmIds]))}
function compactDirectoryUser(user){
  if(!user||!/^[a-f0-9]{32}$/.test(String(user.id||'')))return null;
  const image=typeof user.image==='string'&&!user.image.startsWith('data:')?user.image:'';
  return{id:user.id,name:user.name||'Knot user',username:user.username||'',image,frame:user.frame&&typeof user.frame==='object'?user.frame:undefined,deviceKey:user.deviceKey||undefined,online:!!user.online};
}
function compactDirectoryEntity(entity){
  if(!entity||!/^[a-f0-9]{32}$/.test(String(entity.id||'')))return null;
  const copy={id:entity.id,name:entity.name||'',owner:entity.owner,members:Array.isArray(entity.members)?entity.members.filter(id=>/^[a-f0-9]{32}$/.test(id)):[],channels:Array.isArray(entity.channels)?entity.channels:[],kind:entity.kind};
  if(entity.keyEpoch)copy.keyEpoch=entity.keyEpoch;if(entity.keySteward)copy.keySteward=entity.keySteward;
  if(typeof entity.picture==='string'&&!entity.picture.startsWith('data:'))copy.picture=entity.picture;
  return copy;
}
function persistDirectoryRoster(){
  ssSet('directoryRosterCache',JSON.stringify({self:compactDirectoryUser(directorySnapshot.self),friends:(directorySnapshot.friends||[]).map(compactDirectoryUser).filter(Boolean),servers:(directorySnapshot.servers||[]).map(compactDirectoryEntity).filter(Boolean),groupDms:(directorySnapshot.groupDms||[]).map(compactDirectoryEntity).filter(Boolean)}));
  void refreshLanFingerprints();
}
function restoreDirectoryRosterCache(raw){
  try{
    const cached=typeof raw==='string'?JSON.parse(raw):raw;if(!cached||typeof cached!=='object')return false;
    const friends=Array.isArray(cached.friends)?cached.friends.map(compactDirectoryUser).filter(Boolean):[];
    const servers=Array.isArray(cached.servers)?cached.servers.map(compactDirectoryEntity).filter(Boolean):[];
    const groupDms=Array.isArray(cached.groupDms)?cached.groupDms.map(compactDirectoryEntity).filter(Boolean):[];
    if(!friends.length&&!servers.length&&!groupDms.length)return false;
    directorySnapshot={...directorySnapshot,self:compactDirectoryUser(cached.self)||directorySnapshot.self,friends,servers,groupDms};
    return true;
  }catch{return false}
}
function reopenDm(id){closedDmIds.delete(id);persistClosedDms();selectFriend(id)}
function closeDm(id){closedDmIds.add(id);persistClosedDms();if(activePeerId===id||activeGroupDmId===id){activePeerId='';activeGroupDmId='';activeServerId='';showFriendsLanding()}renderFriends()}
function removeFriend(id){const friend=directoryUser(id);if(!friend||!confirm('Remove '+(friend.name||'this friend')+' from your friend list?'))return;directorySend({type:'remove-friend',peerId:id})}
function renderGroupDmActions(){const actions=$('#groupDmActions'),call=$('#groupDmCall'),add=$('#groupDmAddPeople'),leave=$('#groupDmLeave'),direct=!!activePeerId&&!activeServerId,group=groupDm(activeGroupDmId);if(!actions)return;actions.hidden=!direct&&!group;if(call){const voice=group?.channels?.find(channel=>channel.type==='voice'),joined=!!group&&!!serverVoiceStream&&joinedVoiceServerId===group.id,joining=!!group&&serverVoiceAttempt?.serverId===group.id,switching=!!group&&!!serverVoiceStream&&!joined,others=voice?(directorySnapshot.voiceStates?.[voice.id]||[]).filter(entry=>entry.id!==directoryUserId).length:0,label=joining?'Cancel joining':joined?'Leave call':switching?'Switch call':others?'Join call':'Start call',description=joining?'Cancel joining '+groupDmDisplayName(group):joined?'Leave '+groupDmDisplayName(group)+' call':switching?'Leave the current voice call and join '+groupDmDisplayName(group):others?'Join '+groupDmDisplayName(group)+' call':'Start a call in '+groupDmDisplayName(group);call.hidden=!group||!voice;call.disabled=!voice;call.classList.toggle('active',joined||joining);call.querySelector('span').textContent=label;call.querySelector('use')?.setAttribute('href',joined||joining?'#icon-call-end':'#icon-call-start');call.setAttribute('aria-label',description);call.title=description}if(add){add.hidden=!direct&&!group;add.textContent=group?'Add people':'Create group';add.setAttribute('aria-label',group?'Add friends to '+groupDmDisplayName(group):'Add friends to this direct message')}if(leave){leave.hidden=!group;leave.setAttribute('aria-label',group?'Leave '+groupDmDisplayName(group):'Leave group DM')}}
function installGroupDmCallControl(){const control=$('#groupDmCall');if(!control)return;control.onclick=()=>callBtn.click();new MutationObserver(()=>{if(activeGroupDmId)renderGroupDmActions()}).observe(callBtn,{attributes:true,attributeFilter:['data-call-state','disabled','hidden'],childList:true,subtree:true})}
function showFriendsLanding(){saveConversationDraft();activeConversationKey='';conversationRenderState=null;conversationLoadGeneration++;activePeerId='';activeGroupDmId='';activeServerId='';activeChannelId='';document.body.classList.remove('group-dm-view');messageInput.value='';setPendingGif(null);roomTitle.textContent='Friends';$('#chatTitle').textContent='Friends';$('#roomContextLabel').textContent='DIRECT MESSAGES';$('#chatModePill').textContent='FRIENDS';messageInput.placeholder='Select a direct message';messageInput.setAttribute('aria-label','Select a direct message');syncComposerAvailability(true);messageForm.querySelector('.send').disabled=true;messages.replaceChildren();const roster=document.createElement('section');roster.className='friends-roster';const heading=document.createElement('div');heading.className='friends-roster-heading';heading.innerHTML='<div><strong>All friends</strong><span>Message friends, see who is online, or remove an old device identity.</span></div>';roster.append(heading);for(const friend of directorySnapshot.friends||[]){const row=document.createElement('article');row.className='friends-roster-row';const avatar=document.createElement('span');avatar.className='friend-avatar';paintDirectoryAvatar(avatar,friend);const dot=document.createElement('i');dot.classList.toggle('online',!!(friend.online||friendOnLan(friend.id)));avatar.append(dot);const copy=document.createElement('span');copy.className='friend-copy';const name=document.createElement('strong');name.textContent=friend.name||'Knot user';const status=document.createElement('small');status.textContent=friendOnLan(friend.id)?'On this Wi-Fi':friend.online?'Online':'Offline';if(friendOnLan(friend.id)){const chip=document.createElement('span');chip.className='lan-chip';chip.textContent='Wi-Fi';status.append(chip)}copy.append(name,status);const message=document.createElement('button');message.type='button';message.textContent='Message';message.onclick=()=>reopenDm(friend.id);const remove=document.createElement('button');remove.type='button';remove.className='text-button danger';remove.textContent='Remove';remove.onclick=()=>removeFriend(friend.id);row.append(avatar,copy,message,remove);roster.append(row)}if(!(directorySnapshot.friends||[]).length){const empty=document.createElement('p');empty.className='social-empty';empty.textContent='Add a friend with the + button to start talking.';roster.append(empty)}messages.append(roster);renderGroupDmActions();if(dmCallOngoing()||serverVoiceStream){statusText.textContent=serverVoiceStream?(joinedVoiceScope==='group-dm'?'Group call active':'Server voice active'):'Voice call active';$('.connection').classList.add('connected')}else setStatus(lanNeighbors.size?'Friends · house is local':'Friends');renderFriends()}
function dmCallOngoing(){return !!dmCallPeerId&&(callActive||friendInCall||screenActive||remoteScreenExpected)}
function showFriends({expand=true}={}){if(expand)setSocialSidebarCollapsed(false);activeServerId='';activeGroupDmId='';activeChannelId='';document.body.classList.remove('group-dm-view');if(!dmCallOngoing()&&!serverVoiceStream){renderCallButtonState('start','Start call','Start voice call');callStatus.textContent='Voice off';callStatus.className='call-status'}$('#friendsNavigation').hidden=false;$('#serverNavigation').hidden=true;$('#serverMemberPanel').hidden=true;document.body.classList.remove('server-view');document.querySelectorAll('#serverList .rail-button').forEach(button=>button.classList.remove('active'));$('#homeButton').classList.add('active');renderGroupDmActions();
  // Navigation must never be a disconnect button.  Keep the encrypted server
  // mesh alive while its view is hidden, just as a direct call stays alive in
  // the background.  Explicit Leave/room removal still calls closeServerMesh.
  if(serverVoiceStream){$('#serverVoiceStage').hidden=true;renderServerVoiceUI()}if(!activePeerId)showFriendsLanding();renderDmVoiceUI()}
function goHomeWithoutLeavingCall(){const keepDm=dmCallOngoing(),keepServer=!!serverVoiceStream;activePeerId='';showFriends();if(keepDm){syncVoiceStage();renderDmVoiceUI()}if(keepServer){syncServerMesh();renderServerVoiceUI()}}
function installCallSafeHomeButton(){const home=$('#homeButton');if(!home)return;home.onclick=goHomeWithoutLeavingCall}
function activateDmView(friend){if(!friend)return;closedDmIds.delete(friend.id);persistClosedDms();showFriends();activePeerId=friend.id;syncComposerAvailability(false);messageForm.querySelector('.send').disabled=false;applyFriendProfile(friend);openConversation('dm:'+friend.id);clearDmUnread(friend.id,{render:false});renderGroupDmActions();renderFriends();syncActiveDmTransport();collapseNavigationOnMobile()}
async function selectFriend(id,{connect=true}={}){
  const friend=directoryUser(id);if(!friend)return;const backgroundCall=dmCallOngoing()&&dmCallPeerId&&id!==dmCallPeerId;
  activateDmView(friend);
  if(backgroundCall){pairHint.textContent='Your call with '+(directoryUser(dmCallPeerId)?.name||'your friend')+' stays connected while you use this DM.';renderCallPeerProfile();return}
  if(pc&&dmPeerId===id){renderCallPeerProfile();return}
  // Opening a DM must be side-effect free: live text is available from the
  // directory socket and only Call/file actions make a WebRTC peer.
  if(!friend.online)pairHint.textContent=friendName+' is offline. Your encrypted messages will wait until they return.';
  syncActiveDmTransport();
}
async function selectGroupDm(id){
  const group=groupDm(id);if(!group)return;closedDmIds.delete(id);persistClosedDms();showFriends();activePeerId='';activeGroupDmId=id;activeServerId=id;document.body.classList.add('group-dm-view');$('#friendsNavigation').hidden=false;$('#serverNavigation').hidden=true;$('#serverMemberPanel').hidden=true;const textChannel=group.channels?.find(channel=>channel.type==='text');if(!textChannel)return showFriendsLanding();activeChannelId=textChannel.id;const name=groupDmDisplayName(group);roomTitle.textContent=name;$('#chatTitle').textContent=name;$('#roomContextLabel').textContent='GROUP DIRECT MESSAGE';$('#chatModePill').textContent='E2EE GROUP';messageInput.placeholder='Message '+name;messageInput.setAttribute('aria-label','Message '+name);syncComposerAvailability(false);messageForm.querySelector('.send').disabled=false;fileInput.disabled=true;syncFileAttachmentUi();openConversation(serverHistoryKey(group.id,textChannel.id));clearDmUnread(group.id,{render:false});renderGroupDmActions();renderFriends();renderUnreadBadges();const joined=!!serverVoiceStream&&joinedVoiceServerId===group.id;renderCallButtonState(joined?'end':'start',joined?'Leave call':'Start group call',joined?'Leave group call':'Start group voice call');callStatus.textContent=joined?'Group call connected':'Voice off';callStatus.className=joined?'call-status live':'call-status';setServerStatus('Encrypted group text · offline delivery ready',true);const key=await serverTextKey(group,{create:(group.keySteward||group.owner)===directoryUserId});if(!key){await requestServerTextKey(group);pairHint.textContent='Waiting for a group member to share this group’s current secure key.'}else pairHint.textContent='Messages are end-to-end encrypted and can queue while group members are offline.';if(joined){syncServerMesh();renderServerVoiceUI()}collapseNavigationOnMobile()
}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
async function waitForDmMediaConnection(peerId,plan,timeoutMs){
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){
    if(plan?.cancelled)return false;
    if(pc&&dmPeerId===peerId){
      if(pc.connectionState==='connected')return true;
      if(['failed','closed'].includes(pc.connectionState))return false;
    }
    await delay(100);
  }
  return !!(pc&&dmPeerId===peerId&&pc.connectionState==='connected');
}
function abandonDmMediaAttempt(peerId){
  if(pc||signaling)disconnectRoom({preserveCall:true});
  dmPeerId=peerId;dmConnectingPeerId=peerId;syncActiveDmTransport();
}
async function ensureDmMediaConnection(peerId=activePeerId,{requireFileChannel=false}={}){
  const friend=directoryUser(peerId);if(!peerId||!friendReachable(peerId))throw new Error('Your friend is offline');
  if(!friend?.online&&friendOnLan(peerId))return lanEnsureMedia(peerId);
  if(dmMediaPlan?.peerId===peerId)return dmMediaPlan.promise;
  if(pc&&dmPeerId===peerId&&['connected','connecting','new'].includes(pc.connectionState))return pc;
  if(dmCallOngoing()&&dmCallPeerId!==peerId)throw new Error('End the current voice call before starting another direct connection');
  if(dmMediaPlan)dmMediaPlan.cancelled=true;
  const plan={peerId,cancelled:false,promise:null};dmMediaPlan=plan;dmConnectingPeerId=peerId;syncActiveDmTransport();
  plan.promise=(async()=>{
    for(let attempt=1;attempt<=3;attempt++){
      if(plan.cancelled)throw new Error('A peer connection was started from the other side');
      dmIceServers=directIceServers();relayVoiceMode=false;
      const session=clientHex(16);pairHint.textContent='Trying direct peer connection '+attempt+' of 3…';
      if(!directorySend({type:'connect',peerId,session,context:{type:'dm',relay:false}}))throw new Error('Knot signaling is offline');
      const resumeVoice=pendingVoiceStartPeerId===peerId;
      await automaticPair('host',session,peerId);
      if(resumeVoice)pendingVoiceStartPeerId=peerId;
      if(await waitForDmMediaConnection(peerId,plan,12000))return pc;
      if(plan.cancelled)throw new Error('A peer connection was started from the other side');
      abandonDmMediaAttempt(peerId);
      if(attempt<3)await delay(350*attempt);
    }
    if(plan.cancelled)throw new Error('A peer connection was started from the other side');
    // TURN fallback is intentionally voice-only and has no `files` channel.
    // A file request must stop here instead of silently connecting to that
    // fallback and waiting for a channel which will never be created.
    if(requireFileChannel)throw new Error('Could not establish a direct file connection. Files are not sent through the voice relay.');
    pairHint.textContent='Direct connection failed. Preparing low-bandwidth voice relay…';
    dmIceServers=await requestTurnCredentials();relayVoiceMode=true;
    const session=clientHex(16);
    if(!directorySend({type:'connect',peerId,session,context:{type:'dm',relay:true}}))throw new Error('Knot signaling is offline');
    const resumeVoice=pendingVoiceStartPeerId===peerId;
    await automaticPair('host',session,peerId);
    if(resumeVoice)pendingVoiceStartPeerId=peerId;
    if(await waitForDmMediaConnection(peerId,plan,15000))return pc;
    throw new Error('Could not connect the voice relay. Text still works.');
  })();
  try{const connected=await plan.promise;if(activePeerId===peerId)applyFriendProfile(friend);renderCallPeerProfile();return connected}
  finally{if(dmMediaPlan===plan)dmMediaPlan=null;if(!pc||pc.connectionState!=='connected')relayVoiceMode=false;syncActiveDmTransport()}
}
function paintDirectoryAvatar(avatar,user){setAvatar(avatar,user?.image||'');setAvatarFrame(avatar,user?.frame);setAvatarIdentity(avatar,user?.id||'');if(!validProfileData(user?.image))avatar.textContent=(user?.name||'?').slice(0,1).toUpperCase()}
function renderFriends(){
  const list=$('#friendList');if(!list)return;const query=($('#friendSearch')?.value||'').trim().toLocaleLowerCase(),groups=(directorySnapshot.groupDms||[]).filter(group=>(query||!closedDmIds.has(group.id)||unreadDmCount(group.id)>0)&&(!query||groupDmDisplayName(group).toLocaleLowerCase().includes(query)||groupDmMembers(group).some(member=>(member.name||'').toLocaleLowerCase().includes(query)))),friends=(directorySnapshot.friends||[]).filter(friend=>(query||!closedDmIds.has(friend.id)||unreadDmCount(friend.id)>0)&&(!query||(friend.name||'Knot user').toLocaleLowerCase().includes(query)));list.replaceChildren();
  for(const group of groups){
    const inCall=!!serverVoiceStream&&joinedVoiceServerId===group.id,others=groupDmMembers(group,{includeSelf:false}),online=others.filter(member=>member.online||friendOnLan(member.id)).length,button=document.createElement('button');button.type='button';button.className='friend-entry group-dm-entry'+(group.id===activeGroupDmId?' active':'')+(inCall?' in-call':'')+(online?' has-online':'');button.dataset.id=group.id;button.dataset.kind='group-dm';button.setAttribute('aria-label',groupDmDisplayName(group)+', '+group.members.length+' members'+(inCall?', in voice':online?', '+online+' online':''));button.append(makeStackedAvatars(group));const copy=document.createElement('span');copy.className='friend-copy';const name=document.createElement('strong');name.textContent=groupDmDisplayName(group);const status=document.createElement('small');status.textContent=inCall?'In group call':group.members.length+' members · '+online+' online';copy.append(name,status);button.append(copy);const unread=unreadDmCount(group.id);if(unread){const badge=document.createElement('span');badge.className='dm-unread-badge';badge.textContent=unread>99?'99+':String(unread);badge.setAttribute('aria-label',unread+' unread '+(unread===1?'message':'messages'));button.append(badge);button.classList.add('has-unread')}button.onclick=()=>selectGroupDm(group.id);const row=document.createElement('div');row.className='friend-row group-dm-row';const close=document.createElement('button');close.type='button';close.className='dm-close';close.textContent='×';close.title='Close group DM';close.setAttribute('aria-label','Close '+groupDmDisplayName(group));close.onclick=event=>{event.stopPropagation();closeDm(group.id)};row.append(button,close);list.append(row)
  }
  for(const friend of friends){
    const inCall=friend.id===dmCallPeerId&&dmCallOngoing(),lan=!!friendOnLan(friend.id),button=document.createElement('button');button.type='button';button.className='friend-entry'+(friend.id===activePeerId&&!activeServerId?' active':'')+(inCall?' in-call':'')+(lan?' on-lan':'');button.dataset.id=friend.id;button.setAttribute('aria-label',(friend.name||'Knot user')+', '+(inCall?'in voice':lan?'on this Wi-Fi':friend.online?'online':'offline'));
    const avatar=document.createElement('span');avatar.className='friend-avatar';paintDirectoryAvatar(avatar,friend);const dot=document.createElement('i');dot.classList.toggle('online',!!(friend.online||lan));avatar.append(dot);if(inCall)avatar.dataset.speakingId='dm-friend';
    const copy=document.createElement('span');copy.className='friend-copy';const name=document.createElement('strong');name.textContent=friend.name||'Knot user';const status=document.createElement('small');status.textContent=inCall?'In voice':lan?'On this Wi-Fi':friend.online?'Online':'Offline · messages queue';copy.append(name,status);button.append(avatar,copy);const unread=unreadDmCount(friend.id);if(unread){const badge=document.createElement('span');badge.className='dm-unread-badge';badge.textContent=unread>99?'99+':String(unread);badge.setAttribute('aria-label',unread+' unread '+(unread===1?'message':'messages'));button.append(badge);button.classList.add('has-unread')}button.onclick=()=>selectFriend(friend.id);const row=document.createElement('div');row.className='friend-row';const close=document.createElement('button');close.type='button';close.className='dm-close';close.textContent='×';close.title='Close direct message';close.setAttribute('aria-label','Close direct message with '+(friend.name||'Knot user'));close.onclick=event=>{event.stopPropagation();closeDm(friend.id)};row.append(button,close);list.append(row)
  }
  if(!list.children.length){const empty=document.createElement('p');empty.className='social-empty';empty.textContent=query?'No conversations match your search.':'Create a friend code, then start a direct or group message.';list.append(empty)}refreshSpeakingPaint();
}
function serverInitial(server){return cleanClientName(server?.name,'S').slice(0,2).toUpperCase()}
function cleanClientName(value,fallback=''){return String(value||'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,48)||fallback}
function renderServers(){const list=$('#serverList');if(!list)return;list.replaceChildren();for(const server of directorySnapshot.servers||[]){const button=document.createElement('button');button.type='button';button.className='rail-button'+(server.id===activeServerId&&!activeGroupDmId?' active':'');button.title=server.name;button.setAttribute('aria-label',server.name);button.textContent=serverInitial(server);if(validProfileData(server.picture)){button.style.backgroundImage='url("'+server.picture.replace(/"/g,'%22')+'")';button.textContent=''}button.onclick=()=>selectServer(server.id);list.append(button)}}
function activeServer(){return conversationEntity(activeServerId)}
function activeChannel(){return activeServer()?.channels?.find(channel=>channel.id===activeChannelId)||null}
function canEditServer(server=activeServer()){return !!server&&!isGroupDm(server)&&server.owner===directoryUserId}
function setServerStatus(text,connected=false){statusText.textContent=text;$('.connection').classList.toggle('connected',connected);callBtn.disabled=false;screenBtn.disabled=true}
function voiceChannelEntries(channelId){const entries=[...(directorySnapshot.voiceStates?.[channelId]||[])];if(channelId===joinedVoiceChannelId&&!entries.some(entry=>entry.id===directoryUserId))entries.push({id:directoryUserId,joinedAt:joinedVoiceAt||Date.now()});return entries}
function voiceElapsed(joinedAt){const seconds=Math.max(0,Math.floor((Date.now()-(Number(joinedAt)||Date.now()))/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),rest=seconds%60;return hours?hours+':'+String(minutes).padStart(2,'0')+':'+String(rest).padStart(2,'0'):minutes+':'+String(rest).padStart(2,'0')}
function refreshVoiceElapsed(){document.querySelectorAll('[data-voice-joined]').forEach(node=>{node.textContent=voiceElapsed(node.dataset.voiceJoined)});if(joinedVoiceChannelId){const value=voiceElapsed(joinedVoiceAt);const dock=$('#serverVoiceDockTime'),stage=$('#serverVoiceStageTime');if(dock)dock.textContent=value;if(stage)stage.textContent=value}const dmTime=$('#dmVoiceDockTime');if(dmTime&&(callActive||friendInCall))dmTime.textContent=voiceElapsed(callStart||Date.now())}
function scheduleVoiceElapsed(){clearInterval(voiceElapsedTimer);if(joinedVoiceChannelId||document.querySelector('[data-voice-joined]')){refreshVoiceElapsed();voiceElapsedTimer=setInterval(refreshVoiceElapsed,1000)}}
function renderVoiceParticipants(channelId,container){for(const entry of voiceChannelEntries(channelId)){const member=directorySnapshot.members?.[entry.id]||(entry.id===directoryUserId?directorySnapshot.self:null);if(!member)continue;const row=document.createElement('div');row.className='voice-channel-member';const avatar=document.createElement('span');avatar.className='friend-avatar';avatar.dataset.speakingId=entry.id;paintDirectoryAvatar(avatar,member);const name=document.createElement('span');name.textContent=(member.name||'Knot user')+(entry.id===directoryUserId?' (you)':'');const elapsed=document.createElement('time');elapsed.dataset.voiceJoined=String(entry.joinedAt||Date.now());row.append(avatar,name,elapsed);container.append(row)}refreshSpeakingPaint()}
function moveChannel(sourceId,targetId,after){const server=activeServer(),source=server?.channels.find(channel=>channel.id===sourceId),target=server?.channels.find(channel=>channel.id===targetId);if(!canEditServer(server)||!source||!target||source.type!==target.type||source.id===target.id)return;const channels=server.channels.filter(channel=>channel.id!==sourceId),targetIndex=channels.findIndex(channel=>channel.id===targetId);channels.splice(targetIndex+(after?1:0),0,source);server.channels=channels;renderChannels();directorySend({type:'reorder-channels',serverId:server.id,channelIds:channels.map(channel=>channel.id)})}
function createChannelRow(server,channel){const owner=canEditServer(server),item=document.createElement('div');item.className='channel-item'+(channel.id===activeChannelId?' active':'');item.dataset.id=channel.id;item.dataset.type=channel.type;item.draggable=owner;const button=document.createElement('button');button.type='button';button.className='channel-entry '+channel.type;button.textContent=channel.name;button.title=channel.type==='voice'?'Click to select · double-click to join':'Open #'+channel.name;button.onclick=()=>selectServerChannel(server.id,channel.id);if(channel.type==='voice')button.ondblclick=async event=>{event.preventDefault();await selectServerChannel(server.id,channel.id);await joinServerVoice()};item.append(button);if(owner){const controls=document.createElement('span');controls.className='channel-row-controls';const drag=document.createElement('button');drag.type='button';drag.className='channel-drag';drag.textContent='⠇';drag.title='Drag, or press Alt + Up/Down, to reorder';drag.setAttribute('aria-label','Reorder '+channel.name);drag.onkeydown=event=>{if(!event.altKey||!['ArrowUp','ArrowDown'].includes(event.key))return;const peers=server.channels.filter(value=>value.type===channel.type),index=peers.findIndex(value=>value.id===channel.id),target=peers[index+(event.key==='ArrowUp'?-1:1)];if(!target)return;event.preventDefault();event.stopPropagation();moveChannel(channel.id,target.id,event.key==='ArrowDown');requestAnimationFrame(()=>document.querySelector('.channel-item[data-id="'+channel.id+'"] .channel-drag')?.focus())};const remove=document.createElement('button');remove.type='button';remove.className='channel-remove';remove.textContent='×';remove.title='Delete channel';remove.setAttribute('aria-label','Delete '+channel.name);remove.onclick=event=>{event.stopPropagation();remove.disabled=true;directorySend({type:'delete-channel',serverId:server.id,channelId:channel.id})};controls.append(drag,remove);item.append(controls);item.ondragstart=event=>{draggedChannelId=channel.id;item.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',channel.id)};item.ondragend=()=>{draggedChannelId='';document.querySelectorAll('.channel-item').forEach(row=>row.classList.remove('dragging','drop-before','drop-after'))};item.ondragover=event=>{const source=server.channels.find(value=>value.id===draggedChannelId);if(!source||source.type!==channel.type||source.id===channel.id)return;event.preventDefault();const after=event.clientY>item.getBoundingClientRect().top+item.offsetHeight/2;item.classList.toggle('drop-before',!after);item.classList.toggle('drop-after',after)};item.ondrop=event=>{event.preventDefault();const after=item.classList.contains('drop-after');moveChannel(draggedChannelId,channel.id,after)}}if(channel.type==='voice'){const participants=document.createElement('div');participants.className='voice-channel-members';renderVoiceParticipants(channel.id,participants);item.append(participants)}return item}
function serverScreenSharing(){return !!(serverScreenStream||serverNativeScreenSession)}
function renderServerVoiceUI(){const server=activeServer(),channel=server?.channels?.find(item=>item.id===joinedVoiceChannelId),connected=!!(serverVoiceStream&&channel);const dock=$('#serverVoiceDock'),stage=$('#serverVoiceStage');dock.hidden=!connected;stage.hidden=!connected;document.body.classList.toggle('server-voice-connected',connected);if(!connected)return;$('#serverVoiceDockChannel').textContent=channel.name;$('#serverVoiceStageChannel').textContent=channel.name;const members=$('#serverVoiceStageMembers');members.replaceChildren();for(const entry of voiceChannelEntries(channel.id)){const member=directoryDisplayUser(entry.id,{online:true});if(!member)continue;const card=document.createElement('div');card.className='server-stage-member';const avatar=document.createElement('span');avatar.className='server-stage-avatar';avatar.dataset.speakingId=entry.id;paintDirectoryAvatar(avatar,member);const name=document.createElement('strong');name.textContent=(member.name||'Knot user')+(entry.id===directoryUserId?' (you)':'');card.append(avatar,name);members.append(card)}const muted=serverVoiceMuted;for(const id of ['serverVoiceMute','serverStageMute']){const button=$('#'+id);button.classList.toggle('active',muted);button.setAttribute('aria-label',muted?'Unmute microphone':'Mute microphone');button.title=muted?'Unmute microphone':'Mute microphone'}const sharing=serverScreenSharing();for(const id of ['serverVoiceShare','serverStageShare']){const button=$('#'+id);button.classList.toggle('active',sharing);button.setAttribute('aria-label',groupSfuPilot?'Screen sharing is available on the direct mesh':sharing?'Stop screen sharing':'Share screen');button.title=groupSfuPilot?'Leave the SFU pilot or turn it off to screen share over P2P':sharing?'Stop screen sharing':'Share screen';button.disabled=serverScreenStarting||!!groupSfuPilot}refreshSpeakingPaint();refreshVoiceElapsed()}
function renderDmVoiceUI(){const dock=$('#dmVoiceDock');if(!dock)return;const connected=callActive||friendInCall;dock.hidden=!connected;document.body.classList.toggle('dm-call-connected',connected);placeWatchTogether();if(!connected)return;$('#dmVoiceDockName').textContent=friendInCall?(directoryUser(dmCallPeerId)?.name||friendName||'Direct call'):'Waiting for someone to join';$('#dmVoiceDockTime').textContent=voiceElapsed(callStart||Date.now());$('#dmVoiceMute').classList.toggle('active',micMuted);$('#dmVoiceMute').disabled=!callActive;$('#dmVoiceShare').classList.toggle('active',screenActive||screenStarting);$('#dmVoiceShare').disabled=relayVoiceMode||!callActive||!pc||screenSharePickerPending}
let serverFocusedShareId='';const serverSuppressedShares=new Set();
function serverShareVideo(peerId){if(peerId===directoryUserId)return serverScreenSharing()?$('#serverVoiceScreenPreview'):null;return serverPeers.get(peerId)?.screen||null}
function watchServerShare(peerId){const video=serverShareVideo(peerId);if(!video)return;serverSuppressedShares.delete(peerId);serverFocusedShareId=peerId;renderServerShareExperience()}
function stopWatchingServerShare(peerId=serverFocusedShareId){if(!peerId)return;serverSuppressedShares.add(peerId);const video=serverShareVideo(peerId);try{video?.pause()}catch{};if(serverFocusedShareId===peerId)serverFocusedShareId='';try{if(document.fullscreenElement===video)document.exitFullscreen().catch(()=>{})}catch{}renderServerShareExperience()}
function renderServerShareExperience(){
  const stage=$('#serverVoiceStage'),members=$('#serverVoiceStageMembers'),screens=$('#serverVoiceScreens');if(!stage||!members||!screens)return;
  if(serverFocusedShareId&&!serverShareVideo(serverFocusedShareId))serverFocusedShareId='';const active=serverFocusedShareId&&!serverSuppressedShares.has(serverFocusedShareId)?serverShareVideo(serverFocusedShareId):null;
  for(const video of screens.querySelectorAll('video')){const peerId=video.id==='serverVoiceScreenPreview'?directoryUserId:video.dataset.peerId||'',selected=!!active&&video===active,isLocal=peerId===directoryUserId,state=isLocal?null:serverPeers.get(peerId);video.hidden=!selected;if(isLocal)serverNativeLocalPlayer?.setActive(selected);else state?.nativeScreenPlayer?.setActive(selected);if(!isLocal)try{video.srcObject?.getTracks?.().forEach(track=>{track.enabled=true})}catch{}video.volume=isLocal?0:remoteScreen.volume;video.muted=isLocal||!selected||video.volume===0;if(state?.screenAudio){state.screenAudio.volume=remoteScreen.volume;state.screenAudio.muted=!selected||state.screenAudio.volume===0;try{state.screenAudio.srcObject?.getTracks?.().forEach(track=>{track.enabled=true})}catch{}if(selected&&!state.screenAudio.muted)state.screenAudio.play().catch(()=>{});else try{state.screenAudio.pause()}catch{}}if(selected)video.play().catch(()=>{});else try{video.pause()}catch{}if(!video.dataset.shareMenu){video.dataset.shareMenu='1';video.addEventListener('contextmenu',event=>showShareContextMenu(event,{label:isLocal?'Your stream':(directoryUser(peerId)?.name||'Stream'),volume:!isLocal,stopWatching:()=>stopWatchingServerShare(peerId)}));video.addEventListener('dblclick',()=>stage.requestFullscreen?.().catch(()=>video.requestFullscreen?.().catch(()=>{})))}}
  screens.hidden=!active;members.classList.toggle('watching-share',!!active);stage.classList.toggle('watching-share',!!active);document.body.classList.toggle('screen-share-active',!!active||!screenPreview.hidden||!remoteScreen.hidden);
  for(const card of members.querySelectorAll('.server-stage-member')){const avatar=card.querySelector('[data-speaking-id]'),peerId=avatar?.dataset.speakingId||'',video=serverShareVideo(peerId);card.querySelector('.server-share-badge')?.remove();card.classList.toggle('has-share',!!video);if(!video)continue;const button=document.createElement('button');button.type='button';button.className='server-share-badge';button.innerHTML='<span aria-hidden="true">▣</span><small>LIVE</small>';button.title='Watch '+(peerId===directoryUserId?'your stream':(directoryUser(peerId)?.name||'stream'));button.setAttribute('aria-label',button.title);button.onclick=()=>watchServerShare(peerId);card.prepend(button)}
}
const baseRenderServerVoiceUI=renderServerVoiceUI;renderServerVoiceUI=function(){baseRenderServerVoiceUI();if(serverVoiceStream&&joinedVoiceServerId&&activeServerId!==joinedVoiceServerId){const server=conversationEntity(joinedVoiceServerId),channel=server?.channels?.find(item=>item.id===joinedVoiceChannelId);if(channel){$('#serverVoiceDock').hidden=false;$('#serverVoiceStage').hidden=true;document.body.classList.add('server-voice-connected');$('#serverVoiceDockChannel').textContent=server.name+' · '+channel.name;$('#serverVoiceDockTime').textContent=voiceElapsed(joinedVoiceAt)}}renderServerShareExperience();placeWatchTogether()};
function setMemberPanelCollapsed(collapsed,persist=true){document.body.classList.toggle('server-members-collapsed',!!collapsed);const button=$('#memberPanelToggle');if(button){button.setAttribute('aria-expanded',String(!collapsed));button.setAttribute('aria-label',collapsed?'Show member list':'Hide member list');button.textContent=collapsed?'Show members':'Hide members'}if(persist)ssSet('serverMembersCollapsed',collapsed?'on':'off')}
function renderChannels(){const server=activeServer(),textList=$('#textChannelList'),voiceList=$('#voiceChannelList');if(!server||!textList||!voiceList)return;const owner=canEditServer(server);$('#serverPanelTitle').textContent=server.name;$('#editServerPicture').hidden=!owner;$('#addTextChannel').hidden=!owner;$('#addVoiceChannel').hidden=!owner;textList.replaceChildren();voiceList.replaceChildren();for(const channel of server.channels||[])(channel.type==='voice'?voiceList:textList).append(createChannelRow(server,channel));renderServerMembers();renderServerVoiceUI();scheduleVoiceElapsed()}
function renderServerMembers(){const server=activeServer(),list=$('#serverMemberList'),panel=$('#serverMemberPanel');if(!server||!list||!panel)return;const members=(server.members||[]).map(id=>directoryDisplayUser(id)).filter(Boolean).sort((a,b)=>Number(b.online)-Number(a.online)||(a.name||'').localeCompare(b.name||''));$('#serverMemberCount').textContent=String(server.members?.length||members.length);list.replaceChildren();for(const member of members){const known=!!directoryUser(member.id),button=document.createElement('button');button.type='button';button.className='friend-entry';button.disabled=member.id===directoryUserId||!known;const avatar=document.createElement('span');avatar.className='friend-avatar';paintDirectoryAvatar(avatar,member);const dot=document.createElement('i');dot.classList.toggle('online',!!member.online);avatar.append(dot);const copy=document.createElement('span');copy.className='member-copy';const name=document.createElement('strong');name.textContent=(member.name||'Knot user')+(member.id===directoryUserId?' (you)':'');const status=document.createElement('small');status.textContent=known?(member.online?'Online':'Offline'):'Profile loads when they are online';copy.append(name,status);button.append(avatar,copy);if(member.id!==directoryUserId&&known)button.onclick=()=>selectFriend(member.id);list.append(button)}panel.hidden=false}
function selectServer(id){const server=directorySnapshot.servers?.find(item=>item.id===id);if(!server)return;setSocialSidebarCollapsed(false);
  // A server rail click is browsing, not an instruction to leave a direct or
  // server call.  The call dock remains the owner of those live P2P sessions.
  activePeerId='';activeGroupDmId='';activeServerId=id;document.body.classList.remove('group-dm-view');document.body.classList.add('server-view');$('#friendsNavigation').hidden=true;$('#serverNavigation').hidden=false;$('#serverMemberPanel').hidden=false;$('#homeButton').classList.remove('active');renderGroupDmActions();renderServers();renderChannels();renderDmVoiceUI();const first=server.channels?.find(channel=>channel.type==='text')||server.channels?.[0];if(first)selectServerChannel(id,first.id);collapseNavigationOnMobile()}
async function selectServerChannel(serverId,channelId){const server=(directorySnapshot.servers||[]).find(item=>item.id===serverId),channel=server?.channels?.find(item=>item.id===channelId);if(!server||!channel)return;activeServerId=serverId;activeGroupDmId='';activeChannelId=channelId;activePeerId='';roomTitle.textContent=channel.name;$('#chatTitle').textContent=channel.name;$('#roomContextLabel').textContent=server.name.toUpperCase();$('#chatModePill').textContent=channel.type==='voice'?'VOICE':'P2P MESH';messageInput.placeholder='Message #'+channel.name;messageInput.setAttribute('aria-label','Message '+channel.name+' in '+server.name);openConversation(serverHistoryKey(serverId,channelId));renderChannels();if(channel.type==='voice'&&!serverVoiceStream){setServerStatus('Double-click '+channel.name+' to join voice');renderCallButtonState('start','Join voice','Join voice channel')}else{setServerStatus('Connecting to online server members…');renderCallButtonState(serverVoiceStream?'end':'start',serverVoiceStream?'Leave voice':'Start call',serverVoiceStream?'Leave voice channel':'Start voice call')}syncServerMesh();syncComposerAvailability(false);messageForm.querySelector('.send').disabled=false;fileInput.disabled=true;syncFileAttachmentUi()}
const baseSelectServerChannel=selectServerChannel;
selectServerChannel=async function(serverId,channelId){await baseSelectServerChannel(serverId,channelId);const channel=activeChannel();if(channel?.type==='text'){$('#chatModePill').textContent='ENCRYPTED LIVE';setServerStatus('Encrypted live text · Cloudflare stores no messages',true);const server=activeServer();if(server&&!await serverTextKey(server)){await requestServerTextKey(server);pairHint.textContent='Waiting for an online member to share this server’s secure text key.'}}};
function serverOnlineMembers(serverId=joinedVoiceServerId||activeServerId){const server=conversationEntity(serverId),voiceIds=new Set(voiceChannelEntries(joinedVoiceChannelId).map(entry=>entry.id));return server?(server.members||[]).filter(id=>id!==directoryUserId&&voiceIds.has(id)&&directoryUser(id)?.online):[]}
function serverHistoryKey(serverId,channelId){return (isGroupDm(conversationEntity(serverId))?'group:':'server:')+serverId+':'+channelId}
function normalizeServerHistoryEntry(raw,server,forcedAuthorId=''){if(!raw||typeof raw.text!=='string'||raw.text.length>16000)return null;const authorId=forcedAuthorId||raw.author?.id||(raw.mine?directoryUserId:'');if(!/^[a-f0-9]{32}$/.test(authorId)||!server?.members?.includes(authorId))return null;const gifUrl=typeof raw.gif?.url==='string'&&raw.gif.url.length<=4096?safePreviewUrl(raw.gif.url):null,fallbackUrl=safeExternalUrl(raw.gif?.fallbackUrl),time=Number(raw.time),id=/^[a-f0-9]{32}$/.test(raw.id||'')?raw.id:clientHex(16),member=directoryUser(authorId);return{id,text:raw.text,gif:gifUrl?{url:gifUrl,thumb:typeof raw.gif.thumb==='string'&&safePreviewUrl(raw.gif.thumb)?raw.gif.thumb:gifUrl,fallbackUrl:fallbackUrl?.startsWith('https:')?fallbackUrl:null,emoji:raw.gif?.emoji===true}:null,author:{id:authorId,name:normalizeProfileName(member?.name||raw.author?.name||raw.name,'Server member'),image:'',frame:normalizeFrame(member?.frame||raw.author?.frame||raw.frame)},time:Number.isFinite(time)&&time>0&&time<Date.now()+86400000?time:Date.now(),mine:authorId===directoryUserId}}
function storeServerHistory(serverId,channelId,entries,{render=true}={}){const server=conversationEntity(serverId),channel=server?.channels?.find(item=>item.id===channelId);if(!server||!channel)return 0;const key=serverHistoryKey(serverId,channelId);let added=0;for(const raw of entries||[]){const entry=normalizeServerHistoryEntry(raw,server);if(!entry||!storeConversationEntry(key,entry))continue;added++;if(render&&activeConversationKey===key)syncLiveHistoryWindow(key,entry)}return added}
function syncGroupSfuSettingUi(){const input=$('#groupSfuPilot'),hint=$('#groupSfuPilotHint');if(!input)return;input.checked=groupSfuPilotEnabled;input.disabled=!directoryFeatures.groupSfu;if(hint)hint.textContent=directoryFeatures.groupSfu?'Opt-in pilot available. Group voice uses one SFU upload and falls back to the direct mesh on any setup failure. Media terminates at the configured SFU.':'This Knot server has no SFU gateway configured. Group calls stay on the direct P2P mesh and require no extra account.'}
function groupSfuRpc(action,payload={}){return new Promise((resolve,reject)=>{if(!directorySocket||directorySocket.readyState!==WebSocket.OPEN)return reject(new Error('Knot signaling is offline'));const requestId=clientHex(16),timer=setTimeout(()=>{groupSfuPending.delete(requestId);reject(new Error('SFU request timed out'))},12000);groupSfuPending.set(requestId,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});if(!directorySend({type:'sfu-'+action,requestId,...payload})){clearTimeout(timer);groupSfuPending.delete(requestId);reject(new Error('Could not send the SFU request'))}})}
function addGroupSfuAudio({ownerId,track,stream}){if(!/^[a-f0-9]{32}$/.test(ownerId)||!track||ownerId===directoryUserId)return;const previous=groupSfuAudios.get(ownerId);if(previous){try{previous.pause();previous.srcObject=null;previous.remove()}catch{}}const audio=document.createElement('audio');audio.autoplay=true;audio.hidden=true;audio.srcObject=stream||new MediaStream([track]);document.body.append(audio);groupSfuAudios.set(ownerId,audio);applyMediaElementOutput(audio).catch(()=>{});monitorSpeaking('server:'+ownerId,audio.srcObject);audio.play().catch(()=>{});track.onended=()=>{stopSpeakingMonitor('server:'+ownerId);if(groupSfuAudios.get(ownerId)===audio)groupSfuAudios.delete(ownerId);audio.remove()}}
function clearGroupSfuAudio(){for(const[ownerId,audio]of groupSfuAudios){stopSpeakingMonitor('server:'+ownerId);try{audio.pause();audio.srcObject=null;audio.remove()}catch{}}groupSfuAudios.clear()}
function shouldUseGroupSfu(entity=conversationEntity(joinedVoiceServerId||activeServerId)){return !!(groupSfuPilotEnabled&&directoryFeatures.groupSfu&&isGroupDm(entity)&&window.PairRealtimeSfu?.RealtimeSfuPilot)}
async function closeGroupSfu({notify=true}={}){const pilot=groupSfuPilot;groupSfuPilot=null;groupSfuStarting=false;clearGroupSfuAudio();if(pilot)await pilot.close({notify}).catch(()=>{})}
function fallBackFromGroupSfu(error){if(!groupSfuPilot&&!groupSfuStarting)return;const reason=error?.message||'SFU unavailable';void closeGroupSfu({notify:false});setServerStatus('SFU unavailable · using direct P2P mesh: '+reason);queueMicrotask(syncServerMesh)}
async function startGroupSfu(entity,channel){
  if(!shouldUseGroupSfu(entity)||!serverVoiceStream)return false;await closeGroupSfu();groupSfuStarting=true;const pilot=new window.PairRealtimeSfu.RealtimeSfuPilot({rpc:(action,payload)=>groupSfuRpc(action,{groupId:entity.id,channelId:channel.id,...payload}),onTrack:addGroupSfuAudio,onState:value=>{if(groupSfuPilot!==pilot)return;if(value.state==='connected')setServerStatus('Group voice · experimental SFU connected',true)},onFailure:fallBackFromGroupSfu});groupSfuPilot=pilot;
  try{setServerStatus('Connecting experimental group SFU…');await pilot.start(serverVoiceStream,{entityId:entity.id,channelId:channel.id,scope:'group-dm',ownId:directoryUserId});if(groupSfuPilot!==pilot)return false;groupSfuStarting=false;closeServerMesh();directorySend({type:'sfu-track-request',groupId:entity.id,channelId:channel.id});setServerStatus('Group voice · experimental SFU pilot',true);renderServerVoiceUI();return true}catch(error){if(groupSfuPilot===pilot){groupSfuPilot=null;groupSfuStarting=false;await pilot.close({notify:false});clearGroupSfuAudio();setServerStatus('SFU setup failed · using direct P2P mesh');syncServerMesh()}console.warn('[SFU] group pilot fallback:',error?.message||error);return false}
}
// Server peer data channels now carry only media-control messages. Keeping
// history/text off this channel prevents a voice join from silently becoming a
// second text transport or reintroducing a peer-mesh dependency for chat.
function wireServerChannel(peerId,channel,serverId=activeServerId){channel.onopen=()=>{if(serverVoiceStream)setServerStatus('Connected directly to '+serverPeers.size+' voice peer'+(serverPeers.size===1?'':'s'),true);requestWatchState();announceNetBudget();startNetBudgetPulse()};channel.onmessage=event=>{try{if(typeof event.data!=='string'||event.data.length>64*1024)return;const value=JSON.parse(event.data),state=serverPeers.get(peerId);if(!state||value?.serverId&&value.serverId!==serverId)return;if(value?.t==='watch'){receiveWatchMessage(value);return}if(value?.t==='net-budget'){rememberPeerNetBudget(peerId,value);return}if(value?.t==='screen-codec-fallback'){switchServerScreenCodec(peerId,state,compatibilityScreenCodec()).catch(()=>{});return}if(value?.t==='server-screen-end')clearServerScreenVideo(state)}catch{}}}
function voicePeerAllowed(peerId){return !!serverVoiceStream&&!groupSfuPilot&&voiceChannelEntries(joinedVoiceChannelId).some(entry=>entry.id===peerId)}
function sharedServerSilentAudio(){
  if(serverSilentAudioCtx?.state!=='closed'&&serverSilentScreenAudioTrack?.readyState==='live')return{context:serverSilentAudioCtx,stream:serverSilentAudioStream,track:serverSilentScreenAudioTrack};
  const context=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000}),destination=context.createMediaStreamDestination();destination.channelCount=2;serverSilentAudioCtx=context;serverSilentAudioStream=destination.stream;serverSilentScreenAudioTrack=destination.stream.getAudioTracks()[0];return{context,stream:serverSilentAudioStream,track:serverSilentScreenAudioTrack}
}
function releaseSharedServerSilentAudio(){const context=serverSilentAudioCtx,track=serverSilentScreenAudioTrack;serverSilentAudioCtx=null;serverSilentAudioStream=null;serverSilentScreenAudioTrack=null;try{track?.stop()}catch{}if(context)try{context.close()}catch{}}
function serverMediaPeerCount(){return Math.max(1,[...serverPeers].filter(([peerId,state])=>!state.closing&&voicePeerAllowed(peerId)).length)}
function targetServerVoiceBitrate(){return targetVoiceBitrate()}
async function configureServerVoiceSender(sender){
  if(!sender)return;try{const parameters=sender.getParameters(),bitrate=targetServerVoiceBitrate(),playback=relayVoiceMode?16000:48000;if(!parameters.encodings?.length)parameters.encodings=[{}];parameters.encodings[0].maxBitrate=bitrate;parameters.encodings[0].priority='high';parameters.encodings[0].networkPriority='high';if(parameters.codecs)parameters.codecs.forEach(c=>{if(String(c.mimeType||'').toLowerCase()==='audio/opus'){c.maxptime=20;c.ptime=10;if(c.parameters){c.parameters.maxaveragebitrate=bitrate;c.parameters.maxplaybackrate=playback;c.parameters.maxptime=20;c.parameters.minptime=10;c.parameters.useinbandfec=1;c.parameters.usedtx=1;c.parameters.cbr=1;c.parameters.stereo=0;c.parameters['sprop-stereo']=0}}});await sender.setParameters(parameters)}catch{}
}
function rebalanceServerMediaBudgets(){for(const state of serverPeers.values()){if(state.closing)continue;void configureServerVoiceSender(state.voiceSender)}void maybeAdoptLiveShareBudget()}
function addServerVoiceAudio(peerId,state,track,stream){
  const trackId=track?.id||'';state.audioTrackIds||=new Set();if(trackId&&state.audioTrackIds.has(trackId))return;if(trackId)state.audioTrackIds.add(trackId);const audio=document.createElement('audio');audio.autoplay=true;audio.srcObject=stream;audio.hidden=true;document.body.append(audio);state.audios.push(audio);applyMediaElementOutput(audio).catch(()=>{});monitorSpeaking('server:'+peerId,stream);audio.play().catch(()=>{});
  try{state.voicePlayoutStop?.()}catch{}state.voicePlayoutStop=null;const receiver=state.pc?.getReceivers?.().find(value=>value.track===track);if(receiver)state.voicePlayoutStop=monitorVoicePlayout(receiver,track);
  track.onended=()=>{try{state.voicePlayoutStop?.()}catch{}state.voicePlayoutStop=null;stopSpeakingMonitor('server:'+peerId);if(trackId)state.audioTrackIds.delete(trackId);audio.remove();state.audios=state.audios.filter(item=>item!==audio)};
}
function attachServerIncomingTrack(peerId,state,event){
  const stream=event.streams[0]||new MediaStream([event.track]),isVoiceAudio=event.track.kind==='audio'&&event.transceiver?.sender===state.voiceSender,isReservedScreenAudio=event.track.kind==='audio'&&event.transceiver?.sender===state.screenAudioSender;if(event.track.kind==='video'){addServerScreenVideo(peerId,state,event.track,stream);return}if(isVoiceAudio){addServerVoiceAudio(peerId,state,event.track,stream);return}if(isReservedScreenAudio||state.nativeScreenAudioExpected&&state.nativeScreenPlayer){stream._knotPeerId=peerId;addServerNativeScreenAudio(state,event.track,stream);return}const screenAudio=stream.getVideoTracks().length>0||!!(state.screenStreamId&&stream.id===state.screenStreamId);if(screenAudio){if(state.screen&&state.screen.srcObject!==stream)try{state.screen.srcObject.addTrack(event.track)}catch{}renderServerShareExperience();return}addServerVoiceAudio(peerId,state,event.track,stream)
}
function flushPendingServerTracks(){for(const [peerId,state] of serverPeers){if(!voicePeerAllowed(peerId)||!state.pendingTracks?.length)continue;const pending=state.pendingTracks.splice(0);for(const event of pending)if(event.track?.readyState==='live')attachServerIncomingTrack(peerId,state,event)}}
function addServerScreenVideo(peerId,state,track,stream){
  clearServerNativeScreen(state,{keepChannel:true});
  clearServerScreenVideo(state);
  const video=document.createElement('video');video.autoplay=false;video.playsInline=true;video.srcObject=stream;video.dataset.peerId=peerId;video.muted=true;$('#serverVoiceScreens').append(video);state.screen=video;state.screenStreamId=stream.id;applyMediaElementOutput(video).catch(()=>{});
  const receiver=state.pc.getReceivers().find(value=>value.track===track);if(receiver)state.screenDecodeStop=monitorRemoteScreenDecode(receiver,track,()=>{if(state.channel?.readyState!=='open')return false;state.channel.send(JSON.stringify({t:'screen-codec-fallback',serverId:state.context.serverId}));return true},()=>serverFocusedShareId===peerId&&!serverSuppressedShares.has(peerId)&&!state.screen?.paused);
  renderServerVoiceUI();track.onended=()=>{if(state.screen===video)clearServerScreenVideo(state)};
}
function clearServerScreenVideo(state){if(!state)return;state.screenDecodeStop?.();state.screenDecodeStop=null;if(state.screenAudio){try{state.screenAudio.pause();state.screenAudio.srcObject=null;state.screenAudio.remove()}catch{}state.screenAudio=null}if(state.screen){try{state.screen.pause();state.screen.srcObject=null;state.screen.remove()}catch{}state.screen=null}state.screenStreamId='';renderServerVoiceUI()}
function clearServerNativeScreen(state,{keepChannel=false}={}){
  if(!state)return;state.nativeScreenPlayer?.destroy();state.nativeScreenPlayer=null;state.nativeScreenAudioExpected=false;if(state.nativeReceiveChannel)clearNativeScreenReceiveState(state.nativeReceiveChannel);if(state.screenAudio){try{state.screenAudio.pause();state.screenAudio.srcObject=null;state.screenAudio.remove()}catch{}state.screenAudio=null}if(state.screen&&!state.screen.srcObject){try{state.screen.pause();state.screen.remove()}catch{}state.screen=null;state.screenStreamId=''}if(!keepChannel&&state.nativeReceiveChannel){try{state.nativeReceiveChannel.onmessage=null;state.nativeReceiveChannel.close()}catch{}state.nativeReceiveChannel=null}renderServerVoiceUI()
}
function beginServerNativeScreen(peerId,state,meta,channel){
  meta=validNativeScreenMeta(meta,state.context.serverId);if(!meta)return false;clearServerNativeScreen(state,{keepChannel:true});clearServerScreenVideo(state);const video=document.createElement('video');video.autoplay=false;video.playsInline=true;video.dataset.peerId=peerId;video.muted=true;$('#serverVoiceScreens').append(video);state.screen=video;state.screenStreamId='native';state.nativeScreenAudioExpected=!!meta.audio;applyMediaElementOutput(video).catch(()=>{});
  let fallbackRequested=false;const fallback=()=>{if(fallbackRequested)return;fallbackRequested=true;try{if(channel.readyState==='open')channel.send(JSON.stringify({t:'native-screen-fallback',serverId:state.context.serverId}))}catch{}};try{state.nativeScreenPlayer=createNativeScreenPlayer(video,meta.codec||'AV1',fallback,meta)}catch(error){fallback();clearServerNativeScreen(state,{keepChannel:true});setServerStatus(error.message);return false}channel._nativeReceive=nativeScreenReceiveState(state.nativeScreenPlayer,meta,fallback);drainNativeScreenPreMeta(channel);try{channel.send(JSON.stringify({t:'native-screen-ready',serverId:state.context.serverId,transportVersion:NATIVE_SCREEN_PROTOCOL}))}catch{}renderServerVoiceUI();return true
}
function addServerNativeScreenAudio(state,track,stream){
  if(state.screenAudio){try{state.screenAudio.remove()}catch{}}const audio=document.createElement('audio');audio.autoplay=true;audio.hidden=true;audio.srcObject=stream;audio.volume=remoteScreen.volume;audio.muted=serverFocusedShareId!==stream._knotPeerId&&serverFocusedShareId!==state.screen?.dataset.peerId;document.body.append(audio);state.screenAudio=audio;state.nativeScreenAudioExpected=false;applyMediaElementOutput(audio).catch(()=>{});track.onended=()=>{if(state.screenAudio===audio){audio.remove();state.screenAudio=null}};renderServerShareExperience()
}
function wireServerNativeScreenChannel(peerId,state,channel,{remote=false}={}){
  channel.binaryType='arraybuffer';if(remote){state.nativeReceiveChannel=channel;channel._nativePreMeta=[];channel.onmessage=event=>{if(typeof event.data==='string'){if(event.data.length>64*1024)return;try{const value=JSON.parse(event.data);if(value.t==='native-screen-meta')beginServerNativeScreen(peerId,state,value,channel);else if(value.t==='native-screen-audio'&&value.serverId===state.context.serverId)state.nativeScreenAudioExpected=!!value.active;else if(value.t==='native-screen-end'&&value.serverId===state.context.serverId)clearServerNativeScreen(state,{keepChannel:true})}catch{}return}if(!channel._nativeReceive)holdNativeScreenPreMeta(channel,event.data);else receiveNativeScreenPacket(channel,event.data)};channel.onclose=()=>{channel._nativePreMeta=[];if(state.nativeReceiveChannel===channel){clearServerNativeScreen(state,{keepChannel:true});state.nativeReceiveChannel=null;renderServerVoiceUI()}};return}
  state.nativeSendChannel=channel;channel.onmessage=event=>{if(typeof event.data!=='string'||event.data.length>64*1024)return;try{const value=JSON.parse(event.data);if(value.t==='native-screen-ready'&&value.serverId===state.context.serverId){channel._nativePeerProtocol=Math.max(0,Math.min(16,Number(value.transportVersion)||0));if(channel._nativePeerProtocol>=NATIVE_SCREEN_PROTOCOL)settleNativeScreenReady(channel,true)}else if(value.t==='native-screen-fallback'&&value.serverId===state.context.serverId){try{channel.close()}catch{}}}catch{}};channel.onopen=()=>announceServerNativeChannel(channel);channel.onclose=()=>{settleNativeScreenReady(channel,false);if(channel._serverNativeQueue)channel._serverNativeQueue.length=0;if(state.nativeSendChannel===channel)state.nativeSendChannel=null}
}
async function activateServerPeerMedia(peerId,state){
  if(!state||state.pc.signalingState==='closed'||!voicePeerAllowed(peerId)||state.voiceSender)return false;
  for(const track of serverVoiceStream.getTracks()){state.voiceSender=state.pc.addTrack(track,serverVoiceStream);preferVoiceAudioCodecs(state.pc.getTransceivers().find(value=>value.sender===state.voiceSender));await configureServerVoiceSender(state.voiceSender)}
  try{const silent=sharedServerSilentAudio();state.silentScreenAudioTrack=silent.track;state.screenAudioSender=state.pc.addTrack(silent.track,silent.stream)}catch{state.screenAudioSender=state.pc.addTransceiver('audio',{direction:'sendrecv'}).sender}
  if(serverScreenStream)for(const track of serverScreenStream.getTracks()){if(track.kind==='audio'){await setServerScreenAudioTrack(state,track);continue}const sender=state.pc.addTrack(track,serverScreenStream);state.screenSenders.push(sender);applyScreenCodecPreference(state.pc,sender);await configureScreenVideoSender(sender,track,shareFrameRate,serverMediaPeerCount(),peerReceiveCapMbps(peerId),peerId)}
  if(state.pc.remoteDescription&&state.pc.signalingState==='stable')await renegotiateServerPeer(peerId,state);return true
}
function voiceSignalContext(entity=conversationEntity(joinedVoiceServerId||activeServerId),channelId=joinedVoiceChannelId||activeChannelId){return isGroupDm(entity)?{type:'group-dm',groupId:entity.id,serverId:entity.id,channelId,keyEpoch:Number(entity.keyEpoch)||1}:{type:'server',serverId:entity?.id||'',channelId}}
async function ensureServerPeer(peerId,context=voiceSignalContext()){
  if(serverPeers.has(peerId)){const existing=serverPeers.get(peerId),sameContext=existing.context?.type===context.type&&existing.context?.serverId===context.serverId&&existing.context?.channelId===context.channelId;if(sameContext){await activateServerPeerMedia(peerId,existing);return existing}closeServerPeer(peerId,existing)}
  const connection=new RTCPeerConnection({iceServers:ICE_SERVERS}),state={pc:connection,channel:null,candidates:[],audios:[],audioTrackIds:new Set(),pendingTracks:[],voiceSender:null,screenAudioSender:null,silentScreenAudioTrack:null,screen:null,screenAudio:null,screenDecodeStop:null,screenStreamId:'',screenSenders:[],nativeScreenPlayer:null,nativeSendChannel:null,nativeReceiveChannel:null,nativeScreenAudioExpected:false,context,closing:false,disconnectTimer:null,polite:directoryUserId>peerId,makingOffer:false,ignoreOffer:false,offerGeneration:0,renegotiateRequested:false,renegotiatePromise:null};serverPeers.set(peerId,state);
  connection.onicecandidate=event=>{if(event.candidate)directorySend({type:'signal',peerId,context:state.context,payload:{kind:'candidate',candidate:event.candidate.toJSON()}})};
  connection.onconnectionstatechange=()=>{if(state.closing||serverPeers.get(peerId)!==state)return;const status=connection.connectionState;if(status==='connected'){clearTimeout(state.disconnectTimer);state.disconnectTimer=null;if(serverNativeScreenSession)ensureServerNativeChannel(peerId,state).catch(()=>{});return}if(status==='disconnected'){if(!state.disconnectTimer)state.disconnectTimer=setTimeout(()=>recoverServerPeer(peerId,state),6000);return}if(status==='failed')recoverServerPeer(peerId,state)};
  connection.ondatachannel=event=>{if(event.channel.label==='knot-server-screen-native'){wireServerNativeScreenChannel(peerId,state,event.channel,{remote:true});return}state.channel=event.channel;wireServerChannel(peerId,state.channel,state.context.serverId)};
  connection.ontrack=event=>{if(!voicePeerAllowed(peerId)){if(state.pendingTracks.length<16)state.pendingTracks.push(event);event.track.addEventListener?.('ended',()=>{state.pendingTracks=state.pendingTracks.filter(item=>item!==event)},{once:true});return}attachServerIncomingTrack(peerId,state,event)};
  await activateServerPeerMedia(peerId,state);
  if(directoryUserId<peerId){state.channel=connection.createDataChannel('pair-server-chat');wireServerChannel(peerId,state.channel,state.context.serverId);const generation=++state.offerGeneration;state.makingOffer=true;try{const offer=await connection.createOffer();if(state.closing||generation!==state.offerGeneration)return state;if(offer.sdp)offer.sdp=patchSdp(offer.sdp);await connection.setLocalDescription(offer);if(!state.closing&&generation===state.offerGeneration)directorySend({type:'signal',peerId,context:state.context,payload:{kind:'offer',sdp:connection.localDescription.sdp}})}finally{if(generation===state.offerGeneration)state.makingOffer=false}}rebalanceServerMediaBudgets();return state;
}
async function addQueuedServerCandidates(state){for(const candidate of state.candidates.splice(0))try{await state.pc.addIceCandidate(candidate)}catch(error){if(!state.ignoreOffer)console.warn('server ICE candidate',error)}}
async function handleServerSignal(message){
  if(groupSfuPilot)return;
  const context={...(message.context||{})},payload=message.payload||{},entityId=context.groupId||context.serverId,peerId=String(message.from||'').toLowerCase();
  if(!/^[a-f0-9]{32}$/.test(peerId)||entityId!==joinedVoiceServerId||context.channelId!==joinedVoiceChannelId||!voiceChannelEntries(joinedVoiceChannelId).some(entry=>entry.id===peerId))return;
  if(context.type==='group-dm'){context.groupId=entityId;context.serverId=entityId}
  const state=await ensureServerPeer(peerId,context),connection=state.pc;if(state.closing)return;
  if(payload.kind==='offer'){
    const sdp=validPeerSdp(payload.sdp);if(!sdp)return;const collision=state.makingOffer||connection.signalingState!=='stable';state.ignoreOffer=!state.polite&&collision;if(state.ignoreOffer)return;
    if(collision){state.offerGeneration++;state.makingOffer=false;state.renegotiateRequested=true;if(connection.signalingState==='have-local-offer')await connection.setLocalDescription({type:'rollback'});else if(connection.signalingState!=='stable')return}
    await connection.setRemoteDescription({type:'offer',sdp});const answer=await connection.createAnswer();if(answer.sdp)answer.sdp=patchSdp(answer.sdp);await connection.setLocalDescription(answer);directorySend({type:'signal',peerId,context:state.context,payload:{kind:'answer',sdp:connection.localDescription.sdp}});await addQueuedServerCandidates(state);if(state.renegotiateRequested)queueMicrotask(()=>renegotiateServerPeer(peerId,state).catch(()=>{}));return
  }
  if(payload.kind==='answer'){
    const sdp=validPeerSdp(payload.sdp);if(!sdp||connection.signalingState!=='have-local-offer')return;state.ignoreOffer=false;await connection.setRemoteDescription({type:'answer',sdp});await addQueuedServerCandidates(state);return
  }
  if(payload.kind==='candidate'){
    const candidate=cleanIceCandidate(payload.candidate);if(!candidate||state.ignoreOffer)return;if(connection.remoteDescription)try{await connection.addIceCandidate(candidate)}catch(error){if(!state.ignoreOffer)throw error}else if(state.candidates.length<128)state.candidates.push(candidate)
  }
}
function recoverServerPeer(peerId,state){if(!state||state.closing||serverPeers.get(peerId)!==state)return;const context={...state.context};closeServerPeer(peerId,state,{forgetBudget:false});if(voicePeerAllowed(peerId)&&directoryUser(peerId)?.online)setTimeout(()=>{if(voicePeerAllowed(peerId)&&directoryUser(peerId)?.online&&!serverPeers.has(peerId))ensureServerPeer(peerId,context).catch(()=>{})},150)}
function closeServerPeer(peerId,state=serverPeers.get(peerId),{forgetBudget=true}={}){if(!state||state.closing)return;state.closing=true;state.offerGeneration++;clearTimeout(state.disconnectTimer);state.disconnectTimer=null;try{state.voicePlayoutStop?.()}catch{}state.voicePlayoutStop=null;stopSpeakingMonitor('server:'+peerId);try{state.channel?.close()}catch{}clearServerNativeScreen(state);clearServerScreenVideo(state);try{state.nativeSendChannel?.close()}catch{}try{state.pc.close()}catch{}for(const audio of state.audios||[])try{audio.remove()}catch{}state.audios=[];state.pendingTracks=[];state.candidates=[];if(forgetBudget)peerNetBudgets.delete(peerId);shareBudgetApplied.delete(peerId);if(serverPeers.get(peerId)===state)serverPeers.delete(peerId);queueMicrotask(rebalanceServerMediaBudgets)}
function closeServerMesh(){for(const [peerId,state] of [...serverPeers])closeServerPeer(peerId,state);releaseSharedServerSilentAudio()}
function syncServerMesh(){
  // Text now uses the encrypted live relay. Never create a server WebRTC mesh
  // merely because somebody opened a channel; this mesh is media-only.
  if(!serverVoiceStream||!joinedVoiceServerId)return;if(groupSfuPilot){if(serverPeers.size)closeServerMesh();return}
  // Reconcile instead of close-and-recreate.  The old implementation ran on
  // every channel click and directory snapshot, which needlessly interrupted
  // WebRTC text, voice and screen tracks.
  const serverId=joinedVoiceServerId||activeServerId||[...serverPeers.values()][0]?.context?.serverId;if(!serverId)return;
  const online=new Set(serverOnlineMembers(serverId));
  for(const [peerId,state] of [...serverPeers])if(state.context?.serverId!==serverId||!online.has(peerId))closeServerPeer(peerId,state);
  const context=voiceSignalContext(conversationEntity(serverId),joinedVoiceServerId===serverId?joinedVoiceChannelId:activeChannelId);
  for(const peerId of online)ensureServerPeer(peerId,context).catch(()=>{});
  flushPendingServerTracks();
  if(!online.size)setServerStatus('No other server members online')
}
function toggleServerVoiceMute(){if(!serverVoiceStream)return;serverVoiceMuted=!serverVoiceMuted;serverVoiceStream.getAudioTracks().forEach(track=>track.enabled=!serverVoiceMuted);renderServerVoiceUI()}
async function waitForServerPeerStable(connection,timeoutMs=5000){if(connection.signalingState==='stable')return true;return new Promise(resolve=>{let settled=false;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);connection.removeEventListener('signalingstatechange',changed);resolve(value)};const changed=()=>{if(connection.signalingState==='stable')finish(true);else if(connection.signalingState==='closed')finish(false)};const timer=setTimeout(()=>finish(false),timeoutMs);connection.addEventListener('signalingstatechange',changed)})}
async function renegotiateServerPeer(peerId,state){
  if(!state||state.pc.signalingState==='closed')return false;state.renegotiateRequested=true;if(state.renegotiatePromise)return state.renegotiatePromise;
  state.renegotiatePromise=(async()=>{let sent=false;while(state.renegotiateRequested&&state.pc.signalingState!=='closed'&&!state.closing){state.renegotiateRequested=false;if(!await waitForServerPeerStable(state.pc))break;const generation=++state.offerGeneration;state.makingOffer=true;try{const offer=await state.pc.createOffer();if(generation!==state.offerGeneration||state.closing)continue;if(offer.sdp)offer.sdp=patchSdp(offer.sdp);await state.pc.setLocalDescription(offer);if(generation!==state.offerGeneration||state.closing)continue;directorySend({type:'signal',peerId,context:state.context,payload:{kind:'offer',sdp:state.pc.localDescription.sdp}});sent=true}finally{if(generation===state.offerGeneration)state.makingOffer=false}}return sent})().finally(()=>{state.renegotiatePromise=null});return state.renegotiatePromise;
}
async function switchServerScreenCodec(peerId,state,codec){const sender=state?.screenSenders?.find(value=>value.track?.kind==='video');if(!sender||!applyScreenCodecPreference(state.pc,sender,codec))return false;return renegotiateServerPeer(peerId,state)}
function announceServerNativeChannel(channel){const session=serverNativeScreenSession;if(channel.readyState!=='open'||!session)return false;if(channel._nativeSend?.sessionId===session.id)return true;try{initializeNativeScreenSender(channel,{t:'native-screen-meta',serverId:joinedVoiceServerId,codec:'AV1',fps:session.fps,width:session.width,height:session.height,encoder:session.encoder,latencyTargetMs:session.latencyTargetMs,audio:false},session.id,()=>{try{channel.close()}catch{}});return true}catch{return false}}
async function sendServerNativeItem(channel,item){
  if(channel.readyState!=='open'||!serverNativeScreenSession)return false;if(!announceServerNativeChannel(channel))return false;if(item.kind!=='init'&&!channel._nativeSend.init&&serverNativeScreenInit)await sendNativeScreenLiveItem(channel,{kind:'init',data:serverNativeScreenInit});return sendNativeScreenLiveItem(channel,item)
}
function dropQueuedServerNativeItem(channel,item){if(!item)return;const state=channel._nativeSend;if(state)markNativeScreenCongested(channel,state,!!item.key,Math.max(0,Number(item.frameCount)||0))}
function drainServerNativeQueue(channel){if(channel._serverNativeDraining||channel.readyState!=='open'||!serverNativeScreenSession)return;channel._serverNativeDraining=true;const sessionId=serverNativeScreenSession.id;void(async()=>{try{while(channel.readyState==='open'&&serverNativeScreenSession?.id===sessionId){const next=channel._serverNativeQueue?.shift();if(!next)break;if(!await sendServerNativeItem(channel,next)){try{channel.close()}catch{};break}}}catch{try{channel.close()}catch{}}finally{channel._serverNativeDraining=false;if(channel._serverNativeQueue?.length&&channel.readyState==='open'&&serverNativeScreenSession?.id===sessionId)drainServerNativeQueue(channel)}})()}
function queueServerNativeItem(channel,item){
  if(channel.readyState!=='open'||!serverNativeScreenSession)return false;const queue=channel._serverNativeQueue||(channel._serverNativeQueue=[]);
  if(item.kind==='init'){for(let index=queue.length-1;index>=0;index--)if(queue[index].kind==='init')queue.splice(index,1);queue.unshift(item);drainServerNativeQueue(channel);return true}
  if(item.kind==='cluster'&&item.key){for(let index=queue.length-1;index>=0;index--)if(queue[index].kind==='cluster')dropQueuedServerNativeItem(channel,queue.splice(index,1)[0]);queue.push(item);drainServerNativeQueue(channel);return true}
  if(queue.length>=4){dropQueuedServerNativeItem(channel,item);return true}
  queue.push(item);drainServerNativeQueue(channel);return true
}
async function ensureServerNativeChannel(peerId,state){
  if(!serverNativeScreenSession||!state||state.pc.connectionState!=='connected')return null;let channel=state.nativeSendChannel;if(!channel||channel.readyState==='closed'){channel=state.pc.createDataChannel('knot-server-screen-native',nativeScreenChannelOptions());wireServerNativeScreenChannel(peerId,state,channel)}if(!await waitNativeScreenChannel(channel))return null;announceServerNativeChannel(channel);if(serverNativeScreenInit)await sendServerNativeItem(channel,{kind:'init',data:serverNativeScreenInit});if(serverNativeScreenAudioStream&&!state.screenSenders.some(sender=>sender.track===serverNativeScreenAudioStream.getAudioTracks()[0]))try{await attachServerNativeAudioToPeer(peerId,state)}catch{try{channel.send(JSON.stringify({t:'native-screen-audio',serverId:state.context.serverId,active:false}))}catch{}}return channel
}
async function setServerScreenAudioTrack(state,track){const sender=state?.screenAudioSender;if(!sender)throw new Error('reserved server screen-audio sender is unavailable');await sender.replaceTrack(track||state.silentScreenAudioTrack||null);if(track)try{const parameters=sender.getParameters();if(!parameters.encodings?.length)parameters.encodings=[{}];parameters.encodings[0].maxBitrate=256000;parameters.encodings[0].priority='high';parameters.encodings[0].networkPriority='high';await sender.setParameters(parameters)}catch{}return sender}
async function attachServerNativeAudioToPeer(peerId,state){const track=serverNativeScreenAudioStream?.getAudioTracks?.()[0];if(!track)throw new Error('screen audio ended');if(state.nativeSendChannel?.readyState==='open')state.nativeSendChannel.send(JSON.stringify({t:'native-screen-audio',serverId:state.context.serverId,active:true}));return setServerScreenAudioTrack(state,track)}
async function attachServerNativeScreenAudio(gen){
  if(!screenAudioOn||!serverNativeScreenSession||gen!==serverScreenGen)return;const track=await linuxShareAudioTrack();if(!track||!serverNativeScreenSession||gen!==serverScreenGen){try{track?.stop()}catch{}if(track)cleanupNativeScreenCapture(track._knotCaptureOwner);return}const audioStream=new MediaStream([track]);serverNativeScreenAudioStream=audioStream;try{track.contentHint='music'}catch{};const peers=[...serverPeers].filter(([peerId])=>voicePeerAllowed(peerId)),results=await Promise.allSettled(peers.map(([peerId,state])=>attachServerNativeAudioToPeer(peerId,state))),failed=results.some(result=>result.status==='rejected')||serverNativeScreenAudioStream!==audioStream||!serverNativeScreenSession||gen!==serverScreenGen,label=serverNativeScreenSession?.encoder||'GPU';if(failed){for(const [,state] of peers){setServerScreenAudioTrack(state,null).catch(()=>{});if(state.nativeSendChannel?.readyState==='open')try{state.nativeSendChannel.send(JSON.stringify({t:'native-screen-audio',serverId:state.context.serverId,active:false}))}catch{}}try{track.stop()}catch{}if(serverNativeScreenAudioStream===audioStream)serverNativeScreenAudioStream=null;cleanupNativeScreenCapture(track._knotCaptureOwner);if(gen===serverScreenGen)setServerStatus('Sharing · '+label+' AV1 · computer sound unavailable',true)}else setServerStatus('Sharing · '+label+' AV1 · computer sound live',true)
}
async function pumpServerNativeScreen(gen,session){
  let audioStarted=false,preview=serverNativeLocalPlayer?.mode!=='placeholder';
  while(serverNativeScreenSession?.id===session.id&&gen===serverScreenGen){
    const queued=[];
    if(typeof window.pairNativeScreen.readMany==='function'){const batch=await window.pairNativeScreen.readMany(session.id);if(Array.isArray(batch?.items))queued.push(...batch.items);else if(batch&&!batch.active){if(batch.error)setServerStatus('Native share stopped: '+batch.error);break}}
    if(!queued.length){const item=await window.pairNativeScreen.read(session.id);if(item?.data)queued.push(item);else if(!item?.active){if(item?.error)setServerStatus('Native share stopped: '+item.error);break}}
    if(serverNativeScreenSession?.id!==session.id||gen!==serverScreenGen)break;
    if(!queued.length)continue;
    for(const item of queued){
      if(serverNativeScreenSession?.id!==session.id||gen!==serverScreenGen||!item?.data)break;
      if(item.kind==='init')serverNativeScreenInit=item.data instanceof Uint8Array?item.data.slice():new Uint8Array(item.data);
      if(preview)serverNativeLocalPlayer?.append(item.data);
      const channels=[...serverPeers.values()].map(state=>state.nativeSendChannel).filter(channel=>channel?.readyState==='open');
      for(const channel of channels)if(!queueServerNativeItem(channel,item))try{channel.close()}catch{};
      if(!audioStarted){audioStarted=true;void attachServerNativeScreenAudio(gen)}
    }
  }
  if(serverNativeScreenSession?.id===session.id&&gen===serverScreenGen)await stopServerScreenShare()
}
async function startServerNativeScreenShare(expectedVoiceStream=serverVoiceStream,expectedServerId=joinedVoiceServerId,expectedChannelId=joinedVoiceChannelId){
  const ownsVoice=()=>!!expectedVoiceStream&&serverVoiceStream===expectedVoiceStream&&joinedVoiceServerId===expectedServerId&&joinedVoiceChannelId===expectedChannelId;
  if(!ownsVoice())return false;
  serverScreenStarting=true;abortInFlightNetworkProbe();const gen=++serverScreenGen;let session=null,player=null;const preview=$('#serverVoiceScreenPreview');renderServerVoiceUI();
  const abandon=()=>{if(session)try{window.pairNativeScreen?.stop(session.id)}catch{};if(serverNativeScreenSession?.id===session?.id)serverNativeScreenSession=null;if(player){try{player.destroy()}catch{}if(serverNativeLocalPlayer===player)serverNativeLocalPlayer=null}if(gen===serverScreenGen&&!serverNativeScreenSession&&!serverScreenStream)preview.hidden=true};
  try{await waitForViewerBudgets();if(gen!==serverScreenGen||!ownsVoice()){abandon();return false}const [width,height]=selectedNativeDimensions(),fps=shareFrameRate===30?30:60,viewers=Math.max(1,[...serverPeers].filter(([peerId])=>voicePeerAllowed(peerId)).length);session=await window.pairNativeScreen.start({codec:'av1',fps,width,height,bitrateKbps:targetNativeAv1BitrateKbps(width,height,fps,viewers),cursor:screenCursor});if(!session||session.error)throw new Error(session?.error||'GPU AV1 capture did not start');if(gen!==serverScreenGen||!ownsVoice()){abandon();return false}serverNativeScreenSession=session;serverNativeScreenInit=null;preview.hidden=false;preview.muted=true;player=createNativeScreenPlayer(preview,'AV1',()=>{}, {...session,decode:false});serverNativeLocalPlayer=player;await Promise.all([...serverPeers].filter(([peerId])=>voicePeerAllowed(peerId)).map(([peerId,state])=>ensureServerNativeChannel(peerId,state)));if(gen!==serverScreenGen||!ownsVoice()||serverNativeScreenSession?.id!==session.id){abandon();return false}setServerStatus('Choose a display · starting '+(session.encoder||'GPU')+' AV1…',true);serverFocusedShareId=directoryUserId;renderServerVoiceUI();void pumpServerNativeScreen(gen,session);return true}catch(error){const stale=gen!==serverScreenGen||!ownsVoice();abandon();if(!stale)setServerStatus('Native AV1 unavailable: '+(error?.message||error));return false}finally{if(gen===serverScreenGen)serverScreenStarting=false;renderServerVoiceUI()}
}
async function fallbackServerNativeToWebRtc(expectedSessionId=serverNativeScreenSession?.id){
  const expectedSession=serverNativeScreenSession,expectedVoiceStream=serverVoiceStream,expectedServerId=joinedVoiceServerId,expectedChannelId=joinedVoiceChannelId,previous=screenCodec,compatibility=compatibilityScreenCodec(),beforeStopGen=serverScreenGen;
  if(serverNativeFallbackInFlight||!expectedSession||expectedSession.id!==expectedSessionId||!expectedVoiceStream)return;serverNativeFallbackInFlight=true;
  try{setServerStatus('AV1 playback unavailable · switching to bandwidth-capped '+compatibility);await stopServerScreenShare();if(serverScreenGen!==beforeStopGen+1||serverVoiceStream!==expectedVoiceStream||joinedVoiceServerId!==expectedServerId||joinedVoiceChannelId!==expectedChannelId)return;screenFallbackBitrateCapMbps=compatibility==='VP9'?6:8;screenCodec=compatibility;await startServerScreenShare({skipPicker:true,expectedVoiceStream,expectedServerId,expectedChannelId})}finally{screenCodec=previous;serverNativeFallbackInFlight=false}
}
async function startServerScreenShare({skipPicker=false,expectedVoiceStream:ownedVoiceStream=null,expectedServerId:ownedServerId='',expectedChannelId:ownedChannelId=''}={}){
  if(groupSfuPilot){setServerStatus('Screen sharing stays on the direct P2P mesh. Turn off the SFU pilot and rejoin to share.');return}
  if(!serverVoiceStream||serverScreenSharing()||serverScreenStarting)return;
  const expectedVoiceStream=ownedVoiceStream||serverVoiceStream,expectedServerId=ownedServerId||joinedVoiceServerId,expectedChannelId=ownedChannelId||joinedVoiceChannelId,requestGen=serverScreenGen,ownsVoice=()=>!!expectedVoiceStream&&serverVoiceStream===expectedVoiceStream&&joinedVoiceServerId===expectedServerId&&joinedVoiceChannelId===expectedChannelId,ownsRequest=()=>ownsVoice()&&serverScreenGen===requestGen;
  if(!ownsVoice())return;
  primeScreenAudioContext();
  if(!skipPicker)screenFallbackBitrateCapMbps=0;
  if(!skipPicker){serverScreenStarting=true;renderServerVoiceUI();try{setServerStatus(window.pairEnv?.useSystemPicker?'Choose stream quality…':'Choose a screen or window…');const choice=await chooseScreenShare();if(!choice){if(ownsRequest())setServerStatus('Screen share canceled');return}if(!ownsRequest())return}catch(error){if(ownsRequest())setServerStatus('Screen share failed: '+(error?.message||error));return}finally{serverScreenStarting=false;renderServerVoiceUI()}}
  if(!ownsRequest())return;
  if(!skipPicker&&window.pairNativeScreen&&window.pairEnv?.platform==='linux'&&['0x10de','0x1002'].includes(window.pairEnv.primaryGpuVendor)&&(screenCodec==='auto'||screenCodec==='AV1')){const info=await window.pairNativeScreen.info();if(!ownsRequest())return;if(info?.supported){const started=await startServerNativeScreenShare(expectedVoiceStream,expectedServerId,expectedChannelId);if(started||!ownsVoice())return}}
  if(!ownsVoice())return;
  serverScreenStarting=true;abortInFlightNetworkProbe();const gen=++serverScreenGen;let startupStream=null;renderServerVoiceUI();
  try{
    const fps=shareFrameRate===30?30:60;
    const stream=await captureDisplayStream();startupStream=stream;if(gen!==serverScreenGen){stream.getTracks().forEach(track=>track.stop());return}
    const track=stream.getVideoTracks()[0];if(!track)throw new Error('No screen was selected');
    await tuneDisplayTrack(track);setServerStatus('Checking screen video…');const captured=await waitForDisplayFrames(track);if(gen!==serverScreenGen){stream.getTracks().forEach(value=>value.stop());return}
    try{track.contentHint=screenContentHint}catch{}
    serverScreenStream=stream;startupStream=null;const preview=$('#serverVoiceScreenPreview');preview.srcObject=null;preview.hidden=false;preview.muted=true;serverNativeLocalPlayer?.destroy();serverNativeLocalPlayer=createNativeScreenPlaceholder(preview,{width:captured.width,height:captured.height});track.onended=()=>{if(serverScreenStream===stream)stopServerScreenShare()};
    const viewers=Math.max(1,[...serverPeers].filter(([peerId])=>voicePeerAllowed(peerId)).length),starts=[];for(const [peerId,state] of serverPeers){if(!voicePeerAllowed(peerId))continue;starts.push((async()=>{const sender=state.pc.addTrack(track,stream);state.screenSenders.push(sender);applyScreenCodecPreference(state.pc,sender);await configureScreenVideoSender(sender,track,fps,viewers,peerReceiveCapMbps(peerId),peerId);await renegotiateServerPeer(peerId,state)})())}await Promise.allSettled(starts);if(gen!==serverScreenGen||serverScreenStream!==stream)return;
    setServerStatus('Sharing · '+captured.width+'×'+captured.height+(captured.fps?' · '+captured.fps+'fps':''),true);renderServerVoiceUI();setTimeout(renderServerShareExperience,250);
    if(screenAudioOn)void attachServerScreenAudio(gen,stream);
  }catch(error){try{startupStream?.getTracks().forEach(track=>track.stop())}catch{}const ownsFailure=gen===serverScreenGen&&ownsVoice();if(ownsFailure&&serverScreenStream){serverScreenStream.getTracks().forEach(track=>track.stop());serverScreenStream=null}if(ownsFailure){cleanupNativeScreenCapture();if(error?.name!=='NotAllowedError')setServerStatus('Screen share failed: '+(error?.message||error))}}
  finally{if(gen===serverScreenGen)serverScreenStarting=false;renderServerVoiceUI()}
}
async function attachServerScreenAudio(gen,stream){
  let audioTrack=null;const attached=[];try{audioTrack=window.pairEnv?.platform==='linux'?await linuxShareAudioTrack():await setupNativeScreenCapture()}catch(error){console.warn('[AUDIO] server screen capture failed:',error?.message||error)}
  const discard=()=>{for(const state of attached)setServerScreenAudioTrack(state,null).catch(()=>{});try{audioTrack?.stop()}catch{};try{stream.removeTrack(audioTrack)}catch{};cleanupNativeScreenCapture(audioTrack?._knotCaptureOwner)};if(!audioTrack)return;if(gen!==serverScreenGen||serverScreenStream!==stream){discard();return}
  try{audioTrack.enabled=true;try{audioTrack.contentHint='music'}catch{}stream.addTrack(audioTrack);const starts=[];for(const [peerId,state] of serverPeers){if(!voicePeerAllowed(peerId))continue;attached.push(state);starts.push(setServerScreenAudioTrack(state,audioTrack))}const results=await Promise.allSettled(starts);if(results.some(result=>result.status==='rejected'))throw results.find(result=>result.status==='rejected').reason;if(gen!==serverScreenGen||serverScreenStream!==stream)discard();else setServerStatus('Sharing · computer sound live',true)}catch(error){console.warn('[AUDIO] server screen attach failed:',error?.message||error);discard()}
}
async function stopServerScreenShare(){const stream=serverScreenStream,nativeSession=serverNativeScreenSession;serverScreenGen++;serverScreenStarting=false;if(!stream&&!nativeSession){if(window.pairEnv?.platform==='linux')try{window.pairEnv.stopLinuxShareAudio?.()}catch{};cleanupNativeScreenCapture();if(!networkCapacity)void startNetworkCapacityProbe();return}serverScreenStream=null;serverNativeScreenSession=null;if(nativeSession)window.pairNativeScreen?.stop(nativeSession.id);serverNativeLocalPlayer?.destroy();serverNativeLocalPlayer=null;serverNativeScreenInit=null;if(serverNativeScreenAudioStream){serverNativeScreenAudioStream.getTracks().forEach(track=>track.stop());serverNativeScreenAudioStream=null}stream?.getTracks().forEach(track=>track.stop());if(window.pairEnv?.platform==='linux')try{window.pairEnv.stopLinuxShareAudio?.()}catch{};cleanupNativeScreenCapture();const preview=$('#serverVoiceScreenPreview');preview.pause();preview.srcObject=null;try{preview.removeAttribute('src');preview.load()}catch{}preview.hidden=true;serverFocusedShareId=serverFocusedShareId===directoryUserId?'':serverFocusedShareId;const stops=[];for(const [peerId,state] of serverPeers){if(state.channel?.readyState==='open')try{state.channel.send(JSON.stringify({t:'server-screen-end',serverId:state.context.serverId}))}catch{}if(state.nativeSendChannel){if(state.nativeSendChannel.readyState==='open')try{state.nativeSendChannel.send(JSON.stringify({t:'native-screen-end',serverId:state.context.serverId}))}catch{}try{state.nativeSendChannel.close()}catch{}state.nativeSendChannel=null}await setServerScreenAudioTrack(state,null).catch(()=>{});for(const sender of state.screenSenders||[])try{state.pc.removeTrack(sender)}catch{}state.screenSenders=[];stops.push(renegotiateServerPeer(peerId,state))}await Promise.allSettled(stops);if(!networkCapacity)void startNetworkCapacityProbe();renderServerVoiceUI()}
function disposeServerVoiceAttempt(attempt){
  if(!attempt||attempt.committed)return;for(const stream of new Set([attempt.stream,attempt.raw].filter(Boolean)))try{stream.getTracks().forEach(track=>track.stop())}catch{}stopVoiceNoisePipeline(attempt.pipeline);attempt.stream=attempt.raw=attempt.pipeline=null;
}
async function joinServerVoice(channelOverride=null){
  const entity=activeServer(),channel=channelOverride||activeChannel();if(!entity||!channel||channel.type!=='voice')return callStatus.textContent=isGroupDm(entity)?'This group call is unavailable.':'Select a voice channel first.';
  if(serverVoiceAttempt?.serverId===entity.id&&serverVoiceAttempt?.channelId===channel.id)return;
  if(dmCallOngoing()){await endCall(false);applyRemoteCallState(false);dmCallPeerId=''}
  if(serverVoiceStream&&joinedVoiceServerId===entity.id&&joinedVoiceChannelId===channel.id)return;
  stopServerVoice();const gen=serverVoiceGen,attempt={gen,serverId:entity.id,channelId:channel.id,raw:null,stream:null,pipeline:null,committed:false};serverVoiceAttempt=attempt;serverVoiceStarting=true;renderCallButtonState('end','Cancel joining','Cancel joining voice');callStatus.textContent='Requesting microphone…';callStatus.className='call-status ringing';
  try{
    attempt.raw=await navigator.mediaDevices.getUserMedia(microphoneConstraints());attempt.stream=attempt.raw;
    if(gen!==serverVoiceGen||serverVoiceAttempt!==attempt)return;
    if(noiseReductionMode!=='off')try{attempt.pipeline=noiseReductionMode==='deepfilter'?await createDeepFilterMicrophone(attempt.raw):await createRnnoiseMicrophone(attempt.raw);attempt.stream=attempt.pipeline.stream;activeNoiseProcessor=noiseReductionMode}catch(error){if(gen!==serverVoiceGen||serverVoiceAttempt!==attempt)return;const name=noiseReductionMode==='deepfilter'?'DeepFilterNet3':'RNNoise';deviceHint.textContent=name+' could not start, so Knot is using your raw microphone in this voice channel.';console.warn(name+' group microphone filter unavailable:',error)}
    if(gen!==serverVoiceGen||serverVoiceAttempt!==attempt)return;
    serverVoiceRawStream=attempt.raw;serverVoiceStream=attempt.stream;serverVoiceNoisePipeline=attempt.pipeline;attempt.committed=true;serverVoiceAttempt=null;serverVoiceStarting=false;
    serverVoiceMuted=false;serverVoiceStream.getAudioTracks().forEach(track=>track.enabled=true);joinedVoiceServerId=entity.id;joinedVoiceChannelId=channel.id;joinedVoiceScope=isGroupDm(entity)?'group-dm':'server';joinedVoiceAt=Date.now();monitorSpeaking('server:'+directoryUserId,serverVoiceStream);directorySend(joinedVoiceScope==='group-dm'?{type:'voice-state',groupId:entity.id,channelId:channel.id,joined:true}:{type:'voice-state',serverId:entity.id,channelId:channel.id,joined:true});callStatus.textContent=joinedVoiceScope==='group-dm'?'Group call connected':'Joined '+channel.name;callStatus.className='call-status live';renderCallButtonState('end',joinedVoiceScope==='group-dm'?'Leave call':'Leave voice',joinedVoiceScope==='group-dm'?'Leave group call':'Leave voice channel');if(joinedVoiceScope==='group-dm'){renderFriends();renderServerVoiceUI()}else renderChannels();if(!await startGroupSfu(entity,channel))syncServerMesh();placeWatchTogether();requestWatchState();
  }catch(error){if(gen===serverVoiceGen&&serverVoiceAttempt===attempt){callStatus.textContent='Could not join voice: '+(error?.message||error);callStatus.className='call-status';syncServerMesh();renderServerVoiceUI()}}
  finally{disposeServerVoiceAttempt(attempt);if(serverVoiceAttempt===attempt)serverVoiceAttempt=null;if(gen===serverVoiceGen&&serverVoiceStarting){serverVoiceStarting=false;if(activeGroupDmId){renderCallButtonState('start','Start group call','Start group voice call');renderFriends()}else if(activeServerId){const voice=activeChannel()?.type==='voice';renderCallButtonState('start',voice?'Join voice':'Start call',voice?'Join voice channel':'Start voice call');renderChannels()}renderServerVoiceUI()}}
}
function stopServerVoice(){serverVoiceGen++;serverVoiceStarting=false;const pending=serverVoiceAttempt;serverVoiceAttempt=null;disposeServerVoiceAttempt(pending);abortScreenSharePicker();serverScreenGen++;serverScreenStarting=false;if(window.pairEnv?.platform==='linux')try{window.pairEnv.stopLinuxShareAudio?.()}catch{};stopSpeakingMonitor('server:'+directoryUserId);const serverId=joinedVoiceServerId||activeServerId,channelId=joinedVoiceChannelId,scope=joinedVoiceScope||'server';if(channelId&&serverId)directorySend(scope==='group-dm'?{type:'voice-state',groupId:serverId,channelId,joined:false}:{type:'voice-state',serverId,channelId,joined:false});void closeGroupSfu();if(serverScreenSharing())stopServerScreenShare();const streams=[serverVoiceStream,serverVoiceRawStream];serverVoiceStream=null;serverVoiceRawStream=null;for(const stream of new Set(streams.filter(Boolean)))try{stream.getTracks().forEach(track=>track.stop())}catch{}stopVoiceNoisePipeline(serverVoiceNoisePipeline);serverVoiceNoisePipeline=null;joinedVoiceServerId='';joinedVoiceChannelId='';joinedVoiceScope='';joinedVoiceAt=0;serverVoiceMuted=false;serverFocusedShareId='';serverSuppressedShares.clear();clearInterval(voiceElapsedTimer);closeServerMesh();renderServerVoiceUI();closeWatchTogether();if(activeGroupDmId){renderCallButtonState('start','Start group call','Start group voice call');callStatus.textContent='Voice off';callStatus.className='call-status';renderFriends()}else if(activeServerId){const voice=activeChannel()?.type==='voice';renderCallButtonState('start',voice?'Join voice':'Start call',voice?'Join voice channel':'Start voice call');callStatus.textContent='Voice off';callStatus.className='call-status';renderChannels()}}
async function sendServerMessage(text,gif){const server=activeServer(),channel=activeChannel();if(!server||!channel||channel.type!=='text')return false;const groupDmEntity=isGroupDm(server),groupKey=await serverTextKey(server,{create:true});if(!groupKey){await requestServerTextKey(server);pairHint.textContent=groupDmEntity?'Waiting for a group member to share this group’s current secure key.':'Waiting for an online member to share this server’s secure text key.';return false}const id=clientHex(16),time=Date.now(),payload=chatPayload(text,gif),epoch=Number(server.keyEpoch)||1,scope=groupDmEntity?'group-dm':'server',aad=relayAad(scope,id,directoryUserId,'',server.id,groupDmEntity?channel.id+'@'+epoch:channel.id),cipher=await sealRelay(groupKey.key,JSON.stringify({payload,time}),aad),envelope=groupDmEntity?{type:'relay-text',scope,id,groupId:server.id,channelId:channel.id,keyEpoch:epoch,cipher}:{type:'relay-text',scope,id,serverId:server.id,channelId:channel.id,cipher};if(!directorySend(envelope)){pairHint.textContent='Encrypted text relay is offline.';return false}const entry=normalizeServerHistoryEntry({id,text,gif:gif?.url?{url:gif.url,thumb:gif.thumb||gif.url,fallbackUrl:gif.fallbackUrl||null,emoji:gif.emoji===true}:null,author:{id:directoryUserId,name:profileName,image:'',frame:normalizeFrame(profileFrame)},time},server,directoryUserId);if(entry)storeServerHistory(server.id,channel.id,[entry]);pairHint.textContent=groupDmEntity?'Encrypted group message sent. Offline members will receive it when they return.':'Encrypted live message sent.';return true}
function directoryProfilesChanged(before,after){
  const collect=snapshot=>{const users=new Map();for(const user of [...(snapshot?.friends||[]),...Object.values(snapshot?.members||{})])if(user?.id)users.set(user.id,user);return users},left=collect(before),right=collect(after);if(left.size!==right.size)return true;
  for(const [id,user] of left){const next=right.get(id),frame=user?.frame||{},nextFrame=next?.frame||{};if(!next||user.name!==next.name||user.image!==next.image||frame.zoom!==nextFrame.zoom||frame.x!==nextFrame.x||frame.y!==nextFrame.y)return true}return false
}
function incomingGroupCallMigration(group,knownGroupIds){const migration=group?.callMigration,members=Array.isArray(migration?.members)?migration.members:[];return !knownGroupIds.has(group?.id)&&Number(migration?.expiresAt)>Date.now()&&members.length===2&&members.includes(directoryUserId)&&members.includes(dmCallPeerId)}
async function openCreatedGroup(group,migrateCall=false){if(migrateCall&&dmCallOngoing()){await endCall(false);applyRemoteCallState(false);dmCallPeerId=''}await selectGroupDm(group.id);if(migrateCall){const voice=group.channels?.find(channel=>channel.type==='voice');if(voice)await joinServerVoice(voice)}}
function applyDirectoryProfileUpdate(value){
  const profile=normalizeDirectoryProfile(value?.profile),id=String(profile?.id||'').toLowerCase();if(!/^[a-f0-9]{32}$/.test(id))return;
  const related=id===directoryUserId||(directorySnapshot.friends||[]).some(friend=>friend.id===id)||[...(directorySnapshot.servers||[]),...(directorySnapshot.groupDms||[])].some(entity=>entity.members?.includes(id));if(!related)return;
  const friends=(directorySnapshot.friends||[]).map(friend=>friend.id===id?profile:friend),members={...(directorySnapshot.members||{})};if(id!==directoryUserId&&related)members[id]=profile;
  updateDirectorySnapshot({...directorySnapshot,self:id===directoryUserId?profile:directorySnapshot.self,friends,members});
}
function applyDirectoryPresenceUpdate(value){
  const id=String(value?.userId||'').toLowerCase(),online=value?.online===true,related=id===directoryUserId||(directorySnapshot.friends||[]).some(friend=>friend.id===id)||[...(directorySnapshot.servers||[]),...(directorySnapshot.groupDms||[])].some(entity=>entity.members?.includes(id));if(!/^[a-f0-9]{32}$/.test(id)||!related)return;
  const update=user=>user?.id===id?{...user,online}:user,friends=(directorySnapshot.friends||[]).map(update),members={...(directorySnapshot.members||{})};if(members[id])members[id]=update(members[id]);directorySnapshot={...directorySnapshot,self:update(directorySnapshot.self),friends,members};renderFriends();if(activeServerId&&!activeGroupDmId)renderServerMembers();if(activePeerId===id)syncActiveDmTransport();if(serverVoiceStream){syncServerMesh();renderServerVoiceUI()}
}
function applyDirectoryEntityUpdate(value){
  const entity=normalizeDirectoryEntity(value?.entity),id=String(entity?.id||'').toLowerCase(),members=Array.isArray(entity?.members)?entity.members:[],channels=Array.isArray(entity?.channels)?entity.channels:[];if(!/^[a-f0-9]{32}$/.test(id)||!members.includes(directoryUserId)||!channels.every(channel=>/^[a-f0-9]{32}$/.test(String(channel?.id||''))))return;
  const group=entity.kind==='group-dm',key=group?'groupDms':'servers',list=Array.isArray(directorySnapshot[key])?[...directorySnapshot[key]]:[],index=list.findIndex(item=>item.id===id);if(index>=0)list[index]=entity;else list.push(entity);
  updateDirectorySnapshot({...directorySnapshot,[key]:list});
}
function applyDirectoryVoiceStates(value){
  const entityId=String(value?.entityId||'').toLowerCase(),entity=conversationEntity(entityId);if(!entity||!entity.members?.includes(directoryUserId)||!value.voiceStates||typeof value.voiceStates!=='object')return;
  const allowed=new Set((entity.channels||[]).filter(channel=>channel.type==='voice').map(channel=>channel.id)),voiceStates={...(directorySnapshot.voiceStates||{})};for(const channelId of allowed)delete voiceStates[channelId];
  for(const [channelId,rawEntries] of Object.entries(value.voiceStates)){if(!allowed.has(channelId)||!Array.isArray(rawEntries))continue;const seen=new Set(),entries=[];for(const raw of rawEntries){const id=String(raw?.id||'').toLowerCase();if(!entity.members.includes(id)||seen.has(id)||entries.length>=16)continue;seen.add(id);const joinedAt=Number(raw.joinedAt);entries.push({id,joinedAt:Number.isFinite(joinedAt)&&joinedAt>0&&joinedAt<Date.now()+60000?joinedAt:Date.now()})}voiceStates[channelId]=entries}
  directorySnapshot={...directorySnapshot,voiceStates};renderFriends();if(activeGroupDmId===entityId)renderGroupDmActions();if(activeServerId&&!activeGroupDmId)renderChannels();if(serverVoiceStream){syncServerMesh();flushPendingServerTracks();renderServerVoiceUI()}
}
function applyDirectoryDelta(value){
  const revision=Number(value?.revision),changes=Array.isArray(value?.changes)?value.changes:[];if(Number(value?.directoryVersion)!==2||!Number.isSafeInteger(revision)||revision<1||revision<=directoryRevision||!changes.length||changes.length>64)return;
  if(!directorySnapshot.self?.id){directorySend({type:'snapshot-request'});return}
  if(directoryRevision&&revision!==directoryRevision+1){directorySend({type:'snapshot-request'});return}
  directoryRevision=revision;directorySnapshot={...directorySnapshot,directoryVersion:2,revision};
  for(const change of changes){if(change?.kind==='profile')applyDirectoryProfileUpdate(change);else if(change?.kind==='presence')applyDirectoryPresenceUpdate(change);else if(change?.kind==='entity')applyDirectoryEntityUpdate(change);else if(change?.kind==='voice-states')applyDirectoryVoiceStates(change)}
}
function updateDirectorySnapshot(snapshot){
  const directoryApplyStarted=performance.now();
  snapshot=normalizeDirectorySnapshotWire(snapshot);const previous=directorySnapshot,revision=Number(snapshot?.revision);if(Number.isSafeInteger(revision)&&revision>=0&&revision<directoryRevision)return;
  if(!Array.isArray(snapshot.friends))snapshot.friends=previous.friends||[];if(!Array.isArray(snapshot.servers))snapshot.servers=previous.servers||[];if(!Array.isArray(snapshot.groupDms))snapshot.groupDms=previous.groupDms||[];
  const wiping=((previous.friends||[]).length&&!snapshot.friends.length)||((previous.servers||[]).length&&!snapshot.servers.length)||((previous.groupDms||[]).length&&!snapshot.groupDms.length);
  if(wiping){if(!directoryEmptySnapshotRetry){directoryEmptySnapshotRetry=true;directorySend({type:'snapshot-request'});return}directoryEmptySnapshotRetry=false}else directoryEmptySnapshotRetry=false;
  if(Number.isSafeInteger(revision)&&revision>=0)directoryRevision=revision;
  snapshot.members=snapshot.members&&typeof snapshot.members==='object'?snapshot.members:{};snapshot.voiceStates=snapshot.voiceStates||{};
  const profilesChanged=directoryProfilesChanged(previous,snapshot),oldServerIds=new Set((previous.servers||[]).map(server=>server.id)),oldGroupIds=new Set((previous.groupDms||[]).map(group=>group.id)),newServer=pendingServerSelection?snapshot.servers.find(server=>!oldServerIds.has(server.id)):null,pendingServer=pendingChannelCreation?snapshot.servers.find(server=>server.id===pendingChannelCreation.serverId):null,newChannel=pendingServer?.channels?.find(channel=>channel.type===pendingChannelCreation?.type&&!pendingChannelCreation.beforeIds.has(channel.id)),newGroup=pendingGroupSelection?(pendingGroupSelection.createdId?snapshot.groupDms.find(group=>group.id===pendingGroupSelection.createdId):snapshot.groupDms.find(group=>!pendingGroupSelection.beforeIds.has(group.id))):null,incomingCallGroup=!pendingGroupSelection&&dmCallOngoing()?snapshot.groupDms.find(group=>incomingGroupCallMigration(group,oldGroupIds)):null,previousJoinedGroup=(previous.groupDms||[]).find(group=>group.id===joinedVoiceServerId),nextJoinedGroup=snapshot.groupDms.find(group=>group.id===joinedVoiceServerId),voiceEpochChanged=!!serverVoiceStream&&!!previousJoinedGroup&&!!nextJoinedGroup&&Number(previousJoinedGroup.keyEpoch)!==Number(nextJoinedGroup.keyEpoch);
  directorySnapshot=snapshot;persistDirectoryRoster();const conversationIds=new Set([...snapshot.friends,...snapshot.groupDms].map(item=>item.id));let closedChanged=false,unreadChanged=false;for(const id of [...closedDmIds])if(!conversationIds.has(id)){closedDmIds.delete(id);closedChanged=true}for(const id of Object.keys(unreadDmCounts))if(!conversationIds.has(id)){delete unreadDmCounts[id];unreadChanged=true}for(const id of [...pendingGroupEnvelopes.keys()])if(!snapshot.groupDms.some(group=>group.id===id))pendingGroupEnvelopes.delete(id);if(closedChanged)persistClosedDms();if(unreadChanged)persistUnreadDms();void serverTextMembershipSync().then(async()=>{const group=groupDm(activeGroupDmId);if(group&&!await serverTextKey(group)){await requestServerTextKey(group)}});renderServers();renderFriends();renderUnreadBadges();syncActiveDmTransport();if(!activePeerId&&!activeServerId&&!activeGroupDmId)showFriendsLanding();
  if(activePeerId){const friend=directoryUser(activePeerId);if(friend)applyFriendProfile(friend);else showFriendsLanding()}if(dmCallPeerId)renderCallPeerProfile();if(activeGroupDmId){const activeGroup=groupDm(activeGroupDmId);if(!activeGroup)showFriendsLanding();else{roomTitle.textContent=groupDmDisplayName(activeGroup);$('#chatTitle').textContent=groupDmDisplayName(activeGroup);renderGroupDmActions()}}
  const joinedEntity=joinedVoiceServerId?conversationEntity(joinedVoiceServerId):null,pendingVoiceEntity=serverVoiceAttempt?conversationEntity(serverVoiceAttempt.serverId):null;if(serverVoiceStream&&joinedVoiceChannelId&&!joinedEntity?.channels?.some(channel=>channel.id===joinedVoiceChannelId)||serverVoiceAttempt&&!pendingVoiceEntity?.channels?.some(channel=>channel.id===serverVoiceAttempt.channelId))stopServerVoice();if(voiceEpochChanged){closeServerMesh()}if(activeServerId&&!activeGroupDmId){const server=activeServer();if(activeChannelId&&!server?.channels?.some(channel=>channel.id===activeChannelId)){const fallback=server?.channels?.find(channel=>channel.type==='text')||server?.channels?.[0];if(fallback)selectServerChannel(server.id,fallback.id)}else renderChannels()}if(serverVoiceStream){syncServerMesh();flushPendingServerTracks();renderServerVoiceUI()}
  if(newServer){pendingServerSelection=false;const dialog=$('#serverDialog');if(dialog?.open)dialog.close();selectServer(newServer.id)}if(newChannel){pendingChannelCreation=null;const dialog=$('#channelDialog');if(dialog?.open)dialog.close();selectServerChannel(pendingServer.id,newChannel.id)}if(pendingGroupUpdateId){const updated=snapshot.groupDms.find(group=>group.id===pendingGroupUpdateId.id),changed=updated&&updated.members.some(id=>!pendingGroupUpdateId.beforeMembers.has(id));if(changed){pendingGroupUpdateId='';const dialog=$('#groupDmDialog');if(dialog?.open)dialog.close()}}if(newGroup){const migration=pendingGroupSelection.migrateCall;pendingGroupSelection=null;const dialog=$('#groupDmDialog');if(dialog?.open)dialog.close();void openCreatedGroup(newGroup,migration)}else if(incomingCallGroup)void openCreatedGroup(incomingCallGroup,true);if(profilesChanged&&activeConversationKey&&!newGroup&&!incomingCallGroup)openConversation(activeConversationKey);recordMetric('directory.apply_ms',performance.now()-directoryApplyStarted)
}
async function connectDirectory(){
  const generation=++directoryConnectGeneration;clearTimeout(directoryReconnect);directoryReconnect=null;await profileSettingsReady;if(generation!==directoryConnectGeneration)return;let sessionNeedsLogin=false;
  if(!directoryStateRestored){const saved=await Promise.all([ss('directoryUserId'),ss('directoryToken'),ss('messageHistory'),ss('directoryAccountName'),ss('closedDmIds'),ss('unreadDmCounts'),ss('directoryRosterCache')]);if(generation!==directoryConnectGeneration)return;const keepTransient=transientDirectorySession&&/^[a-f0-9]{32}$/.test(directoryUserId)&&/^[a-f0-9]{64}$/.test(directoryToken);if(!keepTransient){const identity=await loadDirectoryIdentity();directoryUserId=identity.userId;directoryToken=identity.token;directoryAccountName=identity.accountName;if(identity.minted){await ssSet('directoryUserId',directoryUserId);await ssSet('directoryToken',directoryToken)}sessionNeedsLogin=identity.needsLogin}try{const parsed=JSON.parse(saved[2]||'{}');if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.keys(parsed).length){if(window.pairHistory&&await window.pairHistory.importLegacy(directoryUserId,parsed))await ssSet('messageHistory',null);else conversationHistories=parsed}}catch(error){console.warn('[history] legacy migration failed:',error?.message||error)}try{const closed=JSON.parse(saved[4]||'[]');if(Array.isArray(closed))closedDmIds=new Set(closed.filter(id=>/^[a-f0-9]{32}$/.test(id)))}catch{}try{const unread=JSON.parse(saved[5]||'{}');if(unread&&typeof unread==='object'&&!Array.isArray(unread))unreadDmCounts=Object.fromEntries(Object.entries(unread).filter(([id,count])=>/^[a-f0-9]{32}$/.test(id)&&Number(count)>0).map(([id,count])=>[id,Math.min(9999,Math.floor(Number(count)))]))}catch{}if(restoreDirectoryRosterCache(saved[6])){renderServers();renderFriends();renderUnreadBadges();if(!activePeerId&&!activeServerId&&!activeGroupDmId)showFriendsLanding()}directoryStateRestored=true;renderUnreadBadges();renderAccountSummary();void startLanHouse()}
  if(sessionNeedsLogin&&!/^[a-f0-9]{64}$/.test(directoryToken)){setDirectoryState(false,'Sign in required');const dialog=$('#accountDialog');if(dialog&&!dialog.open)dialog.showModal();$('#authSigninTab')?.click();if($('#authStatus'))$('#authStatus').textContent='Your saved session could not be read. Sign in again — your photo and other settings stay on this device.';return}
  if(generation!==directoryConnectGeneration)return;if(directorySocket){const previous=directorySocket;directorySocket=null;try{previous.close()}catch{}}
  setDirectoryState(false,'Connecting…');const socket=new WebSocket(directoryAddress());directorySocket=socket;
  socket.onopen=async()=>{if(directorySocket!==socket)return;directoryBackoff=1000;try{const profile=await directoryProfile();if(directorySocket===socket&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'hello',directoryVersion:2,userId:directoryUserId,token:directoryToken,...profile}))}catch(error){console.warn('directory profile',error);if(directorySocket===socket&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'hello',directoryVersion:2,userId:directoryUserId,token:directoryToken,name:profileName}))}};
  socket.onmessage=event=>{try{
    if(directorySocket!==socket)return;
    const value=JSON.parse(event.data),wireBytes=enc.encode(event.data).byteLength;if(value.type==='snapshot')recordMetric('directory.snapshot_bytes',wireBytes);else if(['profile-update','presence-update','entity-update','voice-states','directory-delta'].includes(value.type))recordMetric('directory.delta_bytes',wireBytes);
    if(value.type==='authenticated'){directoryFeatures={groupSfu:value.features?.groupSfu===true,encryptedFileRelay:value.features?.encryptedFileRelay===true};syncGroupSfuSettingUi();syncFileRelaySettingUi();directoryAccountName=value.username||directoryAccountName;if(directoryAccountName){ssSet('directoryAccountName',directoryAccountName);const connectedMessage='Signed in as @'+directoryAccountName+'. Connected.';if($('#accountStatus'))$('#accountStatus').textContent=connectedMessage;if($('#authStatus'))$('#authStatus').textContent=connectedMessage}renderAccountSummary();setDirectoryState(true,'Online');directoryProfilePush();if(callActive)publishCallState(true);void maybeShowAccountOnboarding();void startLanHouse()}
    else if(value.type==='account-session'){directoryAccountName=value.username||'';persistAccountSession({username:directoryAccountName,remember:pendingAccountRemember}).catch(()=>{});$('#accountPassword').value='';$('#accountStatus').textContent='Account created. You can now sign in on another operating system.';const authStatus=$('#authStatus'),submit=$('#authSubmit'),continueButton=$('#authContinueLocal');if(authStatus)authStatus.textContent='✓ You’re signed up as @'+directoryAccountName+'. Your account is ready.';if(submit)submit.disabled=true;if(continueButton)continueButton.textContent='Continue to Knot';renderAccountSummary()}
    else if(value.type==='snapshot')updateDirectorySnapshot(value);
    else if(value.type==='profile-update')applyDirectoryProfileUpdate(value);
    else if(value.type==='presence-update')applyDirectoryPresenceUpdate(value);
    else if(value.type==='entity-update')applyDirectoryEntityUpdate(value);
    else if(value.type==='voice-states')applyDirectoryVoiceStates(value);
    else if(value.type==='directory-delta')applyDirectoryDelta(value);
    else if(value.type==='sfu-response'){const pending=groupSfuPending.get(String(value.requestId||''));if(pending){groupSfuPending.delete(value.requestId);value.ok===false?pending.reject(new Error(value.message||'SFU request failed')):pending.resolve(value)}}
    else if(value.type==='sfu-track-set'){if(groupSfuPilot&&value.groupId===joinedVoiceServerId&&value.channelId===joinedVoiceChannelId)groupSfuPilot.syncTracks(value.tracks||[]).catch(fallBackFromGroupSfu)}
    else if(value.type==='file-relay-response'){const pending=fileRelayPending.get(String(value.requestId||''));if(pending){fileRelayPending.delete(value.requestId);value.ok===false?pending.reject(new Error(value.message||'Encrypted file relay request failed')):pending.resolve(value)}}
    else if(value.type==='file-relay-offer')receiveEncryptedFileRelay(value).catch(error=>console.warn('encrypted file relay',error))
    else if(value.type==='group-dm-created'){if(pendingGroupSelection)pendingGroupSelection.createdId=String(value.groupId||'')}
    else if(value.type==='call-presence'){const from=String(value.from||'');if(value.active&&directoryUser(from)&&(!dmCallOngoing()||dmCallPeerId===from)){dmCallPeerId=from;applyRemoteCallState(true,value.session||'')}else if(!value.active&&dmCallPeerId===from)applyRemoteCallState(false,value.session||'')}
    else if(value.type==='invite-created'){if(value.kind==='friend'){const input=$('#roomCode');input.value=value.code;pairHint.textContent='Friend code '+value.code+' is ready for 15 minutes.'}else showServerInvite(value.code)}
    else if(value.type==='connect-request'){
      const friend=directoryUser(value.from),samePeer=dmConnectingPeerId===value.from&&(!!pc||!!signaling),useRelay=value.context?.relay===true;
      if(!friend||dmCallOngoing())return;
      // When both people click the same DM, one stable side keeps hosting and
      // the other joins it. This prevents competing offers from cancelling.
      if(samePeer&&directoryUserId<value.from)return;
      if(dmMediaPlan?.peerId===value.from)dmMediaPlan.cancelled=true;
      const resumeVoice=pendingVoiceStartPeerId===value.from;
      dmConnectingPeerId=value.from;
      if(!activeServerId&&(!activePeerId||activePeerId===value.from))activateDmView(friend);
      (async()=>{try{
        if(useRelay){pairHint.textContent='Preparing low-bandwidth voice relay…';dmIceServers=await requestTurnCredentials();relayVoiceMode=true}
        else{dmIceServers=directIceServers();relayVoiceMode=false}
        await automaticPair('join',value.session,value.from);
        if(resumeVoice)pendingVoiceStartPeerId=value.from;
        if(activePeerId===value.from)applyFriendProfile(friend);
      }catch(error){if(activePeerId===value.from)pairHint.textContent=error?.message||'Could not prepare peer connection'}})()
    }
    else if(value.type==='relay-text')receiveRelayText(value).catch(error=>console.warn('encrypted relay text',error))
    else if(value.type==='relay-key')receiveRelayKey(value).catch(error=>console.warn('encrypted relay key',error))
    else if(value.type==='relay-status'){if(activeGroupDmId&&value.queued)pairHint.textContent='Encrypted message sent. Offline group members will receive it when they return.'}
    else if(value.type==='turn-credentials')acceptTurnCredentials(value)
    else if(value.type==='peer-signal'&&['server','group-dm'].includes(value.context?.type))handleServerSignal(value).catch(error=>console.warn('peer signal',error))
    else if(value.type==='error'){const message=value.message||'Knot directory request failed',requestId=String(value.requestId||''),sfuPending=groupSfuPending.get(requestId),relayPending=fileRelayPending.get(requestId);if(sfuPending){groupSfuPending.delete(requestId);sfuPending.reject(new Error(message))}if(relayPending){fileRelayPending.delete(requestId);relayPending.reject(new Error(message))}if(value.action==='turn-credentials')turnCredentialPending?.reject(new Error(message));if(value.action==='create-account'){if($('#accountStatus'))$('#accountStatus').textContent=message;if($('#authStatus'))$('#authStatus').textContent=message}else pairHint.textContent=message;const dialog=$('#serverDialog');if(dialog?.open&&['create-server','redeem-invite'].includes(value.action)){pendingServerSelection=false;$('#serverDialogStatus').textContent=message;dialog.querySelectorAll('form button').forEach(button=>button.disabled=false)}const groupDialog=$('#groupDmDialog');if(groupDialog?.open&&['create-group-dm','add-group-member','update-group-dm','remove-group-member','leave-group-dm'].includes(value.action)){pendingGroupSelection=null;pendingGroupUpdateId='';$('#groupDmStatus').textContent=message;groupDialog.querySelectorAll('button,input').forEach(control=>control.disabled=false)}}
  }catch(error){console.warn('directory message',error)}};
  socket.onclose=event=>{if(directorySocket!==socket)return;directorySocket=null;const disconnected=new Error('Knot signaling disconnected');for(const pending of groupSfuPending.values())pending.reject(disconnected);groupSfuPending.clear();for(const pending of fileRelayPending.values())pending.reject(disconnected);fileRelayPending.clear();if(event.code===1008&&/authenticat|account|credential|session/i.test(event.reason||'')&&!/too many account sessions/i.test(event.reason||'')){setDirectoryState(false,'Sign in required');if(/^[a-f0-9]{64}$/.test(directoryToken))ssSet('directoryToken',null);const dialog=$('#accountDialog');if(dialog&&!dialog.open)dialog.showModal();$('#authSigninTab')?.click();if($('#authStatus'))$('#authStatus').textContent='Your saved session expired or was revoked. Sign in again — your photo and other settings stay on this device.';return}setDirectoryState(false,'Offline — retrying');directoryReconnect=setTimeout(()=>{if(!directorySocket)void connectDirectory()},directoryBackoff);directoryBackoff=Math.min(30000,directoryBackoff*2)};socket.onerror=()=>{if(directorySocket===socket)setDirectoryState(false,'Connection error')};
}
function installFriendNavigation(){const search=$('#friendSearch');search.oninput=renderFriends;search.onkeydown=event=>{if(event.key!=='Enter')return;const first=$('#friendList .friend-entry');if(first){event.preventDefault();first.click()}};$('#friendsHome').onclick=()=>{search.value='';activePeerId='';activeGroupDmId='';showFriends();showFriendsLanding();search.focus()};const clearVisibleUnread=()=>{if(document.visibilityState!=='visible'||!document.hasFocus())return;if(activeGroupDmId)clearDmUnread(activeGroupDmId);else if(activePeerId&&!activeServerId)clearDmUnread(activePeerId)};window.addEventListener('focus',clearVisibleUnread);document.addEventListener('visibilitychange',clearVisibleUnread)}
function installChannelDialog(){const dialog=$('#channelDialog'),form=$('#channelForm'),input=$('#newChannelName'),kind=$('#channelDialogKind'),status=$('#channelDialogStatus'),submit=form.querySelector('.primary');let channelType='text';const open=type=>{if(!canEditServer())return;channelType=type==='voice'?'voice':'text';kind.textContent=channelType.toUpperCase()+' CHANNEL';input.placeholder=channelType==='voice'?'New voice':'new-channel';input.value=channelType==='voice'?'New voice':'new-channel';status.textContent='';submit.disabled=false;dialog.showModal();setTimeout(()=>input.select(),0)};$('#addTextChannel').onclick=()=>open('text');$('#addVoiceChannel').onclick=()=>open('voice');$('#closeChannelDialog').onclick=()=>dialog.close();dialog.addEventListener('click',event=>{const box=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom))dialog.close()});form.onsubmit=event=>{event.preventDefault();const server=activeServer(),name=cleanClientName(input.value,channelType==='voice'?'New voice':'new-channel');if(!canEditServer(server)){dialog.close();return}if(!directorySend({type:'create-channel',serverId:server.id,channelType,name})){status.textContent='Knot is offline. Reconnect before creating a channel.';return}pendingChannelCreation={serverId:server.id,type:channelType,beforeIds:new Set(server.channels.map(channel=>channel.id))};status.textContent='Creating '+name+'…';submit.disabled=true}}
function installServerDialog(){const dialog=$('#serverDialog'),status=$('#serverDialogStatus'),createForm=$('#createServerForm'),joinForm=$('#joinServerForm'),name=$('#newServerName'),code=$('#serverInviteCode'),buttons=[...dialog.querySelectorAll('form button')];const setBusy=text=>{status.textContent=text;buttons.forEach(button=>button.disabled=true)};const open=()=>{status.textContent='';buttons.forEach(button=>button.disabled=false);dialog.showModal();setTimeout(()=>name.select(),0)};$('#addServer').onclick=open;$('#closeServerDialog').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{buttons.forEach(button=>button.disabled=false);if(!pendingServerSelection)status.textContent=''});dialog.addEventListener('click',event=>{const box=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom))dialog.close()});code.addEventListener('input',()=>{code.value=code.value.replace(/\D/g,'').slice(0,5)});createForm.onsubmit=event=>{event.preventDefault();const serverName=cleanClientName(name.value,'New server');if(!directorySend({type:'create-server',name:serverName})){status.textContent='Knot is offline. Reconnect before creating a server.';return}pendingServerSelection=true;setBusy('Creating '+serverName+'…')};joinForm.onsubmit=event=>{event.preventDefault();const invite=code.value.trim();if(!/^\d{5}$/.test(invite)){status.textContent='Enter the five-digit server invite code.';code.focus();return}if(!directorySend({type:'redeem-invite',code:invite})){status.textContent='Knot is offline. Reconnect before joining a server.';return}pendingServerSelection=true;setBusy('Joining server…')}}
function showServerInvite(code=''){const dialog=$('#serverInviteDialog'),output=$('#serverInviteCodeOutput'),status=$('#serverInviteStatus'),copy=$('#copyServerInvite');if(!dialog||!output||!status)return;output.value=code;copy.disabled=!/^\d{5}$/.test(code);status.textContent=copy.disabled?'Creating a secure invite…':'Ready to send — this code expires in 15 minutes.';if(!dialog.open)dialog.showModal();if(code)setTimeout(()=>output.select(),0)}
function installServerInviteDialog(){const dialog=$('#serverInviteDialog'),output=$('#serverInviteCodeOutput'),status=$('#serverInviteStatus'),copy=$('#copyServerInvite');if(!dialog)return;$('#closeServerInvite').onclick=()=>dialog.close();copy.onclick=async()=>{const code=output.value;if(!/^\d{5}$/.test(code))return;try{await navigator.clipboard.writeText(code);status.textContent='Invite code copied. Send it to your friend.'}catch{output.select();status.textContent='Select and copy the code above to send it.'}};dialog.addEventListener('click',event=>{const box=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom))dialog.close()})}
let showGroupDmDialog=()=>{};
function installGroupDmDialog(){
  const dialog=$('#groupDmDialog'),form=$('#groupDmForm'),title=$('#groupDmDialogTitle'),name=$('#groupDmName'),nameLabel=dialog?.querySelector('label[for="groupDmName"]'),list=$('#groupDmFriendList'),status=$('#groupDmStatus'),submit=$('#groupDmCreate');if(!dialog||!form)return;let mode='create',targetGroupId='',requiredSeed='';
  const selectedIds=()=>[...list.querySelectorAll('input[type="checkbox"]:checked')].map(input=>input.value);
  const groupMemberLimit=(group)=>mode==='add'?Math.max(0,GROUP_DM_MAX_MEMBERS-(group?.members?.length||0)):GROUP_DM_MAX_MEMBERS-1;
  const paintStatus=()=>{const selected=selectedIds().length,group=groupDm(targetGroupId),limit=groupMemberLimit(group),minimum=mode==='add'?1:2;status.textContent=selected>limit?'That would exceed the '+GROUP_DM_MAX_MEMBERS+'-person group limit.':selected<minimum?(mode==='add'?'Choose at least one friend.':'Choose at least two friends.'):selected+' selected · '+(limit-selected)+' spot'+(limit-selected===1?'':'s')+' left';submit.disabled=selected<minimum||selected>limit;};
  showGroupDmDialog=({nextMode='create',groupId='',seedIds=[]}={})=>{
    dialog.querySelectorAll('button,input').forEach(control=>control.disabled=false);mode=nextMode==='add'?'add':'create';targetGroupId=mode==='add'?groupId:'';requiredSeed=mode==='create'&&seedIds.length===1?seedIds[0]:'';const group=groupDm(targetGroupId),excluded=new Set(mode==='add'?(group?.members||[]):[]),friends=(directorySnapshot.friends||[]).filter(friend=>!excluded.has(friend.id));title.textContent=mode==='add'?'Add people to '+groupDmDisplayName(group):'Create a group';name.hidden=mode==='add';if(nameLabel)nameLabel.hidden=mode==='add';name.value='';submit.textContent=mode==='add'?'Add to group':'Create group DM';submit.disabled=false;status.textContent='';list.replaceChildren();
    for(const friend of friends){const option=document.createElement('label');option.className='group-dm-friend-option';const avatar=document.createElement('span');avatar.className='friend-avatar';paintDirectoryAvatar(avatar,friend);const copy=document.createElement('span');const strong=document.createElement('strong');strong.textContent=friend.name||'Knot user';const small=document.createElement('small');small.textContent=friend.online?'Online':'Offline';copy.append(strong,small);const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=friend.id;checkbox.checked=seedIds.includes(friend.id);checkbox.disabled=friend.id===requiredSeed;checkbox.onchange=()=>{const limit=groupMemberLimit(group);if(selectedIds().length>limit){checkbox.checked=false;status.textContent='Group DMs can have at most '+GROUP_DM_MAX_MEMBERS+' people.'}paintStatus()};option.append(avatar,copy,checkbox);list.append(option)}
    if(!friends.length){const empty=document.createElement('p');empty.className='social-empty';empty.textContent=mode==='add'?'All of your friends are already in this group, or the group is full.':'Add at least two friends before creating a group DM.';list.append(empty)}paintStatus();if(!dialog.open)dialog.showModal();setTimeout(()=>{if(mode==='create')name.focus();else list.querySelector('input:not(:disabled)')?.focus()},0)
  };
  $('#newGroupDm').onclick=()=>showGroupDmDialog();$('#groupDmAddPeople').onclick=()=>{if(activeGroupDmId)showGroupDmDialog({nextMode:'add',groupId:activeGroupDmId});else if(activePeerId)showGroupDmDialog({seedIds:[activePeerId]})};$('#groupDmCancel').onclick=()=>dialog.close();dialog.addEventListener('click',event=>{const box=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom))dialog.close()});
  form.onsubmit=event=>{event.preventDefault();const memberIds=selectedIds();if(mode==='create'){
      if(memberIds.length<2||memberIds.length>GROUP_DM_MAX_MEMBERS-1){paintStatus();return}const fallback=memberIds.map(id=>directoryUser(id)?.name).filter(Boolean).slice(0,3).join(', ')||'Group DM',groupName=cleanClientName(name.value,fallback),migrateCall=dmCallOngoing()&&dmCallPeerId===requiredSeed&&memberIds.includes(requiredSeed),request={type:'create-group-dm',name:groupName,memberIds,...(migrateCall?{migrateCallPeerId:dmCallPeerId}:{})};if(!directorySend(request)){status.textContent='Knot is offline. Reconnect before creating a group.';return}pendingGroupSelection={beforeIds:new Set((directorySnapshot.groupDms||[]).map(group=>group.id)),createdId:'',migrateCall};status.textContent=migrateCall?'Creating the group and moving your call…':'Creating encrypted group DM…'
    }else{
      const group=groupDm(targetGroupId);if(!group||!memberIds.length||group.members.length+memberIds.length>GROUP_DM_MAX_MEMBERS){paintStatus();return}if(!directorySend({type:'add-group-member',groupId:group.id,memberIds})){status.textContent='Knot is offline. Reconnect before adding people.';return}pendingGroupUpdateId={id:group.id,beforeMembers:new Set(group.members)};status.textContent='Adding '+memberIds.length+' friend'+(memberIds.length===1?'':'s')+'…'
    }dialog.querySelectorAll('button,input').forEach(control=>control.disabled=true)
  };
  $('#groupDmLeave').onclick=()=>{const group=groupDm(activeGroupDmId);if(!group||!confirm('Leave '+groupDmDisplayName(group)+'? You will lose access to its local conversation view.'))return;if(serverVoiceStream&&joinedVoiceServerId===group.id||serverVoiceAttempt?.serverId===group.id)stopServerVoice();if(directorySend({type:'leave-group-dm',groupId:group.id})){pairHint.textContent='Leaving group DM…';showFriendsLanding()}else pairHint.textContent='Knot is offline. Reconnect before leaving the group.'}
}
function watchApi(){return window.KnotWatchTogether||null}
function watchLive(){return !!(callActive||friendInCall||serverVoiceStream)}
function placeWatchTogether(){
  const panel=$('#watchTogether');if(!panel)return;
  const host=serverVoiceStream&&!$('#serverVoiceStage')?.hidden?$('#serverWatchMount'):$('#dmWatchMount');
  if(host&&panel.parentElement!==host)host.append(panel);
  panel.hidden=!watchLive();
  panel.classList.toggle('is-open',!!watchSession);
  document.body.classList.toggle('watching-together',!!watchSession&&watchLive());
  const toggle=$('#watchToggle'),close=$('#watchClose'),seek=$('#watchSeek'),status=$('#watchStatus');
  if(toggle){toggle.hidden=!watchSession;toggle.textContent=watchSession?.playing===false?'Play':'Pause'}
  if(close)close.hidden=!watchSession;
  if(seek){seek.hidden=!watchSession||watchSession.kind!=='local';if(watchSession?.kind==='local'&&watchSession.duration)seek.max=String(watchSession.duration)}
  if(status){status.hidden=!watchSession&&!status.textContent;if(watchSession)status.textContent=watchSession.kind==='local'?(watchSession.title||'This PC')+' · pick the same file on each computer':(watchSession.title||'YouTube')}
}
function sendWatch(payload){
  const body={t:'watch',v:1,...payload};
  send(body);
  if(!joinedVoiceServerId)return;
  const json=JSON.stringify({...body,serverId:joinedVoiceServerId});
  for(const [,state] of serverPeers)if(state.channel?.readyState==='open')try{state.channel.send(json)}catch{}
}
function requestWatchState(){if(watchLive())sendWatch({action:'request'})}
function currentWatchSnapshot(){
  if(!watchSession)return null;
  const time=watchSession.kind==='local'?($('#watchLocal')?.currentTime||watchSession.time||0):watchApi()?.mediaTime(watchSession,Date.now())||watchSession.time||0;
  return {...watchSession,time,at:Date.now(),playing:watchSession.kind==='local'?!($('#watchLocal')?.paused):!!watchSession.playing};
}
function paintWatchMedia(){
  const api=watchApi(),session=watchSession,frame=$('#watchFrame'),video=$('#watchLocal');
  if(!frame||!video)return;
  if(!session){frame.hidden=true;frame.replaceChildren();video.hidden=true;video.removeAttribute('src');try{video.load()}catch{};return}
  if(session.kind==='youtube'&&api){
    video.hidden=true;frame.hidden=false;
    const src=api.watchEmbedUrl(session.id,{start:api.mediaTime(session),playing:session.playing!==false});
    if(frame.dataset.src!==src){frame.dataset.src=src;frame.replaceChildren();const iframe=document.createElement('iframe');iframe.src=src;iframe.title=session.title||'Watch together';iframe.allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';iframe.allowFullscreen=true;iframe.referrerPolicy='strict-origin-when-cross-origin';frame.append(iframe)}
    return;
  }
  frame.hidden=true;frame.replaceChildren();video.hidden=false;
  if(session.objectUrl&&video.src!==session.objectUrl){watchApplying=true;video.src=session.objectUrl}
  try{if(session.playing!==false)video.play().catch(()=>{});else video.pause()}catch{}
  const target=api?.mediaTime(session,Date.now())||session.time||0;
  if(api?.drifted(video.currentTime,target,1.25))video.currentTime=target;
  watchApplying=false;
}
function applyWatchSession(next,{lead=false}={}){
  watchSession=next;watchLeader=lead||watchLeader;watchSeq=Math.max(watchSeq,Number(next?.seq)||watchSeq);
  paintWatchMedia();placeWatchTogether();
  clearInterval(watchTimer);watchTimer=null;
  if(watchSession&&watchLeader)watchTimer=setInterval(()=>{if(!watchLeader||!watchSession)return;const snap=currentWatchSnapshot();if(!snap)return;sendWatch({action:'state',playing:snap.playing!==false,time:snap.time,at:snap.at,seq:++watchSeq})},4000);
}
function closeWatchTogether(){
  watchLeader=false;watchSeq=0;clearInterval(watchTimer);watchTimer=null;
  if(watchObjectUrl){try{URL.revokeObjectURL(watchObjectUrl)}catch{}watchObjectUrl=''}
  watchSession=null;paintWatchMedia();placeWatchTogether();
}
function receiveWatchMessage(raw){
  const api=watchApi(),value=api?.cleanWatchMessage(raw);if(!value||!watchLive())return;
  if(value.action==='request'){if(watchSession&&watchLeader){const snap=currentWatchSnapshot();if(snap)sendWatch({action:'open',...snap,objectUrl:undefined})}return}
  if(value.action==='close'){if(!watchLeader)closeWatchTogether();return}
  if(value.action==='need-file'){if(watchStatusText)watchStatusText('They need the same local file');return}
  if(value.action==='open'||value.action==='state'){
    if(!api.newerWatch(watchSession,value))return;
    if(value.action==='open'&&value.kind==='local'&&watchSession?.hash===value.hash&&watchSession.objectUrl)value.objectUrl=watchSession.objectUrl;
    if(value.kind==='local'&&!value.objectUrl&&watchSession?.hash!==value.hash){$('#watchStatus').hidden=false;$('#watchStatus').textContent='Pick the same file: '+(value.name||'video')}
    applyWatchSession({...watchSession,...value},{lead:false});
  }
}
function watchStatusText(text){const status=$('#watchStatus');if(!status)return;status.hidden=!text;status.textContent=text||''}
async function openWatchYoutube(url){
  const api=watchApi();if(!watchLive()){watchStatusText('Join a call first, then watch together');return}
  const id=api?.youtubeVideoId(url);if(!id){watchStatusText('Paste a YouTube link');return}
  watchLeader=true;const session={kind:'youtube',id,title:'YouTube',playing:true,time:0,at:Date.now(),seq:++watchSeq};
  applyWatchSession(session,{lead:true});sendWatch({action:'open',...session});
}
async function openWatchFile(file){
  const api=watchApi();if(!watchLive()){watchStatusText('Join a call first, then watch together');return}
  if(!file)return;const prefix=await file.slice(0,Math.min(file.size,api?.PREFIX_BYTES||2*1024*1024)).arrayBuffer();
  const hash=await api.hashPrefix(prefix);if(watchObjectUrl)try{URL.revokeObjectURL(watchObjectUrl)}catch{};watchObjectUrl=URL.createObjectURL(file);
  if(watchSession?.kind==='local'&&watchSession.hash===hash){watchSession={...watchSession,objectUrl:watchObjectUrl,name:file.name};applyWatchSession(watchSession,{lead:false});watchStatusText('Matched '+file.name);return}
  watchLeader=true;const session={kind:'local',hash,size:file.size,name:file.name,title:file.name,playing:true,time:0,at:Date.now(),seq:++watchSeq,objectUrl:watchObjectUrl,duration:0};
  applyWatchSession(session,{lead:true});sendWatch({action:'open',kind:'local',hash,size:file.size,name:file.name,title:file.name,playing:true,time:0,at:session.at,seq:session.seq});
}
function installWatchTogether(){
  const panel=$('#watchTogether'),open=$('#watchOpen'),url=$('#watchUrl'),pick=$('#watchPickFile'),file=$('#watchFile'),toggle=$('#watchToggle'),close=$('#watchClose'),seek=$('#watchSeek'),video=$('#watchLocal');
  if(!panel)return;placeWatchTogether();
  open?.addEventListener('click',()=>openWatchYoutube(url?.value||''));
  url?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();openWatchYoutube(url.value)}});
  pick?.addEventListener('click',()=>file?.click());
  file?.addEventListener('change',()=>{const next=file.files?.[0];file.value='';if(next)void openWatchFile(next)});
  toggle?.addEventListener('click',()=>{if(!watchSession)return;watchLeader=true;if(watchSession.kind==='local'&&video){if(video.paused)video.play().catch(()=>{});else video.pause();return}watchSession={...watchSession,playing:watchSession.playing===false,time:watchApi()?.mediaTime(watchSession,Date.now())||0,at:Date.now(),seq:++watchSeq};applyWatchSession(watchSession,{lead:true});sendWatch({action:'state',playing:watchSession.playing!==false,time:watchSession.time,at:watchSession.at,seq:watchSession.seq})});
  close?.addEventListener('click',()=>{sendWatch({action:'close'});closeWatchTogether()});
  video?.addEventListener('play',()=>{if(watchApplying||!watchSession)return;watchLeader=true;watchSession={...watchSession,playing:true,time:video.currentTime,at:Date.now(),seq:++watchSeq};sendWatch({action:'state',playing:true,time:video.currentTime,at:watchSession.at,seq:watchSession.seq});placeWatchTogether()});
  video?.addEventListener('pause',()=>{if(watchApplying||!watchSession)return;watchLeader=true;watchSession={...watchSession,playing:false,time:video.currentTime,at:Date.now(),seq:++watchSeq};sendWatch({action:'state',playing:false,time:video.currentTime,at:watchSession.at,seq:watchSession.seq});placeWatchTogether()});
  video?.addEventListener('seeked',()=>{if(watchApplying||!watchSession||!watchLeader)return;watchSession={...watchSession,time:video.currentTime,at:Date.now(),seq:++watchSeq};sendWatch({action:'state',playing:!video.paused,time:video.currentTime,at:watchSession.at,seq:watchSession.seq});if(seek)seek.value=String(video.currentTime)});
  video?.addEventListener('loadedmetadata',()=>{if(watchSession)watchSession.duration=video.duration||0;if(seek)seek.max=String(video.duration||1)});
  seek?.addEventListener('input',()=>{if(!video||!watchSession)return;watchApplying=true;video.currentTime=Number(seek.value)||0;watchApplying=false});
}

function rewriteLanSdp(sdp,ip){return typeof sdp==='string'&&ip?sdp.replace(/(\s)([A-Za-z0-9-]+\.local)(\s)/g,'$1'+ip+'$3'):sdp}
async function deviceKeyFingerprint(key){if(!validDevicePublicKey(key))return '';const digest=await crypto.subtle.digest('SHA-256',enc.encode(key.x+'|'+key.y));return [...new Uint8Array(digest)].slice(0,16).map(b=>b.toString(16).padStart(2,'0')).join('')}
async function lanAuthKey(peerId){const peer=directoryUser(peerId);if(!validDevicePublicKey(peer?.deviceKey))throw new Error('Missing friend device key');const identity=await deviceIdentity(),remote=await importPub(peer.deviceKey),bits=await crypto.subtle.deriveBits({name:'ECDH',public:remote},identity.privateKey,256),label=enc.encode('knot-lan-auth-v1|'+[directoryUserId,peerId].sort().join('|')),material=new Uint8Array(bits.byteLength+label.byteLength);material.set(new Uint8Array(bits));material.set(label,bits.byteLength);return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',material),{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])}
async function lanProof(peerId,message){const sig=await crypto.subtle.sign('HMAC',await lanAuthKey(peerId),enc.encode(message));return base64UrlEncode(new Uint8Array(sig))}
async function refreshLanFingerprints(){
  try{
    lanFingerprints.clear();
    const users=[directorySnapshot.self,...(directorySnapshot.friends||[])];
    for(const user of users){if(!user?.id)continue;const fp=await deviceKeyFingerprint(user.deviceKey);if(fp)lanFingerprints.set(fp,user.id)}
    if(directorySnapshot.self)lanSelfFp=await deviceKeyFingerprint(directorySnapshot.self.deviceKey)||lanSelfFp;
  }catch{}
}
function lanSend(id,value){return window.pairLan?.send(id,value)}
function rememberLanNeighbor(peerId,info){
  const previous=lanNeighbors.get(peerId)||{};
  lanNeighbors.set(peerId,{...previous,...info,at:Date.now()});
  if(!activePeerId&&!activeServerId&&!activeGroupDmId)showFriendsLanding();
  renderFriends();syncActiveDmTransport();setDirectoryState(directorySocket?.readyState===WebSocket.OPEN,'Online');
}
async function startLanHouse(){
  if(!window.pairLan||!directoryUserId)return;
  await refreshLanFingerprints();
  if(!lanSelfFp){const pub=await devicePublicKey();lanSelfFp=await deviceKeyFingerprint(pub)}
  if(!lanNonce)lanNonce=clientHex(16);
  const started=await window.pairLan.start().catch(()=>null);
  if(!started?.ok)return;lanStarted=true;
  await window.pairLan.setBeacon(lanSelfFp,lanNonce);
}
function installLanListeners(){
  if(!window.pairLan||window.pairLan._knotBound)return;window.pairLan._knotBound=true;
  window.pairLan.onBeacon(beacon=>{
    if(!beacon||beacon.fp===lanSelfFp)return;
    const peerId=lanFingerprints.get(beacon.fp);if(!peerId||peerId===directoryUserId)return;
    rememberLanNeighbor(peerId,{host:beacon.host,port:beacon.port,fp:beacon.fp,nonce:beacon.nonce});
    if(directoryUserId<peerId&&![...lanSockets.values()].some(socket=>socket.friendId===peerId))void window.pairLan.connect(beacon.host,beacon.port).catch(()=>{});
  });
  window.pairLan.onPeer(peer=>{
    if(!peer?.id)return;
    lanSockets.set(peer.id,{...peer,friendId:'',authed:false,nonce:clientHex(16)});
    lanSend(peer.id,{t:'hello',fp:lanSelfFp,nonce:lanSockets.get(peer.id).nonce});
  });
  window.pairLan.onFrame((id,value)=>void handleLanFrame(id,value).catch(error=>console.warn('LAN frame',error)));
  window.pairLan.onClose(id=>{
    const socket=lanSockets.get(id);lanSockets.delete(id);
    if(socket?.friendId&&![...lanSockets.values()].some(item=>item.friendId===socket.friendId&&item.id!==id)){const neighbor=lanNeighbors.get(socket.friendId);if(neighbor)rememberLanNeighbor(socket.friendId,{...neighbor,socketId:''})}
  });
}
async function handleLanFrame(id,value){
  const socket=lanSockets.get(id);if(!socket||!value||typeof value.t!=='string')return;
  if(value.t==='hello'){
    const fp=String(value.fp||''),peerId=lanFingerprints.get(fp);if(!peerId){window.pairLan.close(id);return}
    socket.friendId=peerId;socket.remoteNonce=String(value.nonce||'');socket.remoteFp=fp;
    rememberLanNeighbor(peerId,{host:socket.host,port:socket.port,fp,socketId:id,localAddress:socket.localAddress});
    const material=[lanSelfFp,fp,socket.nonce,socket.remoteNonce].sort().join('|');
    lanSend(id,{t:'auth',proof:await lanProof(peerId,material)});
    return;
  }
  if(value.t==='auth'){
    const peerId=socket.friendId;if(!peerId||!socket.remoteNonce)return;
    const material=[lanSelfFp,socket.remoteFp,socket.nonce,socket.remoteNonce].sort().join('|');
    const expected=await lanProof(peerId,material);if(expected!==value.proof){window.pairLan.close(id);return}
    socket.authed=true;rememberLanNeighbor(peerId,{host:socket.host,socketId:id,authed:true});
    if(lanPairing?.peerId===peerId&&lanPairing.waitAuth)lanPairing.waitAuth();
    return;
  }
  if(value.t==='offer'||value.t==='answer'){
    if(!socket.authed)return;await acceptLanSignal(socket,value);
  }
}
async function acceptLanSignal(socket,remote){
  const peerId=socket.friendId;if(!peerId||!validPeerSdp(remote.sdp)||!validDevicePublicKey(remote.pub))return;
  const sdp=rewriteLanSdp(remote.sdp,socket.host);
  directoryTrustedConnection=true;dmPeerId=peerId;dmConnectingPeerId=peerId;
  if(remote.t==='offer'){
    if(pc&&dmPeerId===peerId&&['connected','connecting'].includes(pc.connectionState))return;
    dmIceServers=[];relayVoiceMode=false;
    setupPeer();if(pc)pc._lan=true;const kp=await keyPair();if(!pc)return;pc._kp=kp;
    await pc.setRemoteDescription({type:'offer',sdp});if(!pc)return;if(!await derive(kp,remote.pub))return;
    pc.getTransceivers().filter(t=>t.receiver.track?.kind==='audio').forEach(t=>{try{if(t.direction!=='sendrecv')t.setDirection('sendrecv')}catch{}});
    bindReservedAudioTransceivers();const answer=await pc.createAnswer();if(!pc)return;await pc.setLocalDescription({type:'answer',sdp:patchSdp(answer.sdp)});if(!pc)return;await waitIce();
    lanSend(socket.id,{t:'answer',sdp:rewriteLanSdp(pc.localDescription.sdp,socket.localAddress||''),pub:await exportPub(kp.publicKey)});
    pairHint.textContent='Connected on this Wi-Fi.';
  }else if(remote.t==='answer'&&pc){
    await pc.setRemoteDescription({type:'answer',sdp});if(!pc)return;if(!await derive(pc._kp,remote.pub))return;
    bindReservedAudioTransceivers();pairHint.textContent='Connected on this Wi-Fi.';
  }
}
async function lanEnsureMedia(peerId){
  const neighbor=friendOnLan(peerId);if(!neighbor)throw new Error('They are not on this Wi-Fi');
  if(pc&&dmPeerId===peerId&&['connected','connecting','new'].includes(pc.connectionState))return pc;
  if(dmCallOngoing()&&dmCallPeerId!==peerId)throw new Error('End the current voice call before starting another direct connection');
  let socketId=neighbor.socketId||[...lanSockets.values()].find(item=>item.friendId===peerId)?.id;
  if(!socketId){
    if(!neighbor.host||!neighbor.port)throw new Error('LAN peer has no address yet');
    const connected=await window.pairLan.connect(neighbor.host,neighbor.port);
    socketId=connected.id;
  }
  const until=Date.now()+4000;while(Date.now()<until){const socket=lanSockets.get(socketId);if(socket?.authed)break;await delay(50)}
  const socket=lanSockets.get(socketId);if(!socket?.authed)throw new Error('Could not prove this Wi-Fi friend');
  directoryTrustedConnection=true;dmIceServers=[];relayVoiceMode=false;dmPeerId=peerId;dmConnectingPeerId=peerId;
  setupPeer();if(pc)pc._lan=true;setupChannels();const kp=await keyPair();if(!pc)return;pc._kp=kp;
  const offer=await pc.createOffer();if(!pc)return;await pc.setLocalDescription({type:'offer',sdp:patchSdp(offer.sdp)});if(!pc)return;await waitIce();
  lanSend(socketId,{t:'offer',sdp:rewriteLanSdp(pc.localDescription.sdp,socket.localAddress||neighbor.host),pub:await exportPub(kp.publicKey)});
  if(await waitForDmMediaConnection(peerId,{cancelled:false},12000)){pairHint.textContent='Connected on this Wi-Fi.';return pc}
  throw new Error('This Wi-Fi path did not connect');
}

  function installDirectoryUI(){const originalSubmit=messageForm.onsubmit;messageForm.onsubmit=async event=>{if(!activeServerId)return originalSubmit(event);event.preventDefault();const text=convertEmoticons(messageInput.value.trim()),gif=pendingGif;if(!text&&!gif)return;const sent=await sendServerMessage(text,gif);if(sent){messageInput.value='';setPendingGif(null)}};$('#homeButton').onclick=goHomeWithoutLeavingCall;$('#addFriend').onclick=()=>{settingsPanel.hidden=true;document.body.classList.remove('settings-open');connectCard.open=true;syncPanelBackdrop();pairHint.textContent='Create a friend code, or enter the five digits your friend sent you.';$('#hostRoom').textContent='Create friend code';$('#joinRoom').textContent='Add friend';setTimeout(()=>$('#roomCode').focus(),0)};$('#hostRoom').onclick=()=>{if(!directorySend({type:'create-invite',kind:'friend'}))pairHint.textContent='Knot presence is offline. Reconnect before creating a friend code.'};$('#joinRoom').onclick=()=>{const code=$('#roomCode').value.trim();if(!/^\d{5}$/.test(code))return pairHint.textContent='Enter a five-digit friend code.';directorySend({type:'redeem-invite',code});pairHint.textContent='Adding friend…'};$('#inviteServer').onclick=()=>{if(!activeServerId||activeGroupDmId)return;showServerInvite();if(!directorySend({type:'create-invite',kind:'server',serverId:activeServerId}))$('#serverInviteStatus').textContent='Knot is offline. Reconnect before creating an invite.'};$('#editServerPicture').onclick=()=>{if(canEditServer())$('#serverPictureInput').click()};$('#serverPictureInput').onchange=async()=>{const file=$('#serverPictureInput').files?.[0];$('#serverPictureInput').value='';if(!file||!canEditServer())return;try{const picture=await resizeProfile(file);if(picture.length>512*1024)throw new Error('Choose a server image smaller than about 380 KB');directorySend({type:'update-server',serverId:activeServerId,picture})}catch(error){alert(error?.message||'Could not use that server picture')}};const directCall=callBtn.onclick;callBtn.onclick=async()=>{if(!activeServerId)return directCall();const entity=activeServer(),voice=activeGroupDmId?entity?.channels?.find(channel=>channel.type==='voice'):activeChannel();if(serverVoiceStarting){stopServerVoice();return}if(serverVoiceStream){const same=joinedVoiceServerId===entity?.id&&(activeGroupDmId||joinedVoiceChannelId===voice?.id);stopServerVoice();if(same)return}if(voice?.type==='voice')await joinServerVoice(voice);else callStatus.textContent='Select a voice channel first.'};installGroupDmCallControl();$('#serverStageLeave').onclick=stopServerVoice;$('#serverVoiceMute').onclick=$('#serverStageMute').onclick=toggleServerVoiceMute;const toggleServerShare=()=>serverScreenSharing()?stopServerScreenShare():startServerScreenShare();$('#serverVoiceShare').onclick=$('#serverStageShare').onclick=toggleServerShare;$('#serverStageFullscreen').onclick=async()=>{const stage=$('#serverVoiceStage');if(document.fullscreenElement===stage||stage.classList.contains('fs')){stage.classList.remove('fs');try{await document.exitFullscreen?.()}catch{}}else{stage.classList.add('fs');try{await stage.requestFullscreen?.()}catch{}}};installSidebarLayout();installFriendNavigation();installServerDialog();installServerInviteDialog();installGroupDmDialog();showFriends({expand:false});connectDirectory()}
queueMicrotask(async()=>{installWatchTogether();installLanListeners();installDirectoryUI();installChannelDialog();installVoicePanelResize();installAccountOnboarding();$('#createAccount').onclick=()=>createKnotAccount();$('#signInAccount').onclick=()=>signInKnotAccount();renderAccountSummary();$('#serverVoiceHangup').onclick=stopServerVoice;$('#dmVoiceHangup').onclick=()=>{setParticipant(participantFriend,false);endCall(false)};$('#dmVoiceMute').onclick=toggleMute;$('#dmVoiceShare').onclick=()=>screenBtn.click();const toggleMembers=()=>setMemberPanelCollapsed(!document.body.classList.contains('server-members-collapsed'));$('#memberPanelToggle').onclick=toggleMembers;$('#serverMembersClose').onclick=()=>setMemberPanelCollapsed(true);setMemberPanelCollapsed((await ss('serverMembersCollapsed'))==='on',false)});
queueMicrotask(installCallSafeHomeButton);
async function automaticPair(kind,explicitRoom='',expectedPeerId=''){
  // Tear down any prior session so a second Host/Join click (or host→leave→host)
  // doesn't leak an old pc/signaling whose handlers fire stale signals.
  reconnectCall=reconnectCall||callActive;if(pc||signaling){disconnectRoom({preserveCall:true});syncActiveDmTransport()}
  role=kind;directoryTrustedConnection=!!expectedPeerId;dmPeerId=expectedPeerId||activePeerId;if(expectedPeerId)dmConnectingPeerId=expectedPeerId;const baseAddress=PAIR_SIGNAL_SERVER; const room=String(explicitRoom||$('#roomCode').value).trim().toUpperCase();
  if(!/^[A-Z0-9_-]{24,64}$/.test(room))return pairHint.textContent='This private call session is invalid. Ask your friend to reconnect and try again.';
  const address=roomSignalAddress(baseAddress,room);
  pairHint.textContent='Connecting to signaling server…'; signaling=new WebSocket(address);
  signaling.onopen=()=>{try{signaling.send(JSON.stringify({type:'join',room}))}catch{}pairHint.textContent=kind==='host'?'Invite code '+room+' is ready — send it to your friend.':'Joining with invite code '+room+'…'};
  signaling.onerror=()=>pairHint.textContent='Could not reach Knot signaling. Check your internet connection.';
  signaling.onmessage=async event=>{try{const message=JSON.parse(event.data);
    if(message.type==='full'){pairHint.textContent='That invite code is already in use. Create a new code or check the number.';try{signaling?.close()}catch{}signaling=null;return}
    if(message.type==='peer-ready'&&role==='host'){
      reconnectCall=reconnectCall||callActive;setupPeer();const kp=await keyPair();if(!pc)return;pc._kp=kp;setupChannels();
      const offer=await pc.createOffer();if(!pc)return;await pc.setLocalDescription({type:'offer',sdp:patchSdp(offer.sdp)});if(!pc)return;await waitIce();if(!signaling)return;
      logCallEvent('Diag: offer has m=audio=' + (pc.localDescription.sdp.includes('m=audio')?'yes':'NO'));
      signaling.send(JSON.stringify({type:'signal',payload:{kind:'offer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}}));
      pairHint.textContent='Offer sent. Connecting…';
      // If the friend never answers (wrong role, different room, or an old build
      // without TURN), don't hang silently — tell them what to check.
      setTimeout(()=>{if(pc&&pc.connectionState!=='connected'){pairHint.textContent='No answer after 20s. Check that your friend entered '+room+' and clicked Join.'}},20000)
    }
    if(message.type==='signal'){const remote=message.payload;if(!remote||typeof remote!=='object')return;
      // Both clicked Host: each receives the other's offer but role==='host', so
      // neither branch matches. Surface it instead of hanging.
      if(remote.kind==='offer'&&role==='host'){pairHint.textContent='Both of you clicked Host. One of you must click Leave, then that person clicks Join instead.';return}
      if(remote.kind==='offer'&&role==='join'){
        if(!validPeerSdp(remote.sdp)||!validDevicePublicKey(remote.pub))throw new Error('The peer sent an invalid offer');
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
        bindReservedAudioTransceivers();const matched=audioTransceiver;
        logCallEvent('Diag: before createAnswer transceivers='+pc.getTransceivers().length+' audioTr='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio')?'ok:dir='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio').direction):'null'));
        const a=await pc.createAnswer();if(!pc)return;await pc.setLocalDescription({type:'answer',sdp:patchSdp(a.sdp)});if(!pc)return;await waitIce();if(!signaling)return;
        logCallEvent('Diag: answer has m=audio=' + (pc.localDescription.sdp.includes('m=audio')?'yes':'NO'));
        signaling.send(JSON.stringify({type:'signal',payload:{kind:'answer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}}));
        pairHint.textContent='Answer sent. Connecting…'
      }else if(remote.kind==='answer'&&role==='host'){
        if(!validPeerSdp(remote.sdp)||!validDevicePublicKey(remote.pub))throw new Error('The peer sent an invalid answer');
        logCallEvent('Diag: before setRD(answer) transceivers='+pc.getTransceivers().length+' audioTr='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio')?'ok:dir='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio').direction):'null'));
        await pc.setRemoteDescription({type:'answer',sdp:remote.sdp});if(!pc)return;if(!await derive(pc._kp,remote.pub)){disconnectRoom();pairHint.textContent='Security code was not confirmed.';return}
        logCallEvent('Diag: after setRD(answer)');
        bindReservedAudioTransceivers();const matched=audioTransceiver;
        const cd=matched?matched.currentDirection:'none';
        logCallEvent('Diag: audio currentDir='+cd);
        // If the friend's answer didn't include an audio sender, startCall will
        // add a transceiver and renegotiate instead of relying on the unmatched one.
        pairHint.textContent='Secure connection established.'
      }else if(remote.kind==='reneg-offer')await answerDirectRenegotiation(remote.sdp,sdp=>{if(!signaling)return false;signaling.send(JSON.stringify({type:'signal',payload:{kind:'reneg-answer',sdp}}));return true})
      else if(remote.kind==='reneg-answer')await applyDirectRenegotiationAnswer(remote.sdp)
    }
  }catch(e){console.warn('signaling message error',e);pairHint.textContent='Connection setup failed: '+(e&&e.message||e)}};
}
$('#hostRoom').onclick=()=>{const code=makeInviteCode();$('#roomCode').value=code;ssSet('roomCode',code);automaticPair('host')}; $('#joinRoom').onclick=()=>automaticPair('join');
function disconnectRoom({preserveCall=false}={}){const resumeCall=!!preserveCall&&(reconnectCall||callActive);abortCurrentFileSession('Disconnected');settleDirectRenegotiation();renegotiating++;abortScreenSharePicker();if(pc&&pc._connectTimer){clearTimeout(pc._connectTimer);pc._connectTimer=null}
  // Tear down an active share before closing the peer connection so WASAPI
  // capture and local MediaStream tracks do not keep running after leave.
  screenGen++;
  screenStarting=false;
  if(nativeScreenSession)try{window.pairNativeScreen?.stop(nativeScreenSession.id)}catch{}nativeScreenSession=null;if(nativeScreenChannel)try{nativeScreenChannel.close()}catch{}nativeScreenChannel=null;nativeLocalPlayer?.destroy();nativeLocalPlayer=null;nativeScreenAnnounced=false;if(nativeScreenAudioStream){nativeScreenAudioStream.getTracks().forEach(track=>track.stop());nativeScreenAudioStream=null}
  if(window.pairEnv?.platform==='linux')try{window.pairEnv.stopLinuxShareAudio?.()}catch{}
  screenActive=false;screenAudioDebug='';
  screenStatsGeneration++;if(screenStatsTimer){clearInterval(screenStatsTimer);screenStatsTimer=null}screenStatsLast=null;
  const hadServerPulse=[...serverPeers.values()].some(state=>!state.closing&&state.channel?.readyState==='open');
  stopNetBudgetPulse();peerNetBudgets.delete(directBudgetKey());peerNetBudgets.delete('direct');shareBudgetApplied.delete(directBudgetKey());
  if(hadServerPulse)startNetBudgetPulse();
  cleanupNativeScreenCapture();
  if(screenStream){try{screenStream.getTracks().forEach(t=>t.stop())}catch{}screenStream=null}
  screenSenders=[];
  try{screenPreview.srcObject=null;screenPreview.removeAttribute('src');screenPreview.load()}catch{};screenPreview.hidden=true;
  screenBtn.textContent='Share screen';screenBtn.title='Share screen';screenBtn.disabled=true;
  screenStatus.textContent='Not sharing';
  clearRemoteScreenShare();
  try{if(chat){chat.onmessage=null;chat.close()}}catch{}try{if(files){files.onmessage=null;files.close()}}catch{}closeTcpLane();try{if(pc)pc.close()}catch{}if(pc&&pc._silentAudioCtx)try{pc._silentAudioCtx.close()}catch{}pc=chat=files=null;if(signaling){try{signaling.onopen=null;signaling.onerror=null;signaling.close()}catch{}signaling=null}sharedKey=null;directFileKey=null;setAvatar(friendAvatar,'');setAvatarIdentity(friendAvatar,'');remoteVoiceTrack=null;remoteVoiceTransceiver=null;stopCallTone();if(friendHeartbeatTimer){clearTimeout(friendHeartbeatTimer);friendHeartbeatTimer=null}stopSpeakingMonitor('dm-friend');try{remoteAudio.srcObject=null}catch{};try{if(audioCtx&&audioCtx.audioSink){audioCtx.audioSink.disconnect();delete audioCtx.audioSink}}catch{}
  // Release any pending backpressure waiters so in-flight sends don't hang
  // forever after the bus is closed. They'll re-check fileBus(), find it gone,
  // and the send loop will abort cleanly.
  busDrains.forEach(set=>set.forEach(h=>{try{h()}catch{}}));busDrains.clear();tcpLaneWait.forEach(wait=>{try{wait.reject(new Error('Disconnected'))}catch{}});tcpLaneWait.clear();dmConnectingPeerId='';pendingVoiceStartPeerId='';
  sendAbort.forEach(c=>c.abort=true);sendAbort.clear();acceptWait.forEach(w=>{try{w.reject(new Error('Disconnected'))}catch{}});acceptWait.clear();
  acceptCards.forEach(done=>{try{done(false)}catch{}});acceptCards.clear();cancelledOffers.clear();activeTransfers.forEach(t=>{t.abort=true;wakeIncomingTransfer(t);if(t.saveMode==='pair')window.pairSave?.cancel?.(t.seq).catch?.(()=>{});if(t.writer)t.writer.abort?.().catch?.(()=>{})});activeTransfers.clear();clearPendingFrames();outTransfers.clear();sendQueue=Promise.resolve();receiveQueue=Promise.resolve();connectSoundDone=false;friendLeftNotified=false;role=null;audioTransceiver=null;screenAudioTransceiver=null;dmPeerId='';dmCallPeerId='';localCallSessionId='';remoteCallSessionId='';deriveGen++;setParticipant(participantYou,false);setFriendPresence(false,{animate:false,sound:false});voiceLog.innerHTML='';setStatus('Not connected');reconnectCall=resumeCall;if(activePeerId)syncActiveDmTransport();$('#leaveRoom').hidden=true;$('#hostRoom').hidden=false;$('#joinRoom').hidden=false;pairHint.textContent='Disconnected from room.'}
$('#leaveRoom').onclick=()=>{disconnectRoom();relayVoiceMode=false;dmIceServers=directIceServers();syncActiveDmTransport()};
function clearTransfers(){
  sendAbort.forEach(c=>c.abort=true);sendAbort.clear();
  acceptWait.forEach(w=>{try{w.reject(new Error('Cleared'))}catch{}});acceptWait.clear();
  acceptCards.forEach(done=>{try{done(false)}catch{}});acceptCards.clear();cancelledOffers.clear();
  activeTransfers.forEach(t=>{t.abort=true;wakeIncomingTransfer(t);if(t.saveMode==='pair')try{window.pairSave.cancel(t.seq)}catch{}if(t.writer)try{t.writer.abort()}catch{}});activeTransfers.clear();
  clearPendingFrames();outTransfers.clear();
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
    localStream=await acquireCallMicrophone();
    monitorSpeaking('dm-self',localStream);
    dmCallPeerId=dmPeerId||activePeerId;callActive=true;callStart=Date.now();renderCallButtonState('end','End call','End local mic test');callBtn.disabled=false;muteBtn.hidden=false;micMuted=false;muteBtn.textContent='Mute';applyMicTransmission();setParticipant(participantYou,true);playSound('connect');callStatus.textContent='Testing microphone locally';callStatus.className='call-status live';
    callTimerId=setInterval(()=>{const s=Math.floor((Date.now()-callStart)/1000);callTimerEl.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');if($('#dmVoiceDockTime'))$('#dmVoiceDockTime').textContent=callTimerEl.textContent},1000);
  }catch(e){callStatus.textContent='Mic test unavailable';callStatus.className='call-status'}finally{callStarting=false}
}
async function startCall(){
  // Guard against re-entry: a second click during getUserMedia or replaceTrack
  // would leak a MediaStream and drive concurrent instances through the state
  // machine. The flag is cleared in the finally block below.
  if(callActive||callStarting)return;if(serverVoiceStream||serverVoiceStarting)stopServerVoice();
  const targetPeer=activePeerId||dmPeerId;
  if(!pc||pc.connectionState!=='connected'){
    if(LOCAL_TEST_MODE&&!pc)return startLocalTestCall();
    pendingVoiceStartPeerId=targetPeer;playSound('connecting');
    callBtn.disabled=true;callStatus.textContent='Connecting to start voice…';callStatus.className='call-status ringing';
    // Text does not create a peer. Preserve the click and start the explicit
    // media path only now; this avoids DM-open races and idle WebRTC meshes.
    if(targetPeer&&friendReachable(targetPeer)&&!pc)void ensureDmMediaConnection(targetPeer).catch(error=>{pendingVoiceStartPeerId='';callBtn.disabled=false;callStatus.textContent=error?.message||'Could not connect voice';callStatus.className='call-status'});
    return;
  }
  if(micTestStream)stopMicrophoneTest();
  callStarting=true;
  friendLeftNotified=false;
  const gen=callGen;
  try{
    callStatus.textContent='Requesting mic…';callStatus.className='call-status ringing';
    localStream=await acquireCallMicrophone();
    if(!pc){releaseCallMicrophone();return}
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
    try{const p=sender.getParameters(),bitrate=targetVoiceBitrate(),playback=relayVoiceMode?16000:48000,stereo=0;if(p){if(!p.encodings||!p.encodings.length)p.encodings=[{}];p.encodings[0].maxBitrate=bitrate;p.encodings[0].priority='high';p.encodings[0].networkPriority='high';if(p.codecs)p.codecs.forEach(c=>{if(c.mimeType.toLowerCase()==='audio/opus'){c.maxptime=20;c.ptime=10;if(c.parameters){c.parameters.maxaveragebitrate=bitrate;c.parameters.maxplaybackrate=playback;c.parameters.maxptime=20;c.parameters.minptime=10;c.parameters.useinbandfec=1;c.parameters.usedtx=1;c.parameters.cbr=1;c.parameters.stereo=stereo;c.parameters['sprop-stereo']=stereo;c.parameters.spropmaxcapturerate=playback}}});await sender.setParameters(p)}}catch(e){console.warn('opus params:',e)}
    // endCall may have run while we were awaiting getUserMedia or replaceTrack
    // (e.g. user clicked Stop Voice or the connection dropped). The generation
    // counter callGen is incremented by every endCall call. If it changed, bail.
    if(gen!==callGen||!pc){try{sender.replaceTrack(null)}catch{};releaseCallMicrophone();return}
    // endCall/disconnectRoom may have run during a nested await; if pc is gone bail.
    if(!pc){try{sender.replaceTrack(null)}catch{};releaseCallMicrophone();return}
    dmCallPeerId=dmPeerId||activePeerId;callActive=true;callStart=Date.now();monitorSpeaking('dm-self',localStream);setRemoteCallAudio(true);renderCallButtonState('end','End call','End voice call');callBtn.disabled=false;muteBtn.hidden=false;micMuted=false;muteBtn.textContent='Mute';muteBtn.title='Mute microphone';applyMicTransmission();
    try{remoteAudio.volume=0}catch{};setCallVolume(volumeSlider.value,false);volumeSlider.hidden=false;volumeValue.hidden=false;
    setParticipant(participantYou,true);logCallEvent('You joined the call');stopCallTone();
    if(friendInCall)playSound('friend-join');else startCallTone('calling',5);publishCallState(true);try{send({t:'call-ring'})}catch{}
    callStatus.textContent=friendInCall?'Voice live':'Waiting for your friend';callStatus.className=friendInCall?'call-status live':'call-status ringing';
    callTimerId=setInterval(()=>{const s=Math.floor((Date.now()-callStart)/1000);const m=Math.floor(s/60),sec=s%60;callTimerEl.textContent=m+':'+String(sec).padStart(2,'0');if($('#dmVoiceDockTime'))$('#dmVoiceDockTime').textContent=callTimerEl.textContent},1000);
  }catch(e){try{send({t:'call-end'})}catch{};endCall(true);const m=String(e?.message||e||'');if(/not\s*found/i.test(m))callStatus.textContent='No mic found — check your microphone connection';else if(/permission|denied|not\s*allowed/i.test(m))callStatus.textContent='Mic access blocked — allow microphone in browser/app settings';else callStatus.textContent='Mic error — '+(e?.message||e);callStatus.className='call-status';
  }finally{callStarting=false}
}
// Tear down the call and release the mic. `silent` skips UI churn when called
// from a disconnect.
async function endCall(silent){
  callGen++;abortScreenSharePicker();screenGen++;stopCallTone();
  if(callActive)publishCallState(false);
  stopSpeakingMonitor('dm-self');
  if(!silent){setParticipant(participantYou,false);logCallEvent('You left the call')}
  if(screenActive||screenStarting||screenStream)await stopScreenShare(true);
  if(callTimerId){clearInterval(callTimerId);callTimerId=null}
  callTimerEl.textContent='';
  // Stopping the local track silences our outgoing audio WITHOUT touching the
  // negotiated transceiver, so no renegotiation is triggered (the app doesn't
  // handle mid-call renegotiation). The peer's receiver just gets silence.
  releaseCallMicrophone();
  // Drop our sender's track so a stopped track doesn't linger on the transceiver
  // (which would otherwise keep matching in startCall and complicate reconnects).
  if(pc){try{const voice=audioTransceiver?.sender||audioTransceiver;if(voice?.replaceTrack)await voice.replaceTrack(null)}catch{}}
  // Only clear the remote audio element's source when the room is left
  // (disconnectRoom), NOT on endCall. A temporary ICE drop would otherwise
  // null the srcObject and ontrack never fires again for the same transceiver,
  // permanently killing audio for the session.
  callActive=false;micMuted=false;syncVoiceStage();setRemoteCallAudio(false);
  if(!friendInCall)dmCallPeerId='';
  renderCallButtonState('start','Start call','Start voice call');muteBtn.hidden=true;volumeSlider.hidden=true;volumeValue.hidden=true;callStatus.textContent='Voice off';callStatus.className='call-status';closeWatchTogether();
  if(!silent){callBtn.disabled=!pc&&!LOCAL_TEST_MODE;playSound('hangup');try{send({t:'call-end'})}catch{}}
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
let renegotiating=0,renegotiationTimer=null;
// Glare guard: if we receive the peer's reneg-offer while we have one pending,
// we resolve it by role. The joiner defers (answers the host's offer instead of
// insisting on its own); the host wins. role is deterministic across peers.
let renegPending=false;
function settleDirectRenegotiation(){clearTimeout(renegotiationTimer);renegotiationTimer=null;renegPending=false}
function armDirectRenegotiationTimeout(target,generation){
  clearTimeout(renegotiationTimer);renegotiationTimer=setTimeout(async()=>{if(generation!==renegotiating||target!==pc)return;renegotiating++;settleDirectRenegotiation();if(target.signalingState==='have-local-offer')try{await target.setLocalDescription({type:'rollback'})}catch{}if(target===pc)pairHint.textContent='Screen-share negotiation timed out. Stop and retry the share.'},12000)
}
async function answerDirectRenegotiation(sdp,reply){
  const target=pc,remoteSdp=validPeerSdp(sdp);if(!target||!remoteSdp||target.signalingState==='closed')return false;const polite=role==='join'||role==='answer',interrupted=renegPending,collision=interrupted||target.signalingState!=='stable';
  if(collision&&!polite)return false;
  if(collision){renegotiating++;settleDirectRenegotiation();if(target.signalingState==='have-local-offer')try{await target.setLocalDescription({type:'rollback'})}catch{return false}else if(target.signalingState!=='stable')return false}
  if(target!==pc)return false;await target.setRemoteDescription({type:'offer',sdp:remoteSdp});if(target!==pc)return false;const answer=await target.createAnswer();if(target!==pc)return false;await target.setLocalDescription({type:'answer',sdp:patchSdp(answer.sdp)});await waitIce(target);if(target!==pc)return false;const sent=reply(target.localDescription.sdp)!==false;if(sent&&interrupted)queueMicrotask(()=>{if(target===pc&&target.signalingState==='stable')renegotiate().catch(()=>{})});return sent
}
async function applyDirectRenegotiationAnswer(sdp){const target=pc,remoteSdp=validPeerSdp(sdp);if(!target||!remoteSdp||target.signalingState!=='have-local-offer')return false;await target.setRemoteDescription({type:'answer',sdp:remoteSdp});if(target===pc)settleDirectRenegotiation();return target===pc}
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
  renegPending=true;let sent=false;
  try{
    const offer=await pc.createOffer({iceRestart:false});
    if(!pc||pc!==target||myId!==renegotiating){renegPending=false;return false}
    await target.setLocalDescription({type:'offer',sdp:patchSdp(offer.sdp)});
    if(!pc||pc!==target||myId!==renegotiating){renegPending=false;return false}
    await waitIce(target);
    if(!pc||pc!==target||myId!==renegotiating){renegPending=false;return false}
    if(signaling){signaling.send(JSON.stringify({type:'signal',payload:{kind:'reneg-offer',sdp:target.localDescription.sdp}}));sent=true}
    else if(chat?.readyState==='open')sent=send({t:'reneg-offer',sdp:target.localDescription.sdp});
    if(!sent)return false;armDirectRenegotiationTimeout(target,myId);return true;
  }catch(e){console.warn('renegotiate error',e);return false}
  finally{if(!sent&&myId===renegotiating)settleDirectRenegotiation()}
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

  if(screenCaptureOwner||screenCaptureCleanup)cleanupNativeScreenCapture();const attempt=++screenCaptureAttempt,isCurrent=()=>attempt===screenCaptureAttempt;let ctx,dest,op,unsubClean,unsubError,unsubFormat,addonData=false,formatReady=false,captureClosed=false,captureFailure='',outputTrack=null;const captureOwner={};
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
    // A valid WASAPI format is sufficient to attach the output track. Requiring
    // PCM in the first 2.5 seconds meant a Windows game/video started *after*
    // sharing could never be heard by the viewer: the route was torn down
    // before its first non-silent packet. The bounded AudioWorklet remains the
    // only path for samples once they arrive.
    unsubFormat=window.pairCapture.onFormat?.(fmt=>{if(!isCurrent())return;if(fmt?.available!==false&&fmt?.isolated===true)formatReady=true;else captureFailure='isolated WASAPI process-loopback format unavailable'});
    if(!isCurrent()){dispose(false);try{ctx.close()}catch{};return null}window.pairCapture.start();
    // Attach only after the addon confirms process isolation. PCM by itself is
    // not proof of isolation; an idle isolated route may produce none yet.
    const deadline=Date.now()+2500;
    while(isCurrent()&&!formatReady&&!captureFailure&&Date.now()<deadline)await new Promise(r=>setTimeout(r,40));
    if(!isCurrent()||captureFailure||!formatReady){
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
function bindReservedAudioTransceivers(){
  if(!pc)return;const audios=pc.getTransceivers().filter(value=>value.receiver.track?.kind==='audio');
  const voiceSender=audioTransceiver?.sender||audioTransceiver,screenSender=screenAudioTransceiver?.sender||screenAudioTransceiver;
  const voice=audios.find(value=>value.sender===voiceSender)||audios[0],screen=audios.find(value=>value.sender===screenSender)||audios.find(value=>value!==voice);
  if(voice)audioTransceiver=voice;if(screen)screenAudioTransceiver=screen;
}
function reservedScreenAudioSender(target=pc){
  if(!target)return null;const value=screenAudioTransceiver;if(value?.sender)return value.sender;if(value?.replaceTrack)return value;
  return target.getTransceivers().filter(item=>item.receiver.track?.kind==='audio').find(item=>item!==audioTransceiver&&item.sender)?.sender||null;
}
async function setReservedScreenAudioTrack(track,target=pc){
  const sender=reservedScreenAudioSender(target);if(!sender)throw new Error('reserved screen-audio sender is unavailable');
  await sender.replaceTrack(track||target?._silentScreenAudioTrack||null);
  if(track)try{const parameters=sender.getParameters();if(!parameters.encodings?.length)parameters.encodings=[{}];parameters.encodings[0].maxBitrate=256000;parameters.encodings[0].priority='high';parameters.encodings[0].networkPriority='high';await sender.setParameters(parameters)}catch{}
  return sender;
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
  if(screenCaptureOwner||screenCaptureCleanup)cleanupNativeScreenCapture();const attempt=++screenCaptureAttempt,isCurrent=()=>attempt===screenCaptureAttempt;let ctx,dest,op,unsubData,unsubError,received=false,captureError='',outputTrack=null;const captureOwner={};
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
    unsubError=window.pairEnv.onLinuxShareAudioError?.(message=>{if(!isCurrent())return;captureError=String(message||'capture failed');console.warn('[AUDIO] PipeWire capture error:',captureError);if(outputTrack?.readyState==='live'){try{outputTrack.stop()}catch{};queueMicrotask(()=>cleanupNativeScreenCapture(captureOwner))}});
    // A silent desktop at share start is normal. Keep the AudioWorklet connected
    // and attach its live track as soon as PipeWire has created the isolated
    // route, so an app/game that starts producing audio later reaches the peer
    // instead of being rejected by an arbitrary first-PCM timeout.
    op.connect(dest);outputTrack=dest.stream.getAudioTracks()[0]||null;if(!outputTrack)throw new Error('PipeWire output track could not be created');
    outputTrack._knotCaptureOwner=captureOwner;try{outputTrack.contentHint='music'}catch{}
    const share=await window.pairEnv.startLinuxShareAudio();if(!isCurrent()){dispose(true);try{ctx.close()}catch{};return null}if(!share)throw new Error('PipeWire share route could not be created');
    // Give an immediately failing parec/portal route a moment to report its
    // error, but do not require audio to already be playing.
    const deadline=Date.now()+180;while(isCurrent()&&!captureError&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));if(!isCurrent()){dispose(true);try{ctx.close()}catch{};return null}
    if(captureError)throw new Error(captureError);
    screenOutCtx=ctx;screenOutDest=dest;screenNative=true;screenCaptureOwner=captureOwner;
    screenCaptureCleanup=()=>dispose(true);return outputTrack;
  }catch(e){
    console.warn('[AUDIO] direct PipeWire capture failed:',e?.message||e);
    screenAudioDebug=' · PipeWire capture unavailable';
    dispose(isCurrent());try{ctx?.close()}catch{};return null;
  }
}
function displayCaptureRequest(){const fps=shareFrameRate===30?30:60;return{video:{frameRate:{ideal:fps,max:fps}}}}
async function captureDisplayStream(){
  try{return await navigator.mediaDevices.getDisplayMedia(displayCaptureRequest())}
  catch(error){if(!/invalid capture constraints/i.test(String(error?.message||error)))throw error;return navigator.mediaDevices.getDisplayMedia({video:{}})}
}
async function tuneDisplayTrack(track){
  if(!track?.applyConstraints)return;
  const fps=shareFrameRate===30?30:60,heights={720:720,1080:1080,1440:1440,2160:2160},height=heights[shareResolution],width=height?Math.round(height*16/9):null,surface=String(track.getSettings?.().displaySurface||''),windowShare=surface==='window'||surface==='application'||surface==='browser',constraints={frameRate:{ideal:fps,max:fps}};
  // The selected preset is a contract for monitors. Using ideal/max let Chromium
  // silently start a 4K share at 1080p. Window sources are not 16:9 presets;
  // forcing exact monitor pixels made those shares die before Go Live.
  if(width&&height&&!windowShare){constraints.width={exact:width};constraints.height={exact:height}}
  const maximumFps=Number(track.getCapabilities?.().frameRate?.max);if(Number.isFinite(maximumFps)&&maximumFps>0&&maximumFps<fps-1)throw new Error(`The selected source supports up to ${maximumFps.toFixed(1)} fps; ${fps} fps was selected`);
  try{await track.applyConstraints(constraints)}catch(error){const preset=width&&height&&!windowShare?`${width}×${height} at ${fps} fps`:`source resolution at ${fps} fps`;throw new Error(`The selected source cannot capture ${preset}: ${error?.message||error}`)}
  try{if(navigator.mediaDevices.getSupportedConstraints?.().cursor)await track.applyConstraints({cursor:screenCursor})}catch{}
}
function validateDisplayCaptureSettings({width=0,height=0,frameRate=0,windowShare=false}={}){
  const requestedHeight={720:720,1080:1080,1440:1440,2160:2160}[shareResolution],requestedWidth=requestedHeight?Math.round(requestedHeight*16/9):0,requestedFps=shareFrameRate===30?30:60,configuredFps=Number(frameRate)||0;
  if(!windowShare&&requestedWidth&&(width!==requestedWidth||height!==requestedHeight))throw new Error(`Capture returned ${width}×${height}; ${requestedWidth}×${requestedHeight} was selected`);
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
    const settings=track.getSettings?.()||{},surface=String(settings.displaySurface||''),windowShare=surface==='window'||surface==='application'||surface==='browser',width=video.videoWidth||settings.width||0,height=video.videoHeight||settings.height||0;if(!width||!height)throw new Error('Screen capture returned an empty video target');return validateDisplayCaptureSettings({width,height,frameRate:settings.frameRate,windowShare});
  }finally{clearTimeout(timer);video.pause();video.srcObject=null}
}
function compatibilityScreenCodec(){return window.pairEnv?.platform==='linux'?'VP9':'H264'}
function orderedScreenCodecs(caps,selectedCodec=screenCodec){
  const compatibility=compatibilityScreenCodec(),hardware=hardwareScreenCodec==='AV1'||hardwareScreenCodec==='H264'?hardwareScreenCodec:'',automatic=hardware?[hardware,compatibility,'VP9','VP8','H264','AV1']:compatibility==='VP9'?['VP9','VP8','H264','AV1']:['H264','VP9','VP8','AV1'],requested=selectedCodec==='auto'?automatic:[selectedCodec,...automatic],order=[...new Set(requested.map(name=>name.toUpperCase()))],seen=new Set(),result=[];
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
  const compatibilityCap=screenFallbackBitrateCapMbps>0?screenFallbackBitrateCapMbps:Infinity,formulaBps=Math.round(Math.min(screenBitrateMbps,compatibilityCap,Math.max(2,base))*1000000);
  if(!screenShareHasProbe())return formulaBps;
  const ceilingMbps=effectiveScreenBitrateCeiling(),probeCap=Number.isFinite(ceilingMbps)?Math.round(ceilingMbps*1e6):Infinity,fallbackBps=screenFallbackBitrateCapMbps>0?screenFallbackBitrateCapMbps*1e6:Infinity,raise=!screenBitrateExplicit&&effectiveUploadCapMbps()>20&&screenShareCanRaiseBitrate(),encoderCapBps=encoderShareCapMbps({hardware:raise,width,height,fps})*1e6;
  return Math.max(2e6,Math.round(raise?Math.min(encoderCapBps,fallbackBps,probeCap):Math.min(formulaBps,probeCap)));
}
async function configureScreenVideoSender(sender,track,fps,viewers=1,viewerReceiveMbps=Infinity,budgetKey=''){
  const settings=track?.getSettings?.()||{},requestedFps=fps===30?30:60,senderBps=Math.round(targetScreenBitrate(settings.width,settings.height,requestedFps)/Math.max(1,Number(viewers)||1)),viewerBps=Number(viewerReceiveMbps)>0&&Number.isFinite(Number(viewerReceiveMbps))?Math.round(Number(viewerReceiveMbps)*1e6):Infinity,maxBitrate=Math.max(350000,Math.round(Math.min(senderBps,viewerBps)));
  if(budgetKey)shareBudgetApplied.set(budgetKey,{mbps:maxBitrate/1e6,at:Date.now()});
  const selected=String(screenCodec==='auto'?(screenShareCanRaiseBitrate()?hardwareScreenCodec:compatibilityScreenCodec()):screenCodec).toUpperCase(),temporal=['AV1','VP9','VP8'].includes(selected),tune=(parameters,useTemporal)=>{if(!parameters.encodings?.length)parameters.encodings=[{}];const encoding=parameters.encodings[0];encoding.maxBitrate=maxBitrate;delete encoding.minBitrate;encoding.maxFramerate=requestedFps;encoding.scaleResolutionDownBy=1;if(useTemporal)encoding.scalabilityMode='L1T2';else delete encoding.scalabilityMode;
  // Screen video used to be explicitly deprioritized below the call. At 4K
  // that made WebRTC drop display frames before the encoder or network were
  // actually saturated. Keep the call audio on its own RTP stream but give an
  // interactive share normal high-priority scheduling.
  encoding.priority='high';encoding.networkPriority='high';parameters.degradationPreference=screenContentHint==='detail'?'maintain-resolution':'maintain-framerate';return parameters};
  try{await sender.setParameters(tune(sender.getParameters(),temporal));return true}catch(error){if(temporal)try{await sender.setParameters(tune(sender.getParameters(),false));return true}catch{}console.warn('[VIDEO] sender tuning unavailable:',error?.message||error);return false}
}
function startScreenStats(sender){
  const generation=++screenStatsGeneration;if(screenStatsTimer)clearInterval(screenStatsTimer);screenStatsLast=null;
  let sampleInFlight=false;const sample=async()=>{if(sampleInFlight)return;sampleInFlight=true;try{
    if(generation!==screenStatsGeneration||!screenActive)return;const reports=await sender.getStats();if(generation!==screenStatsGeneration||!screenActive)return;let out,codec,remote,candidatePair,localCandidate,remoteCandidate;
    reports.forEach(report=>{if(report.type==='outbound-rtp'&&(report.kind==='video'||report.mediaType==='video')&&!report.isRemote)out=report;if(report.type==='remote-inbound-rtp'&&(report.kind==='video'||report.mediaType==='video'))remote=report;if(report.type==='candidate-pair'&&report.state==='succeeded'&&(report.nominated||!candidatePair))candidatePair=report});if(!out)return;
    codec=reports.get(out.codecId);if(candidatePair){localCandidate=reports.get(candidatePair.localCandidateId);remoteCandidate=reports.get(candidatePair.remoteCandidateId)}
    const now=performance.now(),previous=screenStatsLast,bytes=Number(out.bytesSent)||0,frames=Number(out.framesEncoded)||0,totalEncode=Number(out.totalEncodeTime)||0,packets=Number(out.packetsSent)||0,totalSendDelay=Number(out.totalPacketSendDelay)||0,discarded=Number(out.framesDiscardedOnSend)||0,qpSum=Number(out.qpSum)||0,nacks=Number(out.nackCount)||0;let mbps='…',encodeMs=0,encodedDelta=0,sendQueueMs=0,discardedFps=0,averageQp=0,nackRate=0;
    if(previous&&now>previous.at){const elapsed=(now-previous.at)/1000,packetDelta=packets-previous.packets;mbps=(((bytes-previous.bytes)*8)/(now-previous.at)/1000).toFixed(1);encodedDelta=frames-previous.frames;encodeMs=encodedDelta>0?(totalEncode-previous.totalEncode)/encodedDelta*1000:0;sendQueueMs=packetDelta>0?Math.max(0,(totalSendDelay-previous.totalSendDelay)/packetDelta*1000):0;discardedFps=Math.max(0,discarded-previous.discarded)/elapsed;averageQp=encodedDelta>0?Math.max(0,qpSum-previous.qpSum)/encodedDelta:0;nackRate=Math.max(0,nacks-previous.nacks)/elapsed}
    screenStatsLast={bytes,frames,totalEncode,packets,totalSendDelay,discarded,qpSum,nacks,at:now};const fps=Math.round(out.framesPerSecond||0),w=out.frameWidth||0,h=out.frameHeight||0,reason=out.qualityLimitationReason||'';
    const route=candidatePair?.currentRoundTripTime??remote?.roundTripTime,available=candidatePair?.availableOutgoingBitrate,network=(localCandidate&&remoteCandidate?' · '+(localCandidate.candidateType||'?')+'→'+(remoteCandidate.candidateType||'?'):'')+(Number.isFinite(route)?' · '+Math.round(route*1000)+'ms':'')+(Number.isFinite(available)?' · '+(available/1e6).toFixed(0)+' Mbps available':'');
    const metricTags={codec:String(codec?.mimeType||'unknown').replace('video/','').toLowerCase(),route:String(localCandidate?.candidateType||'unknown')+'-'+String(remoteCandidate?.candidateType||'unknown')};if(Number.isFinite(route))recordMetric('screen.rtt_ms',route*1000,metricTags);if(Number.isFinite(available))recordMetric('screen.available_mbps',available/1e6,metricTags);if(encodeMs)recordMetric('screen.encode_ms',encodeMs,metricTags);if(fps)recordMetric('screen.sent_fps',fps,metricTags);if(sendQueueMs)recordMetric('screen.send_queue_ms',sendQueueMs,metricTags);if(discardedFps)recordMetric('screen.discarded_fps',discardedFps,metricTags);if(averageQp)recordMetric('screen.qp',averageQp,metricTags);if(nackRate)recordMetric('screen.nack_rate',nackRate,metricTags);
    void maybeAdoptLiveShareBudget({congested:shareStatsCongested({nackRate,remote})});
    const limitation=reason&&reason!=='none'?` · ${reason} limited (${screenContentHint==='detail'?'preserving detail':'preserving cadence'})`:'';const status='Sharing'+(w&&h?' · '+w+'×'+h:'')+(fps?' · '+fps+'fps':'')+(mbps!=='…'?' · '+mbps+' Mbps':'')+(codec?.mimeType?' · '+codec.mimeType.replace('video/',''):'')+(encodeMs?' · '+encodeMs.toFixed(1)+'ms encode':'')+(sendQueueMs>1?' · '+sendQueueMs.toFixed(0)+'ms send queue':'')+(averageQp?' · QP '+averageQp.toFixed(0):'')+network+limitation+(friendWatchingScreen?' · friend watching':'')+screenAudioDebug;screenStatus.textContent=status;screenBtn.title=status;
  }catch{}finally{sampleInFlight=false}};
  sample();screenStatsTimer=setInterval(sample,2000);
}
const NATIVE_SCREEN_PACKET=0x4b4e5331,NATIVE_SCREEN_PART=60*1024,NATIVE_SCREEN_MAX_PARTS=256,NATIVE_SCREEN_BUFFER_HIGH=256*1024,NATIVE_SCREEN_BUFFER_LOW=96*1024,NATIVE_SCREEN_MAX_SEGMENT=8*1024*1024,NATIVE_SCREEN_BUFFER_HARD=NATIVE_SCREEN_MAX_SEGMENT+2*1024*1024,NATIVE_SCREEN_GAP_WAIT=60,NATIVE_SCREEN_PROTOCOL=2,NATIVE_SCREEN_STALE_MS=150,NATIVE_SCREEN_KEY_WAIT_MS=100,NATIVE_SCREEN_LATENCY_TARGET_MS=110,NATIVE_SCREEN_LATENCY_CEILING_MS=180;
function validNativeScreenMeta(value,expectedServerId=''){
  if(!value||value.t!=='native-screen-meta'||expectedServerId&&value.serverId!==expectedServerId)return null;const width=Number(value.width)||0,height=Number(value.height)||0,fps=Number(value.fps)||60,latencyTargetMs=Number(value.latencyTargetMs)||0,transportVersion=Number(value.transportVersion)||0;
  if(value.codec!=='AV1'||!Number.isInteger(width)||width<0||width>16384||!Number.isInteger(height)||height<0||height>16384||!Number.isFinite(fps)||fps<1||fps>120||!Number.isFinite(latencyTargetMs)||latencyTargetMs<0||latencyTargetMs>5000||!Number.isInteger(transportVersion)||transportVersion<0||transportVersion>16)return null;
  return{...value,width,height,fps,latencyTargetMs,transportVersion,encoder:String(value.encoder||'GPU').slice(0,120),audio:value.audio===true}
}
// A 4K60 AV1 key cluster is routinely larger than the old fixed 320 KiB
// watermark. Admission now includes the entire segment and grants legitimate
// keyframe bursts more room, while small delta frames still meet the tighter
// steady-state watermark so a truly slow peer cannot build seconds of latency.
function nativeScreenBufferBudget(segmentBytes=0){return Math.min(NATIVE_SCREEN_BUFFER_HARD,Math.max(NATIVE_SCREEN_BUFFER_HIGH,Math.max(0,Number(segmentBytes)||0)*3+NATIVE_SCREEN_BUFFER_LOW))}
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
  const latencyTargetMs=Math.max(1,Number(options.latencyTargetMs)||NATIVE_SCREEN_LATENCY_TARGET_MS),latencyCeilingMs=NATIVE_SCREEN_LATENCY_CEILING_MS,frameIntervalMs=1000/Math.max(1,fps),maxPresentationFrames=Math.max(4,Math.ceil(fps*latencyTargetMs/1000)),maxDecodeQueue=Math.max(6,Math.floor(fps*latencyCeilingMs/1000));
  let canvas=null,context=null,trackGenerator=null,frameWriter=null,frameWriterBusy=false,presentationQueue=[],presentationTimer=null,presentationClockTimestamp=null,presentationClockAt=0,presentationGeneration=0,presentationMode='canvas',presentationDroppedFrames=0,renderedFrames=0,lastRenderedAt=0,decoder=null,config=null,configured=false,destroyed=false,decoderDisabled=false,failureReported=false,latencyExceeded=false,latencyViolationWindows=0,playbackActive=true,decodedFrames=0,paintedFrames=0,firstPaintAt=0,frameWidth=0,frameHeight=0,softwareFallback=preferSoftware,hardwareUnavailable=false,replay=[],queuedSinceOutput=0,configuredAt=0,lastOutputAt=0,needsKeyframe=true,displayMaxW=0,displayMaxH=0;const arrivalTimes=new Map(),latencySamples=[],renderIntervals=[];
  const measureDisplaySize=()=>{if(!canvas||!video)return;const box=video.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);displayMaxW=Math.max(1,Math.round((box.width||960)*dpr));displayMaxH=Math.max(1,Math.round((box.height||540)*dpr))};
  const closeDecoderSoon=value=>{if(!value)return;queueMicrotask(()=>{try{value.close()}catch{}})};
  const resetPresentation=()=>{clearTimeout(presentationTimer);presentationTimer=null;for(const frame of presentationQueue){arrivalTimes.delete(frame.timestamp);try{frame.close()}catch{}}presentationQueue=[];presentationClockTimestamp=null;presentationClockAt=0};
  const fail=error=>{if(destroyed||failureReported)return;failureReported=true;decoderDisabled=true;resetPresentation();const failed=decoder;decoder=null;closeDecoderSoon(failed);const reason=error instanceof Error?error:new Error(String(error||'Native AV1 low-latency decode failed'));queueMicrotask(()=>{if(!destroyed)onError(reason)})};
  const drawPreviewUnavailable=()=>{if(!canvas||!context)return;canvas.width=960;canvas.height=540;context.fillStyle='#050609';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='#d8dbe4';context.font='600 24px system-ui';context.textAlign='center';context.fillText('Share is live',canvas.width/2,canvas.height/2-8);context.fillStyle='#8e95a5';context.font='16px system-ui';context.fillText('Local AV1 preview paused to protect performance',canvas.width/2,canvas.height/2+25)};
  const recordPresentation=(timestamp,paintedAt)=>{
    paintedFrames++;if(!firstPaintAt)firstPaintAt=paintedAt;const arrivedAt=arrivalTimes.get(timestamp);arrivalTimes.delete(timestamp);if(arrivedAt===undefined)return;
    latencySamples.push(paintedAt-arrivedAt);if(latencySamples.length>360)latencySamples.shift();
    // Catch-up keeps the 110 ms target. A single scheduling/driver spike used
    // to tear down a healthy AV1 share and recapture as H.264. Only leave
    // hardware after eight consecutive windows above the 180 ms ceiling;
    // healthy windows reset the streak immediately.
    if(enforceLatencyTarget&&latencySamples.length>=120&&paintedFrames%15===0){const recent=latencySamples.slice(-60).sort((a,b)=>a-b),p95=recent[Math.ceil(recent.length*.95)-1];if(p95>latencyCeilingMs)latencyViolationWindows++;else latencyViolationWindows=0;if(latencyViolationWindows>=8){latencyViolationWindows=0;latencySamples.length=0;if(!softwareFallback)startSoftwareDecoder(new Error('Hardware AV1 decode remained above the '+latencyCeilingMs+'ms latency ceiling'));else{latencyExceeded=true;fail(new Error('AV1 software decode remained above the '+latencyCeilingMs+'ms latency ceiling'))}}}
  };
  const noteRendered=now=>{renderedFrames++;if(lastRenderedAt){renderIntervals.push(now-lastRenderedAt);if(renderIntervals.length>360)renderIntervals.shift()}lastRenderedAt=now};
  const presentFrame=frame=>{
    if(destroyed||decoderDisabled||!playbackActive){arrivalTimes.delete(frame.timestamp);try{frame.close()}catch{};return}
    const timestamp=frame.timestamp,generation=presentationGeneration;
    if(frameWriter){if(frameWriterBusy){arrivalTimes.delete(timestamp);presentationDroppedFrames++;try{frame.close()}catch{};return}frameWriterBusy=true;Promise.resolve(frameWriter.ready).then(()=>{if(destroyed||generation!==presentationGeneration||!playbackActive)return false;return Promise.resolve(frameWriter.write(frame)).then(()=>true)}).then(written=>{if(written&&!destroyed&&generation===presentationGeneration&&playbackActive)recordPresentation(timestamp,performance.now());else arrivalTimes.delete(timestamp)}).catch(error=>{arrivalTimes.delete(timestamp);if(!destroyed)fail(error)}).finally(()=>{try{frame.close()}catch{}frameWriterBusy=false;schedulePresentation()});return}
    const fullscreen=!!document.fullscreenElement||document.body.classList.contains('screen-fullscreen')||!!video.closest('.fs');
    let drawW=frameWidth,drawH=frameHeight;
    if(!fullscreen&&frameWidth&&frameHeight){if(!displayMaxW||!displayMaxH)measureDisplaySize();if(displayMaxW&&displayMaxH&&(drawW>displayMaxW||drawH>displayMaxH)){const scale=Math.min(displayMaxW/drawW,displayMaxH/drawH,1);drawW=Math.max(1,Math.round(drawW*scale));drawH=Math.max(1,Math.round(drawH*scale))}}
    if(canvas.width!==drawW||canvas.height!==drawH){canvas.width=drawW;canvas.height=drawH}
    try{context.drawImage(frame,0,0,drawW,drawH);const now=performance.now();recordPresentation(timestamp,now);noteRendered(now)}catch(error){fail(error)}finally{try{frame.close()}catch{}}
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
    presentationQueue.push(frame);
    const now=performance.now();
    while(presentationQueue.length>1){const oldest=presentationQueue[0],arrived=arrivalTimes.get(oldest.timestamp);if(arrived===undefined||now-arrived<=latencyCeilingMs)break;const stale=presentationQueue.shift();arrivalTimes.delete(stale.timestamp);try{stale.close()}catch{}presentationDroppedFrames++;presentationClockTimestamp=null}
    if(presentationQueue.length>maxPresentationFrames){clearTimeout(presentationTimer);presentationTimer=null;const stale=presentationQueue.shift();arrivalTimes.delete(stale.timestamp);try{stale.close()}catch{}presentationDroppedFrames++;presentationClockTimestamp=null}schedulePresentation()
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
    if(!frameWriter){canvas=document.createElement('canvas');canvas.className='native-screen-canvas';canvas.setAttribute('aria-hidden','true');context=canvas.getContext('2d',{alpha:false,desynchronized:true});if(!context)return null;video.after(canvas);video.style.opacity='0';presentationMode='canvas';measureDisplaySize();window.addEventListener('resize',measureDisplaySize);document.addEventListener('fullscreenchange',measureDisplaySize)}
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
          for(const frame of parser.webmAv1Frames(bytes,fps)){
            if(frame.type==='key'){replay=[];needsKeyframe=false}
            if(needsKeyframe)continue;
            // Drop late deltas once decode is already at the 180 ms ceiling
            // and wait for the next key. Throwing here recaptured as H.264.
            if(frame.type==='delta'&&(decoder.decodeQueueSize||0)>=maxDecodeQueue){needsKeyframe=true;continue}
            replay.push(frame);if(replay.length>Math.max(120,fps*2))replay.shift();arrivalTimes.set(frame.timestamp,performance.now());queuedSinceOutput++;decoder.decode(new EncodedVideoChunk(frame))
          }
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
    destroy(){if(destroyed)return;destroyed=true;presentationGeneration++;clearInterval(stallTimer);resetPresentation();window.removeEventListener('resize',measureDisplaySize);document.removeEventListener('fullscreenchange',measureDisplaySize);try{decoder?.close()}catch{}try{const aborted=frameWriter?.abort(new Error('AV1 player closed'));aborted?.catch?.(()=>{})}catch{}try{trackGenerator?.stop()}catch{}canvas?.remove();video.style.opacity='';try{video.pause();video.srcObject=null;video.removeAttribute('src');video.load()}catch{}},
    stats(){const steady=latencySamples.slice(-120).sort((a,b)=>a-b),p95=steady.length?steady[Math.min(steady.length-1,Math.ceil(steady.length*.95)-1)]:0,cadence=[...renderIntervals.slice(-120)].sort((a,b)=>a-b),cadenceP95=cadence.length?cadence[Math.min(cadence.length-1,Math.ceil(cadence.length*.95)-1)]:0,mean=renderIntervals.slice(-120).reduce((sum,value)=>sum+value,0)/Math.max(1,Math.min(120,renderIntervals.length)),actualRendered=presentationMode==='track'?renderedFrames:paintedFrames;return{decodedFrames,paintedFrames:actualRendered,submittedFrames:paintedFrames,renderedFrames:actualRendered,renderFps:mean?1000/mean:0,renderCadenceP95Ms:cadenceP95,firstPaintAt,width:frameWidth,height:frameHeight,decodeQueueSize:decoderDisabled?0:decoder?.decodeQueueSize||0,softwareFallback,hardwareUnavailable,latencyExceeded,latencyViolationWindows,steadyStateP95Ms:p95,latencySamples:steady.length,presentationMode,presentationDroppedFrames,presentationQueueFrames:presentationQueue.length+(frameWriterBusy?1:0)}}
  };
}
function createMseNativeScreenPlayer(video,codec,onError=()=>{},options={}){
  const mime=nativeScreenMime(codec);if(!mime||!window.MediaSource?.isTypeSupported?.(mime))throw new Error('Native '+codec+' playback is not supported');
  // MediaSource is the reliable fallback for Linux drivers which reject the
  // low-latency WebCodecs AV1 path. Per-frame WebM clusters let this fallback
  // retain about 110 ms of decode headroom instead of buffering a second
  // hidden multi-frame mux burst. Playback remains exactly 1x (no tearing).
  // Seek back to the 110 ms target only after the 180 ms ceiling; a tighter
  // forced cutoff caused visible drops while measured p95 stayed low.
  const configuredWidth=Number(options.width)||0,configuredHeight=Number(options.height)||0,targetLag=NATIVE_SCREEN_LATENCY_TARGET_MS/1000,startLag=.09,hardCatchupLag=NATIVE_SCREEN_LATENCY_CEILING_MS/1000;
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
  // Use the explicit hardware WebCodecs path for ~110 ms playback. A driver
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
function nativeScreenSegmentInfo(data,fps=60){const bytes=data instanceof Uint8Array?data:new Uint8Array(data),cluster=bytes.byteLength>=4&&bytes[0]===0x1f&&bytes[1]===0x43&&bytes[2]===0xb6&&bytes[3]===0x75;if(!cluster)return{kind:'init',key:false,frameCount:0};try{const meta=window.KnotNativeVideo?.webmAv1FrameMeta?.(bytes,fps);if(meta)return{kind:'cluster',key:!!meta.key,frameCount:meta.frameCount||0}}catch{}return{kind:'cluster',key:false,frameCount:0}}
function nativeScreenReceiveState(player,meta={},onGap=()=>{}){return{fragments:new Map(),complete:new Map(),nextSeq:0,pendingBytes:0,player,fps:Number(meta.fps)||60,haveInit:false,latestInit:null,resetBeforeKey:false,gapSince:0,gapTimer:null,fallbackRequested:false,onGap}}
function requestNativeReceiveFallback(state,error){if(!state||state.fallbackRequested)return;state.fallbackRequested=true;state.onGap?.(error)}
function clearNativeScreenReceiveState(channel){const state=channel?._nativeReceive;if(!state)return;clearTimeout(state.gapTimer);state.gapTimer=null;state.fragments?.clear();state.complete?.clear();state.pendingBytes=0;channel._nativeReceive=null}
function holdNativeScreenPreMeta(channel,data){
  const bytes=data instanceof ArrayBuffer?data.slice(0):ArrayBuffer.isView(data)?data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength):null;if(!bytes)return;
  if(bytes.byteLength>NATIVE_SCREEN_PART+12)return;if(!channel._nativePreMeta)channel._nativePreMeta=[];let total=channel._nativePreMeta.reduce((sum,value)=>sum+value.byteLength,0);while(channel._nativePreMeta.length&&(channel._nativePreMeta.length>=32||total+bytes.byteLength>2*1024*1024)){total-=channel._nativePreMeta.shift().byteLength}if(total+bytes.byteLength<=2*1024*1024)channel._nativePreMeta.push(bytes)
}
function drainNativeScreenPreMeta(channel){for(const packet of channel._nativePreMeta?.splice(0)||[])receiveNativeScreenPacket(channel,packet)}
function ensureNativeRemoteAudio(){if(nativeRemoteAudio)return nativeRemoteAudio;nativeRemoteAudio=document.createElement('audio');nativeRemoteAudio.autoplay=true;nativeRemoteAudio.hidden=true;document.body.append(nativeRemoteAudio);applyMediaElementOutput(nativeRemoteAudio).catch(()=>{});return nativeRemoteAudio}
function cleanupRemoteNativeScreen({keepChannel=false,keepAudio=false}={}){
  nativeRemotePlayer?.destroy();nativeRemotePlayer=null;if(remoteNativeScreenChannel)clearNativeScreenReceiveState(remoteNativeScreenChannel);if(!keepChannel&&remoteNativeScreenChannel){try{remoteNativeScreenChannel.onmessage=null;remoteNativeScreenChannel.close()}catch{}remoteNativeScreenChannel=null}if(nativeRemoteAudio&&!keepAudio){try{nativeRemoteAudio.pause();nativeRemoteAudio.srcObject=null}catch{}}try{remoteScreen.removeAttribute('src');remoteScreen.load()}catch{}
}
function beginRemoteNativeScreen(meta,channel){
  // The audio m-line can be delivered before this metadata data-channel frame.
  // Preserve that already-bound audio element while initializing the AV1 video
  // player; clearing it here was the Linux → Windows silent-share race.
  meta=validNativeScreenMeta(meta);if(!meta)return false;cleanupRemoteNativeScreen({keepChannel:true,keepAudio:true});remoteNativeScreenChannel=channel;remoteScreenExpected=true;remoteNativeScreenExpected=true;remoteScreenSuppressed=false;remoteScreen.hidden=false;remoteScreen.srcObject=null;let fallbackRequested=false;const requestFallback=()=>{if(fallbackRequested)return;fallbackRequested=true;try{if(channel.readyState==='open')channel.send(JSON.stringify({t:'native-screen-fallback'}))}catch{}};
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
  const state=channel._nativeReceive,bytes=data instanceof ArrayBuffer?new Uint8Array(data):ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):null;if(!state||!bytes||bytes.byteLength<12||bytes.byteLength>NATIVE_SCREEN_PART+12)return;const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);if(view.getUint32(0)!==NATIVE_SCREEN_PACKET)return;const seq=view.getUint32(4),part=view.getUint16(8),total=view.getUint16(10);if(!total||total>NATIVE_SCREEN_MAX_PARTS||part>=total||seq<state.nextSeq||seq>state.nextSeq+4096)return;state.pendingBytes=Number(state.pendingBytes)||0;let entry=state.fragments.get(seq);if(!entry){if(state.fragments.size>=64){const oldest=[...state.fragments.keys()].sort((a,b)=>a-b)[0];removeNativeReceiveSequence(state,oldest)}entry={parts:new Array(total),count:0,bytes:0,receivedAt:performance.now()};state.fragments.set(seq,entry)}if(entry.parts.length!==total||entry.parts[part])return;entry.parts[part]=bytes.slice(12);entry.count++;entry.bytes+=bytes.byteLength-12;state.pendingBytes+=bytes.byteLength-12;if(entry.bytes>NATIVE_SCREEN_MAX_SEGMENT||state.pendingBytes>12*1024*1024){state.fragments.clear();state.complete.clear();state.pendingBytes=0;requestNativeReceiveFallback(state,new Error('Native AV1 receive queue exceeded its real-time limit'));return}if(entry.count===total){const joined=new Uint8Array(entry.bytes);let offset=0;for(const value of entry.parts){joined.set(value,offset);offset+=value.byteLength}state.fragments.delete(seq);const info=nativeScreenSegmentInfo(joined,state.fps);state.complete.set(seq,{data:joined,...info,receivedAt:entry.receivedAt});drainNativeScreenReceive(channel)}
}
function wireNativeScreenChannel(channel,{remote=false}={}){
  channel.binaryType='arraybuffer';if(remote){remoteNativeScreenChannel=channel;channel._nativePreMeta=[];channel.onmessage=event=>{if(typeof event.data==='string'){if(event.data.length>64*1024)return;try{const value=JSON.parse(event.data);if(value.t==='native-screen-meta')beginRemoteNativeScreen(value,channel);else if(value.t==='native-screen-audio')remoteNativeScreenExpected=!!value.active;else if(value.t==='native-screen-end')clearRemoteScreenShare()}catch{}return}if(!channel._nativeReceive)holdNativeScreenPreMeta(channel,event.data);else receiveNativeScreenPacket(channel,event.data)};channel.onclose=()=>{channel._nativePreMeta=[];clearNativeScreenReceiveState(channel);if(remoteNativeScreenChannel===channel&&remoteScreenExpected)clearRemoteScreenShare()};return}
  nativeScreenChannel=channel;channel.onmessage=event=>{if(typeof event.data!=='string'||event.data.length>64*1024)return;try{const value=JSON.parse(event.data);if(value.t==='native-screen-ready'){channel._nativePeerProtocol=Math.max(0,Math.min(16,Number(value.transportVersion)||0));if(channel._nativePeerProtocol>=NATIVE_SCREEN_PROTOCOL)settleNativeScreenReady(channel,true)}else if(value.t==='native-screen-fallback')fallbackNativeScreenToWebRtc(channel._nativeSend?.sessionId)}catch{}};channel.onclose=()=>settleNativeScreenReady(channel,false);
}
async function waitNativeScreenChannel(channel){if(channel.readyState==='open')return true;return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);channel.removeEventListener('open',opened);channel.removeEventListener('close',closed);resolve(value)};const opened=()=>finish(true),closed=()=>finish(false),timer=setTimeout(()=>finish(false),5000);channel.addEventListener('open',opened,{once:true});channel.addEventListener('close',closed,{once:true})})}
function initializeNativeScreenSender(channel,meta,sessionId,onFallback=()=>{}){
  settleNativeScreenReady(channel,false);channel._nativePeerProtocol=0;channel._nativeSend={sessionId,seq:0,init:null,fps:Number(meta.fps)||60,dropping:false,droppedSegments:0,droppedFrames:0,sourceFrames:0,sentFrames:0,discontinuities:0,missedKeys:0,congestedSince:0,fallbackRequested:false,onFallback};channel.bufferedAmountLowThreshold=NATIVE_SCREEN_BUFFER_LOW;
  channel._nativeReadySettled=false;channel._nativeReadyPromise=new Promise(resolve=>{channel._nativeReadyResolve=resolve});
  const metaFrame=JSON.stringify({...meta,transportVersion:NATIVE_SCREEN_PROTOCOL});
  channel.send(metaFrame);
  channel._nativeMetaRetry=setInterval(()=>{const state=channel._nativeSend;if(state?.sessionId!==sessionId||channel._nativeReadySettled||channel.readyState!=='open'){clearInterval(channel._nativeMetaRetry);return}try{channel.send(metaFrame)}catch{}},400);
  channel._nativeProtocolTimer=setTimeout(()=>{const state=channel._nativeSend;if(state?.sessionId!==sessionId||channel._nativePeerProtocol>=NATIVE_SCREEN_PROTOCOL)return;settleNativeScreenReady(channel,false);if(channel.readyState!=='open'||state?.fallbackRequested)return;state.fallbackRequested=true;Promise.resolve(onFallback(new Error('The other Knot client does not support recoverable AV1 transport'))).catch(()=>{})},3000);return channel._nativeSend
}
function settleNativeScreenReady(channel,ready){clearTimeout(channel?._nativeProtocolTimer);clearInterval(channel?._nativeMetaRetry);if(!channel||channel._nativeReadySettled)return;channel._nativeReadySettled=true;channel._nativeReadyResolve?.(!!ready);channel._nativeReadyResolve=null}
async function waitNativeScreenReady(channel){if(!channel?._nativeReadyPromise)return channel?.readyState==='open';const ready=await channel._nativeReadyPromise;return !!ready&&channel.readyState==='open'}
async function nativeChannelBackpressure(channel,segmentBytes=0,waitMs=0){const admitted=()=>channel.readyState==='open'&&(Number(channel.bufferedAmount)||0)+Math.max(0,Number(segmentBytes)||0)<=nativeScreenBufferBudget(segmentBytes);if(channel.readyState!=='open')return false;if(admitted())return true;if(!waitMs||typeof channel.addEventListener!=='function')return false;channel.bufferedAmountLowThreshold=NATIVE_SCREEN_BUFFER_LOW;return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);channel.removeEventListener('bufferedamountlow',low);channel.removeEventListener('close',closed);resolve(value)};const low=()=>finish(admitted()),closed=()=>finish(false),timer=setTimeout(()=>finish(admitted()),waitMs);channel.addEventListener('bufferedamountlow',low,{once:true});channel.addEventListener('close',closed,{once:true})})}
async function sendNativeScreenSegment(channel,item){
  const data=item.data instanceof Uint8Array?item.data:new Uint8Array(item.data);if(!data.byteLength||data.byteLength>NATIVE_SCREEN_MAX_SEGMENT||channel.readyState!=='open')return false;const total=Math.max(1,Math.ceil(data.byteLength/NATIVE_SCREEN_PART)),waitMs=Number(item.waitMs)||0;if(total>NATIVE_SCREEN_MAX_PARTS||(!item.admitted&&!await nativeChannelBackpressure(channel,data.byteLength,waitMs)))return false;try{for(let part=0;part<total;part++){const start=part*NATIVE_SCREEN_PART,end=Math.min(data.byteLength,start+NATIVE_SCREEN_PART),packet=new Uint8Array(12+end-start),view=new DataView(packet.buffer);view.setUint32(0,NATIVE_SCREEN_PACKET);view.setUint32(4,item.seq);view.setUint16(8,part);view.setUint16(10,total);packet.set(data.subarray(start,end),12);channel.send(packet.buffer)}return true}catch{return false}
}
function requestNativeScreenFallback(channel,state,error){if(!state||state.fallbackRequested)return false;state.fallbackRequested=true;settleNativeScreenReady(channel,false);Promise.resolve(state.onFallback?.(error)).catch(()=>{});return true}
function markNativeScreenCongested(channel,state,key,frameCount=0){state.dropping=true;state.droppedSegments++;state.droppedFrames+=Math.max(0,Number(frameCount)||0);if(!state.congestedSince)state.congestedSince=performance.now();if(key)state.missedKeys++;const peerProtocol=Number(channel._nativePeerProtocol)||0;if(peerProtocol>0&&peerProtocol<NATIVE_SCREEN_PROTOCOL)requestNativeScreenFallback(channel,state,new Error('AV1 congestion requires a compatible receiver'))}
async function sendNativeScreenLiveItem(channel,item){
  const state=channel._nativeSend;if(!state||channel.readyState!=='open'||!await waitNativeScreenReady(channel)||channel._nativeSend!==state)return false;const data=item.data instanceof Uint8Array?item.data:new Uint8Array(item.data);
  if(item.kind==='init'){state.init=data.slice();if(!await nativeChannelBackpressure(channel,data.byteLength,100)){markNativeScreenCongested(channel,state,false);return true}const seq=state.seq,sent=await sendNativeScreenSegment(channel,{kind:'init',seq,data,admitted:true});state.seq++;if(!sent)markNativeScreenCongested(channel,state,false);return channel.readyState==='open'}
  const parsed=item.key===undefined||item.frameCount===undefined?nativeScreenSegmentInfo(data,state.fps):null,key=item.key===true||!!parsed?.key,frameCount=Math.max(0,Number(item.frameCount??parsed?.frameCount)||0),capturedAt=Number(item.capturedAt)||0;state.sourceFrames+=frameCount;
  if(item.discontinuity){state.dropping=true;state.discontinuities++}
  if((capturedAt&&Date.now()-capturedAt>NATIVE_SCREEN_STALE_MS&&!key)||(state.dropping&&!key)){markNativeScreenCongested(channel,state,false,frameCount);return true}
  if(!await nativeChannelBackpressure(channel,data.byteLength,key?NATIVE_SCREEN_KEY_WAIT_MS:0)){markNativeScreenCongested(channel,state,key,frameCount);return true}
  const recovering=state.dropping;
  // A duplicate init is sent only at an intentional recovery boundary. The
  // receiver treats it as an immediate decoder reset before the following key,
  // avoiding the artificial sequence gap and visible 80 ms pause used before.
  if(recovering&&key&&state.init){const initSeq=state.seq,initSent=await sendNativeScreenSegment(channel,{kind:'init',seq:initSeq,data:state.init,admitted:true});state.seq++;if(!initSent){markNativeScreenCongested(channel,state,true,frameCount);return channel.readyState==='open'}}
  const seq=state.seq,sent=await sendNativeScreenSegment(channel,{kind:'cluster',seq,data,admitted:true});state.seq++;if(!sent){markNativeScreenCongested(channel,state,key,frameCount);return channel.readyState==='open'}
  state.sentFrames+=frameCount;if(key){state.dropping=false;state.missedKeys=0;state.congestedSince=0}return true
}
function nativeScreenChannelOptions(){return{ordered:false,maxRetransmits:1,priority:'medium'}}
function selectedNativeDimensions(){const dimensions={720:[1280,720],1080:[1920,1080],1440:[2560,1440],2160:[3840,2160]};return dimensions[Number(shareResolution)]||[0,0]}
function targetNativeAv1BitrateKbps(width,height,fps,viewers=1){
  const w=Number(width)>0?Number(width):3840,h=Number(height)>0?Number(height):2160,f=Number(fps)===30?30:60,selectedPixels=w*h,pixels=Math.max(1,selectedPixels),cadence=f===30?.62:1,ratio=pixels/(1920*1080),formulaMbps=Math.max(2.75,6.774*Math.pow(ratio,.62)*cadence),viewCount=Math.max(1,Number(viewers)||1),encoderCap=encoderShareCapMbps({native:true,width:w,height:h,fps:f});
  let budgetMbps=screenBitrateMbps;if(screenShareHasProbe()){const ceiling=effectiveScreenBitrateCeiling(),raise=!screenBitrateExplicit&&effectiveUploadCapMbps()>20;budgetMbps=raise?Math.min(ceiling,encoderCap):Math.min(screenBitrateMbps,ceiling,encoderCap)}
  const uploadBudget=Math.max(.35,budgetMbps/viewCount),viewerCap=currentViewerReceiveCapMbps(),pathBudget=Number.isFinite(viewerCap)?Math.min(uploadBudget,Math.max(.35,viewerCap)):uploadBudget,raise=screenShareHasProbe()&&!screenBitrateExplicit&&effectiveUploadCapMbps()>20;
  return Math.round(Math.min(raise?pathBudget:Math.min(pathBudget,formulaMbps))*1000);
}
async function attachNativeShareAudio(gen){
  if(!screenAudioOn||!screenActive||gen!==screenGen)return;const track=await linuxShareAudioTrack();if(!track||!screenActive||gen!==screenGen){try{track?.stop()}catch{}if(track)cleanupNativeScreenCapture(track._knotCaptureOwner);return}const audioStream=new MediaStream([track]);nativeScreenAudioStream=audioStream;try{track.contentHint='music'}catch{};try{try{if(nativeScreenChannel?.readyState==='open')nativeScreenChannel.send(JSON.stringify({t:'native-screen-audio',active:true}))}catch{}await setReservedScreenAudioTrack(track);if(nativeScreenAudioStream!==audioStream||!screenActive||gen!==screenGen)throw new Error('screen share ended while attaching audio');screenAudioDebug=' · sound live';screenStatus.textContent='Sharing · '+(nativeScreenSession?.encoder||'GPU')+' AV1'+screenAudioDebug}catch(error){console.warn('[AUDIO] native share audio failed:',error?.message||error);try{if(nativeScreenChannel?.readyState==='open')nativeScreenChannel.send(JSON.stringify({t:'native-screen-audio',active:false}))}catch{}try{await setReservedScreenAudioTrack(null)}catch{}try{track.stop()}catch{}if(nativeScreenAudioStream===audioStream)nativeScreenAudioStream=null;cleanupNativeScreenCapture(track._knotCaptureOwner);if(screenActive&&gen===screenGen){screenAudioDebug=' · sound unavailable';screenStatus.textContent='Sharing · '+(nativeScreenSession?.encoder||'GPU')+' AV1'+screenAudioDebug}}
}
async function pumpNativeScreen(gen,session,channel){
  let audioStarted=false,preview=nativeLocalPlayer?.mode!=='placeholder';
  while(screenActive&&gen===screenGen&&nativeScreenSession?.id===session.id){
    const queued=[];
    if(typeof window.pairNativeScreen.readMany==='function'){const batch=await window.pairNativeScreen.readMany(session.id);if(Array.isArray(batch?.items))queued.push(...batch.items);else if(batch&&!batch.active){if(batch.error)screenStatus.textContent='Native share stopped: '+batch.error;break}}
    if(!queued.length){const item=await window.pairNativeScreen.read(session.id);if(item?.data)queued.push(item);else if(!item?.active){if(item?.error)screenStatus.textContent='Native share stopped: '+item.error;break}}
    if(!screenActive||gen!==screenGen||nativeScreenSession?.id!==session.id)break;
    if(!queued.length)continue;
    for(const item of queued){
      if(!screenActive||gen!==screenGen||nativeScreenSession?.id!==session.id||!item?.data)break;
      if(!nativeScreenAnnounced){nativeScreenAnnounced=true;try{send({t:'screen-start',native:true,codec:'AV1',encoder:session.encoder})}catch{};logCallEvent('You started '+(session.encoder||'GPU')+' AV1 screen sharing')}
      if(preview)nativeLocalPlayer?.append(item.data);
      if(!await sendNativeScreenLiveItem(channel,item)){queued.length=0;if(screenActive&&gen===screenGen&&nativeScreenSession?.id===session.id)await stopScreenShare();return}
      if(!audioStarted){audioStarted=true;void attachNativeShareAudio(gen)}
    }
  }
  if(screenActive&&gen===screenGen&&nativeScreenSession?.id===session.id)await stopScreenShare();
}
async function startNativeScreenShare(expectedPc=pc,expectedCallGen=callGen){
  const ownsCall=()=>pc===expectedPc&&callGen===expectedCallGen&&viableScreenPeer(expectedPc);if(!ownsCall())return false;
  screenStarting=true;abortInFlightNetworkProbe();const gen=++screenGen;let channel=null,session=null;
  const abandon=()=>{if(session)try{window.pairNativeScreen?.stop(session.id)}catch{}if(nativeScreenSession?.id===session?.id){nativeScreenSession=null;nativeLocalPlayer?.destroy();nativeLocalPlayer=null;screenPreview.hidden=true}if(channel){try{channel.close()}catch{}if(nativeScreenChannel===channel)nativeScreenChannel=null}};
  try{channel=expectedPc.createDataChannel('knot-screen-native',nativeScreenChannelOptions());wireNativeScreenChannel(channel);if(!await waitNativeScreenChannel(channel))throw new Error('Native screen channel did not open');if(gen!==screenGen||!ownsCall()){abandon();return false}await waitForViewerBudgets();if(gen!==screenGen||!ownsCall()){abandon();return false}const [width,height]=selectedNativeDimensions(),fps=shareFrameRate===30?30:60;session=await window.pairNativeScreen.start({codec:'av1',fps,width,height,bitrateKbps:targetNativeAv1BitrateKbps(width,height,fps),cursor:screenCursor});if(!session||session.error)throw new Error(session?.error||'GPU AV1 capture did not start');if(gen!==screenGen||!ownsCall()){abandon();return false}nativeScreenSession=session;nativeScreenAnnounced=false;screenActive=true;screenSenders=[];screenAudioDebug=screenAudioOn?' · starting sound capture':' · sound off';screenPreview.hidden=false;screenPreview.muted=true;nativeLocalPlayer=createNativeScreenPlayer(screenPreview,'AV1',()=>{}, {...session,decode:false});initializeNativeScreenSender(channel,{t:'native-screen-meta',codec:'AV1',fps:session.fps,width:session.width,height:session.height,encoder:session.encoder,latencyTargetMs:session.latencyTargetMs},session.id,()=>fallbackNativeScreenToWebRtc(session.id));screenBtn.textContent='Stop sharing';screenBtn.title='Stop screen sharing';screenStatus.textContent='Choose a display · starting '+(session.encoder||'GPU')+' AV1…';focusedScreen='local';screenExpanded=false;updateScreenLayout();void pumpNativeScreen(gen,session,channel);return true}catch(error){const stale=gen!==screenGen||!ownsCall();if(!stale){console.warn('[VIDEO] native screen start failed:',error?.message||error);screenStatus.textContent='Native AV1 unavailable: '+(error?.message||error)}abandon();return false}finally{if(gen===screenGen)screenStarting=false}}
async function fallbackNativeScreenToWebRtc(expectedSessionId=nativeScreenSession?.id){
  const expectedSession=nativeScreenSession,expectedPc=pc,expectedCallGen=callGen,previous=screenCodec,compatibility=compatibilityScreenCodec(),beforeStopGen=screenGen;
  if(nativeScreenFallbackInFlight||!expectedSession||expectedSession.id!==expectedSessionId||!screenActive||!viableScreenPeer(expectedPc))return;nativeScreenFallbackInFlight=true;screenStatus.textContent='AV1 playback unavailable · switching to bandwidth-capped '+compatibility;
  try{await stopScreenShare();if(screenGen!==beforeStopGen+1||pc!==expectedPc||callGen!==expectedCallGen||!viableScreenPeer(expectedPc))return;screenFallbackBitrateCapMbps=compatibility==='VP9'?6:8;screenCodec=compatibility;await startScreenShare({skipPicker:true,expectedPc,expectedCallGen})}finally{screenCodec=previous;nativeScreenFallbackInFlight=false}
}
function recoverFromGpuProcessLoss(details={}){
  const reason=String(details.reason||'GPU process restarted');
  screenStatus.textContent='GPU video process restarted ('+reason+') · keeping the live share';
}
window.pairEnv?.onGpuProcessGone?.(recoverFromGpuProcessLoss);
async function startScreenShare({skipPicker=false,expectedPc:ownedPc=null,expectedCallGen:ownedCallGen=null}={}){
  if(relayVoiceMode){screenStatus.textContent='Screen sharing is disabled while low-bandwidth voice relay is active.';return}
  if(screenActive||screenStarting||screenSharePickerPending||!pc)return;
  const expectedPc=ownedPc||pc,expectedCallGen=Number.isInteger(ownedCallGen)?ownedCallGen:callGen,requestGen=screenGen,ownsCall=()=>pc===expectedPc&&callGen===expectedCallGen&&viableScreenPeer(expectedPc),ownsRequest=()=>ownsCall()&&screenGen===requestGen;
  if(!ownsCall())return;
  primeScreenAudioContext();
  if(!skipPicker)screenFallbackBitrateCapMbps=0;
  if(!skipPicker){screenSharePickerPending=true;screenBtn.disabled=true;renderDmVoiceUI();try{screenStatus.textContent=window.pairEnv?.useSystemPicker?'Choose stream quality…':'Choose a screen or window…';const choice=await chooseScreenShare();if(!choice){if(ownsRequest())screenStatus.textContent='Screen share canceled';return}if(!ownsRequest())return}catch(error){if(ownsRequest())screenStatus.textContent='Share failed: '+(error?.message||error);return}finally{screenSharePickerPending=false;screenBtn.disabled=!pc;renderDmVoiceUI()}}
  if(!ownsRequest())return;
  if(!skipPicker&&window.pairNativeScreen&&window.pairEnv?.platform==='linux'&&['0x10de','0x1002'].includes(window.pairEnv.primaryGpuVendor)&&(screenCodec==='auto'||screenCodec==='AV1')){const info=await window.pairNativeScreen.info();if(!ownsRequest())return;if(info?.supported){const started=await startNativeScreenShare(expectedPc,expectedCallGen);if(started||!ownsCall())return}}
  if(!ownsCall())return;
  screenStarting=true;abortInFlightNetworkProbe();const gen=++screenGen;let startupStream=null;
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
    const sender=pc.addTrack(track,stream);screenSenders=[sender];applyScreenCodecPreference(pc,sender);await configureScreenVideoSender(sender,track,fps,1,peerReceiveCapMbps(directBudgetKey()),directBudgetKey());
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
        await setReservedScreenAudioTrack(audioTrack);
        if(gen!==screenGen||!screenActive||!pc)throw new Error('screen share ended while attaching audio');
        logCallEvent('Computer sound sharing started');screenAudioDebug=' · sound live';screenStatus.textContent='Sharing'+screenAudioDebug;
      }catch(e){
        console.warn('[AUDIO] addTrack failed:',e);if(gen===screenGen&&screenActive){screenAudioDebug=' · sound failed';screenStatus.textContent='Sharing'+screenAudioDebug}
        try{await setReservedScreenAudioTrack(null)}catch{}
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
    const negotiated=await renegotiate();if(gen!==screenGen)return;if(negotiated)await configureScreenVideoSender(sender,track,fps,1,peerReceiveCapMbps(directBudgetKey()),directBudgetKey());void attachShareAudio();
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
  screenActive=false;friendWatchingScreen=false;screenAudioDebug='';
  screenStatsGeneration++;if(screenStatsTimer){clearInterval(screenStatsTimer);screenStatsTimer=null}screenStatsLast=null;
  shareBudgetApplied.delete(directBudgetKey());
  if(!networkCapacity)void startNetworkCapacityProbe();
  cleanupNativeScreenCapture();
  if(screenStream){screenStream.getTracks().forEach(t=>t.stop());screenStream=null}
  if(pc){
    // Video is renegotiated per share, while the computer-audio m-line is
    // permanent and returns to its reserved silent track between shares.
    try{await setReservedScreenAudioTrack(null)}catch{}
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
screenBtn.onclick=()=>{if(screenActive||screenStarting)stopScreenShare();else if(relayVoiceMode){screenStatus.textContent='Screen sharing is disabled while low-bandwidth voice relay is active.'}else if(!pc&&LOCAL_TEST_MODE){screenStatus.textContent='Connect with a friend to start screen sharing';screenStatus.className='screen-status';}else startScreenShare()};
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
function setRemoteScreenWatching(watching){const next=watching===true;if(remoteScreenWatchAnnounced===next)return;remoteScreenWatchAnnounced=next;try{send({t:'screen-watch',active:next})}catch{}}
function watchDmShare(kind){const available=kind==='local'?!screenPreview.hidden:!remoteScreen.hidden;if(!available)return;if(kind==='remote'){remoteScreenSuppressed=false;setRemoteScreenWatching(true);try{remoteScreen.srcObject?.getTracks?.().forEach(track=>{track.enabled=true});nativeRemoteAudio?.srcObject?.getTracks?.().forEach(track=>{track.enabled=true})}catch{}if(remoteScreen.volume>0){remoteScreen.muted=false;if(nativeRemoteAudio)nativeRemoteAudio.muted=false}}else setRemoteScreenWatching(false);focusedScreen=kind;screenExpanded=true;updateScreenLayout()}
function syncScreenPlayback(){const localAvailable=screenPreview.srcObject||nativeLocalPlayer,localSelected=screenExpanded&&focusedScreen==='local';nativeLocalPlayer?.setActive(localSelected);if(!screenPreview.hidden&&localAvailable&&screenPreview.readyState>=2){if(localSelected)screenPreview.play().catch(()=>{});else screenPreview.pause()}const remoteAvailable=remoteScreen.srcObject||nativeRemotePlayer;if(!remoteScreen.hidden&&remoteAvailable){const selected=screenExpanded&&focusedScreen==='remote'&&!remoteScreenSuppressed;nativeRemotePlayer?.setActive(selected);try{remoteScreen.srcObject?.getTracks?.().forEach(track=>{track.enabled=true});nativeRemoteAudio?.srcObject?.getTracks?.().forEach(track=>{track.enabled=true})}catch{}if(selected){if(remoteScreen.volume>0)remoteScreen.muted=false;remoteScreen.play().catch(()=>{});if(nativeRemoteAudio){nativeRemoteAudio.volume=remoteScreen.volume;nativeRemoteAudio.muted=remoteScreen.volume===0;if(!nativeRemoteAudio.muted)nativeRemoteAudio.play().catch(()=>{})}}else{remoteScreen.pause();remoteScreen.muted=true;if(nativeRemoteAudio){nativeRemoteAudio.pause();nativeRemoteAudio.muted=true}}}}
function updateScreenLayout(){
  const hasLocal=!screenPreview.hidden,hasRemote=!remoteScreen.hidden,fullscreen=document.fullscreenElement===screenStage||screenStage.classList.contains('fs');if(!hasRemote&&focusedScreen==='remote')focusedScreen='local';if(!hasLocal&&focusedScreen==='local')focusedScreen='remote';if(!hasLocal&&!hasRemote)screenExpanded=false;if(focusedScreen==='remote'&&remoteScreenSuppressed)screenExpanded=false;
  document.body.classList.toggle('screen-share-active',hasLocal||hasRemote||!!document.querySelector('#serverVoiceStage.watching-share'));
  voicePanel.classList.toggle('screen-sharing',hasLocal||hasRemote);voicePanel.classList.toggle('screen-expanded',screenExpanded&&(hasLocal||hasRemote));screenStage.classList.toggle('screen-expanded-local',focusedScreen==='local');
  participantYou.classList.toggle('has-share',hasLocal);participantFriend.classList.toggle('has-share',hasRemote);
  localShareBadge.hidden=!hasLocal;remoteShareBadge.hidden=!hasRemote;localScreenTile.hidden=!screenExpanded||!hasLocal||focusedScreen!=='local';remoteScreenTile.hidden=!screenExpanded||!hasRemote||focusedScreen!=='remote'||remoteScreenSuppressed;screenViewBar.hidden=!screenExpanded;screenViewBar.querySelector('[data-screen-volume]').hidden=focusedScreen!=='remote';fsBtn.textContent=fullscreen?'✕':'⛶';fsBtn.title=fullscreen?'Exit fullscreen':'Fullscreen';syncScreenPlayback();syncScreenAudioBadge();renderDmVoiceUI();
}
function returnToSharePreview(){if(focusedScreen==='remote')setRemoteScreenWatching(false);screenExpanded=false;updateScreenLayout()}
function exitShareFullscreen({collapse=false}={}){nativeShareFullscreen=false;screenStage.classList.remove('fs');document.body.classList.remove('screen-fullscreen');try{if(document.fullscreenElement===screenStage)document.exitFullscreen().catch(()=>{})}catch{}if(collapse)screenExpanded=false;updateScreenLayout()}
async function toggleRemoteFs(){const target=focusedScreen==='local'?screenPreview:remoteScreen;if(screenStage.classList.contains('fs')||document.fullscreenElement===screenStage){exitShareFullscreen();return}if(!screenExpanded||target.hidden)return;
  // Fullscreen the stage, not the <video>.  A video-only request is routinely
  // rejected by Electron's compositor and, when accepted, leaves the call
  // container's insets around it.  The stage owns the selected tile and its
  // controls, so it can fill the physical display reliably.
  // Apply the viewport stage synchronously. Electron may resolve or reject the
  // native fullscreen request after a compositor frame; waiting for that event
  // previously left the share at its card size on both Linux and Windows.
  nativeShareFullscreen=true;screenStage.classList.add('fs');document.body.classList.add('screen-fullscreen');
  try{if(!screenStage.requestFullscreen)throw new Error('stage fullscreen unavailable');await screenStage.requestFullscreen()}catch{}updateScreenLayout()}
remoteScreenTile.addEventListener('contextmenu',event=>showShareContextMenu(event,{label:'Friend’s stream',volume:true,stopWatching:stopWatchingRemoteShare}));
screenViewBar.onclick=event=>{if(event.target.closest('[data-screen-return]'))returnToSharePreview();else if(event.target.closest('[data-screen-volume]'))showShareContextMenu(event,{label:'Friend’s stream',volume:true,stopWatching:stopWatchingRemoteShare});else if(event.target.closest('[data-screen-fullscreen]'))toggleRemoteFs()};
const screenLayoutObserver=new MutationObserver(updateScreenLayout);screenLayoutObserver.observe(screenPreview,{attributes:true,attributeFilter:['hidden']});screenLayoutObserver.observe(remoteScreen,{attributes:true,attributeFilter:['hidden']});updateScreenLayout();
document.addEventListener('fullscreenchange',()=>{const is=document.fullscreenElement===screenStage;document.body.classList.toggle('screen-fullscreen',is);if(!is)screenStage.classList.remove('fs');updateScreenLayout()});document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(!shareContextMenu.hidden){hideShareContextMenu();return}if(document.fullscreenElement===screenStage||screenStage.classList.contains('fs'))exitShareFullscreen();else if(screenExpanded)returnToSharePreview()});
