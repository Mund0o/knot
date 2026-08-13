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
      return{peak,trim,calls};
    })()`, true);
    console.log('PASS Windows audio renderer packet flow and output routing', JSON.stringify(result));
    window.destroy();
    app.quit();
  } catch (error) {
    window.destroy();
    fail(error);
  }
});
