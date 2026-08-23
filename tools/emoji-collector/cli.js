#!/usr/bin/env node
// Emoji.gg catalog collector v2 — sitemap-driven crawl.
//
// Discovery walks Emoji.gg's own public sitemap index (no robots.txt
// restrictions are published) rather than the legacy /api endpoint, which only
// exposes ~5.4k of the ~140k catalog entries.
//
// Every emoji detail page is fetched once, its license badge parsed, and — for
// redistributable licenses (WTFPL > CC BY 4.0 > Basic per operator policy) —
// the asset is downloaded, signature-validated, hashed and stored
// content-addressed. Streamer/unknown licenses are never mirrored.
//
// Fully resumable: every URL's state lives in SQLite (crawl_state).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open } = require('./lib/db');
const { normalizeLicense, MIRRORABLE, attributionRequired, rank } = require('./lib/licenses');
const { sniff, isAnimated, dimensions } = require('./lib/images');
const { createFetcher, BlockedError } = require('./lib/fetcher');

const BASE = 'https://emoji.gg';
const USER_AGENT = process.env.EMOJI_COLLECTOR_UA || 'KnotEmojiCollector/1.0 (+https://github.com/Mund0o/knot)';
const MAX_BYTES = 512 * 1024;
const MIN_BYTES = 64;

function parseArgs(argv) {
  const args = { target: Infinity, resume: false, dryRun: false, metadataOnly: false, animatedOnly: false,
    concurrency: 4, delay: 300, output: path.resolve(__dirname, '..', '..', 'emoji-catalog'), limit: 0, staticCap: null };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const next = () => argv[++i];
    switch (key) {
      case 'target': args.target = Math.max(0, parseInt(next(), 10) || 0); break;
      case 'resume': args.resume = true; break;
      case 'dry-run': args.dryRun = true; break;
      case 'metadata-only': args.metadataOnly = true; break;
      case 'animated-only': args.animatedOnly = true; break;
      case 'static-cap': args.staticCap = Math.max(0, parseInt(next(), 10)); break;
      case 'concurrency': args.concurrency = Math.min(8, Math.max(1, parseInt(next(), 10) || 4)); break;
      case 'delay': args.delay = Math.max(0, parseInt(next(), 10) || 300); break;
      case 'output': args.output = path.resolve(next()); break;
      case 'limit': args.limit = Math.max(0, parseInt(next(), 10) || 0); break;
      default: console.error(`Unknown flag --${key}`); process.exit(2);
    }
  }
  return args;
}

