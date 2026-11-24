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
import { compileDisplay, displayInstitution } from './lib/display.mjs';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { Http, sha1, errorCode } from './lib/http.mjs';
import { loadState, saveState, resolveId, resolveExisting } from './lib/state.mjs';
import { makeCategorizer, makeFieldTagger } from './lib/categorize.mjs';
import { normalize, mergePostings } from './lib/normalize.mjs';
import { findDuplicates } from './lib/dedupe.mjs';
import { attachPdfs } from './lib/pdf.mjs';
import { carryForward } from './lib/listing.mjs';
import { advtAlias } from './lib/advert.mjs';
import { todayISO } from './lib/dates.mjs';
import { makeSubjectTest } from '../search/subject.mjs';
import { loadIndexConfig } from '../search/build-index.mjs';
import { diffLinks, updateGone, skipReason, warningsFor, suspectRun, SOFT_GONE_ADAPTERS } from './lib/health.mjs';
import { caExpiries } from './lib/ca.mjs';
import { withWatchdog } from './lib/watchdog.mjs';

const ADAPTERS = {
  inspire: () => import('./adapters/inspire.mjs'),
  ajo: () => import('./adapters/ajo.mjs'),
  'html-list': () => import('./adapters/html-list.mjs'),
  'html-page': () => import('./adapters/html-page.mjs'),
  'html-table': () => import('./adapters/html-table.mjs'),
  rss: () => import('./adapters/rss.mjs'),
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


async function main() {
  const cfg = await loadConfig();
  const wanted = many('source');
  // Link-outs are listed on the status page but never crawled.
  const linkOuts = cfg.sources.filter((s) => s.adapter === 'link-out');
  const all = cfg.sources.filter((s) => s.enabled !== false && s.adapter !== 'link-out');
  for (const id of wanted) if (!all.some((s) => s.id === id)) throw new Error(`unknown source ${id}`);
  const selected = all.filter((s) => (flag('all') || wanted.includes(s.id)) && (!runner || (s.runner ?? 'actions') === runner));
  if (!selected.length) throw new Error('nothing to crawl: pass --source <id> or --all');

  let state;
  try { state = await loadState(stateDir, { bootstrap: flag('bootstrap') }); }
  catch (e) { if (!dry) throw e; state = await loadState(stateDir, { bootstrap: true }); }

  state.robots ??= {};
  const http = new Http({ cacheDir: flag('no-cache') ? undefined : cacheDir, meta: state.http, robotsCache: state.robots, log: (m) => console.error(m) });
  for (const s of all) if (s.crawlDelay) http.setHostDelay(new URL(s.url).host, s.crawlDelay);
  // Ordinary headers a host needs (SINP returns 500 to gzip/deflate): Accept* only, checked in http.mjs.
  for (const s of all) if (s.headers) http.setHostHeaders(new URL(s.url).host, s.headers);
  const cache = kv(cacheDir);
  const now = new Date().toISOString();

  const health = {};
  const emptyOkRuns = new Set();
  const pdfReports = {};
  const itemsBySource = {};
  const goneBySource = {};
  await Promise.all(all.map(async (s) => {
    const cachedKey = `items:${s.id}`;
    const goneKey = `gone:${s.id}`;
    goneBySource[s.id] = (await cache.get(goneKey)) ?? {};
    const prevItems = (await cache.get(cachedKey)) ?? [];
    if (!selected.includes(s)) {
      itemsBySource[s.id] = prevItems;
      return;
    }
    const t0 = Date.now();
    const log = (m) => console.error(`[${s.id}] ${m}`);
    const prevState = state.sources[s.id] ?? {};
    try {
      const mod = await ADAPTERS[s.adapter]();
      const items = await withWatchdog(async (signal) => {
        const h = http.withSignal(signal);
        const got = await mod.crawl(s, { http: h, log, cache });
        // PDF adverts: text for matching, deadlines and card facts (fetched once per URL, capped).
        if (got.some((it) => it.pdfUrls?.length)) {
          pdfReports[s.id] = await attachPdfs(got, { http: h, cache, log, today: todayISO() });
          const r = pdfReports[s.id];
          log(`PDFs: ${r.fetched} fetched, ${r.skipped.length} skipped, ${r.truncated.length} truncated, ${r.imageOnly} image-only, ${r.notices} result notices${r.deferred ? `, ${r.deferred} deferred to the next run` : ''}`);
        }
        return got;
      }, (s.timeoutMin ?? 10) * 60_000, s.id);
      // A paginated list read only up to its first all-closed page, or an RSS feed showing its
      // newest N items: a posting missing from what was read has usually just moved to an unread
      // page or aged out of the feed. Carry it forward rather than mark it gone, unless it is
      // newer than the oldest row read (then it should have been there, and it was removed).
      const carried = carryForward(items, prevItems);
      if (carried.length) { items.push(...carried); log(`${carried.length} postings from unread pages carried forward`); }
      const curIds = items.map((it) => it.sourceId);
      // Admissions pages can be empty between rounds: zero is not a breakage there, as long as the
      // page still has its list markup (rows found, then filtered out as results or past rounds).
      const emptyByDesign = s.emptyOk && items.length === 0 && items.rowsSeen > 0;
      if (emptyByDesign) emptyOkRuns.add(s.id);
      const suspect = emptyByDesign ? null : suspectRun(items.length, prevItems.length || prevState.items || 0);
      if (suspect) {
        // Zero items, or a large drop: probably broken markup or a block page, not a board that
        // emptied overnight. Keep the previous items and don't mark anything gone.
        itemsBySource[s.id] = prevItems;
        health[s.id] = { ok: true, items: items.length, staleItems: prevItems.length, new: 0, gone: 0, suspect, ms: Date.now() - t0 };
        log(`${suspect}; keeping ${prevItems.length} items from the last good run`);
        return;
      }
      const { added, gone } = prevState.links ? diffLinks(prevState.links, curIds) : { added: [], gone: [] };
      goneBySource[s.id] = updateGone(goneBySource[s.id], { prevItems, goneIds: gone, curIds, now, soft: SOFT_GONE_ADAPTERS.has(s.adapter) });
      itemsBySource[s.id] = items;
      await cache.set(cachedKey, items);
      await cache.set(goneKey, goneBySource[s.id]);
      health[s.id] = { ok: true, items: items.length, new: added.length, gone: gone.length, firstRun: !prevState.links || undefined, ms: Date.now() - t0, links: curIds };
    } catch (e) {
      itemsBySource[s.id] = prevItems;
      const code = errorCode(e);
      health[s.id] = { ok: false, items: 0, staleItems: prevItems.length, error: code, skipped: skipReason(code) ?? undefined, message: String(e.message).slice(0, 300), ms: Date.now() - t0 };
      log(`FAILED ${code}: ${e.message}${prevItems.length ? ` (using ${prevItems.length} cached items)` : ''}`);
    }
  }));

  const categorize = makeCategorizer(cfg.categories);
  const fieldsOf = makeFieldTagger(cfg.fields);
  // A weak alias (an external URL a posting links to) is used only if exactly one item of that
  // source claims it; an umbrella ad shared by several postings must not merge them.
  // The Advt. No. is one too, within an institution: the same advert often sits on two of its list
  // pages (openings and postdoc), and two rows of one page with one number are not merged.
  const weakOf = (raw) => [...(raw.weakAliases ?? []), advtAlias(raw)].filter(Boolean);
  const weakCount = new Map();
  for (const s of all) for (const raw of itemsBySource[s.id] ?? []) for (const a of weakOf(raw)) {
    const k = `${s.id}\t${a}`;
    weakCount.set(k, (weakCount.get(k) ?? 0) + 1);
  }
  const groups = new Map();
  for (const s of all) {
    const live = (itemsBySource[s.id] ?? []).map((raw) => [raw, null]);
    const live_ids = new Set(live.map(([raw]) => raw.sourceId));
    const gone = Object.values(goneBySource[s.id] ?? {}).filter((g) => !live_ids.has(g.item.sourceId)).map((g) => [g.item, g]);
    for (const [raw, g] of [...live, ...gone]) {
      const goneSince = g?.goneSince ?? null;
      const weak = weakOf(raw).filter((a) => weakCount.get(`${s.id}\t${a}`) === 1);
      const aliases = [...new Set([raw.sourceId, ...(raw.aliases ?? []), ...weak].filter(Boolean))];
      const id = goneSince ? resolveExisting(state.ids, aliases) : resolveId(state.ids, aliases, now);
      if (!id) continue;
      const p = normalize(raw, { categorize, fieldsOf, sourceName: s.name, gone: goneSince, goneSoft: Boolean(g?.soft) });
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(p);
    }
  }
  // Cross-source duplicates that share no URL (same advert, different title and link): merged by
  // institution + deadline + description similarity (crawler/lib/dedupe.mjs). Recomputed every
  // run; IDs are untouched, and the merged posting takes the ID seen first.
  const firstSeenOf = (id) => state.ids.postings[id]?.firstSeen ?? now;
  const pre = [...groups].map(([id, list]) => ({ id, ...mergePostings(list.map((q) => ({ ...q, sources: [...q.sources] }))), firstSeen: firstSeenOf(id) }));
  const dups = findDuplicates(pre, cfg.institutions);
  for (const { keep, drop, score, titles } of dups) {
    if (!groups.has(keep) || !groups.has(drop)) continue;
    groups.get(keep).push(...groups.get(drop));
    groups.delete(drop);
    if (flag('verbose-dedupe')) console.error(`dedupe ${score}: ${keep} <- ${drop}  ${titles.map((t) => t.slice(0, 55)).join('  ||  ')}`);
  }
  const { variants, concepts } = await loadIndexConfig();
  const namesSubject = makeSubjectTest({ fields: cfg.fields, concepts, variants });
  const display = compileDisplay(cfg.institutions.display);
  const postings = [...groups].map(([id, list]) => {
    const p = displayInstitution(mergePostings(list, { namesSubject }), display);
    const rec = state.ids.postings[id];
    return { id, ...p, firstSeen: list.length > 1 ? [rec.firstSeen, ...dups.filter((d) => d.keep === id).map((d) => firstSeenOf(d.drop))].sort()[0] : rec.firstSeen, lastSeen: rec.lastSeen };
  });

  for (const [id, h] of Object.entries(health)) {
    const prev = state.sources[id] ?? {};
    state.sources[id] = {
      lastRun: now,
      lastOk: h.ok && !h.suspect ? now : prev.lastOk ?? null,
      items: h.items,
      // Runs in a row with no items or a suspect drop (named zeroStreak for history).
      // An admissions page with no open round is empty by design (emptyOk), not broken.
      zeroStreak: (h.items === 0 && !emptyOkRuns.has(id)) || h.suspect ? (prev.zeroStreak ?? 0) + 1 : 0,
      error: h.error ?? null,
      links: h.links ?? prev.links,
    };
    delete h.links;
    h.zeroStreak = state.sources[id].zeroStreak;
    h.lastOk = state.sources[id].lastOk;
  }
  // Every source in the report, including ones not crawled this run.
  const report = {};
  for (const s of all) {
    const st = state.sources[s.id] ?? {};
    report[s.id] = { name: s.name, institution: s.institution ?? s.name, page: s.page ?? pageLabel(s), url: s.url, crawled: Boolean(health[s.id]), ...(health[s.id] ?? { items: st.items ?? 0 }), zeroStreak: st.zeroStreak ?? 0, lastRun: st.lastRun ?? null, lastOk: st.lastOk ?? null };
    if (pdfReports[s.id]) {
      const r = pdfReports[s.id];
      report[s.id].pdf = { fetched: r.fetched, skipped: r.skipped.length, truncated: r.truncated.length, imageOnly: r.imageOnly, notices: r.notices, deferred: r.deferred };
    }
  }
  for (const s of linkOuts) report[s.id] = { name: s.name, institution: s.institution ?? s.name, url: s.url, linkOut: true, note: s.note ?? null, crawled: false, items: 0, zeroStreak: 0 };
  const certs = caExpiries(new Date(now));
  const robots = await http.robotsReport();
  const out = { built: now, run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    postings: postings.length, gone: postings.filter((p) => p.gone).length, http: http.stats, sources: report, robots, certs,
    // PDFs not read in full: skipped (too large, robots, not a PDF, fetch failed) or cut at 10 pages.
    pdfs: {
      skipped: Object.entries(pdfReports).flatMap(([source, r]) => r.skipped.map((x) => ({ source, ...x }))),
      truncated: Object.entries(pdfReports).flatMap(([source, r]) => r.truncated.map((x) => ({ source, ...x }))),
      imageOnly: Object.values(pdfReports).reduce((a, r) => a + r.imageOnly, 0),
      deferred: Object.values(pdfReports).reduce((a, r) => a + r.deferred, 0),
    } };
  out.warnings = warningsFor(out);

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'postings.json'), JSON.stringify({ built: now, postings }));
  await writeFile(path.join(outDir, 'health.json'), JSON.stringify(out, null, 1));
  if (!dry) await saveState(stateDir, state);

  for (const w of out.warnings) console.error(`::warning::${w}`);
  for (const [id, h] of Object.entries(health)) console.error(`${h.ok ? 'ok  ' : 'FAIL'} ${id.padEnd(22)} ${String(h.items).padStart(5)} items  +${h.new ?? 0} -${h.gone ?? 0}  ${(h.ms / 1000).toFixed(1)} s${h.error ? `  ${h.error}` : ''}${h.suspect ? `  ${h.suspect}` : ''}`);
  console.error(`${dups.length} cross-source duplicates merged by similarity`);
  console.error(`${postings.length} postings after merging; http ${JSON.stringify(http.stats)}${dry ? ' (dry run: state not saved)' : ''}`);
  if (Object.values(health).every((h) => !h.ok)) process.exitCode = 1;
}

// "openings", "postdoc": the page part of a source's URL, for rows grouped under an institution.
function pageLabel(s) {
  try { return decodeURIComponent(new URL(s.url).pathname.split('/').filter(Boolean).at(-1) ?? s.id).replace(/[-_]+/g, ' '); } catch { return s.id; }
}

main().catch((e) => { console.error(e); process.exit(1); });
