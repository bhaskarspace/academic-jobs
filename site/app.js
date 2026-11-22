// Search page. Loads the prebuilt index once and searches in the browser.
import { prepare, search, highlight, isExpired } from '../search/query.js';

const PAGE = 50;
const GENERAL_PAGE = 10;
const STALE_DAYS = 120;
const CATS = [
  ['', 'All'], ['phd', 'PhD'], ['postdoc', 'Postdoc'], ['faculty', 'Faculty'], ['fellowship', 'Fellowship'], ['other', 'Other'],
];
const CAT_LABEL = Object.fromEntries(CATS.slice(1));
// Field facets. `physics` is the group of every physics field (hep-*, gr-qc, cond-mat, quant-ph,
// math-ph, astro-ph, nucl-*, nlin, physics.*), so maths and CS postings drop out in one click.
const FIELDS = [
  ['', 'All fields'], ['physics', 'Physics'], ['hep-th', 'hep-th'], ['cond-mat', 'cond-mat'], ['quant-ph', 'quant-ph'],
  ['gr-qc', 'gr-qc'], ['math-ph', 'math-ph'], ['hep-ph', 'hep-ph'], ['hep-ex', 'hep-ex'], ['hep-lat', 'hep-lat'],
  ['astro-ph', 'astro-ph'], ['nucl', 'nucl'], ['math', 'math'], ['cs', 'cs'],
];
const FIELD_KEYS = FIELDS.slice(1).map(([k]) => k);
const APPROACHES = { theory: 'Theory', computational: 'Computational', experimental: 'Experimental' };
const FIELD_HINT = { 1: 'title', 2: 'institution/subject', 4: 'ad text' };

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k);
  return e;
};

const today = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
const region = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const countryName = (c) => { try { return region?.of(c) ?? c; } catch { return c; } };
const fmtDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86_400_000);

// "New since your last visit": a visit starts when the page is opened more than 6 h after the
// previous one, so reloads within a session keep the markers.
const visits = (() => {
  const KEY = 'aj-visits';
  const now = Date.now();
  let v = null;
  try { v = JSON.parse(localStorage.getItem(KEY)); } catch { /* storage blocked */ }
  if (!v || now - v.current > 6 * 3600_000) v = { previous: v?.current ?? null, current: now };
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ }
  return v;
})();
const lastVisitDay = visits.previous ? new Date(visits.previous).toISOString().slice(0, 10) : null;

const state = { q: '', category: '', field: '', approach: '', sort: 'relevance', expired: false, shown: PAGE, generalShown: GENERAL_PAGE };
let engine = null;

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') ?? '';
  state.category = CAT_LABEL[p.get('cat')] ? p.get('cat') : '';
  state.field = FIELD_KEYS.includes(p.get('f')) ? p.get('f') : '';
  state.approach = APPROACHES[p.get('ap')] ? p.get('ap') : '';
  state.sort = ['relevance', 'deadline', 'newest'].includes(p.get('sort')) ? p.get('sort') : 'relevance';
  state.expired = p.get('expired') === '1';
  $('q').value = state.q;
  $('sort').value = state.sort;
  $('approach').value = state.approach;
  $('expired').checked = state.expired;
}

function writeUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.category) p.set('cat', state.category);
  if (state.field) p.set('f', state.field);
  if (state.approach) p.set('ap', state.approach);
  if (state.sort !== 'relevance') p.set('sort', state.sort);
  if (state.expired) p.set('expired', '1');
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function renderCats(counts) {
  const box = $('cats');
  box.replaceChildren(...CATS.map(([key, label]) => {
    const n = key ? counts[key] ?? 0 : counts.all;
    return el('button', {
      type: 'button', role: 'radio', class: 'cat', 'aria-checked': String(state.category === key),
      onclick: () => { state.category = key; resetPages(); update(); },
    }, label, el('span', { class: 'n' }, String(n)));
  }));
}

