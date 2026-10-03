const path = require('path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function fail(error) {
  console.error(error?.stack || error);
  app.exit(1);
}

// A microphone that disappears mid-call (headset unplugged, Bluetooth
// reconnect) must be replaced in the live call, and the RNNoise worklet must
// survive a moment without input instead of going silent for good.
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: process.env.KNOT_ELECTRON_SMOKE_X11 === '1',
    opacity: process.env.KNOT_ELECTRON_SMOKE_X11 === '1' ? 0 : 1,
    skipTaskbar: process.env.KNOT_ELECTRON_SMOKE_X11 === '1',
    width: 900,
    height: 700,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: process.env.KNOT_ELECTRON_SMOKE_X11 !== '1',
    },
  });
  const pageErrors = [];
  window.webContents.on('console-message', event => { if (/Uncaught/.test(event.message || '')) pageErrors.push(event.message); });

  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const assert=(condition,message)=>{if(!condition)throw new Error(message)};
      const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const peak=async stream=>{const context=new AudioContext(),source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);const samples=new Float32Array(2048);let value=0;for(let i=0;i<16;i++){analyser.getFloatTimeDomainData(samples);for(const sample of samples)value=Math.max(value,Math.abs(sample));await delay(25)}await context.close();return value};

      // 1. RNNoise keeps working after its input is briefly disconnected.
      const raw=await navigator.mediaDevices.getUserMedia({audio:true});
      const pipeline=await createRnnoiseMicrophone(raw);let processorFailed=false;pipeline.node.onprocessorerror=()=>{processorFailed=true};
      await delay(300);assert(await peak(pipeline.stream)>0.05,'RNNoise produced no audio from the test microphone');
      pipeline.source.disconnect();await delay(300);pipeline.source.connect(pipeline.node);await delay(400);
      assert(!processorFailed,'the RNNoise worklet failed while its input was disconnected');
      assert(await peak(pipeline.stream)>0.05,'RNNoise stayed silent after its input came back');
      stopVoiceNoisePipeline(pipeline);raw.getTracks().forEach(track=>track.stop());

      // 2. Server voice: a lost microphone is replaced in every peer and the
      // SFU publisher, and the mute state carries over.
      noiseReductionMode='rnnoise';callActive=false;localStream=null;
      const replaced=[],sender=()=>({track:null,replaceTrack(track){replaced.push(track);this.track=track;return Promise.resolve()}});
      const peerSender=sender(),sfuSender=sender();
      serverPeers.clear();serverPeers.set('a'.repeat(32),{voiceSender:peerSender,closing:false});
      groupSfuPilot={publisher:{getSenders:()=>[sfuSender]},close(){}};sfuSender.track={kind:'audio'};
      const firstRaw=await navigator.mediaDevices.getUserMedia(microphoneConstraints());watchMicrophoneEnd(firstRaw);
      const first=await filterReplacementMicrophone(firstRaw);
      serverVoiceRawStream=firstRaw;serverVoiceStream=first.stream;serverVoiceNoisePipeline=first.pipeline;joinedVoiceChannelId='c'.repeat(32);serverVoiceMuted=true;
      const lost=firstRaw.getAudioTracks()[0];lost.stop();lost.dispatchEvent(new Event('ended'));
      for(const until=Date.now()+5000;Date.now()<until&&serverVoiceRawStream===firstRaw;)await delay(25);
      while(microphoneSwap)await microphoneSwap;
      assert(serverVoiceRawStream!==firstRaw&&serverVoiceRawStream.getAudioTracks()[0].readyState==='live','server voice did not open a new microphone after the old one ended');
      const current=serverVoiceStream.getAudioTracks()[0];
      assert(peerSender.track===current&&sfuSender.track===current,'the new microphone was not sent to every voice peer and the SFU');
      assert(current.enabled===false,'a muted user was unmuted by the microphone swap');
      assert(!!serverVoiceNoisePipeline,'noise suppression was not rebuilt for the new microphone');
      assert(first.stream.getAudioTracks()[0].readyState==='ended','the old processed microphone track was left running');
      assert(/reconnected/i.test(deviceHint.textContent),'the user was not told the microphone reconnected: '+deviceHint.textContent);

      // 3. Changing the input device mid-call applies at once.
      const beforeSwitch=serverVoiceRawStream;inputDevice.dispatchEvent(new Event('change'));
      for(const until=Date.now()+5000;Date.now()<until&&serverVoiceRawStream===beforeSwitch;)await delay(25);
      while(microphoneSwap)await microphoneSwap;
      assert(serverVoiceRawStream!==beforeSwitch&&peerSender.track===serverVoiceStream.getAudioTracks()[0],'changing the input device mid-call did not switch the live microphone');

      stopVoiceNoisePipeline(serverVoiceNoisePipeline);for(const stream of [serverVoiceStream,serverVoiceRawStream])stream.getTracks().forEach(track=>track.stop());
      serverVoiceStream=null;serverVoiceRawStream=null;serverVoiceNoisePipeline=null;joinedVoiceChannelId='';serverPeers.clear();groupSfuPilot=null;
      return 'microphone recovery smoke passed';
    })()`);
    if (pageErrors.length) throw new Error('page errors: ' + pageErrors.join(' | '));
    console.log(result);
    app.exit(0);
  } catch (error) {
    fail(error);
  }
});
