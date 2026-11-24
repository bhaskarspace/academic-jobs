// Date parsing for the formats seen in the audit. Everything returns 'YYYY-MM-DD' or null.
//   2026-11-27, 2026-11-27 23:59:59     Nov 27, 2026     27 Nov 2026, 05:00 PM
//   27th November 2026                  27.11.2026  27/11/2026  27-11-2026 (day first: India/Europe)
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';

const pad = (n) => String(n).padStart(2, '0');
function ymd(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += 2000;
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 31 Feb
  return `${y}-${pad(m)}-${pad(d)}`;
}
const mon = (s) => MONTHS[s.toLowerCase().slice(0, 4)] ?? MONTHS[s.toLowerCase().slice(0, 3)];

const PATTERNS = [
  [new RegExp(`\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b`), (m) => ymd(m[1], m[2], m[3])],
  [new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'), (m) => ymd(m[3], mon(m[1]), m[2])],
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+(?:of\\s+)?${MON}[\\s,-]+(\\d{4})\\b`, 'i'), (m) => ymd(m[3], mon(m[2]), m[1])],
  [/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})\b/, (m) => ymd(m[3], m[2], m[1])],
];

export function parseDate(s) {
  if (!s) return null;
  const str = String(s);
  if (/^0000-00-00/.test(str)) return null;
  let best = null;
  for (const [re, f] of PATTERNS) {
    const m = re.exec(str);
    if (m) {
      const v = f(m);
      if (v && (best == null || m.index < best.index)) best = { v, index: m.index };
    }
  }
  return best?.v ?? null;
}

// All dates in a text, with positions (for deadline extraction from free text).
export function findDates(text) {
  const out = [];
  if (!text) return out;
  for (const [re, f] of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(text))) {
      const v = f(m);
      if (v) out.push({ date: v, index: m.index, text: m[0] });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

const NUM_WORDS = { seven: 7, ten: 10, fifteen: 15, twenty: 20, 'twenty one': 21, 'twenty-one': 21, thirty: 30, 'thirty one': 31, 'forty five': 45, 'forty-five': 45, sixty: 60 };
// Cues, strongest first. A date within CUE_WINDOW characters after the cue is taken.
const CUES = [
  { kind: 'deadline', re: /last\s+date\s+(?:for|of)\s+(?:the\s+)?(?:receipt|submission|submitting|receiving)\s+(?:of\s+)?(?:online\s+)?applications?/gi },
  { kind: 'deadline', re: /(?:applications?|forms?)\s+(?:should|must|may)\s+(?:be\s+)?(?:reach|submitted|sent|received)[^.]{0,80}?\bon\s+or\s+before/gi },
  { kind: 'deadline', re: /\b(?:last\s+date|deadline|closing\s+date|apply\s+(?:by|before)|due\s+(?:by|date)|on\s+or\s+before)\b/gi },
  { kind: 'walk-in', re: /\bwalk[- ]?in[- ]?(?:interviews?|test|selection)?\s*(?:will\s+be\s+held\s+)?(?:on|dated?|:)?/gi },
  { kind: 'walk-in', re: /\bdate\s+(?:and|&)\s+time\s+of\s+(?:the\s+)?(?:walk[- ]?in|interview)/gi },
];
const CUE_WINDOW = 120;
// "within 21 days of (the date of) publication / from the date of this advertisement"
const RELATIVE = /\bwithin\s+(\d{1,3}|[a-z]+(?:[\s-][a-z]+)?)\s*(?:\(\s*\d{1,3}\s*\)\s*)?days?\s+(?:of|from|after)\s+(?:the\s+)?(?:date\s+of\s+)?(?:the\s+)?(?:publication|advertisement|advt|issue|appearance|notification|release)/i;

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Deadline in free text (a page or a PDF advert).
 *   kind 'deadline' (last date, on or before ...)          confidence medium
 *   kind 'walk-in'  (the interview date is the deadline)   confidence medium
 *   kind 'relative' (within N days of publication; computed from `posted`)  confidence low
 * When several cues match, the strongest kind wins, then the nearest date; among walk-in dates
 * the latest (an advert may list interviews on several days).
 * @returns {{date, kind, confidence, cue} | null}
 */
export function extractDeadlineInfo(text, { posted = null } = {}) {
  if (!text) return null;
  const dates = findDates(text);
  for (const [rank, { kind, re }] of CUES.entries()) {
    const found = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length;
      const near = dates.filter((x) => x.index >= end - 1 && x.index - end < CUE_WINDOW);
      // Walk-ins can run over several days ("on 3 and 4 December"): every date in the window counts.
      for (const d of kind === 'walk-in' ? near : near.slice(0, 1)) found.push({ date: d.date, dist: d.index - end, cue: m[0].trim().replace(/\s+/g, ' ') });
    }
    if (!found.length) continue;
    const pick = kind === 'walk-in'
      ? found.sort((a, b) => b.date.localeCompare(a.date))[0]
      : found.sort((a, b) => a.dist - b.dist)[0];
    return { date: pick.date, kind, confidence: 'medium', cue: pick.cue, rank };
  }
  const r = RELATIVE.exec(text);
  if (r && posted) {
    const w = r[1].toLowerCase().replace(/\s+/g, ' ');
    const n = /^\d+$/.test(w) ? Number(w) : NUM_WORDS[w] ?? NUM_WORDS[w.replace(' ', '-')];
    if (n && n <= 120) return { date: addDays(posted, n), kind: 'relative', confidence: 'low', cue: r[0].replace(/\s+/g, ' ') };
  }
  return null;
}

// Standing calls: "applications are accepted throughout the year", "on a rolling basis", "no last
// date", "apply at any time". "At any time" only counts next to an application word, and not in
// "may be withdrawn / cancelled / modified at any time" (an advert's small print).
const ROLLING = [
  /\b(?:accepted|received|considered|invited|open)\s+(?:all\s+)?throughout\s+the\s+year\b/i,
  /\bthroughout\s+the\s+year\b[^.]{0,60}\bappl/i,
  /\bappl[a-z]*\b[^.]{0,60}\bthroughout\s+the\s+year\b/i,
  /\ball\s+(?:the\s+)?year\s+round\b/i,
  /\bon\s+a\s+rolling\s+basis\b/i,
  /\brolling\s+(?:call|admissions?|applications?|deadline)\b/i,
  /\bno\s+(?:fixed\s+)?(?:last\s+date|deadline)\b/i,
  /\b(?:apply|applications?|submitted|considered|accepted|received)\b[^.]{0,40}?\bat\s+any\s+time\b/i,
];
const ROLLING_NOT = /\b(?:withdraw|cancel|terminat|modif|amend|revok|reject|discontinu|chang)[a-z]*\b[^.]{0,40}\bat\s+any\s+time\b|\bat\s+any\s+time\b[^.]{0,40}\b(?:withdraw|cancel|terminat|modif|amend|revok|reject|discontinu|without\s+(?:any\s+)?(?:notice|reason))/i;

/** The phrase that marks a standing ("rolling") call, or null. */
export function rollingCue(text) {
  if (!text) return null;
  for (const re of ROLLING) {
    const m = re.exec(text);
    if (!m) continue;
    // Check the "at any time" small print in the sentence around the match.
    const from = Math.max(0, text.lastIndexOf('.', m.index) + 1);
    const to = text.indexOf('.', m.index + m[0].length);
    if (/at\s+any\s+time/i.test(m[0]) && ROLLING_NOT.test(text.slice(from, to < 0 ? undefined : to + 1))) continue;
    return m[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

// A review-start date is not a closing date: "review of applications will begin on 1 December",
// "applications received by 1 December will receive first (or full) consideration", "priority
// deadline: 1 December", together with "until the position is filled". Such a call stays open after
// that date, so it is rolling, with the date shown as "review from".
const REVIEW_CUES = [
  /\breview\s+of\s+applications\s+(?:will\s+)?(?:begins?|beginning|starts?|starting|commenc[a-z]*)\b(?:\s+(?:on|from|after))?/gi,
  /\b(?:applications?\s+)?review\s+(?:will\s+)?(?:begins?|starts?|commenc[a-z]*)\b(?:\s+(?:on|from|after))?/gi,
  /\b(?:first|full)\s+consideration\b/gi,
  /\bpriority\s+(?:deadline|date)\b/gi,
];
const UNTIL_FILLED = /\buntil\s+(?:the\s+)?(?:positions?|posts?|vacanc(?:y|ies)|roles?|openings?)?\s*(?:(?:is|are|has\s+been|have\s+been)\s+)?filled\b|\buntil\s+filled\b/i;

/**
 * The review-start date of a call that runs until filled, or null when the text has no
 * "until filled" or no dated review cue. The date is the one nearest the cue, on either side
 * ("applications received by 1 December will receive first consideration").
 * @returns {{date, cue} | null}
 */
export function reviewStart(text) {
  if (!text || !UNTIL_FILLED.test(text)) return null;
  const dates = findDates(text);
  let best = null;
  for (const re of REVIEW_CUES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length;
      for (const d of dates) {
        const dist = d.index >= end - 1 ? d.index - end : m.index - d.index;
        if (dist < 0 || dist > CUE_WINDOW) continue;
        if (!best || dist < best.dist) best = { date: d.date, cue: m[0].trim().replace(/\s+/g, ' '), dist };
      }
    }
  }
  return best && { date: best.date, cue: best.cue };
}

// The deadline in free text: the date nearest after a "last date"/"deadline"/"closing date" cue.
export function extractDeadline(text) {
  if (!text) return null;
  const cue = /(last\s+date|deadline|closing\s+date|apply\s+(?:by|before)|due\s+(?:by|date)|on\s+or\s+before|walk[- ]in(?:[- ]interview)?)/gi;
  const dates = findDates(text);
  let m;
  let best = null;
  while ((m = cue.exec(text))) {
    const d = dates.find((x) => x.index >= m.index && x.index - m.index < 120);
    if (d && (!best || d.index - m.index < best.dist)) best = { date: d.date, dist: d.index - m.index, cue: m[1] };
  }
  return best ? best.date : null;
}

export const todayISO = (d = new Date()) => d.toISOString().slice(0, 10);
