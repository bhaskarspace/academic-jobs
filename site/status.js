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

function state(s) {
  if (!s.crawled) return ['idle', 'Not crawled this run'];
  if (s.skipped) return ['skip', `Skipped: ${s.skipped}`];
  if (!s.ok) return ['fail', 'Failed'];
  if (s.zeroStreak >= STREAK_WARN) return ['fail', `No items for ${s.zeroStreak} runs`];
  if (s.suspect) return ['warn', 'Returned nothing'];
  return ['ok', 'OK'];
}

function note(s) {
  const bits = [];
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
  const rows = Object.entries(h.sources).sort(([a], [b]) => a.localeCompare(b));
  $('sources').tBodies[0].replaceChildren(...rows.map(([id, s]) => {
    const [cls, label] = state(s);
    return el('tr', {},
      el('th', { scope: 'row' }, el('a', { href: s.url }, s.name ?? id), el('span', { class: 'id' }, id)),
      el('td', {}, el('span', { class: `pill ${cls}` }, label)),
      el('td', { class: 'num' }, String(s.items ?? 0)),
      el('td', { class: 'num' }, s.new == null ? '–' : String(s.new)),
      el('td', { class: 'num' }, s.gone == null ? '–' : String(s.gone)),
      el('td', {}, when(s.lastOk)),
      el('td', { class: 'note' }, note(s)));
  }));
  $('robots').tBodies[0].replaceChildren(...Object.entries(h.robots ?? {}).map(([origin, r]) => el('tr', {},
    el('th', { scope: 'row' }, origin.replace(/^https?:\/\//, '')),
    el('td', {}, r.source === 'live' ? `fetched (${r.status})` : r.source === 'cache' ? `unreachable (${r.error || r.status}); used the copy from ${when(r.cachedAt)}` : `unreachable (${r.error || r.status}), no cached copy: nothing fetched`))));
  $('certs').tBodies[0].replaceChildren(...(h.certs ?? []).map((c) => el('tr', {},
    el('th', { scope: 'row' }, c.file), el('td', {}, c.subject),
    el('td', { class: c.daysLeft <= 30 ? 'soon' : '' }, `${c.notAfter.slice(0, 10)} (${c.daysLeft} days)`))));
}

main().catch((e) => { console.error(e); $('lede').textContent = 'The health report could not be loaded.'; });
