// Change detection and the per-run health report.
//
// Each source's link set (the sourceIds it listed) is kept in state. A run that returns items is
// diffed against it: new = listed now but not before; gone = listed before but not now. A gone
// item is kept (from the cache) for GONE_KEEP_DAYS:
//   - job boards (INSPIRE, AJO, MathJobs): a dropped posting has closed -> "removed from source",
//     hidden like an expired one;
//   - HTML list pages (institutes trim and paginate adverts that are still open): "soft" -> stays
//     visible until its deadline, marked "no longer on the list page".
// A suspect run (zero items where there were some, or fewer than half of a previous count of
// LARGE_DROP_MIN or more) is a probable breakage (changed markup, a block page): the previous
// items are kept, nothing is marked gone, a warning is raised, and the streak grows. After
// ISSUE_STREAK suspect runs in a row an issue is opened.
export const GONE_KEEP_DAYS = 60;
export const LARGE_DROP_MIN = 10;
export const SOFT_GONE_ADAPTERS = new Set(['html-list', 'html-table', 'rss', 'wp-json', 'js-rendered']);

/**
 * Is this run's item count believable?
 * @returns {null | string} null when fine, else the reason the run is suspect
 */
export function suspectRun(count, prevCount) {
  if (!prevCount) return null;
  if (count === 0) return 'zero items (previous items kept)';
  if (prevCount >= LARGE_DROP_MIN && count < prevCount / 2) return `large drop: ${count} items where there were ${prevCount} (previous items kept)`;
  return null;
}
export const ISSUE_STREAK = 3;
export const CERT_WARN_DAYS = 30;

/** @returns {{added: string[], gone: string[]}} */
export function diffLinks(prev = [], cur = []) {
  const p = new Set(prev), c = new Set(cur);
  return { added: cur.filter((x) => !p.has(x)), gone: prev.filter((x) => !c.has(x)) };
}

/**
 * Update the gone store with this run's diff.
 * @param {object} store   {sourceId: {item, goneSince}} for one source
 * @param {object[]} prevItems  the source's items from the last good run
 * @param {string[]} goneIds
 * @param {string[]} curIds
 */
export function updateGone(store, { prevItems = [], goneIds = [], curIds = [], now, soft = false }) {
  const out = { ...store };
  for (const id of curIds) delete out[id];                 // came back
  const byId = new Map(prevItems.map((it) => [it.sourceId, it]));
  for (const id of goneIds) if (!out[id] && byId.has(id)) out[id] = { item: byId.get(id), goneSince: now, ...(soft ? { soft: true } : {}) };
  const cutoff = new Date(Date.parse(now) - GONE_KEEP_DAYS * 86_400_000).toISOString();
  const today = now.slice(0, 10);
  // Soft entries also stay while their advert's own deadline is ahead.
  for (const [id, g] of Object.entries(out)) if (g.goneSince < cutoff && !(g.soft && g.item.deadline && g.item.deadline >= today)) delete out[id];
  return out;
}

/** Robots-related skip reason for an error code, as shown in the report. */
export function skipReason(code) {
  if (code === 'ROBOTS_DISALLOWED') return 'robots.txt disallows';
  if (code === 'ROBOTS_UNREACHABLE') return 'robots.txt unreachable';
  return null;
}

/** Warnings for the top of the report and the status page. */
export function warningsFor({ sources = {}, certs = [], robots = {} }) {
  const w = [];
  for (const [id, s] of Object.entries(sources)) {
    if (s.zeroStreak >= ISSUE_STREAK) w.push(`${id}: no or too few items for ${s.zeroStreak} runs${s.suspect ? ` (${s.suspect})` : ''}`);
    else if (s.suspect) w.push(`${id}: ${s.suspect}`);
  }
  for (const c of certs) if (c.daysLeft <= CERT_WARN_DAYS) w.push(`config/ca/${c.file} (${c.subject}) ${c.daysLeft < 0 ? 'expired' : 'expires'} ${c.notAfter.slice(0, 10)}`);
  for (const [origin, r] of Object.entries(robots)) {
    if (r.source === 'cache') w.push(`${origin}: robots.txt unreachable (${r.error || r.status}); used the copy from ${r.cachedAt?.slice(0, 10)}`);
  }
  return w;
}
