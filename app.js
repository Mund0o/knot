/* Pair: manual-signaling, two-person P2P chat with application-level E2EE. */
const $=s=>document.querySelector(s);const signalOut=$('#signalOut'),signalIn=$('#signalIn'),copySignal=$('#copySignal'),processSignal=$('#processSignal'),pairCodeMeta=$('#pairCodeMeta'),statusText=$('#statusText'),messages=$('#messages'),messageForm=$('#messageForm'),messageInput=$('#messageInput'),fileInput=$('#fileInput'),chooseFiles=$('#chooseFiles'),transfers=$('#transfers'),pairHint=$('#pairHint'),participantYou=$('#participantYou'),participantFriend=$('#participantFriend'),voiceLog=$('#voiceLog'),screenBtn=$('#screenBtn'),screenPreset=$('#screenPreset'),screenStatus=$('#screenStatus'),screenPreview=$('#screenPreview'),remoteScreen=$('#remoteScreen');
const updateBanner=$('#updateBanner'),updateTitle=$('#updateTitle'),updateDetails=$('#updateDetails');let updateHideTimer=null;
function renderUpdateStatus(status){if(!updateBanner||!status)return;clearTimeout(updateHideTimer);const state=String(status.state||'idle');updateBanner.className='update-banner update-'+state;updateTitle.textContent=status.message||'Checking for updates…';updateDetails.textContent=status.version?'Pair '+status.version:'';updateBanner.hidden=state==='idle'||state==='current';if(state==='current')updateHideTimer=setTimeout(()=>{updateBanner.hidden=true},1200)}
if(window.pairUpdates){window.pairUpdates.getStatus().then(renderUpdateStatus).catch(()=>{});window.pairUpdates.onStatus(renderUpdateStatus)}
let pc,chat,files,role,sharedKey,sendQueue=Promise.resolve(),receiveQueue=Promise.resolve(),pairSignalBusy=false,pairReplyAccepted=false;let CHUNK=1024*1024;const MAX=200*1024**3;
let directoryTrustedConnection=false,recordConversationMessage=()=>{},directoryProfilePush=()=>{};
// Voice: a live two-way WebRTC audio call on the SAME peer connection. Media is
// encrypted by WebRTC's built-in DTLS-SRTP, so it reuses the existing E2EE link.
let localStream=null,micMuted=false,callActive=false,callStart=0,callTimerId=null,callStarting=false,callGen=0,reconnectCall=false;
// Screen share: video via getDisplayMedia; system audio only via native
// process-loopback / PipeWire so Pair's own call playback is never re-captured.
let screenNative=false,screenOutCtx=null,screenOutDest=null,screenCaptureCleanup=null;
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
let screenTransceiver=null,screenActive=false,screenStarting=false,screenStream=null,screenGen=0,screenSenders=[],screenStatsTimer=null,screenStatsLast=null,remoteScreenExpected=false,screenAudioDebug='';
const callBtn=$('#callBtn'),muteBtn=$('#muteBtn'),volumeSlider=$('#volumeSlider'),volumeValue=$('#volumeValue'),callStatus=$('#callStatus'),callTimerEl=$('#callTimer'),remoteAudio=$('#remoteAudio'),connectCard=$('#connectCard'),addFriendBtn=$('#addFriend'),panelBackdrop=$('#panelBackdrop'),profileBtn=$('#profileBtn'),profileInput=$('#profileInput'),profileAdjust=$('#profileAdjust'),profileEditor=$('#profileEditor'),profileZoom=$('#profileZoom'),profileX=$('#profileX'),profileY=$('#profileY'),profileDone=$('#profileDone'),friendAvatar=$('#friendAvatar'),voicePanel=$('#voicePanel'),roomTitle=$('#roomTitle'),settingsPanel=$('#settingsPanel'),settingsAvatar=$('#settingsAvatar'),settingsChangePhoto=$('#settingsChangePhoto'),settingsAdjustPhoto=$('#settingsAdjustPhoto'),settingsRemovePhoto=$('#settingsRemovePhoto'),displayNameInput=$('#displayName'),yourNameEl=$('#yourName'),friendNameEl=$('#friendName'),inputDevice=$('#inputDevice'),outputDevice=$('#outputDevice'),voiceProcessing=$('#voiceProcessing'),voiceInputMode=$('#voiceInputMode'),pushToTalkSettings=$('#pushToTalkSettings'),pushToTalkKeyButton=$('#pushToTalkKey'),pushToTalkDelayInput=$('#pushToTalkDelay'),pushToTalkDelayValue=$('#pushToTalkDelayValue'),deviceHint=$('#deviceHint'),testMicrophone=$('#testMicrophone'),reduceMotion=$('#reduceMotion'),soundEffects=$('#soundEffects'),shareProfile=$('#shareProfile'),rememberInvite=$('#rememberInvite'),hardwareAcceleration=$('#hardwareAcceleration'),hardwareHint=$('#hardwareHint');
let profileAvatar='',profileFrame={zoom:100,x:50,y:50},profileIdentity=makeProfileIdentity(),profileName='You',friendName='Friend',inputDeviceId='default',outputDeviceId='default',voiceProcessingEnabled=false,voiceInputModeValue='voice',pushToTalkKey='Space',pushToTalkDelay=0,pushToTalkHeld=false,pushToTalkCapturing=false,pushToTalkReleaseTimer=null,soundEnabled=true,profileSharing=true,rememberInviteCode=true,micTestStream=null,micTestSource=null,micTestGain=null;
// A 5 MiB source GIF expands to roughly 6.7 MiB as a data URL. This remains
// below Pair's negotiated data-channel limit while allowing proper animations.
const MAX_PROFILE_DATA=7*1024*1024;
// The call stage stays above the direct-message timeline, matching a DM call.
// Keeping it in the document flow means messages are never hidden behind it.
// Lightweight synth sound effects via Web Audio (no asset files needed). Each
// call lazily creates/resumes the AudioContext so it works after a user gesture
// and stays quiet until then.
let audioCtx=null;
function sfxCtx(){if(!audioCtx){try{audioCtx=new (window.AudioContext||window.webkitAudioContext)();if(outputDeviceId&&typeof audioCtx.setSinkId==='function')audioCtx.setSinkId(outputDeviceId).catch(()=>{})}catch{return null}}if(audioCtx.state==='suspended'){try{audioCtx.resume()}catch{}}return audioCtx}
// Browsers keep a freshly created AudioContext 'suspended' until a user gesture.
// The connect chime fires from async channel-open callbacks (outside a gesture),
// so pre-warm/resume the context on the first interaction anywhere on the page.
function warmAudio(){const c=sfxCtx();if(c&&c.state==='suspended'){try{c.resume()}catch{}}}
document.addEventListener('pointerdown',warmAudio,{once:true});
document.addEventListener('keydown',warmAudio,{once:true});
function tone(ctx,freq,start,dur,type='sine',gain=0.18){const o=ctx.createOscillator(),g=ctx.createGain();o.type=type;o.frequency.setValueAtTime(freq,ctx.currentTime+start);g.gain.setValueAtTime(0,ctx.currentTime+start);g.gain.linearRampToValueAtTime(gain,ctx.currentTime+start+0.02);g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+start+dur);o.connect(g).connect(ctx.destination);o.start(ctx.currentTime+start);o.stop(ctx.currentTime+start+dur+0.02)}
function setParticipant(el,on){if(el===participantFriend){setFriendPresence(on,{sound:false});return}if(el===participantYou){setSelfPresence(on);return}const dot=el.querySelector('.indicator');if(dot)dot.classList.toggle('on',on)}
function syncVoiceStage(){voicePanel.classList.toggle('call-active',!!(callActive||friendInCall))}
function setFriendPresence(on,{animate=true,sound=true}={}){
  const wasPresent=friendInCall;friendInCall=on;syncVoiceStage();const dot=participantFriend.querySelector('.indicator');if(dot)dot.classList.toggle('on',on);
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
function setRemoteCallAudio(enabled){try{if(!enabled){remoteAudio.muted=true;remoteAudio.pause();const ctx=audioCtx;if(ctx?.audioSink){ctx.audioSink.disconnect();delete ctx.audioSink}return}remoteAudio.muted=false;remoteAudio.volume=0;remoteAudio.play().catch(()=>{});setupPermanentAudioSink()}catch{}}
remoteAudio.addEventListener('play',()=>{if(!callActive)queueMicrotask(()=>setRemoteCallAudio(false))});
// Keep a large amount of data in flight so the SCTP pipe stays saturated.
// The sender only waits when bufferedAmount exceeds this; the low-threshold
// is set below it so we refill before the buffer fully drains.
// Pair has exactly one recipient. A 128 MiB window keeps a fast wired link full
// while remaining below the main-process disk writer's 256 MiB backpressure
// limit. This is deliberately not a many-peer fairness setting.
const SEND_WINDOW=128*1024*1024;
const CRYPTO_AHEAD=4;
async function awaitDrain(){const f=files;if(!f||f.readyState!=='open'||f.bufferedAmount<=f.bufferedAmountLowThreshold)return;for(let i=0;i<500;i++){if(!files||files.readyState!=='open')return;if(files.bufferedAmount<=files.bufferedAmountLowThreshold)return;await new Promise(r=>setTimeout(r,20))}}
// Send a JSON control message over the WebRTC chat channel. If the channel is
// closed mid-send we throw a typed error the caller can treat as "aborted"
// rather than letting an unhandled rejection break the send chain.
async function safeSend(data){const f=files;if(!f||f.readyState!=='open')throw new Error('disconnected');for(let i=0;i<3;i++){try{f.send(data);return}catch(e){const m=String(e?.message||'').toLowerCase();if(m.includes('invalid state')||m.includes('closed')||m.includes('not connected'))throw new Error('disconnected');await awaitDrain()}}throw new Error('send failed after retries')}
// Apply backpressure to the direct WebRTC file channel so its send buffer
// remains bounded even during very large transfers.
const busDrains=new Map();function awaitBusDrain(bus){if(!bus||bus!==fileBus())return Promise.resolve();if(bus.bufferedAmount<=SEND_WINDOW*0.75)return Promise.resolve();let waiters=busDrains.get(bus);if(!waiters){waiters=new Set();busDrains.set(bus,waiters)}return new Promise(r=>{let done=false;  const cleanup=()=>{if(done)return;done=true;clearInterval(timer);clearTimeout(timeout);try{bus.removeEventListener('bufferedamountlow',h)}catch{};waiters.delete(h)};const h=()=>{if(bus.bufferedAmount<=SEND_WINDOW*0.75||bus!==fileBus()){cleanup();r()}};const timer=setInterval(h,50);const timeout=setTimeout(()=>{cleanup();r()},30000);try{bus.addEventListener('bufferedamountlow',h)}catch{};waiters.add(h)})}
async function busSafeSend(data){let retries=0;for(;;){const bus=fileBus();if(!bus)throw new Error('no file channel');
  // Proactively wait if the socket's send buffer is already near the window, so
  // we never overflow it (which would throw and abort the whole transfer).
  if(bus.bufferedAmount>SEND_WINDOW){await awaitBusDrain(bus);continue}
  try{bus.send(data);return}catch(e){const m=String(e?.message||'').toLowerCase();if(m.includes('send queue is full')||m.includes('buffered')||m.includes('invalid state')){retries++;if(retries>100)throw new Error('send failed after excessive retries');await awaitBusDrain(bus);continue}throw e}}}
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
function validPairingSignal(value){if(!value||!['offer','answer'].includes(value.type)||typeof value.sdp!=='string'||!value.sdp||value.sdp.length>MAX_SIGNAL_SIZE||!value.pub||typeof value.pub!=='object'||typeof value.pub.x!=='string'||typeof value.pub.y!=='string')throw new Error('This is not a valid Pair invite or reply');return value}
async function makeSignal(value){const raw=enc.encode(JSON.stringify(validPairingSignal(value)));if(raw.byteLength>MAX_SIGNAL_SIZE)throw new Error('Pairing code is too large');try{if(!window.CompressionStream)throw new Error('Compression unavailable');const packed=await readSignalStream(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')));if(packed.byteLength<raw.byteLength)return SIGNAL_COMPRESSED_PREFIX+base64UrlEncode(packed)}catch{}return SIGNAL_RAW_PREFIX+base64UrlEncode(raw)}
async function cleanSignal(value){const code=String(value||'').trim();if(!code||code.length>MAX_SIGNAL_SIZE)throw new Error('Pairing code is missing or too large');let bytes;if(code.startsWith(SIGNAL_COMPRESSED_PREFIX)){if(!window.DecompressionStream)throw new Error('This compact code needs a newer version of Pair');bytes=await readSignalStream(new Blob([base64UrlDecode(code.slice(SIGNAL_COMPRESSED_PREFIX.length))]).stream().pipeThrough(new DecompressionStream('deflate')))}else if(code.startsWith(SIGNAL_RAW_PREFIX))bytes=base64UrlDecode(code.slice(SIGNAL_RAW_PREFIX.length));else{try{bytes=Uint8Array.from(atob(code),c=>c.charCodeAt(0))}catch{throw new Error('This is not a Pair pairing code')}}if(bytes.byteLength>MAX_SIGNAL_SIZE)throw new Error('Pairing code is too large');try{return validPairingSignal(JSON.parse(dec.decode(bytes)))}catch(e){if(e.message?.includes('valid Pair'))throw e;throw new Error('This is not a valid Pair invite or reply')}}
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
function setupChannels(){chat=pc.createDataChannel('chat');files=pc.createDataChannel('files');wire()}function wire(){if(chat){chat.onopen=()=>{setStatus('Connected directly',true);announceProfile()};chat.onmessage=async e=>{try{if(typeof e.data!=='string'||e.data.length>MAX_MESSAGE_SIZE*3)return;const o=JSON.parse(e.data);if(o.t==='msg'&&isEncryptedMessage(o.v)){const message=readChatPayload(dec.decode(await open(o.v)));addMessage(message.text,false,message.gif)}else if(o.t==='profile'){const p=typeof o.v==='string'?{image:o.v}:o.v;if(validProfileIdentity(p?.identity))setAvatarIdentity(friendAvatar,p.identity);if(typeof p?.image==='string'&&p.image.length<=MAX_PROFILE_DATA){setAvatar(friendAvatar,p.image);setAvatarFrame(friendAvatar,p.frame)}}      else if(o.t==='call-ring'){// Reset the leave-chime flag when the friend rings again, so a second
        // call→leave cycle still plays the leave tone instead of going silent.
        friendLeftNotified=false;setParticipant(participantFriend,true);logCallEvent('Friend joined the call');playSound('ring');setRemoteCallAudio(callActive);}else if(o.t==='call-end'){setParticipant(participantFriend,false);if(!friendLeftNotified){friendLeftNotified=true;playSound('leave')}logCallEvent('Friend left the call');callStatus.textContent='Friend left the call';callStatus.className='call-status';/* Keep this person's microphone and call state alive. The connection is a room, not a one-shot call: only the peer that pressed End Call leaves. */}else if(o.t==='screen-start'){remoteScreenExpected=true;logCallEvent('Friend started screen sharing');remoteScreen.hidden=false;screenStatus.textContent='Friend sharing';}else if(o.t==='screen-end'){remoteScreenExpected=false;logCallEvent('Friend stopped screen sharing');remoteScreen.srcObject=null;remoteScreen.hidden=true;screenStatus.textContent='Not sharing';}else if(o.t==='reneg-offer'&&typeof o.sdp==='string'&&pc){// Same glare rule as the signaling path: only the join/answer side yields.
if(renegPending&&(role==='join'||role==='answer')){renegotiating++;renegPending=false}await pc.setRemoteDescription({type:'offer',sdp:o.sdp});const a=await pc.createAnswer();await pc.setLocalDescription({type:'answer',sdp:patchSdp(a.sdp)});await waitIce();send({t:'reneg-answer',sdp:pc.localDescription.sdp});}else if(o.t==='reneg-answer'&&typeof o.sdp==='string'&&pc){await pc.setRemoteDescription({type:'answer',sdp:o.sdp});}}catch(e){console.warn('direct renegotiation error',e)}}}if(files){files.binaryType='arraybuffer';files.bufferedAmountLowThreshold=Math.max(1*1024*1024,SEND_WINDOW-4*1024*1024);files.onmessage=e=>{receiveQueue=receiveQueue.then(()=>onFileFrame(e)).catch(()=>{})};files.onopen=()=>setStatus('Connected directly',true)}}
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
function setupPeer(){
  // Close previous pc and associated resources if reconnecting (e.g. peer-left → peer-ready).
  // Null pc first so the old pc's onconnectionstatechange handler bails (sees !pc).
  if(pc){
    const oldPc=pc;pc=null;const oldChat=chat;const oldFiles=files;chat=null;files=null;
    if(oldPc._connectTimer){clearTimeout(oldPc._connectTimer);oldPc._connectTimer=null}
    if(oldPc._silentAudioCtx)try{oldPc._silentAudioCtx.close()}catch{}
    if(oldChat){oldChat.onmessage=null;try{oldChat.close()}catch{}}
    if(oldFiles){oldFiles.onmessage=null;try{oldFiles.close()}catch{}}
    try{oldPc.close()}catch{}
  }
  pc=new RTCPeerConnection({iceServers:ICE_SERVERS});pc.onicecandidate=()=>{};  let wasEverConnected=false;
  pc.onconnectionstatechange=()=>{if(!pc)return;if(pc.connectionState==='connected'){screenBtn.disabled=false;screenPreset.disabled=false;if(pc._connectTimer){clearTimeout(pc._connectTimer);pc._connectTimer=connectTimer=null}    if(!wasEverConnected){wasEverConnected=true;if(reconnectCall){reconnectCall=false;if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}callActive=false;startCall()}}else{setStatus('Connected directly',true);friendLeftNotified=false}}if(['failed','disconnected','closed'].includes(pc.connectionState)){screenBtn.disabled=true;screenPreset.disabled=true;if(pc._connectTimer){clearTimeout(pc._connectTimer);pc._connectTimer=connectTimer=null}setParticipant(participantFriend,false);setStatus(pc.connectionState);if(!friendLeftNotified){friendLeftNotified=true;playSound('leave')}};if(pc.connectionState==='connecting'){pairHint.textContent='Negotiating peer connection (ICE '+ (pc.iceConnectionState||'') +')…';armConnectTimeout()}};pc.oniceconnectionstatechange=()=>{if(pc.iceConnectionState==='failed'){pairHint.textContent='Peer connection failed (ICE '+(pc.iceConnectionState||'')+'). NAT/network blocks a direct link and the TURN relay could not be reached. Both must be on v1.0.0+, and your network must allow the TURN relay.'}else if(pc.iceConnectionState==='checking'||pc.iceConnectionState==='connected'){pairHint.textContent='Negotiating peer connection (ICE '+(pc.iceConnectionState||'')+' )…'}};pc.ondatachannel=e=>{if(e.channel.label==='chat')chat=e.channel;else files=e.channel;wire()};
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
    const bindsToScreen=stream===remoteScreen.srcObject
      ||!!(screenStreamId&&e.streams?.some(s=>s?.id===screenStreamId))
      ||stream.getVideoTracks().length>0
      ||remoteScreenExpected
      ||(e.track.kind==='audio'&&!remoteScreen.hidden&&!!remoteScreen.srcObject);
    if(e.track.kind==='audio'&&bindsToScreen){
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
      const play=()=>{if(remoteScreen.volume>0)remoteScreen.muted=false;const p=remoteScreen.play();if(p?.catch)p.catch(()=>{})};play();
      if(!screenGestureGuard){screenGestureGuard=true;document.addEventListener('pointerdown',play,{once:true});document.addEventListener('keydown',play,{once:true})}
      return;
    }
    if(e.track.kind==='audio'){logCallEvent('Audio track received from friend');if(remoteAudio.srcObject){try{remoteAudio.srcObject.getAudioTracks().forEach(t=>t.onended=null)}catch{}}if(remoteAudio.srcObject&&remoteAudio.srcObject!==stream){try{remoteAudio.srcObject.addTrack(e.track)}catch{}}else remoteAudio.srcObject=stream;e.track.onended=()=>{if(!friendLeftNotified){friendLeftNotified=true;playSound('leave')}logCallEvent('Friend left the call');callStatus.textContent='Friend left the call';callStatus.className='call-status'};if(!callActive){setRemoteCallAudio(false);return}setRemoteCallAudio(true);if(!gestureGuard){gestureGuard=true;document.addEventListener('pointerdown',()=>setRemoteCallAudio(callActive),{once:true});document.addEventListener('keydown',()=>setRemoteCallAudio(callActive),{once:true})}}else if(e.track.kind==='video'){remoteScreen.hidden=false;try{remoteScreen.srcObject=stream;remoteScreen.play()}catch{};e.track.onended=()=>{if(remoteScreen.srcObject===stream){remoteScreen.srcObject=null;remoteScreen.hidden=true}}}}catch{}};
}
async function waitIce(){if(pc.iceGatheringState==='complete')return;await new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;pc?.removeEventListener('icegatheringstatechange',f);clearTimeout(timeout);resolve()};const f=()=>{if(pc?.iceGatheringState==='complete')finish()};const timeout=setTimeout(finish,5000);pc.addEventListener('icegatheringstatechange',f)})}
function patchOpusSdp(sdp){return sdp.replace(/a=fmtp:111[^\r\n]*/g,m=>{if(!m.includes('maxaveragebitrate'))m+='; maxaveragebitrate=256000';else m=m.replace(/maxaveragebitrate=\d+/,'maxaveragebitrate=256000');if(!m.includes('maxplaybackrate'))m+='; maxplaybackrate=48000';if(!m.includes('useinbandfec'))m+='; useinbandfec=1';if(!m.includes('usedtx'))m+='; usedtx=0';if(!m.includes('stereo'))m+='; stereo=1';else m=m.replace(/stereo=[01]/,'stereo=1');if(!m.includes('sprop-stereo'))m+='; sprop-stereo=1';else m=m.replace(/sprop-stereo=[01]/,'sprop-stereo=1');return m})}
// Sender parameters are the primary limiter. This SDP fallback keeps browsers
// that ignore those parameters from silently collapsing a high-motion share to
// the old 16 Mbps ceiling.
function patchVideoSdp(sdp){
  const eol=sdp.includes('\r\n')?'\r\n':'\n';
  const cap=Math.round(Math.max(4,Math.min(240,Number(screenBitrateMbps)||160))*1000000);
  return sdp.split(/(?=^m=)/m).map(section=>{
    if(!section.startsWith('m=video '))return section;
    const lines=section.split(/\r?\n/).filter(line=>!/^b=(?:AS|TIAS):/i.test(line)&&!/^a=x-google-(?:min|max)-bitrate:/i.test(line));
    const connection=lines.findIndex(line=>line.startsWith('c='));
    lines.splice(connection>=0?connection+1:1,0,'b=TIAS:'+cap);
    return lines.join(eol);
  }).join('');
}
function patchSdp(sdp){return patchVideoSdp(patchOpusSdp(sdp))}
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
const pendingFrames=new Map();const PENDING_FRAME_LIMIT=32*1024*1024,PENDING_FRAME_TTL=30000,ACTIVE_FRAME_LIMIT=64*1024*1024;let pendingFrameBytes=0;
function dropPending(seq){const held=pendingFrames.get(seq);if(!held)return;for(const p of held)pendingFrameBytes-=p.len;pendingFrames.delete(seq);if(pendingFrameBytes<0)pendingFrameBytes=0}
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
function enableLocalTestControls(){if(!LOCAL_TEST_MODE)return;messageInput.disabled=false;messageForm.querySelector('.send').disabled=false;fileInput.disabled=false;callBtn.disabled=false;screenBtn.disabled=false;screenPreset.disabled=false;statusText.textContent='Local test mode';pairHint.textContent='Test mode is on — messages stay on this device until you pair with a friend.'}
enableLocalTestControls();

