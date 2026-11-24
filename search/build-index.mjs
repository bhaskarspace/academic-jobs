// Build the public search index from .out/postings.json.
//
// What ships (and what doesn't): display records carry title, institution, dates, categories,
// fields, sources, URL and a <=240-char snippet. The ad text itself is NOT shipped: it is
// represented only by an inverted index of stemmed terms with per-field weights and no word
// positions, so the text cannot be reconstructed from it.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize, buildVariants } from './tokenize.js';
import { compileConcepts, makePhraseMatcher, phraseList, isPhysicsField } from './concepts.js';
import { makeApproachTagger, APPROACH_SHORT } from './approach.mjs';
import { loadYaml } from '../crawler/lib/config.mjs';

// Field weights (BM25F-style: weighted term frequency).
// pdf: text of the PDF advert (Indian institutes), indexed but never shipped; a hit there shows
// "in PDF advert".
export const FIELDS = { title: { bit: 1, w: 3 }, meta: { bit: 2, w: 2 }, body: { bit: 4, w: 1 }, pdf: { bit: 8, w: 0.7 } };
// Bits above the field bits record which surface forms of a term a document used (see `forms`).
export const FORM_SHIFT = 4;
const MAX_FORMS = 7;
const BODY_TERMS_MAX = 150; // per document, by tf-idf; title, meta and concept terms are always kept
// A posting "names no topic" when its title hits no concept and its text hits none, or so many
// that it is an umbrella call (ICTS, Perimeter: "astrophysics, condensed matter, string theory, ...").
const UMBRELLA_CONCEPTS = 4;

const SHORT_CAT = { phd: 'phd', postdoc: 'pd', faculty: 'fac', fellowship: 'fel', other: 'oth' };
const SHORT_CONF = { high: 'h', medium: 'm', low: 'l' };

/**
 * @param {object[]} postings
 * @param {object} [o]
 * @param {object} [o.variants]  {stem: canonicalStem} from buildVariants
 * @param {object} [o.concepts]  the YAML `concepts:` map
 * @param {object} [o.approach]  config/approach.yaml
 */
