'use strict';

const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {LocalMetricsStore,cleanTags,percentile}=require('../local-metrics');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'knot-metrics-'));let now=Date.now();
try{
  const target=path.join(root,'metrics.db'),store=new LocalMetricsStore(()=>target,{clock:()=>now,flushDelayMs:0});
  assert.strictEqual(store.record('unknown.metric',1),false,'dynamic metric name accepted');
  assert.strictEqual(store.record('screen.rtt_ms',NaN),false,'non-finite value accepted');
  assert.strictEqual(cleanTags({codec:'AV1',peerId:'secret',route:'host-host',lane:'tcp',filename:'private.txt'}),'{"codec":"AV1","route":"host-host","lane":"tcp"}','private/dynamic tags survived validation or the bounded transfer lane was lost');
  for(const value of [10,20,30,40,100])assert(store.record('screen.rtt_ms',value,{codec:'AV1'}));
  store.record('renderer.long_task_ms',75);store.flush();
  const summary=store.summary({hours:24});assert.strictEqual(summary.localOnly,true);assert.strictEqual(summary.metrics['screen.rtt_ms'].p95,100);assert.strictEqual(summary.metrics['screen.rtt_ms'].count,5);assert.strictEqual(percentile([1,2,3,4],.5),2);
  store.close();assert(fs.existsSync(target));if(process.platform!=='win32')assert.strictEqual(fs.statSync(target).mode&0o077,0,'metrics database permissions are not private');
  console.log('PASS local-only allowlisted metrics aggregation contains no dynamic identifiers');
}finally{fs.rmSync(root,{recursive:true,force:true})}
