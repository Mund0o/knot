const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const gpuSource = fs.readFileSync(path.join(__dirname, '..', 'linux-gpu.js'), 'utf8');
const accelerationSource = fs.readFileSync(path.join(__dirname, '..', 'gpu-acceleration.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
if (mainSource.includes("appendSwitch('render-node-override'") || mainSource.includes("appendSwitch('use-angle'")) {
  throw new Error('Linux screen sharing still forces a portal-incompatible GPU target');
}
if (!mainSource.includes('applyGpuAccelerationPolicy(app') || !mainSource.includes("primaryGpuCard: selectedPrimaryGpu?.card") || !accelerationSource.includes("switches.set('hardware-video-device-path', gpu.renderNode)") || !accelerationSource.includes("switches.set('use-webgpu-adapter', 'opengles')") || !accelerationSource.includes("['force-high-performance-gpu', '']") || !accelerationSource.includes("['disable-software-rasterizer', '']") || !gpuSource.includes('.filter(candidate => !candidate.integrated)') || !gpuSource.includes("env.DRI_PRIME = selector") || !gpuSource.includes("env.__VK_LAYER_NV_optimus = 'NVIDIA_only'") || !gpuSource.includes("env.LIBVA_DRIVER_NAME = 'nvidia'")) {
  throw new Error('Linux media can still select an integrated GPU when a discrete main GPU is available');
}
if (!rendererSource.includes('await waitForDisplayFrames(track)') || rendererSource.indexOf('await waitForDisplayFrames(track)') > rendererSource.indexOf("send({t:'screen-start'})")) {
  throw new Error('Screen sharing is advertised before a real capture frame arrives');
}
if (rendererSource.includes('p.encodings[0].minBitrate=')) {
  throw new Error('Screen sharing still forces a congestion-breaking minimum bitrate');
}
if (!mainSource.includes("if (process.platform === 'linux')") || !mainSource.includes("types: ['screen']") || !rendererSource.includes("window.pairEnv?.getSources&&!window.pairEnv.useSystemPicker")) {
  throw new Error('Linux display media does not acquire its portal source in one step');
}
if (!rendererSource.includes("parameters.degradationPreference='maintain-resolution'") || !rendererSource.includes("encoding.networkPriority='low'") || !rendererSource.includes("p.encodings[0].networkPriority='high'") || !rendererSource.includes("screenAudio=stream.getVideoTracks().length>0") || !rendererSource.includes("t:'screen-codec-fallback',serverId:state.context.serverId")) {
  throw new Error('Selected screen quality, server screen audio routing, or server AV1 recovery can silently regress');
}
if (!rendererSource.includes('FILE_DRAIN_TIMEOUT=45000') || !rendererSource.includes('direct connection stopped draining')) {
  throw new Error('File transfers can still wait forever on a stalled SCTP send buffer');
}
if (!rendererSource.includes('pendingFrameDelete=pendingFrames.delete.bind') || !rendererSource.includes('pendingFrames.delete=seq=>')) {
  throw new Error('Canceled early file frames can still leak the pending-transfer budget');
}
if (!rendererSource.includes('maxptime=20') || !rendererSource.includes('c.maxptime=20;c.ptime=10')) {
  throw new Error('Voice audio can still queue long Opus packets behind screen sharing');
}
if (!rendererSource.includes("send({t:'screen-codec-fallback'})") || !rendererSource.includes("await switchScreenCodec('H264')") || !rendererSource.includes('receiver.playoutDelayHint=.08')) {
  throw new Error('AV1 decode failure and tearing do not have a screen-share recovery path');
}
if (!rendererSource.includes('decode:false') || !rendererSource.includes('startSoftwareDecoder') || rendererSource.includes('window.pairEnv?.toggleFullscreen')) {
  throw new Error('Native AV1 can still overload the sender, black-screen without retrying, or fullscreen the whole app');
}
if (!rendererSource.includes('targetNativeAv1BitrateKbps(width,height,fps)') || !rendererSource.includes("createDataChannel('knot-screen-native',{ordered:false,maxPacketLifeTime:100,priority:'low'})") || !rendererSource.includes('NATIVE_SCREEN_BUFFER_HIGH=256*1024')) {
  throw new Error('Native AV1 can still monopolize the connection and lag voice traffic');
}

function fail(error) {
  console.error('Navigation UI smoke test failed:', error?.stack || error);
  app.exit(1);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true }
  });
  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const assert=(condition,message)=>{if(!condition)throw new Error(message)};
      const dialog=document.querySelector('#serverDialog'),plus=document.querySelector('#addServer'),toggle=document.querySelector('#sidebarToggle'),home=document.querySelector('#homeButton'),handle=document.querySelector('#sidebarResize'),shell=document.querySelector('.app-shell');
      const brandIcon=home.querySelector('img');assert(brandIcon&&brandIcon.complete&&brandIcon.naturalWidth>0,'Knot home logo did not load');
      plus.click();assert(dialog.open,'server plus did not open Create/Join dialog');assert(dialog.textContent.includes('Create a server')&&dialog.textContent.includes('Join a server'),'server actions are not visible');dialog.close();
      toggle.click();assert(document.body.classList.contains('social-sidebar-collapsed'),'sidebar did not collapse');assert(toggle.getAttribute('aria-expanded')==='false','collapsed state is not announced');
      home.click();assert(!document.body.classList.contains('social-sidebar-collapsed'),'Knot home did not reopen Friends');assert(!document.querySelector('#friendsNavigation').hidden,'Friends did not become visible');
      setSocialSidebarWidth(280,false);const before=parseFloat(shell.style.getPropertyValue('--social-sidebar-width'));handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));const after=parseFloat(shell.style.getPropertyValue('--social-sidebar-width'));assert(after>before,'keyboard resize did not increase sidebar width');
      directorySnapshot={friends:[{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:'Alice',image:'',online:true},{id:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',name:'Bob',image:'',online:false}],members:{},servers:[]};renderFriends();assert(document.querySelectorAll('#friendList .friend-entry').length===2,'direct-message rows did not render');assert(/Connecting|Connected/.test(document.querySelector('#friendList .friend-copy small').textContent),'persistent DM presence label did not render');const search=document.querySelector('#friendSearch');search.value='ali';search.dispatchEvent(new Event('input',{bubbles:true}));assert(document.querySelectorAll('#friendList .friend-entry').length===1,'conversation search did not filter friends');search.value='';renderFriends();
      const selfId='cccccccccccccccccccccccccccccccc',friendId='dddddddddddddddddddddddddddddddd',serverId='11111111111111111111111111111111',generalId='22222222222222222222222222222222',rulesId='33333333333333333333333333333333',voiceId='44444444444444444444444444444444';directoryUserId=selfId;directorySnapshot={friends:[],members:{[selfId]:{id:selfId,name:'Tester',image:'',online:true},[friendId]:{id:friendId,name:'Friend',image:'',online:false}},self:{id:selfId,name:'Tester',image:'',online:true},voiceStates:{},servers:[{id:serverId,name:'Test Server',picture:'',owner:selfId,members:[selfId,friendId],channels:[{id:generalId,type:'text',name:'general'},{id:rulesId,type:'text',name:'rules'},{id:voiceId,type:'voice',name:'Lounge'}]}]};let sent=[];directorySend=value=>{sent.push(value);return true};renderServers();const server=document.querySelector('#serverList .rail-button');assert(server&&server.textContent==='TE','server icon was not rendered below P');server.click();assert(!document.querySelector('#serverNavigation').hidden&&document.querySelector('#friendsNavigation').hidden,'server click did not switch Friends to channels');assert(document.querySelectorAll('#textChannelList .channel-item').length===2&&document.querySelectorAll('#voiceChannelList .channel-item').length===1,'text and voice channels were not grouped');
      document.querySelector('#addTextChannel').click();const channelDialog=document.querySelector('#channelDialog');assert(channelDialog.open,'text channel plus did not open the channel dialog');document.querySelector('#newChannelName').value='updates';document.querySelector('#channelForm').requestSubmit();assert(sent.at(-1)?.type==='create-channel'&&sent.at(-1)?.channelType==='text','text channel creation was not sent');pendingChannelCreation=null;channelDialog.close();document.querySelector('#serverMembersClose').click();assert(document.body.classList.contains('server-members-collapsed')&&document.querySelector('#memberPanelToggle').getAttribute('aria-expanded')==='false','member list did not collapse');document.querySelector('#memberPanelToggle').click();assert(!document.body.classList.contains('server-members-collapsed'),'member list did not reopen');
      document.querySelector('#textChannelList .channel-remove').click();assert(sent.at(-1)?.type==='delete-channel','channel deletion was not sent');moveChannel(rulesId,generalId,false);assert(sent.at(-1)?.type==='reorder-channels'&&sent.at(-1).channelIds[0]===rulesId,'channel reorder was not sent');
      selectServerChannel(serverId,generalId);sendServerMessage('saved locally',null);const local=conversationHistories['server:'+serverId+':'+generalId]?.at(-1);assert(local?.id&&local.author?.id===selfId&&local.mine,'local server message was not stored canonically');const fakeChannel={readyState:'open',sent:[],send(value){this.sent.push(JSON.parse(value))}};wireServerChannel(friendId,fakeChannel,serverId);fakeChannel.onopen();assert(fakeChannel.sent[0]?.t==='server-history-request','history was not requested when the peer opened');fakeChannel.onmessage({data:JSON.stringify({t:'server-history',serverId,channelId:rulesId,entries:[{id:'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',text:'older server message',author:{id:friendId,name:'Friend'},time:Date.now()-1000}]})});assert(conversationHistories['server:'+serverId+':'+rulesId]?.some(item=>item.text==='older server message'),'history from another channel was not retained');selectServerChannel(serverId,rulesId);assert(document.querySelector('#messages').textContent.includes('older server message'),'synced channel history was not rendered');
      const editCount=sent.length;directorySnapshot.servers[0].owner=friendId;renderChannels();assert(document.querySelector('#addTextChannel').hidden&&document.querySelector('#editServerPicture').hidden,'server editing controls were shown to a non-owner');assert(!document.querySelector('#textChannelList .channel-remove')&&!document.querySelector('#textChannelList .channel-item').draggable,'non-owner channel editing remained available');moveChannel(generalId,rulesId,false);assert(sent.length===editCount,'a non-owner could reorder channels');directorySnapshot.servers[0].owner=selfId;renderChannels();
      const applied=[];shareResolution='2160';shareFrameRate=60;await tuneDisplayTrack({applyConstraints:async value=>applied.push(value)});const captureRequest=displayCaptureRequest();assert(captureRequest.video===true&&!('audio' in captureRequest),'display capture request contains invalid pre-capture constraints');assert(applied[0]?.width?.max===3840&&applied[0]?.height?.max===2160&&applied[0]?.frameRate?.max===60,'display quality was not applied after capture');screenBitrateMbps=60;screenFallbackBitrateCapMbps=0;assert(targetScreenBitrate(3840,2160,60)===56000000,'normal WebRTC 4K60 target lost its configured headroom');assert(targetNativeAv1BitrateKbps(3840,2160,60)===10000,'native AV1 no longer reserves upload and voice headroom at 4K60');const patchedSdp=patchSdp('m=video 9 UDP/TLS/RTP/SAVPF 96\\r\\nc=IN IP4 0.0.0.0\\r\\na=rtpmap:96 video/VP9/90000\\r\\n');assert(!patchedSdp.includes('b=TIAS:')&&!patchedSdp.includes('x-google-start-bitrate'),'screen video still bypasses congestion control through SDP');const ordered=orderedScreenCodecs({codecs:[{mimeType:'video/H264'},{mimeType:'video/AV1'},{mimeType:'video/VP9'},{mimeType:'video/rtx'}]},'AV1');assert(ordered[0].mimeType==='video/AV1'&&ordered.some(codec=>codec.mimeType==='video/rtx'),'explicit AV1 preference or repair codec was dropped');let senderParameters={encodings:[{}]};const sender={getParameters:()=>structuredClone(senderParameters),setParameters:async value=>{senderParameters=structuredClone(value)}},screenTrack={getSettings:()=>({width:3840,height:2160})};screenRecoveryLevel=0;await configureScreenVideoSender(sender,screenTrack,60);assert(senderParameters.degradationPreference==='maintain-resolution'&&senderParameters.encodings[0].maxFramerate===60&&senderParameters.encodings[0].scaleResolutionDownBy===1&&senderParameters.encodings[0].priority==='medium'&&senderParameters.encodings[0].networkPriority==='low'&&senderParameters.encodings[0].maxBitrate===56000000&&!('minBitrate' in senderParameters.encodings[0]),'screen sender does not preserve 4K60 while yielding network priority to voice');screenFallbackBitrateCapMbps=12;await configureScreenVideoSender(sender,screenTrack,60);assert(senderParameters.encodings[0].maxBitrate===12000000,'H.264 compatibility recovery can still saturate the upload');screenFallbackBitrateCapMbps=0;const workletContext=new AudioContext({sampleRate:48000});await workletContext.audioWorklet.addModule(new URL('screen-audio-worklet.js',location.href));const workletNode=new AudioWorkletNode(workletContext,'knot-screen-audio',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]}),workletDest=workletContext.createMediaStreamDestination();workletNode.connect(workletDest);workletNode.port.postMessage(new Float32Array(4096));assert(workletDest.stream.getAudioTracks().length===1,'Linux screen audio worklet did not create a stereo output track');workletNode.disconnect();await workletContext.close();screenActive=true;screenStream={getVideoTracks:()=>[screenTrack]};screenRecoveryLevel=0;await recoverOverloadedScreenSender(sender);assert(screenRecoveryLevel===1&&senderParameters.encodings[0].maxFramerate===60&&senderParameters.encodings[0].scaleResolutionDownBy===1,'encoder warning silently changed the selected preset');await recoverOverloadedScreenSender(sender);assert(senderParameters.encodings[0].maxFramerate===60&&senderParameters.encodings[0].scaleResolutionDownBy===1,'repeated overload silently reduced quality');screenActive=false;screenStream=null;screenRecoveryLevel=0;
      const nativeState={context:{serverId},nativeSendChannel:null,nativeReceiveChannel:null,nativeScreenPlayer:null,nativeScreenAudioExpected:false,screen:null,screenAudio:null},nativeSent={readyState:'open',send(){},close(){}},nativeReceived={readyState:'open',send(){},close(){}};wireServerNativeScreenChannel(friendId,nativeState,nativeSent);wireServerNativeScreenChannel(friendId,nativeState,nativeReceived,{remote:true});assert(nativeState.nativeSendChannel===nativeSent&&nativeState.nativeReceiveChannel===nativeReceived,'simultaneous native screen send and receive channels overwrite each other');const appended=[],packetChannel={_nativeReceive:{fragments:new Map(),complete:new Map(),nextSeq:0,player:{append:value=>appended.push([...value])}}},nativePayload=new Uint8Array([1,2,3,4,5]),makePacket=(part,total,data)=>{const packet=new Uint8Array(12+data.length),view=new DataView(packet.buffer);view.setUint32(0,NATIVE_SCREEN_PACKET);view.setUint32(4,0);view.setUint16(8,part);view.setUint16(10,total);packet.set(data,12);return packet.buffer};receiveNativeScreenPacket(packetChannel,makePacket(1,2,nativePayload.slice(2)));receiveNativeScreenPacket(packetChannel,makePacket(0,2,nativePayload.slice(0,2)));assert(appended.length===1&&appended[0].join(',')===nativePayload.join(','),'native AV1 packet fragments were not reassembled in order');const realVideoDecoder=window.VideoDecoder;let decoderInstances=0;const decoderConfigs=[];class RejectHardwareDecoder{constructor(callbacks){decoderInstances++;this.callbacks=callbacks;this.decodeQueueSize=0}configure(config){decoderConfigs.push({...config});if(config.hardwareAcceleration==='prefer-hardware')throw new DOMException('hardware rejected','NotSupportedError');this.config=config}decode(){}close(){}}window.VideoDecoder=RejectHardwareDecoder;const decoderFixture=new Uint8Array([0x63,0xa2,0x84,0x81,0x0d,0x8c,0]),remoteDecodeVideo=document.createElement('video'),localDecodeVideo=document.createElement('video');document.body.append(remoteDecodeVideo,localDecodeVideo);const remoteDecodePlayer=createWebCodecsNativeScreenPlayer(remoteDecodeVideo,'AV1',error=>{throw error},{width:3840,height:2160,fps:60}),localDecodePlayer=createWebCodecsNativeScreenPlayer(localDecodeVideo,'AV1',()=>{},{width:3840,height:2160,fps:60,decode:false});assert(remoteDecodePlayer.append(decoderFixture)&&remoteDecodePlayer.stats().softwareFallback,'AMD-style hardware configuration rejection did not retry software AV1');assert(decoderConfigs.at(-1)?.codec==='av01.0.13H.08','AMD AV1 high-tier configuration was rewritten to main tier');assert(remoteDecodePlayer.stats().presentationMode===(typeof MediaStreamTrackGenerator==='function'?'track':'canvas'),'decoded AV1 frames did not use the direct video-track presentation path');assert(localDecodePlayer.append(decoderFixture)&&localDecodePlayer.mode==='placeholder'&&localDecodePlayer.stats().decodeDisabled&&decoderInstances===2,'sender preview instantiated an AV1 decoder');remoteDecodePlayer.destroy();localDecodePlayer.destroy();remoteDecodeVideo.remove();localDecodeVideo.remove();window.VideoDecoder=realVideoDecoder;serverNativeScreenSession={id:1};assert(serverScreenSharing(),'server native share did not activate the stream UI');serverNativeScreenSession=null;
      const recovered=[],recoveryPlayer={resets:0,append:value=>{recovered.push([...value]);return true},reset(){this.resets++;return true}},recoveryChannel={_nativeReceive:nativeScreenReceiveState(recoveryPlayer,{fps:60})};recoveryChannel._nativeReceive.haveInit=true;recoveryChannel._nativeReceive.nextSeq=1;recoveryChannel._nativeReceive.pendingBytes=2;recoveryChannel._nativeReceive.complete.set(2,{data:new Uint8Array([7]),kind:'init',key:false});recoveryChannel._nativeReceive.complete.set(3,{data:new Uint8Array([8]),kind:'cluster',key:true});drainNativeScreenReceive(recoveryChannel);await new Promise(resolve=>setTimeout(resolve,NATIVE_SCREEN_GAP_WAIT+20));assert(recoveryPlayer.resets===1&&recovered.at(-1)?.[0]===8&&recoveryChannel._nativeReceive.nextSeq===4,'a missing AV1 fragment did not recover at the next keyframe');
      let congestionFallbacks=0;const congestionPackets=[],congestionChannel={readyState:'open',bufferedAmount:NATIVE_SCREEN_BUFFER_HIGH+1,_nativePeerProtocol:NATIVE_SCREEN_PROTOCOL,send:value=>congestionPackets.push(value),_nativeSend:{sessionId:1,seq:0,init:new Uint8Array([9]),fps:60,dropping:false,droppedSegments:0,missedKeys:0,congestedSince:0,fallbackRequested:false,onFallback:()=>{congestionFallbacks++}}};await sendNativeScreenLiveItem(congestionChannel,{kind:'cluster',data:new Uint8Array([1]),key:false});assert(congestionChannel._nativeSend.dropping&&congestionPackets.length===0,'native congestion queued a stale delta frame');congestionChannel.bufferedAmount=0;await sendNativeScreenLiveItem(congestionChannel,{kind:'cluster',data:new Uint8Array([2]),key:true});assert(!congestionChannel._nativeSend.dropping&&congestionPackets.length===2,'native congestion did not resume with init plus keyframe');congestionChannel.bufferedAmount=NATIVE_SCREEN_BUFFER_HIGH+1;congestionChannel._nativeSend.dropping=false;congestionChannel._nativeSend.congestedSince=performance.now()-6000;await sendNativeScreenLiveItem(congestionChannel,{kind:'cluster',data:new Uint8Array([3]),key:false});assert(congestionFallbacks===0&&!congestionChannel._nativeSend.fallbackRequested&&congestionChannel._nativeSend.dropping,'recoverable congestion switched to a larger H.264 stream');congestionChannel._nativePeerProtocol=NATIVE_SCREEN_PROTOCOL-1;congestionChannel._nativeSend.dropping=false;await sendNativeScreenLiveItem(congestionChannel,{kind:'cluster',data:new Uint8Array([4]),key:false});assert(congestionFallbacks===1&&congestionChannel._nativeSend.fallbackRequested,'legacy receiver compatibility fallback was not requested');
      const voiceTrack={enabled:false,stop(){}};
      navigator.mediaDevices.getUserMedia=async()=>({getAudioTracks:()=>[voiceTrack],getTracks:()=>[voiceTrack]});
      const voiceButton=document.querySelector('#voiceChannelList .channel-entry');
      voiceButton.click();
      assert(!serverVoiceStream,'single click joined voice');
      assert(getComputedStyle(document.querySelector('#voicePanel')).display==='none','old server call row remained visible');
      voiceButton.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,20));
      assert(joinedVoiceChannelId===voiceId&&joinedVoiceServerId===serverId&&document.querySelector('#voiceChannelList .voice-channel-member'),'double click did not join voice or render its member');
      assert(!document.querySelector('#serverVoiceDock').hidden&&!document.querySelector('#serverVoiceStage').hidden,'connected voice controls did not appear');
      assert(document.querySelectorAll('#serverVoiceDock .server-voice-actions button').length===3&&!document.querySelector('#serverVoiceFocus')&&!document.querySelector('#serverVoiceLeave'),'redundant compact voice controls remained');
      assert(document.querySelector('#serverVoiceShare svg')&&document.querySelector('#serverVoiceHangup svg'),'clear share or hang-up icon is missing');
      document.querySelector('#serverVoiceMute').click();
      assert(!voiceTrack.enabled&&serverVoiceMuted,'server mute control did not mute the microphone');
      await selectServerChannel(serverId,generalId);
      assert(joinedVoiceChannelId===voiceId&&!document.querySelector('#serverVoiceDock').hidden,'opening text disconnected server voice');

      const secondId='55555555555555555555555555555555';
      directorySnapshot.members[secondId]={id:secondId,name:'Second friend',image:'',online:false};
      directorySnapshot.servers[0].members.push(secondId);
      directorySnapshot.voiceStates[voiceId]=[{id:selfId,joinedAt:Date.now()-65000},{id:friendId,joinedAt:Date.now()-4000},{id:secondId,joinedAt:Date.now()-2000}];
      renderChannels();
      const firstShare=document.createElement('video'),secondShare=document.createElement('video');
      firstShare.dataset.peerId=friendId;secondShare.dataset.peerId=secondId;
      document.querySelector('#serverVoiceScreens').append(firstShare,secondShare);
      const peerStub=screen=>({screen,audios:[],screenSenders:[],pc:{close(){}},channel:null});
      serverPeers.set(friendId,peerStub(firstShare));serverPeers.set(secondId,peerStub(secondShare));renderServerVoiceUI();
      const serverShareBadges=[...document.querySelectorAll('#serverVoiceStageMembers .server-share-badge')];
      assert(serverShareBadges.length===2,'simultaneous server shares did not render beside their owners');
      serverShareBadges[0].click();
      assert([...document.querySelectorAll('#serverVoiceScreens video')].filter(video=>!video.hidden).length===1,'watching one server share showed overlapping streams');
      serverShareBadges[1].click();
      assert([...document.querySelectorAll('#serverVoiceScreens video')].filter(video=>!video.hidden).length===1&&serverFocusedShareId===secondId,'switching server shares did not focus one stream');
      secondShare.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:40,clientY:40}));
      assert(!shareContextMenu.hidden&&shareContextMenu.textContent.includes('Stop Watching'),'server share context menu is missing Stop Watching');
      shareContextMenu.querySelector('.share-context-stop').click();
      assert(serverSuppressedShares.has(secondId)&&secondShare.hidden,'server Stop Watching did not collapse the selected stream');

      showFriends();
      assert(joinedVoiceChannelId===voiceId&&!document.querySelector('#serverVoiceDock').hidden&&document.querySelector('#serverVoiceStage').hidden,'opening Friends disconnected server voice or left the stage covering the DM');
      document.querySelector('#serverVoiceHangup').click();
      assert(document.querySelector('#serverVoiceDock').hidden&&document.querySelector('#serverVoiceStage').hidden,'compact hang-up did not disconnect server voice');

      const otherId='66666666666666666666666666666666';
      directorySnapshot.friends=[{id:friendId,name:'Friend',image:'',online:true},{id:otherId,name:'Other DM',image:'',online:true}];
      directorySnapshot.members[otherId]={id:otherId,name:'Other DM',image:'',online:true};
      activePeerId=friendId;dmPeerId=friendId;dmCallPeerId=friendId;friendName='Friend';callActive=true;callStart=Date.now()-65000;syncVoiceStage();renderFriends();
      assert(!document.querySelector('#dmVoiceDock').hidden&&document.querySelector('#voicePanel').classList.contains('call-active'),'DM call controls did not appear');
      assert(getComputedStyle(document.querySelector('#voicePanel')).position==='sticky','active call stage does not follow the conversation');
      paintSpeaking('dm-self',true);
      assert(document.querySelector('#participantYou .avatar').classList.contains('speaking'),'speaking outline was not applied');
      paintSpeaking('dm-self',false);
      const speakingTestContext=new AudioContext({sampleRate:48000}),speakingTone=speakingTestContext.createOscillator(),speakingGain=speakingTestContext.createGain(),speakingDestination=speakingTestContext.createMediaStreamDestination();speakingGain.gain.value=.12;speakingTone.frequency.value=220;speakingTone.connect(speakingGain).connect(speakingDestination);speakingTone.start();monitorSpeaking('dm-friend',speakingDestination.stream);await new Promise(resolve=>setTimeout(resolve,180));assert(document.querySelector('#participantFriend .avatar').classList.contains('speaking'),'friend audio did not drive the green speaking outline');stopSpeakingMonitor('dm-friend');speakingTone.stop();await speakingTestContext.close();
      assert(document.querySelectorAll('#dmVoiceDock .server-voice-actions button').length===3,'DM controls contain a redundant action');
      const dmKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),persistentChannel={readyState:'open',sent:[],send(value){this.sent.push(JSON.parse(value))}};
      persistentDmPeers.set(otherId,{key:dmKey,channel:persistentChannel,pc:{connectionState:'connected'}});
      await selectFriend(otherId,{connect:false});
      assert(callActive&&dmCallPeerId===friendId&&activePeerId===otherId&&!messageInput.disabled,'opening another DM disconnected the current call or disabled the new conversation');
      messageInput.value='message while calling';messageForm.requestSubmit();await new Promise(resolve=>setTimeout(resolve,20));
      assert(persistentChannel.sent[0]?.t==='dm-msg'&&persistentChannel.sent[0]?.v?.iv,'the background DM was not sent over its encrypted persistent channel');
      selectServer(serverId);
      assert(callActive&&!document.querySelector('#dmVoiceDock').hidden,'opening a server disconnected or hid the DM call');
      showFriends();

      remoteScreen.srcObject=new MediaStream();remoteScreen.hidden=false;remoteScreenExpected=true;updateScreenLayout();
      assert(!remoteShareBadge.hidden&&participantFriend.classList.contains('has-share'),'remote share was not discoverable beside its owner');
      remoteShareBadge.click();
      assert(screenExpanded&&focusedScreen==='remote'&&!remoteScreenTile.hidden,'clicking the remote share badge did not open its viewer');
      assert(getComputedStyle(document.querySelector('#voicePanel .voice-participants')).visibility==='visible','focus view hid the participant strip');
      screenViewBar.querySelector('[data-screen-return]').click();assert(!screenExpanded,'return-to-call control did not close focus view');remoteShareBadge.click();
      remoteScreenTile.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:60,clientY:60}));
      assert(!shareContextMenu.hidden&&shareContextMenu.textContent.includes('Stop Watching'),'DM share context menu is missing Stop Watching');
      shareContextMenu.querySelector('.share-context-stop').click();
      assert(remoteScreenSuppressed&&!screenExpanded&&remoteScreen.srcObject&&!remoteShareBadge.hidden,'Stop Watching destroyed the stream instead of keeping it discoverable');
      remoteShareBadge.click();
      assert(!remoteScreenSuppressed&&screenExpanded,'the share badge did not resume a stopped-watching stream');
      screenPreview.srcObject=new MediaStream();screenPreview.hidden=false;updateScreenLayout();
      assert(!localShareBadge.hidden&&!remoteShareBadge.hidden,'two DM share badges were not visible at the same time');
      localShareBadge.click();
      assert(!localScreenTile.hidden&&remoteScreenTile.hidden,'local and remote DM shares overlapped');
      remoteShareBadge.click();
      assert(localScreenTile.hidden&&!remoteScreenTile.hidden,'switching DM shares did not preserve a single focused stream');
      let shareElementFullscreen=false;screenStage.requestFullscreen=async()=>{shareElementFullscreen=true};await toggleRemoteFs();assert(shareElementFullscreen,'fullscreen did not target the screen-share element');
      nativeShareFullscreen=true;screenStage.classList.add('fs');document.body.classList.add('screen-fullscreen');
      clearRemoteScreenShare('Friend stopped sharing');
      assert(!nativeShareFullscreen&&!screenStage.classList.contains('fs')&&!document.body.classList.contains('screen-fullscreen')&&remoteScreen.hidden&&!remoteScreenExpected,'remote share teardown left Knot fullscreen or retained stale share state');
      screenPreview.srcObject=null;screenPreview.hidden=true;updateScreenLayout();
      applyRemoteCallState(true,'remote-session');applyRemoteCallState(false,'remote-session');
      assert(!friendInCall&&participantFriend.getAttribute('aria-hidden')==='true','friend leave did not immediately remove the avatar');
      assert(document.querySelectorAll('.theme-option').length===9,'all nine appearance themes were not rendered');
      for(const theme of THEMES){applyTheme(theme,false);assert(document.documentElement.dataset.theme===theme,'theme did not apply: '+theme)}applyTheme('midnight',false);
      document.querySelector('#dmVoiceHangup').click();await new Promise(resolve=>setTimeout(resolve,0));
      assert(document.querySelector('#dmVoiceDock').hidden,'DM compact hang-up did not end the call');
      return {dialog:true,collapse:true,resize:[before,after],friendSearch:true,serverRail:true,channelCreate:true,channelDelete:true,channelReorder:true,historySync:true,ownerControls:true,memberCollapse:true,displayConstraints:true,motionSender:true,audioWorklet:true,encoderRecovery:true,nativeTransport:true,doubleClickVoice:true,voiceDock:true,voicePersists:true,serverMultiShare:true,dmCallDock:true,stickyCall:true,speakingRing:true,backgroundDmCall:true,persistentDm:true,dmMultiShare:true,stopWatching:true,fullscreenCleanup:true,remoteLeaveCleanup:true,themes:true};
    })()`, true);
    if (process.env.PAIR_UI_SCREENSHOT) {
      if (process.env.PAIR_UI_SCREENSHOT_VIEW === 'server') await window.webContents.executeJavaScript(`(()=>{const selfId='cccccccccccccccccccccccccccccccc',friendId='dddddddddddddddddddddddddddddddd',serverId='11111111111111111111111111111111',generalId='22222222222222222222222222222222',rulesId='33333333333333333333333333333333',voiceId='44444444444444444444444444444444';directoryUserId=selfId;directorySnapshot={friends:[],self:{id:selfId,name:'Mundo',image:'',online:true},members:{[selfId]:{id:selfId,name:'Mundo',image:'',online:true},[friendId]:{id:friendId,name:'Purplepelican',image:'',online:true}},voiceStates:{[voiceId]:[{id:selfId,joinedAt:Date.now()-6529000},{id:friendId,joinedAt:Date.now()-180000}]},servers:[{id:serverId,name:'RJVS',picture:'',owner:selfId,members:[selfId,friendId],channels:[{id:generalId,type:'text',name:'general'},{id:rulesId,type:'text',name:'memes'},{id:voiceId,type:'voice',name:'Vibin'}]}]};selectServer(serverId);selectServerChannel(serverId,generalId);serverVoiceStream=new MediaStream();joinedVoiceChannelId=voiceId;joinedVoiceAt=Date.now()-67000;renderChannels()})()`);
      else if (process.env.PAIR_UI_SCREENSHOT_VIEW === 'dm-share') await window.webContents.executeJavaScript(`(()=>{const friendId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';directorySnapshot={friends:[{id:friendId,name:'Jmeleed',image:'',online:true}],members:{},servers:[]};showFriends({expand:false});activePeerId=friendId;dmCallPeerId=friendId;friendName='Jmeleed';applyFriendProfile(directorySnapshot.friends[0]);openConversation('dm:'+friendId);renderFriends();callActive=true;callStart=Date.now()-67000;setParticipant(participantYou,true);setParticipant(participantFriend,true);screenPreview.hidden=false;remoteScreen.hidden=false;remoteScreenExpected=true;screenPreview.parentElement.style.background='linear-gradient(135deg,#1f2937,#111827)';watchDmShare('remote');remoteScreenTile.style.background='radial-gradient(circle at 35% 35%,#5865f2,#11131a 58%)';screenStatus.textContent='Jmeleed sharing · 1920×1080 · sound live';syncVoiceStage()})()`);
      else if (process.env.PAIR_UI_SCREENSHOT_VIEW === 'dm-call') await window.webContents.executeJavaScript(`(()=>{const friendId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';directorySnapshot={friends:[{id:friendId,name:'Jmeleed',image:'',online:true}],members:{},servers:[]};showFriends({expand:false});activePeerId=friendId;friendName='Jmeleed';renderFriends();callActive=true;callStart=Date.now()-67000;setParticipant(participantYou,true);setParticipant(participantFriend,true);syncVoiceStage()})()`);
      else await window.webContents.executeJavaScript(`(()=>{directorySnapshot={friends:[{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:'Alice',image:'',online:true},{id:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',name:'Bob',image:'',online:false}],members:{},servers:[]};showFriends({expand:false});renderFriends();if(document.querySelector('#roomTitle').textContent!=='Friends')throw new Error('Friends home retained the server title')})()`);
      await new Promise(resolve => setTimeout(resolve, 100));
      fs.writeFileSync(process.env.PAIR_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    console.log('PASS navigation UI', JSON.stringify(result));
    window.destroy();
    app.quit();
  } catch (error) {
    window.destroy();
    fail(error);
  }
});
