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
import { loadYaml } from '../crawler/lib/config.mjs';

// Field weights (BM25F-style: weighted term frequency).
export const FIELDS = { title: { bit: 1, w: 3 }, meta: { bit: 2, w: 2 }, body: { bit: 4, w: 1 } };
const BODY_TERMS_MAX = 150; // per document, by tf-idf; title and meta terms are always kept

const SHORT_CAT = { phd: 'phd', postdoc: 'pd', faculty: 'fac', fellowship: 'fel', other: 'oth' };
const SHORT_CONF = { high: 'h', medium: 'm', low: 'l' };

export function buildIndex(postings, { variants = {}, built = new Date().toISOString() } = {}) {
  const docs = [];
  const perDoc = [];   // [{term: {wtf, mask}}]
  const df = new Map();
  for (const p of postings) {
    const fields = {
      title: p.title,
      meta: [p.institution, p.subject, p.city, p.region, (p.fields || []).join(' ')].filter(Boolean).join(' \n '),
      body: p.body,
    };
    const terms = new Map();
    let len = 0;
    for (const [name, text] of Object.entries(fields)) {
      const f = FIELDS[name];
      for (const t of tokenize(text, { variants })) {
        const e = terms.get(t.term) ?? { wtf: 0, mask: 0, body: 0 };
        e.wtf += f.w;
        e.mask |= f.bit;
        if (name === 'body') e.body++;
        terms.set(t.term, e);
        len += f.w;
      }
    }
    perDoc.push(terms);
    for (const t of terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    docs.push({ p, len });
  }

  // Prune body-only terms to the top N by tf-idf per document.
  const N = postings.length;
  const idf = (t) => Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
  for (const terms of perDoc) {
    const bodyOnly = [...terms].filter(([, e]) => e.mask === FIELDS.body.bit);
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
      x.list.push(i - x.last, e.wtf, e.mask);
      x.last = i;
    }
  });
  const index = {};
  for (const t of [...inv.keys()].sort()) index[t] = inv.get(t).list;

  const totalLen = docs.reduce((a, d) => a + d.len, 0);
  return {
    v: 1,
    built,
    n: N,
    avgLen: N ? totalLen / N : 0,
    variants,
    docs: docs.map(({ p, len }) => displayRecord(p, len)),
    index,
  };
}

function displayRecord(p, len) {
  const r = {
    id: p.id,
    t: p.title,
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
  if (p.rolling) r.roll = 1;
  if (p.pdfUrls?.length) r.pdf = p.pdfUrls[0];
  return r;
}

export async function loadVariants() {
  const c = await loadYaml('concepts/physics.yaml');
  return buildVariants(c?.variants ?? []);
}

// CLI: node search/build-index.mjs [in=.out/postings.json] [out=.out/index.json]
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const inFile = process.argv[2] ?? '.out/postings.json';
  const outFile = process.argv[3] ?? '.out/index.json';
  const { built, postings } = JSON.parse(await readFile(inFile, 'utf8'));
  const idx = buildIndex(postings, { variants: await loadVariants(), built });
  await mkdir(path.dirname(outFile), { recursive: true });
  const json = JSON.stringify(idx);
  await writeFile(outFile, json);
  console.error(`${idx.n} docs, ${Object.keys(idx.index).length} terms, ${(json.length / 1e6).toFixed(2)} MB -> ${outFile}`);
}
