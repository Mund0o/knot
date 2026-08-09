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
    const result = await window.webContents.executeJavaScript(`(()=>{
      const assert=(condition,message)=>{if(!condition)throw new Error(message)};
      const dialog=document.querySelector('#serverDialog'),plus=document.querySelector('#addServer'),toggle=document.querySelector('#sidebarToggle'),home=document.querySelector('#homeButton'),handle=document.querySelector('#sidebarResize'),shell=document.querySelector('.app-shell');
      plus.click();assert(dialog.open,'server plus did not open Create/Join dialog');assert(dialog.textContent.includes('Create a server')&&dialog.textContent.includes('Join a server'),'server actions are not visible');dialog.close();
      toggle.click();assert(document.body.classList.contains('social-sidebar-collapsed'),'sidebar did not collapse');assert(toggle.getAttribute('aria-expanded')==='false','collapsed state is not announced');
      home.click();assert(!document.body.classList.contains('social-sidebar-collapsed'),'P did not reopen Friends');assert(!document.querySelector('#friendsNavigation').hidden,'Friends did not become visible');
      const before=parseFloat(shell.style.getPropertyValue('--social-sidebar-width'));handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));const after=parseFloat(shell.style.getPropertyValue('--social-sidebar-width'));assert(after>before,'keyboard resize did not increase sidebar width');
      directorySnapshot={friends:[],members:{},self:null,servers:[{id:'11111111111111111111111111111111',name:'Test Server',picture:'',members:[],channels:[{id:'22222222222222222222222222222222',type:'text',name:'general'}]}]};renderServers();const server=document.querySelector('#serverList .rail-button');assert(server&&server.textContent==='TE','server icon was not rendered below P');server.click();assert(!document.querySelector('#serverNavigation').hidden&&document.querySelector('#friendsNavigation').hidden,'server click did not switch Friends to channels');
      return {dialog:true,collapse:true,resize:[before,after],serverRail:true,serverChannels:true};
    })()`, true);
    if (process.env.PAIR_UI_SCREENSHOT) fs.writeFileSync(process.env.PAIR_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    console.log('PASS navigation UI', JSON.stringify(result));
    window.destroy();
    app.quit();
  } catch (error) {
    window.destroy();
    fail(error);
  }
});
