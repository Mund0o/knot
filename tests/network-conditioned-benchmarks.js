'use strict';

const assert=require('assert');
const {simulateMediaPath,runNetworkMatrix}=require('../network-benchmark');

const direct=runNetworkMatrix(),publishOnce=runNetworkMatrix({publisherCopies:false});
assert.strictEqual(direct.length,108);assert.strictEqual(publishOnce.length,108);
const clean=simulateMediaPath({rttMs:20,lossPct:0,uploadMbps:50,viewers:1,publisherCopies:true,seed:7});
assert(clean.p95Ms<=100,`clean-link p95 ${clean.p95Ms.toFixed(1)} ms exceeded the 100 ms target`);
const mesh=simulateMediaPath({rttMs:50,lossPct:1,uploadMbps:25,viewers:5,publisherCopies:true,seed:8}),singleUpload=simulateMediaPath({rttMs:50,lossPct:1,uploadMbps:25,viewers:5,publisherCopies:false,seed:8});
assert(singleUpload.p95Ms<mesh.p95Ms,'single-publish group route did not reduce modeled queue latency');
assert(mesh.maxQueueMs<=150,'real-time stale-frame bound exceeded the 150 ms ceiling');
const summarize=results=>({conditions:results.length,under100:results.filter(item=>item.p95Ms<=100).length,under150:results.filter(item=>item.p95Ms<=150).length,dropped:results.reduce((sum,item)=>sum+item.droppedFrames,0),worstP95:Math.max(...results.map(item=>item.p95Ms))});
console.log('NETWORK BASELINE',JSON.stringify({matrix:{lossPct:[0,1,2,5],rttMs:[20,50,100],uploadMbps:[10,25,50],viewers:[1,5,9]},publisherMesh:summarize(direct),singlePublish:summarize(publishOnce)}));
console.log('PASS deterministic network-conditioned latency benchmark preserves 100/150 ms targets without forcing them');
