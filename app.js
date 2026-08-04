/* Pair: manual-signaling, two-person P2P chat with application-level E2EE. */
const $=s=>document.querySelector(s);const signalOut=$('#signalOut'),signalIn=$('#signalIn'),copySignal=$('#copySignal'),processSignal=$('#processSignal'),pairCodeMeta=$('#pairCodeMeta'),statusText=$('#statusText'),messages=$('#messages'),messageForm=$('#messageForm'),messageInput=$('#messageInput'),fileInput=$('#fileInput'),chooseFiles=$('#chooseFiles'),transfers=$('#transfers'),pairHint=$('#pairHint'),participantYou=$('#participantYou'),participantFriend=$('#participantFriend'),voiceLog=$('#voiceLog'),screenBtn=$('#screenBtn'),screenPreset=$('#screenPreset'),screenStatus=$('#screenStatus'),screenPreview=$('#screenPreview'),remoteScreen=$('#remoteScreen');
const updateBanner=$('#updateBanner'),updateTitle=$('#updateTitle'),updateDetails=$('#updateDetails');let updateHideTimer=null;
function renderUpdateStatus(status){if(!updateBanner||!status)return;clearTimeout(updateHideTimer);const state=String(status.state||'idle');updateBanner.className='update-banner update-'+state;updateTitle.textContent=status.message||'Checking for updates…';updateDetails.textContent=status.version?'Pair '+status.version:'';updateBanner.hidden=state==='idle'||state==='current';if(state==='current')updateHideTimer=setTimeout(()=>{updateBanner.hidden=true},1200)}
if(window.pairUpdates){window.pairUpdates.getStatus().then(renderUpdateStatus).catch(()=>{});window.pairUpdates.onStatus(renderUpdateStatus)}
let pc,chat,files,role,sharedKey,sendQueue=Promise.resolve(),receiveQueue=Promise.resolve();let CHUNK=1024*1024;const MAX=200*1024**3;
const SCREEN_PRESETS={'480p30':{width:{ideal:854,max:854},height:{ideal:480,max:480},frameRate:{ideal:30,max:30}},'720p30':{width:{ideal:1280,max:1280},height:{ideal:720,max:720},frameRate:{ideal:30,max:30}},'720p60':{width:{ideal:1280,max:1280},height:{ideal:720,max:720},frameRate:{ideal:60,max:60}},'1080p30':{width:{ideal:1920,max:1920},height:{ideal:1080,max:1080},frameRate:{ideal:30,max:30}},'1080p60':{width:{ideal:1920,max:1920},height:{ideal:1080,max:1080},frameRate:{ideal:60,max:60}},'1440p60':{width:{ideal:2560,max:2560},height:{ideal:1440,max:1440},frameRate:{ideal:60,max:60}},'4k60':{width:{ideal:3840,max:3840},height:{ideal:2160,max:2160},frameRate:{ideal:60,max:60}}};
// Voice: a live two-way WebRTC audio call on the SAME peer connection. Media is
// encrypted by WebRTC's built-in DTLS-SRTP, so it reuses the existing E2EE link.
let localStream=null,micMuted=false,callActive=false,callStart=0,callTimerId=null,callStarting=false,callGen=0,reconnectCall=false;
// Native WASAPI loopback capture with echo cancellation (subtracts Pair's voice).
let screenNative=false,screenRefCtx=null,screenRefNode=null,screenOutCtx=null,screenOutNode=null,screenOutDest=null,screenCleanBuf=null,screenCleanWP=0,screenCleanRP=0,screenCleanAvail=0,screenCaptureCleanup=null;
// Direct handle to the audio transceiver created in setupPeer, so startCall can
// always reuse it (never add a second m-line). Nulled on disconnect/teardown.
let audioTransceiver=null;
// Keep the interface fully usable while this build is being tested without a
// second device. Network-only actions stay local and are clearly labelled.
const LOCAL_TEST_MODE=true;
// Per-connection sound flags so the chimes don't double/triple: chat+files both
// report "connected", and connection-loss/voice-leave can each fire a leave tone.
let connectSoundDone=false,friendLeftNotified=false,friendInCall=false,friendPresenceTimer=null,selfInCall=false,selfPresenceTimer=null;
let screenTransceiver=null,screenActive=false,screenStream=null,screenGen=0,screenSenders=[],screenStatsTimer=null,screenStatsLast=null,remoteScreenExpected=false;
const callBtn=$('#callBtn'),muteBtn=$('#muteBtn'),volumeSlider=$('#volumeSlider'),volumeValue=$('#volumeValue'),callStatus=$('#callStatus'),callTimerEl=$('#callTimer'),remoteAudio=$('#remoteAudio'),connectCard=$('#connectCard'),addFriendBtn=$('#addFriend'),panelBackdrop=$('#panelBackdrop'),profileBtn=$('#profileBtn'),profileInput=$('#profileInput'),profileAdjust=$('#profileAdjust'),profileEditor=$('#profileEditor'),profileZoom=$('#profileZoom'),profileX=$('#profileX'),profileY=$('#profileY'),profileDone=$('#profileDone'),friendAvatar=$('#friendAvatar'),voicePanel=$('#voicePanel'),settingsPanel=$('#settingsPanel'),settingsAvatar=$('#settingsAvatar'),settingsChangePhoto=$('#settingsChangePhoto'),settingsAdjustPhoto=$('#settingsAdjustPhoto'),settingsRemovePhoto=$('#settingsRemovePhoto'),displayNameInput=$('#displayName'),yourNameEl=$('#yourName'),friendNameEl=$('#friendName'),inputDevice=$('#inputDevice'),outputDevice=$('#outputDevice'),voiceProcessing=$('#voiceProcessing'),voiceInputMode=$('#voiceInputMode'),pushToTalkSettings=$('#pushToTalkSettings'),pushToTalkKeyButton=$('#pushToTalkKey'),pushToTalkDelayInput=$('#pushToTalkDelay'),pushToTalkDelayValue=$('#pushToTalkDelayValue'),deviceHint=$('#deviceHint'),testMicrophone=$('#testMicrophone'),reduceMotion=$('#reduceMotion'),soundEffects=$('#soundEffects'),shareProfile=$('#shareProfile'),rememberInvite=$('#rememberInvite'),hardwareAcceleration=$('#hardwareAcceleration'),hardwareHint=$('#hardwareHint');
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
function setFriendPresence(on,{animate=true,sound=true}={}){
  const wasPresent=friendInCall;friendInCall=on;const dot=participantFriend.querySelector('.indicator');if(dot)dot.classList.toggle('on',on);
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
  const wasPresent=selfInCall;selfInCall=on;const dot=participantYou.querySelector('.indicator');if(dot)dot.classList.toggle('on',on);
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
function setCallVolume(percent,persist=true){const value=Math.max(0,Math.min(100,Number(percent)||0))/100;volumeSlider.value=String(Math.round(value*100));volumeValue.textContent=Math.round(value*100)+'%';try{const ctx=sfxCtx();if(ctx&&ctx.audioGain)ctx.audioGain.gain.setValueAtTime(value,ctx.currentTime)}catch{};try{remoteAudio.volume=0;remoteAudio.muted=false}catch{};if(persist)ssSet('volume',String(value));}
// Separate WebSocket used to relay file bytes (E2EE) between peers. Reuses the
// same signaling host/room, so no extra port forwarding. Binary frames are
// relayed verbatim; this saturates a LAN far better than WebRTC SCTP.
let streamWs=null,streamRoom=null,streamServer=null;
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
// Send over whichever file bus is active, applying backpressure so we don't
// overflow the socket's send buffer. The relay socket uses bufferedAmount; the
// WebRTC channel uses bufferedAmount + the bufferedamountlow event.
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
let deriveGen=0;async function derive(local,remote){const gen=++deriveGen;const bits=await crypto.subtle.deriveBits({name:'ECDH',public:await importPub(remote)},local.privateKey,256);const hash=await crypto.subtle.digest('SHA-256',bits);const code=[...new Uint8Array(hash)].slice(0,12).map(b=>b.toString(16).padStart(2,'0')).join('').match(/.{1,4}/g).join('-');$('#fingerprint').textContent='Security code: '+code;if(gen!==deriveGen)return false;const confirmed=window.confirm('Security check: compare this code with your friend over voice or another trusted channel:\n\n'+code+'\n\nOnly click OK if both codes match.');if(!confirmed||gen!==deriveGen){sharedKey=null;return false}const key=await crypto.subtle.importKey('raw',bits,{name:'AES-GCM'},false,['encrypt','decrypt']);if(gen===deriveGen){sharedKey=key;return true}return false;}
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
function addMessage(text,mine=false,gif=null){
  $('.empty')?.remove();
  const el=document.createElement('div');el.className='message '+(mine?'mine':'');
  const isEmoji=/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D\u20E3]+$/u.test(text.trim());
  const source=mine?profileBtn:friendAvatar,avatar=document.createElement('span'),name=mine?profileName:friendName;
  avatar.className='avatar message-avatar';avatar.classList.toggle('has-image',source.classList.contains('has-image'));avatar.style.backgroundImage=source.style.backgroundImage;avatar.style.backgroundSize=source.style.backgroundSize;avatar.style.backgroundPositionX=source.style.backgroundPositionX;avatar.style.backgroundPositionY=source.style.backgroundPositionY;avatar.style.setProperty('--avatar-hue',source.style.getPropertyValue('--avatar-hue'));const letter=document.createElement('span');letter.className='avatar-letter';letter.textContent=name.slice(0,1).toUpperCase()||'?';avatar.append(letter);
  const content=document.createElement('div');content.className='message-content';
  const header=document.createElement('div');header.className='message-header';const sender=document.createElement('strong');sender.textContent=name;const time=document.createElement('time');time.textContent=new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});header.append(sender,time);
  const bubble=document.createElement('div');bubble.className='bubble'+(isEmoji?' emoji-only':'');bubble.innerHTML=renderContent(text);if(!text)bubble.hidden=true;
  content.append(header,bubble);
  if(gif?.url){const attachment=document.createElement('div');attachment.className='gif-attachment-message';const link=document.createElement('a');link.href=gif.url;link.target='_blank';link.rel='noopener noreferrer';const image=document.createElement('img');image.src=gif.url;image.alt='GIF attachment';image.loading='lazy';image.referrerPolicy='no-referrer';link.append(image);attachment.append(link);if(!mine){const id=gif.url;const star=document.createElement('button');star.type='button';star.className='gif-message-favorite'+(getFavs().some(f=>f.id===id)?' on':'');star.textContent=star.classList.contains('on')?'★':'☆';star.title=star.classList.contains('on')?'Remove from favorites':'Save GIF';star.onclick=()=>{const on=toggleFav(id,gif.url,gif.thumb||gif.url,{id,url:gif.url,thumb:gif.thumb||gif.url,type:'gifs'});star.classList.toggle('on',on);star.textContent=on?'★':'☆';star.title=on?'Remove from favorites':'Save GIF'};attachment.append(star)}content.append(attachment)}
  el.append(avatar,content);messages.append(el);messages.scrollTop=messages.scrollHeight;
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
        friendLeftNotified=false;setParticipant(participantFriend,true);logCallEvent('Friend joined the call');playSound('ring');setupPermanentAudioSink();}else if(o.t==='call-end'){setParticipant(participantFriend,false);if(!friendLeftNotified){friendLeftNotified=true;playSound('leave')}logCallEvent('Friend left the call');callStatus.textContent='Friend left the call';callStatus.className='call-status';/* Keep this person's microphone and call state alive. The connection is a room, not a one-shot call: only the peer that pressed End Call leaves. */}else if(o.t==='screen-start'){remoteScreenExpected=true;logCallEvent('Friend started screen sharing');remoteScreen.hidden=false;screenStatus.textContent='Friend sharing';}else if(o.t==='screen-end'){remoteScreenExpected=false;logCallEvent('Friend stopped screen sharing');remoteScreen.srcObject=null;remoteScreen.hidden=true;screenStatus.textContent='Not sharing';}else if(o.t==='reneg-offer'&&typeof o.sdp==='string'&&pc){if(renegPending){renegotiating++;renegPending=false}await pc.setRemoteDescription({type:'offer',sdp:o.sdp});const a=await pc.createAnswer();await pc.setLocalDescription({type:'answer',sdp:patchSdp(a.sdp)});await waitIce();send({t:'reneg-answer',sdp:pc.localDescription.sdp});}else if(o.t==='reneg-answer'&&typeof o.sdp==='string'&&pc){await pc.setRemoteDescription({type:'answer',sdp:o.sdp});}}catch(e){console.warn('direct renegotiation error',e)}}}if(files){files.binaryType='arraybuffer';files.bufferedAmountLowThreshold=Math.max(1*1024*1024,SEND_WINDOW-4*1024*1024);   files.onmessage=e=>{receiveQueue=receiveQueue.then(()=>onFileFrame(e)).catch(()=>{})};files.onopen=()=>setStatus('Connected directly',true)}if(streamWs){streamWs.binaryType='arraybuffer';try{streamWs.bufferedAmountLowThreshold=SEND_WINDOW*0.75}catch{};streamWs.onmessage=e=>onStreamFrame(e);}}
