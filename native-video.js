(function installNativeVideo(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotNativeVideo = api;
})(typeof window === 'object' ? window : null, () => {
  function bytesOf(value) {
    return value instanceof Uint8Array ? value : new Uint8Array(value);
  }

  function vint(bytes, offset, keepMarker = false) {
    if (offset >= bytes.length) return null;
    const first = bytes[offset];let mask = 0x80,length = 1;
    while (length <= 8 && !(first & mask)) { mask >>= 1;length++; }
    if (length > 8 || offset+length > bytes.length) return null;
    let value = keepMarker ? first : first & (mask-1);
    for (let index=1;index<length;index++){value=value*256+bytes[offset+index];if(!Number.isSafeInteger(value))return null}
    return { length, value };
  }

  function av1Description(webmInit) {
    const bytes = bytesOf(webmInit);
    // Matroska CodecPrivate (0x63A2) contains AV1CodecConfigurationRecord.
    // Search only the initialization segment, never encoded frame payloads.
    for (let offset=0;offset+4<bytes.length;offset++) {
      if (bytes[offset] !== 0x63 || bytes[offset+1] !== 0xa2) continue;
      const size = vint(bytes, offset+2);if (!size) continue;
      const start = offset+2+size.length,end = start+size.value;
      if (size.value >= 4 && size.value <= 256 && end <= bytes.length && (bytes[start]&0x80)) return bytes.slice(start,end);
    }
    return null;
  }

  function av1Codec(description) {
    const bytes = bytesOf(description || []);
    if (bytes.length < 3) return 'av01.0.13M.08';
    const profile = bytes[1] >> 5,level = bytes[1]&0x1f,tier = bytes[2]&0x80?'H':'M';
    const highBitDepth = !!(bytes[2]&0x40),twelveBit = !!(bytes[2]&0x20),depth = highBitDepth?(twelveBit?12:10):8;
    return `av01.${profile}.${String(level).padStart(2,'0')}${tier}.${String(depth).padStart(2,'0')}`;
  }

  function unsigned(bytes, start, end) {
    let value = 0;for (let offset=start;offset<end;offset++){value=value*256+bytes[offset];if(!Number.isSafeInteger(value))return 0}return value;
  }

  function blockFrame(bytes, start, end, clusterTimeMs, durationUs, forceKey = false, copyData = true) {
    const track = vint(bytes,start);if (!track || start+track.length+3>end) return null;
    let offset=start+track.length;let relative=(bytes[offset]<<8)|bytes[offset+1];if(relative&0x8000)relative-=0x10000;offset+=2;
    const flags=bytes[offset++],lacing=(flags>>1)&3;if(lacing||offset>=end)return null;
    const frame = {
      type: forceKey || !!(flags&0x80) ? 'key' : 'delta',
      timestamp: Math.max(0,Math.round((clusterTimeMs+relative)*1000)),
      duration: durationUs
    };
    // EncodedVideoChunk copies the payload. Keep a view here so 4K60 classify
    // and decode paths do not pay an extra main-thread memcpy per cluster.
    if (copyData) frame.data = bytes.subarray(offset,end);
    return frame;
  }

  function parseAv1Cluster(cluster, fps = 60, copyData = true) {
    const bytes=bytesOf(cluster),clusterId=[0x1f,0x43,0xb6,0x75];
    if(bytes.length<6||!clusterId.every((value,index)=>bytes[index]===value))return[];
    const size=vint(bytes,4);if(!size)return[];let offset=4+size.length,clusterTime=0;const frames=[],duration=Math.round(1000000/Math.max(1,fps));
    while(offset<bytes.length){
      const id=vint(bytes,offset,true);if(!id)break;const elementSize=vint(bytes,offset+id.length);if(!elementSize)break;
      const start=offset+id.length+elementSize.length,end=start+elementSize.value;if(end>bytes.length)break;
      if(id.value===0xe7)clusterTime=unsigned(bytes,start,end);
      else if(id.value===0xa3){const frame=blockFrame(bytes,start,end,clusterTime,duration,false,copyData);if(frame)frames.push(frame);}
      else if(id.value===0xa0){
        // BlockGroup is uncommon for this live muxer, but accepting it keeps the
        // parser compatible with AMD/FFmpeg versions that choose Block instead
        // of SimpleBlock. No ReferenceBlock means a key frame.
        let child=start,block=null,referenced=false;
        while(child<end){const childId=vint(bytes,child,true),childSize=childId&&vint(bytes,child+childId.length);if(!childId||!childSize)break;const body=child+childId.length+childSize.length,bodyEnd=body+childSize.value;if(bodyEnd>end)break;if(childId.value===0xa1)block=[body,bodyEnd];else if(childId.value===0xfb)referenced=true;child=bodyEnd;}
        if(block){const frame=blockFrame(bytes,block[0],block[1],clusterTime,duration,!referenced,copyData);if(frame)frames.push(frame);}
      }
      offset=end;
    }
    return frames;
  }

  function webmAv1Frames(cluster, fps = 60) {
    return parseAv1Cluster(cluster, fps, true);
  }

  function webmAv1FrameMeta(cluster, fps = 60) {
    const frames = parseAv1Cluster(cluster, fps, false);
    return { key: frames.some(frame => frame.type === 'key'), frameCount: frames.length };
  }

  return { vint, av1Description, av1Codec, webmAv1Frames, webmAv1FrameMeta };
});
