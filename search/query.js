// Search over the prebuilt index. Runs in the browser; also imported by tests and tools.
import { tokenize } from './tokenize.js';

export const CATEGORY = { phd: 'phd', pd: 'postdoc', fac: 'faculty', fel: 'fellowship', oth: 'other' };
export const CONFIDENCE = { h: 'high', m: 'medium', l: 'low' };
const K1 = 1.2;
const B = 0.75;

export function prepare(idx) {
  const docs = idx.docs.map((d, ix) => ({
    ...d,
    ix,
    cats: d.cat.map((x) => { const [c, k] = x.split(':'); return { category: CATEGORY[c], confidence: CONFIDENCE[k] }; }),
  }));
  const decoded = new Map();
  const postings = (term) => {
    if (decoded.has(term)) return decoded.get(term);
    const flat = idx.index[term];
    let m = null;
    if (flat) {
      m = new Map();
      let doc = 0;
      for (let j = 0; j < flat.length; j += 3) { doc += flat[j]; m.set(doc, { wtf: flat[j + 1], mask: flat[j + 2] }); }
    }
    decoded.set(term, m);
    return m;
  };
  return { idx, docs, postings, variants: idx.variants ?? {}, n: idx.n, avgLen: idx.avgLen || 1 };
}

export function parseQuery(engine, q) {
  const toks = tokenize(q ?? '', { variants: engine.variants });
  const required = new Map();
  const optional = new Map();
  for (const t of toks) {
    // Report the whole typed word ("AdS/CFT"), not its parts, so the UI lists it once.
    let a = t.start, b = t.end;
    while (a > 0 && !/\s/.test(q[a - 1])) a--;
    while (b < q.length && !/\s/.test(q[b])) b++;
    const surface = q.slice(a, b).replace(/^[("'“]+|[)"'”.,;:!?]+$/g, '');
    if (t.joined) { if (!required.has(t.term)) optional.set(t.term, surface); }
    else { required.set(t.term, surface); optional.delete(t.term); }
  }
  return { required, optional };
}

export const isExpired = (d, today) => Boolean(d.d && d.d < today);

/**
 * @returns {{results: Array<{doc, score, matched: Array<{term, surface, mask}>}>, mode: 'all'|'any'|'browse'|'none', counts: object}}
 */
export function search(engine, q, { category = null, includeExpired = false, sort = 'relevance', today } = {}) {
  today ??= new Date().toISOString().slice(0, 10);
  const { required, optional } = parseQuery(engine, q);
  let mode = 'browse';
  let scored;

  if (required.size || optional.size) {
    const terms = [...required.keys()];
    const lists = terms.map((t) => engine.postings(t));
    let cands = null;
    if (terms.length && lists.every(Boolean)) {
      const [first, ...rest] = [...lists].sort((a, b) => a.size - b.size);
      cands = [...first.keys()].filter((d) => rest.every((l) => l.has(d)));
    }
    mode = 'all';
    if (!cands?.length) {
      // Fall back to "any word" so a typo or a rare word doesn't blank the page.
      const any = new Set();
      for (const l of [...lists, ...[...optional.keys()].map((t) => engine.postings(t))]) if (l) for (const d of l.keys()) any.add(d);
      cands = [...any];
      mode = cands.length ? (terms.length > 1 ? 'any' : 'all') : 'none';
    }
    const all = new Map([...required, ...optional]);
    scored = cands.map((di) => {
      const doc = engine.docs[di];
      let score = 0;
      const matched = [];
      for (const [term, surface] of all) {
        const l = engine.postings(term);
        const e = l?.get(di);
        if (!e) continue;
        const df = l.size;
        const idf = Math.log(1 + (engine.n - df + 0.5) / (df + 0.5));
        const norm = e.wtf + K1 * (1 - B + B * (doc.len / engine.avgLen));
        score += idf * ((e.wtf * (K1 + 1)) / norm);
        matched.push({ term, surface, mask: e.mask });
      }
      return { doc, score, matched };
    });
  } else {
    scored = engine.docs.map((doc) => ({ doc, score: 0, matched: [] }));
  }

  const live = scored.filter((r) => includeExpired || !isExpired(r.doc, today));
  const counts = { all: live.length };
  for (const r of live) for (const c of new Set(r.doc.cats.map((x) => x.category))) counts[c] = (counts[c] ?? 0) + 1;
  let results = category ? live.filter((r) => r.doc.cats.some((c) => c.category === category)) : live;

  const newest = (a, b) => (b.doc.fs ?? '').localeCompare(a.doc.fs ?? '') || (b.doc.p ?? '').localeCompare(a.doc.p ?? '');
  const deadline = (a, b) => {
    const ea = isExpired(a.doc, today), eb = isExpired(b.doc, today);
    if (ea !== eb) return ea ? 1 : -1;
    if (!a.doc.d !== !b.doc.d) return a.doc.d ? -1 : 1;
    return (a.doc.d ?? '').localeCompare(b.doc.d ?? '') || newest(a, b);
  };
  const relevance = (a, b) => b.score - a.score || newest(a, b);
  results = [...results].sort(sort === 'deadline' ? deadline : sort === 'newest' ? newest : mode === 'browse' ? newest : relevance);
  return { results, mode, counts };
}

// Split text into [{text, hit}] segments, marking tokens whose term is in `terms`.
export function highlight(text, terms, variants) {
  if (!text) return [];
  const spans = tokenize(text, { variants }).filter((t) => terms.has(t.term)).sort((a, b) => a.start - b.start);
  const out = [];
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue;
    if (s.start > at) out.push({ text: text.slice(at, s.start), hit: false });
    out.push({ text: text.slice(s.start, s.end), hit: true });
    at = s.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