export function buildIndex(postings, { variants = {}, concepts = {}, approach = {}, built = new Date().toISOString() } = {}) {
  const compiled = compileConcepts(concepts, variants);
  const phrases = makePhraseMatcher(phraseList(compiled));
  // concept key -> concept ids, for "which concepts does this posting mention"
  const keyConcepts = new Map();
  for (const [id, c] of Object.entries(compiled)) {
    for (const e of [...c.query, ...c.members]) keyConcepts.set(e.key, [...(keyConcepts.get(e.key) ?? []), id]);
  }
  const approachOf = makeApproachTagger(approach);

  const docs = [];
  const perDoc = [];   // [Map term -> {wtf, mask, forms:Set}]
  const df = new Map();
  const formCount = new Map(); // term -> Map(form -> docs)
  const plainTerms = new Set(); // terms seen at least once as a plain word, not only as a joined compound
  for (const p of postings) {
    const fields = {
      // Other sources' titles for the same advert (shown as "Also listed as") are title text too.
      title: [p.title, ...(p.altTitles ?? [])].join(' \n '),
      meta: [p.institution, p.institutionSource, p.institutionAlt, p.subject, p.city, p.region, (p.fields || []).join(' ')].filter(Boolean).join(' \n '),
      body: p.body,
      pdf: p.pdfText ?? '',
    };
    const terms = new Map();
    const hitConcepts = { title: new Set(), meta: new Set(), body: new Set(), pdf: new Set() };
    let len = 0;
    for (const [name, text] of Object.entries(fields)) {
      const f = FIELDS[name];
      const toks = tokenize(text, { variants });
      for (const t of [...toks, ...phrases(toks)]) {
        const e = terms.get(t.term) ?? { wtf: 0, mask: 0, forms: new Set() };
        e.wtf += f.w;
        e.mask |= f.bit;
        e.forms.add(t.form);
        terms.set(t.term, e);
        if (!t.phrase) len += f.w;
        if (!t.joined && !t.phrase) plainTerms.add(t.term);
        for (const id of keyConcepts.get(t.term) ?? []) hitConcepts[name].add(id);
      }
    }
    // Field tags ("math-ph") are in meta for matching, but they are not the posting naming a topic:
    // a PhD admissions call tagged with every physics subfield is still a general call.
    const tagText = (p.fields || []).join(' ');
    if (tagText) {
      const own = new Set();
      const metaOwn = [p.institution, p.institutionSource, p.institutionAlt, p.subject, p.city, p.region].filter(Boolean).join(' \n ');
      const toks = tokenize(metaOwn, { variants });
      for (const t of [...toks, ...phrases(toks)]) for (const id of keyConcepts.get(t.term) ?? []) own.add(id);
      hitConcepts.meta = own;
    }
    perDoc.push(terms);
    for (const [t, e] of terms) {
      df.set(t, (df.get(t) ?? 0) + 1);
      const fc = formCount.get(t) ?? new Map();
      for (const form of e.forms) fc.set(form, (fc.get(form) ?? 0) + 1);
      formCount.set(t, fc);
    }
    const bodyConcepts = new Set([...hitConcepts.meta, ...hitConcepts.body, ...hitConcepts.pdf]);
    const general = hitConcepts.title.size === 0 && (bodyConcepts.size === 0 || bodyConcepts.size >= UMBRELLA_CONCEPTS);
    docs.push({ p, len, general, approach: approachOf({ title: p.title ?? '', body: p.body ?? '', unit: p.institution ?? '' }) });
  }

  // Surface forms: only for terms written in more than one way; the most common first.
  const forms = {};
  const formIndex = new Map(); // term -> Map(form -> bit index)
  for (const [t, fc] of formCount) {
    if (fc.size < 2) continue;
    const list = [...fc].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_FORMS).map(([f]) => f);
    forms[t] = list;
    formIndex.set(t, new Map(list.map((f, i) => [f, i])));
  }

  // Prune body-only terms to the top N by tf-idf per document. Concept keys always stay.
  const N = postings.length;
  const idf = (t) => Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
  for (const terms of perDoc) {
    const textOnly = FIELDS.body.bit | FIELDS.pdf.bit;
    const bodyOnly = [...terms].filter(([t, e]) => (e.mask & ~textOnly) === 0 && !keyConcepts.has(t));
    if (bodyOnly.length <= BODY_TERMS_MAX) continue;
    bodyOnly.sort((a, b) => b[1].wtf * idf(b[0]) - a[1].wtf * idf(a[0]));
    for (const [t] of bodyOnly.slice(BODY_TERMS_MAX)) terms.delete(t);
  }

  // Inverted index: term -> flat [docDelta, wtf, mask, docDelta, wtf, mask, ...]
  const inv = new Map();
  perDoc.forEach((terms, i) => {
    for (const [t, e] of terms) {
      if (!inv.has(t)) inv.set(t, { last: 0, list: [] });
      const x = inv.get(t);
      let mask = e.mask;
      const fi = formIndex.get(t);
      if (fi) for (const form of e.forms) if (fi.has(form)) mask |= 1 << (FORM_SHIFT + fi.get(form));
      x.list.push(i - x.last, e.wtf, mask);
      x.last = i;
    }
  });
  const index = {};
  for (const t of [...inv.keys()].sort()) index[t] = inv.get(t).list;
  const shippedForms = {};
  for (const t of Object.keys(forms)) if (index[t]) shippedForms[t] = forms[t];

  const totalLen = docs.reduce((a, d) => a + d.len, 0);
  const idx = {
    v: 2,
    built,
    n: N,
    avgLen: N ? totalLen / N : 0,
    variants,
    concepts: compiled,
    forms: shippedForms,
    docs: docs.map((d) => displayRecord(d, built)),
    index,
  };
  // The most common surface form of every term, for the variant review (not shipped).
  const topForm = new Map();
  for (const [t, fc] of formCount) topForm.set(t, [...fc].sort((a, b) => b[1] - a[1])[0][0]);
  Object.defineProperty(idx, 'topForm', { value: topForm, enumerable: false });
  Object.defineProperty(idx, 'plainTerms', { value: plainTerms, enumerable: false });
  return idx;
}

/**
 * Candidate variant pairs for review: index terms that share a prefix of 6+ characters but stem
 * differently (postdoc / postdoctor). Physics vocabulary (both terms mostly in physics postings)
 * comes first, then pairs where one stem is a prefix of the other, then the rest.
 * @returns {Array<{a, b, dfA, dfB, prefix: boolean, physics: boolean}>} a, b: most common surface forms
 */
export function variantCandidates(idx, { rejected = [], minDf = 2, limit = 400, physicsShare = 0.75 } = {}) {
  const dfOf = (t) => idx.index[t].length / 3;
  const isPhys = idx.docs.map((d) => (d.f ?? []).some(isPhysicsField));
  const share = (t) => {
    const l = idx.index[t];
    let d = 0, n = 0;
    for (let j = 0; j < l.length; j += 3) { d += l[j]; if (isPhys[d]) n++; }
    return n / (l.length / 3);
  };
  const surface = (t) => idx.topForm?.get(t) ?? idx.forms[t]?.[0] ?? t;
  const reject = new Set(rejected.map((pair) => pair.map((w) => w.toLowerCase()).sort().join(' ')));
  const terms = Object.keys(idx.index).filter((t) => /^[a-z]{6,}$/.test(t) && dfOf(t) >= minDf && (!idx.plainTerms || idx.plainTerms.has(t)));
  const byPrefix = new Map();
  for (const t of terms) {
    const k = t.slice(0, 6);
    if (!byPrefix.has(k)) byPrefix.set(k, []);
    byPrefix.get(k).push(t);
  }
  const out = [];
  for (const group of byPrefix.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [x, y] = group[i].length <= group[j].length ? [group[i], group[j]] : [group[j], group[i]];
        const a = surface(x), b = surface(y);
        if (a === b || reject.has([a, b].sort().join(' '))) continue;
        out.push({ a, b, dfA: dfOf(x), dfB: dfOf(y), prefix: y.startsWith(x), physics: Math.min(share(x), share(y)) >= physicsShare });
      }
    }
  }
  out.sort((p, q) => (q.physics - p.physics) || (q.prefix - p.prefix) || (Math.min(q.dfA, q.dfB) - Math.min(p.dfA, p.dfB)) || p.a.localeCompare(q.a));
  return out.slice(0, limit);
}

