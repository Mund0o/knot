'use strict';

const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {EncryptedHistoryStore,validScope,cleanEntry}=require('../history-store');

(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'knot-history-')),target=path.join(root,'history.db'),key=crypto.randomBytes(32),owner='1'.repeat(32),peer='2'.repeat(32),conversation='dm:'+peer;
  try{
    const store=new EncryptedHistoryStore(()=>target,{keyProvider:async()=>key});assert(validScope(owner,conversation));assert(!validScope(owner,'../../settings.json'));assert.strictEqual(cleanEntry({text:'x'.repeat(16001)}),null);
    const first={id:'a'.repeat(32),text:'private message alpha',mine:true,time:1000},second={id:'b'.repeat(32),text:'private message beta',mine:false,time:2000,author:{id:peer,name:'Friend'}};
    assert.strictEqual((await store.appendMany(owner,conversation,[first,second])).added,2);assert.strictEqual((await store.append(owner,conversation,first)).added,0,'message-id dedupe failed');
    const page=await store.list(owner,conversation,{limit:1});assert.strictEqual(page.items[0].entry.text,second.text);assert(page.hasOlder&&page.nextBefore>0);const older=await store.list(owner,conversation,{limit:10,before:page.nextBefore});assert.strictEqual(older.items[0].entry.text,first.text);
    const legacy={['dm:'+peer]:[{text:'legacy private body',mine:true,time:3000}]};assert(await store.importLegacy(owner,legacy));assert(await store.importLegacy(owner,legacy));assert.strictEqual((await store.list(owner,conversation,{limit:20})).items.filter(item=>item.entry.text==='legacy private body').length,1,'legacy migration was not idempotent');
    store.close();for(const file of fs.readdirSync(root)){const bytes=fs.readFileSync(path.join(root,file));assert(!bytes.includes(Buffer.from('private message'))&&!bytes.includes(Buffer.from('legacy private body')),'plaintext history leaked into SQLite/WAL')}
    const reopened=new EncryptedHistoryStore(()=>target,{keyProvider:async()=>key}),restored=await reopened.list(owner,conversation,{limit:20});assert.strictEqual(restored.items.length,3,'history did not survive restart');reopened.close();
    if(process.platform!=='win32')assert.strictEqual(fs.statSync(target).mode&0o077,0,'history database permissions are not private');console.log('PASS per-message encrypted SQLite history, hashed scopes, pagination, dedupe, migration, and restart');
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exit(1)});
