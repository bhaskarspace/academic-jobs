// Shared crawl loop for list-shaped sources (html-list, html-table): pagination, row filters,
// detail pages and the item shape. Adapters only turn one page of HTML into rows.
//
// Source keys handled here (see config/sources.yaml):
//   pages:   { next: "https://…{n}…", max: 10 }   paginated list. Pages are read in order until
//            a page has no open advert (deadline today or later, or no deadline but posted in
//            the last OPEN_WITHOUT_DEADLINE_DAYS days), or no rows, or `max`.
//   match / exclude:  regexes (case-insensitive) a row title must / must not match.
//   skipOld: true     drop rows whose title names only past years ("… January 2024").
//   maxAgeDays: N     drop rows with no deadline posted more than N days ago (a page that keeps
//                     years of undated adverts, as SINP does).
//   detail:  { text?, rows?, rowMap?, pdf? }   fetched once per new, unexpired row.
//   pdfs: false       link to PDFs but never fetch them (robots.txt disallows the PDF folder).
// A row is { title, url?, ref?, deadline?, posted?, body?, subject?, pi?, pdfUrls? }.
import * as cheerio from 'cheerio';
import { clean, canonicalUrl } from './text.mjs';
import { parseDate, todayISO } from './dates.mjs';

export const OPEN_WITHOUT_DEADLINE_DAYS = 60;
export const DEFAULT_MAX_PAGES = 10;