// Add name handling once per data channel without disturbing the encrypted
// message/profile handler above. This also covers the channel received by the
// answering peer through `ondatachannel`.
const originalWire=wire,profileNameChannels=new WeakSet();
wire=function(){if(chat&&!profileNameChannels.has(chat)){chat.addEventListener('message',handleProfileNameMessage);profileNameChannels.add(chat)}return originalWire()}
// Pick the fast relay socket if available, otherwise the WebRTC data channel.
function fileBus(){return (streamWs&&streamWs.readyState===WebSocket.OPEN)?streamWs:(files&&files.readyState==='open'?files:null)}

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
  let gestureGuard=false;
  pc.ontrack=e=>{logCallEvent('Diag: ontrack kind='+e.track.kind);try{const stream=e.streams[0]||new MediaStream([e.track]);const isScreenStream=stream===remoteScreen.srcObject||stream.getVideoTracks().length>0||(remoteScreenExpected&&e.track.kind==='audio');if(e.track.kind==='audio'&&isScreenStream){remoteScreenExpected=false;remoteScreen.hidden=false;if(!remoteScreen.srcObject)remoteScreen.srcObject=stream;logCallEvent('Screen audio received');const play=()=>{const p=remoteScreen.play();if(p?.catch)p.catch(()=>{})};play();if(!gestureGuard){gestureGuard=true;document.addEventListener('pointerdown',play,{once:true});document.addEventListener('keydown',play,{once:true})}return}if(e.track.kind==='audio'){logCallEvent('Audio track received from friend');if(remoteAudio.srcObject){try{remoteAudio.srcObject.getAudioTracks().forEach(t=>t.onended=null)}catch{}}if(remoteAudio.srcObject&&remoteAudio.srcObject!==stream){try{remoteAudio.srcObject.addTrack(e.track)}catch{}}else remoteAudio.srcObject=stream;remoteAudio.muted=false;remoteAudio.volume=0;e.track.onended=()=>{if(!friendLeftNotified){friendLeftNotified=true;playSound('leave')}logCallEvent('Friend left the call');callStatus.textContent='Friend left the call';callStatus.className='call-status'};const play=()=>{const p=remoteAudio.play();if(p?.catch)p.catch(()=>{})};play();setupPermanentAudioSink();if(!gestureGuard){gestureGuard=true;document.addEventListener('pointerdown',()=>{play();setupPermanentAudioSink()},{once:true});document.addEventListener('keydown',()=>{play();setupPermanentAudioSink()},{once:true})}}else if(e.track.kind==='video'){remoteScreenExpected=false;remoteScreen.hidden=false;try{remoteScreen.srcObject=stream;remoteScreen.play()}catch{};e.track.onended=()=>{remoteScreen.srcObject=null;remoteScreen.hidden=true}}}catch{}};
}
async function waitIce(){if(pc.iceGatheringState==='complete')return;await new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;pc?.removeEventListener('icegatheringstatechange',f);clearTimeout(timeout);resolve()};const f=()=>{if(pc?.iceGatheringState==='complete')finish()};const timeout=setTimeout(finish,5000);pc.addEventListener('icegatheringstatechange',f)})}
function patchOpusSdp(sdp){return sdp.replace(/a=fmtp:111[^\r\n]*/g,m=>{if(!m.includes('maxaveragebitrate'))m+='; maxaveragebitrate=256000';else m=m.replace(/maxaveragebitrate=\d+/,'maxaveragebitrate=256000');if(!m.includes('maxplaybackrate'))m+='; maxplaybackrate=48000';if(!m.includes('useinbandfec'))m+='; useinbandfec=1';if(!m.includes('usedtx'))m+='; usedtx=0';if(!m.includes('stereo'))m+='; stereo=1';else m=m.replace(/stereo=[01]/,'stereo=1');if(!m.includes('sprop-stereo'))m+='; sprop-stereo=1';else m=m.replace(/sprop-stereo=[01]/,'sprop-stereo=1');return m})}
// Sender parameters are the primary limiter. This SDP fallback keeps browsers
// that ignore those parameters from silently collapsing a high-motion share to
// the old 16 Mbps ceiling.
function patchVideoSdp(sdp){
  sdp=sdp.replace(/\r\n/g,'\n');
  return sdp.replace(/^m=video .*\n(?:[^m].*\n)*/gm,m=>{
    let section=m;
    section=section.replace(/\nb=AS:\d+/g,'');
    section=section.replace(/\na=x-google-(?:min|max)-bitrate:\d+/g,'');
    return section+'a=x-google-max-bitrate:140000\n';
  });
}
function patchSdp(sdp){return patchVideoSdp(patchOpusSdp(sdp))}
$('#createOffer').onclick=async()=>{try{if(pc||signaling)disconnectRoom();role='offer';signalIn.value='';ssSet('savedInviteCode',null);setOutgoingCode('');processSignal.textContent='Finish connection';setupPeer();const kp=await keyPair();pc._kp=kp;setupChannels();const o=await pc.createOffer();await pc.setLocalDescription({type:'offer',sdp:patchSdp(o.sdp)});await waitIce();setOutgoingCode(await makeSignal({type:'offer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}));pairHint.textContent='Invite ready. Copy it, send it to your friend, then paste their reply in step 2.'}catch(e){pairHint.textContent='Could not create invite: '+(e?.message||e)}};
processSignal.onclick=async()=>{try{const remote=await cleanSignal(signalIn.value);if(role==='offer'){if(remote.type!=='answer')throw new Error('Paste the reply your friend created, not another invite');await pc.setRemoteDescription({type:'answer',sdp:remote.sdp});if(!await derive(pc._kp,remote.pub))throw new Error('Security code was not confirmed');pairHint.textContent='Connecting directly…'}else if(!role){if(remote.type!=='offer')throw new Error('Paste an invite first, then create its reply');role='answer';setOutgoingCode('');setupPeer();const kp=await keyPair();pc._kp=kp;await pc.setRemoteDescription({type:'offer',sdp:remote.sdp});if(!await derive(kp,remote.pub))throw new Error('Security code was not confirmed');const a=await pc.createAnswer();await pc.setLocalDescription({type:'answer',sdp:patchSdp(a.sdp)});await waitIce();setOutgoingCode(await makeSignal({type:'answer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}));pairHint.textContent='Reply ready. Copy it and send it back to the person who invited you.';processSignal.textContent='Reply ready'}else pairHint.textContent='Your reply is already ready. Copy it and send it back to your friend.'}catch(e){pairHint.textContent='Could not continue pairing: '+(e?.message||e)}};
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
// Dedicated handler for the relay socket. Processes chunk frames immediately
// and independently of the WebRTC control channel, so the Accept-card click or
// any control handling can never block bulk reception.
function onStreamFrame(e){
  if(!(e.data instanceof ArrayBuffer))return;
  enqueueChunk(new Uint8Array(e.data));
}
// Control + (fallback) chunk handler for the WebRTC data channel.
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
let screenCursor='always',screenContentHint='motion',screenBitrateMbps=20,screenCodec='auto',shareResolution=1080,shareFrameRate=30;
function openSettingsTab(name){document.querySelectorAll('.settings-tab').forEach(tab=>{const active=tab.dataset.settingsTab===name;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active))});document.querySelectorAll('.settings-page').forEach(page=>{const active=page.dataset.settingsPage===name;page.classList.toggle('active',active);page.hidden=!active})}
function addScreenShareSettings(){
  const tab=document.createElement('button');tab.type='button';tab.className='settings-tab';tab.dataset.settingsTab='screen';tab.setAttribute('role','tab');tab.setAttribute('aria-selected','false');tab.textContent='Screen sharing';
  const page=document.createElement('section');page.className='settings-section settings-page';page.dataset.settingsPage='screen';page.setAttribute('role','tabpanel');page.hidden=true;
  page.innerHTML='<div><h3>Screen sharing</h3><p>Set your preferred capture behavior before starting a share. Changes apply to your next share.</p></div><label class="settings-field"><span>Maximum video bitrate <output id="screenBitrateValue">20 Mbps</output></span><input id="screenBitrateSetting" type="range" min="2" max="120" value="20" step="1" /></label><label class="settings-field"><span>Video codec</span><select id="screenCodecSetting"><option value="auto">Automatic (recommended)</option><option value="H264">H.264</option><option value="H265">H.265 / HEVC</option><option value="VP9">VP9</option><option value="AV1">AV1</option><option value="VP8">VP8</option></select></label><label class="settings-field"><span>Content optimization</span><select id="screenContentHintSetting"><option value="motion">Motion — games and video</option><option value="detail">Detail — text and documents</option></select></label><label class="settings-field"><span>Cursor</span><select id="screenCursorSetting"><option value="always">Always show</option><option value="motion">Show while moving</option><option value="never">Hide cursor</option></select></label><p class="settings-hint">Codec support depends on both devices. Automatic is the most compatible choice.</p>';
  document.querySelector('.settings-tabs').append(tab);document.querySelector('.settings-pages').append(page);tab.onclick=()=>openSettingsTab('screen');
  const bitrate=$('#screenBitrateSetting'),bitrateValue=$('#screenBitrateValue'),codec=$('#screenCodecSetting'),contentHint=$('#screenContentHintSetting'),cursor=$('#screenCursorSetting');
  const updateBitrate=()=>{screenBitrateMbps=Math.max(2,Math.min(120,Number(bitrate.value)||20));bitrate.style.setProperty('--range-fill',((screenBitrateMbps-2)/118*100)+'%');bitrateValue.textContent=screenBitrateMbps+' Mbps';ssSet('screenBitrate',String(screenBitrateMbps))};
  bitrate.oninput=updateBitrate;codec.onchange=()=>{screenCodec=['auto','H264','H265','VP9','AV1','VP8'].includes(codec.value)?codec.value:'auto';ssSet('screenCodec',screenCodec)};contentHint.onchange=()=>{screenContentHint=contentHint.value==='detail'?'detail':'motion';ssSet('screenContentHint',screenContentHint)};cursor.onchange=()=>{screenCursor=['always','motion','never'].includes(cursor.value)?cursor.value:'always';ssSet('screenCursor',screenCursor)};
  return async()=>{const b=Number(await ss('screenBitrate'));screenBitrateMbps=Number.isFinite(b)&&b>=2&&b<=120?b:20;bitrate.value=String(screenBitrateMbps);bitrate.style.setProperty('--range-fill',((screenBitrateMbps-2)/118*100)+'%');bitrateValue.textContent=screenBitrateMbps+' Mbps';const v=await ss('screenCodec');screenCodec=['auto','H264','H265','VP9','AV1','VP8'].includes(v)?v:'auto';codec.value=screenCodec;const c=await ss('screenCursor');screenCursor=['always','motion','never'].includes(c)?c:'always';cursor.value=screenCursor;const h=await ss('screenContentHint');screenContentHint=h==='detail'?'detail':'motion';contentHint.value=screenContentHint};
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
reduceMotion.onchange=()=>{document.documentElement.dataset.reduceMotion=String(reduceMotion.checked);ssSet('reduceMotion',reduceMotion.checked?'on':'off')};soundEffects.onchange=()=>{soundEnabled=soundEffects.checked;ssSet('soundEffects',soundEnabled?'on':'off')};shareProfile.onchange=()=>{profileSharing=shareProfile.checked;ssSet('shareProfile',profileSharing?'on':'off');announceProfile()};rememberInvite.onchange=()=>{rememberInviteCode=rememberInvite.checked;ssSet('rememberInvite',rememberInviteCode?'on':'off');if(!rememberInviteCode)ssSet('savedInviteCode',null)};$('#clearSavedInvite').onclick=()=>{signalIn.value='';ssSet('savedInviteCode',null);pairHint.textContent='Saved pairing code cleared from this device.'};hardwareAcceleration.onchange=()=>{const enabled=hardwareAcceleration.checked;ssSet('hardwareAcceleration',enabled?'on':'off');hardwareHint.textContent='Restart Pair to '+(enabled?'enable':'disable')+' hardware acceleration.'};$('#restartPair').onclick=()=>{if(window.pairEnv?.relaunch)window.pairEnv.relaunch();else hardwareHint.textContent='Close and reopen Pair to apply this setting.'};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&(!settingsPanel.hidden||connectCard.open))closePanels()});
function validProfileData(data){return typeof data==='string'&&data.length<=MAX_PROFILE_DATA&&/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(data)}
function setAvatar(el,data){if(!el)return;const safe=validProfileData(data)?data:'';el.classList.toggle('has-image',!!safe);el.style.backgroundImage=safe?'url("'+safe.replace(/"/g,'%22')+'")':'';}
function normalizeFrame(frame){return {zoom:Math.max(40,Math.min(180,Number(frame?.zoom)||100)),x:Math.max(0,Math.min(100,Number(frame?.x??50))),y:Math.max(0,Math.min(100,Number(frame?.y??50)))}}
function validProfileIdentity(value){return typeof value==='string'&&/^[a-z0-9]{12,32}$/i.test(value)}
function normalizeProfileName(value,fallback){if(typeof value!=='string')return fallback;const name=value.replace(/[\u0000-\u001f\u007f]/g,'').replace(/\s+/g,' ').trim().slice(0,32);return name||fallback}
function renderParticipantNames(){yourNameEl.textContent=profileName;friendNameEl.textContent=friendName;displayNameInput.value=profileName}
function updateProfileName(value,{persist=true,share=true}={}){profileName=normalizeProfileName(value,'You');renderParticipantNames();if(persist)ssSet('profileName',profileName);if(share)announceProfile()}
function handleProfileNameMessage(event){try{if(typeof event.data!=='string')return;const message=JSON.parse(event.data);if(message?.t!=='profile-name')return;friendName=normalizeProfileName(message.v,'Friend');renderParticipantNames()}catch{}}
function makeProfileIdentity(){const bytes=crypto.getRandomValues(new Uint8Array(9));return [...bytes].map(v=>v.toString(36).padStart(2,'0')).join('')}
function avatarHue(identity){let hash=0;for(const ch of identity)hash=(hash*31+ch.charCodeAt(0))>>>0;return hash%360}
function setAvatarIdentity(el,identity){if(!el)return;const safe=validProfileIdentity(identity)?identity:'';if(safe)el.style.setProperty('--avatar-hue',String(avatarHue(safe)));else el.style.removeProperty('--avatar-hue');}
function setAvatarFrame(el,frame){if(!el)return;const f=normalizeFrame(frame);el.style.backgroundSize=f.zoom+'% auto';el.style.backgroundPositionX=f.x+'%';el.style.backgroundPositionY=f.y+'%';}
function renderProfile(){[profileBtn,settingsAvatar].forEach(el=>{setAvatar(el,profileAvatar);setAvatarFrame(el,profileFrame);setAvatarIdentity(el,profileIdentity)});renderParticipantNames();const hasPhoto=!!profileAvatar;profileAdjust.hidden=!hasPhoto;settingsAdjustPhoto.hidden=!hasPhoto;settingsRemovePhoto.hidden=!hasPhoto;}
function announceProfile(){if(profileIdentity){send({t:'profile',v:{image:profileSharing?profileAvatar:'',frame:profileFrame,identity:profileIdentity}});send({t:'profile-name',v:profileSharing?profileName:'Friend'})}}
async function readProfileData(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=()=>reject(new Error('Could not read image'));r.readAsDataURL(blob)})}
async function resizeProfile(file){if(file.type==='image/gif'){if(file.size>5*1024*1024)throw new Error('Choose a GIF smaller than 5 MB');const data=await readProfileData(file);if(!validProfileData(data))throw new Error('Choose a valid GIF smaller than 5 MB');return data}const bitmap=await createImageBitmap(file);const size=480,scale=Math.min(size/bitmap.width,size/bitmap.height,1);const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close?.();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.72));if(!blob)throw new Error('Could not read image');const data=await readProfileData(blob);if(!validProfileData(data))throw new Error('Choose a smaller image');return data;}
function updateProfileFrame(sendUpdate=false){profileFrame=normalizeFrame({zoom:profileZoom.value,x:profileX.value,y:profileY.value});renderProfile();ssSet('profileFrame',JSON.stringify(profileFrame));if(sendUpdate)announceProfile()}
function openSettings(showPhotoEditor=false){connectCard.open=false;settingsPanel.hidden=false;document.body.classList.add('settings-open');syncPanelBackdrop();if(showPhotoEditor){openSettingsTab('profile');profileEditor.hidden=false}}
$('#openSettings').onclick=()=>openSettings();$('#closeSettings').onclick=closePanels;
profileBtn.onclick=()=>openSettings(true);profileAdjust.onclick=()=>openSettings(true);settingsChangePhoto.onclick=()=>profileInput.click();settingsAdjustPhoto.onclick=()=>{profileEditor.hidden=!profileEditor.hidden};settingsRemovePhoto.onclick=async()=>{profileAvatar='';renderProfile();profileEditor.hidden=true;await ssSet('profileAvatar',null);await ssSet('profilePhotoMode','none');announceProfile()};profileDone.onclick=()=>{profileEditor.hidden=true;updateProfileFrame(true)};[profileZoom,profileX,profileY].forEach(input=>input.oninput=()=>updateProfileFrame(false));[profileZoom,profileX,profileY].forEach(input=>input.onchange=()=>updateProfileFrame(true));profileInput.onchange=async()=>{const file=profileInput.files?.[0];profileInput.value='';if(!file)return;try{profileAvatar=await resizeProfile(file);renderProfile();await ssSet('profileAvatar',profileAvatar);await ssSet('profilePhotoMode','custom');announceProfile()}catch(e){alert(e.message||'Could not set profile photo')}};
(async()=>{updateProfileName(await ss('profileName'),{persist:false,share:false})})();displayNameInput.onchange=()=>updateProfileName(displayNameInput.value);
(async()=>{inputDeviceId=(await ss('inputDevice'))||'default';outputDeviceId=(await ss('outputDevice'))||'default';voiceProcessingEnabled=(await ss('voiceProcessing'))==='on';voiceInputModeValue=(await ss('voiceInputMode'))==='ptt'?'ptt':'voice';const savedPttKey=await ss('pushToTalkKey');pushToTalkKey=typeof savedPttKey==='string'&&savedPttKey.length<32?savedPttKey:'Space';const savedPttDelay=Number(await ss('pushToTalkDelay'));pushToTalkDelay=Number.isFinite(savedPttDelay)?Math.max(0,Math.min(1000,savedPttDelay)):0;soundEnabled=(await ss('soundEffects'))!=='off';profileSharing=(await ss('shareProfile'))!=='off';rememberInviteCode=(await ss('rememberInvite'))!=='off';const motion=(await ss('reduceMotion'))==='on';const hardware=(await ss('hardwareAcceleration'))!=='off';if(!rememberInviteCode){signalIn.value='';ssSet('savedInviteCode',null)}voiceProcessing.checked=voiceProcessingEnabled;updatePushToTalkUI();soundEffects.checked=soundEnabled;shareProfile.checked=profileSharing;rememberInvite.checked=rememberInviteCode;reduceMotion.checked=motion;hardwareAcceleration.checked=hardware;document.documentElement.dataset.reduceMotion=String(motion);hardwareHint.textContent='Hardware acceleration is '+(hardware?'enabled':'disabled')+' for the next start.';await restoreScreenShareSettings();await refreshAudioDevices();await applyOutputDevice()})();signalIn.addEventListener('input',()=>{if(!rememberInviteCode)ssSet('savedInviteCode',null)});
(async()=>{const savedServer=await ss('signalServer');const savedRoom=await ss('roomCode');const savedInvite=await ss('savedInviteCode');if(savedServer)$('#signalServer').value=savedServer;if(savedRoom)$('#roomCode').value=savedRoom;if(typeof savedInvite==='string'&&savedInvite.length<=MAX_SIGNAL_SIZE)signalIn.value=savedInvite;['signalServer','roomCode'].forEach(id=>$('#'+id).addEventListener('input',()=>ssSet(id==='signalServer'?'signalServer':'roomCode',$('#'+id).value.trim())));signalIn.addEventListener('input',()=>ssSet('savedInviteCode',signalIn.value.trim()));const savedVol=await ss('volume');if(savedVol!==null){const v=parseFloat(savedVol);if(v>=0&&v<=1)setCallVolume(Math.round(v*100),false)}const savedFrame=await ss('profileFrame');try{if(savedFrame)profileFrame=normalizeFrame(JSON.parse(savedFrame))}catch{};profileZoom.value=profileFrame.zoom;profileX.value=profileFrame.x;profileY.value=profileFrame.y;const savedAvatar=await ss('profileAvatar');if(validProfileData(savedAvatar)){profileAvatar=savedAvatar;renderProfile();announceProfile()}})();
// Every installation gets a stable generated look until the owner chooses a
// photo. The compact identity is only used to derive the avatar color.
(async()=>{const savedIdentity=await ss('profileIdentity');profileIdentity=validProfileIdentity(savedIdentity)?savedIdentity:makeProfileIdentity();renderProfile();if(profileIdentity!==savedIdentity)ssSet('profileIdentity',profileIdentity)})();
// On a fresh install, use the person's OS account picture when it is available.
// This remains local until they pair, and choosing a photo in Pair still wins.
(async()=>{if(!window.pairEnv?.getSystemAvatar)return;await new Promise(resolve=>setTimeout(resolve,0));if(profileAvatar||await ss('profilePhotoMode')==='none')return;try{const avatar=await window.pairEnv.getSystemAvatar();if(profileAvatar||!validProfileData(avatar))return;profileAvatar=avatar;renderProfile();await ssSet('profileAvatar',profileAvatar);await ssSet('profilePhotoMode','system');announceProfile()}catch{}})();
// Auto-update pulls latest.json directly from GitHub (configured in updater.js),
  // independent of the signaling server. No action needed here.

let signaling;
function secureSignalAddress(address){try{const u=new URL(address);const loopback=['localhost','127.0.0.1','[::1]','::1'].includes(u.hostname);return u.protocol==='wss:'||(u.protocol==='ws:'&&loopback)?u.href:null}catch{return null}}
async function automaticPair(kind){
  // Tear down any prior session so a second Host/Join click (or host→leave→host)
  // doesn't leak an old pc/signaling whose handlers fire stale signals.
  reconnectCall=callActive;if(pc||signaling)disconnectRoom();
  role=kind; const address=secureSignalAddress($('#signalServer').value.trim()); const room=$('#roomCode').value.trim();
  if(!address)return pairHint.textContent='Use wss:// for remote signaling (ws:// is allowed only on localhost), or use direct pairing instead.';
  if(room.length<16)return pairHint.textContent='Use a room code with at least 16 characters.';
  pairHint.textContent='Connecting to signaling server…'; signaling=new WebSocket(address);
  signaling.onopen=()=>{try{signaling.send(JSON.stringify({type:'join',room}))}catch{}pairHint.textContent='Waiting for your friend in room '+room.toUpperCase()+'…'};
  signaling.onerror=()=>pairHint.textContent='Could not reach the signaling server. Check the address and firewall.';
  signaling.onmessage=async event=>{try{const message=JSON.parse(event.data);
    if(message.type==='full'){pairHint.textContent='That room already has two people.';return}
    if(message.type==='peer-ready'&&role==='host'){
      reconnectCall=callActive;setupPeer();const kp=await keyPair();if(!pc)return;pc._kp=kp;setupChannels();
      const offer=await pc.createOffer();if(!pc)return;await pc.setLocalDescription({type:'offer',sdp:patchSdp(offer.sdp)});if(!pc)return;await waitIce();if(!signaling)return;
      logCallEvent('Diag: offer has m=audio=' + (pc.localDescription.sdp.includes('m=audio')?'yes':'NO'));
      signaling.send(JSON.stringify({type:'signal',payload:{kind:'offer',sdp:pc.localDescription.sdp,pub:await exportPub(kp.publicKey)}}));
      openStreamRelay(address,room);pairHint.textContent='Offer sent. Connecting…';
      // If the friend never answers (wrong role, different room, or an old build
      // without TURN), don't hang silently — tell them what to check.
      setTimeout(()=>{if(pc&&pc.connectionState!=='connected'){pairHint.textContent='No answer from your friend after 20s. Make sure exactly ONE of you clicked Host and the other clicked Join, you are in the SAME room code, and both are on the latest version (v1.0.0+ with TURN).'}},20000)
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
        openStreamRelay(address,room);pairHint.textContent='Answer sent. Connecting…'
      }else if(remote.kind==='answer'&&role==='host'){
        logCallEvent('Diag: before setRD(answer) transceivers='+pc.getTransceivers().length+' audioTr='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio')?'ok:dir='+(pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio').direction):'null'));
        await pc.setRemoteDescription({type:'answer',sdp:remote.sdp});if(!pc)return;if(!await derive(pc._kp,remote.pub)){disconnectRoom();pairHint.textContent='Security code was not confirmed.';return}
        logCallEvent('Diag: after setRD(answer)');
        const matched=pc.getTransceivers().find(t=>t.receiver.track?.kind==='audio'&&t.mid);if(matched)audioTransceiver=matched;
        const cd=matched?matched.currentDirection:'none';
        logCallEvent('Diag: audio currentDir='+cd);
        // If the friend's answer didn't include an audio sender, startCall will
        // add a transceiver and renegotiate instead of relying on the unmatched one.
        openStreamRelay(address,room);pairHint.textContent='Secure connection established.'
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
// Open the separate relay socket used to move file bytes. Same host + room as
// the signaling socket; the server relays binary frames to the other peer.
function openStreamRelay(address,room){streamServer=address;streamRoom=room;try{if(streamWs){try{streamWs.onopen=null;streamWs.onerror=null;streamWs.onmessage=null;streamWs.close()}catch{}}streamWs=new WebSocket(address);streamWs.onopen=()=>{try{streamWs.send(JSON.stringify({type:'join',room:room+':stream'}))}catch{};wire()};streamWs.onerror=()=>{if(!pc||pc.connectionState!=='connected')pairHint.textContent='Stream relay failed — transfers will use WebRTC';};streamWs.onclose=()=>{};}catch{streamWs=null;if(!pc||pc.connectionState!=='connected')pairHint.textContent='Could not open stream relay — transfers will use WebRTC'}}
$('#hostRoom').onclick=()=>automaticPair('host'); $('#joinRoom').onclick=()=>automaticPair('join');
function disconnectRoom(){if(pc&&pc._connectTimer){clearTimeout(pc._connectTimer);pc._connectTimer=null}try{if(chat){chat.onmessage=null;chat.close()}}catch{}try{if(files){files.onmessage=null;files.close()}}catch{}try{if(pc)pc.close()}catch{}if(pc&&pc._silentAudioCtx)try{pc._silentAudioCtx.close()}catch{}pc=chat=files=null;if(signaling){try{signaling.onopen=null;signaling.onerror=null;signaling.onmessage=null;signaling.close()}catch{}signaling=null}if(streamWs){try{streamWs.onopen=null;streamWs.onerror=null;streamWs.onmessage=null;streamWs.onclose=null;streamWs.close()}catch{}streamWs=null}streamServer=streamRoom=null;sharedKey=null;setAvatar(friendAvatar,'');setAvatarIdentity(friendAvatar,'');try{remoteAudio.srcObject=null}catch{};try{if(audioCtx&&audioCtx.audioSink){audioCtx.audioSink.disconnect();delete audioCtx.audioSink}}catch{}try{remoteScreen.srcObject=null}catch{};remoteScreen.hidden=true;screenActive=false;screenStream=null;
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
    try{remoteAudio.muted=false;remoteAudio.play()}catch{}
    setupPermanentAudioSink();
    // endCall/disconnectRoom may have run during a nested await; if pc is gone bail.
    if(!pc){try{sender.replaceTrack(null)}catch{};if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}return}
    callActive=true;callStart=Date.now();callBtn.textContent='End call';callBtn.title='End voice call';callBtn.disabled=false;muteBtn.hidden=false;micMuted=false;muteBtn.textContent='Mute';muteBtn.title='Mute microphone';applyMicTransmission();
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
function endCall(silent){
  if(!silent){setParticipant(participantYou,false);logCallEvent('You left the call')}
  if(screenActive)stopScreenShare(true);
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
  callActive=false;micMuted=false;
  callBtn.textContent='Start call';callBtn.title='Start voice call';muteBtn.hidden=true;volumeSlider.hidden=true;volumeValue.hidden=true;callStatus.textContent='Voice off';callStatus.className='call-status';
  if(!silent){callBtn.disabled=!pc&&!LOCAL_TEST_MODE;playSound('leave');try{send({t:'call-end'})}catch{}}
}
function toggleMute(){
  if(!localStream)return;
  micMuted=!micMuted;
  applyMicTransmission();
  if(micMuted){muteBtn.textContent='Unmute';muteBtn.title='Unmute microphone'}else if(voiceInputModeValue!=='ptt'){muteBtn.textContent='Mute';muteBtn.title='Mute microphone'}
}
callBtn.onclick=()=>{if(callActive)endCall(false);else{try{remoteAudio.muted=false;remoteAudio.play()}catch{};setupPermanentAudioSink();startCall()}};
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
async function renegotiate(){
  if(!pc||(!signaling&&chat?.readyState!=='open'))return;
  const myId=++renegotiating;
  renegPending=true;
  try{
    const offer=await pc.createOffer({iceRestart:false});
    if(!pc||myId!==renegotiating){renegPending=false;return}
    await pc.setLocalDescription({type:'offer',sdp:patchSdp(offer.sdp)});
    if(!pc||myId!==renegotiating){renegPending=false;return}
    await waitIce();
    if(myId!==renegotiating){renegPending=false;return}
    if(signaling)signaling.send(JSON.stringify({type:'signal',payload:{kind:'reneg-offer',sdp:pc.localDescription.sdp}}));
    else if(chat?.readyState==='open')send({t:'reneg-offer',sdp:pc.localDescription.sdp});
    else{renegPending=false;return}
  }catch(e){console.warn('renegotiate error',e)}
  renegPending=false;
}
// JS NLMS echo canceller: reads screen-capture audio + remote voice reference
// from two ScriptProcessors in one AudioContext, subtracts the remote voice
// from the screen audio to prevent echo, outputs a clean MediaStream track.
// The displayed remote audio is part of the OS mix on Windows. Include both
// the voice element and an incoming screen-audio track in the AEC reference so
// either one is removed before our own screen audio is sent back.
function remotePlaybackReference(){
  const tracks=[];
  for(const el of [remoteAudio,remoteScreen]){
    try{for(const t of el.srcObject?.getAudioTracks?.()||[]){if(t.readyState==='live'&&!tracks.includes(t))tracks.push(t)}}catch{}
  }
  return tracks.length?new MediaStream(tracks):null;
}

async function setupNativeScreenCapture(){
  const rawTrack=screenStream?.getAudioTracks()[0];
  console.log('[AEC] rawTrack=',!!rawTrack);
  if(!rawTrack){console.log('[AEC] no raw screen track');return null}
  const refStream=remotePlaybackReference();

  // Path 1: Native WASAPI addon with NLMS echo cancellation
  if(window.pairCapture){
    console.log('[AEC] trying native addon');
    let ctx, dest, addonData=false, aecTimedOut=false;
    try{
      ctx=new AudioContext();
      if(ctx.state==='suspended'){try{await ctx.resume()}catch{}}
      dest=ctx.createMediaStreamDestination();dest.channelCount=1;
      const RS=96000;const cleanBuf=new Float32Array(RS);
      let wp=0,avail=0;
      let cleanCount=0;
      const unsubClean=window.pairCapture.onCleanAudio((buf,frames)=>{
        cleanCount++;
        if(!aecTimedOut){
          addonData=true;
          const arr=new Float32Array(buf);
          for(let i=0;i<arr.length&&avail<RS;i++){cleanBuf[wp]=arr[i];wp=(wp+1)%RS;avail++}
          if(cleanCount%50===0)console.log('[AEC] clean #'+cleanCount+' frames='+frames+' avail='+avail+' rms='+Math.sqrt(arr.reduce((s,v)=>s+v*v,0)/arr.length).toFixed(5));
        }
      });
      const unsubError=window.pairCapture.onError(msg=>console.warn('[AEC] capture error:',msg));
      window.pairCapture.start();
      let refProc,refSilence,refSource,refCount=0;
      if(refStream&&refStream.getAudioTracks().length){
        console.log('[AEC] ref stream active, tracks:',refStream.getAudioTracks().length,'label:',refStream.getAudioTracks()[0].label);
        refSource=ctx.createMediaStreamSource(refStream);
        // A ScriptProcessor does not consistently receive callbacks unless it
        // has a live path to an AudioNode destination. Keep it inaudible with
        // a zero-gain node, but let it run so the native canceller receives the
        // exact remote audio that is also present in the system loopback.
        refProc=ctx.createScriptProcessor(1024,1,1);
        refSilence=ctx.createGain();refSilence.gain.value=0;
        refProc.onaudioprocess=e=>{
          refCount++;
          const d=e.inputBuffer.getChannelData(0);
          const ab=d.buffer.slice(d.byteOffset,d.byteOffset+d.byteLength);
          window.pairCapture.pushReference(ab);
          if(refCount%50===0)console.log('[AEC] ref push #'+refCount+' samples='+d.length+' rms='+Math.sqrt(d.reduce((s,v)=>s+v*v,0)/d.length).toFixed(5));
        };
        refSource.connect(refProc);refProc.connect(refSilence);refSilence.connect(ctx.destination);
      }else console.warn('[AEC] no ref stream available');
      await new Promise(r=>setTimeout(r,3000));
      if(!addonData){
        console.warn('[AEC] addon no data in 3s, falling back');
        aecTimedOut=true;
        if(unsubClean)unsubClean();if(unsubError)unsubError();
        window.pairCapture.stop();
        if(refProc)try{refProc.disconnect()}catch{}
        if(ctx)try{ctx.close()}catch{}
        ctx=null;
      }else{
        console.log('[AEC] addon producing data, using clean track');
        const B=1024;
        const op=ctx.createScriptProcessor(B,0,1);
        op.onaudioprocess=e=>{
          const out=e.outputBuffer.getChannelData(0);
          if(avail<out.length)return;
          const rp=(wp-avail+RS)%RS;
          for(let i=0;i<out.length;i++)out[i]=cleanBuf[(rp+i)%RS];
          avail-=out.length;
        };
        op.connect(dest);
        screenOutCtx=ctx;screenOutDest=dest;
        screenNative=true;
        const t=dest.stream.getAudioTracks()[0];
        console.log('[AEC] returning clean track=',!!t);
        screenCaptureCleanup=()=>{if(unsubClean)unsubClean();if(unsubError)unsubError();window.pairCapture.stop();try{if(refSource)refSource.disconnect()}catch{};try{if(refProc)refProc.disconnect()}catch{};try{if(refSilence)refSilence.disconnect()}catch{};try{op.disconnect()}catch{}};
        return t;
      }
    }catch(e){
      console.warn('[AEC] addon path error:',e.message);
      if(ctx)try{ctx.close()}catch{}
    }
  }

  // Path 2: JS NLMS echo canceller (subtracts remote voice from loopback)
  console.log('[AEC] trying JS NLMS');
  try{
    const ctx=new AudioContext();
    if(ctx.state==='suspended'){try{await ctx.resume()}catch{}}
    const RS=96000;const refRing=new Float32Array(RS);let refWritten=0,estGain=0.5,bestDly=2048;
    let refProc,refSilence,refSrc,delayEstCnt=0,bypassCount=0,nlmsLogCount=0;
    if(refStream&&refStream.getAudioTracks().length){
      refSrc=ctx.createMediaStreamSource(refStream);
      refProc=ctx.createScriptProcessor(1024,1,1);
      refSilence=ctx.createGain();refSilence.gain.value=0;
      let refCbCount=0;
      refProc.onaudioprocess=e=>{
        refCbCount++;
        const d=e.inputBuffer.getChannelData(0);
        for(let i=0;i<d.length;i++)refRing[(refWritten+i)%RS]=d[i];
        refWritten+=d.length;
        if(refCbCount%30===0)console.log('[AEC] JS ref #'+refCbCount+' written='+refWritten+' rms='+Math.sqrt(d.reduce((s,v)=>s+v*v,0)/d.length).toFixed(5));
      };
      refSrc.connect(refProc);refProc.connect(refSilence);refSilence.connect(ctx.destination);
    }else console.log('[AEC] JS NLMS no ref stream');
    const src=ctx.createMediaStreamSource(new MediaStream([rawTrack]));
    const outP=ctx.createScriptProcessor(1024,1,1);
    const dest=ctx.createMediaStreamDestination();dest.channelCount=1;
    let nlmsActivated=false;
    outP.onaudioprocess=e=>{
      const cap=e.inputBuffer.getChannelData(0);
      const out=e.outputBuffer.getChannelData(0);
      if(refWritten>bestDly+cap.length){
        if(!nlmsActivated){nlmsActivated=true;console.log('[AEC] JS NLMS ACTIVE refWritten='+refWritten+' bestDly='+bestDly);}
        if(++delayEstCnt%30===0){
          let bestCorr=0,bestD=bestDly;
          const minD=480,maxD=7200,n=Math.min(cap.length,256);
          for(let d=minD;d<maxD;d+=4){
            let c=0,nc=0,nr=0;
            for(let i=0;i<n;i++){
              const cv=cap[i],rv=refRing[(refWritten-d+i)%RS];
              c+=cv*rv;nc+=cv*cv;nr+=rv*rv;
            }
            const denom=Math.sqrt(nc*nr);
            if(denom>1e-10&&c/denom>bestCorr){bestCorr=c/denom;bestD=d;}
          }
          if(bestCorr>0.05)bestDly=Math.round((bestDly*3+bestD)/4);
          if(++nlmsLogCount%3===0)console.log('[AEC] JS NLMS gain='+estGain.toFixed(4)+' delay='+bestDly+' corr='+bestCorr.toFixed(3));
        }
        for(let i=0;i<cap.length;i++){
          const r=refRing[(refWritten-bestDly+i)%RS];
          const c=cap[i];
          out[i]=c-estGain*r;
          if(Math.abs(r)>0.001){
            const num=c*r,den=r*r+1e-10;
            estGain=0.998*estGain+0.002*num/den;
            if(estGain<0)estGain=0;
          }
        }
      }else{
        bypassCount++;
        for(let i=0;i<cap.length;i++)out[i]=cap[i];
        if(bypassCount%30===0)console.log('[AEC] JS NLMS BYPASS #'+bypassCount+' refWritten='+refWritten+' need>'+(bestDly+cap.length));
      }
    };
    src.connect(outP);outP.connect(dest);
    screenOutCtx=ctx;screenOutDest=dest;
    const t=dest.stream.getAudioTracks()[0];
    console.log('[AEC] JS NLMS track=',!!t);
    screenCaptureCleanup=()=>{try{src.disconnect()}catch{};try{outP.disconnect()}catch{};if(refSrc)try{refSrc.disconnect()}catch{};if(refProc)try{refProc.disconnect()}catch{};if(refSilence)try{refSilence.disconnect()}catch{}};
    return t;
  }catch(e){
    console.warn('[AEC] JS NLMS failed:',e.message);
  }

  // Never fall back to raw system audio. A friend can join a call after the
  // share begins; forwarding a raw desktop mix would then send Pair's own
  // playback back to them and create an echo loop. Silence is preferable to
  // leaking Pair audio when the clean capture path is unavailable.
  console.warn('[AEC] no clean path available; system audio is disabled to keep Pair audio out of the share');
  return null;
}
function cleanupNativeScreenCapture(){
  screenNative=false;
  if(screenCaptureCleanup){try{screenCaptureCleanup()}catch{};screenCaptureCleanup=null}
  if(screenOutDest){screenOutDest=null}
  if(screenOutCtx){try{screenOutCtx.close()}catch{};screenOutCtx=null}
}
async function linuxShareAudioTrack(){
  const label=await window.pairEnv?.startLinuxShareAudio?.();if(!label)return null;
  for(let attempt=0;attempt<12;attempt++){const devices=await navigator.mediaDevices.enumerateDevices();const device=devices.find(d=>d.kind==='audioinput'&&d.label.includes(label));if(device){const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:device.deviceId},echoCancellation:false,noiseSuppression:false,autoGainControl:false}});return stream.getAudioTracks()[0]||null}await new Promise(resolve=>setTimeout(resolve,150))}
  window.pairEnv?.stopLinuxShareAudio?.();return null;
}
function startScreenStats(sender){
  if(screenStatsTimer)clearInterval(screenStatsTimer);screenStatsLast=null;
  const sample=async()=>{try{if(!screenActive)return;const reports=await sender.getStats();let out;reports.forEach(r=>{if(r.type==='outbound-rtp'&&(r.kind==='video'||r.mediaType==='video')&&!r.isRemote)out=r});if(!out)return;const now=performance.now();let mbps='…';if(screenStatsLast&&now>screenStatsLast.at){mbps=(((out.bytesSent-screenStatsLast.bytes)*8)/(now-screenStatsLast.at)/1000).toFixed(1)}screenStatsLast={bytes:out.bytesSent,at:now};const fps=Math.round(out.framesPerSecond||0),w=out.frameWidth||0,h=out.frameHeight||0;const status='Sharing'+(w&&h?' · '+w+'×'+h:'')+(fps?' · '+fps+'fps':'')+(mbps!=='…'?' · '+mbps+' Mbps':'');screenStatus.textContent=status;screenBtn.title=status}catch{}};
  sample();screenStatsTimer=setInterval(sample,2000);
}
async function startScreenShare(){
  if(screenActive||!pc)return;
  const gen=++screenGen;
  // Show source picker in Electron app (in browser getDisplayMedia shows native picker)
  if(window.pairEnv?.getSources){
    const sources=await window.pairEnv.getSources();
    if(!sources.length||gen!==screenGen){screenStatus.textContent='No sources';return}
    const id=await new Promise(resolve=>{
      const o=document.createElement('div');o.className='screen-source-modal';
      const b=document.createElement('div');b.className='screen-source-dialog';
      b.innerHTML='<h3>Select what to share</h3><div class="share-start-options"><label>Resolution<select id="shareResolution"><option value="720">720p</option><option value="1080" selected>1080p</option><option value="1440">1440p</option><option value="2160">4K</option></select></label><label>Frame rate<select id="shareFrameRate"><option value="30" selected>30 fps</option><option value="60">60 fps</option></select></label><label class="share-audio-option"><input id="shareSystemAudio" type="checkbox" checked /> Share system audio</label></div>';
      const resolution=b.querySelector('#shareResolution'),frameRate=b.querySelector('#shareFrameRate'),audio=b.querySelector('#shareSystemAudio');resolution.value=String(shareResolution);frameRate.value=String(shareFrameRate);audio.checked=screenAudioOn;
      const g=document.createElement('div');g.className='screen-source-grid';
      sources.forEach(s=>{const btn=document.createElement('button');btn.type='button';btn.className='screen-source-option';const img=document.createElement('img');img.src=s.thumbnail;img.alt='';const name=document.createElement('span');name.textContent=s.name;btn.append(img,name);btn.onclick=()=>{shareResolution=Number(resolution.value)||1080;shareFrameRate=Number(frameRate.value)||30;screenAudioOn=audio.checked;resolve(s.id);o.remove()};g.appendChild(btn)});
      const c=document.createElement('button');c.className='screen-source-cancel';c.textContent='Cancel';c.onclick=()=>{resolve(null);o.remove()};
      b.appendChild(g);b.appendChild(c);o.appendChild(b);document.body.appendChild(o);
    });
    if(!id||gen!==screenGen)return;
    window.pairEnv.setPendingSource(id);
  }
  try{
    const heights={720:720,1080:1080,1440:1440,2160:2160},height=heights[shareResolution]||1080,width=Math.round(height*16/9),fps=shareFrameRate===60?60:30;
    const v={width:{ideal:width,max:width},height:{ideal:height,max:height},frameRate:{ideal:fps,max:fps}};
    v.cursor=screenCursor;
    const constraints={video:v};
    constraints.audio=screenAudioOn&&window.pairEnv?.platform!=='linux'?{echoCancellation:true,autoGainControl:false,noiseSuppression:false}:false;
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
    // Audio cleanup can take a few seconds on Windows. Start the video first,
    // then attach the cleaned audio in a second negotiation so clicking Share
    // never appears to hang while Pair protects the call from echo.
    const attachShareAudio=async()=>{let audioTrack=stream.getAudioTracks()[0];if(window.pairEnv?.platform==='linux')audioTrack=await linuxShareAudioTrack();if(!audioTrack)return;if(window.pairEnv?.platform!=='linux')try{const cleanTrack=await setupNativeScreenCapture();if(cleanTrack)audioTrack=cleanTrack}catch(e){console.warn('[AUDIO] canceller exception:',e)}if(gen!==screenGen||!screenActive||!pc||!audioTrack)return;try{screenSenders.push(pc.addTrack(audioTrack,stream));await renegotiate()}catch(e){console.warn('[AUDIO] addTrack failed:',e)}};
    // Prefer codecs that are normally hardware accelerated. AV1 is excellent at
    // low bitrates but its software encoder is a frequent source of high CPU and
    // seconds of latency during desktop capture, so it stays a last fallback.
    try{const tr=pc.getTransceivers().find(t=>t.sender===sender);if(tr){const caps=RTCRtpSender.getCapabilities('video');if(caps){const names=screenCodec==='auto'?['AV1','H265','H264','VP9','VP8']:[screenCodec,'H264','VP9','VP8'];const cs=names.map(name=>caps.codecs.find(c=>c.mimeType===`video/${name}`)).filter(Boolean);if(cs.length)tr.setCodecPreferences(cs)}}}catch(e){console.warn('[VIDEO] codec pref err:',e)}
    try{const p=sender.getParameters();if(p){if(!p.encodings||!p.encodings.length)p.encodings=[{}];const preset=screenPreset.value;const maxBitrate=Math.round(Math.max(2,Math.min(120,screenBitrateMbps))*1000000);p.encodings[0].maxBitrate=maxBitrate;p.encodings[0].maxFramerate=SCREEN_PRESETS[preset]?.frameRate?.max||30;p.degradationPreference=screenContentHint==='detail'?'maintain-resolution':'maintain-framerate';await sender.setParameters(p);console.log('[VIDEO] bitrate='+(maxBitrate/1e6)+'Mbps '+p.degradationPreference)}else console.warn('[VIDEO] no params')}catch(e){console.warn('[VIDEO] setParams err:',e)}
    if(gen!==screenGen||!pc){screenSenders.forEach(s=>{try{pc.removeTrack(s)}catch{}});screenSenders=[];stream.getTracks().forEach(t=>t.stop());return}
    screenActive=true;
    screenPreview.srcObject=stream;screenPreview.hidden=false;try{screenPreview.play()}catch{}
    screenBtn.textContent='Stop sharing';screenBtn.title='Stop screen sharing';screenStatus.textContent='Sharing';
    startScreenStats(sender);
    try{send({t:'screen-start'})}catch{};
    logCallEvent('You started screen sharing');
    track.onended=()=>{if(screenActive)stopScreenShare()};
    await renegotiate();if(gen!==screenGen)return;void attachShareAudio();
  }catch(e){screenStatus.textContent='Share failed';if(e.name!=='NotAllowedError')logCallEvent('Screen share error')}
}
async function stopScreenShare(fromEnd){
  if(!screenActive&&!fromEnd)return;
  screenGen++;
  if(window.pairEnv?.platform==='linux')window.pairEnv.stopLinuxShareAudio?.();
  screenActive=false;
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
screenBtn.onclick=()=>{if(screenActive)stopScreenShare();else if(!pc&&LOCAL_TEST_MODE){screenStatus.textContent='Pair with a friend to start screen sharing';screenStatus.className='screen-status';}else startScreenShare()};
screenPreset.onchange=()=>{if(screenActive){stopScreenShare();startScreenShare()}};
// Screen share audio toggle — on by default, turn off to stop capturing system audio (prevents echo feedback on Windows loopback).
let screenAudioOn=true;
const audioToggleBtn=document.createElement('button');audioToggleBtn.textContent='Audio on';audioToggleBtn.className='audio-toggle is-on';
audioToggleBtn.onclick=()=>{screenAudioOn=!screenAudioOn;audioToggleBtn.textContent=screenAudioOn?'Audio on':'Audio off';audioToggleBtn.classList.toggle('is-on',screenAudioOn)};screenBtn.parentElement.insertBefore(audioToggleBtn,screenStatus);
// Volume slider for the remote screen share audio, shown on right-click.
const screenVolWrap=document.createElement('div');screenVolWrap.className='screen-volume';
const screenVolLabel=document.createElement('span');screenVolLabel.textContent='Volume';
const screenVol=document.createElement('input');screenVol.type='range';screenVol.min=0;screenVol.max=100;screenVol.value=100;
screenVol.oninput=()=>{const v=Math.max(0,Math.min(100,Number(screenVol.value)||0))/100;remoteScreen.volume=v;remoteScreen.muted=v===0;ssSet('screenVol',String(v))};
// Restore saved screen volume (fire-and-forget).
(async()=>{try{const saved=await ss('screenVol');if(saved!==null){const v=parseFloat(saved);if(v>=0&&v<=1){remoteScreen.volume=v;remoteScreen.muted=v===0;screenVol.value=Math.round(v*100)}}}catch{}})()
screenVolWrap.appendChild(screenVolLabel);screenVolWrap.appendChild(screenVol);remoteScreen.parentElement.appendChild(screenVolWrap);
remoteScreen.addEventListener('contextmenu',e=>{e.preventDefault();screenVolWrap.style.display=screenVolWrap.style.display==='none'?'flex':'none';screenVolWrap.style.alignItems='center'});
document.addEventListener('click',e=>{if(!screenVolWrap.contains(e.target)&&e.target!==remoteScreen)screenVolWrap.style.display='none'});
const screenVideos=screenPreview.parentElement;let screenView='grid',focusedScreen='remote';
function makeScreenTile(video,label,kind){const tile=document.createElement('article');tile.className='screen-tile '+kind;tile.dataset.screenTile=kind;const name=document.createElement('span');name.className='screen-tile-name';name.textContent=label;const avatar=document.createElement('span');avatar.className='screen-tile-avatar';avatar.textContent=kind==='local'?'Y':'F';tile.append(video,name,avatar);return tile}
const localScreenTile=makeScreenTile(screenPreview,'You', 'local'),remoteScreenTile=makeScreenTile(remoteScreen,'Friend', 'remote');remoteScreenTile.appendChild(screenVolWrap);screenVideos.replaceChildren(localScreenTile,remoteScreenTile);
const screenViewBar=document.createElement('div');screenViewBar.className='screen-view-bar';screenViewBar.innerHTML='<button type="button" data-screen-view="grid" title="Grid view">▦ Grid</button><button type="button" data-screen-view="focus" title="Focus view">▣ Focus</button><button type="button" data-screen-fullscreen title="Fullscreen">⛶ Fullscreen</button>';screenVideos.after(screenViewBar);
const gridViewButton=screenViewBar.querySelector('[data-screen-view="grid"]'),focusViewButton=screenViewBar.querySelector('[data-screen-view="focus"]'),fsBtn=screenViewBar.querySelector('[data-screen-fullscreen]');
function screenIsActive(){return !screenPreview.hidden||!remoteScreen.hidden}
function updateScreenLayout(){const hasLocal=!screenPreview.hidden,hasRemote=!remoteScreen.hidden;if(!hasRemote)focusedScreen='local';if(!hasLocal)focusedScreen='remote';voicePanel.classList.toggle('screen-sharing',hasLocal||hasRemote);voicePanel.classList.toggle('screen-focus',screenView==='focus'&&hasLocal&&hasRemote);voicePanel.classList.toggle('screen-focus-local',focusedScreen==='local');localScreenTile.hidden=!hasLocal;remoteScreenTile.hidden=!hasRemote;gridViewButton.classList.toggle('active',screenView==='grid');focusViewButton.classList.toggle('active',screenView==='focus');fsBtn.hidden=!screenIsActive();fsBtn.textContent=(remoteScreen.classList.contains('fs')||screenPreview.classList.contains('fs'))?'✕ Exit fullscreen':'⛶ Fullscreen'}
function toggleRemoteFs(){const target=focusedScreen==='local'?screenPreview:remoteScreen,other=target===screenPreview?remoteScreen:screenPreview;const is=target.classList.toggle('fs');other.classList.remove('fs');document.body.classList.toggle('screen-fullscreen',is);updateScreenLayout()}
function selectScreen(kind){focusedScreen=kind;if(!remoteScreen.hidden&&!screenPreview.hidden)screenView='focus';updateScreenLayout()}
screenVideos.addEventListener('click',event=>{const tile=event.target.closest('[data-screen-tile]');if(!tile)return;focusedScreen=tile.dataset.screenTile;toggleRemoteFs()});
screenViewBar.onclick=event=>{const view=event.target.closest('[data-screen-view]')?.dataset.screenView;if(view){screenView=view;updateScreenLayout();return}if(event.target.closest('[data-screen-fullscreen]'))toggleRemoteFs()};
const screenLayoutObserver=new MutationObserver(updateScreenLayout);screenLayoutObserver.observe(screenPreview,{attributes:true,attributeFilter:['hidden']});screenLayoutObserver.observe(remoteScreen,{attributes:true,attributeFilter:['hidden']});updateScreenLayout();
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&(remoteScreen.classList.contains('fs')||screenPreview.classList.contains('fs')))toggleRemoteFs()});
