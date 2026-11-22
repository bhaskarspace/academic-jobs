// Search over the prebuilt index. Runs in the browser; also imported by tests and tools.
//
// A query is split into clauses, one per typed word, or one per concept phrase ("quantum chaos").
// A clause is satisfied by a literal hit (any of its alternatives: the typed words, the joined
// form of a compound, or a synonym from the concept's `query:` list) or by an expanded hit on one
// of the concept's member terms. Expanded hits count only when the posting's fields pass the
// concept's field gate, and they score below literal hits. Literal hits on a different surface
// form of the same stem ("Topology" for "topological") score below exact-form hits.
import { tokenize } from './tokenize.js';
import { makePhraseMatcher, fieldsPass, isPhysicsField } from './concepts.js';

export const CATEGORY = { phd: 'phd', pd: 'postdoc', fac: 'faculty', fel: 'fellowship', oth: 'other' };
export const CONFIDENCE = { h: 'high', m: 'medium', l: 'low' };
export const APPROACH = { th: 'theory', comp: 'computational', exp: 'experimental' };
const CONF_RANK = { low: 1, medium: 2, high: 3 };
const K1 = 1.2;
const B = 0.75;
const FORM_SHIFT = 3;   // must match build-index.mjs
const STEM_ONLY = 0.6;  // a stem-only hit when the typed form exists elsewhere in the corpus
const SYNONYM = 0.9;    // another `query:` entry of the concept
const EXPANDED = 0.5;   // a member term of the concept
const FIELD_MASK = 7;

