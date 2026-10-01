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
      directorySend=()=>true;
      await connectDirectory();
      assert(socket&&typeof socket.onmessage==='function','could not capture the directory socket handler');
      const deliver=async request=>{await socket.onmessage({data:JSON.stringify(request)});await tick()};

      const savedPair=automaticPair;
      const asked=[];
      automaticPair=async(kind,session,from)=>{asked.push({kind,session,from})};

      // A call with Alice is live on this device. Her re-pair must be answered,
      // or a joiner that has to reconnect is ignored and can never attach a mic.
      dmCallPeerId=friendId;callActive=true;friendInCall=true;pc=null;signaling=null;
      await deliver({type:'connect-request',from:friendId,session:'S1',context:{type:'dm',relay:false}});
      assert(asked.length===1&&asked[0].kind==='join'&&asked[0].from===friendId,
        'the caller ignored a re-pair from the peer it is already calling, so the joiner could never attach its mic');

      // A connect-request from an unrelated peer during a live call stays
      // refused: that would tear down a call the user did not ask to end.
      asked.length=0;
      await deliver({type:'connect-request',from:otherId,session:'S2',context:{type:'dm',relay:false}});
      assert(asked.length===0,'a connect-request from an unrelated peer tore down a live call');

      // Same-session glare: the lower-id side keeps its current room and does
      // not join a duplicate connect from the same peer.
      const savedSelf=directoryUserId,savedRole=role;
      directoryUserId='00000000000000000000000000000000';
      asked.length=0;callActive=false;friendInCall=false;dmCallPeerId='';
      dmConnectingPeerId=friendId;pairRoom='S3';role='join';
      pc={connectionState:'connecting',signalingState:'stable',close(){}};
      signaling={readyState:1,close(){},onopen:null,onerror:null,onmessage:null};
      await deliver({type:'connect-request',from:friendId,session:'S3',context:{type:'dm',relay:false}});
      assert(asked.length===0,'same-session glare from the higher-id peer was not dropped');

      // A later retry or TURN session must still be joined by the lower-id joiner.
      asked.length=0;
      await deliver({type:'connect-request',from:friendId,session:'S4TURNSESSIONVALUE0001',context:{type:'dm',relay:false}});
      assert(asked.length===1&&asked[0].kind==='join'&&asked[0].session==='S4TURNSESSIONVALUE0001',
        'a new session connect-request was dropped as glare: '+JSON.stringify(asked));

      // The lower-id host still refuses a competing connect while it is hosting.
      asked.length=0;role='host';
      await deliver({type:'connect-request',from:friendId,session:'S5TURNSESSIONVALUE0001',context:{type:'dm',relay:false}});
      assert(asked.length===0,'the lower-id host joined a competing session instead of keeping its own');
      directoryUserId=savedSelf;role=savedRole;pc=null;signaling=null;pairRoom='';dmConnectingPeerId='';

      pendingVoiceStartPeerId=friendId;dmPeerId=friendId;dmCallPeerId=friendId;
      disconnectRoom({preserveCall:true});
      assert(pendingVoiceStartPeerId===friendId,'preserveCall cleared the pending voice start');
      assert(dmCallPeerId===friendId,'preserveCall cleared the live call peer');
      pendingVoiceStartPeerId='';dmCallPeerId='';dmPeerId='';

      // Joining from the friends list, before this device ever opened the DM,
      // must reach the calling peer instead of stalling on no connection.
      asked.length=0;callActive=false;friendInCall=false;dmCallPeerId=friendId;
      const savedEnsure=ensureDmMediaConnection;
      const savedPlay=playSound;
      const ensured=[];
      ensureDmMediaConnection=async peerId=>{ensured.push(peerId);return null};
      playSound=()=>{};
      activePeerId='';dmPeerId='';
      await startCall();
      await tick();
      assert(ensured.length===1&&ensured[0]===friendId,
        'joining a friend call from the friends list did not reach the calling peer');

      // No peer at all must say so instead of parking on a dead button.
      ensured.length=0;dmCallPeerId='';
      await startCall();
      await tick();
      assert(ensured.length===0,'join attempted with no peer to join');
      assert(callBtn.disabled===false,'the call button stayed disabled with no peer to join');
      assert(/Open this conversation/.test(callStatus.textContent),
        'joining with no peer gave no guidance: '+callStatus.textContent);

      automaticPair=savedPair;ensureDmMediaConnection=savedEnsure;playSound=savedPlay;
      window.WebSocket=RealWebSocket;
      callActive=false;friendInCall=false;dmCallPeerId='';activePeerId='';dmPeerId='';
      return {answeredCaller:true,refusedStranger:true,joinedFromFriendsList:true,noPeerGuidance:true};
    })()`, true);
    console.log('PASS dm call join', JSON.stringify(result));
    window.destroy();
    app.quit();
  } catch (error) {
    window.destroy();
    fail(error);
  }
});
