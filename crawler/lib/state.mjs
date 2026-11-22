// Persistent crawl state. Lives on the `state` branch (checked out into .state/ by crawl.yml).
//   ids.json       { aliases: {alias: id}, postings: {id: {firstSeen, lastSeen, merged?}} }
//   http.json      { url: {etag, lastModified, contentType} }
//   sources.json   { sourceId: {lastRun, lastOk, items, zeroStreak, error} }
//   meta.json      { version, updated }
// Posting IDs are assigned ONCE, at first sight, and never recomputed: later URLs from other
// sources become aliases of the existing ID (so firstSeen survives INSPIRE picking up an AJO ad).
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { sha1 } from './http.mjs';

const FILES = ['ids', 'http', 'sources', 'meta'];

export async function loadState(dir, { bootstrap = false } = {}) {
  const exists = await access(path.join(dir, 'meta.json')).then(() => true, () => false);
  if (!exists) {
    if (!bootstrap) throw new Error(`No state in ${dir}. Refusing to start from empty state; pass --bootstrap only for the very first run.`);
    return { ids: { aliases: {}, postings: {} }, http: {}, sources: {}, meta: { version: 1, created: new Date().toISOString() } };
  }
  const s = {};
  for (const f of FILES) s[f] = JSON.parse(await readFile(path.join(dir, `${f}.json`), 'utf8').catch(() => '{}'));
  s.ids.aliases ??= {};
  s.ids.postings ??= {};
  return s;
}

export async function saveState(dir, state) {
  await mkdir(dir, { recursive: true });
  state.meta.updated = new Date().toISOString();
  for (const f of FILES) await writeFile(path.join(dir, `${f}.json`), JSON.stringify(state[f], null, f === 'ids' ? 0 : 1) + '\n');
}

function follow(ids, id) {
  const seen = new Set();
  while (ids.postings[id]?.merged && !seen.has(id)) { seen.add(id); id = ids.postings[id].merged; }
  return id;
}

/**
 * Resolve a raw item's aliases to its stable posting ID, assigning a new one at first sight.
 * If the aliases point at two existing IDs, the older (earliest firstSeen) wins and the other
 * is recorded as merged into it.
 */
export function resolveId(ids, aliases, now) {
  const found = [...new Set(aliases.map((a) => ids.aliases[a]).filter(Boolean).map((id) => follow(ids, id)))];
  let id;
  if (!found.length) {
    id = 'p' + sha1(aliases[0]).slice(0, 12);
    for (let n = 1; ids.postings[id]; n++) id = 'p' + sha1(`${aliases[0]}#${n}`).slice(0, 12); // hash collision
    ids.postings[id] = { firstSeen: now, lastSeen: now };
  } else {
    found.sort((a, b) => (ids.postings[a]?.firstSeen ?? now).localeCompare(ids.postings[b]?.firstSeen ?? now) || a.localeCompare(b));
    id = found[0];
    for (const other of found.slice(1)) {
      const o = ids.postings[other];
      ids.postings[id].firstSeen = [ids.postings[id].firstSeen, o?.firstSeen].filter(Boolean).sort()[0];
      ids.postings[other] = { ...o, merged: id };
    }
  }
  for (const a of aliases) ids.aliases[a] = id;
  ids.postings[id].lastSeen = now;
  return id;
}
