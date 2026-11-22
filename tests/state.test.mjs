import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveId, loadState, saveState } from '../crawler/lib/state.mjs';

const fresh = () => ({ aliases: {}, postings: {} });

test('an ID is assigned at first sight and kept when another source picks the ad up', () => {
  const ids = fresh();
  const a = resolveId(ids, ['ajo:123', 'https://academicjobsonline.org/ajo/jobs/123'], '2026-11-01T00:00:00Z');
  // Later INSPIRE lists the same ad, linking to the AJO URL.
  const b = resolveId(ids, ['inspire:999', 'https://inspirehep.net/jobs/999', 'https://academicjobsonline.org/ajo/jobs/123'], '2026-11-10T00:00:00Z');
  assert.equal(a, b);
  assert.equal(ids.postings[a].firstSeen, '2026-11-01T00:00:00Z');
  // INSPIRE's own alias now resolves to the same ID, even without the AJO link.
  assert.equal(resolveId(ids, ['inspire:999'], '2026-11-11T00:00:00Z'), a);
});

test('the ID does not depend on which URL comes first', () => {
  const ids = fresh();
  const a = resolveId(ids, ['x:1', 'https://example.org/job/1'], '2026-11-01T00:00:00Z');
  assert.equal(resolveId(ids, ['https://example.org/job/1', 'x:1'], '2026-11-02T00:00:00Z'), a);
});

test('when two existing IDs meet, the older wins and the other becomes an alias', () => {
  const ids = fresh();
  const old = resolveId(ids, ['inspire:1'], '2026-10-01T00:00:00Z');
  const young = resolveId(ids, ['ajo:2'], '2026-11-01T00:00:00Z');
  const merged = resolveId(ids, ['inspire:1', 'ajo:2'], '2026-11-05T00:00:00Z');
  assert.equal(merged, old);
  assert.equal(ids.postings[young].merged, old);
  assert.equal(resolveId(ids, ['ajo:2'], '2026-11-06T00:00:00Z'), old);
});

test('state refuses to start empty unless bootstrapping', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aj-state-'));
  try {
    await assert.rejects(loadState(dir), /Refusing to start from empty state/);
    const s = await loadState(dir, { bootstrap: true });
    resolveId(s.ids, ['a:1'], '2026-11-01T00:00:00Z');
    await saveState(dir, s);
    const again = await loadState(dir);
    assert.ok(again.ids.aliases['a:1']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
