import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { diffLinks, updateGone, warningsFor, skipReason, suspectRun, GONE_KEEP_DAYS } from '../crawler/lib/health.mjs';
import * as htmlList from '../crawler/adapters/html-list.mjs';
import { loadConfig } from '../crawler/lib/config.mjs';
import { buildIndex } from '../search/build-index.mjs';
import { prepare, search, isExpired } from '../search/query.js';
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
  assert.match(a.title, /pune returns no or too few items/);
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

test('fixture: a restructure that leaves 3 stray links where there were 216 is a suspect run', async () => {
  const { sources } = await loadConfig();
  const s = sources.find((x) => x.id === 'iiser-pune-openings');
  const rows = htmlList.parseList(await readFile(new URL('./fixtures/iiser-pune/openings.html', import.meta.url), 'utf8'), s, s.url);
  assert.ok(rows.length >= 200);
  assert.match(suspectRun(3, rows.length), /large drop: 3 items where there were \d+/);
  assert.match(suspectRun(0, rows.length), /zero items/);
  assert.equal(suspectRun(Math.ceil(rows.length / 2), rows.length), null, 'half is still believable');
  assert.equal(suspectRun(3, 8), null, 'small boards may shrink');
  assert.match(suspectRun(0, 8), /zero items/);
  assert.equal(suspectRun(5, 0), null, 'first run');
});

test('a suspect drop counts toward the issue streak and blocks "recovered"', () => {
  const h = (streak, items, suspect) => ({ sources: { pune: { crawled: true, ok: true, items, suspect, zeroStreak: streak } }, certs: [] });
  assert.equal(planIssues(h(3, 3, 'large drop: 3 items where there were 216 (previous items kept)'), [])[0].action, 'open');
  assert.deepEqual(planIssues(h(1, 3, 'large drop'), [{ number: 9, body: '<!-- health:source:pune -->' }]), [], 'a suspect run is not a recovery');
  assert.ok(warningsFor(h(3, 3, 'large drop: 3 of 216')).some((w) => /no or too few items for 3 runs/.test(w)));
});

test('list-page removals are soft: kept while the deadline is ahead, even past the keep period', () => {
  const item = { sourceId: 'x', deadline: '2027-06-30' };
  const store = updateGone({}, { prevItems: [item], goneIds: ['x'], curIds: [], now, soft: true });
  assert.equal(store.x.soft, true);
  const later = new Date(Date.parse(now) + (GONE_KEEP_DAYS + 30) * 86_400_000).toISOString();
  assert.ok(updateGone(store, { curIds: [], now: later }).x, 'deadline still ahead');
  const hard = updateGone({}, { prevItems: [item], goneIds: ['x'], curIds: [], now });
  assert.deepEqual(updateGone(hard, { curIds: [], now: later }), {});
});

test('an institute posting off its list page stays visible until its deadline; a board posting is hidden', () => {
  const n = (src, deadline, gone, goneSoft) => ({
    ...normalize({ source: src, sourceId: `${src}:${deadline}`, url: `https://${src}/${deadline}`, title: `Postdoc ${src} ${deadline}`, deadline },
      { categorize: () => [{ category: 'postdoc', confidence: 'high' }], fieldsOf: () => [], sourceName: src, gone, goneSoft }),
    id: `${src}-${deadline}`, firstSeen: now,
  });
  const ps = [
    n('iiser-pune-openings', '2026-12-15', now, true),   // off the list, deadline ahead: visible
    n('iiser-pune-openings', '2026-11-30', now, true),   // visible until 30 Nov
    n('ajo', '2026-12-15', now, false),                   // board dropped it: closed
  ].map((p) => mergePostings([p]));
  ps.forEach((p, i) => { p.id = `d${i}`; p.firstSeen = now; });
  const idx = JSON.parse(JSON.stringify(buildIndex(ps, { built: now })));
  const [soft, soon, hardGone] = idx.docs;
  assert.equal(soft.ol, 1);
  assert.equal(hardGone.ol, undefined);
  assert.equal(isExpired(soft, '2026-11-23'), false);
  assert.equal(isExpired(soon, '2026-12-01'), true, 'hidden once its deadline passes');
  assert.equal(isExpired(hardGone, '2026-11-23'), true);
  const shown = search(prepare(idx), 'postdoc', { today: '2026-11-23' }).results.map((r) => r.doc.id);
  assert.deepEqual(shown.sort(), ['d0', 'd1']);
  const mixed = mergePostings([n('iiser-pune-openings', '2026-12-15', now, true), n('ajo', '2026-12-15', now, false)]);
  assert.equal(mixed.goneSoft, false, 'a board dropping it means it closed');
});
