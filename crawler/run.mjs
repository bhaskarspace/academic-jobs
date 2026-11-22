#!/usr/bin/env node
// Crawl sources, normalise, assign stable IDs, merge, and write .out/postings.json.
//
//   node crawler/run.mjs --source iiser-pune-openings --dry   one source, state not written
//   node crawler/run.mjs --all                                everything (what crawl.yml runs)
//   node crawler/run.mjs --all --runner mac                   only sources marked runner: mac
//
// Options: --state DIR (.state)  --cache DIR (.cache)  --out DIR (.out)  --no-cache  --bootstrap
// Sources not crawled this run (or that fail) contribute their last good items from the cache,
// so a partial or failed run never makes postings vanish.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { Http, sha1, errorCode } from './lib/http.mjs';
import { loadState, saveState, resolveId } from './lib/state.mjs';
import { makeCategorizer, makeFieldTagger } from './lib/categorize.mjs';
import { normalize, mergePostings } from './lib/normalize.mjs';

const ADAPTERS = {
  inspire: () => import('./adapters/inspire.mjs'),
  ajo: () => import('./adapters/ajo.mjs'),
  'html-list': () => import('./adapters/html-list.mjs'),
  'html-page': () => import('./adapters/html-page.mjs'),
};

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const many = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));

const stateDir = opt('state', '.state');
const cacheDir = opt('cache', '.cache');
const outDir = opt('out', '.out');
const dry = flag('dry');
const runner = opt('runner', null);

function kv(dir) {
  const p = (k) => path.join(dir, 'kv', `${sha1(k)}.json`);
  return {
    async get(k) { if (flag('no-cache')) return null; try { return JSON.parse(await readFile(p(k), 'utf8')); } catch { return null; } },
    async set(k, v) { await mkdir(path.dirname(p(k)), { recursive: true }); await writeFile(p(k), JSON.stringify(v)); },
  };
}

const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${what} exceeded ${ms / 60000} min`), { code: 'WATCHDOG' })), ms).unref()),
]);

async function main() {
  const cfg = await loadConfig();
  const wanted = many('source');
  const all = cfg.sources.filter((s) => s.enabled !== false);
  for (const id of wanted) if (!all.some((s) => s.id === id)) throw new Error(`unknown source ${id}`);
  const selected = all.filter((s) => (flag('all') || wanted.includes(s.id)) && (!runner || (s.runner ?? 'actions') === runner));
  if (!selected.length) throw new Error('nothing to crawl: pass --source <id> or --all');

  let state;
  try { state = await loadState(stateDir, { bootstrap: flag('bootstrap') }); }
  catch (e) { if (!dry) throw e; state = await loadState(stateDir, { bootstrap: true }); }

  const http = new Http({ cacheDir: flag('no-cache') ? undefined : cacheDir, meta: state.http, log: (m) => console.error(m) });
  for (const s of all) if (s.crawlDelay) http.setHostDelay(new URL(s.url).host, s.crawlDelay);
  const cache = kv(cacheDir);
  const now = new Date().toISOString();

  const health = {};
  const itemsBySource = {};
  await Promise.all(all.map(async (s) => {
    const cachedKey = `items:${s.id}`;
    if (!selected.includes(s)) {
      itemsBySource[s.id] = (await cache.get(cachedKey)) ?? [];
      return;
    }
    const t0 = Date.now();
    const log = (m) => console.error(`[${s.id}] ${m}`);
    try {
      const mod = await ADAPTERS[s.adapter]();
      const items = await withTimeout(mod.crawl(s, { http, log, cache }), (s.timeoutMin ?? 10) * 60_000, s.id);
      itemsBySource[s.id] = items;
      await cache.set(cachedKey, items);
      health[s.id] = { ok: true, items: items.length, ms: Date.now() - t0 };
    } catch (e) {
      const prev = (await cache.get(cachedKey)) ?? [];
      itemsBySource[s.id] = prev;
      health[s.id] = { ok: false, items: 0, staleItems: prev.length, error: errorCode(e), message: String(e.message).slice(0, 300), ms: Date.now() - t0 };
      log(`FAILED ${errorCode(e)}: ${e.message}${prev.length ? ` (using ${prev.length} cached items)` : ''}`);
    }
  }));

  const categorize = makeCategorizer(cfg.categories);
  const fieldsOf = makeFieldTagger(cfg.fields);
  // A weak alias (an external URL a posting links to) is used only if exactly one item of that
  // source claims it; an umbrella ad shared by several postings must not merge them.
  const weakCount = new Map();
  for (const s of all) for (const raw of itemsBySource[s.id] ?? []) for (const a of raw.weakAliases ?? []) {
    const k = `${s.id}\t${a}`;
    weakCount.set(k, (weakCount.get(k) ?? 0) + 1);
  }
  const groups = new Map();
  for (const s of all) {
    for (const raw of itemsBySource[s.id] ?? []) {
      const weak = (raw.weakAliases ?? []).filter((a) => weakCount.get(`${s.id}\t${a}`) === 1);
      const aliases = [...new Set([raw.sourceId, ...(raw.aliases ?? []), ...weak].filter(Boolean))];
      const id = resolveId(state.ids, aliases, now);
      const p = normalize(raw, { categorize, fieldsOf, sourceName: s.name });
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(p);
    }
  }
  const postings = [...groups].map(([id, list]) => {
    const p = mergePostings(list);
    const rec = state.ids.postings[id];
    return { id, ...p, firstSeen: rec.firstSeen, lastSeen: rec.lastSeen };
  });

  for (const [id, h] of Object.entries(health)) {
    const prev = state.sources[id] ?? {};
    state.sources[id] = {
      lastRun: now,
      lastOk: h.ok ? now : prev.lastOk ?? null,
      items: h.items,
      zeroStreak: h.items === 0 ? (prev.zeroStreak ?? 0) + 1 : 0,
      error: h.error ?? null,
    };
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'postings.json'), JSON.stringify({ built: now, postings }));
  await writeFile(path.join(outDir, 'health.json'), JSON.stringify({ built: now, http: http.stats, sources: health, state: state.sources }, null, 1));
  if (!dry) await saveState(stateDir, state);

  for (const [id, h] of Object.entries(health)) console.error(`${h.ok ? 'ok  ' : 'FAIL'} ${id.padEnd(22)} ${String(h.items).padStart(5)} items  ${(h.ms / 1000).toFixed(1)} s${h.error ? `  ${h.error}` : ''}`);
  console.error(`${postings.length} postings after merging; http ${JSON.stringify(http.stats)}${dry ? ' (dry run: state not saved)' : ''}`);
  if (Object.values(health).every((h) => !h.ok)) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
