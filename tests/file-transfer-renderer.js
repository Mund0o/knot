const path = require('path');
const { app, BrowserWindow } = require('electron');

function fail(error) {
  console.error('Renderer file-transfer state test failed:', error?.stack || error);
  app.exit(1);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    },
  });

  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'), { query: { testMode: '1' } });
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const assert=(condition,message)=>{if(!condition)throw new Error(message)};
      const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const waitFor=async(predicate,message,timeout=2000)=>{const until=performance.now()+timeout;while(performance.now()<until){if(predicate())return;await delay(5)}throw new Error(message)};
      const rejects=async(promise,pattern,message)=>{let error=null;try{await promise}catch(value){error=value}assert(error&&(!pattern||pattern.test(String(error?.message||error))),message||'expected rejection')};
      const controls=bus=>bus.sent.filter(value=>typeof value==='string').flatMap(value=>{try{return[JSON.parse(value)]}catch{return[]}});
      const makeBus=()=>({
        readyState:'open',bufferedAmount:0,bufferedAmountLowThreshold:0,sent:[],onSend:null,
        send(data){this.sent.push(data);this.onSend?.(data)},
        addEventListener(){},removeEventListener(){},
      });
      const directCalls=[];
      window.pairDirectFile={
        send:async(id,data)=>{directCalls.push({id,data})},
        close:id=>directCalls.push({close:id}),reset:()=>true,ack(){},
      };
      const bind=async(peer='alice')=>{
        abortCurrentFileSession('Test fixture reset');
        sendAbort.clear();outTransfers.clear();activeTransfers.clear();acceptWait.clear();completionWait.clear();acceptCards.clear();clearPendingFrames();
        messages.replaceChildren();sendQueue=Promise.resolve();receiveQueue=Promise.resolve();
        const bus=makeBus();
        pc={connectionState:'connected',sctp:{maxMessageSize:64*1024}};
        files=bus;chat=null;dmPeerId=peer;activePeerId=peer;activeServerId='';activeGroupDmId='';
        sharedKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
        directFileKey=crypto.getRandomValues(new Uint8Array(32));
        fileTransportMode='webrtc';remoteFileProtocol=2;CHUNK=negotiatedFileChunkSize(pc.sctp.maxMessageSize);
        delete window.pairSave;
        const session=currentFileSession(peer);
        assert(session&&liveFileSession(session),'fixture did not create a live file session');
        return{bus,session,context:{epoch:fileSessionEpoch,bus},peer};
      };

      // Installing the E2EE key must re-advertise v2 even if the channel opened
      // while a user was still comparing the fingerprint.
      {
        const savedAnnounce=announceFileCapabilities;
        let announced=0;
        announceFileCapabilities=()=>{announced++};
        try{
          directoryTrustedConnection=true;
          const local=await keyPair(),remote=await keyPair();
          assert(await derive(local,await exportPub(remote.publicKey)),'test ECDH derive failed');
          assert(announced===1,'derive did not announce file capabilities after installing sharedKey');
        }finally{announceFileCapabilities=savedAnnounce;directoryTrustedConnection=false}
      }

      // Control JSON stays on ordered WebRTC; only encrypted binary envelopes
      // may enter the native direct lane.
      {
        const fixture=await bind();
        assert(registerDirectFilePeer('native-1',fixture.session.epoch),'native lane did not register');
        await safeSend(JSON.stringify({t:'start',v:{}}),fixture.session);
        const binary=new Uint8Array([1,2,3]).buffer;
        assert(await busSafeSend(binary,fixture.session,'native-1')==='tcp','binary frame did not use the native lane');
        assert(typeof fixture.bus.sent[0]==='string','control packet left the WebRTC lane');
        assert(directCalls.some(call=>call.id==='native-1'&&call.data instanceof ArrayBuffer),'native lane did not receive the binary frame');
        await rejects(busSafeSend('{}',fixture.session,'native-1'),/controls cannot use/i,'TCP lane accepted JSON control data');
        await rejects(safeSend('x'.repeat(MAX_FILE_CONTROL_BYTES+1),fixture.session),/invalid file control/i,'oversized control was accepted');

        for(let index=2;index<=MAX_DIRECT_FILE_PEERS;index++)assert(registerDirectFilePeer('native-'+index,fixture.session.epoch),'valid bounded direct peer was rejected');
        assert(!registerDirectFilePeer('native-over-cap',fixture.session.epoch),'direct peer cap was not enforced');
        closeTcpLane();

        const report=new Map([
          ['pair-public',{id:'pair-public',type:'candidate-pair',state:'succeeded',selected:true,remoteCandidateId:'remote-public'}],
          ['pair-lan',{id:'pair-lan',type:'candidate-pair',state:'succeeded',nominated:false,remoteCandidateId:'remote-lan'}],
          ['pair-failed',{id:'pair-failed',type:'candidate-pair',state:'failed',remoteCandidateId:'remote-failed'}],
          ['remote-public',{id:'remote-public',type:'remote-candidate',address:'203.0.113.8'}],
          ['remote-lan',{id:'remote-lan',type:'remote-candidate',address:'192.168.50.9'}],
          ['remote-failed',{id:'remote-failed',type:'remote-candidate',address:'127.0.0.1'}],
        ]);
        pc.getStats=async()=>report;
        const addresses=await remoteTcpAddresses();
        assert(addresses.includes('203.0.113.8')&&addresses.includes('192.168.50.9'),'standard remote-candidate stats lost alternate TCP routes');
        assert(!addresses.includes('127.0.0.1'),'failed ICE pair influenced native TCP connection attempts');
      }

      // Selecting Bob while Alice owns the live channel must never reuse Alice's
      // session, and replacing the session must invalidate old async callbacks.
      {
        const fixture=await bind('alice');
        activePeerId='bob';
        assert(currentFileSession('bob')===null,'wrong recipient reused the current file channel');
        const before=fixture.bus.sent.length;
        await sendFile(new File([], 'wrong-peer.txt'),fixture.session,'bob');
        assert(fixture.bus.sent.length===before&&/different friend/i.test(pairHint.textContent),'wrong-peer send emitted data or hid the recipient mismatch');
        const staleContext=fixture.context,staleSession=fixture.session;
        abortCurrentFileSession('Connection replaced');
        await rejects(safeSend('{}',staleSession),/changed|disconnected/i,'stale session remained writable');
        const fresh=await bind('bob');
        let staleAccepted=false,staleSeq=fileSeq+100;
        acceptWait.set(staleSeq,{resolve:()=>{staleAccepted=true},reject:()=>{}});
        await onFileFrame({data:JSON.stringify({t:'accept',seq:staleSeq})},false,staleContext);
        assert(!staleAccepted,'stale data-channel context mutated the replacement session');
        acceptWait.delete(staleSeq);
        assert(liveFileSession(fresh.session),'replacement session was damaged by stale input');
      }

      // A blocked binary receive must not head-of-line block cancel/end/accept.
      {
        const fixture=await bind();
        const originalOnFileFrame=onFileFrame;
        let releaseBinary,binaryEnteredResolve,controlSeen=false;
        const binaryEntered=new Promise(resolve=>{binaryEnteredResolve=resolve});
        try{
          onFileFrame=async event=>{if(event.data instanceof ArrayBuffer){binaryEnteredResolve();await new Promise(resolve=>{releaseBinary=resolve})}else controlSeen=true};
          dispatchFileChannelFrame({data:new ArrayBuffer(8)},fixture.context);
          await binaryEntered;
          dispatchFileChannelFrame({data:JSON.stringify({t:'cancel',seq:1})},fixture.context);
          await delay(0);
          assert(controlSeen,'control frame waited behind a backpressured binary frame');
          releaseBinary();await receiveQueue;
        }finally{onFileFrame=originalOnFileFrame}
      }

      assert(FILE_ACCEPT_TIMEOUT===5*60*1000&&FILE_RECEIPT_TIMEOUT===10*60*1000,'human/save durability timeouts regressed');
      assert(negotiatedFileChunkSize(64*1024)<=64*1024-FILE_FRAME_RESERVE_BYTES,'64 KiB SCTP peer was given an oversized plaintext chunk');

      // Auto TCP probing happens alongside the human accept/save step. A dead
      // firewall port must not delay the offer card itself by five seconds, and
      // the resolved WebRTC fallback must be announced before binary chunks.
      {
        const fixture=await bind();fileTransportMode='auto';
        const realPrepare=prepareTcpLane;let resolveTcp,startSeen=false;
        try{
          prepareTcpLane=()=>new Promise(resolve=>{resolveTcp=resolve});
          const seq=fileSeq+1;
          fixture.bus.onSend=data=>{if(typeof data!=='string')return;let value;try{value=JSON.parse(data)}catch{return}if(value.t==='start'){startSeen=true;void onFileFrame({data:JSON.stringify({t:'accept',seq})},false,fixture.context)}if(value.t==='end'&&!value.cancelled)void onFileFrame({data:JSON.stringify({t:'complete',seq,size:0})},false,fixture.context)};
          await sendFile(new File([], 'auto-fallback.txt'),fixture.session,fixture.peer);
          await waitFor(()=>startSeen&&typeof resolveTcp==='function','file offer waited for auto TCP probing');
          assert(!controls(fixture.bus).some(value=>value.t==='end'&&value.seq===seq),'sender streamed before route probing settled');
          resolveTcp('');await sendQueue;
          assert(controls(fixture.bus).some(value=>value.t==='route'&&value.seq===seq&&value.transport==='webrtc'),'resolved auto fallback was not announced');
          assert([...messages.querySelectorAll('.transfer-status')].at(-1)?.textContent==='Delivered','auto WebRTC fallback did not finish');
        }finally{prepareTcpLane=realPrepare}
      }

      // Fast accept and completion replies are deliberately fired from inside
      // dataChannel.send(), in the same turn as start/end.
      {
        const fixture=await bind();
        const seq=fileSeq+1;
        fixture.bus.onSend=data=>{if(typeof data!=='string')return;let value;try{value=JSON.parse(data)}catch{return}if(value.t==='start')void onFileFrame({data:JSON.stringify({t:'accept',seq})},false,fixture.context);if(value.t==='end'&&!value.cancelled)void onFileFrame({data:JSON.stringify({t:'complete',seq,size:0})},false,fixture.context)};
        await sendFile(new File([], 'empty.txt'),fixture.session,fixture.peer);
        await sendQueue;
        const card=[...messages.querySelectorAll('.transfer')].at(-1);
        assert(card?.querySelector('.transfer-status')?.textContent==='Delivered','zero-byte fast accept/completion did not deliver');
        const sent=controls(fixture.bus).filter(value=>value.seq===seq||value.t==='start');
        assert(sent.some(value=>value.t==='start')&&sent.some(value=>value.t==='end'),'zero-byte transfer did not emit start/end');
        assert(!fixture.bus.sent.some(value=>value instanceof ArrayBuffer),'zero-byte transfer emitted a bogus chunk');
      }

      // A receipt is only authoritative when it reports the exact offered size.
      {
        const fixture=await bind();
        const seq=fileSeq+1,file=new File([new Uint8Array([7,8,9])],'receipt.bin');
        let wrongReceiptIgnored=false;
        fixture.bus.onSend=data=>{if(typeof data!=='string')return;let value;try{value=JSON.parse(data)}catch{return}if(value.t==='start')void onFileFrame({data:JSON.stringify({t:'accept',seq})},false,fixture.context);if(value.t==='end'&&!value.cancelled){void onFileFrame({data:JSON.stringify({t:'complete',seq,size:0})},false,fixture.context);wrongReceiptIgnored=completionWait.has(seq);void onFileFrame({data:JSON.stringify({t:'complete',seq,size:file.size})},false,fixture.context)}};
        await sendFile(file,fixture.session,fixture.peer);await sendQueue;
        assert(wrongReceiptIgnored,'mismatched durable receipt completed the transfer');
        assert([...messages.querySelectorAll('.transfer-status')].at(-1)?.textContent==='Delivered','matching durable receipt did not complete the transfer');
      }

      // Receiver save failure must reject the sender's durable wait.
      {
        const fixture=await bind();
        const seq=fileSeq+1;
        fixture.bus.onSend=data=>{if(typeof data!=='string')return;let value;try{value=JSON.parse(data)}catch{return}if(value.t==='start')void onFileFrame({data:JSON.stringify({t:'accept',seq})},false,fixture.context);if(value.t==='end'&&!value.cancelled)void onFileFrame({data:JSON.stringify({t:'save-failed',seq})},false,fixture.context)};
        await sendFile(new File([], 'save-fails.txt'),fixture.session,fixture.peer);await sendQueue;
        assert(/Failed: Friend could not save/i.test([...messages.querySelectorAll('.transfer-status')].at(-1)?.textContent||''),'save-failed was presented as delivered');
      }

      // Every queued read/encrypt job has a rejection observer, even when an
      // earlier job aborts the outer loop and leaves later jobs unawaited.
      {
        const fixture=await bind();remoteFileProtocol=1;CHUNK=MIN_FILE_CHUNK_BYTES;
        const seq=fileSeq+1,unhandled=[];
        const onUnhandled=event=>{unhandled.push(event.reason);event.preventDefault()};
        window.addEventListener('unhandledrejection',onUnhandled);
        fixture.bus.onSend=data=>{if(typeof data!=='string')return;try{const value=JSON.parse(data);if(value.t==='start')void onFileFrame({data:JSON.stringify({t:'accept',seq})},false,fixture.context)}catch{}};
        const badFile={name:'read-errors.bin',type:'application/octet-stream',size:CHUNK*3,slice(start){return{arrayBuffer:()=>new Promise((_,reject)=>setTimeout(()=>reject(new Error('read '+start)),start?20:0))}}};
        await sendFile(badFile,fixture.session,fixture.peer);await sendQueue;await delay(80);
        window.removeEventListener('unhandledrejection',onUnhandled);
        assert(unhandled.length===0,'abandoned crypto look-ahead emitted unhandled rejections');
      }

      // Hostile peers cannot turn byte budgets into millions of tiny JS objects.
      {
        const tracker=new IncomingRangeTracker(MIN_FILE_CHUNK_BYTES*2),transferState={protocol:2,chunkSize:MIN_FILE_CHUNK_BYTES,size:MIN_FILE_CHUNK_BYTES*2,tracker,frames:[],bufferedBytes:0,abort:false,_waiters:new Set()};
        let tinyRejected=false;try{reserveIncomingFrame(transferState,{offset:0,plainBytes:1,last:false})}catch{tinyRejected=true}
        assert(tinyRejected,'protocol v2 accepted a tiny chunk that violated negotiated chunkSize');
        const capped={protocol:2,chunkSize:MIN_FILE_CHUNK_BYTES,size:MIN_FILE_CHUNK_BYTES*4,frames:[],bufferedBytes:0,abort:false,_waiters:new Set(),tracker:{committed:0,ranges:{size:MAX_ACTIVE_RANGES_PER_TRANSFER,has:()=>false},reserve:()=>true}};
        let capRejected=false;try{reserveIncomingFrame(capped,{offset:0,plainBytes:MIN_FILE_CHUNK_BYTES,last:false})}catch{capRejected=true}
        assert(capRejected,'active incoming range object cap was not enforced');
      }

      // A hostile early frame is held before its encrypted offer can be
      // validated. If it contradicts the eventual chunk contract, accepting
      // the offer must close the just-opened save stream and release all maps.
      {
        const fixture=await bind(),seq=fileSeq+4000;
        let cancels=0;
        window.pairSave={start:async()=>({ok:true}),write:async()=>true,end:async()=>true,cancel:async()=>{cancels++;return true}};
        const encrypted=await sealBytes(new Uint8Array([1]),fixture.session.key);
        const early=packChunk(seq,0,new Uint8Array(encrypted.iv),new Uint8Array(encrypted.data),false);
        await onFileFrame({data:early},false,fixture.context);
        assert(pendingFrames.has(seq),'validly framed early chunk was not held');
        const v=await seal(JSON.stringify({name:'hostile-early.bin',size:MIN_FILE_CHUNK_BYTES,type:'application/octet-stream',seq,transport:'webrtc',protocol:2,receipt:true,chunkSize:MIN_FILE_CHUNK_BYTES}),fixture.session.key);
        await onFileFrame({data:JSON.stringify({t:'start',v})},false,fixture.context);
        await waitFor(()=>acceptCards.has(seq),'hostile early-frame offer did not reach acceptance');
        acceptCards.get(seq)(true);
        await waitFor(()=>controls(fixture.bus).some(value=>value.t==='cancel'&&value.seq===seq),'contradictory held frame did not fail closed');
        await waitFor(()=>cancels===1,'failed held frame did not cancel its native save stream');
        assert(!activeTransfers.has(seq)&&!pendingFrames.has(seq),'failed held frame leaked active or pending state');
      }

      const openIncoming=async(fixture,seq,endImpl)=>{
        const calls={writes:0,cancels:0};
        window.pairSave={start:async()=>({ok:true}),write:async()=>{calls.writes++;return true},end:endImpl,cancel:async()=>{calls.cancels++;return true}};
        const v=await seal(JSON.stringify({name:'incoming-'+seq+'.bin',size:0,type:'application/octet-stream',seq,transport:'webrtc',protocol:2,receipt:true,chunkSize:MIN_FILE_CHUNK_BYTES}),fixture.session.key);
        await onFileFrame({data:JSON.stringify({t:'start',v})},false,fixture.context);
        await waitFor(()=>acceptCards.has(seq),'incoming accept card did not appear');
        acceptCards.get(seq)(true);
        await waitFor(()=>activeTransfers.has(seq),'accepted incoming transfer did not activate');
        await waitFor(()=>controls(fixture.bus).some(value=>value.t==='accept'&&value.seq===seq),'receiver did not acknowledge acceptance');
        return{calls,transfer:activeTransfers.get(seq)};
      };

      // End dispatch is detached from a slow fsync/rename, so unrelated controls
      // remain responsive. Only an explicit true commit produces complete.
      {
        const fixture=await bind();
        let releaseCommit;
        const seq=fileSeq+1000;
        await openIncoming(fixture,seq,()=>new Promise(resolve=>{releaseCommit=()=>resolve(true)}));
        const started=performance.now();
        await onFileFrame({data:JSON.stringify({t:'end',seq})},false,fixture.context);
        assert(performance.now()-started<100,'end dispatcher awaited slow durable commit');
        await waitFor(()=>typeof releaseCommit==='function','durable commit did not start');
        let otherAccepted=false;const otherSeq=seq+1;
        acceptWait.set(otherSeq,{resolve:()=>{otherAccepted=true},reject:()=>{}});
        dispatchFileChannelFrame({data:JSON.stringify({t:'accept',seq:otherSeq})},fixture.context);
        await waitFor(()=>otherAccepted,'unrelated control blocked behind durable commit');acceptWait.delete(otherSeq);
        assert(activeTransfers.has(seq),'transfer vanished before durable commit');
        releaseCommit();
        await waitFor(()=>controls(fixture.bus).some(value=>value.t==='complete'&&value.seq===seq&&value.size===0),'successful zero-byte commit did not emit exact completion');
        await waitFor(()=>!activeTransfers.has(seq),'completed incoming transfer leaked state');
      }

      // A false IPC completion is a failed commit, not success.
      {
        const fixture=await bind();
        const seq=fileSeq+2000;
        const opened=await openIncoming(fixture,seq,async()=>false);
        const card=opened.transfer.el;
        await onFileFrame({data:JSON.stringify({t:'end',seq})},false,fixture.context);
        await waitFor(()=>controls(fixture.bus).some(value=>value.t==='save-failed'&&value.seq===seq),'false save completion did not notify sender');
        assert(!controls(fixture.bus).some(value=>value.t==='complete'&&value.seq===seq),'false save completion emitted success');
        assert(/Save failed/i.test(card.querySelector('.transfer-status').textContent),'false save completion was shown as received');
      }

      // Gap grace ignores work that is still decrypting/writing and restarts on
      // recent progress; a completed file without end remains bounded.
      {
        const now=Date.now(),fake={endSeen:true,tracker:{complete:false},frames:[],endAt:now-END_GAP_GRACE-100,lastActivity:now-5};
        assert(!incomingGapExpired(fake,1,now),'active disk/decrypt work was labeled a missing chunk');
        assert(!incomingGapExpired(fake,0,now),'recent late chunk did not extend end gap grace');
        fake.lastActivity=now-END_GAP_GRACE-100;
        assert(incomingGapExpired(fake,0,now),'truly idle missing range did not expire');

        const t={endSeen:false,tracker:new IncomingRangeTracker(0),frames:[],parts:[],received:0,bufferedBytes:0,size:0,seq:fileSeq+3000,session:null,saveMode:'mem',abort:false,writeError:null,stuck:null,lastActivity:Date.now(),_waiters:new Set(),el:transfer('missing-end.bin',0,'in')};
        t.writeQueue=makeWriteQueue(t);
        const realNow=Date.now,base=realNow();let shifted=false;
        const pending=processIncoming(t);
        await waitFor(()=>t._waiters.size>0,'completed file did not wait for end marker');
        Date.now=()=>base+END_MARKER_GRACE+1;shifted=true;wakeIncomingTransfer(t);
        await rejects(pending,/did not finish/i,'missing end marker did not expire');
        if(shifted)Date.now=realNow;
      }

      abortCurrentFileSession('Test complete');
      return 'renderer file-transfer state machine passed';
    })()`);
    console.log(result);
    window.destroy();
    app.quit();
  } catch (error) {
    try { window.destroy(); } catch {}
    fail(error);
  }
}).catch(fail);
