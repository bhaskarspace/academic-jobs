// Polite HTTP client for the crawler.
//  - identifies itself (UA with the repo issues URL; never an email address)
//  - obeys robots.txt (RFC 9309, see robots.mjs: retried, last good copy when unreachable) and crawl-delay
//  - spaces requests per host (default 2 s), runs different hosts concurrently
//  - conditional requests (ETag / Last-Modified) with an on-disk body cache for 304s
//  - hard timeouts and a small retry with backoff
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchRobots, blockedReason, RobotsDisallowed } from './robots.mjs';
import { loadExtraCAs } from './ca.mjs';

// Node's happy-eyeballs gives each address family 250 ms by default, which is too short for some
// Indian hosts from GitHub runners (they failed with ETIMEDOUT while curl got through).
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);
// Missing intermediates for hosts with incomplete chains (config/ca/).
loadExtraCAs();

export const UA = 'academic-jobs/0.1 (+https://github.com/bhaskarspace/academic-jobs/issues)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export { RobotsDisallowed };

// Headers a source may set for its host (config/sources.yaml `headers:`). Only ordinary content
// negotiation: never a User-Agent or anything that would make the crawler look like a browser.
export const SOURCE_HEADERS = new Set(['accept', 'accept-language', 'accept-encoding']);
export function checkSourceHeaders(headers = {}, id = '?') {
  for (const k of Object.keys(headers)) if (!SOURCE_HEADERS.has(k.toLowerCase())) throw new Error(`${id}: header ${k} is not allowed in sources.yaml (only ${[...SOURCE_HEADERS].join(', ')})`);
  return headers;
}

export class Aborted extends Error {
  constructor(url) { super(`aborted: ${url}`); this.code = 'WATCHDOG'; }
}

export class HttpError extends Error {
  constructor(url, status) { super(`HTTP ${status} for ${url}`); this.code = `HTTP_${status}`; this.status = status; }
}

export class Http {
  /**
   * @param {object} o
   * @param {string} [o.cacheDir]   where 304 bodies are kept (Actions cache; safe to lose)
   * @param {object} [o.meta]       persistent {url: {etag, lastModified}} (lives in state)
   * @param {object} [o.robotsCache] persistent {origin: {fetched, status, body}} (lives in state)
   * @param {number} [o.minGapMs]   default per-host spacing
   * @param {number} [o.timeoutMs]  total time per request, including the body
   * @param {(msg:string)=>void} [o.log]
   */
  constructor({ cacheDir, meta = {}, robotsCache = {}, minGapMs = 2000, timeoutMs = 45_000, retries = 2, log = () => {} } = {}) {
    Object.assign(this, { cacheDir, meta, robotsCache, minGapMs, timeoutMs, retries, log });
    this.robots = new Map();     // origin -> Promise<{allowed(url), delayMs, status}>
    this.hostQueue = new Map();  // host -> Promise chain
    this.hostGap = new Map();    // host -> configured gap override (ms)
    this.hostHeaders = new Map(); // host -> extra ordinary headers (SOURCE_HEADERS only)
    this.stats = { requests: 0, notModified: 0, errors: 0, bytes: 0, robotsSkipped: { disallowed: 0, unreachable: 0 } };
  }

  setHostHeaders(host, headers) {
    if (headers && Object.keys(headers).length) this.hostHeaders.set(host, { ...(this.hostHeaders.get(host) ?? {}), ...checkSourceHeaders(headers, host) });
  }

  /**
   * A view of this client for one source: every request carries `signal`, so the source's
   * watchdog stops its queued and in-flight requests instead of leaving them running.
   */
  withSignal(signal) {
    return {
      get: (url, o = {}) => this.get(url, { ...o, signal }),
      json: (url, o = {}) => this.json(url, { ...o, signal }),
      isAllowed: (url) => this.isAllowed(url),
      stats: this.stats,
    };
  }

  setHostDelay(host, seconds) {
    if (seconds) this.hostGap.set(host, Math.max(this.hostGap.get(host) ?? 0, seconds * 1000));
  }

  async robotsFor(origin) {
    if (!this.robots.has(origin)) {
      this.robots.set(origin, fetchRobots(origin, {
        cache: this.robotsCache,
        retries: this.retries,
        get: async (url) => { const res = await this.#raw(url, {}); return { status: res.status, text: await res.text() }; },
      }).then((r) => {
        if (r.source !== 'live') this.log(`robots.txt for ${origin} unreachable (${r.error || r.status}); ${r.source === 'cache' ? `using the copy from ${r.cachedAt}` : 'no cached copy, so nothing is fetched'}`);
        return r;
      }));
    }
    return this.robots.get(origin);
  }

  /** {origin: {status, source, error, cachedAt}} for the health report. */
  async robotsReport() {
    const out = {};
    for (const [origin, p] of this.robots) {
      const r = await p;
      out[origin] = { status: r.status, source: r.source, error: r.error ?? undefined, cachedAt: r.cachedAt };
    }
    return out;
  }

  async isAllowed(url) {
    const r = await this.robotsFor(new URL(url).origin);
    return r.allowed(url);
  }

  // Serialise requests per host and keep the gap.
  #schedule(host, fn) {
    const prev = this.hostQueue.get(host) ?? Promise.resolve();
    const run = prev.then(async () => {
      try { return await fn(); }
      finally {
        const robots = await this.robots.get(`https://${host}`)?.catch?.(() => null);
        const gap = Math.max(this.minGapMs, this.hostGap.get(host) ?? 0, robots?.delayMs ?? 0);
        await sleep(gap);
      }
    });
    this.hostQueue.set(host, run.catch(() => {}));
    return run;
  }

