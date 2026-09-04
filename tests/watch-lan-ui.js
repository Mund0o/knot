'use strict';

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
    width: 1100,
    height: 760,
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
      const selfId='cccccccccccccccccccccccccccccccc';
      const friendId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const serverId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const textId='dddddddddddddddddddddddddddddddd';
      const voiceId='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      directoryUserId=selfId;
      directorySnapshot={
        friends:[{id:friendId,name:'Alice',image:'',online:true,deviceKey:null}],
        members:{
          [selfId]:{id:selfId,name:'Tester',image:'',online:true},
          [friendId]:{id:friendId,name:'Alice',image:'',online:true},
        },
        self:{id:selfId,name:'Tester',image:'',online:true},
        voiceStates:{[voiceId]:[{id:friendId,joinedAt:Date.now()}]},
        servers:[{id:serverId,name:'House',owner:selfId,members:[selfId,friendId],channels:[{id:textId,type:'text',name:'chat'},{id:voiceId,type:'voice',name:'Living room'}]}],
        groupDms:[],
      };
      directorySend=()=>true;
      showFriends({expand:false});
      showFriendsLanding();
      assert(document.getElementById('watchTogether'),'watch together panel is missing');
      assert(typeof KnotWatchTogether==='object'&&KnotWatchTogether.youtubeVideoId('https://youtu.be/dQw4w9WgXcQ')==='dQw4w9WgXcQ','watch-together helper is not loaded');
      const embed=KnotWatchTogether.watchEmbedUrl('dQw4w9WgXcQ',{start:12,playing:true});
      assert(embed.includes('youtube-nocookie.com')&&embed.includes('autoplay=1')&&embed.includes('start=12'),'watch embed is not privacy-preserving');
      assert(typeof playSound==='function'&&typeof mallet==='function','catchy ring helpers are missing');

      await selectServer(serverId);
      const voiceButton=[...document.querySelectorAll('.channel-entry.voice')].find(button=>button.textContent.includes('Living room'));
      assert(voiceButton,'voice channel is missing');

      lanNeighbors.set(friendId,{host:'192.168.1.20',port:18788,fp:'ab'.repeat(16),at:Date.now()});
      showFriendsLanding();
      assert(document.querySelector('.lan-chip'),'LAN friends do not show an on-this-Wi-Fi chip');
      lanNeighbors.delete(friendId);
      return {watch:true,lanChip:true,ring:true};
    })()`, true);
    console.log('PASS watch LAN UI', JSON.stringify(result));
    window.destroy();
    app.quit();
  } catch (error) {
    window.destroy();
    fail(error);
  }
});
