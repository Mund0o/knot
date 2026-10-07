const path = require('path');
const { app, BrowserWindow } = require('electron');

function fail(error) {
  console.error(error?.stack || error);
  app.exit(1);
}

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
      offscreen: process.env.KNOT_ELECTRON_SMOKE_X11 !== '1',
    },
  });

  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const assert=(condition,message)=>{if(!condition)throw new Error(message)};
      const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
      const until=async(predicate,message,ms=6000)=>{const stop=Date.now()+ms;while(Date.now()<stop){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25))}throw new Error(message)};
      const selfId='cccccccccccccccccccccccccccccccc';
      const friendId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const otherId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const friend={id:friendId,name:'Alice',image:'',online:true};
      const other={id:otherId,name:'Bob',image:'',online:true};
      directoryUserId=selfId;
      directorySnapshot={
        friends:[friend,other],
        members:{[selfId]:{id:selfId,name:'Tester',image:'',online:true},[friendId]:friend,[otherId]:other},
        self:{id:selfId,name:'Tester',image:'',online:true},
        voiceStates:{},servers:[],groupDms:[],
      };

      // Re-open the directory against a fake socket so a test can deliver real
      // directory messages through the app's own onmessage handler.
      const RealWebSocket=window.WebSocket;
      let socket=null;
      window.WebSocket=class FakeSocket{
        constructor(){this.readyState=1;this.sent=[];socket=this}
        send(value){this.sent.push(value)}
        close(){}
      };
      directorySocket=null;
      const sent=[];
      directorySend=value=>{sent.push(value);return true};
      await connectDirectory();
      assert(socket&&typeof socket.onmessage==='function','could not capture the directory socket handler');
      const deliver=async request=>{await socket.onmessage({data:JSON.stringify(request)});await tick()};
      const presence=()=>sent.filter(value=>value.type==='call-presence');

      const savedMic=acquireCallMicrophone,savedPlay=playSound;
      const micContext=new AudioContext(),micDestination=micContext.createMediaStreamDestination();
      acquireCallMicrophone=async()=>micDestination.stream;
      playSound=()=>{};
      const FRIEND_SESSION='k2'+'a'.repeat(12);

      // The friend rings while this device never opened their DM: the controller knows, the screen says so,
      // and the button offers to join.
      activePeerId='';dmPeerId='';dmCallPeerId='';friendInCall=false;
      await deliver({type:'call-presence',from:friendId,active:true,session:FRIEND_SESSION});
      assert(callControl.remoteActive(friendId)&&friendInCall&&dmCallPeerId===friendId,'a ring from a friend was not noticed');
      assert(/Alice is calling/.test(callStatus.textContent)&&callBtn.title==='Join voice call','the ring did not offer to join: '+callStatus.textContent+' / '+callBtn.title);

      // A ring from an older Knot cannot be joined, and the user is told instead of left waiting.
      await deliver({type:'call-presence',from:otherId,active:true,session:'0123456789abcdef'});
      assert(!callControl.remoteActive(otherId),'a call from an older Knot was treated as joinable');
      assert(/older Knot/.test(pairHint.textContent),'nobody was told the friend runs an older Knot: '+pairHint.textContent);

      // One press from the friends list joins that call: same session, presence published, connection started.
      sent.length=0;
      pressCall();
      await until(()=>callActive&&!callStarting,'the join did not finish');
      assert(callControl.inCall&&callControl.peer===friendId&&callControl.session===FRIEND_SESSION,'the join did not adopt the friend\\'s call: '+callControl.peer+' '+callControl.session);
      assert(presence().some(value=>value.peerId===friendId&&value.active===true&&value.session===FRIEND_SESSION),'joining did not tell the friend: '+JSON.stringify(presence()));
      await until(()=>sent.some(value=>value.type==='signal'&&value.peerId===friendId&&value.payload?.kind==='offer'),'no connection offer went to the friend');
      const offer=sent.find(value=>value.type==='signal'&&value.payload?.kind==='offer');
      assert(/a=knot-link:[a-f0-9]{16}/.test(offer.payload.sdp)&&/a=knot-pub:/.test(offer.payload.sdp),'the offer carries no link id or encryption key');
      assert(offer.context?.type==='dm','the offer was not sent as a direct-message signal');
      assert(linkHub.current?.peerId===friendId&&pc===linkHub.current.pc&&dmPeerId===friendId,'the app is not using the link\\'s connection');
      assert(chat?.label==='chat'&&chat.negotiated&&files?.label==='files'&&files.negotiated,'the data channels are not pre-negotiated');

      // A second friend ringing during this call is remembered but never steals the call.
      await deliver({type:'call-presence',from:otherId,active:true,session:'k2'+'b'.repeat(12)});
      assert(callControl.remoteActive(otherId)&&callControl.peer===friendId&&dmCallPeerId===friendId,'a second ring took over the call in progress');
      await deliver({type:'call-presence',from:otherId,active:false,session:'k2'+'b'.repeat(12)});

      // A lower session from the same friend (both started at once) is adopted and repeated.
      sent.length=0;const LOWER='k2'+'0'.repeat(12);
      await deliver({type:'call-presence',from:friendId,active:true,session:LOWER});
      assert(callControl.session===LOWER,'the lower of two simultaneous calls was not adopted');
      assert(presence().some(value=>value.active===true&&value.session===LOWER),'the adopted session was not repeated to the friend');

      // Hanging up tells the friend, releases the microphone and leaves the connection for the next call.
      sent.length=0;
      await endCall(false);
      assert(!callControl.inCall&&!callActive&&!localStream,'hanging up left the call or the microphone active');
      assert(presence().some(value=>value.peerId===friendId&&value.active===false&&value.session===LOWER),'hanging up did not tell the friend: '+JSON.stringify(presence()));
      assert(linkHub.current?.peerId===friendId,'hanging up threw away the connection a redial could reuse');

      // The status line and button are shared with group and server calls: DM call events must not repaint them there.
      activeServerId='dddddddddddddddddddddddddddddddd';callStatus.textContent='Group call connected';renderCallButtonState('end','Leave call','Leave group call');
      renderCallStatus();handleCallControlEvent({type:'ring-ended',peer:otherId});
      assert(callStatus.textContent==='Group call connected'&&callBtn.title==='Leave group call','a DM call event repainted the group call controls: '+callStatus.textContent+' / '+callBtn.title);
      activeServerId='';

      // With nobody to call, a press says so and the button stays usable.
      linkHub.drop();pc=null;activePeerId='';dmPeerId='';dmCallPeerId='';friendInCall=false;
      callControl.receive(friendId,false,'');callControl.receive(otherId,false,'');
      pressCall();await tick();
      assert(/Open a conversation/.test(callStatus.textContent),'pressing with nobody to call gave no guidance: '+callStatus.textContent);
      assert(callBtn.disabled===false,'the call button stayed disabled with no peer to call');

      acquireCallMicrophone=savedMic;playSound=savedPlay;window.WebSocket=RealWebSocket;
      linkHub.drop();micContext.close();
      return {noticedRing:true,olderKnotExplained:true,joinedFromFriendsList:true,negotiatedChannels:true,keptOwnCall:true,mergedGlare:true,hangUpPublished:true,groupControlsUntouched:true,noPeerGuidance:true};
    })()`, true);
    console.log('PASS dm call join', JSON.stringify(result));
    window.destroy();
    app.quit();
  } catch (error) {
    window.destroy();
    fail(error);
  }
});
