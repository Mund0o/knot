'use strict';

const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const {DatabaseSync}=require('node:sqlite');

const FORMAT='history-aes-gcm-v1',MAX_ENTRY_BYTES=64*1024,MAX_CONVERSATION_MESSAGES=10000,MAX_TOTAL_MESSAGES=200000,MAX_TOTAL_PLAIN_BYTES=256*1024*1024;
const OWNER=/^[a-f0-9]{32}$/,CONVERSATION=/^(?:dm:[a-f0-9]{32}|(?:server|group):[a-f0-9]{32}:[a-f0-9]{32})$/;

function validScope(owner,conversation){return OWNER.test(String(owner||''))&&CONVERSATION.test(String(conversation||''))}
function cleanEntry(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.text!=='string'||value.text.length>16000)return null;
  const copy=JSON.parse(JSON.stringify(value,(key,item)=>key.startsWith('_')?undefined:item));const serialized=JSON.stringify(copy);
  return Buffer.byteLength(serialized,'utf8')<=MAX_ENTRY_BYTES?{copy,serialized}:null;
}

class EncryptedHistoryStore{
  constructor(resolvePath,{keyProvider}={}){if(typeof resolvePath!=='function')throw new TypeError('resolvePath must be a function');if(typeof keyProvider!=='function')throw new TypeError('keyProvider must be a function');this.resolvePath=resolvePath;this.keyProvider=keyProvider;this.keyPromise=null;this.db=null;this.appendCount=0}
  open(){if(this.db)return this.db;const target=this.resolvePath();fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});this.db=new DatabaseSync(target);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA busy_timeout=3000;PRAGMA secure_delete=ON;CREATE TABLE IF NOT EXISTS messages(row_id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_hash TEXT NOT NULL,message_hash TEXT,recorded_at INTEGER NOT NULL,plain_bytes INTEGER NOT NULL,format TEXT NOT NULL,iv BLOB NOT NULL,tag BLOB NOT NULL,payload BLOB NOT NULL,UNIQUE(conversation_hash,message_hash));CREATE INDEX IF NOT EXISTS messages_conversation_row ON messages(conversation_hash,row_id DESC);CREATE INDEX IF NOT EXISTS messages_recorded ON messages(recorded_at,row_id);CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);try{fs.chmodSync(target,0o600)}catch{}return this.db}
  async key(){if(!this.keyPromise)this.keyPromise=Promise.resolve(this.keyProvider()).then(master=>{const raw=Buffer.from(master);if(raw.length!==32)throw new Error('History master key must be 32 bytes');return crypto.createHmac('sha256',raw).update('Knot encrypted history v1').digest()}).catch(error=>{this.keyPromise=null;throw error});return this.keyPromise}
  async hashes(owner,conversation,messageId=''){if(!validScope(owner,conversation))throw new Error('Invalid history scope');const key=await this.key(),scope=crypto.createHmac('sha256',key).update(`owner:${owner}|conversation:${conversation}`).digest('hex'),message=/^[a-f0-9]{32}$/.test(String(messageId||''))?crypto.createHmac('sha256',key).update(`scope:${scope}|message:${messageId}`).digest('hex'):null;return{key,scope,message}}
  seal(key,scope,message,recordedAt,serialized){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(`${FORMAT}|${scope}|${message||''}|${recordedAt}`));const payload=Buffer.concat([cipher.update(serialized,'utf8'),cipher.final()]);return{iv,tag:cipher.getAuthTag(),payload}}
  reveal(key,row){if(row.format!==FORMAT)return null;const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(row.iv));decipher.setAAD(Buffer.from(`${FORMAT}|${row.conversation_hash}|${row.message_hash||''}|${row.recorded_at}`));decipher.setAuthTag(Buffer.from(row.tag));const value=JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.payload)),decipher.final()]).toString('utf8'));return cleanEntry(value)?.copy||null}
  async append(owner,conversation,entry){return this.appendMany(owner,conversation,[entry])}
  async appendMany(owner,conversation,entries){
    const prepared=(Array.isArray(entries)?entries:[]).slice(0,1000).map(cleanEntry).filter(Boolean);if(!prepared.length)return{added:0};const {key,scope}=await this.hashes(owner,conversation),database=this.open(),insert=database.prepare('INSERT OR IGNORE INTO messages(conversation_hash,message_hash,recorded_at,plain_bytes,format,iv,tag,payload) VALUES(?,?,?,?,?,?,?,?)');let added=0;
    database.exec('BEGIN IMMEDIATE');try{for(const item of prepared){const time=Number(item.copy.time),recordedAt=Number.isFinite(time)&&time>0&&time<Date.now()+86400000?Math.floor(time):Date.now(),message=/^[a-f0-9]{32}$/.test(String(item.copy.id||''))?crypto.createHmac('sha256',key).update(`scope:${scope}|message:${item.copy.id}`).digest('hex'):null,sealed=this.seal(key,scope,message,recordedAt,item.serialized);const result=insert.run(scope,message,recordedAt,Buffer.byteLength(item.serialized),FORMAT,sealed.iv,sealed.tag,sealed.payload);added+=Number(result.changes)||0}database.exec('COMMIT')}catch(error){try{database.exec('ROLLBACK')}catch{}throw error}
    this.appendCount+=added;if(this.appendCount>=64){this.appendCount=0;this.prune()}return{added};
  }
  async list(owner,conversation,{before=null,limit=80}={}){
    const {key,scope}=await this.hashes(owner,conversation),database=this.open();limit=Math.max(1,Math.min(200,Number(limit)||80));const cursor=Number.isSafeInteger(Number(before))&&Number(before)>0?Number(before):Number.MAX_SAFE_INTEGER,rows=database.prepare('SELECT * FROM messages WHERE conversation_hash=? AND row_id<? ORDER BY row_id DESC LIMIT ?').all(scope,cursor,limit+1),hasOlder=rows.length>limit,page=rows.slice(0,limit),items=[];
    for(const row of page){try{const entry=this.reveal(key,row);if(entry)items.push({rowId:Number(row.row_id),entry})}catch{}}
    items.reverse();return{items,nextBefore:hasOlder&&items.length?items[0].rowId:null,hasOlder};
  }
  async importLegacy(owner,histories){
    if(!OWNER.test(String(owner||''))||!histories||typeof histories!=='object'||Array.isArray(histories))return false;const key=await this.key(),marker=crypto.createHmac('sha256',key).update(`legacy-owner:${owner}`).digest('hex'),database=this.open();if(database.prepare('SELECT value FROM meta WHERE key=?').get(marker))return true;
    for(const [conversation,entries] of Object.entries(histories)){if(!CONVERSATION.test(conversation)||!Array.isArray(entries))continue;await this.appendMany(owner,conversation,entries.slice(-MAX_CONVERSATION_MESSAGES))}
    database.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(marker,String(Date.now()));this.prune();return true;
  }
  prune(){
    const database=this.open();database.exec(`DELETE FROM messages WHERE row_id IN (SELECT row_id FROM (SELECT row_id,ROW_NUMBER() OVER(PARTITION BY conversation_hash ORDER BY row_id DESC) position FROM messages) WHERE position>${MAX_CONVERSATION_MESSAGES});DELETE FROM messages WHERE row_id IN (SELECT row_id FROM messages ORDER BY row_id DESC LIMIT -1 OFFSET ${MAX_TOTAL_MESSAGES});`);let total=Number(database.prepare('SELECT COALESCE(SUM(plain_bytes),0) total FROM messages').get().total)||0;while(total>MAX_TOTAL_PLAIN_BYTES){const rows=database.prepare('SELECT row_id,plain_bytes FROM messages ORDER BY recorded_at,row_id LIMIT 1000').all();if(!rows.length)break;let remove=0,count=0;for(const row of rows){remove+=Number(row.plain_bytes)||0;count++;if(total-remove<=MAX_TOTAL_PLAIN_BYTES)break}database.prepare('DELETE FROM messages WHERE row_id IN (SELECT row_id FROM messages ORDER BY recorded_at,row_id LIMIT ?)').run(count);total-=remove}}
  close(){try{this.db?.exec('PRAGMA wal_checkpoint(TRUNCATE)')}catch{}try{this.db?.close()}catch{}this.db=null}
}

module.exports={EncryptedHistoryStore,FORMAT,MAX_ENTRY_BYTES,MAX_CONVERSATION_MESSAGES,MAX_TOTAL_MESSAGES,MAX_TOTAL_PLAIN_BYTES,validScope,cleanEntry};
