'use strict';

// Deterministic link model used by CI to compare routing/bitrate changes under
// the same loss, RTT, upload, and viewer-count matrix. It never contacts a
// network service and intentionally reports bad conditions rather than hiding
// them behind a forced quality target.
function seededRandom(seed=0x4b4e4f54){let state=seed>>>0;return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/0x100000000}}
function percentile(values,fraction){if(!values.length)return 0;const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.min(ordered.length-1,Math.ceil(ordered.length*fraction)-1)]}

function simulateMediaPath({rttMs=20,lossPct=0,uploadMbps=25,viewers=1,publisherCopies=true,durationSeconds=12,fps=60,targetMbps=16,staleFrameMs=150,seed=1}={}){
  const random=seededRandom(seed),frameInterval=1000/fps,frames=Math.floor(durationSeconds*fps),copies=publisherCopies?Math.max(1,viewers):1,capacityBitsPerMs=Math.max(.001,uploadMbps*1000),latencies=[],queueDepths=[];let linkFreeAt=0,lostFrames=0,droppedFrames=0,maxQueueMs=0;
  for(let index=0;index<frames;index++){
    const capturedAt=index*frameInterval,motionPhase=(index%240)/240,sceneFactor=motionPhase>.35&&motionPhase<.72?1.7:index%60===0?2.2:.72;
    const bits=(targetMbps*1e6/fps)*sceneFactor*copies,start=Math.max(capturedAt,linkFreeAt),service=bits/capacityBitsPerMs;
    const lost=random()<lossPct/100,recovery=lost?Math.min(120,Math.max(10,rttMs*.85)):0;if(lost)lostFrames++;
    linkFreeAt=start+service;const latency=linkFreeAt-capturedAt+rttMs/2+recovery,queueMs=Math.max(0,start-capturedAt);maxQueueMs=Math.max(maxQueueMs,queueMs);queueDepths.push(queueMs);
    // A real-time sender should discard stale delta frames instead of allowing
    // an unbounded reliable queue. Count those misses in the benchmark.
    if(latency>staleFrameMs){droppedFrames++;linkFreeAt=Math.min(linkFreeAt,capturedAt+staleFrameMs);continue}
    latencies.push(latency);
  }
  return{rttMs,lossPct,uploadMbps,viewers,publisherCopies,staleFrameMs,frames,deliveredFrames:latencies.length,lostFrames,droppedFrames,p50Ms:percentile(latencies,.5),p95Ms:percentile(latencies,.95),maxMs:Math.max(0,...latencies),queueP95Ms:percentile(queueDepths,.95),maxQueueMs,under100Pct:latencies.filter(value=>value<=100).length/Math.max(1,latencies.length)*100,under150Pct:latencies.filter(value=>value<=150).length/Math.max(1,latencies.length)*100};
}

function runNetworkMatrix({loss=[0,1,2,5],rtt=[20,50,100],upload=[10,25,50],viewers=[1,5,9],publisherCopies=true}={}){const results=[];let seed=1;for(const lossPct of loss)for(const rttMs of rtt)for(const uploadMbps of upload)for(const count of viewers)results.push(simulateMediaPath({lossPct,rttMs,uploadMbps,viewers:count,publisherCopies,seed:seed++}));return results}

module.exports={seededRandom,percentile,simulateMediaPath,runNetworkMatrix};
