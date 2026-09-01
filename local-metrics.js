'use strict';

const fs=require('fs');
const path=require('path');
const {DatabaseSync}=require('node:sqlite');

// Deliberately closed allowlist: no dynamic event names and no strings that can
// carry account IDs, filenames, message text, addresses, or room identifiers.
const METRIC_NAMES=new Set([
  'app.main_ready_ms','app.renderer_ready_ms','renderer.long_task_ms',
  'history.read_ms','history.append_ms','history.render_ms',
  'directory.snapshot_bytes','directory.delta_bytes','directory.apply_ms',
  'screen.rtt_ms','screen.encode_ms','screen.available_mbps','screen.sent_fps','screen.playout_ms',
  'screen.send_queue_ms','screen.discarded_fps','screen.qp','screen.nack_rate',
  'file.throughput_mbps','file.stall_ms','file.retry_count',
]);
const TAG_KEYS=new Set(['route','codec','scope','condition','direction','lane']);
const TAG_VALUE=/^[a-z0-9][a-z0-9_.:-]{0,31}$/i;
const RETENTION_MS=7*24*60*60*1000,MAX_ROWS=10000,MAX_BUFFER=64;

function cleanTags(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return '{}';const tags={};
  for(const [key,raw] of Object.entries(value)){const text=String(raw||'');if(TAG_KEYS.has(key)&&TAG_VALUE.test(text))tags[key]=text}
  return JSON.stringify(tags);
}
function percentile(values,fraction){if(!values.length)return 0;const ordered=[...values].sort((a,b)=>a-b),index=Math.min(ordered.length-1,Math.max(0,Math.ceil(ordered.length*fraction)-1));return ordered[index]}

class LocalMetricsStore{
  constructor(resolvePath,{clock=()=>Date.now(),flushDelayMs=1000}={}){if(typeof resolvePath!=='function')throw new TypeError('resolvePath must be a function');this.resolvePath=resolvePath;this.clock=clock;this.flushDelayMs=Math.max(0,Math.min(10000,Number(flushDelayMs)||0));this.db=null;this.buffer=[];this.timer=null}
  open(){if(this.db)return this.db;const target=this.resolvePath();fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});this.db=new DatabaseSync(target);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA busy_timeout=3000;CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,value REAL NOT NULL,tags TEXT NOT NULL,recorded_at INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS samples_name_time ON samples(name,recorded_at);`);try{fs.chmodSync(target,0o600)}catch{}return this.db}
  record(name,value,tags={}){if(!METRIC_NAMES.has(name)||!Number.isFinite(Number(value)))return false;const numeric=Math.max(0,Math.min(1e9,Number(value)));this.buffer.push({name,value:numeric,tags:cleanTags(tags),at:this.clock()});if(this.buffer.length>=MAX_BUFFER)this.flush();else if(!this.timer)this.timer=setTimeout(()=>{this.timer=null;this.flush()},this.flushDelayMs);return true}
  flush(){if(this.timer){clearTimeout(this.timer);this.timer=null}if(!this.buffer.length)return true;let database;try{database=this.open()}catch{return false}const pending=this.buffer.splice(0),insert=database.prepare('INSERT INTO samples(name,value,tags,recorded_at) VALUES(?,?,?,?)');try{database.exec('BEGIN IMMEDIATE');for(const item of pending)insert.run(item.name,item.value,item.tags,item.at);database.prepare('DELETE FROM samples WHERE recorded_at<?').run(this.clock()-RETENTION_MS);database.prepare('DELETE FROM samples WHERE id IN (SELECT id FROM samples ORDER BY id DESC LIMIT -1 OFFSET ?)').run(MAX_ROWS);database.exec('COMMIT');return true}catch{try{database.exec('ROLLBACK')}catch{}this.buffer.unshift(...pending.slice(-MAX_ROWS));return false}}
  summary({hours=24}={}){this.flush();const since=this.clock()-Math.max(1,Math.min(168,Number(hours)||24))*60*60*1000;let rows=[];try{rows=this.open().prepare('SELECT name,value,tags FROM samples WHERE recorded_at>=? ORDER BY id').all(since)}catch{}const grouped=new Map();for(const row of rows){const values=grouped.get(row.name)||[];values.push(Number(row.value)||0);grouped.set(row.name,values)}const metrics={};for(const [name,values] of grouped)metrics[name]={count:values.length,average:values.reduce((sum,value)=>sum+value,0)/values.length,p50:percentile(values,.5),p95:percentile(values,.95),max:Math.max(...values)};return{localOnly:true,hours:Math.max(1,Math.min(168,Number(hours)||24)),samples:rows.length,metrics}}
  close(){this.flush();try{this.db?.close()}catch{}this.db=null}
}

module.exports={LocalMetricsStore,METRIC_NAMES,TAG_KEYS,cleanTags,percentile,RETENTION_MS,MAX_ROWS};
