// Legacy Hindi fonts (Kruti Dev, DevLys, ...) map Devanagari glyphs onto Latin code points, so a
// PDF typed in them extracts as Latin nonsense: भारत -> "Hkkjr", आवेदन -> "vkosnu",
// विज्ञापन -> "foKkiu". Such lines must not reach the index or the snippet.
//
// A line is gibberish when most of its words aren't English words (config/words-en.txt) AND it
// shows the legacy-font signature (two marked words, or the k share): punctuation inside words (f'k{kk, ifj;kstuk, i=), a capital in
// the middle of a word (foKkiu, lkFk), a capital followed by the "k" matra (Hkkjr), or an
// unusually high share of the letter k (the matra ा). The signature keeps French, German or
// Spanish adverts (unknown words, but none of these traits) from being dropped.
import { readFileSync } from 'node:fs';

let WORDS = null;
function words() {
  if (!WORDS) {
    const txt = readFileSync(new URL('../../config/words-en.txt', import.meta.url), 'utf8');
    WORDS = new Set(txt.split('\n').filter((l) => l && !l.startsWith('#')));
  }
  return WORDS;
}

const EDGE = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;
// Punctuation inside a word. An apostrophe counts only before a letter other than s (f'k{kk), so
// "Master's" doesn't.
const MARK_INSIDE = /[A-Za-z][;{}=~|\\^`¼½¾¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¿×÷][A-Za-z]|[a-z]'[a-rt-z]/;
// A capital inside a word that starts in lower case (foKkiu, lkFk); "PhD", "IceCube" start upper.
const CAMEL = /^[a-z]+[A-Z]/;
// Consonant capitals + the k matra (Hk = भा, Fk = था, Nk = छा); not Sk/Ak/Ok ("Skills").
const CAP_MATRA = /^[BCDFGHJLMNPQRTVWXYZ]k/;
const LEAD_COMMA = /^,[a-z]/; // ",oa" = एवं

function isReal(w) {
  const W = words();
  const l = w.toLowerCase();
  if (W.has(l)) return true;
  for (const suf of ['s', 'es', 'ed', 'd', 'ing', 'ly', "'s"]) if (l.endsWith(suf) && W.has(l.slice(0, -suf.length))) return true;
  return false;
}

/**
 * Classify one line.
 * @returns {{real:number, other:number, marked:number, kRatio:number, garbled:boolean}}
 */
export function lineStats(line) {
  let real = 0;
  let other = 0;
  let marked = 0;
  let letters = 0;
  let ks = 0;
  for (const raw of line.split(/\s+/)) {
    const chunk = raw.replace(EDGE, '');
    if (!chunk || !/[A-Za-z]/.test(chunk)) continue;               // numbers, dates, Devanagari, punctuation
    if (/@|https?:|www\.|\.(?:in|org|com|edu)\b/i.test(chunk)) continue; // addresses
    if (/\d/.test(chunk) && !/[A-Za-z]{3}/.test(chunk)) continue;  // 88/2026, Rs.31,000, 10.00AM
    const lettersOnly = chunk.replace(/[^A-Za-z]/g, '');
    letters += lettersOnly.length;
    ks += (lettersOnly.match(/k/g) ?? []).length;
    if (/^[A-Z]{2,8}$/.test(chunk)) { real++; continue; }          // acronyms: IISER, DST, ANRF
    if (/^[A-Za-z][a-z'’-]*$/.test(chunk) && chunk.split('-').every((w) => !w || isReal(w.replace(/[’']s$/, '')))) { real++; continue; }
    const sig = MARK_INSIDE.test(chunk) || CAMEL.test(chunk) || CAP_MATRA.test(chunk) || LEAD_COMMA.test(raw);
    if (sig) { marked++; continue; }
    if (/^[A-Z][a-z]+$/.test(chunk)) continue;                     // a proper noun: neither way
    other++;
  }
  const n = real + other + marked;
  const kRatio = letters ? ks / letters : 0;
  const garbled = n >= 2 && real / n < 0.5 && (marked >= 2 || kRatio > 0.08);
  return { real, other, marked, kRatio, garbled, n };
}

/**
 * Drop gibberish lines from extracted text. A short line between two dropped lines goes too,
 * unless it holds a real English word.
 * @returns {{text: string, dropped: number}}
 */
export function dropGarbled(text) {
  const lines = String(text ?? '').split('\n');
  const stats = lines.map(lineStats);
  const drop = stats.map((s) => s.garbled);
  for (let i = 1; i < lines.length - 1; i++) {
    if (drop[i] || !stats[i].n || stats[i].real) continue;
    const prev = drop.slice(0, i).lastIndexOf(true);
    const next = drop.indexOf(true, i + 1);
    if (prev >= 0 && next >= 0 && i - prev <= 2 && next - i <= 2) drop[i] = true;
  }
  const kept = lines.filter((_, i) => !drop[i]);
  return { text: kept.join('\n'), dropped: drop.filter(Boolean).length };
}
