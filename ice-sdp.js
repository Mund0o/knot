(function installIceSdp(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotIceSdp = api;
})(typeof window === 'object' ? window : typeof globalThis === 'object' ? globalThis : null, () => {
  const WAIT_ICE_MS = 8000;
  const WAIT_ICE_RELAY_MS = 12000;
  const DIRECT_CONNECT_MS = 25000;
  const RELAY_CONNECT_MS = 20000;
  const FREE_AUDIO_PAYLOAD_TYPES = [114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 127, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109];

  function parseIceCandidateLine(line) {
    const text = String(line || '').trim();
    const body = text.startsWith('a=') ? text.slice(2) : text;
    const match = body.match(/^candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+(\d+)\s+typ\s+(\S+)/i);
    if (!match) return null;
    const address = match[1];
    return {
      address,
      port: Number(match[2]),
      typ: match[3].toLowerCase(),
      mdns: /\.local\.?$/i.test(address),
    };
  }

  function sdpIceCandidates(sdp) {
    return String(sdp || '').split(/\r?\n/).map(parseIceCandidateLine).filter(Boolean);
  }

  function sdpHasPublicIceCandidate(sdp) {
    return sdpIceCandidates(sdp).some(item => item.typ === 'srflx' || item.typ === 'relay' || item.typ === 'prflx');
  }

  function sdpHasRelayIceCandidate(sdp) {
    return sdpIceCandidates(sdp).some(item => item.typ === 'relay');
  }

  function iceCandidateWorthSending(value) {
    const line = typeof value === 'string' ? value : value && value.candidate;
    const parsed = parseIceCandidateLine(line);
    if (!parsed) return typeof line === 'string' && line.length > 0;
    return !parsed.mdns;
  }

  function preferPublicIceSdp(sdp) {
    const text = String(sdp || '');
    if (!sdpHasPublicIceCandidate(text)) return text;
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    // split() keeps the empty string after a trailing newline. Adding another
    // terminator produced a blank SDP line, and Chromium rejected the offer
    // and the answer with "Invalid SDP line."
    const lines = text.split(/\r?\n/);
    const trailingEmpty = lines.length > 1 && lines[lines.length - 1] === '';
    const kept = (trailingEmpty ? lines.slice(0, -1) : lines).filter(line => {
      if (!line) return false;
      const parsed = parseIceCandidateLine(line);
      if (!parsed) return true;
      return !(parsed.typ === 'host' && parsed.mdns);
    });
    const next = kept.join(newline);
    return trailingEmpty && next ? next + newline : next;
  }

  function remapAudioPayloadType(section, fromPt, toPt) {
    const from = String(fromPt), to = String(toPt);
    if (from === to || new RegExp('a=rtpmap:' + to + '\\b').test(section)) return section;
    let next = section.replace(/^m=audio .+$/m, line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) return line;
      return parts.slice(0, 3).concat([...new Set(parts.slice(3).map(pt => pt === from ? to : pt))]).join(' ');
    });
    next = next.replace(new RegExp('^(a=(?:rtpmap|fmtp|rtcp-fb):)' + from + '(?=\\s|$)', 'gm'), '$1' + to);
    next = next.replace(new RegExp('(\\bapt=)' + from + '\\b', 'g'), '$1' + to);
    next = next.replace(new RegExp('(a=fmtp:\\d+ )' + from + '(?=/)', 'g'), '$1' + to);
    next = next.replace(new RegExp('(a=fmtp:\\d+ \\d+/)' + from + '\\b', 'g'), '$1' + to);
    return next;
  }

  function payloadTypesInSdp(sdp) {
    const used = new Set();
    String(sdp || '').replace(/a=rtpmap:(\d+)\b/g, (_, pt) => used.add(Number(pt)));
    String(sdp || '').replace(/^m=\w+ \d+ \S+ (.+)$/gm, (_, pts) => {
      for (const pt of String(pts).trim().split(/\s+/)) if (/^\d+$/.test(pt)) used.add(Number(pt));
    });
    return used;
  }

  function takeFreeAudioPayloadType(used) {
    // 112/113 are Chromium telephone-event. 111/63/110/126 are the first m-line's
    // Opus/RED/CN/telephone-event. Reusing 112 was a no-op on real offers, so both
    // audio m-lines kept Opus 111 and the bundle either crashed or dropped sound.
    for (const pt of FREE_AUDIO_PAYLOAD_TYPES) {
      if (used.has(pt)) continue;
      used.add(pt);
      return pt;
    }
    return 0;
  }

  function unbundleOpusCollision(sdp) {
    const used = new Set([111, 112, 113]);
    let audioIndex = 0;
    return String(sdp || '').split(/(?=^m=)/m).map(part => {
      if (!part.startsWith('m=audio')) {
        payloadTypesInSdp(part).forEach(pt => used.add(pt));
        return part;
      }
      if (audioIndex++ === 0) {
        payloadTypesInSdp(part).forEach(pt => used.add(pt));
        return part;
      }
      let next = part;
      const opusPt = Number((next.match(/a=rtpmap:(\d+) opus\//i) || [])[1] || 111);
      if (used.has(opusPt)) {
        const opusTo = takeFreeAudioPayloadType(used);
        if (opusTo && opusTo !== opusPt) next = remapAudioPayloadType(next, opusPt, opusTo);
      } else used.add(opusPt);
      const redPt = Number((next.match(/a=rtpmap:(\d+) red\//i) || [])[1] || 0);
      if (redPt) {
        if (used.has(redPt)) {
          const redTo = takeFreeAudioPayloadType(used);
          if (redTo && redTo !== redPt) next = remapAudioPayloadType(next, redPt, redTo);
        } else used.add(redPt);
      }
      payloadTypesInSdp(next).forEach(pt => used.add(pt));
      return next;
    }).join('');
  }

  return {
    WAIT_ICE_MS,
    WAIT_ICE_RELAY_MS,
    DIRECT_CONNECT_MS,
    RELAY_CONNECT_MS,
    parseIceCandidateLine,
    sdpIceCandidates,
    sdpHasPublicIceCandidate,
    sdpHasRelayIceCandidate,
    iceCandidateWorthSending,
    preferPublicIceSdp,
    remapAudioPayloadType,
    payloadTypesInSdp,
    takeFreeAudioPayloadType,
    unbundleOpusCollision,
  };
});
