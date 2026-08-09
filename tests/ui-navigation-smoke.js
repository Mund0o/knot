const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

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
      directorySnapshot={friends:[{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:'Alice',image:'',online:true},{id:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',name:'Bob',image:'',online:false}],members:{},servers:[]};renderFriends();assert(document.querySelectorAll('#friendList .friend-entry').length===2,'direct-message rows did not render');assert(document.querySelector('#friendList .friend-copy small').textContent==='Online','presence label did not render');const search=document.querySelector('#friendSearch');search.value='ali';search.dispatchEvent(new Event('input',{bubbles:true}));assert(document.querySelectorAll('#friendList .friend-entry').length===1,'conversation search did not filter friends');search.value='';renderFriends();
      const selfId='cccccccccccccccccccccccccccccccc',friendId='dddddddddddddddddddddddddddddddd',serverId='11111111111111111111111111111111',generalId='22222222222222222222222222222222',rulesId='33333333333333333333333333333333',voiceId='44444444444444444444444444444444';directoryUserId=selfId;directorySnapshot={friends:[],members:{[selfId]:{id:selfId,name:'Tester',image:'',online:true},[friendId]:{id:friendId,name:'Friend',image:'',online:false}},self:{id:selfId,name:'Tester',image:'',online:true},voiceStates:{},servers:[{id:serverId,name:'Test Server',picture:'',owner:selfId,members:[selfId,friendId],channels:[{id:generalId,type:'text',name:'general'},{id:rulesId,type:'text',name:'rules'},{id:voiceId,type:'voice',name:'Lounge'}]}]};let sent=[];directorySend=value=>{sent.push(value);return true};renderServers();const server=document.querySelector('#serverList .rail-button');assert(server&&server.textContent==='TE','server icon was not rendered below P');server.click();assert(!document.querySelector('#serverNavigation').hidden&&document.querySelector('#friendsNavigation').hidden,'server click did not switch Friends to channels');assert(document.querySelectorAll('#textChannelList .channel-item').length===2&&document.querySelectorAll('#voiceChannelList .channel-item').length===1,'text and voice channels were not grouped');
      document.querySelector('#addTextChannel').click();const channelDialog=document.querySelector('#channelDialog');assert(channelDialog.open,'text channel plus did not open the channel dialog');document.querySelector('#newChannelName').value='updates';document.querySelector('#channelForm').requestSubmit();assert(sent.at(-1)?.type==='create-channel'&&sent.at(-1)?.channelType==='text','text channel creation was not sent');pendingChannelCreation=null;channelDialog.close();
      document.querySelector('#textChannelList .channel-remove').click();assert(sent.at(-1)?.type==='delete-channel','channel deletion was not sent');moveChannel(rulesId,generalId,false);assert(sent.at(-1)?.type==='reorder-channels'&&sent.at(-1).channelIds[0]===rulesId,'channel reorder was not sent');
      selectServerChannel(serverId,generalId);sendServerMessage('saved locally',null);const local=conversationHistories['server:'+serverId+':'+generalId]?.at(-1);assert(local?.id&&local.author?.id===selfId&&local.mine,'local server message was not stored canonically');const fakeChannel={readyState:'open',sent:[],send(value){this.sent.push(JSON.parse(value))}};wireServerChannel(friendId,fakeChannel,serverId);fakeChannel.onopen();assert(fakeChannel.sent[0]?.t==='server-history-request','history was not requested when the peer opened');fakeChannel.onmessage({data:JSON.stringify({t:'server-history',serverId,channelId:rulesId,entries:[{id:'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',text:'older server message',author:{id:friendId,name:'Friend'},time:Date.now()-1000}]})});assert(conversationHistories['server:'+serverId+':'+rulesId]?.some(item=>item.text==='older server message'),'history from another channel was not retained');selectServerChannel(serverId,rulesId);assert(document.querySelector('#messages').textContent.includes('older server message'),'synced channel history was not rendered');
      const editCount=sent.length;directorySnapshot.servers[0].owner=friendId;renderChannels();assert(document.querySelector('#addTextChannel').hidden&&document.querySelector('#editServerPicture').hidden,'server editing controls were shown to a non-owner');assert(!document.querySelector('#textChannelList .channel-remove')&&!document.querySelector('#textChannelList .channel-item').draggable,'non-owner channel editing remained available');moveChannel(generalId,rulesId,false);assert(sent.length===editCount,'a non-owner could reorder channels');directorySnapshot.servers[0].owner=selfId;renderChannels();
      navigator.mediaDevices.getUserMedia=async()=>({getAudioTracks:()=>[{enabled:false,stop(){}}],getTracks:()=>[{stop(){}}]});const voiceButton=document.querySelector('#voiceChannelList .channel-entry');voiceButton.click();assert(!serverVoiceStream,'single click joined voice');voiceButton.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,20));assert(joinedVoiceChannelId===voiceId&&document.querySelector('#voiceChannelList .voice-channel-member'),'double click did not join voice or render its member');stopServerVoice();
      return {dialog:true,collapse:true,resize:[before,after],friendSearch:true,serverRail:true,channelCreate:true,channelDelete:true,channelReorder:true,historySync:true,ownerControls:true,doubleClickVoice:true};
    })()`, true);
    if (process.env.PAIR_UI_SCREENSHOT) {
      if (process.env.PAIR_UI_SCREENSHOT_VIEW === 'server') await window.webContents.executeJavaScript(`(()=>{const selfId='cccccccccccccccccccccccccccccccc',friendId='dddddddddddddddddddddddddddddddd',serverId='11111111111111111111111111111111',generalId='22222222222222222222222222222222',rulesId='33333333333333333333333333333333',voiceId='44444444444444444444444444444444';directoryUserId=selfId;directorySnapshot={friends:[],self:{id:selfId,name:'Mundo',image:'',online:true},members:{[selfId]:{id:selfId,name:'Mundo',image:'',online:true},[friendId]:{id:friendId,name:'Purplepelican',image:'',online:true}},voiceStates:{[voiceId]:[{id:selfId,joinedAt:Date.now()-6529000},{id:friendId,joinedAt:Date.now()-180000}]},servers:[{id:serverId,name:'RJVS',picture:'',owner:selfId,members:[selfId,friendId],channels:[{id:generalId,type:'text',name:'general'},{id:rulesId,type:'text',name:'memes'},{id:voiceId,type:'voice',name:'Vibin'}]}]};selectServer(serverId);selectServerChannel(serverId,generalId)})()`);
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
