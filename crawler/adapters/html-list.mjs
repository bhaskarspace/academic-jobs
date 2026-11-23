// Selector-driven adapter for an HTML page that lists postings as repeated blocks (list items,
// cards, one table per advert), with optional detail pages and pagination (crawler/lib/listing.mjs).
// Config (see config/sources.yaml):
//   list: {
//     item,                    one element per posting
//     title,                   selector; with titleAll: true, every match is joined ("Post A; Post B")
//     link?,                   anchor; without it the posting URL is the page URL + #slug(title)
//     ref?, body?, subject?, pi?   selectors (text)
//     pdf?,                    anchors to PDF adverts inside the item
//     dates?: { sel, label, map: {labelPrefix: deadline|posted} }   one element per date
//     labels?: { sel, map: {labelPrefix: deadline|posted|ref} }      "Label: value" runs in one text
//   }
import * as cheerio from 'cheerio';
import { clean } from '../lib/text.mjs';
import { parseDate } from '../lib/dates.mjs';
import { crawlListing, byLabel, blockText, parseDetail } from '../lib/listing.mjs';

export { parseDetail };

const RE_ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Advertisement Number: X, Dated: 2026-11-06 Last Date: 01 Dec 2026" -> {ref, posted, deadline, lead}. */
export function labelled(text, map) {
  const labels = Object.keys(map);
  const any = labels.map(RE_ESC).join('|');
  const out = {};
  const first = new RegExp(`(?:${any})\\s*:`, 'i').exec(text);
  out.lead = clean((first ? text.slice(0, first.index) : text).replace(/[,;]\s*$/, ''));
  for (const label of labels) {
    const m = new RegExp(`${RE_ESC(label)}\\s*:\\s*([\\s\\S]*?)(?=(?:${any})\\s*:|$)`, 'i').exec(text);
    if (!m) continue;
    const key = map[label];
    const v = clean(m[1]).replace(/[,;]\s*$/, '').replace(/\s*\bNew\b\s*$/i, '');
    out[key] = key === 'deadline' || key === 'posted' ? parseDate(v) : v;
  }
  return out;
}

export function parseList(html, source, baseUrl) {
  const $ = cheerio.load(html);
  const L = source.list;
  const text = ($el, sel) => (sel ? clean($el.find(sel).first().text()) : '');
  const out = [];
  $(L.item).each((_, el) => {
    const $el = $(el);
    const titles = L.title === '@lead' ? [] : L.titleAll
      ? [...new Set($el.find(L.title).map((_, t) => clean($(t).text())).get().filter(Boolean))]
      : [clean($el.find(L.title).first().text())].filter(Boolean);
    let title = titles.join('; ');
    const item = {};
    if (L.labels) {
      const v = labelled(clean($el.find(L.labels.sel).first().text()), L.labels.map);
      for (const k of ['ref', 'posted', 'deadline']) if (v[k]) item[k] = v[k];
      if (!title && L.title === '@lead') title = v.lead;
    }
    if (!title) return;
    item.title = title;
    if (L.link) {
      const href = $el.find(L.link).first().attr('href');
      if (!href) return;
      item.url = new URL(href, baseUrl).toString();
    }
    if (L.ref) {
      const $r = $el.find(L.ref).first().clone();
      $r.find('strong,b,label').remove();
      item.ref = clean($r.text()) || item.ref || null;
    }
    if (L.body) { const b = $el.find(L.body); if (b.length) item.body = b.map((_, e) => blockText($, e)).get().join('\n'); }
    if (L.subject) item.subject = [...new Set($el.find(L.subject).map((_, t) => clean($(t).text())).get().filter(Boolean))].join('; ') || null;
    if (L.pi) item.pi = text($el, L.pi) || null;
    if (L.pdf) item.pdfUrls = [...new Set($el.find(L.pdf).map((_, a) => $(a).attr('href')).get().filter((h) => h && !/\/$/.test(h)).map((h) => new URL(h, baseUrl).toString()))];
    if (L.dates) {
      $el.find(L.dates.sel).each((_, d) => {
        const $d = $(d);
        const key = byLabel(L.dates.map, $d.find(L.dates.label).first().text());
        const $v = $d.clone();
        $v.find(L.dates.label).remove();
        if (key) item[key] = parseDate(clean($v.text()));
      });
    }
    out.push(item);
  });
  return out;
}

export const crawl = (source, ctx) => crawlListing(source, ctx, parseList);
