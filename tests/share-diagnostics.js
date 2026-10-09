'use strict';

// The share log: lines from the page are kept short, polite and local; the main process's own lines continue while a share is on and stop
// when it is not; the file never grows without limit.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createShareDiagnostics, MAX_LINE, MAX_FILE_BYTES, ACTIVE_MS, MAX_LINES_PER_SECOND } = require('../share-diagnostics');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-share-diag-'));
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
try {
  // a clock and a timer the test drives
  let clock = Date.UTC(2026, 9, 8, 12, 0, 0), tick = null;
  const make = (name, extra = {}) => createShareDiagnostics({ file: path.join(dir, name), now: () => clock, header: 'Knot 1.1.130 linux', setTimer: fn => { tick = fn; return { unref() {} }; }, clearTimer: () => { tick = null; }, metrics: () => [{ type: 'Tab', pid: 11, cpu: 94.4, memoryKb: 460800 }, { type: 'GPU', pid: 12, cpu: 38, memoryKb: 389120 }], ...extra });

  // 1. a line from the page is written with a time and its source, and starts the process lines
  {
    const log = make('one.log'), file = log.file;
    assert.strictEqual(log.record('viewer AV1 3840x2160 recv=60 shown=19'), true);
    assert(log.running, 'the process lines did not start with the first line from the page');
    let text = read(file);
    assert(/---- share log 2026-10-08T12:00:00.000Z Knot 1.1.130 linux/.test(text), 'no header: ' + text);
    assert(/\d\d:\d\d:\d\d\.\d{3} page viewer AV1 3840x2160 recv=60 shown=19\n/.test(text), 'the page line is not there: ' + text);
    clock += 1000; tick();
    text = read(file);
    assert(/ main cpu\/ram Tab#11:94%\/450MB GPU#12:38%\/380MB\n/.test(text), 'the process line is wrong: ' + text);
    // the page keeps writing: the process lines continue
    log.record('viewer again'); clock += 1000; tick(); log.record('viewer again'); clock += 1000; tick();
    assert((read(file).match(/ main cpu\/ram /g) || []).length === 3, 'process lines stopped while the page was still writing');
    // the page goes quiet: the process lines say so once, then stop (a stuck page is visible as busy processes and no page lines)
    for (let i = 0; i < Math.ceil(ACTIVE_MS / 1000) + 2; i++) { clock += 1000; if (tick) tick(); }
    assert(!log.running && tick === null, 'the process lines never stopped');
    assert(/page silent/.test(read(file)), 'a silent page is not noted');
    const stopped = read(file); clock += 5000; assert.strictEqual(read(file), stopped, 'something was written after it stopped');
    // a new share starts a new section
    clock += 60000; log.record('viewer second share');
    assert((read(file).match(/---- share log /g) || []).length === 2, 'a second share did not get its own header');
    console.log('PASS page lines are timestamped; process lines follow while the page writes and stop when it goes silent');
  }

  // 1b. the UDP streams' own numbers follow the process line, and a lane source that fails is simply left out
  {
    const log = make('lanes.log', { lanes: () => [{ id: 'abc123', cwnd: 503, rttMs: 39, inflight: 319992, retransmits: 290, fastRecoveries: 3, timeouts: 0, bandwidthMbps: 129.4 }] }), file = log.file;
    log.record('viewer x'); clock += 1000; tick();
    assert(/ main lanes udx#abc123:cwnd=503 rtt=39ms inflight=312KB rexmit=290 fastRec=3 rto=0 bw=129.4Mbps\n/.test(read(file)), 'the lane line is wrong: ' + read(file));
    const failing = make('lanes2.log', { lanes: () => { throw new Error('no runtime'); } }); failing.record('x'); clock += 1000; assert.doesNotThrow(() => tick());
    assert(!/ main lanes /.test(read(failing.file)) && / main cpu\/ram /.test(read(failing.file)), 'a failing lane source broke the process line');
    console.log('PASS the UDP streams\' numbers are logged beside the process line');
  }

  // 2. nothing that is not text, nothing long, no control characters, no flood
  {
    const log = make('two.log'), file = log.file;
    for (const bad of [null, undefined, 42, {}, [], '', '   ', '\u0000\u0001']) assert.strictEqual(log.record(bad), false, 'accepted ' + JSON.stringify(bad));
    assert.strictEqual(read(file), '', 'something was written for input that is not text');
    log.record('x'.repeat(MAX_LINE * 3)); assert(!/x{901}/.test(read(file)) && /x{900}\n/.test(read(file)), 'a long line was not cut to ' + MAX_LINE);
    log.record('line one\nline two\r\n\u001b[31mred'); assert(!/[\u0000-\u0009\u000b-\u001f]/.test(read(file).replace(/\n/g, '')) && /line one line two .*red/.test(read(file)), 'control characters were kept: ' + JSON.stringify(read(file)));
    clock += 5000; let accepted = 0; for (let i = 0; i < 500; i++) if (log.record('flood ' + i)) accepted++;
    assert.strictEqual(accepted, MAX_LINES_PER_SECOND, `a flood got ${accepted} lines in, not ${MAX_LINES_PER_SECOND}`);
    clock += 1000; assert.strictEqual(log.record('after the second'), true, 'the limit did not reset');
    console.log('PASS only short text is kept, cleaned, and rate-limited');
  }

  // 3. the file is bounded: past the limit it moves to .1 and starts again
  {
    const log = make('three.log'), file = log.file; const filler = 'y'.repeat(800);
    let written = 0;
    for (let i = 0; written < MAX_FILE_BYTES + 40000; i++) { clock += 1000; if (log.record(filler + i)) written += 830; }
    assert(fs.existsSync(file + '.1'), 'the file was not rotated');
    assert(fs.statSync(file).size < MAX_FILE_BYTES + 2000 && fs.statSync(file + '.1').size < MAX_FILE_BYTES + 2000, 'a file grew past its limit');
    assert(fs.statSync(file).size > 0, 'the new file is empty');
    console.log('PASS the log is bounded: a full file becomes ".1" and the log goes on in a fresh one');
  }

  // 4. permissions, and a log that cannot be written never throws
  {
    const log = make('four.log'); log.record('a line');
    assert.strictEqual(fs.statSync(log.file).mode & 0o077, 0, 'the log is readable by other users');
    const nowhere = createShareDiagnostics({ file: path.join(dir, 'missing', 'deeper', 'x.log'), now: () => clock, setTimer: () => ({ unref() {} }), clearTimer() {} });
    assert.doesNotThrow(() => nowhere.record('cannot be written'));
    const broken = make('five.log', { metrics: () => { throw new Error('no metrics'); } }); broken.record('x'); clock += 1000; assert.doesNotThrow(() => tick());
    assert.throws(() => createShareDiagnostics({}), /file is required/);
    console.log('PASS the log is private to its owner and a failing disk or metrics source never breaks anything');
  }
  console.log('ALL SHARE LOG CHECKS PASSED');
} finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
