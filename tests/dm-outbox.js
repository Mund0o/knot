const path = require('path');
const { app, BrowserWindow } = require('electron');

function fail(error) {
  console.error(error?.stack || error);
  app.exit(1);
}

// A direct message typed on an unstable connection must never vanish: it is
// shown at once, kept until the directory confirms it, sent again after a
// reconnect (also after a restart), and shown only once on the receiving side.
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
      const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const waitFor=async(check,message,timeout=4000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(25)}throw new Error(message)};
      const selfId='cccccccccccccccccccccccccccccccc',friendId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      const sockets=[];
      window.WebSocket=class FakeSocket{
        static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
        constructor(){this.readyState=1;this.sent=[];sockets.push(this)}
        send(value){this.sent.push(value)}
        close(){this.readyState=3}
      };
      const relayed=socket=>socket.sent.map(value=>JSON.parse(value)).filter(value=>value.type==='relay-text');
      // No username: an account name would be saved and change later tests.
      const authenticate=async socket=>{await socket.onopen?.();await socket.onmessage({data:JSON.stringify({type:'authenticated',features:{}})})};
      const deliver=async(socket,value)=>{await socket.onmessage({data:JSON.stringify(value)});await delay(50)};

      // Finish the app's own startup connection, then go offline.
      await connectDirectory();
      const goOffline=()=>{clearTimeout(directoryReconnect);const socket=directorySocket;directorySocket=null;directoryAuthenticatedSocket=null;if(socket){socket.onclose=null;socket.close?.()}};
      goOffline();
      // Earlier tests can leave unconfirmed messages behind in this profile.
      dmOutbox.clear();dmOutboxLoaded=null;await ssSet('dmOutbox',null);
      directoryUserId=selfId;
      // The friend's device key is our own: the pair key is symmetric, so this
      // test can also play the friend's side.
      const friend={id:friendId,name:'Alice',image:'',online:false,deviceKey:await devicePublicKey()};
      directorySnapshot={friends:[friend],members:{[friendId]:friend},self:{id:selfId,name:'Tester',image:'',online:true},voiceStates:{},servers:[],groupDms:[]};
      await selectFriend(friendId,{connect:false});
      syncActiveDmTransport();
      assert(!messageInput.disabled&&!messageForm.querySelector('.send').disabled,'the message box is disabled while Knot is offline');
      assert(/offline/i.test(statusText.textContent),'the DM header does not say Knot is offline: '+statusText.textContent);

      // 1. Typed offline: shown at once, waiting, and saved.
      messageInput.value='hello from a train';messageForm.requestSubmit();
      await waitFor(()=>dmOutbox.size===1,'an offline message was not queued: '+pairHint.textContent);
      const first=[...dmOutbox.keys()][0];
      let element=dmMessageElement(first);
      assert(element&&element.classList.contains('pending'),'the queued message is not shown as pending');
      assert(/Waiting for connection/.test(element.querySelector('.message-pending')?.textContent||''),'the queued message does not say it is waiting for a connection');
      assert(messageInput.value==='','the message box was not cleared after queueing');
      assert(JSON.parse(await ss('dmOutbox')).some(entry=>entry.id===first),'the queued message was not saved');

      // 2. Restart, then reconnect: the saved message is sent with its id.
      dmOutbox.clear();dmOutboxLoaded=null;
      await connectDirectory();
      const s1=sockets.at(-1);
      await authenticate(s1);
      await waitFor(()=>relayed(s1).some(value=>value.id===first),'the queued message was not sent after reconnecting');
      const sent=relayed(s1).find(value=>value.id===first);
      assert(sent.peerId===friendId&&sent.requestId===first&&sent.scope==='dm','the resent envelope is wrong: '+JSON.stringify(sent));
      element=dmMessageElement(first);
      assert(/Sending/.test(element?.querySelector('.message-pending')?.textContent||''),'a sent but unconfirmed message is not shown as sending');

      // 3. The directory confirms it.
      await deliver(s1,{type:'relay-status',id:first,queued:true});
      assert(!dmOutbox.has(first),'a confirmed message stayed in the outbox');
      assert(!dmMessageElement(first).classList.contains('pending')&&!dmMessageElement(first).querySelector('.message-pending'),'a confirmed message still looks pending');
      assert(!JSON.parse(await ss('dmOutbox')).length,'a confirmed message stayed saved');

      // 4. A half-open socket that never answers: reconnect and resend.
      messageInput.value='are you there';messageForm.requestSubmit();
      await waitFor(()=>dmOutbox.size===1,'the second message was not queued');
      const second=[...dmOutbox.keys()][0];
      assert(relayed(s1).some(value=>value.id===second),'the second message was not sent on the open socket');
      const socketCount=sockets.length;
      await delay(10500);
      assert(directorySocket!==s1,'a socket that never acknowledged a message was kept');
      await waitFor(()=>sockets.length>socketCount,'Knot did not reconnect after an unacknowledged message',4000);
      const s2=sockets.at(-1);
      await authenticate(s2);
      await waitFor(()=>relayed(s2).some(value=>value.id===second),'the unacknowledged message was not resent after reconnecting');
      await deliver(s2,{type:'relay-status',id:second,queued:false});
      assert(!dmOutbox.size,'the resent message was not confirmed');

      // 5. The directory refuses it: shown as not delivered, no retry loop.
      messageInput.value='refused';messageForm.requestSubmit();
      await waitFor(()=>dmOutbox.size===1,'the third message was not queued');
      const third=[...dmOutbox.keys()][0];
      await deliver(s2,{type:'error',action:'relay-text',requestId:third,message:'direct-message recipient is not a friend'});
      assert(!dmOutbox.has(third),'a refused message stays in the outbox and would be retried forever');
      assert(dmMessageElement(third)?.classList.contains('failed')&&/Not delivered/.test(dmMessageElement(third).querySelector('.message-pending')?.textContent||''),'a refused message is not shown as not delivered');

      // 6. The friend's resend of a message we already have shows only once,
      // even after a restart cleared the in-memory seen list.
      const incoming=clientHex(16),cipher=await sealRelay(await relayPairKey(friendId),chatPayload('only once',null),relayAad('dm',incoming,friendId,selfId));
      const before=messages.querySelectorAll('.message').length;
      await deliver(s2,{type:'relay-text',scope:'dm',from:friendId,id:incoming,cipher});
      await waitFor(()=>messages.querySelectorAll('.message').length===before+1,'an incoming message was not shown');
      seenRelayMessages.clear();
      await deliver(s2,{type:'relay-text',scope:'dm',from:friendId,id:incoming,cipher});
      await delay(150);
      assert(messages.querySelectorAll('.message').length===before+1,'a resent incoming message was shown twice');
      assert(s2.sent.map(value=>JSON.parse(value)).filter(value=>value.type==='relay-ack'&&value.id===incoming).length===2,'a duplicate incoming message was not acknowledged');
      // 7. A reconnecting call probes the directory: a socket that stays
      // silent is replaced at once, one that answers is kept.
      probeDirectory(300);await delay(450);
      assert(directorySocket!==s2,'a directory socket that ignored the probe was kept');
      await waitFor(()=>sockets.at(-1)!==s2,'Knot did not reconnect after a failed directory probe',4000);
      const s3=sockets.at(-1);await authenticate(s3);
      probeDirectory(300);await deliver(s3,{type:'pong'});await delay(400);
      assert(directorySocket===s3,'a directory socket that answered the probe was replaced');
      await ssSet('dmOutbox',null);
      return 'dm outbox smoke passed';
    })()`);
    console.log(result);
    app.exit(0);
  } catch (error) {
    fail(error);
  }
});
