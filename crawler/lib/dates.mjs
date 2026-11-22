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
