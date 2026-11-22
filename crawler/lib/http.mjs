// Polite HTTP client for the crawler.
//  - identifies itself (UA with the repo issues URL; never an email address)
//  - obeys robots.txt (RFC 9309: 4xx = allow all, 5xx/unreachable = disallow all) and crawl-delay
//  - spaces requests per host (default 2 s), runs different hosts concurrently
//  - conditional requests (ETag / Last-Modified) with an on-disk body cache for 304s
//  - hard timeouts and a small retry with backoff
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import robotsParser from 'robots-parser';

// Node's happy-eyeballs gives each address family 250 ms by default, which is too short for some
// Indian hosts from GitHub runners (they failed with ETIMEDOUT while curl got through).
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

export const UA = 'academic-jobs/0.1 (+https://github.com/bhaskarspace/academic-jobs/issues)';
const UA_TOKEN = 'academic-jobs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export class RobotsDisallowed extends Error {
  constructor(url) { super(`robots.txt disallows ${url}`); this.code = 'ROBOTS_DISALLOWED'; }
}

export class HttpError extends Error {
  constructor(url, status) { super(`HTTP ${status} for ${url}`); this.code = `HTTP_${status}`; this.status = status; }
}

export class Http {
  /**
   * @param {object} o
   * @param {string} [o.cacheDir]   where 304 bodies are kept (Actions cache; safe to lose)
   * @param {object} [o.meta]       persistent {url: {etag, lastModified}} (lives in state)
   * @param {number} [o.minGapMs]   default per-host spacing
   * @param {number} [o.timeoutMs]  total time per request, including the body
   * @param {(msg:string)=>void} [o.log]
   */
  constructor({ cacheDir, meta = {}, minGapMs = 2000, timeoutMs = 45_000, retries = 2, log = () => {} } = {}) {
    Object.assign(this, { cacheDir, meta, minGapMs, timeoutMs, retries, log });
    this.robots = new Map();     // origin -> Promise<{allowed(url), delayMs, status}>
    this.hostQueue = new Map();  // host -> Promise chain
    this.hostGap = new Map();    // host -> configured gap override (ms)
    this.stats = { requests: 0, notModified: 0, errors: 0, bytes: 0 };
  }

  setHostDelay(host, seconds) {
    if (seconds) this.hostGap.set(host, Math.max(this.hostGap.get(host) ?? 0, seconds * 1000));
  }

  async robotsFor(origin) {
    if (!this.robots.has(origin)) {
      this.robots.set(origin, (async () => {
        const url = `${origin}/robots.txt`;
        try {
          const res = await this.#raw(url, {});
          const status = res.status;
          if (status >= 200 && status < 300) {
            const txt = await res.text();
            const r = robotsParser(url, txt);
            return { status, allowed: (u) => r.isAllowed(u, UA_TOKEN) !== false, delayMs: (r.getCrawlDelay(UA_TOKEN) ?? 0) * 1000 };
          }
          await res.arrayBuffer().catch(() => {});
          if (status >= 400 && status < 500) return { status, allowed: () => true, delayMs: 0 };
          return { status, allowed: () => false, delayMs: 0 };
        } catch (e) {
          return { status: 0, error: e.cause?.code || e.name, allowed: () => false, delayMs: 0 };
        }
      })());
    }
    return this.robots.get(origin);
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

  #raw(url, headers) {
    return fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
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
   */
  async get(url, { binary = false, conditional = true, ignoreRobots = false, accept } = {}) {
    const u = new URL(url);
    if (!ignoreRobots && !(await this.isAllowed(url))) throw new RobotsDisallowed(url);

    return this.#schedule(u.host, async () => {
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
        this.stats.requests++;
        try {
          const res = await this.#raw(url, headers);
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
          const buf = Buffer.from(await res.arrayBuffer());
          this.stats.bytes += buf.length;
          const contentType = res.headers.get('content-type') || '';
          const etag = res.headers.get('etag');
          const lastModified = res.headers.get('last-modified');
          if (cp && (etag || lastModified)) {
            this.meta[url] = { etag: etag || undefined, lastModified: lastModified || undefined, contentType };
            await mkdir(path.dirname(cp), { recursive: true });
            await writeFile(cp, buf);
          }
          return { url: res.url || url, status: res.status, notModified: false, contentType, body: binary ? buf : decode(buf, contentType) };
        } catch (e) {
          if (e instanceof HttpError) { this.stats.errors++; throw e; }
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
