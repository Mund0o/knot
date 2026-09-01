'use strict';

const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {Worker}=require('worker_threads');
const catalog=require('../emoji-catalog');

(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'knot-emoji-worker-')),originalFetch=global.fetch;
  try{
    global.fetch=async()=>new Response(JSON.stringify(Array.from({length:200},(_,index)=>({id:index+1,title:index===0?'smile':'smile_'+index,slug:'emoji_'+index,image:`https://cdn3.emoji.gg/emojis/${index}.png`,description:'happy face',category:1,license:'0',faves:index,submitted_by:'tester'}))),{status:200});
    catalog.init(null,{cacheRoot:root});await catalog.refresh({force:true});catalog.close();
    const worker=new Worker(path.join(__dirname,'..','emoji-catalog-worker.js'),{workerData:{root}}),pending=new Map();let sequence=0;
    worker.on('message',message=>{const request=pending.get(message.id);if(!request)return;pending.delete(message.id);message.error?request.reject(new Error(message.error)):request.resolve(message.value)});
    const call=(method,...args)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});worker.postMessage({id,method,args})});
    let ticks=0;const ticker=setInterval(()=>ticks++,1);
    const result=await Promise.race([call('search',{q:'smile',limit:60}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('worker timeout')),5000))]);
    clearInterval(ticker);assert(result.items.length===60&&ticks>0,'search blocked caller or returned malformed results');
    assert.strictEqual((await call('stats')).total,200);await assert.rejects(call('refresh'),/not allowed/i);await worker.terminate();
    console.log('PASS Emoji.gg API search remains off the renderer/main event loop');
  }finally{global.fetch=originalFetch;catalog.close();fs.rmSync(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exit(1)});
