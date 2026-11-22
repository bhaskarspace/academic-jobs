// Change detection and the per-run health report.
//
// Each source's link set (the sourceIds it listed) is kept in state. A run that returns items is
// diffed against it: new = listed now but not before; gone = listed before but not now. A gone
// item is kept (from the cache) as a "removed from source" posting, hidden like an expired one,
// for GONE_KEEP_DAYS. A run that returns zero items where the last one had some is treated as a
// probable breakage (changed markup, a block page): the previous items are kept, nothing is
// marked gone, and the zero streak grows. After ISSUE_STREAK zero runs an issue is opened.
export const GONE_KEEP_DAYS = 60;
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
export function updateGone(store, { prevItems = [], goneIds = [], curIds = [], now }) {
  const out = { ...store };
  for (const id of curIds) delete out[id];                 // came back
  const byId = new Map(prevItems.map((it) => [it.sourceId, it]));
  for (const id of goneIds) if (!out[id] && byId.has(id)) out[id] = { item: byId.get(id), goneSince: now };
  const cutoff = new Date(Date.parse(now) - GONE_KEEP_DAYS * 86_400_000).toISOString();
  for (const [id, g] of Object.entries(out)) if (g.goneSince < cutoff) delete out[id];
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
    if (s.zeroStreak >= ISSUE_STREAK) w.push(`${id}: no items for ${s.zeroStreak} runs`);
    else if (s.suspect) w.push(`${id}: ${s.suspect}`);
  }
  for (const c of certs) if (c.daysLeft <= CERT_WARN_DAYS) w.push(`config/ca/${c.file} (${c.subject}) ${c.daysLeft < 0 ? 'expired' : 'expires'} ${c.notAfter.slice(0, 10)}`);
  for (const [origin, r] of Object.entries(robots)) {
    if (r.source === 'cache') w.push(`${origin}: robots.txt unreachable (${r.error || r.status}); used the copy from ${r.cachedAt?.slice(0, 10)}`);
  }
  return w;
}
