'use strict';

// A short record, kept on this computer only, of what a screen share was doing second by second, for working out why one went wrong.
// While a share is on, the page sends one line a second (what arrives, what is shown, what decodes it, which lane carries it) and the main
// process adds how busy each of Knot's processes is. The page cannot write anything when it is the thing that is stuck; the main process's own
// lines are the ones that still arrive then, so a stuck page shows up as a busy process with no page lines. Nothing here is sent anywhere, and the
// file holds only numbers and the names of codecs and decoders (no addresses, names or messages).
const fs = require('fs');

const MAX_LINE = 900;                    // characters kept of one line from the page
const MAX_FILE_BYTES = 768 * 1024;       // then the file becomes `<file>.1` and a new one starts: the last hour or two of shares are kept
const ACTIVE_MS = 6000;                  // the process lines continue this long after the last line from the page
const SAMPLE_MS = 1000;
const MAX_LINES_PER_SECOND = 6;          // the page is not trusted to be polite

function createShareDiagnostics({ file, now = Date.now, metrics = () => [], lanes = () => [], header = '', setTimer = setInterval, clearTimer = clearInterval } = {}) {
  if (!file) throw new TypeError('a file is required');
  let timer = null, lastNoteAt = 0, windowStart = 0, inWindow = 0, size = null, lines = 0;

  const clock = () => { const date = new Date(now()); return date.toTimeString().slice(0, 8) + '.' + String(date.getMilliseconds()).padStart(3, '0'); };

  function write(source, text) {
    try {
      if (size === null) { try { size = fs.statSync(file).size; } catch { size = 0; } }
      if (size > MAX_FILE_BYTES) { try { fs.renameSync(file, file + '.1'); } catch {} size = 0; }
      const line = `${clock()} ${source} ${text}\n`;
      fs.appendFileSync(file, line, { mode: 0o600 });
      size += Buffer.byteLength(line); lines++;
    } catch {}
  }

  function processes() {
    let list = [];
    try { list = metrics() || []; } catch {}
    return list.map(item => `${String(item.type || '?').slice(0, 12)}${item.pid ? '#' + item.pid : ''}:${Math.round(Number(item.cpu) || 0)}%/${Math.round((Number(item.memoryKb) || 0) / 1024)}MB`).join(' ');
  }

  function laneLine() {
    let list = [];
    try { list = lanes() || []; } catch {}
    return list.map(item => `udx#${item.id}:cwnd=${item.cwnd} rtt=${item.rttMs}ms inflight=${Math.round((Number(item.inflight) || 0) / 1024)}KB rexmit=${item.retransmits} fastRec=${item.fastRecoveries} rto=${item.timeouts} bw=${item.bandwidthMbps}Mbps`).join('  ');
  }

  function sample() {
    if (now() - lastNoteAt > ACTIVE_MS) { write('main', 'share ended or page silent for ' + Math.round(ACTIVE_MS / 1000) + ' s: process lines stop'); stop(); return; }
    write('main', 'cpu/ram ' + processes());
    const laneText = laneLine();
    if (laneText) write('main', 'lanes ' + laneText);
  }

  function stop() { if (timer) { try { clearTimer(timer); } catch {} } timer = null; }

  // One line from the page. Anything that is not a short piece of text is ignored.
  function record(text) {
    if (typeof text !== 'string' || !text) return false;
    const time = now();
    if (time - windowStart >= 1000) { windowStart = time; inWindow = 0; }
    if (++inWindow > MAX_LINES_PER_SECOND) return false;
    const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_LINE);
    if (!clean) return false;
    lastNoteAt = time;
    if (!timer) {
      write('main', `---- share log ${new Date(time).toISOString()} ${header}`.trim());
      timer = setTimer(sample, SAMPLE_MS); try { timer.unref?.(); } catch {}
    }
    write('page', clean);
    return true;
  }

  return { record, stop, get lines() { return lines; }, get running() { return !!timer; }, file };
}

module.exports = { createShareDiagnostics, MAX_LINE, MAX_FILE_BYTES, ACTIVE_MS, MAX_LINES_PER_SECOND };