export function variantCandidatesYaml(cands, built) {
  const line = (c) => `  - [${c.a}, ${c.b}]${' '.repeat(Math.max(1, 34 - c.a.length - c.b.length))}# ${c.dfA} / ${c.dfB} postings`;
  return [
    `# Variant candidates from the build of ${built}.`,
    '# Index terms that share a 6+ letter prefix but stem differently. To approve a pair, move it into',
    '# `variants:` in concepts/physics.yaml (merge with an existing group if it has one); to reject it,',
    '# move it into `notVariants:` so it is not suggested again.',
    `physics:  # both words mostly in physics postings`,
    ...cands.filter((c) => c.physics).map(line),
    'prefix:   # one stem is a prefix of the other',
    ...cands.filter((c) => !c.physics && c.prefix).map(line),
    'shared:   # only a shared prefix: often unrelated words',
    ...cands.filter((c) => !c.physics && !c.prefix).map(line),
    '',
  ].join('\n');
}

function displayRecord({ p, len, general, approach }, built) {
  const r = {
    id: p.id,
    t: p.title,
    at: p.altTitles?.length ? p.altTitles : undefined,
    i: p.institution || undefined,
    c: p.country || undefined,
    rg: p.region || undefined,
    cat: p.categories.map((c) => `${SHORT_CAT[c.category]}:${SHORT_CONF[c.confidence]}`),
    f: p.fields?.length ? p.fields : undefined,
    p: p.posted || undefined,
    d: p.deadline || undefined,
    fs: p.firstSeen?.slice(0, 10),
    u: p.url,
    s: p.sources.map((s) => s.name),
    su: p.sources.length > 1 ? p.sources.map((s) => s.url) : undefined,
    sn: p.snippet || undefined,
    len,
  };
  if (approach.length) r.ap = approach.map((a) => `${APPROACH_SHORT[a.approach]}:${SHORT_CONF[a.confidence]}`);
  if (general) r.gen = 1;
  if (p.gone) {
    r.g = p.gone.slice(0, 10);
    // Off an institute's list page but its deadline is still ahead: stays visible until then.
    if (p.goneSoft && p.deadline && p.deadline >= built.slice(0, 10)) r.ol = 1;
  }
  if (p.rolling) r.roll = 1;
  if (p.rolling && p.reviewFrom) r.rv = p.reviewFrom;
  if (p.pdfUrls?.length) r.pdf = p.pdfUrls[0];
  // How the deadline was found, when not from the list/source: kind (w = walk-in, r = relative)
  // and confidence (m/l), and where (page or PDF).
  const di = p.deadlineInfo;
  if (p.deadline && di && di.confidence !== 'high') {
    r.dc = SHORT_CONF[di.confidence];
    r.df = di.from === 'pdf' ? 'pdf' : 'page';
  }
  if (p.deadline && di?.kind === 'walk-in') r.dk = 'w';
  if (p.deadline && di?.kind === 'relative') r.dk = 'r';
  // Advert facts, each [value, confidence]; age is a list of limits.
  const fx = {};
  for (const [k, short] of [['advt', 'a'], ['pi', 'pi'], ['project', 'pj'], ['funding', 'fu'], ['age', 'ag'], ['ageRelax', 'ar']]) {
    const f = p.facts?.[k];
    if (f) fx[short] = [f.value, SHORT_CONF[f.confidence]];
  }
  if (Object.keys(fx).length) r.fx = fx;
  if (p.pdfInfo?.some((i) => i.imageOnly)) r.scan = 1;
  return r;
}

export async function loadVariants() {
  const c = await loadYaml('concepts/physics.yaml');
  return buildVariants(c?.variants ?? []);
}

/** Everything buildIndex needs from the repo's YAML files. */
export async function loadIndexConfig() {
  const [c, approach] = await Promise.all([loadYaml('concepts/physics.yaml'), loadYaml('config/approach.yaml')]);
  return { variants: buildVariants(c?.variants ?? []), concepts: c?.concepts ?? {}, approach: approach ?? {}, notVariants: c?.notVariants ?? [] };
}

// CLI: node search/build-index.mjs [in=.out/postings.json] [out=.out/index.json]
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const inFile = process.argv[2] ?? '.out/postings.json';
  const outFile = process.argv[3] ?? '.out/index.json';
  const { built, postings } = JSON.parse(await readFile(inFile, 'utf8'));
  const idx = buildIndex(postings, { ...(await loadIndexConfig()), built });
  await mkdir(path.dirname(outFile), { recursive: true });
  const json = JSON.stringify(idx);
  await writeFile(outFile, json);
  console.error(`${idx.n} docs, ${Object.keys(idx.index).length} terms, ${(json.length / 1e6).toFixed(2)} MB -> ${outFile}`);
}
