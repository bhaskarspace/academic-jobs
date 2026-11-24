// Adapter for postings laid out as rows of an HTML table whose header names the columns.
// Config (see config/sources.yaml):
//   table:   selector of the table (default "table")
//   columns: { headerPrefix: role }   roles: title, link (anchor in the cell), pdf (anchors to the
//            advert), deadline, posted, ref, subject, pi. A cell can serve two roles with a list:
//            { "job title": [title, link] }.
//   skip:    regex; rows whose title matches are not postings ("Application form", "Annexure").
// Headerless tables can name columns by position instead: columns: { "#2": title, ... }.
// A table without <th> cells uses its first row as the header (bold <td>s, as on TIFR-H).
//   titleSelector: selector inside the title cell, when the cell also holds a description (ISI).
//   pdfLinks: regex; only links matching it count for the pdf role (a cell may also hold an
//            "Apply Online" form link, as on IUCAA).
//   rollingTables: regex; a table whose preceding heading or paragraph matches is a standing
//            call ("accepting applications throughout the year"): its rows are rolling.
// Pagination, filters and detail pages: crawler/lib/listing.mjs.
import * as cheerio from 'cheerio';
import { clean } from '../lib/text.mjs';
import { parseDate } from '../lib/dates.mjs';
import { crawlListing, byLabel } from '../lib/listing.mjs';

export function parseTable(html, source, baseUrl) {
  const $ = cheerio.load(html);
  const out = [];
  const skip = source.skip ? new RegExp(source.skip, 'i') : null;
  const pdfLink = source.pdfLinks ? new RegExp(source.pdfLinks, 'i') : null;
  const cellText = ($c, role) => {
    if (role === 'title' && source.titleSelector) { const t = $c.find(source.titleSelector).first(); if (t.length) return clean(t.text()); }
    return clean($c.text());
  };
  $(source.table ?? 'table').each((_, table) => {
    const $t = $(table);
    const withTh = $t.find('tr').filter((_, r) => $(r).find('th').length > 0).first();
    const header = withTh.length ? withTh : $t.find('tr').first();
    const heads = header.find('th,td').map((_, c) => clean($(c).text())).get();
    const roles = heads.map((h, i) => {
      const r = source.columns[`#${i + 1}`] ?? byLabel(source.columns, h);
      return r == null ? [] : [].concat(r);
    });
    if (!roles.some((r) => r.includes('title'))) return; // not the postings table
    const lead = source.rollingTables ? clean($t.prevAll('h1,h2,h3,h4,h5,h6,p,strong,div').first().text()) : '';
    const rolling = Boolean(source.rollingTables && new RegExp(source.rollingTables, 'i').test(lead));
    $t.find('tr').each((_, tr) => {
      if (tr === header[0]) return;
      const cells = $(tr).children('td');
      if (cells.length < 2) return;
      const row = {};
      cells.each((i, td) => {
        const $c = $(td);
        for (const role of roles[i] ?? []) {
          const v = cellText($c, role);
          const hrefs = $c.find('a').map((_, a) => $(a).attr('href')).get().filter((h) => h && !/^(#|javascript:)/.test(h));
          if (role === 'link') { if (hrefs[0]) row.url = new URL(hrefs[0], baseUrl).toString(); }
          // A folder URL ("…/uploads/job/") is a broken link, not a document.
          else if (role === 'pdf') row.pdfUrls = [...new Set([...(row.pdfUrls ?? []), ...hrefs.filter((h) => !/\/$/.test(h) && (!pdfLink || pdfLink.test(h))).map((h) => new URL(h, baseUrl).toString())])];
          else if (role === 'deadline' || role === 'posted') row[role] = parseDate(v);
          else if (v) row[role] = v;
        }
      });
      if (!row.title || (skip && skip.test(row.title))) return;
      if (rolling) row.rolling = true;
      // A row whose only link is its PDF: the PDF is the posting's URL.
      if (!row.url && row.pdfUrls?.length && !source.detail) row.url = row.pdfUrls[0];
      out.push(row);
    });
  });
  return out;
}

export const crawl = (source, ctx) => crawlListing(source, ctx, parseTable);