const lc = (s) => clean(s).toLowerCase();
export const slug = (s) => lc(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

export function byLabel(map, label) {
  const l = lc(label).replace(/:$/, '');
  for (const [prefix, key] of Object.entries(map || {})) if (l.startsWith(prefix.toLowerCase())) return key;
  return null;
}

const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

/** Is this row still open, judging by its dates alone? */
export function rowOpen(row, today) {
  if (row.deadline) return row.deadline >= today;
  return Boolean(row.posted && row.posted >= addDays(today, -OPEN_WITHOUT_DEADLINE_DAYS));
}

/** Text of a block with line breaks at block elements. */
export function blockText($, el) {
  const $t = $(el).clone();
  $t.find('script,style').remove();
  $t.find('p,div,br,li,tr,h1,h2,h3,h4,h5,h6').each((_, e) => { $(e).append('\n'); });
  return clean($t.text());
}

export function parseDetail(html, source, baseUrl) {
  const $ = cheerio.load(html);
  const D = source.detail || {};
  const out = {};
  if (D.text) {
    const el = $(D.text).first();
    if (el.length) out.body = blockText($, el);
  }
  if (D.rows) {
    $(D.rows).each((_, tr) => {
      const key = byLabel(D.rowMap, $(tr).find('th,td').first().text());
      if (!key) return;
      const v = clean($(tr).find('td').last().text());
      out[key] = key === 'deadline' ? parseDate(v) : v;
    });
  }
  if (D.pdf) {
    out.pdfUrls = [...new Set($(D.pdf).map((_, a) => $(a).attr('href')).get().filter(Boolean).map((h) => new URL(h, baseUrl).toString()))];
  }
  return out;
}

function keepRow(row, source, year, today) {
  if (source.maxAgeDays && !row.deadline && row.posted && row.posted < addDays(today, -source.maxAgeDays)) return false;
  if (source.match && !new RegExp(source.match, 'i').test(row.title)) return false;
  if (source.exclude && new RegExp(source.exclude, 'i').test(row.title)) return false;
  if (source.skipOld) {
    const years = (row.title.match(/\b20\d\d\b/g) ?? []).map(Number);
    if (years.length && Math.max(...years) < year) return false;
  }
  return true;
}

/**
 * Read a list source. `parsePage(html, source, pageUrl)` returns rows for one page.
 * The returned array carries `partial` (pages left unread) and `oldestPosted` (the oldest posted
 * date among the rows read), which run.mjs uses so that a posting that moved to an unread page is
 * carried forward rather than marked gone.
 */
export async function crawlListing(source, { http, log, cache, today: todayOverride }, parsePage) {
  const today = todayOverride ?? todayISO();
  const year = Number(today.slice(0, 4));
  const P = source.pages;
  const max = P ? (P.max ?? DEFAULT_MAX_PAGES) : 1;
  const rows = [];
  const seen = new Set();
  let partial = false;
  let pagesRead = 0;
  for (let n = 1; n <= max; n++) {
    const url = n === 1 ? source.url : P.next.replace('{n}', String(n));
    const res = await http.get(url);
    pagesRead++;
    const got = parsePage(res.body, source, res.url).filter((r) => r.title);
    const fresh = got.filter((r) => { const k = `${r.ref ?? ''}\t${r.url ?? ''}\t${r.title}`; if (seen.has(k)) return false; seen.add(k); return true; });
    rows.push(...fresh);
    if (!P || !fresh.length) break; // past the last page (or the site repeats its last page)
    if (!fresh.some((r) => rowOpen(r, today))) { partial = true; break; } // older pages are all closed too
    if (n === max) partial = true;
  }
  if (source.titleRef) {
    // The advert number leads the title ("Advertisement No.: (92/2026) – Recruitment for …").
    const re = new RegExp(source.titleRef, 'i');
    for (const r of rows) {
      const m = re.exec(r.title);
      if (!m) continue;
      r.ref ??= m[1]?.trim() || null;
      const rest = r.title.slice(m[0].length).trim();
      if (rest) r.title = rest.replace(/^[“"](.+?)[”"]/, '$1');
    }
  }
  // A deadline written into the list title ("… [Last date: 05.06.2026]", "(Last Date :28-02-2024)")
  // is list data: it dates the row, so an expired row's detail page isn't fetched.
  for (const r of rows) {
    if (r.deadline) continue;
    const m = /\b(?:last\s+date|closing\s+date|deadline)\s*(?:of\s+application\s*)?[:\-–]?\s*([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4}|[0-9]{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+20[0-9]{2}|[A-Za-z]{3,9}\s+[0-9]{1,2},?\s+20[0-9]{2})/i.exec(r.title);
    const d = m && parseDate(m[1]);
    if (d) r.deadline = d;
  }
  const kept = rows.filter((r) => keepRow(r, source, year, today));
  let fetched = 0;
  let detailErrors = 0;
  const items = [];
  for (const row of kept) {
    let detail = {};
    // No link of its own: the advert PDF, else the list page + #slug (the fragment keeps postings
    // of one page apart; it is not an alias, since canonical URLs drop fragments).
    const url = row.url ?? row.pdfUrls?.[0] ?? `${source.url}#${slug(row.title)}`;
    const ownUrl = Boolean(row.url ?? row.pdfUrls?.[0]);
    if (source.detail && row.url) {
      const key = `detail:${row.url}`;
      detail = (await cache.get(key)) ?? null;
      const expired = row.deadline && row.deadline < today;
      if (!detail && !expired) {
        try {
          const d = await http.get(row.url);
          detail = parseDetail(d.body, source, d.url);
          await cache.set(key, detail);
          fetched++;
        } catch (e) {
          detailErrors++;
          log(`detail failed ${row.url}: ${e.code || e.message}`);
        }
      }
      detail ??= {};
    }
    const pdfUrls = [...new Set([...(row.pdfUrls ?? []), ...(detail.pdfUrls ?? [])])];
    items.push({
      source: source.id,
      sourceId: `${source.id}:${row.ref || url}`,
      url,
      aliases: ownUrl ? [canonicalUrl(url)] : [],
      title: row.title,          // English part is extracted in normalize
      titleOriginal: row.title,
      institution: source.institution,
      country: source.country ?? null,
      ref: detail.ref || row.ref || null,
      deadline: row.deadline ?? detail.deadline ?? null,
      posted: row.posted ?? null,
      body: [row.body, detail.body].filter(Boolean).join('\n'),
      subject: row.subject ?? null,
      pi: row.pi ?? null,
      fixedCategories: source.categories ?? undefined,
      fixedFields: source.fields ?? undefined,
      admissions: source.admissions || undefined,
      rolling: row.rolling || undefined,
      pdfUrls,
      noPdfFetch: source.pdfs === false || undefined,
    });
  }
  const posted = kept.map((r) => r.posted).filter(Boolean).sort();
  Object.defineProperty(items, 'partial', { value: partial });
  Object.defineProperty(items, 'oldestPosted', { value: posted[0] ?? null });
  Object.defineProperty(items, 'rowsSeen', { value: rows.length }); // before filters: the markup still matched
  log(`${items.length} rows${rows.length !== kept.length ? ` (${rows.length - kept.length} filtered out)` : ''} from ${pagesRead} page${pagesRead > 1 ? 's' : ''}${partial ? ' (stopped: the last page read had no open advert)' : ''}, ${fetched} detail pages fetched${detailErrors ? `, ${detailErrors} detail errors` : ''}`);
  return items;
}

/**
 * Postings of a partial read (pages left unread, or a feed's newest-N window) that were seen last
 * run but not this one, and that are older than the oldest row read: they moved to an unread page
 * or aged out of the feed, so they are kept as they were. A missing posting newer than that was
 * inside the range read, so it really left the list (and the removal rule applies).
 */
export function carryForward(items, prevItems) {
  if (!items.partial) return [];
  const have = new Set(items.map((it) => it.sourceId));
  return prevItems.filter((p) => !have.has(p.sourceId) && !(p.posted && items.oldestPosted && p.posted > items.oldestPosted));
}
