import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, extractDeadline } from '../crawler/lib/dates.mjs';

test('formats seen in the audit', () => {
  assert.equal(parseDate('Nov 27, 2026'), '2026-11-27');
  assert.equal(parseDate('2026-11-30 23:59:59'), '2026-11-30');
  assert.equal(parseDate('01 Dec 2026, 05:00 PM'), '2026-12-01');
  assert.equal(parseDate('18.11.2026'), '2026-11-18');
  assert.equal(parseDate('27/11/2026'), '2026-11-27');
  assert.equal(parseDate('27th November 2026'), '2026-11-27');
  assert.equal(parseDate('September 3, 2026'), '2026-09-03');
});

test('invalid and placeholder dates', () => {
  assert.equal(parseDate('0000-00-00 00:00:00'), null);
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('soon'), null);
});

test('deadline from free text prefers the date after a cue', () => {
  assert.equal(extractDeadline('Published 01.11.2026. The last date for receipt of applications is 15th December 2026.'), '2026-12-15');
  assert.equal(extractDeadline('Walk-in-interview : 18.11.2026 at 10 AM'), '2026-11-18');
  assert.equal(extractDeadline('Advertisement dated 2026-10-01.'), null);
});
