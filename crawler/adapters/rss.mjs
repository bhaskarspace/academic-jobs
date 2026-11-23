// RSS 2.0 feed of postings (IISER Mohali's Joomla notice portal). Each <item> is a posting: title,
// link, description (HTML: the advert text, with its deadline in prose) and pubDate (posted).
// A feed shows only its newest N items, so an item leaving the feed has usually just aged out:
// the result is marked partial and run.mjs carries such items forward instead of marking them gone.
// Config: url, institution, country, match/exclude (see crawler/lib/listing.mjs), detail? (rarely).
import * as cheerio from 'cheerio';
import { clean, canonicalUrl } from '../lib/text.mjs';

const isoDate = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10); };

export function parseFeed(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('item').map((_, it) => {
    const $it = $(it);
    const html = $it.find('description').first().text();
    const $d = cheerio.load(`<div>${html}</div>`);
    $d('script,style').remove();
    $d('p,div,br,li,tr,h1,h2,h3,h4,h5,h6').each((_, e) => { $d(e).append('\n'); });
    const pdfUrls = $d('a').map((_, a) => $d(a).attr('href')).get().filter((h) => h && /\.pdf(?:$|\?)/i.test(h));
    return {
      title: clean($it.find('title').first().text()),
      url: clean($it.find('link').first().text()) || clean($it.find('guid').first().text()),
      posted: isoDate($it.find('pubDate').first().text()),
      body: clean($d('div').first().text()),
      pdfUrls,
    };
  }).get().filter((r) => r.title && r.url);
}

export async function crawl(source, { http, log }) {
  const res = await http.get(source.url, { accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5' });
  const rows = parseFeed(res.body);
  const re = (s) => (s ? new RegExp(s, 'i') : null);
  const match = re(source.match);
  const exclude = re(source.exclude);
  const items = rows.filter((r) => (!match || match.test(r.title)) && (!exclude || !exclude.test(r.title))).map((r) => ({
    source: source.id,
    sourceId: `${source.id}:${r.url}`,
    url: r.url,
    aliases: [canonicalUrl(r.url)],
    title: r.title,
    titleOriginal: r.title,
    institution: source.institution,
    country: source.country ?? null,
    posted: r.posted,
    deadline: null, // read from the description text in normalize
    body: r.body,
    pdfUrls: r.pdfUrls.map((h) => new URL(h, res.url).toString()),
    fixedCategories: source.categories ?? undefined,
    fixedFields: source.fields ?? undefined,
    admissions: source.admissions || undefined,
  }));
  const posted = items.map((i) => i.posted).filter(Boolean).sort();
  Object.defineProperty(items, 'partial', { value: true });
  Object.defineProperty(items, 'oldestPosted', { value: posted[0] ?? null });
  Object.defineProperty(items, 'rowsSeen', { value: rows.length });
  log(`${items.length} feed items${rows.length !== items.length ? ` (${rows.length - items.length} filtered out)` : ''}`);
  return items;
}
