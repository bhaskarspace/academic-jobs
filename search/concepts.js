// Concepts from concepts/physics.yaml, compiled to index terms. Shared by the build and the browser.
//
// A concept has
//   query:  the words that invoke it in a search ("chaos", "quantum chaos")
//   terms:  member words and phrases it expands to ("OTOC", "SYK", "many-body localization")
//   weak:   members too broad to count alone ("thermalization"): they count only next to another
//           member hit or a literal hit of the query word
//   fields: arXiv-style fields where an expanded hit counts (field gating)
// Each member and query entry compiles to one index key:
//   - one word, or one hyphenated chunk ("out-of-time-order") -> its term (the joined term for a compound)
//   - several words ("random matrix") -> a phrase key "random matrix", indexed at build time from
//     consecutive tokens, because the shipped index has no word positions.
import { tokenize } from './tokenize.js';

// Field tags that count as physics, for the one-click "Physics" facet and for gating.
export const PHYSICS_FIELDS = /^(hep|gr-qc|cond-mat|quant-ph|math-ph|astro-ph|nucl|nlin|physics)/;
export const isPhysicsField = (f) => PHYSICS_FIELDS.test(f);

/** Compile one entry ("random matrix", "OTOC", "out-of-time-order") to {key, terms, surface}. */
export function compileEntry(text, variants) {
  const toks = tokenize(String(text), { variants });
  if (!toks.length) return null;
  const chunks = String(text).trim().split(/\s+/);
  if (chunks.length === 1) {
    // A compound uses its joined form; "AdS5" (ads + ads5) uses the specific last token.
    const joined = toks.find((t) => t.joined);
    const term = joined ? joined.term : toks[toks.length - 1].term;
    return { key: term, terms: [term], surface: String(text) };
  }
  const terms = toks.filter((t) => !t.joined).map((t) => t.term);
  if (terms.length === 1) return { key: terms[0], terms, surface: String(text) };
  return { key: terms.join(' '), terms, surface: String(text) };
}

/**
 * Compile the YAML `concepts:` map. Returns
 *   {id: {label, fields: [..], query: [{key, terms, surface}], members: [{key, terms, surface, weak?}]}}
 */
export function compileConcepts(concepts = {}, variants = {}) {
  const out = {};
  for (const [id, c] of Object.entries(concepts ?? {})) {
    if (!c) continue;
    const label = c.label ?? id.replace(/[-_]/g, ' ');
    const query = (c.query ?? [label]).map((q) => compileEntry(q, variants)).filter(Boolean);
    const seen = new Set(query.map((q) => q.key));
    const members = [];
    for (const [list, weak] of [[c.terms, false], [c.weak, true]]) {
      for (const m of list ?? []) {
        const e = compileEntry(m, variants);
        if (!e || seen.has(e.key)) continue;
        seen.add(e.key);
        members.push(weak ? { ...e, weak: true } : e);
      }
    }
    out[id] = { label, fields: c.fields ?? [], query, members };
  }
  return out;
}

/** Phrase matcher over a token list: returns the phrase keys present ([{key, start, end, form}]). */
export function makePhraseMatcher(phrases) {
  const byFirst = new Map();
  for (const terms of phrases) {
    if (terms.length < 2) continue;
    const list = byFirst.get(terms[0]) ?? [];
    list.push(terms);
    byFirst.set(terms[0], list);
  }
  return (tokens) => {
    const seq = tokens.filter((t) => !t.joined);
    const hits = [];
    for (let i = 0; i < seq.length; i++) {
      const cands = byFirst.get(seq[i].term);
      if (!cands) continue;
      for (const terms of cands) {
        if (i + terms.length > seq.length) continue;
        let ok = true;
        for (let k = 1; k < terms.length && ok; k++) ok = seq[i + k].term === terms[k];
        if (ok) {
          const key = terms.join(' ');
          hits.push({ term: key, form: key, start: seq[i].start, end: seq[i + terms.length - 1].end, phrase: true });
        }
      }
    }
    return hits;
  };
}

/** Every multi-word key used by the compiled concepts (members and query phrases). */
export function phraseList(compiled) {
  const list = [];
  for (const c of Object.values(compiled)) for (const e of [...c.query, ...c.members]) if (e.terms.length > 1) list.push(e.terms);
  return list;
}

/** Does a document's field list pass the concept's field gate? */
export function fieldsPass(docFields, concept) {
  if (!concept.fields?.length) return true;
  return (docFields ?? []).some((f) => concept.fields.includes(f));
}