function renderFields(counts) {
  const box = $('fields');
  // Show a field only when something is in it (always keep the chosen one and the two groups).
  const shown = FIELDS.filter(([key]) => !key || key === 'physics' || key === state.field || (counts.fields[key] ?? 0) > 0);
  box.replaceChildren(...shown.map(([key, label]) => {
    const n = key ? counts.fields[key] ?? 0 : counts.anyField;
    return el('button', {
      type: 'button', role: 'radio', class: `cat${key === 'physics' ? ' group' : ''}`, 'aria-checked': String(state.field === key),
      title: key === 'physics' ? 'Every physics field: hep, gr-qc, cond-mat, quant-ph, math-ph, astro-ph, nucl, nlin' : null,
      onclick: () => { state.field = key; resetPages(); update(); },
    }, label, el('span', { class: 'n' }, String(n)));
  }));
}

const resetPages = () => { state.shown = PAGE; state.generalShown = GENERAL_PAGE; };
const where = (mask) => [1, 2, 4].filter((b) => mask & b).map((b) => FIELD_HINT[b]).join(', ');

function marked(text, terms) {
  return highlight(text, terms, engine.variants).map((s) => (s.hit ? el('mark', {}, s.text) : s.text));
}

function deadlineLine(d) {
  if (d.g) return el('span', { class: 'dl past', title: 'No source lists this advert any more; it was probably filled or withdrawn' }, `Removed from source ${fmtDate(d.g)}`);
  if (d.roll) return el('span', { class: 'dl rolling' }, 'Rolling call, no fixed deadline');
  if (!d.d) {
    // No deadline is a flag, never a reason to drop the posting. Old ones are marked as possibly closed.
    const since = d.p ?? d.fs;
    const age = since ? daysBetween(since, today) : 0;
    const txt = `No deadline found${d.p ? ` · posted ${fmtDate(d.p)}` : ''}${age > STALE_DAYS ? ' · possibly closed' : ''}`;
    return el('span', { class: 'dl none', title: 'The advert did not state a deadline we could read' }, txt);
  }
  const left = daysBetween(today, d.d);
  if (left < 0) return el('span', { class: 'dl past' }, `Closed ${fmtDate(d.d)}`);
  const hint = left === 0 ? 'today' : left === 1 ? '1 day left' : `${left} days left`;
  return el('span', { class: `dl${left <= 7 ? ' soon' : ''}` }, `Deadline ${fmtDate(d.d)} (${hint})`);
}

function card({ doc: d, matched }) {
  const terms = new Set(matched.map((m) => m.term));
  const place = [d.i, d.c ? countryName(d.c) : d.rg].filter(Boolean).join(' · ');
  const cats = d.cats.map((c) => {
    const guessed = c.confidence !== 'high';
    return el('span', {
      class: `badge cat-${c.category}${guessed ? ' guessed' : ''}`,
      title: guessed ? `Category guessed from the ${c.confidence === 'medium' ? 'title' : 'advert text'}` : 'Category given by the source',
    }, CAT_LABEL[c.category], guessed ? '?' : '');
  });
  const approaches = d.approaches.filter((a) => a.confidence !== 'low').map((a) => el('span', {
    class: 'badge approach',
    title: a.confidence === 'high' ? 'From the title' : 'Guessed from the advert text',
  }, APPROACHES[a.approach], a.confidence === 'high' ? '' : '?'));
  const isNew = lastVisitDay && d.fs && d.fs >= lastVisitDay;
  // One entry per word the user typed (AdS/CFT yields ads, cft and adscft: show it once), and
  // one chip per concept for words matched through it.
  const bySurface = new Map();
  const byConcept = new Map();
  for (const m of matched) {
    if (m.via) {
      const g = byConcept.get(m.via) ?? new Map();
      g.set(m.surface, (g.get(m.surface) ?? 0) | m.mask);
      byConcept.set(m.via, g);
    } else bySurface.set(m.surface, (bySurface.get(m.surface) ?? 0) | m.mask);
  }
  const why = bySurface.size || byConcept.size
    ? el('p', { class: 'why' },
      'Matched: ',
      [...bySurface].map(([surface, mask], i) => [i ? ', ' : '', el('b', {}, surface), ` (in ${where(mask)})`]),
      bySurface.size && byConcept.size ? ' ' : null,
      [...byConcept].map(([id, g]) => {
        const label = engine.concepts[id]?.label ?? id;
        const words = [...g];
        return el('span', { class: 'via', title: `Matched through the concept “${label}” in concepts/physics.yaml` },
          el('i', {}, `via ${label}: `), words.map(([w, mask], i) => [i ? ', ' : '', el('b', {}, w)]),
          el('i', {}, ` (${where(words.reduce((a, [, m]) => a | m, 0))})`));
      }))
    : null;
  const sources = d.s.map((name, i) => (d.su ? el('a', { href: d.su[i], class: 'src', target: '_blank', rel: 'noopener' }, name) : el('span', { class: 'src' }, name)));
  return el('li', { class: `job${isExpired(d, today) ? ' expired' : ''}` },
    el('h2', {}, el('a', { href: d.u, target: '_blank', rel: 'noopener' }, marked(d.t, terms))),
    place ? el('p', { class: 'where' }, place) : null,
    el('p', { class: 'line' }, deadlineLine(d), ...cats, ...approaches, isNew ? el('span', { class: 'badge new', title: 'First seen since your last visit' }, 'New') : null),
    d.sn ? el('p', { class: 'snippet' }, marked(d.sn, terms)) : null,
    why,
    el('p', { class: 'sources' }, 'Via ', sources.flatMap((s, i) => (i ? [' + ', s] : [s])),
      d.pdf ? [' · ', el('a', { href: d.pdf, target: '_blank', rel: 'noopener' }, 'PDF advert')] : null),
  );
}

