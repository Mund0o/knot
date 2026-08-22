// Image sniffing without third-party dependencies: validate magic bytes,
// detect true animation (never infer it from filenames), extract dimensions.
function sniff(buffer) {
  if (!(buffer instanceof Uint8Array) || buffer.length < 12) return null;
  const ascii = (start, text) => Buffer.from(text, 'ascii').equals(buffer.subarray(start, start + text.length));
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { mime: 'image/gif', ext: 'gif' };
  if (ascii(0, '\x89PNG')) return { mime: 'image/png', ext: 'png' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { mime: 'image/webp', ext: 'webp' };
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  return null;
}

// Count GIF image descriptors / WebP ANIM chunks / PNG acTL frames. A single
// frame means static even when a site labels the file "animated".
function isAnimated(buffer, mime) {
  if (!(buffer instanceof Uint8Array)) return false;
  if (mime === 'image/gif') {
    let frames = 0;
    // Header(6) + logical screen descriptor(7) land us at index 13; skip the
    // optional global color table before any frame data can appear.
    const screenPacked = buffer[10];
    let i = 13;
    if (screenPacked & 0x80) i += 3 * Math.pow(2, (screenPacked & 0x07) + 1);
    while (i + 7 <= buffer.length && frames < 2) {
      const b = buffer[i];
      if (b === 0x21) { // extension introducer
        const label = buffer[i + 1];
        i += 2;
        if (label === 0xF9) { i += 6; continue; } // graphic control: fixed size
        while (i < buffer.length) { const size = buffer[i]; i += 1 + size + (size === 0 ? 0 : 0); if (size === 0) break; }
      } else if (b === 0x2C) { // image descriptor = one frame
        frames++;
        i += 9; // separator + left/top/width/height consumed; now at packed byte
        const packed = buffer[i];
        if (packed & 0x80) i += 3 * Math.pow(2, (packed & 0x07) + 1); // local color table
        i += 2; // skip the packed byte just read plus the LZW minimum code size byte
        while (i < buffer.length) { const size = buffer[i]; i += 1 + size; if (size === 0) break; }
      } else if (b === 0x3B) break; // trailer
      else break;
    }
    return frames > 1;
  }
  if (mime === 'image/webp') {
    for (let i = 12; i + 4 <= buffer.length; i++) if (Buffer.from('ANIM').equals(buffer.subarray(i, i + 4))) return true;
    return false;
  }
  if (mime === 'image/png') {
    for (let i = 8; i + 8 <= buffer.length;) {
      const length = buffer.readUInt32BE(i);
      const type = Buffer.from(buffer.subarray(i + 4, i + 8)).toString('ascii');
      if (type === 'acTL') return true;
      if (type === 'IDAT') return false;
      i += 12 + length;
    }
    return false;
  }
  return false;
}

function dimensions(buffer, mime) {
  try {
    if (mime === 'image/gif' && buffer.length >= 10) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    if (mime === 'image/png' && buffer.length >= 24 && Buffer.from('IHDR').equals(buffer.subarray(12, 16)))
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    if (mime === 'image/webp') {
      const format = Buffer.from(buffer.subarray(12, 16)).toString('ascii');
      if (format === 'VP8X' && buffer.length >= 30)
        return { width: 1 + ((buffer[26] << 16) | (buffer[25] << 8) | buffer[24]), height: 1 + ((buffer[29] << 16) | (buffer[28] << 8) | buffer[27]) };
      if (format === 'VP8 ' && buffer.length >= 30)
        return { width: buffer.readUInt16LE(26) & 0x3FFF, height: buffer.readUInt16LE(28) & 0x3FFF };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xFF) { i++; continue; }
        const marker = buffer[i + 1];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC)
          return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
        i += 2 + buffer.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return { width: 0, height: 0 };
}

module.exports = { sniff, isAnimated, dimensions };