async function ss(key){if(window.pairSettings){try{return await window.pairSettings.get(key)}catch{}}try{return localStorage.getItem('pair.'+key)}catch{}}
async function ssSet(key,val){if(window.pairSettings){try{await window.pairSettings.set(key,val);return}catch{}}try{if(val==null)localStorage.removeItem('pair.'+key);else localStorage.setItem('pair.'+key,val)}catch{}}
let screenCursor='always',screenContentHint='motion',screenBitrateMbps=160,screenCodec='auto',shareResolution='source',shareFrameRate=60;
function syncScreenPreset(){const value=`${shareResolution}p${shareFrameRate}`.replace('sourcep','source');if([...screenPreset.options].some(option=>option.value===value))screenPreset.value=value}
function openSettingsTab(name){document.querySelectorAll('.settings-tab').forEach(tab=>{const active=tab.dataset.settingsTab===name;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active))});document.querySelectorAll('.settings-page').forEach(page=>{const active=page.dataset.settingsPage===name;page.classList.toggle('active',active);page.hidden=!active})}
function addScreenShareSettings(){
  const tab=document.createElement('button');tab.type='button';tab.className='settings-tab';tab.dataset.settingsTab='screen';tab.setAttribute('role','tab');tab.setAttribute('aria-selected','false');tab.textContent='Screen sharing';
  const page=document.createElement('section');page.className='settings-section settings-page';page.dataset.settingsPage='screen';page.setAttribute('role','tabpanel');page.hidden=true;
  page.innerHTML='<div><h3>Screen sharing</h3><p>Pair preserves source resolution and frame rate until the network or encoder reaches a real limit.</p></div><label class="settings-field"><span>Resolution</span><select id="screenResolutionSetting"><option value="source">Source — sharpest</option><option value="2160">4K</option><option value="1440">1440p</option><option value="1080">1080p</option><option value="720">720p</option></select></label><label class="settings-field"><span>Frame rate</span><select id="screenFrameRateSetting"><option value="60">60 fps</option><option value="30">30 fps</option></select></label><label class="settings-field"><span>Maximum video bitrate <output id="screenBitrateValue">160 Mbps</output></span><input id="screenBitrateSetting" type="range" min="4" max="240" value="160" step="1" /></label><label class="settings-field"><span>Video codec</span><select id="screenCodecSetting"><option value="auto">Automatic — hardware-friendly</option><option value="H264">H.264</option><option value="H265">H.265 / HEVC</option><option value="VP9">VP9</option><option value="AV1">AV1</option><option value="VP8">VP8</option></select></label><label class="settings-field"><span>Content optimization</span><select id="screenContentHintSetting"><option value="motion">Motion — games and video</option><option value="detail">Detail — text and documents</option></select></label><label class="settings-field"><span>Cursor</span><select id="screenCursorSetting"><option value="always">Always show</option><option value="motion">Show while moving</option><option value="never">Hide cursor</option></select></label><p class="settings-hint">4K/60 uses a 160 Mbps quality ceiling by default. Actual traffic can be lower on static frames without losing quality; congestion control remains active to prevent latency from building during real packet loss.</p><div class="settings-inline-actions"><button id="testScreenAudio" type="button">Test isolated computer audio</button></div><p id="screenAudioTestStatus" class="settings-hint" aria-live="polite">Checks the OS isolation route directly; it does not depend on microphone-device enumeration.</p>';
  document.querySelector('.settings-tabs').append(tab);document.querySelector('.settings-pages').append(page);tab.onclick=()=>openSettingsTab('screen');
  const resolution=$('#screenResolutionSetting'),frameRate=$('#screenFrameRateSetting'),bitrate=$('#screenBitrateSetting'),bitrateValue=$('#screenBitrateValue'),codec=$('#screenCodecSetting'),contentHint=$('#screenContentHintSetting'),cursor=$('#screenCursorSetting'),audioTest=$('#testScreenAudio'),audioTestStatus=$('#screenAudioTestStatus');
  const updateBitrate=()=>{screenBitrateMbps=Math.max(4,Math.min(240,Number(bitrate.value)||160));bitrate.style.setProperty('--range-fill',((screenBitrateMbps-4)/236*100)+'%');bitrateValue.textContent=screenBitrateMbps+' Mbps';ssSet('screenBitrate',String(screenBitrateMbps))};
  resolution.onchange=()=>{shareResolution=['source','720','1080','1440','2160'].includes(resolution.value)?resolution.value:'source';syncScreenPreset();ssSet('shareResolution',shareResolution)};frameRate.onchange=()=>{shareFrameRate=Number(frameRate.value)===30?30:60;syncScreenPreset();ssSet('shareFrameRate',String(shareFrameRate))};bitrate.oninput=updateBitrate;enableRangeDrag(bitrate);codec.onchange=()=>{screenCodec=['auto','H264','H265','VP9','AV1','VP8'].includes(codec.value)?codec.value:'auto';ssSet('screenCodec',screenCodec)};contentHint.onchange=()=>{screenContentHint=contentHint.value==='detail'?'detail':'motion';ssSet('screenContentHint',screenContentHint)};cursor.onchange=()=>{screenCursor=['always','motion','never'].includes(cursor.value)?cursor.value:'always';ssSet('screenCursor',screenCursor)};
  audioTest.onclick=()=>testScreenAudioIsolation(audioTest,audioTestStatus);
  return async()=>{const b=Number(await ss('screenBitrate'));screenBitrateMbps=Number.isFinite(b)&&b>=4&&b<=240?b:160;bitrate.value=String(screenBitrateMbps);bitrate.style.setProperty('--range-fill',((screenBitrateMbps-4)/236*100)+'%');bitrateValue.textContent=screenBitrateMbps+' Mbps';const v=await ss('screenCodec');screenCodec=['auto','H264','H265','VP9','AV1','VP8'].includes(v)?v:'auto';codec.value=screenCodec;const c=await ss('screenCursor');screenCursor=['always','motion','never'].includes(c)?c:'always';cursor.value=screenCursor;const h=await ss('screenContentHint');screenContentHint=h==='detail'?'detail':'motion';contentHint.value=screenContentHint;const savedResolution=await ss('shareResolution');shareResolution=['source','720','1080','1440','2160'].includes(savedResolution)?savedResolution:'source';resolution.value=shareResolution;const savedFps=Number(await ss('shareFrameRate'));shareFrameRate=savedFps===30?30:60;frameRate.value=String(shareFrameRate);syncScreenPreset()};
}
const restoreScreenShareSettings=addScreenShareSettings();
document.querySelectorAll('.settings-tab').forEach(tab=>tab.onclick=()=>openSettingsTab(tab.dataset.settingsTab));
function makeDeviceOption(value,label){const option=document.createElement('option');option.value=value;option.textContent=label;return option}
async function refreshAudioDevices(){try{const devices=await navigator.mediaDevices.enumerateDevices();const inputs=devices.filter(device=>device.kind==='audioinput'),outputs=devices.filter(device=>device.kind==='audiooutput');inputDevice.replaceChildren(makeDeviceOption('default','System default'));outputDevice.replaceChildren(makeDeviceOption('default','System default'));inputs.forEach((device,index)=>inputDevice.append(makeDeviceOption(device.deviceId,device.label||'Microphone '+(index+1))));outputs.forEach((device,index)=>outputDevice.append(makeDeviceOption(device.deviceId,device.label||'Speaker '+(index+1))));inputDevice.value=[...inputDevice.options].some(option=>option.value===inputDeviceId)?inputDeviceId:'default';outputDevice.value=[...outputDevice.options].some(option=>option.value===outputDeviceId)?outputDeviceId:'default';deviceHint.textContent=(inputs.length||outputs.length)?'Device list updated.':'Connect or allow a microphone to reveal device names.'}catch{deviceHint.textContent='Pair could not read audio devices yet.'}}
function microphoneConstraints({echoCancellation=voiceProcessingEnabled}={}){const audio={sampleRate:{ideal:48000},sampleSize:{ideal:32},channelCount:{ideal:2},latency:{ideal:.01},echoCancellation,noiseSuppression:false,autoGainControl:false,voiceIsolation:false,googEchoCancellation:echoCancellation,googAutoGainControl:false,googNoiseSuppression:false,googHighpassFilter:false,googTypingNoiseDetection:false,googAudioMirroring:false};if(inputDeviceId&&inputDeviceId!=='default')audio.deviceId={exact:inputDeviceId};return {audio,video:false}}
async function applyOutputDevice(){try{if(audioCtx&&typeof audioCtx.setSinkId==='function')await audioCtx.setSinkId(outputDeviceId||'default');else if(typeof remoteAudio.setSinkId==='function')await remoteAudio.setSinkId(outputDeviceId||'default');else{deviceHint.textContent='Speaker selection is not supported on this system.';return}deviceHint.textContent='Speaker selection applied.'}catch{deviceHint.textContent='Could not use that speaker. Try the system default.'}}
function stopMicrophoneTest(){try{micTestSource?.disconnect()}catch{}try{micTestGain?.disconnect()}catch{}if(micTestStream)micTestStream.getTracks().forEach(track=>track.stop());micTestStream=micTestSource=micTestGain=null;testMicrophone.textContent='Test microphone'}
async function toggleMicrophoneTest(){if(micTestStream){stopMicrophoneTest();deviceHint.textContent='Microphone test stopped.';return}if(localStream){deviceHint.textContent='End the call before testing the microphone.';return}try{const ctx=sfxCtx();if(!ctx)throw new Error('Audio output unavailable');await ctx.resume();micTestStream=await navigator.mediaDevices.getUserMedia(microphoneConstraints({echoCancellation:false}));micTestSource=ctx.createMediaStreamSource(micTestStream);micTestGain=ctx.createGain();micTestGain.gain.value=1;micTestSource.connect(micTestGain).connect(ctx.destination);testMicrophone.textContent='Stop microphone test';deviceHint.textContent='Raw microphone monitor live — echo cancellation is tested during paired calls only.';await refreshAudioDevices()}catch{stopMicrophoneTest();deviceHint.textContent='Could not start the microphone test. Check the selected device and permission.'}}
function formatPushToTalkKey(code){return ({Space:'Space',Escape:'Esc',ControlLeft:'Left Ctrl',ControlRight:'Right Ctrl',AltLeft:'Left Alt',AltRight:'Right Alt',ShiftLeft:'Left Shift',ShiftRight:'Right Shift',MetaLeft:'Left Super',MetaRight:'Right Super'})[code]||code.replace(/^Key/,'').replace(/^Digit/,'')}
function updatePushToTalkUI(){const enabled=voiceInputModeValue==='ptt';pushToTalkSettings.hidden=!enabled;voiceInputMode.value=voiceInputModeValue;pushToTalkKeyButton.textContent=pushToTalkCapturing?'Press a key…':formatPushToTalkKey(pushToTalkKey);pushToTalkDelayInput.value=String(pushToTalkDelay);pushToTalkDelayValue.textContent=pushToTalkDelay+' ms'}
function applyMicTransmission(){if(!localStream)return;const open=!micMuted&&(voiceInputModeValue!=='ptt'||pushToTalkHeld);localStream.getAudioTracks().forEach(track=>track.enabled=open);if(callActive&&voiceInputModeValue==='ptt'&&!micMuted){muteBtn.textContent=pushToTalkHeld?'Talking…':'Hold '+formatPushToTalkKey(pushToTalkKey);muteBtn.title='Push to talk is enabled in Settings'}}
function releasePushToTalk(){pushToTalkReleaseTimer=null;pushToTalkHeld=false;applyMicTransmission()}
voiceInputMode.onchange=()=>{voiceInputModeValue=voiceInputMode.value==='ptt'?'ptt':'voice';ssSet('voiceInputMode',voiceInputModeValue);if(voiceInputModeValue!=='ptt'){pushToTalkHeld=false;if(pushToTalkReleaseTimer){clearTimeout(pushToTalkReleaseTimer);pushToTalkReleaseTimer=null}}updatePushToTalkUI();applyMicTransmission()};pushToTalkKeyButton.onclick=()=>{pushToTalkCapturing=true;updatePushToTalkUI();deviceHint.textContent='Press the key you want to hold for push to talk.'};pushToTalkDelayInput.oninput=()=>{pushToTalkDelay=Math.max(0,Math.min(1000,Number(pushToTalkDelayInput.value)||0));ssSet('pushToTalkDelay',String(pushToTalkDelay));updatePushToTalkUI()};
window.addEventListener('keydown',event=>{if(pushToTalkCapturing){if(event.code==='Escape'){pushToTalkCapturing=false;updatePushToTalkUI();return}event.preventDefault();pushToTalkKey=event.code;pushToTalkCapturing=false;ssSet('pushToTalkKey',pushToTalkKey);updatePushToTalkUI();return}if(voiceInputModeValue!=='ptt'||event.code!==pushToTalkKey||event.repeat)return;if(/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||''))return;event.preventDefault();if(pushToTalkReleaseTimer){clearTimeout(pushToTalkReleaseTimer);pushToTalkReleaseTimer=null}pushToTalkHeld=true;applyMicTransmission()});window.addEventListener('keyup',event=>{if(voiceInputModeValue!=='ptt'||event.code!==pushToTalkKey)return;event.preventDefault();if(pushToTalkReleaseTimer)clearTimeout(pushToTalkReleaseTimer);pushToTalkReleaseTimer=setTimeout(releasePushToTalk,pushToTalkDelay)});window.addEventListener('blur',()=>{if(pushToTalkReleaseTimer){clearTimeout(pushToTalkReleaseTimer);pushToTalkReleaseTimer=null}pushToTalkHeld=false;applyMicTransmission()});
inputDevice.onchange=()=>{inputDeviceId=inputDevice.value;ssSet('inputDevice',inputDeviceId);if(micTestStream)stopMicrophoneTest()};outputDevice.onchange=()=>{outputDeviceId=outputDevice.value;ssSet('outputDevice',outputDeviceId);applyOutputDevice()};voiceProcessing.onchange=()=>{voiceProcessingEnabled=voiceProcessing.checked;ssSet('voiceProcessing',voiceProcessingEnabled?'on':'off');if(micTestStream)stopMicrophoneTest();deviceHint.textContent=voiceProcessingEnabled?'Echo cancellation enabled; noise suppression and auto-gain stay off.':'Raw stereo microphone mode enabled for the cleanest raw sound.'};$('#refreshDevices').onclick=()=>refreshAudioDevices();$('#testSound').onclick=()=>playSound('ring');testMicrophone.onclick=()=>toggleMicrophoneTest();navigator.mediaDevices?.addEventListener?.('devicechange',refreshAudioDevices);
const THEMES=new Set(['midnight','violet','forest','ember']);
function applyTheme(theme,persist=true){const selected=THEMES.has(theme)?theme:'midnight';document.documentElement.dataset.theme=selected;document.querySelectorAll('.theme-option').forEach(button=>{const active=button.dataset.theme===selected;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active))});if(persist)ssSet('theme',selected)}
function syncPanelBackdrop(){panelBackdrop.hidden=!!settingsPanel.hidden&&!connectCard.open}
function closePanels(){if(micTestStream)stopMicrophoneTest();connectCard.open=false;settingsPanel.hidden=true;document.body.classList.remove('settings-open');syncPanelBackdrop()}
$('#addFriend').onclick=()=>{settingsPanel.hidden=true;document.body.classList.remove('settings-open');connectCard.open=true;syncPanelBackdrop();setTimeout(()=>signalIn.focus(),0)};
connectCard.addEventListener('toggle',syncPanelBackdrop);panelBackdrop.onclick=closePanels;
document.querySelectorAll('.theme-option').forEach(button=>button.onclick=()=>applyTheme(button.dataset.theme));
(async()=>{applyTheme(await ss('theme'),false)})();
reduceMotion.onchange=()=>{document.documentElement.dataset.reduceMotion=String(reduceMotion.checked);ssSet('reduceMotion',reduceMotion.checked?'on':'off')};soundEffects.onchange=()=>{soundEnabled=soundEffects.checked;ssSet('soundEffects',soundEnabled?'on':'off')};shareProfile.onchange=()=>{profileSharing=shareProfile.checked;ssSet('shareProfile',profileSharing?'on':'off');announceProfile();directoryProfilePush()};rememberInvite.onchange=()=>{rememberInviteCode=rememberInvite.checked;ssSet('rememberInvite',rememberInviteCode?'on':'off');if(!rememberInviteCode)ssSet('savedInviteCode',null)};$('#clearSavedInvite').onclick=()=>{signalIn.value='';ssSet('savedInviteCode',null);pairHint.textContent='Saved pairing code cleared from this device.'};hardwareAcceleration.onchange=()=>{const enabled=hardwareAcceleration.checked;ssSet('hardwareAcceleration',enabled?'on':'off');hardwareHint.textContent='Restart Pair to '+(enabled?'enable':'disable')+' hardware acceleration.'};$('#restartPair').onclick=()=>{if(window.pairEnv?.relaunch)window.pairEnv.relaunch();else hardwareHint.textContent='Close and reopen Pair to apply this setting.'};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&(!settingsPanel.hidden||connectCard.open))closePanels()});
function validProfileData(data){return typeof data==='string'&&data.length<=MAX_PROFILE_DATA&&/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(data)}
function setAvatar(el,data){if(!el)return;const safe=validProfileData(data)?data:'';el.classList.toggle('has-image',!!safe);el.style.backgroundImage=safe?'url("'+safe.replace(/"/g,'%22')+'")':'';}
function normalizeFrame(frame){return {zoom:Math.max(40,Math.min(180,Number(frame?.zoom)||100)),x:Math.max(0,Math.min(100,Number(frame?.x??50))),y:Math.max(0,Math.min(100,Number(frame?.y??50)))}}
function validProfileIdentity(value){return typeof value==='string'&&/^[a-z0-9]{12,32}$/i.test(value)}
function normalizeProfileName(value,fallback){if(typeof value!=='string')return fallback;const name=value.replace(/[\u0000-\u001f\u007f]/g,'').replace(/\s+/g,' ').trim().slice(0,32);return name||fallback}
function renderParticipantNames(){yourNameEl.textContent=profileName;friendNameEl.textContent=friendName;if(roomTitle&&!activeServerId)roomTitle.textContent=friendName&&friendName!=='Friend'?friendName:'Private room';displayNameInput.value=profileName;const side=$('#sidebarProfileName');if(side)side.textContent=profileName;const sideLetter=$('#sidebarProfileAvatar .avatar-letter');if(sideLetter)sideLetter.textContent=profileName.slice(0,1).toUpperCase()||'Y'}
function updateProfileName(value,{persist=true,share=true}={}){profileName=normalizeProfileName(value,'You');renderParticipantNames();if(persist)ssSet('profileName',profileName);if(share)announceProfile();directoryProfilePush()}
function handleProfileNameMessage(event){try{if(typeof event.data!=='string')return;const message=JSON.parse(event.data);if(message?.t!=='profile-name')return;friendName=normalizeProfileName(message.v,'Friend');renderParticipantNames()}catch{}}
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
(async()=>{inputDeviceId=(await ss('inputDevice'))||'default';outputDeviceId=(await ss('outputDevice'))||'default';voiceProcessingEnabled=(await ss('voiceProcessing'))==='on';voiceInputModeValue=(await ss('voiceInputMode'))==='ptt'?'ptt':'voice';const savedPttKey=await ss('pushToTalkKey');pushToTalkKey=typeof savedPttKey==='string'&&savedPttKey.length<32?savedPttKey:'Space';const savedPttDelay=Number(await ss('pushToTalkDelay'));pushToTalkDelay=Number.isFinite(savedPttDelay)?Math.max(0,Math.min(1000,savedPttDelay)):0;soundEnabled=(await ss('soundEffects'))!=='off';profileSharing=(await ss('shareProfile'))!=='off';rememberInviteCode=(await ss('rememberInvite'))!=='off';const motion=(await ss('reduceMotion'))==='on';const hardware=(await ss('hardwareAcceleration'))!=='off';if(!rememberInviteCode){signalIn.value='';ssSet('savedInviteCode',null)}voiceProcessing.checked=voiceProcessingEnabled;updatePushToTalkUI();soundEffects.checked=soundEnabled;shareProfile.checked=profileSharing;rememberInvite.checked=rememberInviteCode;reduceMotion.checked=motion;hardwareAcceleration.checked=hardware;document.documentElement.dataset.reduceMotion=String(motion);hardwareHint.textContent='Hardware acceleration is '+(hardware?'enabled':'disabled')+' for the next start.';await restoreScreenShareSettings();await refreshAudioDevices();await applyOutputDevice()})();signalIn.addEventListener('input',()=>{if(!rememberInviteCode)ssSet('savedInviteCode',null)});
(async()=>{const savedRoom=await ss('roomCode');const savedInvite=await ss('savedInviteCode');if(/^\d{5}$/.test(savedRoom||''))$('#roomCode').value=savedRoom;if(typeof savedInvite==='string'&&savedInvite.length<=MAX_SIGNAL_SIZE)signalIn.value=savedInvite;$('#roomCode').addEventListener('input',()=>{const code=$('#roomCode').value.replace(/\D/g,'').slice(0,5);$('#roomCode').value=code;ssSet('roomCode',code)});signalIn.addEventListener('input',()=>ssSet('savedInviteCode',signalIn.value.trim()));const savedVol=await ss('volume');if(savedVol!==null){const v=parseFloat(savedVol);if(v>=0&&v<=1)setCallVolume(Math.round(v*100),false)}const savedFrame=await ss('profileFrame');try{if(savedFrame)profileFrame=normalizeFrame(JSON.parse(savedFrame))}catch{};profileZoom.value=profileFrame.zoom;profileX.value=profileFrame.x;profileY.value=profileFrame.y;const savedAvatar=await ss('profileAvatar');if(validProfileData(savedAvatar)){profileAvatar=savedAvatar;renderProfile();announceProfile()}})();
// Every installation gets a stable generated look until the owner chooses a
// photo. The compact identity is only used to derive the avatar color.
(async()=>{const savedIdentity=await ss('profileIdentity');profileIdentity=validProfileIdentity(savedIdentity)?savedIdentity:makeProfileIdentity();renderProfile();if(profileIdentity!==savedIdentity)ssSet('profileIdentity',profileIdentity)})();
// On a fresh install, use the person's OS account picture when it is available.
// This remains local until they pair, and choosing a photo in Pair still wins.
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
let directorySocket=null,directoryReconnect=null,directoryBackoff=1000,directoryUserId='',directoryToken='',directorySnapshot={friends:[],servers:[],members:{}},activePeerId='',activeServerId='',activeChannelId='',activeConversationKey='',historyRendering=false;
let conversationHistories={},historySaveTimer=null,serverVoiceStream=null;const serverPeers=new Map();
let socialSidebarWidth=280,pendingServerSelection=false;
function clientHex(bytes){const value=crypto.getRandomValues(new Uint8Array(bytes));return [...value].map(byte=>byte.toString(16).padStart(2,'0')).join('')}
function directoryAddress(){const u=new URL(PAIR_SIGNAL_SERVER);u.pathname='/directory';u.search='';return u.href}
function directorySend(value){if(directorySocket?.readyState!==WebSocket.OPEN)return false;try{directorySocket.send(JSON.stringify(value));return true}catch{return false}}
function directoryUser(id){return directorySnapshot.friends.find(friend=>friend.id===id)||directorySnapshot.members?.[id]||null}
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
recordConversationMessage=entry=>{if(historyRendering||!activeConversationKey||!entry||typeof entry.text!=='string')return;const list=conversationHistories[activeConversationKey]||(conversationHistories[activeConversationKey]=[]);list.push(entry);if(list.length>500)list.splice(0,list.length-500);scheduleHistorySave()};
function openConversation(key){activeConversationKey=key;historyRendering=true;messages.replaceChildren();const list=conversationHistories[key]||[];for(const item of list){const current=item.author?.id?directoryUser(item.author.id):null;addMessage(item.text,!!item.mine,item.gif,item.author?{...item.author,...current,time:item.time}:{time:item.time})}historyRendering=false;if(!list.length){const empty=document.createElement('div');empty.className='empty';empty.innerHTML='<span>✦</span><p>Messages stay on your devices and travel directly to online peers.</p>';messages.append(empty)}}
function applyFriendProfile(friend){if(!friend)return;friendName=normalizeProfileName(friend.name,'Friend');setAvatar(friendAvatar,friend.image||'');setAvatarFrame(friendAvatar,friend.frame);setAvatarIdentity(friendAvatar,friend.id);renderParticipantNames();roomTitle.textContent=friendName;$('#chatTitle').textContent=friendName;$('#roomContextLabel').textContent='DIRECT MESSAGE';$('#chatModePill').textContent='DIRECT';messageInput.placeholder='Message '+friendName;}
function setSocialSidebarCollapsed(collapsed,persist=true){document.body.classList.toggle('social-sidebar-collapsed',!!collapsed);const toggle=$('#sidebarToggle');if(toggle){toggle.textContent=collapsed?'›':'‹';toggle.setAttribute('aria-expanded',String(!collapsed));toggle.setAttribute('aria-label',(collapsed?'Open':'Collapse')+' friends and channels panel');toggle.title=(collapsed?'Open':'Collapse')+' panel'}if(persist)ssSet('socialSidebarCollapsed',collapsed?'on':'off')}
function sidebarWidthLimit(){const rail=window.innerWidth<=670?56:window.innerWidth<=900?60:72;return Math.max(190,Math.min(420,window.innerWidth-rail-360))}
function setSocialSidebarWidth(value,persist=true){socialSidebarWidth=Math.max(190,Math.min(sidebarWidthLimit(),Number(value)||280));$('.app-shell')?.style.setProperty('--social-sidebar-width',socialSidebarWidth+'px');if(persist)ssSet('socialSidebarWidth',String(Math.round(socialSidebarWidth)))}
async function installSidebarLayout(){const toggle=$('#sidebarToggle'),handle=$('#sidebarResize');setSocialSidebarWidth(Number(await ss('socialSidebarWidth'))||280,false);setSocialSidebarCollapsed((await ss('socialSidebarCollapsed'))==='on',false);toggle.onclick=()=>setSocialSidebarCollapsed(!document.body.classList.contains('social-sidebar-collapsed'));let startX=0,startWidth=0;handle.addEventListener('pointerdown',event=>{if(document.body.classList.contains('social-sidebar-collapsed'))return;startX=event.clientX;startWidth=socialSidebarWidth;handle.setPointerCapture(event.pointerId);document.body.classList.add('sidebar-resizing')});handle.addEventListener('pointermove',event=>{if(!handle.hasPointerCapture(event.pointerId))return;setSocialSidebarWidth(startWidth+event.clientX-startX,false)});const finish=event=>{if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);if(document.body.classList.contains('sidebar-resizing')){document.body.classList.remove('sidebar-resizing');setSocialSidebarWidth(socialSidebarWidth)}};handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('dblclick',()=>setSocialSidebarWidth(280));handle.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home'].includes(event.key))return;event.preventDefault();setSocialSidebarWidth(event.key==='Home'?280:socialSidebarWidth+(event.key==='ArrowLeft'?-16:16))});window.addEventListener('resize',()=>setSocialSidebarWidth(socialSidebarWidth,false))}
function showFriendsLanding(){roomTitle.textContent='Friends';$('#chatTitle').textContent='Friends';$('#roomContextLabel').textContent='DIRECT MESSAGES';$('#chatModePill').textContent='DIRECT';messageInput.placeholder='Select a direct message';activeConversationKey='';messages.replaceChildren();const empty=document.createElement('div');empty.className='empty';empty.innerHTML='<span>✦</span><p>Choose a friend from Direct Messages, or add someone with the + button.</p>';messages.append(empty);setStatus('Select a direct message')}
function showFriends({expand=true}={}){if(expand)setSocialSidebarCollapsed(false);if(serverVoiceStream){serverVoiceStream.getTracks().forEach(track=>track.stop());serverVoiceStream=null}activeServerId='';activeChannelId='';callBtn.textContent='Start call';callStatus.textContent='Voice off';callStatus.className='call-status';$('#friendsNavigation').hidden=false;$('#serverNavigation').hidden=true;document.querySelectorAll('#serverList .rail-button').forEach(button=>button.classList.remove('active'));$('#homeButton').classList.add('active');closeServerMesh();if(!activePeerId)showFriendsLanding()}
async function selectFriend(id,{connect=true}={}){const friend=directoryUser(id);if(!friend)return;showFriends();activePeerId=id;applyFriendProfile(friend);openConversation('dm:'+id);document.querySelectorAll('.friend-entry').forEach(button=>button.classList.toggle('active',button.dataset.id===id));if(pc&&pc.connectionState==='connected')disconnectRoom();setStatus(friend.online?'Online — connecting directly':'Offline');if(connect&&friend.online){const session=clientHex(16);directorySend({type:'connect',peerId:id,session,context:{type:'dm'}});await automaticPair('host',session,id);applyFriendProfile(friend)}else if(!friend.online){messageInput.disabled=true;messageForm.querySelector('.send').disabled=true;fileInput.disabled=true;pairHint.textContent=friendName+' is offline. Pair will show them online as soon as they open the app.'}}
function paintDirectoryAvatar(avatar,user){setAvatar(avatar,user?.image||'');setAvatarFrame(avatar,user?.frame);setAvatarIdentity(avatar,user?.id||'');if(!validProfileData(user?.image))avatar.textContent=(user?.name||'?').slice(0,1).toUpperCase()}
function renderFriends(){const list=$('#friendList');if(!list)return;const query=($('#friendSearch')?.value||'').trim().toLocaleLowerCase(),friends=(directorySnapshot.friends||[]).filter(friend=>!query||(friend.name||'Pair user').toLocaleLowerCase().includes(query));list.replaceChildren();for(const friend of friends){const button=document.createElement('button');button.type='button';button.className='friend-entry'+(friend.id===activePeerId&&!activeServerId?' active':'');button.dataset.id=friend.id;button.setAttribute('aria-label',(friend.name||'Pair user')+', '+(friend.online?'online':'offline'));const avatar=document.createElement('span');avatar.className='friend-avatar';paintDirectoryAvatar(avatar,friend);const dot=document.createElement('i');dot.classList.toggle('online',!!friend.online);avatar.append(dot);const copy=document.createElement('span');copy.className='friend-copy';const name=document.createElement('strong');name.textContent=friend.name||'Pair user';const status=document.createElement('small');status.textContent=friend.online?'Online':'Offline';copy.append(name,status);button.append(avatar,copy);button.onclick=()=>selectFriend(friend.id);list.append(button)}if(!list.children.length){const empty=document.createElement('p');empty.className='social-empty';empty.textContent=query?'No direct messages match your search.':'Create a five-digit friend code to add someone.';list.append(empty)}}
function serverInitial(server){return cleanClientName(server?.name,'S').slice(0,2).toUpperCase()}
function cleanClientName(value,fallback=''){return String(value||'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,48)||fallback}
function renderServers(){const list=$('#serverList');if(!list)return;list.replaceChildren();for(const server of directorySnapshot.servers||[]){const button=document.createElement('button');button.type='button';button.className='rail-button'+(server.id===activeServerId?' active':'');button.title=server.name;button.setAttribute('aria-label',server.name);button.textContent=serverInitial(server);if(validProfileData(server.picture)){button.style.backgroundImage='url("'+server.picture.replace(/"/g,'%22')+'")';button.textContent=''}button.onclick=()=>selectServer(server.id);list.append(button)}}
function activeServer(){return directorySnapshot.servers?.find(server=>server.id===activeServerId)||null}
function activeChannel(){return activeServer()?.channels?.find(channel=>channel.id===activeChannelId)||null}
function setServerStatus(text,connected=false){statusText.textContent=text;$('.connection').classList.toggle('connected',connected);callBtn.disabled=false;screenBtn.disabled=true;screenPreset.disabled=true}
function renderChannels(){const server=activeServer(),list=$('#channelList');if(!server||!list)return;$('#serverPanelTitle').textContent=server.name;list.replaceChildren();for(const channel of server.channels||[]){const button=document.createElement('button');button.type='button';button.className='channel-entry '+channel.type+(channel.id===activeChannelId?' active':'');button.textContent=channel.name;button.onclick=()=>selectServerChannel(server.id,channel.id);list.append(button)}renderServerMembers()}
function renderServerMembers(){const server=activeServer(),list=$('#serverMemberList');if(!server||!list)return;list.replaceChildren();const members=(server.members||[]).map(id=>directorySnapshot.members?.[id]||(id===directoryUserId?directorySnapshot.self:null)).filter(Boolean).sort((a,b)=>Number(b.online)-Number(a.online)||(a.name||'').localeCompare(b.name||''));for(const member of members){const button=document.createElement('button');button.type='button';button.className='friend-entry';button.disabled=member.id===directoryUserId;const avatar=document.createElement('span');avatar.className='friend-avatar';paintDirectoryAvatar(avatar,member);const dot=document.createElement('i');dot.classList.toggle('online',!!member.online);avatar.append(dot);const name=document.createElement('span');name.textContent=(member.name||'Pair user')+(member.id===directoryUserId?' (you)':'');button.append(avatar,name);if(member.id!==directoryUserId)button.onclick=()=>selectFriend(member.id);list.append(button)}}
function selectServer(id){const server=directorySnapshot.servers?.find(item=>item.id===id);if(!server)return;setSocialSidebarCollapsed(false);if(pc)disconnectRoom();activePeerId='';activeServerId=id;$('#friendsNavigation').hidden=true;$('#serverNavigation').hidden=false;$('#homeButton').classList.remove('active');renderServers();renderChannels();const first=server.channels?.find(channel=>channel.type==='text')||server.channels?.[0];if(first)selectServerChannel(id,first.id)}
async function selectServerChannel(serverId,channelId){const server=directorySnapshot.servers?.find(item=>item.id===serverId),channel=server?.channels?.find(item=>item.id===channelId);if(!server||!channel)return;activeServerId=serverId;activeChannelId=channelId;activePeerId='';roomTitle.textContent=channel.name;$('#chatTitle').textContent=channel.name;$('#roomContextLabel').textContent=server.name.toUpperCase();$('#chatModePill').textContent=channel.type==='voice'?'VOICE':'P2P MESH';messageInput.placeholder='Message #'+channel.name;openConversation('server:'+serverId+':'+channelId);renderChannels();setServerStatus('Connecting to online server members…');if(channel.type==='voice')await joinServerVoice();else{stopServerVoice();syncServerMesh()}messageInput.disabled=false;messageForm.querySelector('.send').disabled=false;fileInput.disabled=true}
function serverOnlineMembers(){const server=activeServer();return (server?.members||[]).filter(id=>id!==directoryUserId&&directorySnapshot.members?.[id]?.online)}
function wireServerChannel(peerId,channel){channel.onopen=()=>setServerStatus('Connected directly to '+serverPeers.size+' server peer'+(serverPeers.size===1?'':'s'),true);channel.onmessage=event=>{try{const value=JSON.parse(event.data);if(value?.t!=='server-msg'||value.serverId!==activeServerId||value.channelId!==activeChannelId||typeof value.text!=='string')return;const author=directoryUser(peerId)||{id:peerId,name:value.name||'Server member',image:value.image||'',frame:value.frame};addMessage(value.text,false,value.gif,author)}catch{}}}
async function ensureServerPeer(peerId){if(serverPeers.has(peerId))return serverPeers.get(peerId);const connection=new RTCPeerConnection({iceServers:ICE_SERVERS}),state={pc:connection,channel:null,candidates:[],audio:null};serverPeers.set(peerId,state);connection.onicecandidate=event=>{if(event.candidate)directorySend({type:'signal',peerId,context:{type:'server',serverId:activeServerId,channelId:activeChannelId},payload:{kind:'candidate',candidate:event.candidate.toJSON()}})};connection.onconnectionstatechange=()=>{if(['failed','closed'].includes(connection.connectionState)){try{state.audio?.remove()}catch{}serverPeers.delete(peerId)}};connection.ondatachannel=event=>{state.channel=event.channel;wireServerChannel(peerId,state.channel)};connection.ontrack=event=>{if(event.track.kind!=='audio')return;const audio=document.createElement('audio');audio.autoplay=true;audio.srcObject=event.streams[0]||new MediaStream([event.track]);audio.hidden=true;document.body.append(audio);state.audio=audio;audio.play().catch(()=>{})};if(serverVoiceStream)for(const track of serverVoiceStream.getTracks())connection.addTrack(track,serverVoiceStream);if(directoryUserId<peerId){state.channel=connection.createDataChannel('pair-server-chat');wireServerChannel(peerId,state.channel);const offer=await connection.createOffer();await connection.setLocalDescription(offer);directorySend({type:'signal',peerId,context:{type:'server',serverId:activeServerId,channelId:activeChannelId},payload:{kind:'offer',sdp:connection.localDescription.sdp}})}return state}
async function handleServerSignal(message){const context=message.context||{},payload=message.payload||{};if(context.serverId!==activeServerId||context.channelId!==activeChannelId)return;const state=await ensureServerPeer(message.from),connection=state.pc;if(payload.kind==='offer'){await connection.setRemoteDescription({type:'offer',sdp:payload.sdp});const answer=await connection.createAnswer();await connection.setLocalDescription(answer);directorySend({type:'signal',peerId:message.from,context,payload:{kind:'answer',sdp:connection.localDescription.sdp}});for(const candidate of state.candidates.splice(0))await connection.addIceCandidate(candidate)}else if(payload.kind==='answer'){await connection.setRemoteDescription({type:'answer',sdp:payload.sdp});for(const candidate of state.candidates.splice(0))await connection.addIceCandidate(candidate)}else if(payload.kind==='candidate'){if(connection.remoteDescription)await connection.addIceCandidate(payload.candidate);else state.candidates.push(payload.candidate)}}
function closeServerMesh(){for(const state of serverPeers.values()){try{state.channel?.close()}catch{}try{state.pc.close()}catch{}try{state.audio?.remove()}catch{}}serverPeers.clear()}
function syncServerMesh(){closeServerMesh();const online=serverOnlineMembers();for(const id of online)ensureServerPeer(id).catch(()=>{});if(!online.length)setServerStatus('No other server members online')}
async function joinServerVoice(){stopServerVoice();try{serverVoiceStream=await navigator.mediaDevices.getUserMedia(microphoneConstraints());serverVoiceStream.getAudioTracks().forEach(track=>track.enabled=true);callStatus.textContent='Joined '+activeChannel().name;callStatus.className='call-status live';callBtn.textContent='Leave voice';syncServerMesh()}catch(error){callStatus.textContent='Could not join voice: '+(error?.message||error);callStatus.className='call-status';syncServerMesh()}}
function stopServerVoice(){if(serverVoiceStream){serverVoiceStream.getTracks().forEach(track=>track.stop());serverVoiceStream=null}closeServerMesh();if(activeServerId){callBtn.textContent='Join voice';callStatus.textContent='Voice off';callStatus.className='call-status'}}
function sendServerMessage(text,gif){const server=activeServer(),channel=activeChannel();if(!server||!channel)return;const value={t:'server-msg',serverId:server.id,channelId:channel.id,text,gif:gif?.url?{url:gif.url,thumb:gif.thumb||gif.url}:null,name:profileName,image:profileSharing&&profileAvatar.length<=480*1024?profileAvatar:'',frame:normalizeFrame(profileFrame)};let sent=0;for(const state of serverPeers.values())if(state.channel?.readyState==='open'){state.channel.send(JSON.stringify(value));sent++}addMessage(text,true,value.gif);if(!sent)pairHint.textContent='No server members are online in this channel. The message is saved locally only.'}
function profileSnapshotSignature(snapshot){const profiles=[...(snapshot?.friends||[]),...Object.values(snapshot?.members||{})];return JSON.stringify(profiles.map(user=>[user.id,user.name,user.image,user.frame]))}
function updateDirectorySnapshot(snapshot){const profilesChanged=profileSnapshotSignature(directorySnapshot)!==profileSnapshotSignature(snapshot),oldServerIds=new Set((directorySnapshot.servers||[]).map(server=>server.id)),newServer=pendingServerSelection?(snapshot.servers||[]).find(server=>!oldServerIds.has(server.id)):null;directorySnapshot=snapshot;renderFriends();renderServers();if(activePeerId){const friend=directoryUser(activePeerId);if(friend)applyFriendProfile(friend)}if(activeServerId){renderChannels();syncServerMesh()}if(newServer){pendingServerSelection=false;const dialog=$('#serverDialog');if(dialog?.open)dialog.close();selectServer(newServer.id)}if(profilesChanged&&activeConversationKey)openConversation(activeConversationKey)}
async function connectDirectory(){clearTimeout(directoryReconnect);const saved=await Promise.all([ss('directoryUserId'),ss('directoryToken'),ss('messageHistory')]);directoryUserId=/^[a-f0-9]{32}$/.test(saved[0]||'')?saved[0]:clientHex(16);directoryToken=/^[a-f0-9]{64}$/.test(saved[1]||'')?saved[1]:clientHex(32);if(directoryUserId!==saved[0])await ssSet('directoryUserId',directoryUserId);if(directoryToken!==saved[1])await ssSet('directoryToken',directoryToken);try{const parsed=JSON.parse(saved[2]||'{}');if(parsed&&typeof parsed==='object')conversationHistories=parsed}catch{}setDirectoryState(false,'Connecting…');const socket=new WebSocket(directoryAddress());directorySocket=socket;socket.onopen=async()=>{directoryBackoff=1000;try{const profile=await directoryProfile();if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'hello',userId:directoryUserId,token:directoryToken,...profile}))}catch(error){console.warn('directory profile',error);if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'hello',userId:directoryUserId,token:directoryToken,name:profileName,image:'',frame:normalizeFrame(profileFrame)}))}};socket.onmessage=event=>{try{const value=JSON.parse(event.data);if(value.type==='authenticated'){setDirectoryState(true,'Online');directoryProfilePush()}else if(value.type==='snapshot')updateDirectorySnapshot(value);else if(value.type==='invite-created'){if(value.kind==='friend'){const input=$('#roomCode');input.value=value.code;pairHint.textContent='Friend code '+value.code+' is ready for 15 minutes.'}else alert('Server invite code: '+value.code+'\n\nThis code expires in 15 minutes.')}else if(value.type==='connect-request'){const friend=directoryUser(value.from);if(friend){activePeerId=value.from;showFriends();applyFriendProfile(friend);openConversation('dm:'+value.from);automaticPair('join',value.session,value.from).then(()=>applyFriendProfile(friend))}}else if(value.type==='peer-signal')handleServerSignal(value).catch(error=>console.warn('server signal',error));else if(value.type==='error'){const message=value.message||'Pair directory request failed';pairHint.textContent=message;const dialog=$('#serverDialog');if(dialog?.open&&['create-server','redeem-invite'].includes(value.action)){pendingServerSelection=false;$('#serverDialogStatus').textContent=message;dialog.querySelectorAll('form button').forEach(button=>button.disabled=false)}}}catch(error){console.warn('directory message',error)}};socket.onclose=()=>{if(directorySocket!==socket)return;directorySocket=null;setDirectoryState(false,'Offline — retrying');directoryReconnect=setTimeout(connectDirectory,directoryBackoff);directoryBackoff=Math.min(30000,directoryBackoff*2)};socket.onerror=()=>setDirectoryState(false,'Connection error')}
function installFriendNavigation(){const search=$('#friendSearch');search.oninput=renderFriends;search.onkeydown=event=>{if(event.key!=='Enter')return;const first=$('#friendList .friend-entry');if(first){event.preventDefault();first.click()}};$('#friendsHome').onclick=()=>{search.value='';renderFriends();search.focus()}}
function installServerDialog(){const dialog=$('#serverDialog'),status=$('#serverDialogStatus'),createForm=$('#createServerForm'),joinForm=$('#joinServerForm'),name=$('#newServerName'),code=$('#serverInviteCode'),buttons=[...dialog.querySelectorAll('form button')];const setBusy=text=>{status.textContent=text;buttons.forEach(button=>button.disabled=true)};const open=()=>{status.textContent='';buttons.forEach(button=>button.disabled=false);dialog.showModal();setTimeout(()=>name.select(),0)};$('#addServer').onclick=open;$('#closeServerDialog').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{buttons.forEach(button=>button.disabled=false);if(!pendingServerSelection)status.textContent=''});dialog.addEventListener('click',event=>{const box=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom))dialog.close()});code.addEventListener('input',()=>{code.value=code.value.replace(/\D/g,'').slice(0,5)});createForm.onsubmit=event=>{event.preventDefault();const serverName=cleanClientName(name.value,'New server');if(!directorySend({type:'create-server',name:serverName})){status.textContent='Pair is offline. Reconnect before creating a server.';return}pendingServerSelection=true;setBusy('Creating '+serverName+'…')};joinForm.onsubmit=event=>{event.preventDefault();const invite=code.value.trim();if(!/^\d{5}$/.test(invite)){status.textContent='Enter the five-digit server invite code.';code.focus();return}if(!directorySend({type:'redeem-invite',code:invite})){status.textContent='Pair is offline. Reconnect before joining a server.';return}pendingServerSelection=true;setBusy('Joining server…')}}
function installDirectoryUI(){const originalSubmit=messageForm.onsubmit;messageForm.onsubmit=async event=>{if(!activeServerId)return originalSubmit(event);event.preventDefault();const text=convertEmoticons(messageInput.value.trim()),gif=pendingGif;if(!text&&!gif)return;sendServerMessage(text,gif);messageInput.value='';setPendingGif(null)};$('#homeButton').onclick=()=>{showFriends();if(activePeerId)selectFriend(activePeerId,{connect:false})};$('#addFriend').onclick=()=>{settingsPanel.hidden=true;document.body.classList.remove('settings-open');connectCard.open=true;syncPanelBackdrop();pairHint.textContent='Create a friend code, or enter the five digits your friend sent you.';$('#hostRoom').textContent='Create friend code';$('#joinRoom').textContent='Add friend';setTimeout(()=>$('#roomCode').focus(),0)};$('#hostRoom').onclick=()=>{if(!directorySend({type:'create-invite',kind:'friend'}))pairHint.textContent='Pair presence is offline. Reconnect before creating a friend code.'};$('#joinRoom').onclick=()=>{const code=$('#roomCode').value.trim();if(!/^\d{5}$/.test(code))return pairHint.textContent='Enter a five-digit friend code.';directorySend({type:'redeem-invite',code});pairHint.textContent='Adding friend…'};$('#inviteServer').onclick=()=>activeServerId&&directorySend({type:'create-invite',kind:'server',serverId:activeServerId});$('#addTextChannel').onclick=()=>{const name=prompt('Text channel name:','new-channel');if(name)directorySend({type:'create-channel',serverId:activeServerId,channelType:'text',name})};$('#addVoiceChannel').onclick=()=>{const name=prompt('Voice channel name:','New voice');if(name)directorySend({type:'create-channel',serverId:activeServerId,channelType:'voice',name})};$('#editServerPicture').onclick=()=>$('#serverPictureInput').click();$('#serverPictureInput').onchange=async()=>{const file=$('#serverPictureInput').files?.[0];$('#serverPictureInput').value='';if(!file)return;try{const picture=await resizeProfile(file);if(picture.length>512*1024)throw new Error('Choose a server image smaller than about 380 KB');directorySend({type:'update-server',serverId:activeServerId,picture})}catch(error){alert(error?.message||'Could not use that server picture')}};const directCall=callBtn.onclick;callBtn.onclick=()=>{if(!activeServerId)return directCall();if(serverVoiceStream)stopServerVoice();else if(activeChannel()?.type==='voice')joinServerVoice();else callStatus.textContent='Select a voice channel first.'};installSidebarLayout();installFriendNavigation();installServerDialog();showFriends({expand:false});connectDirectory()}
queueMicrotask(installDirectoryUI);
async function automaticPair(kind,explicitRoom='',expectedPeerId=''){
  // Tear down any prior session so a second Host/Join click (or host→leave→host)
  // doesn't leak an old pc/signaling whose handlers fire stale signals.
  reconnectCall=callActive;if(pc||signaling)disconnectRoom();
  role=kind;directoryTrustedConnection=!!expectedPeerId;activePeerId=expectedPeerId||activePeerId;const baseAddress=PAIR_SIGNAL_SERVER; const room=String(explicitRoom||$('#roomCode').value).trim().toUpperCase();
  if(!/^(?:\d{5}|[A-Z0-9_-]{16,64})$/.test(room))return pairHint.textContent='Enter the five-digit invite code.';
  const address=roomSignalAddress(baseAddress,room);
  pairHint.textContent='Connecting to signaling server…'; signaling=new WebSocket(address);
  signaling.onopen=()=>{try{signaling.send(JSON.stringify({type:'join',room}))}catch{}pairHint.textContent=kind==='host'?'Invite code '+room+' is ready — send it to your friend.':'Joining with invite code '+room+'…'};
  signaling.onerror=()=>pairHint.textContent='Could not reach Pair signaling. Check your internet connection.';
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
function disconnectRoom(){if(pc&&pc._connectTimer){clearTimeout(pc._connectTimer);pc._connectTimer=null}
  // Tear down an active share before closing the peer connection so WASAPI
  // capture and local MediaStream tracks do not keep running after leave.
  screenGen++;
  screenStarting=false;
  if(window.pairEnv?.platform==='linux')try{window.pairEnv.stopLinuxShareAudio?.()}catch{}
  screenActive=false;screenAudioDebug='';
  if(screenStatsTimer){clearInterval(screenStatsTimer);screenStatsTimer=null}screenStatsLast=null;
  cleanupNativeScreenCapture();
  if(screenStream){try{screenStream.getTracks().forEach(t=>t.stop())}catch{}screenStream=null}
  screenSenders=[];
  try{screenPreview.srcObject=null}catch{};screenPreview.hidden=true;
  screenBtn.textContent='Share screen';screenBtn.title='Share screen';screenBtn.disabled=true;
  screenStatus.textContent='Not sharing';
  remoteScreenExpected=false;
  try{if(chat){chat.onmessage=null;chat.close()}}catch{}try{if(files){files.onmessage=null;files.close()}}catch{}try{if(pc)pc.close()}catch{}if(pc&&pc._silentAudioCtx)try{pc._silentAudioCtx.close()}catch{}pc=chat=files=null;if(signaling){try{signaling.onopen=null;signaling.onerror=null;signaling.onmessage=null;signaling.close()}catch{}signaling=null}sharedKey=null;setAvatar(friendAvatar,'');setAvatarIdentity(friendAvatar,'');try{remoteAudio.srcObject=null}catch{};try{if(audioCtx&&audioCtx.audioSink){audioCtx.audioSink.disconnect();delete audioCtx.audioSink}}catch{}try{remoteScreen.srcObject=null}catch{};remoteScreen.hidden=true;
  // Release any pending backpressure waiters so in-flight sends don't hang
  // forever after the bus is closed. They'll re-check fileBus(), find it gone,
  // and the send loop will abort cleanly.
  busDrains.forEach(set=>set.forEach(h=>{try{h()}catch{}}));busDrains.clear();
  sendAbort.forEach(c=>c.abort=true);sendAbort.clear();acceptWait.forEach(w=>{try{w.reject(new Error('Disconnected'))}catch{}});acceptWait.clear();
  acceptCards.forEach(done=>{try{done(false)}catch{}});acceptCards.clear();  activeTransfers.forEach(t=>t.abort=true);activeTransfers.clear();pendingFrames.clear();outTransfers.clear();sendQueue=Promise.resolve();receiveQueue=Promise.resolve();connectSoundDone=false;friendLeftNotified=false;role=null;audioTransceiver=null;deriveGen++;setParticipant(participantYou,false);setParticipant(participantFriend,false);voiceLog.innerHTML='';setStatus('Not connected');$('#leaveRoom').hidden=true;$('#hostRoom').hidden=false;$('#joinRoom').hidden=false;pairHint.textContent='Disconnected from room.'}
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
    callActive=true;callStart=Date.now();callBtn.textContent='End call';callBtn.title='End local mic test';callBtn.disabled=false;muteBtn.hidden=false;micMuted=false;muteBtn.textContent='Mute';applyMicTransmission();setParticipant(participantYou,true);playSound('ring');callStatus.textContent='Testing microphone locally';callStatus.className='call-status live';
    callTimerId=setInterval(()=>{const s=Math.floor((Date.now()-callStart)/1000);callTimerEl.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0')},1000);
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
    // Configure Opus for maximum quality — 510 kbps (spec limit), 48 kHz, FEC
    try{const p=sender.getParameters();if(p){if(!p.encodings||!p.encodings.length)p.encodings=[{}];p.encodings[0].maxBitrate=256000;if(p.codecs)p.codecs.forEach(c=>{if(c.mimeType.toLowerCase()==='audio/opus'){c.maxptime=120;c.ptime=20;if(c.parameters){c.parameters.maxaveragebitrate=256000;c.parameters.maxplaybackrate=48000;c.parameters.useinbandfec=1;c.parameters.usedtx=0;c.parameters.cbr=1;c.parameters.stereo=1;c.parameters['sprop-stereo']=1;c.parameters.spropmaxcapturerate=48000}}});await sender.setParameters(p)}}catch(e){console.warn('opus params:',e)}
    // endCall may have run while we were awaiting getUserMedia or replaceTrack
    // (e.g. user clicked Stop Voice or the connection dropped). The generation
    // counter callGen is incremented by every endCall call. If it changed, bail.
    if(gen!==callGen||!pc){try{sender.replaceTrack(null)}catch{};if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}return}
    // endCall/disconnectRoom may have run during a nested await; if pc is gone bail.
    if(!pc){try{sender.replaceTrack(null)}catch{};if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}return}
    callActive=true;callStart=Date.now();setRemoteCallAudio(true);callBtn.textContent='End call';callBtn.title='End voice call';callBtn.disabled=false;muteBtn.hidden=false;micMuted=false;muteBtn.textContent='Mute';muteBtn.title='Mute microphone';applyMicTransmission();
    try{remoteAudio.volume=0}catch{};setCallVolume(volumeSlider.value,false);volumeSlider.hidden=false;volumeValue.hidden=false;
    setParticipant(participantYou,true);logCallEvent('You joined the call');
    playSound('ring');try{send({t:'call-ring'})}catch{}
    callStatus.textContent='Voice live';callStatus.className='call-status live';
    callTimerId=setInterval(()=>{const s=Math.floor((Date.now()-callStart)/1000);const m=Math.floor(s/60),sec=s%60;callTimerEl.textContent=m+':'+String(sec).padStart(2,'0')},1000);
  }catch(e){try{send({t:'call-end'})}catch{};endCall(true);const m=String(e?.message||e||'');if(/not\s*found/i.test(m))callStatus.textContent='No mic found — check your microphone connection';else if(/permission|denied|not\s*allowed/i.test(m))callStatus.textContent='Mic access blocked — allow microphone in browser/app settings';else callStatus.textContent='Mic error — '+(e?.message||e);callStatus.className='call-status';
  }finally{callStarting=false}
}
// Tear down the call and release the mic. `silent` skips UI churn when called
// from a disconnect.
async function endCall(silent){
  if(!silent){setParticipant(participantYou,false);logCallEvent('You left the call')}
  if(screenActive||screenStarting||screenStream)await stopScreenShare(true);
  callGen++;
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
  callBtn.textContent='Start call';callBtn.title='Start voice call';muteBtn.hidden=true;volumeSlider.hidden=true;volumeValue.hidden=true;callStatus.textContent='Voice off';callStatus.className='call-status';
  if(!silent){callBtn.disabled=!pc&&!LOCAL_TEST_MODE;playSound('leave');try{send({t:'call-end'})}catch{}}
}
function toggleMute(){
  if(!localStream)return;
  micMuted=!micMuted;
  applyMicTransmission();
  if(micMuted){muteBtn.textContent='Unmute';muteBtn.title='Unmute microphone'}else if(voiceInputModeValue!=='ptt'){muteBtn.textContent='Mute';muteBtn.title='Mute microphone'}
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
// Capture desktop sound for screen share while keeping Pair voice out of that
// mix. Windows uses process-loopback that excludes Pair's process tree; Linux
// uses a dedicated PipeWire sink. The voice call stays on its own WebRTC track.
async function setupNativeScreenCapture(){
  if(!window.pairCapture){
    console.warn('[AUDIO] isolated desktop capture unavailable; refusing full-mix loopback');
    return null;
  }

  let ctx,dest,addonData=false,captureReady=false,captureClosed=false,captureFailure='',outputTrack=null;
  try{
    ctx=new AudioContext({sampleRate:48000});
    if(ctx.state==='suspended'){try{await ctx.resume()}catch{}}
    dest=ctx.createMediaStreamDestination();dest.channelCount=2;
    // Interleaved stereo ring: [L,R,L,R,...]
    const RS=96000;const cleanBuf=new Float32Array(RS*2);
    let wp=0,avail=0;
    const unsubClean=window.pairCapture.onCleanAudio((buf,frames)=>{
      if(captureClosed)return;
      addonData=true;
      const arr=new Float32Array(buf);
      // Prefer interleaved stereo from the native addon. Older builds emit mono
      // (one float per frame); lift that to L/R so the share track stays stereo.
      const stereo=arr.length>=frames*2;
      for(let i=0;i<frames&&avail<RS;i++){
        if(stereo){
          cleanBuf[wp*2]=arr[i*2];
          cleanBuf[wp*2+1]=arr[i*2+1];
        }else{
          const s=arr[i]||0;
          cleanBuf[wp*2]=s;
          cleanBuf[wp*2+1]=s;
        }
        wp=(wp+1)%RS;
        avail++;
      }
    });
    const unsubError=window.pairCapture.onError(msg=>{
      captureFailure=String(msg||'native capture failed');
      console.warn('[AUDIO] capture error:',captureFailure);
      // A failure after attachment must not leave a silent track labelled as
      // healthy. End it, release native capture, and expose the actual stage in
      // the same live status used for video quality diagnostics.
      if(outputTrack&&outputTrack.readyState==='live'){
        try{outputTrack.stop()}catch{}
        screenAudioDebug=' · sound capture stopped';
        if(screenActive)screenStatus.textContent='Sharing'+screenAudioDebug;
        queueMicrotask(()=>cleanupNativeScreenCapture());
      }
    });
    // The format notification means WASAPI initialized successfully. Do not
    // require audible samples to be playing during this short startup window;
    // an idle but valid loopback stream should still be attached to WebRTC.
    const unsubFormat=window.pairCapture.onFormat?.(fmt=>{if(fmt&&fmt.available!==false)captureReady=true});
    window.pairCapture.start();
    // Attach as soon as WASAPI is ready or the first packet arrives so share
    // audio starts with the video instead of waiting on audible desktop sound.
    const deadline=Date.now()+2500;
    while(!captureReady&&!addonData&&!captureFailure&&Date.now()<deadline)await new Promise(r=>setTimeout(r,40));
    if(captureFailure||(!captureReady&&!addonData)){
      console.warn('[AUDIO] isolated desktop capture did not initialize; sharing video only',captureFailure);
      captureClosed=true;
      if(unsubClean)unsubClean();if(unsubError)unsubError();if(unsubFormat)unsubFormat();
      window.pairCapture.stop();
      if(ctx)try{ctx.close()}catch{}
      return null;
    }
    const B=1024;
    const op=ctx.createScriptProcessor(B,0,2);
    op.onaudioprocess=e=>{
      const L=e.outputBuffer.getChannelData(0);
      const R=e.outputBuffer.getChannelData(1);
      if(avail<L.length){L.fill(0);R.fill(0);return}
      const rp=(wp-avail+RS)%RS;
      for(let i=0;i<L.length;i++){
        const idx=((rp+i)%RS)*2;
        L[i]=cleanBuf[idx];
        R[i]=cleanBuf[idx+1];
      }
      avail-=L.length;
    };
    op.connect(dest);
    screenOutCtx=ctx;screenOutDest=dest;
    screenNative=true;
    outputTrack=dest.stream.getAudioTracks()[0];
    try{if(outputTrack)outputTrack.contentHint='music'}catch{}
    screenCaptureCleanup=()=>{if(unsubClean)unsubClean();if(unsubError)unsubError();if(unsubFormat)unsubFormat();window.pairCapture.stop();try{op.disconnect()}catch{}};
    return outputTrack||null;
  }catch(e){
    console.warn('[AUDIO] isolated desktop capture failed:',e?.message||e);
    if(ctx)try{ctx.close()}catch{}
    try{window.pairCapture.stop()}catch{}
    return null;
  }
}
function cleanupNativeScreenCapture(){
  screenNative=false;
  if(screenCaptureCleanup){try{screenCaptureCleanup()}catch{};screenCaptureCleanup=null}
  if(screenOutDest){screenOutDest=null}
  if(screenOutCtx){try{screenOutCtx.close()}catch{};screenOutCtx=null}
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
      const deadline=Date.now()+2500;while(!format&&!frames&&!error&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,40));
      if(error)throw new Error(error);if(!format&&!frames)throw new Error('WASAPI process-loopback did not initialize');
      status.dataset.state='ready';status.textContent=`Ready — WASAPI process isolation initialized${format?.sampleRate?' at '+format.sampleRate.toLocaleString()+' Hz':''}${format?.channels?' · '+format.channels+' channels':''}.`;
    }else throw new Error('isolated computer-audio capture is available in the Windows and Linux apps');
  }catch(error){
    const message=String(error?.message||error||'unknown error').replace(/\s+/g,' ').slice(0,240);
    status.dataset.state='error';status.textContent='Unavailable — '+message+'. Screen video remains safe; Pair will not fall back to an echoing whole-system mix.';
  }finally{
    if(window.pairEnv?.platform==='linux')try{window.pairEnv.stopLinuxShareAudio?.()}catch{}
    else try{window.pairCapture?.stop?.()}catch{}
    unsubs.forEach(unsub=>{try{unsub?.()}catch{}});button.disabled=false;
  }
}
async function linuxShareAudioTrack(){
  if(!window.pairEnv?.startLinuxShareAudio||!window.pairEnv?.onLinuxShareAudio)return null;
  let ctx,dest,op,unsubData,unsubError,received=false,captureError='';
  try{
    ctx=new AudioContext({sampleRate:48000});
    if(ctx.state==='suspended'){try{await ctx.resume()}catch{}}
    dest=ctx.createMediaStreamDestination();dest.channelCount=2;
    const RS=96000,pcm=new Float32Array(RS*2);let wp=0,avail=0;
    unsubData=window.pairEnv.onLinuxShareAudio(buf=>{
      const arr=new Float32Array(buf);received=true;
      const frames=Math.floor(arr.length/2);
      for(let i=0;i<frames;i++){
        // When the renderer falls behind, discard the oldest frame instead of
        // freezing capture until the entire two-second ring drains.
        if(avail===RS)avail--;
        pcm[wp*2]=arr[i*2];pcm[wp*2+1]=arr[i*2+1];wp=(wp+1)%RS;avail++;
      }
    });
    unsubError=window.pairEnv.onLinuxShareAudioError?.(message=>{captureError=String(message||'capture failed');console.warn('[AUDIO] PipeWire capture error:',captureError)});
    const share=await window.pairEnv.startLinuxShareAudio();if(!share)throw new Error('PipeWire share route could not be created');
    const deadline=Date.now()+2500;while(!received&&!captureError&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,40));
    if(!received)throw new Error(captureError||'PipeWire monitor produced no samples');
    const B=1024;op=ctx.createScriptProcessor(B,0,2);
    op.onaudioprocess=e=>{
      const L=e.outputBuffer.getChannelData(0),R=e.outputBuffer.getChannelData(1);
      if(avail<L.length){L.fill(0);R.fill(0);return}
      const rp=(wp-avail+RS)%RS;
      for(let i=0;i<L.length;i++){const idx=((rp+i)%RS)*2;L[i]=pcm[idx];R[i]=pcm[idx+1]}
      avail-=L.length;
    };
    op.connect(dest);screenOutCtx=ctx;screenOutDest=dest;screenNative=true;
    const track=dest.stream.getAudioTracks()[0]||null;try{if(track)track.contentHint='music'}catch{}
    screenCaptureCleanup=()=>{if(unsubData)unsubData();if(unsubError)unsubError();window.pairEnv.stopLinuxShareAudio?.();try{op.disconnect()}catch{}};
    return track;
  }catch(e){
    console.warn('[AUDIO] direct PipeWire capture failed:',e?.message||e);
    screenAudioDebug=' · PipeWire capture unavailable';
    if(unsubData)unsubData();if(unsubError)unsubError();try{op?.disconnect()}catch{};try{ctx?.close()}catch{};window.pairEnv.stopLinuxShareAudio?.();return null;
  }
}
function startScreenStats(sender){
  if(screenStatsTimer)clearInterval(screenStatsTimer);screenStatsLast=null;
  const sample=async()=>{try{if(!screenActive)return;const reports=await sender.getStats();let out,pair,source;reports.forEach(r=>{if(r.type==='outbound-rtp'&&(r.kind==='video'||r.mediaType==='video')&&!r.isRemote)out=r;if(r.type==='candidate-pair'&&r.state==='succeeded'&&(r.nominated||r.selected))pair=r;if(r.type==='media-source'&&(r.kind==='video'||r.mediaType==='video'))source=r});if(!out)return;const now=performance.now(),previous=screenStatsLast;let mbps='…',encodeMs='',measuredFps=0;if(previous&&now>previous.at){const elapsed=now-previous.at;mbps=(((out.bytesSent-previous.bytes)*8)/elapsed/1000).toFixed(1);const encoded=(out.framesEncoded||0)-(previous.framesEncoded||0),encode=(out.totalEncodeTime||0)-(previous.totalEncodeTime||0);measuredFps=Math.round(encoded*1000/elapsed);if(encoded>0&&encode>=0)encodeMs=(encode/encoded*1000).toFixed(1)}screenStatsLast={bytes:out.bytesSent,framesEncoded:out.framesEncoded||0,totalEncodeTime:out.totalEncodeTime||0,at:now};const fps=Math.round(out.framesPerSecond||measuredFps||0),sourceFps=Math.round(source?.framesPerSecond||0),w=out.frameWidth||source?.width||0,h=out.frameHeight||source?.height||0,codecReport=reports.get(out.codecId),codec=codecReport?.mimeType?.replace(/^video\//i,'')||'',encoder=String(out.encoderImplementation||'').trim().slice(0,32);const reason=out.qualityLimitationReason,remote=reports.get(out.remoteId),rtt=Number(remote?.roundTripTime??pair?.currentRoundTripTime),loss=Number(remote?.fractionLost),available=Number(pair?.availableOutgoingBitrate),target=Number(out.targetBitrate);const wants4k60=h>=2160&&w>=3840&&shareFrameRate>=60,is4k60=wants4k60&&fps>=55,slowCapture=wants4k60&&sourceFps>0&&sourceFps<55,slowEncoder=wants4k60&&previous&&!slowCapture&&fps<55;const limit=reason==='bandwidth'?' · network limited':reason==='cpu'||slowEncoder?' · encoder below 60fps':slowCapture?' · capture below 60fps':reason&&reason!=='none'?' · quality adapting':is4k60?' · 4K60 locked':'';const network=(Number.isFinite(rtt)?' · '+Math.round(rtt*1000)+'ms RTT':'')+(Number.isFinite(loss)&&loss>0?' · '+(loss*100).toFixed(1)+'% loss':'')+(Number.isFinite(available)&&available>0?' · '+(available/1e6).toFixed(0)+' Mbps available':'');const rate=mbps!=='…'?' · '+mbps+(Number.isFinite(target)&&target>0?'/'+(target/1e6).toFixed(0):'')+' Mbps':'';const encode=encodeMs?' · '+encodeMs+'ms encode':'';const status='Sharing'+(w&&h?' · '+w+'×'+h:'')+(fps?' · '+fps+'fps':'')+rate+(codec?' · '+codec:'')+(encoder?' '+encoder:'')+encode+network+limit+screenAudioDebug;screenStatus.textContent=status;screenBtn.title=status}catch{}};
  sample();screenStatsTimer=setInterval(sample,2000);
}
function orderedScreenCodecs(caps){
  // Linux Chromium commonly falls back to OpenH264 software encoding, which is
  // unable to keep up with 4K capture. VP9 avoids H.264's level constraints and
  // is also exposed by Intel's VA-API encoder when acceleration is available.
  const automatic=window.pairEnv?.platform==='linux'?['VP9','H264','VP8','AV1','H265']:['H264','VP9','VP8','AV1','H265'];
  const requested=screenCodec==='auto'?automatic:[screenCodec,...automatic];
  const order=[...new Set(requested.map(name=>name.toUpperCase()))],seen=new Set(),result=[];
  for(const name of order)for(const codec of caps.codecs||[]){if(codec.mimeType?.toUpperCase()!==`VIDEO/${name}`||seen.has(codec))continue;seen.add(codec);result.push(codec)}
  // Keep retransmission and forward-error-correction codecs. Dropping these
  // while forcing a preferred primary codec makes packet loss look like a
  // video-quality problem even on an otherwise fast connection.
  for(const codec of caps.codecs||[]){if(!seen.has(codec)&&/^video\/(?:rtx|red|ulpfec|flexfec)/i.test(codec.mimeType||'')){seen.add(codec);result.push(codec)}}
  return result;
}
function targetScreenBitrate(width,height,fps){
  const pixels=Math.max(1,(Number(width)||1920)*(Number(height)||1080)),motion=Math.max(.5,(Number(fps)||60)/60);
  // Quality-first ceilings: about 40 Mbps for 1080p60, 72 Mbps for 1440p60,
  // and 160 Mbps for 4K60. Static content can encode far below this without a
  // quality loss; this removes Pair as the bottleneck without disabling the
  // congestion control that prevents an overloaded link from building latency.
  const ratio=pixels/(1920*1080),sourceTarget=(ratio<=1?40:ratio<=2?72:160*Math.max(1,ratio/4))*Math.pow(motion,.74);
  return Math.round(Math.min(screenBitrateMbps,Math.max(8,sourceTarget))*1000000);
}
async function configureScreenVideoSender(sender,track,fps){
  const settings=track.getSettings?.()||{},maxBitrate=targetScreenBitrate(settings.width,settings.height,fps);
  const p=sender.getParameters();if(!p.encodings||!p.encodings.length)p.encodings=[{}];
  p.encodings[0].maxBitrate=maxBitrate;p.encodings[0].maxFramerate=fps;p.encodings[0].scaleResolutionDownBy=1;p.encodings[0].priority='high';
  if('networkPriority' in p.encodings[0])p.encodings[0].networkPriority='high';
  // Source fidelity prevents Chromium from silently scaling a 1440p/4K share
  // down. When capacity is tight it may reduce quantizer quality or drop input
  // frames, which the live diagnostic exposes instead of hiding the downgrade.
  p.degradationPreference='maintain-framerate-and-resolution';
  try{await sender.setParameters(p)}catch(e){
    // Older WebRTC builds may reject priority while accepting the core quality
    // controls. Retry with a fresh transaction object and the portable fields.
    const fallback=sender.getParameters();if(!fallback.encodings||!fallback.encodings.length)fallback.encodings=[{}];fallback.encodings[0].maxBitrate=maxBitrate;fallback.encodings[0].maxFramerate=fps;fallback.encodings[0].scaleResolutionDownBy=1;fallback.degradationPreference='maintain-framerate-and-resolution';await sender.setParameters(fallback);console.warn('[VIDEO] optional priority parameters unsupported; core source-fidelity lock retained:',e?.message||e)
  }
  const applied=sender.getParameters(),encoding=applied.encodings?.[0]||{};
  if(encoding.scaleResolutionDownBy!==undefined&&encoding.scaleResolutionDownBy!==1)throw new Error('browser changed the requested screen scale');
  console.log('[VIDEO] source='+((settings.width||'?')+'×'+(settings.height||'?'))+' ceiling='+(Number(encoding.maxBitrate||maxBitrate)/1e6).toFixed(1)+'Mbps '+fps+'fps degradation='+(applied.degradationPreference||'browser-default'));
}
async function startScreenShare(){
  if(screenActive||screenStarting||!pc)return;
  screenStarting=true;
  const gen=++screenGen;
  // Show source picker in Electron app (in browser getDisplayMedia shows native picker)
  try{
  if(window.pairEnv?.getSources&&!window.pairEnv.useSystemPicker){
    const sources=await window.pairEnv.getSources();
    if(!sources.length||gen!==screenGen){screenStatus.textContent='No sources';return}
    const id=await new Promise(resolve=>{
      const o=document.createElement('div');o.className='screen-source-modal';
      const b=document.createElement('div');b.className='screen-source-dialog';
      b.innerHTML='<h3>Select what to share</h3><div class="share-start-options"><label>Resolution<select id="shareResolution"><option value="source" selected>Source — sharpest</option><option value="2160">4K</option><option value="1440">1440p</option><option value="1080">1080p</option><option value="720">720p</option></select></label><label>Frame rate<select id="shareFrameRate"><option value="60" selected>60 fps</option><option value="30">30 fps</option></select></label><label class="share-audio-option"><input id="shareSystemAudio" type="checkbox" checked /> Share computer sound<span class="share-audio-hint">Desktop apps and games — Pair voice is always excluded</span></label></div>';
      const resolution=b.querySelector('#shareResolution'),frameRate=b.querySelector('#shareFrameRate'),audio=b.querySelector('#shareSystemAudio');resolution.value=String(shareResolution);frameRate.value=String(shareFrameRate);audio.checked=screenAudioOn;
      const g=document.createElement('div');g.className='screen-source-grid';
      sources.forEach(s=>{const btn=document.createElement('button');btn.type='button';btn.className='screen-source-option';const img=document.createElement('img');img.src=s.thumbnail;img.alt='';const name=document.createElement('span');name.textContent=s.name;btn.append(img,name);btn.onclick=()=>{shareResolution=['source','720','1080','1440','2160'].includes(resolution.value)?resolution.value:'source';shareFrameRate=Number(frameRate.value)===30?30:60;screenAudioOn=audio.checked;syncScreenPreset();ssSet('shareResolution',shareResolution);ssSet('shareFrameRate',String(shareFrameRate));resolve(s.id);o.remove()};g.appendChild(btn)});
      const c=document.createElement('button');c.className='screen-source-cancel';c.textContent='Cancel';c.onclick=()=>{resolve(null);o.remove()};
      b.appendChild(g);b.appendChild(c);o.appendChild(b);document.body.appendChild(o);
    });
    if(!id||gen!==screenGen)return;
    window.pairEnv.setPendingSource(id);
  }
  try{
    const heights={720:720,1080:1080,1440:1440,2160:2160},height=heights[shareResolution],width=height?Math.round(height*16/9):null,fps=shareFrameRate===30?30:60;
    const v={frameRate:{ideal:fps,max:fps}};if(width&&height){v.width={ideal:width,max:width};v.height={ideal:height,max:height}}
    v.cursor=screenCursor;
    const constraints={video:v};
    // Never request Chromium's full-mix loopback. That path includes Pair voice
    // playback. Computer sound is attached separately through isolated capture
    // so desktop/game audio can share while the call stays on the voice track.
    constraints.audio=false;
    const stream=await navigator.mediaDevices.getDisplayMedia(constraints);
    if(gen!==screenGen||!pc){stream.getTracks().forEach(t=>t.stop());return}
    screenStream=stream;
    const track=stream.getVideoTracks()[0];
    if(!track){stream.getTracks().forEach(t=>t.stop());return}
    // Desktop capture defaults to text/detail on some Chromium builds. Motion
    // tells the encoder to preserve changing game/action content instead.
    try{track.contentHint=screenContentHint}catch{}
    // Add the video track
    let sender;
    try{sender=pc.addTrack(track,stream);screenSenders=[sender]}catch{stream.getTracks().forEach(t=>t.stop());return}
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
        // an orphaned Pair Share sink after the user has already stopped.
        if(window.pairEnv?.platform==='linux')try{window.pairEnv.stopLinuxShareAudio?.()}catch{}
        else cleanupNativeScreenCapture();
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
    // Prefer codecs that are normally hardware accelerated. AV1 is excellent at
    // low bitrates but its software encoder is a frequent source of high CPU and
    // seconds of latency during desktop capture, so it stays a last fallback.
    try{const tr=pc.getTransceivers().find(t=>t.sender===sender),caps=RTCRtpSender.getCapabilities('video');if(tr&&caps){const codecs=orderedScreenCodecs(caps);if(codecs.length)tr.setCodecPreferences(codecs)}}catch(e){console.warn('[VIDEO] codec pref err:',e)}
    try{await configureScreenVideoSender(sender,track,fps)}catch(e){console.warn('[VIDEO] setParams err:',e)}
    if(gen!==screenGen||!pc){screenSenders.forEach(s=>{try{pc.removeTrack(s)}catch{}});screenSenders=[];stream.getTracks().forEach(t=>t.stop());return}
    screenActive=true;screenAudioDebug=screenAudioOn?' · starting sound capture':' · sound off';
    screenPreview.muted=true;
    screenPreview.srcObject=stream;screenPreview.hidden=false;try{screenPreview.play()}catch{}
    screenBtn.textContent='Stop sharing';screenBtn.title='Stop screen sharing';screenStatus.textContent='Sharing';
    startScreenStats(sender);
    try{send({t:'screen-start'})}catch{};
    logCallEvent('You started screen sharing');
    track.onended=()=>{if(screenActive)stopScreenShare()};
    const videoNegotiated=await renegotiate();if(gen!==screenGen)return;
    // Negotiation can replace the browser's internal send stream. Reapply the
    // 4K/60 ceiling and no-scale preference to the negotiated sender so a
    // browser default cannot silently take over after the initial setup.
    if(videoNegotiated)try{await configureScreenVideoSender(sender,track,fps)}catch(e){console.warn('[VIDEO] post-negotiation params err:',e)}
    void attachShareAudio();
  }catch(e){screenStatus.textContent='Share failed';if(e.name!=='NotAllowedError')logCallEvent('Screen share error')}
  }finally{if(gen===screenGen)screenStarting=false}
}
async function stopScreenShare(fromEnd){
  if(!screenActive&&!screenStarting&&!fromEnd&&!screenStream)return;
  screenGen++;
  screenStarting=false;
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
  screenPreview.srcObject=null;screenPreview.hidden=true;
  screenBtn.textContent='Share screen';screenBtn.title='Share screen';screenBtn.disabled=!pc;
  if(!fromEnd){screenStatus.textContent='Not sharing';try{send({t:'screen-end'})}catch{};logCallEvent('You stopped screen sharing')}
}
screenBtn.onclick=()=>{if(screenActive||screenStarting)stopScreenShare();else if(!pc&&LOCAL_TEST_MODE){screenStatus.textContent='Pair with a friend to start screen sharing';screenStatus.className='screen-status';}else startScreenShare()};
screenPreset.onchange=async()=>{const match=screenPreset.value.match(/^(source|720p|1080p|1440p|2160p)(30|60)$/);if(!match)return;shareResolution=match[1].replace(/p$/,'');shareFrameRate=Number(match[2]);ssSet('shareResolution',shareResolution);ssSet('shareFrameRate',String(shareFrameRate));if(screenActive||screenStarting){await stopScreenShare();await startScreenShare()}};
// Screen share computer-sound toggle. Voice always stays on the call track;
// this only controls whether desktop/game sound rides with the share.
let screenAudioOn=true;
const audioToggleBtn=document.createElement('button');audioToggleBtn.textContent='Sound on';audioToggleBtn.className='audio-toggle is-on';
audioToggleBtn.title='Share computer sound with the screen (not the voice call)';
audioToggleBtn.onclick=()=>{screenAudioOn=!screenAudioOn;audioToggleBtn.textContent=screenAudioOn?'Sound on':'Sound off';audioToggleBtn.classList.toggle('is-on',screenAudioOn);audioToggleBtn.title=screenAudioOn?'Share computer sound with the screen (not the voice call)':'Computer sound will not be shared'};screenBtn.parentElement.insertBefore(audioToggleBtn,screenStatus);
const syncAudioToggleAvailability=()=>{audioToggleBtn.disabled=screenBtn.disabled};new MutationObserver(syncAudioToggleAvailability).observe(screenBtn,{attributes:true,attributeFilter:['disabled']});syncAudioToggleAvailability();
// Volume slider for the remote screen share audio, shown on right-click.
const screenVolWrap=document.createElement('div');screenVolWrap.className='screen-volume';
const screenVolLabel=document.createElement('span');screenVolLabel.textContent='Volume';
const screenVol=document.createElement('input');screenVol.type='range';screenVol.min=0;screenVol.max=100;screenVol.value=100;
screenVol.oninput=()=>{const v=Math.max(0,Math.min(100,Number(screenVol.value)||0))/100;remoteScreen.volume=v;remoteScreen.muted=v===0;ssSet('screenVol',String(v))};
enableRangeDrag(screenVol);
// Restore saved screen volume (fire-and-forget).
(async()=>{try{const saved=await ss('screenVol');if(saved!==null){const v=parseFloat(saved);if(v>=0&&v<=1){remoteScreen.volume=v;remoteScreen.muted=v===0;screenVol.value=Math.round(v*100)}}}catch{}})()
screenVolWrap.appendChild(screenVolLabel);screenVolWrap.appendChild(screenVol);remoteScreen.parentElement.appendChild(screenVolWrap);
remoteScreen.addEventListener('contextmenu',e=>{e.preventDefault();screenVolWrap.style.display=screenVolWrap.style.display==='none'?'flex':'none';screenVolWrap.style.alignItems='center'});
document.addEventListener('click',e=>{if(!screenVolWrap.contains(e.target)&&e.target!==remoteScreen&&!e.target.closest?.('[data-screen-volume]'))screenVolWrap.style.display='none'});
const screenVideos=screenPreview.parentElement;let screenExpanded=false,focusedScreen='remote';
function makeScreenTile(video,label,kind){const tile=document.createElement('article');tile.className='screen-tile '+kind;tile.dataset.screenTile=kind;const name=document.createElement('span');name.className='screen-tile-name';name.textContent=label;const avatar=document.createElement('span');avatar.className='screen-tile-avatar';avatar.textContent=kind==='local'?'Y':'F';tile.append(video,name,avatar);return tile}
const localScreenTile=makeScreenTile(screenPreview,'You', 'local'),remoteScreenTile=makeScreenTile(remoteScreen,'Friend', 'remote');remoteScreenTile.appendChild(screenVolWrap);screenVideos.replaceChildren(localScreenTile,remoteScreenTile);
const screenViewBar=document.createElement('div');screenViewBar.className='screen-view-bar';screenViewBar.innerHTML='<button type="button" data-screen-volume title="Screen volume" aria-label="Screen volume">♫</button><button type="button" data-screen-fullscreen title="Fullscreen" aria-label="Fullscreen">⛶</button>';screenVideos.after(screenViewBar);
const screenVolumeBtn=screenViewBar.querySelector('[data-screen-volume]'),fsBtn=screenViewBar.querySelector('[data-screen-fullscreen]'),screenStage=screenVideos.parentElement;screenStage.classList.add('screen-stage');let nativeShareFullscreen=false;
const screenAudioBadge=document.createElement('span');screenAudioBadge.className='screen-audio-badge';screenStage.appendChild(screenAudioBadge);const syncScreenAudioBadge=()=>{screenAudioBadge.textContent=screenStatus.textContent||'Sharing';screenAudioBadge.hidden=!screenIsActive()};new MutationObserver(syncScreenAudioBadge).observe(screenStatus,{childList:true,characterData:true,subtree:true});
function screenIsActive(){return !screenPreview.hidden||!remoteScreen.hidden}
function updateScreenLayout(){const hasLocal=!screenPreview.hidden,hasRemote=!remoteScreen.hidden,fullscreen=!!document.fullscreenElement||screenStage.classList.contains('fs');if(!hasRemote)focusedScreen='local';if(!hasLocal)focusedScreen='remote';if(!hasLocal&&!hasRemote)screenExpanded=false;voicePanel.classList.toggle('screen-sharing',hasLocal||hasRemote);voicePanel.classList.toggle('screen-expanded',screenExpanded&&(hasLocal||hasRemote));screenStage.classList.toggle('screen-expanded-local',focusedScreen==='local');localScreenTile.hidden=!hasLocal;remoteScreenTile.hidden=!hasRemote;screenViewBar.hidden=!screenIsActive();fsBtn.hidden=!screenExpanded||!screenIsActive();fsBtn.textContent=fullscreen?'✕':'⛶';fsBtn.title=fullscreen?'Exit fullscreen':'Fullscreen';syncScreenAudioBadge()}
function returnToSharePreview(){screenStage.classList.remove('fs');document.body.classList.remove('screen-fullscreen');screenExpanded=false;updateScreenLayout()}
function toggleRemoteFs(){if(screenStage.classList.contains('fs')||document.fullscreenElement){if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});else if(nativeShareFullscreen)window.pairEnv?.toggleFullscreen?.();nativeShareFullscreen=false;returnToSharePreview();return}screenStage.classList.add('fs');document.body.classList.add('screen-fullscreen');nativeShareFullscreen=!!window.pairEnv?.toggleFullscreen;window.pairEnv?.toggleFullscreen?.();updateScreenLayout()}
screenVideos.addEventListener('click',event=>{if(event.target.closest('input,button,label'))return;const tile=event.target.closest('[data-screen-tile]');if(!tile)return;focusedScreen=tile.dataset.screenTile;if(!screenExpanded)screenExpanded=true;try{if(remoteScreen.volume>0)remoteScreen.muted=false;remoteScreen.play().catch(()=>{})}catch{}updateScreenLayout()});
screenViewBar.onclick=event=>{if(event.target.closest('[data-screen-volume]')){screenVolWrap.style.display=screenVolWrap.style.display==='flex'?'none':'flex';screenVolWrap.style.alignItems='center'}else if(event.target.closest('[data-screen-fullscreen]'))toggleRemoteFs()};
const screenLayoutObserver=new MutationObserver(updateScreenLayout);screenLayoutObserver.observe(screenPreview,{attributes:true,attributeFilter:['hidden']});screenLayoutObserver.observe(remoteScreen,{attributes:true,attributeFilter:['hidden']});updateScreenLayout();
window.pairEnv?.onFullscreenChange?.(isFullscreen=>{nativeShareFullscreen=!!isFullscreen;if(!isFullscreen)returnToSharePreview()});document.addEventListener('fullscreenchange',()=>{const is=!!document.fullscreenElement;document.body.classList.toggle('screen-fullscreen',is);if(!is)returnToSharePreview();else updateScreenLayout()});document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(document.fullscreenElement||screenStage.classList.contains('fs'))toggleRemoteFs();else if(screenExpanded)returnToSharePreview()});
