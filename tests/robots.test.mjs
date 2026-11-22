import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRobots, blockedReason } from '../crawler/lib/robots.mjs';

const O = 'https://www.example.ac.in';
const PAGE = `${O}/careers`;
const reset = () => { throw Object.assign(new Error('reset'), { cause: { code: 'ECONNRESET' } }); };
const seq = (...steps) => { let i = 0; return async () => { const s = steps[Math.min(i++, steps.length - 1)]; return typeof s === 'function' ? s() : s; }; };
const opts = (get, cache = {}) => ({ get, cache, backoffMs: 0, now: () => '2026-11-23T00:47:00Z' });

test('a transient failure is retried (IIT Kharagpur: ECONNRESET, then 200)', async () => {
  const cache = {};
  const r = await fetchRobots(O, opts(seq(reset, { status: 200, text: 'User-agent: *\nAllow: /' }), cache));
  assert.equal(r.source, 'live');
  assert.equal(r.attempts, 2);
  assert.equal(blockedReason(r, PAGE), null);
  assert.equal(cache[O].status, 200, 'the good copy is kept');
});

test('5xx is retried like a page fetch', async () => {
  const r = await fetchRobots(O, opts(seq({ status: 503, text: '' }, { status: 503, text: '' }, { status: 200, text: '' })));
  assert.equal(r.source, 'live');
  assert.equal(r.attempts, 3);
});

test('unreachable after retries: the last good copy is used (NCBS: connect timeout)', async () => {
  const cache = { [O]: { fetched: '2026-11-20T00:47:00Z', status: 200, body: 'User-agent: *\nDisallow: /private/' } };
  const r = await fetchRobots(O, opts(reset, cache));
  assert.equal(r.source, 'cache');
  assert.equal(r.cachedAt, '2026-11-20T00:47:00Z');
  assert.equal(r.error, 'ECONNRESET');
  assert.equal(blockedReason(r, PAGE), null);
  assert.equal(blockedReason(r, `${O}/private/x`), 'disallowed');
});

test('unreachable with no copy: disallow all, reported as unreachable', async () => {
  const r = await fetchRobots(O, opts(reset));
  assert.equal(r.source, 'none');
  assert.equal(r.attempts, 3);
  assert.equal(blockedReason(r, PAGE), 'unreachable');
});

test('a 4xx robots.txt allows everything; Disallow: / is "disallowed", not "unreachable"', async () => {
  assert.equal(blockedReason(await fetchRobots(O, opts(seq({ status: 404, text: '' }))), PAGE), null);
  const r = await fetchRobots(O, opts(seq({ status: 200, text: 'User-agent: *\nDisallow: /' })));
  assert.equal(blockedReason(r, PAGE), 'disallowed');
});

test('read-only callers do not update the cache', async () => {
  const cache = {};
  await fetchRobots(O, { ...opts(seq({ status: 200, text: '' }), cache), readOnly: true });
  assert.deepEqual(cache, {});
});