async function discoverEmojis(fetcher) {
  // Sitemaps carry the modern catalog; the legacy JSON API exposes an older
  // slice (underscore slugs) whose detail pages live at the same paths. Merge
  // both sources so pre-rebrand entries — including most WTFPL/CC BY uploads —
  // are never missed.
  const index = await fetcher(`${BASE}/sitemap.xml`);
  const files = [...String(index).matchAll(/<loc>(https:\/\/emoji\.gg\/sitemap\/emojis\/\d+)<\/loc>/g)].map(m => m[1]);
  if (!files.length) throw new Error('No emoji sitemaps found in sitemap index');
  const urls = [];
  for (const file of files) {
    const xml = await fetcher(file);
    for (const m of String(xml).matchAll(/<loc>(https:\/\/emoji\.gg\/emoji\/[^<]+)<\/loc>/g)) urls.push(m[1]);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  try {
    const apiItems = await fetcher(`${BASE}/api`);
    for (const item of Array.isArray(apiItems) ? apiItems : []) {
      if (item?.slug) urls.push(`${BASE}/emoji/${item.slug}`);
    }
    console.log(`Legacy API supplement: ${Array.isArray(apiItems) ? apiItems.length : 0} entries merged.`);
  } catch (error) { console.warn('Legacy API unavailable, continuing with sitemap only:', error.message); }
  return [...new Set(urls)];
}

function parseDetailPage(html, url) {
  const meta = prop => { const m = new RegExp(`property="${prop}" content="([^"]*)"`).exec(html); return m ? m[1] : null; };
  const title = meta('og:title');
  const image = meta('og:image');
  const description = meta('og:description') || '';
  const licenseMatch = /fa-award[^>]*><\/i>\s*([^<]+?)\s*(?:License)?\s*<\/h5>/.exec(html);
  const authorMatch = /\bby ([^.<]+)[.<]/i.exec(description);
  const idMatch = /\/emoji\/(\d+)[-_]/.exec(url);
  return {
    url,
    name: title ? title.replace(/\s*-\s*Discord Emoji\s*$/i, '').trim() : '',
    image: image || null,
    author: authorMatch ? authorMatch[1].trim().slice(0, 80) : '',
    licenseText: licenseMatch ? licenseMatch[1].trim() : null,
    externalId: idMatch ? idMatch[1] : crypto.createHash('sha1').update(url).digest('hex').slice(0, 12),
    slug: url.split('/emoji/')[1] || '',
  };
}

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[_\-+.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function processOne(fetcher, url, args, db, counts) {
  db.prepare(`INSERT INTO crawl_state(url,status) VALUES(?,'processing')
    ON CONFLICT(url) DO UPDATE SET status='processing',attempts=attempts+1,updated_at=datetime('now')`).run(url);
  try {
    const html = await fetcher(url);
    const detail = parseDetailPage(html, url);
    const known = db.prepare('SELECT id FROM items WHERE external_id=?').get(detail.externalId);
    if (known) {
      db.prepare("UPDATE crawl_state SET status='duplicate' WHERE url=?").run(url);
      counts.duplicate++;
      return { ok: true, duplicate: true };
    }
    const license = normalizeLicense(detail.licenseText);
    if (!MIRRORABLE(license) || !detail.name || !detail.image) {
      const reason = !MIRRORABLE(license) ? `license:${license}` : (!detail.name ? 'no-name' : 'no-image');
      if (!MIRRORABLE(license)) counts.skippedLicense++;
      db.prepare("UPDATE crawl_state SET status=?,last_error=? WHERE url=?").run(!MIRRORABLE(license) ? 'skipped-license' : 'failed-permanent', reason, url);
      return { ok: false, skip: !MIRRORABLE(license), license };
    }
    if (args.metadataOnly || args.dryRun) {
      db.prepare("UPDATE crawl_state SET status='complete-metadata',last_error=? WHERE url=?").run(JSON.stringify({ name: detail.name, image: detail.image, license, author: detail.author }), url);
      return { ok: true, metadata: true, license };
    }

    let buffer;
    try { buffer = await fetcher(detail.image, { asBuffer: true }); }
    catch (error) {
      db.prepare("UPDATE crawl_state SET status='failed-permanent',last_error=? WHERE url=?").run(`asset: ${error.message}`.slice(0, 200), url);
      return { ok: false, assetFail: true };
    }
    if (buffer.length < MIN_BYTES || buffer.length > MAX_BYTES) {
      db.prepare("UPDATE crawl_state SET status='failed-permanent',last_error='asset size out of range' WHERE url=?").run(url);
      return { ok: false, assetFail: true };
    }
    const sniffed = sniff(buffer);
    if (!sniffed) {
      db.prepare("UPDATE crawl_state SET status='failed-permanent',last_error='unrecognized image signature' WHERE url=?").run(url);
      return { ok: false, assetFail: true };
    }
    const animated = isAnimated(buffer, sniffed.mime);
    if (args.animatedOnly && !animated) {
      db.prepare("UPDATE crawl_state SET status='skipped-license',last_error='static filtered' WHERE url=?").run(url);
      counts.skippedLicense++;
      return { ok: false, skip: true };
    }
    if (!animated && args.staticCap !== null && counts.staticAccepted >= args.staticCap) {
      // Budget spent: erase the checkpoint so a future run treats this page as
      // untouched instead of permanently skipping potentially wanted content.
      db.prepare('DELETE FROM crawl_state WHERE url=?').run(url);
      counts.cappedStatic++;
      return { ok: true, capped: true };
    }
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const dup = db.prepare('SELECT id FROM items WHERE asset_hash=?').get(hash);
    if (dup) {
      db.prepare("UPDATE crawl_state SET status='duplicate' WHERE url=?").run(url);
      counts.duplicate++;
      return { ok: true, duplicate: true };
    }
    const dims = dimensions(buffer, sniffed.mime);
    const relPath = path.join('originals', hash.slice(0, 2), `${hash}.${sniffed.ext}`);
    fs.mkdirSync(path.dirname(path.join(args.output, relPath)), { recursive: true });
    fs.writeFileSync(path.join(args.output, relPath), buffer);
    const normalized = normalizeName(detail.name);
    try {
    db.prepare(`INSERT INTO items(external_id,name,normalized_name,slug,category,animated,mime,ext,width,height,file_size,
        asset_hash,asset_path,license,author,source_page,original_url,attribution_required,faves,search_text)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      detail.externalId, detail.name.slice(0, 120), normalized, detail.slug, 0,
      animated ? 1 : 0, sniffed.mime, sniffed.ext, dims.width, dims.height, buffer.length,
      hash, relPath, license, detail.author, url, detail.image, attributionRequired(license) ? 1 : 0,
      0, normalized);
    } catch (error) {
      if (!String(error.message).includes('UNIQUE')) throw error;
      db.prepare("UPDATE crawl_state SET status='duplicate' WHERE url=?").run(url);
      counts.duplicate++;
      return { ok: true, duplicate: true };
    }
    db.prepare("UPDATE crawl_state SET status='complete',last_error='' WHERE url=?").run(url);
    return { ok: true, accepted: true, animated };
  } catch (error) {
    const permanent = !!error.permanent;
    db.prepare('UPDATE crawl_state SET status=?,last_error=? WHERE url=?')
      .run(permanent ? 'failed-permanent' : 'failed-temporary', String(error.message).slice(0, 200), url);
    return { error };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = Date.now();
  fs.mkdirSync(args.output, { recursive: true });
  const db = open(args.output);
  const fetcher = createFetcher({ userAgent: USER_AGENT });

  console.log('[Emoji Collector v2 — sitemap crawl]');
  console.log('Discovering sitemap URLs…');
  const allUrls = await discoverEmojis(fetcher);
  console.log(`Candidates discovered: ${allUrls.length}`);

  const priorState = new Map(db.prepare('SELECT url,status FROM crawl_state').all().map(r => [r.url, r.status]));
  const doneStates = new Set(['complete', 'complete-metadata', 'duplicate', 'skipped-license']);
  let queue = allUrls.filter(url => !args.resume || !doneStates.has(priorState.get(url)));
  if (args.limit) queue = queue.slice(0, args.limit);
  if (args.target !== Infinity) queue = queue.slice(0, Math.max(0, args.target));
  const total = queue.length;

  const counts = { accepted: 0, duplicate: 0, skippedLicense: 0, failedTemporary: 0, failedPermanent: 0, metadata: 0, animated: 0, staticAccepted: 0, cappedStatic: 0 };
  let processed = 0, blocked = false;
  const worker = async () => {
    while (!blocked && queue.length) {
      const url = queue.shift();
      if (!url) return;
      const result = await processOne(fetcher, url, args, db, counts);
      processed++;
      if (result.accepted && !result.animated) counts.staticAccepted++;
      if (result.accepted && result.animated) counts.animated++;
      else if (result.error && !result.error.permanent) counts.failedTemporary++;
      else if (result.error) counts.failedPermanent++;
      else if (result.assetFail) counts.failedPermanent++;
      else if (result.metadata) counts.metadata++;
      else if (result.duplicate) {} // already counted in processOne
      else if (result.ok) counts.accepted++;
      if (processed % 25 === 0 || processed === total)
        process.stdout.write(`\rProcessed ${processed}/${total} · accepted ${counts.accepted} (+${counts.staticAccepted} static / ${counts.animated} anim) · dupe ${counts.duplicate} · capped ${counts.cappedStatic} · fail ${counts.failedTemporary + counts.failedPermanent}   `);
      await new Promise(resolve => setTimeout(resolve, args.delay));
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, worker));
  process.stdout.write('\n');

  const stats = db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(animated),0) animated,
      COALESCE(SUM(CASE WHEN license='WTFPL' THEN 1 ELSE 0 END),0) wtfpl,
      COALESCE(SUM(CASE WHEN license='CC-BY-4.0' THEN 1 ELSE 0 END),0) ccby,
      COALESCE(SUM(CASE WHEN license='Basic' THEN 1 ELSE 0 END),0) basic,
      COALESCE(SUM(file_size),0) bytes FROM items`).get();
  const manifest = {
    version: 2, generatedAt: new Date().toISOString(), source: 'https://emoji.gg',
    totalCount: stats.total, animatedCount: stats.animated, staticCount: stats.total - stats.animated,
    wtfplCount: stats.wtfpl, ccByCount: stats.ccby, basicCount: stats.basic,
    requestedTarget: args.target === Infinity ? null : args.target,
    note: 'Mirrored licenses: WTFPL, CC BY 4.0, Basic (operator-approved free-platform use).',
  };
  fs.writeFileSync(path.join(args.output, 'manifest', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`
[Emoji Collector] finished in ${((Date.now() - startedAt) / 1000).toFixed(0)}s
Discovered:        ${allUrls.length}
Processed this run:${processed}
Accepted:          ${stats.total} (${manifest.animatedCount} animated / ${manifest.staticCount} static)
  WTFPL:            ${manifest.wtfplCount}
  CC BY 4.0:        ${manifest.ccByCount}
  Basic:            ${manifest.basicCount}
Duplicates:        ${counts.duplicate}
License-skipped:   ${counts.skippedLicense}
Failed temp/perm:  ${counts.failedTemporary}/${counts.failedPermanent}
Blocked by server: ${blocked}
Total bytes:       ${stats.bytes.toLocaleString()}
Output:            ${args.output}`);
  db.close();
  if (blocked) process.exitCode = 3;
}

main().catch(error => { console.error('[Emoji Collector] fatal:', error.message); process.exitCode = 1; });
