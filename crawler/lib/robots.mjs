// robots.txt for the crawler and the probe (RFC 9309).
//   2xx           -> parse it, and keep a copy (state.robots) for later outages
//   4xx           -> allow all
//   5xx / network -> retried like page fetches; if still unreachable, use the last good copy
//                    (RFC 9309 2.4 permits a cached copy); with no copy, disallow all
// Every result says where its rules came from (`source`: live | cache | none), so the health
// report can tell "robots.txt disallows" from "robots.txt unreachable".
import robotsParser from 'robots-parser';

export const UA_TOKEN = 'academic-jobs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RobotsDisallowed extends Error {
  constructor(url, reason = 'disallowed') {
    super(reason === 'unreachable' ? `robots.txt unreachable (no cached copy) for ${url}` : `robots.txt disallows ${url}`);
    this.code = reason === 'unreachable' ? 'ROBOTS_UNREACHABLE' : 'ROBOTS_DISALLOWED';
    this.reason = reason;
  }
}

function rules(url, status, body) {
  if (status >= 400 && status < 500) return { allowed: () => true, delayMs: 0 };
  const r = robotsParser(url, body ?? '');
  return { allowed: (u) => r.isAllowed(u, UA_TOKEN) !== false, delayMs: (r.getCrawlDelay(UA_TOKEN) ?? 0) * 1000 };
}

/**
 * @param {string} origin                    https://host
 * @param {object} o
 * @param {(url:string)=>Promise<{status:number, text:string}>} o.get   one raw GET (throws on network errors)
 * @param {object} [o.cache]                 {origin: {fetched, status, body}}; updated on success unless readOnly
 * @param {number} [o.retries]               same policy as page fetches: 2 retries, 2 s then 6 s
 * @returns {Promise<{status, error?, source: 'live'|'cache'|'none', cachedAt?, attempts, allowed(url):boolean, delayMs}>}
 */
export async function fetchRobots(origin, { get, cache = {}, readOnly = false, retries = 2, backoffMs = 2000, now = () => new Date().toISOString() } = {}) {
  const url = `${origin}/robots.txt`;
  let status = 0, error = null, attempts = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(backoffMs * 3 ** (attempt - 1));
    attempts++;
    try {
      const res = await get(url);
      status = res.status;
      error = null;
      if (status === 429 || status >= 500) continue;
      const body = status < 300 ? res.text : '';
      if (!readOnly) cache[origin] = { fetched: now(), status, body };
      return { status, source: 'live', attempts, ...rules(url, status, body) };
    } catch (e) {
      status = 0;
      error = e.cause?.code || (e.name === 'TimeoutError' ? 'TIMEOUT' : e.code || e.name);
    }
  }
  const c = cache[origin];
  if (c) return { status, error, source: 'cache', cachedAt: c.fetched, attempts, ...rules(url, c.status, c.body) };
  return { status, error, source: 'none', attempts, allowed: () => false, delayMs: 0 };
}

/** Why a URL can't be fetched under these rules, or null. */
export function blockedReason(r, url) {
  if (r.allowed(url)) return null;
  return r.source === 'none' ? 'unreachable' : 'disallowed';
}
