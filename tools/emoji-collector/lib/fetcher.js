// Polite HTTP: identify ourselves, bound concurrency at the caller, retry only
// transient failures with exponential backoff + jitter, honor Retry-After, and
// surface an explicit "blocked" signal so collection can stop gracefully.
const BLOCK_CODES = new Set([401, 403, 429]);

class BlockedError extends Error {
  constructor(message, status) { super(message); this.name = 'BlockedError'; this.status = status; this.blocked = true; }
}

function createFetcher({ userAgent, maxRetries = 4, timeoutMs = 30000 } = {}) {
  let backoffMs = 500;
  return async function request(url, { asBuffer = false } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt) {
        const wait = lastError?.retryAfter ?? Math.round(backoffMs * (2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5));
        await new Promise(resolve => setTimeout(resolve, Math.min(wait, 60000)));
      }
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': userAgent, Accept: 'application/json,image/*;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'gzip, br', Referer: 'https://emoji.gg/' },
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) {
          backoffMs = Math.max(250, backoffMs >> 1);
          if (asBuffer) return Buffer.from(await response.arrayBuffer());
          const text = await response.text();
          try { return JSON.parse(text); } catch { return text; }
        }
        const retryAfter = Number(response.headers.get('retry-after')) * 1000 || undefined;
        if (BLOCK_CODES.has(response.status)) {
          if (response.status !== 429 && response.status !== 403) throw new BlockedError(`HTTP ${response.status}`, response.status);
          // 403/429: one polite strike each is enough to consider stopping.
          if (attempt >= 1) throw new BlockedError(`HTTP ${response.status} after retry`, response.status);
          lastError = Object.assign(new Error(`HTTP ${response.status}`), { retryAfter, status: response.status });
          continue;
        }
        if (response.status >= 500) { lastError = Object.assign(new Error(`HTTP ${response.status}`), { retryAfter }); continue; }
        throw Object.assign(new Error(`HTTP ${response.status}`), { permanent: true });
      } catch (error) {
        if (error.blocked || error.permanent) throw error;
        lastError = error;
      }
    }
    throw lastError || new Error('request failed');
  };
}

module.exports = { createFetcher, BlockedError };
