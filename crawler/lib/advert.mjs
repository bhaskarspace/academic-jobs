// Facts read from an Indian institute advert (page text or PDF text), each with a confidence:
//   advt      Advt. No.                         high from the list/table, medium from the text
//   pi        principal investigator            medium when labelled
//   project   project title                     medium when labelled or quoted after "project titled"
//   funding   funding agency                    medium when labelled, low from "funded by ..." prose
//   age       upper age limit(s) in years       medium near an "age" label, low otherwise
//   ageRelax  the age-relaxation sentence       medium
// and where the post description starts, so snippets skip the letterhead (bilingual institute
// name, address, Advt. No. and date lines, the standard "the institute is a premier ..." blurb).

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const trimValue = (s, max = 160) => {
  const v = one(s).replace(/^[\s:–—\-.,;]+|[\s:–—\-,;]+$/g, '');
  return v.length > max ? `${v.slice(0, max).replace(/\s+\S*$/, '')} …` : v;
};

/** "ADVT. NO. : 88 / 2026" -> "88/2026"; used for display and as a dedupe key. */
export function normalizeAdvt(s) {
  const v = one(s).replace(/^(?:advt\.?|advertisement|ref(?:erence)?\.?)\s*(?:no\.?|number)?\s*[:.\-–]*\s*/i, '');
  const core = v.replace(/\s*([\/\-.])\s*/g, '$1').replace(/\s+/g, ' ').trim();
  return /\d/.test(core) ? core.toUpperCase() : null;
}

