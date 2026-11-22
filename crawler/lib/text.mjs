// HTML -> text, snippets, and title clean-up.
import * as cheerio from 'cheerio';

const BLOCK = 'p,div,br,li,tr,h1,h2,h3,h4,h5,h6,ul,ol,table,section,article';

export function htmlToText(html) {
  if (!html) return '';
  const $ = cheerio.load(`<div id="__root">${html}</div>`);
  $('script,style,noscript').remove();
  $(BLOCK).each((_, el) => { $(el).append('\n'); });
  return clean($('#__root').text());
}

export function clean(s) {
  return String(s ?? '')
    .replace(/ /g, ' ')
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// First ~max characters, cut at a word boundary. This is the only ad text the public site ships.
export function snippet(text, max = 240) {
  const t = clean(text).replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '') + ' …';
}

// Bilingual Hindi/English text, as Indian institutes publish it: "हिंदी / English" pairs, often
// several in one title ("“वरिष्ठ ... / Senior Technical Officer”, “... / Technical Officer”").
// Drop each Hindi part together with the slash that follows it, then any Devanagari left over,
// then tidy quotes, brackets and separators.
const HINDI_THEN_SLASH = /[ऀ-ॿ][ऀ-ॿ\s\-–()]*(?:-[IVX]+\b)?\s*\/\s*/g;
const DEVANAGARI = /[ऀ-ॿ]+/g;

export function englishText(text) {
  const t = String(text ?? '');
  if (!/[ऀ-ॿ]/.test(t)) return t;
  if (!/[A-Za-z]{3}/.test(t)) return t; // Hindi only: keep as is
  let s = t.replace(HINDI_THEN_SLASH, ' ').replace(DEVANAGARI, ' ');
  s = s
    .replace(/[“”"‘’]/g, '')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\(\s*[-–]\s*/g, '(')
    .replace(/\/\s*[-–]\s*/g, '/ ')
    .replace(/(^|[\/,&]\s*)\(([^()]+)\)(?=\s*(?:[\/,&-]|$))/g, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([,.;:)])/g, '$1')
    .replace(/\( +/g, '(')
    .replace(/^[\s\/\-–:,.&]+|[\s\/\-–:,&]+$/gm, '')
    .replace(/(\s*,\s*)+/g, ', ');
  return s.trim().replace(/^[^A-Za-z0-9(]+/, '') || t;
}

export function englishTitle(title) {
  const t = clean(title).replace(/\s+/g, ' ').trim();
  if (!/[\u0900-\u097F]/.test(t)) return t.replace(/^[“"]+|[”"]+$/g, '').trim();
  return englishText(t)
    .replace(/^[“"]+|[”"]+$/g, '')
    .replace(/\.$/, '')
    // grade suffixes orphaned from the Hindi half: "I/II/III (Research Associate - I/II/III)"
    .replace(/^-?[IVX]+(?:\/[IVX]+)*\s*(?:\/\s*)?(?=[(A-Z])/, '')
    .replace(/\s-[IVX]+\s+\(/g, ' (')
    .replace(/\/\s*&/g, '&')
    // leftovers before the first English word: "I 30.12.2024 Recruitment ..." / "() (4; Recruitment ..."
    .replace(/^[\s\-–IVX(),;\/\d.]*(?=[A-Z][a-z])/, '')
    // the walk-in / last-date sentence belongs in the deadline, not the title
    .replace(/[.,]?\s+(?:walk[- ]in|last date)\b.*$/i, '')
    .replace(/[.,;]\s*\d{1,2}[./-]\d{1,2}[./-]\d{2,4}.*$/, '')
    // a leading "(Executive) / ..." group loses its brackets
    .replace(/^\(([^()]+)\)(?=\s*(?:[\/,&-]|and\b|$))/, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .replace(/^([^()]*)\)/, '$1'); // unmatched ")" left by a stripped "(" 
}

// Stable form of a URL for aliasing: https, lower-case host, no fragment, no tracking params,
// no trailing slash.
export function canonicalUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(k)) url.searchParams.delete(k);
    let s = url.toString();
    if (s.endsWith('/') && url.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}