function update() {
  writeUrl();
  const { results, mode, counts, general } = search(engine, state.q, {
    category: state.category || null, field: state.field || null, approach: state.approach || null,
    includeExpired: state.expired, sort: state.sort, today, facetKeys: FIELD_KEYS,
  });
  renderCats(counts);
  renderFields(counts);
  const n = results.length;
  const what = state.category ? CAT_LABEL[state.category].toLowerCase() + ' ' : '';
  let msg = state.q.trim()
    ? `${n} ${what}position${n === 1 ? '' : 's'} matching “${state.q.trim()}”`
    : `${n} open ${what}position${n === 1 ? '' : 's'}`;
  if (mode === 'any') msg += '. No posting has every word, so these match some of them';
  if (mode === 'none') msg = `Nothing matches “${state.q.trim()}”. Try a broader topic or another spelling`;
  $('summary').textContent = msg + '.';
  $('results').replaceChildren(...results.slice(0, state.shown).map(card));
  const left = n - state.shown;
  $('more').hidden = left <= 0;
  if (left > 0) $('more').textContent = `Show more (${left} left)`;

  const g = general?.results ?? [];
  $('general').hidden = !g.length;
  if (g.length) {
    const fields = general.fields.slice(0, 4).join(' / ') + (general.fields.length > 4 ? ' …' : '');
    $('general-head').textContent = `Open calls in ${fields} that don't name a topic (${g.length})`;
    $('general-results').replaceChildren(...g.slice(0, state.generalShown).map(card));
    const gl = g.length - state.generalShown;
    $('general-more').hidden = gl <= 0;
    if (gl > 0) $('general-more').textContent = `Show more (${gl} left)`;
  }
}

let timer;
const debounced = () => { clearTimeout(timer); timer = setTimeout(() => { resetPages(); update(); }, 120); };

async function init() {
  readUrl();
  const res = await fetch('data/index.json');
  if (!res.ok) throw new Error(`index ${res.status}`);
  const idx = await res.json();
  engine = prepare(idx);
  $('updated').textContent = `Data updated ${new Date(idx.built).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}. ${idx.n} postings indexed.`;
  $('q').addEventListener('input', () => { state.q = $('q').value; debounced(); });
  $('sort').addEventListener('change', () => { state.sort = $('sort').value; update(); });
  $('approach').addEventListener('change', () => { state.approach = $('approach').value; resetPages(); update(); });
  $('expired').addEventListener('change', () => { state.expired = $('expired').checked; resetPages(); update(); });
  $('more').addEventListener('click', () => { state.shown += PAGE; update(); });
  $('general-more').addEventListener('click', () => { state.generalShown += GENERAL_PAGE; update(); });
  update();
}

init().catch((e) => {
  console.error(e);
  $('summary').textContent = 'The postings index could not be loaded. Please try again later.';
});
