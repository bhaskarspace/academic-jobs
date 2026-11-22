import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLinks, updateGone, warningsFor, skipReason, GONE_KEEP_DAYS } from '../crawler/lib/health.mjs';
import { planIssues } from '../tools/health-issues.mjs';
import { caExpiries } from '../crawler/lib/ca.mjs';
import { normalize, mergePostings } from '../crawler/lib/normalize.mjs';

const now = '2026-11-23T00:47:00.000Z';

test('link-set diff: new and gone', () => {
  assert.deepEqual(diffLinks(['a', 'b', 'c'], ['b', 'c', 'd']), { added: ['d'], gone: ['a'] });
});

test('gone items are kept with goneSince, dropped when they return or after the keep period', () => {
  let store = updateGone({}, { prevItems: [{ sourceId: 'a', title: 'A' }, { sourceId: 'b' }], goneIds: ['a'], curIds: ['b'], now });
  assert.deepEqual(Object.keys(store), ['a']);
  assert.equal(store.a.goneSince, now);
  assert.deepEqual(updateGone(store, { curIds: ['a'], now }), {}, 'came back');
  const later = new Date(Date.parse(now) + (GONE_KEEP_DAYS + 1) * 86_400_000).toISOString();
  assert.deepEqual(updateGone(store, { curIds: [], now: later }), {}, 'expired from the store');
});

test('a posting is removed-from-source only when every source removed it', () => {
  const n = (src, gone) => normalize({ source: src, sourceId: `${src}:1`, url: `https://${src}/1`, title: 'Postdoc' },
    { categorize: () => [{ category: 'postdoc', confidence: 'high' }], fieldsOf: () => [], sourceName: src, gone });
  assert.equal(mergePostings([n('ajo', '2026-11-20T00:00:00Z'), n('inspire', null)]).gone, null);
  assert.equal(mergePostings([n('ajo', '2026-11-20T00:00:00Z'), n('inspire', '2026-11-21T00:00:00Z')]).gone, '2026-11-21T00:00:00Z');
});

test('robots skips are reported by reason', () => {
  assert.equal(skipReason('ROBOTS_DISALLOWED'), 'robots.txt disallows');
  assert.equal(skipReason('ROBOTS_UNREACHABLE'), 'robots.txt unreachable');
  assert.equal(skipReason('HTTP_500'), null);
});

test('certificate expiry warnings 30 days ahead', () => {
  const certs = caExpiries(new Date('2028-08-15T00:00:00Z'));
  const yr1 = certs.find((c) => c.file === 'letsencrypt-yr1.pem');
  assert.ok(yr1.daysLeft <= 30 && yr1.daysLeft > 0, String(yr1.daysLeft));
  assert.ok(warningsFor({ certs }).some((w) => /letsencrypt-yr1\.pem/.test(w)));
  assert.ok(!warningsFor({ certs: caExpiries(new Date('2026-11-23T00:00:00Z')) }).length);
});

const health = (streak, items = 0) => ({ run: 'https://run', sources: { pune: { name: 'IISER Pune', url: 'https://x', crawled: true, ok: true, items, zeroStreak: streak } }, certs: [] });

test('an issue opens on the third zero run, not before, and only once', () => {
  assert.deepEqual(planIssues(health(2), []), []);
  const [a] = planIssues(health(3), []);
  assert.equal(a.action, 'open');
  assert.match(a.title, /pune returns no items/);
  assert.match(a.body, /<!-- health:source:pune -->/);
  assert.deepEqual(planIssues(health(4), [{ number: 7, title: a.title, body: a.body }]), []);
});

test('the issue closes when the source recovers', () => {
  const open = [{ number: 7, body: '<!-- health:source:pune -->' }];
  const [a] = planIssues(health(0, 12), open);
  assert.equal(a.action, 'close');
  assert.equal(a.number, 7);
});

test('test-branch runs keep their own issues', () => {
  const [a] = planIssues(health(3), [{ number: 7, body: '<!-- health:source:pune -->' }], 'test-bad-selector');
  assert.equal(a.action, 'open');
  assert.match(a.title, /\[test: test-bad-selector\]/);
  assert.deepEqual(planIssues(health(0, 5), [{ number: 8, body: '<!-- health:source:pune@test-x -->' }]), [], 'main never closes a test issue');
});

test('expiring certificates open an issue', () => {
  const h = { sources: {}, certs: [{ file: 'x.pem', subject: 'X', notAfter: '2026-12-01T00:00:00Z', daysLeft: 8 }] };
  const [a] = planIssues(h, []);
  assert.equal(a.action, 'open');
  assert.match(a.title, /config\/ca\/x\.pem expires 2026-12-01/);
});
