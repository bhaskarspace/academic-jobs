import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../search/build-index.mjs';
import { findEmails, indexLeaks, fixtureLeaks } from '../tools/check-emails.mjs';

const P = (id, body) => ({
  id, title: 'Postdoc', body, url: `https://x/${id}`, sources: [{ source: 's', name: 'S', url: `https://x/${id}` }],
  categories: [{ category: 'postdoc', confidence: 'high' }], fields: [], snippet: '',
});
const BODY = 'Contact Adarsh Patri at adarshpatri@gmail.com, todo(at)nifs.ac.jp, chen_[at]_as.edu.tw or see https://phys.uni.edu/jobs and physics.iisc.ac.in.';

test('findEmails sees raw, URL-encoded and (at) forms, not the placeholder', () => {
  assert.deepEqual(findEmails('a.b@uni.edu x%40y.org todo(at)nifs.ac.jp placeholder@example.org 05%7Cplaceholder%40example.org'),
    ['a.b@uni.edu', 'x%40y.org', 'todo(at)nifs.ac.jp']);
});

test('the guard flags stripped addresses in an index', () => {
  const idx = { index: { adarshpatrigmailcom: [0, 1, 4], holographi: [0, 3, 1] }, docs: [] };
  assert.ok(indexLeaks(idx).some((l) => /adarshpatrigmailcom/.test(l)));
  assert.ok(indexLeaks(idx, { postings: [P('a', BODY)] }).some((l) => /holds adarshpatrigmailcom/.test(l)));
});

test('an index built from text with addresses has none', () => {
  const postings = [P('a', BODY)];
  const idx = JSON.parse(JSON.stringify(buildIndex(postings, {})));
  assert.deepEqual(indexLeaks(idx, { postings }), []);
  assert.ok(idx.index.contact, 'ordinary words are still indexed');
});

test('the fixtures hold no email addresses', async () => {
  assert.deepEqual(await fixtureLeaks('tests/fixtures'), []);
});
