(function installRealtimeSfuPilot(root) {
  'use strict';

  const ID=/^[a-f0-9]{32}$/;
  const safeDescription=(value,type)=>value&&value.type===type&&typeof value.sdp==='string'&&value.sdp.length>20&&value.sdp.length<=512*1024?{type,sdp:value.sdp}:null;
  const safeTrack=value=>value&&ID.test(String(value.ownerId||''))&&typeof value.sessionId==='string'&&value.sessionId.length<=128&&typeof value.trackName==='string'&&value.trackName.length<=256?{ownerId:value.ownerId,sessionId:value.sessionId,trackName:value.trackName,kind:value.kind==='video'?'video':'audio'}:null;

  class RealtimeSfuPilot {
    constructor({rpc,onTrack=()=>{},onState=()=>{},onFailure=()=>{}}={}) {
      if(typeof rpc!=='function')throw new TypeError('RealtimeSfuPilot needs an authenticated RPC function');
      this.rpc=rpc;this.onTrack=onTrack;this.onState=onState;this.onFailure=onFailure;this.publisher=null;this.subscriber=null;this.room=null;this.ownId='';this.remoteSignature='';this.closed=false;this.generation=0;this.subscriptionGeneration=0;
    }

    async start(stream,{entityId,channelId,scope='group-dm',ownId}={}) {
      if(this.closed)throw new Error('SFU pilot is closed');if(!stream?.getAudioTracks?.().length||!ID.test(entityId)||!ID.test(channelId)||!ID.test(ownId))throw new Error('SFU pilot received an invalid group call');
      this.room={entityId,channelId,scope:scope==='server'?'server':'group-dm'};this.ownId=ownId;const generation=++this.generation,pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}],bundlePolicy:'max-bundle'});this.publisher=pc;
      pc.onconnectionstatechange=()=>{if(generation!==this.generation||this.closed)return;const state=pc.connectionState;this.onState({transport:'sfu',side:'publisher',state});if(['failed','closed'].includes(state))this.fail(new Error('SFU publisher connection '+state))};
      const transceivers=stream.getAudioTracks().slice(0,1).map(track=>pc.addTransceiver(track,{direction:'sendonly'}));for(const transceiver of transceivers){try{const parameters=transceiver.sender.getParameters();parameters.encodings=parameters.encodings?.length?parameters.encodings:[{}];parameters.encodings[0].maxBitrate=48000;parameters.encodings[0].priority='high';await transceiver.sender.setParameters(parameters)}catch{}}const offer=await pc.createOffer();await pc.setLocalDescription(offer);
      const published=await this.rpc('publish',{...this.room,sessionDescription:pc.localDescription,tracks:transceivers.map(({mid,sender},index)=>({location:'local',mid:String(mid??index),trackName:sender.track?.id||crypto.randomUUID(),kind:sender.track?.kind||'audio'}))});
      if(generation!==this.generation||this.closed)throw new Error('SFU pilot start was superseded');const answer=safeDescription(published?.sessionDescription,'answer');if(!answer)throw new Error('SFU returned an invalid publisher answer');await pc.setRemoteDescription(answer);this.onState({transport:'sfu',side:'publisher',state:'connecting'});await this.syncTracks(published.roomTracks||[]);return true;
    }

    async syncTracks(values=[]) {
      if(this.closed||!this.room)return false;const tracks=values.map(safeTrack).filter(track=>track&&track.ownerId!==this.ownId&&track.kind==='audio').slice(0,19),signature=tracks.map(track=>`${track.ownerId}:${track.sessionId}:${track.trackName}`).sort().join('|');if(signature===this.remoteSignature)return true;this.remoteSignature=signature;const generation=++this.subscriptionGeneration;
      const previous=this.subscriber;if(!tracks.length){this.subscriber=null;try{previous?.close()}catch{}this.onState({transport:'sfu',side:'subscriber',state:'idle'});return true}
      const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}],bundlePolicy:'max-bundle'}),pending=[];this.subscriber=pc;
      pc.ontrack=event=>{pending.push(event)};pc.onconnectionstatechange=()=>{if(generation!==this.subscriptionGeneration||this.closed)return;const state=pc.connectionState;this.onState({transport:'sfu',side:'subscriber',state});if(['failed','closed'].includes(state))this.fail(new Error('SFU subscriber connection '+state))};
      try{
        const pulled=await this.rpc('subscribe',{...this.room,tracks});if(generation!==this.subscriptionGeneration||this.closed)throw new Error('SFU subscription was superseded');const remoteOffer=safeDescription(pulled?.sessionDescription,'offer');if(!remoteOffer)throw new Error('SFU returned an invalid subscriber offer');
        const responseTracks=Array.isArray(pulled.tracks)?pulled.tracks:[],owners=new Map(),requestedByName=new Map(tracks.map(track=>[`${track.sessionId}:${track.trackName}`,track]));for(let index=0;index<responseTracks.length;index++){const output=responseTracks[index],mid=String(output?.mid??''),input=requestedByName.get(`${output?.sessionId||''}:${output?.trackName||''}`)||tracks[index];if(mid&&input)owners.set(mid,input.ownerId)}
        await pc.setRemoteDescription(remoteOffer);if(generation!==this.subscriptionGeneration||this.closed)throw new Error('SFU subscription was superseded');const answer=await pc.createAnswer();await pc.setLocalDescription(answer);await this.rpc('renegotiate',{...this.room,sessionId:pulled.sessionId,sessionDescription:pc.localDescription});if(generation!==this.subscriptionGeneration||this.closed)throw new Error('SFU subscription was superseded');
        pc.ontrack=event=>{const ownerId=owners.get(String(event.transceiver?.mid??''))||'';if(ownerId)this.onTrack({ownerId,track:event.track,stream:event.streams?.[0]||new MediaStream([event.track])})};for(const event of pending)pc.ontrack(event);try{previous?.close()}catch{}this.onState({transport:'sfu',side:'subscriber',state:'connecting'});return true;
      }catch(error){try{pc.close()}catch{}if(this.subscriber===pc)this.subscriber=previous||null;throw error}
    }

    fail(error){if(this.closed)return;this.onFailure(error instanceof Error?error:new Error(String(error||'SFU pilot failed')))}

    async close({notify=true}={}) {
      if(this.closed)return;this.closed=true;this.generation++;this.subscriptionGeneration++;const publisher=this.publisher,subscriber=this.subscriber;this.publisher=this.subscriber=null;try{publisher?.close()}catch{}try{subscriber?.close()}catch{}if(notify&&this.room)try{await this.rpc('close',this.room)}catch{}this.onState({transport:'sfu',state:'closed'})
    }
  }

  const api={RealtimeSfuPilot,safeTrack,safeDescription};if(typeof module!=='undefined'&&module.exports)module.exports=api;if(root)root.PairRealtimeSfu=api;
})(typeof window!=='undefined'?window:globalThis);
