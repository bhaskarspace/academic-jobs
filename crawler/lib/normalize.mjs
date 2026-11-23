// Raw adapter item -> Posting (see PLAN.md "Normalisation"), and merging of items that resolved
// to the same stable ID.
import { snippet, clean, englishText, englishTitle } from './text.mjs';
import { extractDeadlineInfo } from './dates.mjs';
import { advertFacts, postDescription } from './advert.mjs';
import { dropGarbled } from './garble.mjs';

const PRIORITY = { inspire: 3, ajo: 2, mathjobs: 2 };
const prio = (src) => PRIORITY[src] ?? 1;
const RANK = { high: 3, medium: 2, low: 1 };

// Where the deadline came from, strongest first: the list/table or a board's own field (high),
// the page text (medium), the PDF advert (medium; low for "within N days of publication").
function deadlineOf(raw, title, body, pdfText) {
  if (raw.deadline) return { date: raw.deadline, kind: 'deadline', confidence: 'high', from: raw.scheme ? 'source' : 'list' };
  if (raw.scheme) return null;
  for (const [from, text] of [['page', `${title}\n${body}`], ['pdf', pdfText]]) {
    const d = extractDeadlineInfo(text, { posted: raw.posted ?? null });
    if (d) return { date: d.date, kind: d.kind, confidence: d.confidence, from, cue: d.cue };
  }
  return null;
}

export function normalize(raw, { categorize, fieldsOf, sourceName, gone = null, goneSoft = false }) {
  const board = Boolean(raw.scheme);
  // Institute pages and their PDFs may be typed in legacy Hindi fonts: drop the gibberish lines.
  const body = board ? clean(raw.body ?? '') : dropGarbled(clean(raw.body ?? '')).text;
  const pdfText = board ? '' : String(raw.pdfText ?? '');
  const titleRaw = raw.titleOriginal ?? raw.title ?? '';
  const pdfDesc = pdfText ? postDescription(pdfText) : '';
  const subjectText = raw.subject ?? (board ? '' : `${raw.title ?? ''}\n${body.slice(0, 600)}\n${pdfDesc.slice(0, 1500)}`);
  const dl = deadlineOf(raw, titleRaw, body, pdfText);
  // Snippet: the post description, not the letterhead. A one-line page summary ("Temporary and
  // contractual ... in Physics department") is followed by the PDF's description.
  const pageEn = englishText(body);
  const pageDesc = board ? pageEn : postDescription(body) || pageEn;
  const snippetText = !board && pdfDesc && pageEn.length < 200 ? [pageEn, pdfDesc].filter(Boolean).join(' — ') : pageDesc;
  const facts = board ? {} : advertFacts(`${body}\n${pdfText}`, { listRef: raw.ref ?? null });
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
    categories: categorize({ scheme: raw.scheme, values: raw.values, fixed: raw.fixedCategories, title: raw.title ?? '', body: pdfText ? `${body}\n${pdfDesc}` : body }),
    fields: fieldsOf({ arxiv: raw.arxiv, subject: subjectText }),
    posted: raw.posted ?? null,
    // Institute pages often give the date only in prose or in the PDF ("Walk-in interviews on ...").
    deadline: dl?.date ?? null,
    deadlineInfo: dl ? { kind: dl.kind, confidence: dl.confidence, from: dl.from } : null,
    rolling: Boolean(raw.rolling),
    pdfUrls: raw.pdfUrls ?? [],
    pdfInfo: raw.pdfInfo ?? [],
    facts,
    snippet: snippet(snippetText),
    body,
    pdfText,
    _prio: prio(raw.source),
  };
}

const titleKey = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Merge the items of one posting. Fields come from the highest-priority source, except the title:
 * if exactly one of the distinct titles names a subject (`namesSubject`, search/subject.mjs), that
 * one is used. The other titles are kept as `altTitles` (shown and searchable).
 */
export function mergePostings(list, { namesSubject = null } = {}) {
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
    if (out.deadline == null && q.deadline) { out.deadline = q.deadline; out.deadlineInfo = q.deadlineInfo; }
    for (const k of ['posted', 'country', 'institution', 'institutionAlt', 'applyUrl', 'subject']) out[k] ??= q[k];
    for (const [k, f] of Object.entries(q.facts ?? {})) if (!out.facts?.[k] || RANK[f.confidence] > RANK[out.facts[k].confidence]) out.facts = { ...out.facts, [k]: f };
    if (q.pdfText && !(out.pdfText ?? '').includes(q.pdfText)) out.pdfText = [out.pdfText, q.pdfText].filter(Boolean).join('\n\n');
    out.pdfInfo = [...(out.pdfInfo ?? []), ...(q.pdfInfo ?? []).filter((i) => !(out.pdfInfo ?? []).some((x) => x.url === i.url))];
    if (q.body && !bodies.includes(q.body)) bodies.push(q.body);
    out.pdfUrls = [...new Set([...out.pdfUrls, ...q.pdfUrls])];
  }
  if (cats.size > 1) cats.delete('other');
  out.categories = [...cats].map(([category, confidence]) => ({ category, confidence }))
    .sort((a, b) => RANK[b.confidence] - RANK[a.confidence]);
  out.fields = [...fields].sort();
  out.body = bodies.join('\n\n');
  const titles = [];
  for (const q of list) if (q.title && !titles.some((t) => titleKey(t) === titleKey(q.title))) titles.push(q.title);
  if (namesSubject && titles.length > 1) {
    const withSubject = titles.filter((t) => namesSubject(t));
    if (withSubject.length === 1) out.title = withSubject[0];
  }
  out.altTitles = titles.filter((t) => titleKey(t) !== titleKey(out.title));
  out.gone = list.every((q) => q.gone) ? list.map((q) => q.gone).sort().at(-1) : null;
  // "No longer on the list page" (stays visible until its deadline) only if every source that
  // dropped it is a list page; a job board dropping it means it closed.
  out.goneSoft = Boolean(out.gone) && list.every((q) => q.goneSoft);
  delete out._prio;
  return out;
}