const ADVT = /\b(?:advt\.?|advertisement)\s*(?:no\.?|number|sankhya)\s*[.:\-–]*\s*([A-Za-z0-9][A-Za-z0-9 \/\-.()]{0,30}?\d+[A-Za-z]?)(?=\s*(?:$|[\n,;)\]]|dated?\b|date\b|\s{2}))/im;
// Label case-insensitive, name case-sensitive (a capitalised name, optionally after a title).
const PI_LABEL = /\b(?:principal\s+investigator|name\s+of\s+(?:the\s+)?(?:PI|principal\s+investigator)|project\s+(?:investigator|coordinator)|PI)\s*(?:\(PI\))?\s*[:\-–]\s*/gi;
const PI_NAME = /^((?:(?:Dr|Prof|Professor|Mr|Ms|Mrs)\.?\s*)*[A-Z][A-Za-z]*\.?(?:\s+[A-Z][A-Za-z]*\.?){0,5})/;
const PROJECT_LABEL = /\b(?:title\s+of\s+(?:the\s+)?project|project\s+title|name\s+of\s+(?:the\s+)?project)\s*[:\-–]?\s*[“"‘']?([^\n“”"]{6,200}?)[”"’']?\s*(?:\n|$)/i;
const PROJECT_QUOTED = /\b(?:title\s+of(?:\s+the)?|project\s+(?:titled|entitled)|under\s+the\s+(?:\w+\s+){0,3}project\s+(?:titled|entitled))\s*[:\-–]?\s*[“"]([^”"]{6,200})[”"]/i;
const FUNDING_LABEL = /\b(?:[Ff]unding|[Ss]ponsoring|FUNDING|SPONSORING)(?:\s+(?:[Aa]gency|AGENCY))?\s*[:\-–]?\s*([A-Z][^\n]{2,120})/;
const FUNDING_PROSE = /\b(?:[Ff]unded|[Ss]ponsored|[Ss]upported)\s+by\s+(?:the\s+)?([A-Z][A-Za-z&,.\-() ]{2,80}?)(?=[.;\n]|\s+(?:under|for|and\s+the|at)\b)/;
const AGE_LABELLED = /\b(?:upper\s+)?age(?:\s+limit)?\b[^.\n]{0,120}?(?:not\s+(?:be\s+)?(?:more|greater|older)\s+than|not\s+(?:to\s+)?exceed(?:ing)?|should\s+not\s+exceed|below|less\s+than|maximum(?:\s+of)?|upto|up\s+to|limit\s*(?:is|of|:|-|–)?|age\s*[:\-–])\s*(\d{2})\s*(?:years|yrs)/gi;
const AGE_BARE = /\b(?:not\s+(?:be\s+)?more\s+than|not\s+exceeding|maximum\s+age\s+(?:of\s+)?)\s*(\d{2})\s*(?:years|yrs)\b/gi;
// The relaxation sentence, from its own start ("Age relaxation ...", "Relaxation in upper age ...",
// "... age is relaxable by 5 years for SC/ST").
const RELAX = /\b(?:age\s+relax\w*|relax\w*\s+(?:in|of)\s+(?:the\s+)?(?:upper\s+)?age|upper\s+age\s+limit\s+(?:is\s+)?relax\w*|relax\w*\s+by\s+\d+\s+years?\s+for)[^.]*/i;

// English part of bilingual text, line by line: drop each Hindi run with the " / " after it, then
// any Devanagari left. Unlike englishText (titles) it keeps quotes, which mark project titles.
const HINDI = /[\u0900-\u097F\u200C\u200D][\u0900-\u097F\u200C\u200D\s\-–()]*(?:\s*\/\s*)?/g;
const english = (text) => String(text ?? '').split('\n')
  .map((l) => l.replace(HINDI, ' ').replace(/^[\s\/]+/, '').replace(/[ \t]+/g, ' ').trim())
  .filter((l) => /[A-Za-z]/.test(l)).join('\n');
export { english as englishLines };

export function advertFacts(text, { listRef = null } = {}) {
  const t = english(text);
  const facts = {};
  const ref = listRef ? normalizeAdvt(listRef) : null;
  if (ref) facts.advt = { value: ref, confidence: 'high' };
  else {
    const m = ADVT.exec(t);
    const v = m && normalizeAdvt(m[1]);
    if (v) facts.advt = { value: v, confidence: 'medium' };
  }
  for (const m of t.matchAll(PI_LABEL)) {
    const name = PI_NAME.exec(t.slice(m.index + m[0].length, m.index + m[0].length + 80));
    if (name && name[1].replace(/(?:Dr|Prof|Professor|Mr|Ms|Mrs)\.?\s*/g, '').length >= 3) { facts.pi = { value: trimValue(name[1], 80), confidence: 'medium' }; break; }
  }
  const proj = PROJECT_QUOTED.exec(t) ?? PROJECT_LABEL.exec(t);
  if (proj && !/^(?:project|the project)$/i.test(trimValue(proj[1]))) facts.project = { value: trimValue(proj[1]), confidence: 'medium' };
  const fl = FUNDING_LABEL.exec(t);
  const fundLabelled = fl && !/^(?:agency|agencies|particularly|patterns|mechanisms)\b/i.test(fl[1]) ? trimValue(fl[1].replace(/\s+Agency\.?$/, ''), 100) : null;
  if (fundLabelled && fundLabelled.length > 2) facts.funding = { value: fundLabelled, confidence: 'medium' };
  else {
    const fp = FUNDING_PROSE.exec(t);
    if (fp) facts.funding = { value: trimValue(fp[1], 100), confidence: 'low' };
  }
  const ages = new Set();
  let conf = 'medium';
  for (const m of t.matchAll(AGE_LABELLED)) ages.add(Number(m[1]));
  if (!ages.size) {
    // Tables put the value before or far from its label ("Not more than 35 years ... Age of
    // applicant as on ..."): take bare limits when the text mentions age at all.
    if (/\bage\b/i.test(t)) for (const m of t.matchAll(AGE_BARE)) ages.add(Number(m[1]));
    conf = 'low';
  }
  const ageList = [...ages].filter((a) => a >= 18 && a <= 70).sort((a, b) => a - b);
  if (ageList.length) facts.age = { value: ageList, confidence: conf };
  const rx = RELAX.exec(t.replace(/\s*\n\s*/g, ' '));
  if (rx) facts.ageRelax = { value: trimValue(rx[0], 140), confidence: 'medium' };
  return facts;
}

/**
 * Dedupe key from an institute advert's number: "advt:<institution>:<number>". Bare serials ("12")
 * repeat every year, so only numbers with a year or office code ("88/2026", "IITB/R-12") count.
 * Boards (raw.scheme set) have their own IDs.
 */
export function advtAlias(raw) {
  if (raw.scheme) return null;
  const n = normalizeAdvt(raw.ref ?? '') ?? (raw.pdfText ? advertFacts(raw.pdfText).advt?.value : null);
  if (!n || !/[\/\-]/.test(n)) return null;
  return `advt:${String(raw.institution ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}:${n}`;
}

// --- snippet start ---------------------------------------------------------------------------
const START = /(?:invites?\s+applications|applications\s+are\s+(?:hereby\s+)?invited|(?:may|can)\s+attend\s+(?:the\s+)?walk[- ]?in|walk[- ]?in\s+interviews?\s+(?:will\s+be|is|are)\s+(?:held|conducted|scheduled)|is\s+(?:looking|seeking)\s+for|seeks\s+(?:applications|candidates)|for\s+the\s+following\s+(?:post|position)s?|(?:post|position)\s+name\b|name\s+of\s+the\s+(?:post|position)\b|wishes\s+to\s+(?:engage|recruit|fill))/i;
const LETTERHEAD = /^(?:.*\b(?:institute|university|IISER|IIT\b|IISc|laboratory|ministry|government\s+of|autonomous|deemed|recognised|recognized|an\s+institution)\b.*|.*\b\d{3}\s?\d{3}\b.*|.*\b(?:road|marg|nagar|campus|pin|phone|tel|fax|e-?mail|website|www\.)\b.*|.*\b(?:advt|advertisement|ref)\.?\s*(?:no|number)\b.*|^\s*(?:date|dated)\b.*|.*\btemporary\s+and\s+contractual\b.*|[^a-z]*)$/i;
const BLURB = /\b(?:is\s+a\s+premier|was\s+established\s+in|institute\s+of\s+national\s+importance|act\s+of\s+parliament|autonomous\s+(?:body|institution)\s+(?:under|of))\b/i;

/**
 * The text from where the post description starts: at a start cue ("invites applications",
 * "may attend walk-in interviews", "Post Name"), else after the letterhead lines and the
 * institute blurb. English only.
 */
export function postDescription(text) {
  const t = english(text);
  const m = START.exec(t.slice(0, 4000));
  if (m) {
    const lineStart = t.lastIndexOf('\n', m.index) + 1;
    // The sentence the cue sits in, not the whole paragraph before it.
    const sentStart = Math.max(lineStart, t.lastIndexOf('. ', m.index) + 2 > 1 ? t.lastIndexOf('. ', m.index) + 2 : lineStart);
    return t.slice(Math.min(sentStart, m.index)).trim();
  }
  const lines = t.split('\n');
  let i = 0;
  while (i < lines.length && i < 25 && (LETTERHEAD.test(lines[i]) || lines[i].split(/\s+/).length < 4)) i++;
  let rest = lines.slice(i).join('\n');
  // Drop the standard institute blurb paragraph.
  const paras = rest.split(/\n(?=[A-Z])/);
  while (paras.length > 1 && BLURB.test(paras[0])) paras.shift();
  rest = paras.join('\n');
  return rest.trim();
}
