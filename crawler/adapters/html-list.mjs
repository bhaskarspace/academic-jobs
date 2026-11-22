// Selector-driven adapter for an HTML page that lists postings, with optional detail pages.
// Config (see config/sources.yaml):
//   list:   { item, title, link, ref?, dates?: {sel, label, map: {labelPrefix: deadline|posted}} }
//   detail: { text?, rows?, rowMap?: {labelPrefix: deadline|ref}, pdf? }
// Detail pages are fetched only for postings not seen before (cached by URL), and not at all
// for postings whose list deadline has already passed.
import * as cheerio from 'cheerio';
import { clean, canonicalUrl } from '../lib/text.mjs';
import { parseDate, todayISO } from '../lib/dates.mjs';

const lc = (s) => clean(s).toLowerCase();

function byLabel(map, label) {
  const l = lc(label);
  for (const [prefix, key] of Object.entries(map || {})) if (l.startsWith(prefix.toLowerCase())) return key;
  return null;
}

export function parseList(html, source, baseUrl) {
  const $ = cheerio.load(html);
  const L = source.list;
  const out = [];
  $(L.item).each((_, el) => {
    const $el = $(el);
    const a = $el.find(L.link).first();
    const href = a.attr('href');
    const title = clean($el.find(L.title).first().text());
    if (!title || !href) return;
    const item = { title, url: new URL(href, baseUrl).toString() };
    if (L.ref) {
      const $r = $el.find(L.ref).first().clone();
      $r.find('strong,b,label').remove();
      item.ref = clean($r.text()) || null;
    }
    if (L.dates) {
      $el.find(L.dates.sel).each((_, d) => {
        const $d = $(d);
        const label = $d.find(L.dates.label).first().text();
        const key = byLabel(L.dates.map, label);
        const $v = $d.clone();
        $v.find(L.dates.label).remove();
        if (key) item[key] = parseDate(clean($v.text()));
      });
    }
    out.push(item);
  });
  return out;
}

export function parseDetail(html, source, baseUrl) {
  const $ = cheerio.load(html);
  const D = source.detail || {};
  const out = {};
  if (D.text) {
    const $t = $(D.text).first().clone();
    $t.find('script,style').remove();
    $t.find('p,div,br,li,tr,h1,h2,h3,h4,h5,h6').each((_, el) => { $(el).append('\n'); });
    out.body = clean($t.text());
  }
  if (D.rows) {
    $(D.rows).each((_, tr) => {
      const key = byLabel(D.rowMap, $(tr).find('th').first().text());
      if (!key) return;
      const v = clean($(tr).find('td').first().text());
      out[key] = key === 'deadline' ? parseDate(v) : v;
    });
  }
  if (D.pdf) {
    out.pdfUrls = [...new Set($(D.pdf).map((_, a) => $(a).attr('href')).get().filter(Boolean).map((h) => new URL(h, baseUrl).toString()))];
  }
  return out;
}

export async function crawl(source, { http, log, cache, today: todayOverride }) {
  const res = await http.get(source.url);
  const rows = parseList(res.body, source, res.url);
  const today = todayOverride ?? todayISO();
  let fetched = 0;
  let detailErrors = 0;
  const items = [];
  for (const row of rows) {
    let detail = {};
    if (source.detail) {
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
    const url = row.url;
    items.push({
      source: source.id,
      sourceId: `${source.id}:${row.ref || url}`,
      url,
      aliases: [canonicalUrl(url)],
      title: row.title,          // English part is extracted in normalize
      titleOriginal: row.title,
      institution: source.institution,
      country: source.country ?? null,
      ref: detail.ref || row.ref || null,
      deadline: row.deadline ?? detail.deadline ?? null,
      posted: row.posted ?? null,
      body: detail.body ?? '',
      pdfUrls: detail.pdfUrls ?? [],
    });
  }
  log(`${items.length} rows, ${fetched} detail pages fetched${detailErrors ? `, ${detailErrors} detail errors` : ''}`);
  return items;
}
