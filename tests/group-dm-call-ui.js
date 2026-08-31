const path = require('path');
const { app, BrowserWindow } = require('electron');

function fail(error) {
  console.error(error?.stack || error);
  app.exit(1);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 650,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    },
  });

  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const assert=(condition,message)=>{if(!condition)throw new Error(message)};
      const selfId='cccccccccccccccccccccccccccccccc';
      const friendId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const groupId='77777777777777777777777777777777';
      const textId='88888888888888888888888888888888';
      const voiceId='99999999999999999999999999999999';
      const group={
        id:groupId,
        kind:'group-dm',
        name:'Test crew',
        owner:selfId,
        keySteward:selfId,
        keyEpoch:1,
        members:[selfId,friendId],
        channels:[
          {id:textId,type:'text',name:'chat'},
          {id:voiceId,type:'voice',name:'Call'},
        ],
      };
      directoryUserId=selfId;
      directorySnapshot={
        friends:[{id:friendId,name:'Alice',image:'',online:true}],
        members:{
          [selfId]:{id:selfId,name:'Tester',image:'',online:true},
          [friendId]:{id:friendId,name:'Alice',image:'',online:true},
        },
        self:{id:selfId,name:'Tester',image:'',online:true},
        voiceStates:{},
        servers:[],
        groupDms:[group],
      };
      directorySend=()=>true;
      serverTextKeysLoaded=true;
      serverTextKeys={};
      showFriends({expand:false});
      renderFriends();
      await selectGroupDm(groupId);

      const button=document.querySelector('#groupDmCall');
      assert(button&&!button.hidden&&!button.disabled,'group call button is not available before joining');
      assert(getComputedStyle(button).display!=='none','group call button is hidden by the group-DM layout');
      assert(button.getAttribute('aria-label')==='Start a call in Test crew','group call button has no clear accessible start label');
      window.resizeTo(620,650);
      await new Promise(resolve=>setTimeout(resolve,50));
      assert(innerWidth<=670&&getComputedStyle(button).display==='grid','group call button is not preserved in the compact group-DM layout');

      const savedJoin=joinServerVoice;
      const savedStop=stopServerVoice;
      const joinedChannels=[];
      joinServerVoice=async channel=>{
        joinedChannels.push(channel?.id);
        serverVoiceStream={};
        joinedVoiceServerId=groupId;
        joinedVoiceChannelId=voiceId;
        joinedVoiceScope='group-dm';
        renderCallButtonState('end','Leave call','Leave group call');
      };
      stopServerVoice=()=>{
        serverVoiceStream=null;
        serverVoiceAttempt=null;
        serverVoiceStarting=false;
        joinedVoiceServerId='';
        joinedVoiceChannelId='';
        joinedVoiceScope='';
        renderCallButtonState('start','Start group call','Start group voice call');
      };

      button.click();
      await new Promise(resolve=>setTimeout(resolve,0));
      assert(joinedChannels.length===1&&joinedChannels[0]===voiceId,'group call button did not start the group voice channel');
      assert(button.textContent.includes('Leave call')&&button.getAttribute('aria-label')==='Leave Test crew call','group call button did not expose a leave state');

      button.click();
      await new Promise(resolve=>setTimeout(resolve,0));
      assert(!serverVoiceStream,'group call button did not leave the active group call');
      assert(!button.hidden&&!button.disabled&&getComputedStyle(button).display!=='none','group call button disappeared after leaving');
      assert(button.textContent.includes('Start call'),'group call button did not return to its start state');

      button.click();
      await new Promise(resolve=>setTimeout(resolve,0));
      assert(joinedChannels.length===2&&joinedChannels[1]===voiceId,'group call button could not rejoin after leaving');

      stopServerVoice();
      joinServerVoice=savedJoin;
      stopServerVoice=savedStop;
      return {visibleBeforeJoin:true,compactLayout:true,started:true,left:true,rejoined:true,channelId:voiceId};
    })()`, true);
    console.log('PASS group DM call UI', JSON.stringify(result));
    window.destroy();
    app.quit();
  } catch (error) {
    window.destroy();
    fail(error);
  }
});