  #raw(url, headers, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...(this.hostHeaders.get(new URL(url).host) ?? {}), ...headers },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  }

  #cachePath(url) {
    return this.cacheDir && path.join(this.cacheDir, 'http', sha1(url));
  }

  /**
   * GET a URL politely. Returns {url, status, body: string|Buffer, contentType, notModified}.
   * Throws RobotsDisallowed, HttpError (4xx/5xx after retries) or a network error.
   * @param {object} [opt]
   * @param {boolean} [opt.binary]       return a Buffer (PDFs)
   * @param {boolean} [opt.conditional]  use ETag/Last-Modified (default true)
   * @param {boolean} [opt.ignoreRobots] only for sources with a recorded `permission:`
   * @param {number}  [opt.maxBytes]     stop and throw TooLarge (code TOO_LARGE) past this size
   * @param {AbortSignal} [opt.signal]  the source's watchdog (see withSignal)
   */
  async get(url, { binary = false, conditional = true, ignoreRobots = false, accept, maxBytes = 0, signal } = {}) {
    if (signal?.aborted) throw new Aborted(url);
    const u = new URL(url);
    if (!ignoreRobots) {
      const why = blockedReason(await this.robotsFor(u.origin), url);
      if (why) { this.stats.robotsSkipped[why]++; throw new RobotsDisallowed(url, why); }
    }

    return this.#schedule(u.host, async () => {
      if (signal?.aborted) throw new Aborted(url);
      const cp = this.#cachePath(url);
      const m = this.meta[url];
      let cached = null;
      if (conditional && m && cp) cached = await readFile(cp).catch(() => null);
      const headers = {};
      if (accept) headers.Accept = accept;
      if (cached) {
        if (m.etag) headers['If-None-Match'] = m.etag;
        if (m.lastModified) headers['If-Modified-Since'] = m.lastModified;
      }

      let lastErr;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        if (attempt) await sleep(2000 * 3 ** (attempt - 1));
        if (signal?.aborted) throw new Aborted(url);
        this.stats.requests++;
        try {
          const res = await this.#raw(url, headers, signal);
          if (res.status === 304 && cached) {
            await res.arrayBuffer().catch(() => {});
            this.stats.notModified++;
            return { url, status: 304, notModified: true, contentType: m.contentType, body: binary ? cached : cached.toString('utf8') };
          }
          if (res.status === 429 || res.status >= 500) {
            await res.arrayBuffer().catch(() => {});
            lastErr = new HttpError(url, res.status);
            continue;
          }
          if (res.status >= 400) {
            await res.arrayBuffer().catch(() => {});
            throw new HttpError(url, res.status);
          }
          const declared = Number(res.headers.get('content-length') || 0);
          if (maxBytes && declared > maxBytes) {
            await res.body?.cancel().catch(() => {});
            throw new TooLarge(url, declared);
          }
          const buf = maxBytes ? await readCapped(res, maxBytes, url) : Buffer.from(await res.arrayBuffer());
          this.stats.bytes += buf.length;
          const contentType = res.headers.get('content-type') || '';
          const etag = res.headers.get('etag');
          const lastModified = res.headers.get('last-modified');
          if (cp && conditional && (etag || lastModified)) {
            this.meta[url] = { etag: etag || undefined, lastModified: lastModified || undefined, contentType };
            await mkdir(path.dirname(cp), { recursive: true });
            await writeFile(cp, buf);
          }
          return { url: res.url || url, status: res.status, notModified: false, contentType, body: binary ? buf : decode(buf, contentType) };
        } catch (e) {
          if (e instanceof HttpError) { this.stats.errors++; throw e; }
          if (e instanceof TooLarge) throw e;
          if (signal?.aborted) throw new Aborted(url);
          lastErr = e;
        }
      }
      this.stats.errors++;
      throw lastErr;
    });
  }

  async json(url, opt) {
    const r = await this.get(url, { accept: 'application/json', ...opt });
    return { ...r, data: JSON.parse(r.body) };
  }
}

function decode(buf, contentType) {
  const cs = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().toLowerCase();
  try {
    return new TextDecoder(cs && cs !== 'utf8' ? cs : 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export function errorCode(e) {
  if (!e) return null;
  if (e.code && typeof e.code === 'string' && !e.cause) return e.code;
  const c = e.cause ?? e;
  if (e.name === 'TimeoutError' || c.name === 'TimeoutError') return 'TIMEOUT';
  return c.code || c.name || 'ERROR';
}

/** A response larger than the caller's limit (PDF cap). Not retried, not counted as an error. */
export class TooLarge extends Error {
  constructor(url, bytes) {
    super(`larger than the limit (${(bytes / 1e6).toFixed(1)} MB or more): ${url}`);
    this.code = 'TOO_LARGE';
    this.bytes = bytes;
    this.url = url;
  }
}

async function readCapped(res, maxBytes, url) {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks = [];
  let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > maxBytes) throw new TooLarge(url, n); // leaving the loop cancels the stream
    chunks.push(c);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