export function prepare(idx) {
  const docs = idx.docs.map((d, ix) => ({
    ...d,
    ix,
    cats: d.cat.map((x) => { const [c, k] = x.split(':'); return { category: CATEGORY[c], confidence: CONFIDENCE[k] }; }),
    approaches: (d.ap ?? []).map((x) => { const [a, k] = x.split(':'); return { approach: APPROACH[a], confidence: CONFIDENCE[k] }; }),
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
  const concepts = idx.concepts ?? {};
  // query key -> concept ids; multi-word query keys are found with a phrase matcher
  const queryKeys = new Map();
  const queryPhrases = [];
  for (const [id, c] of Object.entries(concepts)) {
    for (const e of c.query) {
      queryKeys.set(e.key, [...(queryKeys.get(e.key) ?? []), id]);
      if (e.terms.length > 1) queryPhrases.push(e.terms);
    }
  }
  return {
    idx, docs, postings, concepts, queryKeys,
    matchQueryPhrases: makePhraseMatcher(queryPhrases),
    variants: idx.variants ?? {}, forms: idx.forms ?? {}, n: idx.n, avgLen: idx.avgLen || 1,
  };
}

// The whole typed word around a token ("AdS/CFT"), so the UI lists it once.
function typedWord(q, start, end) {
  let a = start, b = end;
  while (a > 0 && !/\s/.test(q[a - 1])) a--;
  while (b < q.length && !/\s/.test(q[b])) b++;
  return { a, b, text: q.slice(a, b).replace(/^[("'“]+|[)"'”.,;:!?]+$/g, '') };
}

/**
 * @returns {{clauses: Array<{surface, alts: Array<{terms: Array<{term, form}>, weight, surface?, via?}>, concepts: string[]}>}}
 */
export function parseQuery(engine, q) {
  q ??= '';
  const toks = tokenize(q, { variants: engine.variants }).map((t) => ({ ...t, word: typedWord(q, t.start, t.end) }));
  const seq = toks.filter((t) => !t.joined);
  const clauses = [];
  const used = new Set();

  // Concept phrases first ("quantum chaos", "many body"), longest match wins.
  const phraseHits = engine.matchQueryPhrases(toks).sort((x, y) => x.start - y.start || y.end - x.end);
  for (const h of phraseHits) {
    const covered = seq.filter((t) => t.start >= h.start && t.end <= h.end);
    if (covered.some((t) => used.has(t))) continue;
    covered.forEach((t) => used.add(t));
    const words = toks.filter((t) => t.start >= h.start && t.end <= h.end);
    const surface = q.slice(Math.min(...words.map((t) => t.word.a)), Math.max(...words.map((t) => t.word.b))).trim();
    clauses.push({ at: h.start, surface, typed: covered, concepts: engine.queryKeys.get(h.term) ?? [] });
  }
  // Then one clause per typed word: its parts, plus its joined form as an alternative.
  const byWord = new Map();
  for (const t of toks) {
    if (used.has(t) || (t.joined && seq.some((s) => used.has(s) && s.word.a === t.word.a))) continue;
    const w = byWord.get(t.word.a) ?? { at: t.word.a, surface: t.word.text, typed: [], joined: null };
    if (t.joined) w.joined = t; else w.typed.push(t);
    byWord.set(t.word.a, w);
  }
  for (const w of byWord.values()) {
    const keys = [...w.typed.map((t) => t.term), w.joined?.term].filter(Boolean);
    const concepts = [...new Set(keys.flatMap((k) => (w.typed.length === 1 || k === w.joined?.term ? engine.queryKeys.get(k) ?? [] : [])))];
    clauses.push({ ...w, concepts });
  }
  clauses.sort((x, y) => x.at - y.at);

  for (const c of clauses) {
    const alts = [];
    const seen = new Set();
    const add = (terms, weight, extra = {}) => {
      const k = terms.map((t) => t.term).join('|');
      if (!terms.length || seen.has(k)) return;
      seen.add(k);
      alts.push({ terms, weight, ...extra });
    };
    add(c.typed.map((t) => ({ term: t.term, form: t.form })), 1);
    if (c.joined) add([{ term: c.joined.term, form: c.joined.form }], 1);
    for (const id of c.concepts) {
      for (const e of engine.concepts[id].query) add([{ term: e.key }], SYNONYM, { surface: e.surface, via: id });
    }
    c.alts = alts;
    delete c.typed; delete c.joined; delete c.at;
  }
  return { clauses: clauses.filter((c) => c.alts.length) };
}

export const isExpired = (d, today) => Boolean(d.d && d.d < today);

/** Does a document match a field facet? `physics` is the group of every physics field. */
export function fieldFacet(d, key) {
  if (!key) return true;
  const fs = d.f ?? [];
  if (key === 'physics') return fs.some(isPhysicsField);
  return fs.some((f) => f === key || f.startsWith(`${key}-`) || f.startsWith(`${key}.`));
}

/**
 * Approach filter: untagged postings stay; a tagged posting stays when the chosen approach is
 * at least as confident as any other tag (an "Experimental ..." title with one "theory" in the
 * text is hidden under Theory).
 */
export function approachFacet(d, key) {
  if (!key || !d.approaches.length) return true;
  const mine = d.approaches.find((a) => a.approach === key);
  if (!mine) return false;
  const others = d.approaches.filter((a) => a.approach !== key).map((a) => CONF_RANK[a.confidence]);
  return CONF_RANK[mine.confidence] >= Math.max(0, ...others);
}

/**
 * @returns {{results: Array<{doc, score, matched: Array<{term, surface, mask, via?, exact?}>}>,
 *   mode: 'all'|'any'|'browse'|'none', counts: {all, [category]: n, fields: {[key]: n}},
 *   general: null | {fields: string[], results: Array<{doc}>}}}
 */
export function search(engine, q, { category = null, field = null, approach = null, includeExpired = false, sort = 'relevance', today, facetKeys = [] } = {}) {
  today ??= new Date().toISOString().slice(0, 10);
  const { clauses } = parseQuery(engine, q);
  let mode = 'browse';
  let scored;

  const bm25 = (doc, e, df) => {
    const idf = Math.log(1 + (engine.n - df + 0.5) / (df + 0.5));
    const norm = e.wtf + K1 * (1 - B + B * (doc.len / engine.avgLen));
    return idf * ((e.wtf * (K1 + 1)) / norm);
  };

  if (clauses.length) {
    // Docs satisfying each clause.
    const sat = clauses.map((c) => {
      const s = new Set();
      for (const alt of c.alts) {
        const lists = alt.terms.map((t) => engine.postings(t.term));
        if (!lists.every(Boolean)) continue;
        const [first, ...rest] = [...lists].sort((a, b) => a.size - b.size);
        for (const d of first.keys()) if (rest.every((l) => l.has(d))) s.add(d);
      }
      const literal = new Set(s);
      for (const id of c.concepts) {
        const concept = engine.concepts[id];
        const weakHits = new Map();
        for (const m of concept.members) {
          const l = engine.postings(m.key);
          if (!l) continue;
          for (const d of l.keys()) {
            if (!fieldsPass(engine.docs[d].f, concept)) continue;
            if (!m.weak) s.add(d);
            else weakHits.set(d, (weakHits.get(d) ?? 0) + 1);
          }
        }
        // A weak member counts next to a literal hit, another member, or a second weak member.
        for (const [d, k] of weakHits) if (k >= 2 || literal.has(d)) s.add(d);
      }
      return s;
    });
    const [first, ...rest] = [...sat].sort((a, b) => a.size - b.size);
    let cands = [...first].filter((d) => rest.every((s) => s.has(d)));
    mode = 'all';
    if (!cands.length) {
      // Fall back to "any word" so a typo or a rare word doesn't blank the page.
      cands = [...new Set(sat.flatMap((s) => [...s]))];
      mode = cands.length ? (clauses.length > 1 ? 'any' : 'all') : 'none';
    }
    scored = cands.map((di) => {
      const doc = engine.docs[di];
      let score = 0;
      const matched = [];
      for (const c of clauses) {
        // Literal: the best alternative.
        let best = 0, bestMatched = [];
        for (const alt of c.alts) {
          let s = 0;
          const m = [];
          for (const t of alt.terms) {
            const l = engine.postings(t.term);
            const e = l?.get(di);
            if (!e) { s = 0; break; }
            let factor = alt.weight;
            let exact;
            const forms = t.form && engine.forms[t.term];
            if (forms) {
              const fi = forms.indexOf(t.form);
              if (fi >= 0) { exact = Boolean(e.mask & (1 << (FORM_SHIFT + fi))); if (!exact) factor *= STEM_ONLY; }
            }
            s += factor * bm25(doc, e, l.size);
            m.push({ term: t.term, surface: alt.surface ?? c.surface, mask: e.mask & FIELD_MASK, via: alt.via, exact });
          }
          if (s > best) { best = s; bestMatched = m; }
        }
        // Expanded: member terms of the clause's concepts, if the posting passes the field gate.
        const exp = [];
        for (const id of c.concepts) {
          const concept = engine.concepts[id];
          if (!fieldsPass(doc.f, concept)) continue;
          const hits = [];
          for (const mem of concept.members) {
            const l = engine.postings(mem.key);
            const e = l?.get(di);
            if (e) hits.push({ weak: mem.weak, s: bm25(doc, e, l.size), m: { term: mem.key, surface: mem.surface, mask: e.mask & FIELD_MASK, via: id, member: true } });
          }
          const strong = hits.some((h) => !h.weak);
          if (strong || best > 0 || hits.length >= 2) exp.push(...hits);
        }
        exp.sort((a, b) => b.s - a.s);
        const expScore = exp.length ? exp[0].s + 0.3 * exp.slice(1, 4).reduce((a, x) => a + x.s, 0) : 0;
        score += best + EXPANDED * expScore;
        matched.push(...bestMatched);
        const seenM = new Set(bestMatched.map((m) => m.term));
        for (const x of exp) if (!seenM.has(x.m.term)) { seenM.add(x.m.term); matched.push(x.m); }
      }
      return { doc, score, matched };
    });
  } else {
    scored = engine.docs.map((doc) => ({ doc, score: 0, matched: [] }));
  }

  const live = scored.filter((r) => includeExpired || !isExpired(r.doc, today));
  const byApproach = live.filter((r) => approachFacet(r.doc, approach));
  // Facet counts: each facet counts under the other facets' filters.
  const inField = byApproach.filter((r) => fieldFacet(r.doc, field));
  const counts = { all: inField.length, fields: {} };
  for (const r of inField) for (const c of new Set(r.doc.cats.map((x) => x.category))) counts[c] = (counts[c] ?? 0) + 1;
  const inCat = category ? byApproach.filter((r) => r.doc.cats.some((c) => c.category === category)) : byApproach;
  for (const k of facetKeys) counts.fields[k] = inCat.filter((r) => fieldFacet(r.doc, k)).length;
  counts.anyField = inCat.length;
  let results = inCat.filter((r) => fieldFacet(r.doc, field));

  const newest = (a, b) => (b.doc.fs ?? '').localeCompare(a.doc.fs ?? '') || (b.doc.p ?? '').localeCompare(a.doc.p ?? '');
  const deadline = (a, b) => {
    const ea = isExpired(a.doc, today), eb = isExpired(b.doc, today);
    if (ea !== eb) return ea ? 1 : -1;
    if (!a.doc.d !== !b.doc.d) return a.doc.d ? -1 : 1;
    return (a.doc.d ?? '').localeCompare(b.doc.d ?? '') || newest(a, b);
  };
  const relevance = (a, b) => b.score - a.score || newest(a, b);
  results = [...results].sort(sort === 'deadline' ? deadline : sort === 'newest' ? newest : mode === 'browse' ? newest : relevance);

  // General calls: postings in the concepts' fields that name no topic, so a topic query misses them.
  let general = null;
  const topicConcepts = [...new Set(clauses.flatMap((c) => c.concepts))];
  if (topicConcepts.length && mode !== 'none') {
    const fields = [...new Set(topicConcepts.flatMap((id) => engine.concepts[id].fields))].filter((f) => f !== 'physics');
    const inResults = new Set(results.map((r) => r.doc.ix));
    const gen = engine.docs.filter((d) => d.gen && !inResults.has(d.ix)
      && (d.f ?? []).some((f) => fields.includes(f))
      && (includeExpired || !isExpired(d, today))
      && approachFacet(d, approach) && fieldFacet(d, field)
      && (!category || d.cats.some((c) => c.category === category)))
      .map((doc) => ({ doc, score: 0, matched: [] }));
    general = { fields, results: gen.sort(sort === 'newest' ? newest : deadline) };
  }
  return { results, mode, counts, general };
}

/** Terms to highlight for a result: single terms plus phrase keys (matched as word sequences). */
export function highlightTerms(matched) {
  return new Set(matched.map((m) => m.term));
}

// Split text into [{text, hit}] segments, marking tokens whose term is in `terms` (phrase keys
// like "random matrix" mark the whole phrase).
export function highlight(text, terms, variants) {
  if (!text) return [];
  const toks = tokenize(text, { variants });
  const phrases = [...terms].filter((t) => t.includes(' ')).map((t) => t.split(' '));
  const spans = [
    ...toks.filter((t) => terms.has(t.term)),
    ...(phrases.length ? makePhraseMatcher(phrases)(toks) : []),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
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
