const path = require('path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

function fail(error) {
  console.error(error?.stack || error);
  app.exit(1);
}

// The real app code with its LAN transport, against a stand-in friend built from the same link module. Nothing
// here may go through the directory: a Wi-Fi link signals only over the Wi-Fi socket.
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: process.env.KNOT_ELECTRON_SMOKE_X11 === '1',
    opacity: process.env.KNOT_ELECTRON_SMOKE_X11 === '1' ? 0 : 1,
    skipTaskbar: process.env.KNOT_ELECTRON_SMOKE_X11 === '1',
    width: 900,
    height: 700,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: process.env.KNOT_ELECTRON_SMOKE_X11 !== '1' },
  });
  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const assert=(condition,message)=>{if(!condition)throw new Error(message)};
      const until=async(predicate,message,ms=15000)=>{const stop=Date.now()+ms;while(Date.now()<stop){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25))}throw new Error(message)};
      const selfId='cccccccccccccccccccccccccccccccc',friendId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const friend={id:friendId,name:'Alice',image:'',online:true};
      directoryUserId=selfId;
      directorySnapshot={friends:[friend],members:{[selfId]:{id:selfId,name:'Tester',image:'',online:true},[friendId]:friend},self:{id:selfId,name:'Tester',image:'',online:true},voiceStates:{},servers:[],groupDms:[]};
      const directorySignals=[];
      directorySend=value=>{if(value.type==='signal')directorySignals.push(value);return true};
      const frames=[];
      const SOCKET={id:'sock1',friendId,authed:true,host:'192.168.50.7',localAddress:'192.168.50.5',port:4000};

      // ---- the stand-in friend: its own hub, wired to the app only through LAN frames
      const {CallLink,LinkHub}=window.KnotCallLink;
      const friendKeys=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
      const friendPub=await crypto.subtle.exportKey('jwk',friendKeys.publicKey);
      const contexts=[];
      const toApp=message=>acceptLanSignal(SOCKET,message.kind==='candidate'?{t:'candidate',candidate:message.candidate}:{t:message.kind,sdp:message.sdp});
      const friendHub=new LinkHub({selfId:friendId,create:options=>new CallLink({
        RTCPeerConnection,iceServers:[],localPub:{kty:'EC',crv:'P-256',x:friendPub.x,y:friendPub.y},signal:message=>{toApp(message);return true},
        setup:(pc,self)=>{
          const context=new AudioContext();contexts.push(context);
          for(let index=0;index<2;index++){const destination=context.createMediaStreamDestination();pc.addTrack(destination.stream.getAudioTracks()[0],destination.stream)}
          self.chat=pc.createDataChannel('chat',{negotiated:true,id:0});self.files=pc.createDataChannel('files',{negotiated:true,id:1});
        },...options})});
      lanSend=(id,value)=>{
        frames.push(value);
        queueMicrotask(()=>friendHub.receive(selfId,value.t==='candidate'?{kind:'candidate',candidate:value.candidate}:{kind:value.t,sdp:value.sdp}));
        return true;
      };
      lanSockets.set(SOCKET.id,SOCKET);
      lanNeighbors.set(friendId,{host:SOCKET.host,port:SOCKET.port,socketId:SOCKET.id,authed:true,at:Date.now()});
      assert(lanPathReady(friendId),'the Wi-Fi path was not recognised as ready');
      const connected=()=>linkHub.current?.state==='connected'&&friendHub.current?.state==='connected'&&chat?.readyState==='open'&&friendHub.current.chat?.readyState==='open';

      // ---- I call over Wi-Fi: the app offers, the friend answers, nothing touches the directory
      const link=prepareCallLink(friendId);
      assert(link&&link.via==='lan','a friend on the Wi-Fi was not given a Wi-Fi link: '+link?.via);
      await until(connected,'the Wi-Fi link never connected');
      assert(pc._lan===true&&pc===linkHub.current.pc,'the connection is not marked as a Wi-Fi one');
      assert(directorySignals.length===0,'a Wi-Fi link signalled through the directory: '+JSON.stringify(directorySignals.slice(0,2)));
      assert(frames.some(frame=>frame.t==='offer'&&/a=knot-link:/.test(frame.sdp)&&/a=knot-pub:/.test(frame.sdp)),'the offer over Wi-Fi carries no link id or key');
      assert(!frames.some(frame=>frame.t==='candidate'&&/\\.local/.test(frame.candidate.candidate)),'a .local candidate name leaked over Wi-Fi unrewritten');
      await until(()=>!!sharedKey,'the key from the Wi-Fi offer was never derived');

      // ---- the friend calls over Wi-Fi: its offer arrives as a LAN frame and the app answers over the same socket
      linkHub.drop();friendHub.drop();frames.length=0;sharedKey=null;
      friendHub.ensure(selfId).start();
      await until(connected,'an incoming Wi-Fi link never connected');
      assert(linkHub.current.via==='lan'&&!linkHub.current.creator,'the answering side did not adopt the Wi-Fi link');
      assert(frames.some(frame=>frame.t==='answer'),'the app answered somewhere other than the Wi-Fi socket');
      assert(directorySignals.length===0,'an incoming Wi-Fi link answered through the directory');

      // ---- a Wi-Fi link that never comes up falls back to the internet path
      linkHub.drop();friendHub.drop();frames.length=0;
      lanSend=()=>true;                                  // the friend is unreachable over Wi-Fi
      const stuck=prepareCallLink(friendId);
      assert(stuck.via==='lan','expected a Wi-Fi attempt first');
      await until(()=>linkHub.current&&linkHub.current!==stuck&&linkHub.current.via==='directory',"the unreachable Wi-Fi link was not replaced by an internet one",9000);
      assert(directorySignals.some(value=>value.payload?.kind==='offer'),'the fallback never offered over the directory');

      linkHub.drop();friendHub.drop();contexts.forEach(context=>context.close());
      return {viaWifi:true,answeredOverWifi:true,fellBackToInternet:true};
    })()`, true);
    console.log('PASS lan call link', JSON.stringify(result));
    window.destroy();
    app.quit();
  } catch (error) {
    window.destroy();
    fail(error);
  }
});
