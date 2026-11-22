// Raw adapter item -> Posting (see PLAN.md "Normalisation"), and merging of items that resolved
// to the same stable ID.
import { snippet, clean, englishText, englishTitle } from './text.mjs';
import { extractDeadline } from './dates.mjs';

const PRIORITY = { inspire: 3, ajo: 2, mathjobs: 2 };
const prio = (src) => PRIORITY[src] ?? 1;
const RANK = { high: 3, medium: 2, low: 1 };

export function normalize(raw, { categorize, fieldsOf, sourceName, gone = null, goneSoft = false }) {
  const body = clean(raw.body ?? '');
  const subjectText = raw.subject ?? (raw.scheme ? '' : `${raw.title ?? ''}\n${body.slice(0, 600)}`);
  return {
    sources: [{ source: raw.source, name: sourceName, url: raw.url, sourceId: raw.sourceId, ...(gone ? { gone } : {}) }],
    gone: gone ?? null,
    goneSoft: Boolean(gone && goneSoft),
    url: raw.url,
    applyUrl: raw.applyUrl ?? null,
    // Cleaned here, not in the adapter, so clean-up fixes apply to cached items without a recrawl.
    title: englishTitle(raw.titleOriginal ?? raw.title ?? ''),
    institution: clean(raw.institution ?? '').replace(/\s+/g, ' '),
    institutionAlt: raw.institutionAlt ?? null,
    country: raw.country ?? null,
    region: raw.region ?? null,
    city: raw.city ?? null,
    subject: raw.subject ?? null,
    ref: raw.ref ?? null,
    categories: categorize({ scheme: raw.scheme, values: raw.values, fixed: raw.fixedCategories, title: raw.title ?? '', body }),
    fields: fieldsOf({ arxiv: raw.arxiv, subject: subjectText }),
    posted: raw.posted ?? null,
    // Institute pages often give the date only in prose ("Walk-in interviews will be held on ...").
    deadline: raw.deadline ?? (raw.scheme ? null : extractDeadline(`${raw.titleOriginal ?? raw.title ?? ''}\n${body}`)),
    rolling: Boolean(raw.rolling),
    pdfUrls: raw.pdfUrls ?? [],
    snippet: snippet(englishText(body)),
    body,
    _prio: prio(raw.source),
  };
}

export function mergePostings(list) {
  // Live copies first: a posting is "removed from source" only when every source removed it.
  list.sort((a, b) => Boolean(a.gone) - Boolean(b.gone) || b._prio - a._prio);
  const [p, ...rest] = list;
  const out = { ...p, sources: [...p.sources] };
  const cats = new Map(p.categories.map((c) => [c.category, c.confidence]));
  const fields = new Set(p.fields);
  const bodies = [p.body];
  for (const q of rest) {
    for (const s of q.sources) if (!out.sources.some((x) => x.sourceId === s.sourceId)) out.sources.push(s);
    for (const c of q.categories) {
      const prev = cats.get(c.category);
      if (!prev || RANK[c.confidence] > RANK[prev]) cats.set(c.category, c.confidence);
    }
    q.fields.forEach((f) => fields.add(f));
    for (const k of ['deadline', 'posted', 'country', 'institution', 'institutionAlt', 'applyUrl', 'subject']) out[k] ??= q[k];
    if (q.body && !bodies.includes(q.body)) bodies.push(q.body);
    out.pdfUrls = [...new Set([...out.pdfUrls, ...q.pdfUrls])];
  }
  if (cats.size > 1) cats.delete('other');
  out.categories = [...cats].map(([category, confidence]) => ({ category, confidence }))
    .sort((a, b) => RANK[b.confidence] - RANK[a.confidence]);
  out.fields = [...fields].sort();
  out.body = bodies.join('\n\n');
  out.gone = list.every((q) => q.gone) ? list.map((q) => q.gone).sort().at(-1) : null;
  // "No longer on the list page" (stays visible until its deadline) only if every source that
  // dropped it is a list page; a job board dropping it means it closed.
  out.goneSoft = Boolean(out.gone) && list.every((q) => q.goneSoft);
  delete out._prio;
  return out;
}
