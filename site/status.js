// Status page: renders data/health.json (written by crawler/run.mjs).
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v != null && v !== false) (k === 'class' ? (e.className = v) : e.setAttribute(k, v));
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k);
  return e;
};
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const STREAK_WARN = 3;
// Problems first: failing, then suspect/warning, then skipped, then fine, then link-outs.
const ORDER = { fail: 0, warn: 1, skip: 2, ok: 3, idle: 4 };

function state(s) {
  if (s.linkOut) return ['idle', 'Link-out'];
  if (!s.crawled) return ['idle', 'Not crawled this run'];
  if (s.skipped) return ['skip', `Skipped: ${s.skipped}`];
  if (!s.ok) return ['fail', 'Failed'];
  if (s.zeroStreak >= STREAK_WARN) return ['fail', `No items for ${s.zeroStreak} runs`];
  if (s.suspect) return ['warn', s.items ? 'Suspect drop' : 'Returned nothing'];
  return ['ok', 'OK'];
}

function note(s) {
  const bits = [];
  if (s.linkOut && s.note) bits.push(s.note);
  if (s.error && !s.skipped) bits.push(s.error);
  if (s.suspect) bits.push(s.suspect);
  if (s.staleItems) bits.push(`showing ${s.staleItems} items from the last good run`);
  if (s.firstRun) bits.push('first run: no previous list to compare');
  return bits.join('; ');
}

async function main() {
  const res = await fetch('data/health.json');
  if (!res.ok) throw new Error(`health ${res.status}`);
  const h = await res.json();
  $('lede').replaceChildren(...[`Last crawl ${when(h.built)}: ${h.postings} postings`, h.gone ? `, ${h.gone} of them removed from their source` : '', '. ',
    h.run ? el('a', { href: h.run }, 'Run log') : ''].filter((x) => x !== ''));
  if (h.warnings?.length) {
    $('warnings').hidden = false;
    $('warnings').replaceChildren(...h.warnings.map((w) => el('li', {}, w)));
  }
  const rows = Object.entries(h.sources).map(([id, s]) => ({ id, s, st: state(s) }));
  // Summary line: "5 OK · 1 link-out · 0 warnings · 0 failing".
  const n = (k) => rows.filter((r) => r.st[0] === k).length;
  const linkOuts = rows.filter((r) => r.s.linkOut).length;
  const parts = [[n('ok'), 'OK'], [linkOuts, linkOuts === 1 ? 'link-out' : 'link-outs'], [n('warn'), n('warn') === 1 ? 'warning' : 'warnings'], [n('fail'), 'failing']];
  if (n('skip')) parts.push([n('skip'), 'skipped (robots.txt)']);
  const idle = n('idle') - linkOuts;
  if (idle) parts.push([idle, 'not crawled this run']);
  $('summary').replaceChildren(...parts.flatMap(([k, label], i) => [i ? ' · ' : '', el('span', { class: (label === 'failing' || /^warning/.test(label)) && k ? 'bad' : null }, `${k} ${label}`)]));
  // Each institution's pages under one name; groups with problems first.
  const groups = new Map();
  for (const r of rows) {
    const g = r.s.institution ?? r.s.name ?? r.id;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const worst = (list) => Math.min(...list.map((r) => ORDER[r.st[0]]));
  const sorted = [...groups].map(([g, list]) => [g, list.sort((a, b) => ORDER[a.st[0]] - ORDER[b.st[0]] || a.id.localeCompare(b.id))])
    .sort(([ga, a], [gb, b]) => worst(a) - worst(b) || ga.localeCompare(gb));
  const row = ({ id, s, st: [cls, label] }, grouped) => el('tr', { class: grouped ? 'page' : null },
    el('th', { scope: 'row' }, el('a', { href: s.url }, grouped ? (s.page ?? id) : s.name ?? id), el('span', { class: 'id' }, id)),
    el('td', {}, el('span', { class: `pill ${cls}` }, label)),
    el('td', { class: 'num' }, s.linkOut ? '–' : String(s.items ?? 0)),
    el('td', { class: 'num' }, s.new == null ? '–' : String(s.new)),
    el('td', { class: 'num' }, s.gone == null ? '–' : String(s.gone)),
    el('td', { class: 'date' }, s.linkOut ? '–' : when(s.lastOk)),
    el('td', { class: 'note' }, note(s)));
  $('sources').tBodies[0].replaceChildren(...sorted.flatMap(([g, list]) => (list.length === 1
    ? [row(list[0], false)]
    : [el('tr', { class: 'inst' }, el('th', { scope: 'rowgroup', colspan: '7' }, g, el('span', { class: 'count' }, `${list.length} pages`))),
      ...list.map((r) => row(r, true))])));
  $('robots').tBodies[0].replaceChildren(...Object.entries(h.robots ?? {}).map(([origin, r]) => el('tr', {},
    el('th', { scope: 'row' }, origin.replace(/^https?:\/\//, '')),
    el('td', {}, r.source === 'live' ? `fetched (${r.status})` : r.source === 'cache' ? `unreachable (${r.error || r.status}); used the copy from ${when(r.cachedAt)}` : `unreachable (${r.error || r.status}), no cached copy: nothing fetched`))));
  $('certs').tBodies[0].replaceChildren(...(h.certs ?? []).map((c) => el('tr', {},
    el('th', { scope: 'row' }, c.file), el('td', {}, c.subject),
    el('td', { class: c.daysLeft <= 30 ? 'soon' : '' }, `${c.notAfter.slice(0, 10)} (${c.daysLeft} days)`))));
}

main().catch((e) => { console.error(e); $('lede').textContent = 'The health report could not be loaded.'; });
