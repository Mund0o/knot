const path = require('path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function fail(error) {
  console.error('Windows audio renderer smoke failed:', error?.stack || error);
  app.exit(1);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true }
  });
  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'), { query: { testMode: '1' } });
    await new Promise(resolve => setTimeout(resolve, 300));
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const assert=(condition,message)=>{if(!condition)throw new Error(message)};
      const ctx=new AudioContext({sampleRate:48000});
      await ctx.audioWorklet.addModule(new URL('screen-audio-worklet.js',location.href));
      await ctx.resume();
      const node=new AudioWorkletNode(ctx,'knot-screen-audio',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
      const analyser=ctx.createAnalyser(),mute=ctx.createGain(),destination=ctx.createMediaStreamDestination(),diagnostics=[];
      analyser.fftSize=256;mute.gain.value=0;node.port.onmessage=event=>diagnostics.push(event.data);
      node.connect(destination);node.connect(analyser).connect(mute).connect(ctx.destination);
      const packet=new Float32Array(10000*2);
      for(let frame=6160;frame<10000;frame++){packet[frame*2]=.25;packet[frame*2+1]=.25}
      node.port.postMessage(packet,[packet.buffer]);
      const samples=new Float32Array(analyser.fftSize);let peak=0;
      for(let attempt=0;attempt<30&&peak<.1;attempt++){
        await new Promise(resolve=>setTimeout(resolve,4));
        analyser.getFloatTimeDomainData(samples);for(const sample of samples)peak=Math.max(peak,Math.abs(sample));
      }
      const trim=diagnostics.find(value=>value?.type==='trim');
      assert(trim?.droppedFrames===6160&&trim?.bufferedFrames===3840,'worklet did not discard the stale beginning of an oversized IPC packet');
      assert(peak>.1,'valid stereo PCM did not flow through the real AudioWorklet output');
      assert(destination.stream.getAudioTracks().length===1,'worklet did not create a WebRTC-compatible stereo track');
      node.disconnect();await ctx.close();

      const previousNative=nativeRemoteAudio,previousOutput=outputDeviceId,remoteDescriptor=Object.getOwnPropertyDescriptor(remoteScreen,'setSinkId'),calls=[];
      const dmNative={setSinkId:async id=>calls.push('dm-native:'+id)},serverStandard={setSinkId:async id=>calls.push('server-standard:'+id)},serverNative={setSinkId:async id=>calls.push('server-native:'+id)};
      Object.defineProperty(remoteScreen,'setSinkId',{configurable:true,value:async id=>calls.push('dm-standard:'+id)});
      nativeRemoteAudio=dmNative;serverPeers.set('windows-audio-sink-test',{audios:[],screen:serverStandard,screenAudio:serverNative});outputDeviceId='test-output';
      const elements=screenShareOutputElements();
      assert(elements.length===4&&elements.includes(remoteScreen)&&elements.includes(dmNative)&&elements.includes(serverStandard)&&elements.includes(serverNative),'screen output enumeration missed a standard/native DM/server route');
      await applyOutputDevice();
      assert(['dm-standard','dm-native','server-standard','server-native'].every(route=>calls.includes(route+':test-output')),'selected device was not applied to every screen-audio route');
      serverPeers.delete('windows-audio-sink-test');nativeRemoteAudio=previousNative;outputDeviceId=previousOutput;
      if(remoteDescriptor)Object.defineProperty(remoteScreen,'setSinkId',remoteDescriptor);else delete remoteScreen.setSinkId;

      // Exercise the cross-platform handoff used by Windows standard shares and
      // Linux native AV1 shares: voice and desktop sound reserve separate
      // m-lines in the initial offer, then the desktop lane swaps from silence
      // to live sound without a renegotiation race.
      if(pc){try{pc.close()}catch{}pc=null}
      cleanupRemoteNativeScreen();remoteScreenExpected=true;remoteNativeScreenExpected=true;remoteScreenSuppressed=false;remoteScreen.hidden=false;screenExpanded=false;focusedScreen='remote';callActive=true;
      setupPeer();const receiver=pc,sender=new RTCPeerConnection({iceServers:[]});
      receiver.onicecandidate=event=>{if(event.candidate)sender.addIceCandidate(event.candidate).catch(()=>{})};
      sender.onicecandidate=event=>{if(event.candidate)receiver.addIceCandidate(event.candidate).catch(()=>{})};
      const makeTone=async frequency=>{const context=new AudioContext({sampleRate:48000}),destination=context.createMediaStreamDestination(),oscillator=context.createOscillator(),gain=context.createGain();oscillator.frequency.value=frequency;gain.gain.value=.08;oscillator.connect(gain).connect(destination);oscillator.start();await context.resume().catch(()=>{});return{context,destination,oscillator,track:destination.stream.getAudioTracks()[0]}};
      const voice=await makeTone(337),screen=await makeTone(719);
      const senderSilentContext=new AudioContext({sampleRate:48000}),senderSilentDestination=senderSilentContext.createMediaStreamDestination();
      sender.addTrack(voice.track,voice.destination.stream);
      const senderScreenAudio=sender.addTrack(senderSilentDestination.stream.getAudioTracks()[0],senderSilentDestination.stream);
      const offer=await sender.createOffer();await sender.setLocalDescription(offer);await receiver.setRemoteDescription(offer);const answer=await receiver.createAnswer();await receiver.setLocalDescription(answer);await sender.setRemoteDescription(answer);
      await senderScreenAudio.replaceTrack(screen.track);
      await new Promise(resolve=>setTimeout(resolve,500));
      const routedScreenTrack=nativeRemoteAudio?.srcObject?.getAudioTracks?.()[0];
      assert(remoteAudio.srcObject?.getAudioTracks?.().length===1,'the established call track was not kept on the voice route');
      assert(routedScreenTrack?.readyState==='live','the later desktop-audio m-line was not routed to the dedicated screen element');
      watchDmShare('remote');await new Promise(resolve=>setTimeout(resolve,120));
      assert(screenExpanded&&focusedScreen==='remote'&&!nativeRemoteAudio.muted&&!nativeRemoteAudio.paused&&routedScreenTrack.enabled,'watching a remote share did not unmute/play its desktop-audio track');
      let inboundAudio=0;for(const report of (await receiver.getStats()).values())if(report.type==='inbound-rtp'&&(report.kind==='audio'||report.mediaType==='audio'))inboundAudio+=Number(report.bytesReceived)||0;
      assert(inboundAudio>0,'the receiver did not receive cross-platform call/screen audio RTP');
      sender.close();receiver.close();pc=null;voice.oscillator.stop();screen.oscillator.stop();voice.track.stop();screen.track.stop();voice.context.close().catch(()=>{});screen.context.close().catch(()=>{});senderSilentContext.close().catch(()=>{});cleanupRemoteNativeScreen();remoteScreenExpected=false;remoteNativeScreenExpected=false;remoteScreen.hidden=true;screenExpanded=false;callActive=false;
      return{peak,trim,calls,inboundAudio};
    })()`, true);
    console.log('PASS Windows audio renderer packet flow and output routing', JSON.stringify(result));
    window.destroy();
    app.quit();
  } catch (error) {
    window.destroy();
    fail(error);
  }
});
