// One page describing a standing call (e.g. "Postdoctoral Research Associate positions, apply any
// time", or an institute's PhD admissions page). Indexed as one posting with no list deadline.
// Config: url, title, text (selector), categories, fields, rolling (default true: "apply any
// time"; false for pages like PhD admissions that open by dated advertisement, whose deadline is
// then read from the page text).
//   sections: { heading, match?, skipOld? }   a page that stacks several calls ("ADMISSION TO
//            Ph.D. PROGRAM – JANUARY 2027", "… JANUARY 2024"): one posting per heading that
//            matches; skipOld drops headings naming only past years.
import * as cheerio from 'cheerio';
import { clean, canonicalUrl } from '../lib/text.mjs';
import { slug } from '../lib/listing.mjs';
import { todayISO } from '../lib/dates.mjs';

const MARK = '\u0001';

export function parsePage(html, source) {
  const $ = cheerio.load(html);
  const $all = $(source.text || 'main');
  const $t = (source.textAll ? $('<div></div>').append($all.clone()) : $all.first().clone());
  $t.find('script,style,nav,header,footer').remove();
  if (source.sections) $t.find(source.sections.heading).each((_, h) => { $(h).prepend(MARK); });
  $t.find('p,div,br,li,tr,h1,h2,h3,h4,h5,h6').each((_, el) => { $(el).append('\n'); });
  return clean($t.text());
}

/** Split page text at the marked headings: [{title, body}]. */
export function sectionsOf(text, { match, skipOld } = {}, today = todayISO()) {
  const year = Number(today.slice(0, 4));
  const re = match ? new RegExp(match, 'i') : null;
  return text.split(MARK).slice(1).map((chunk) => {
    const [first, ...rest] = chunk.split('\n');
    return { title: clean(first), body: clean(rest.join('\n')) };
  }).filter(({ title }) => {
    if (!title || (re && !re.test(title))) return false;
    const years = (title.match(/\b20\d\d\b/g) ?? []).map(Number);
    return !(skipOld && years.length && Math.max(...years) < year);
  });
}

export async function crawl(source, { http, today }) {
  const res = await http.get(source.url);
  const text = parsePage(res.body, source);
  if (!text) throw new Error(`selector ${source.text} matched nothing`);
  const base = {
    source: source.id,
    institution: source.institution,
    country: source.country ?? null,
    fixedCategories: source.categories ?? [],
    fixedFields: source.fields ?? undefined,
    admissions: source.admissions || undefined,
    rolling: source.rolling !== false,
    deadline: null,
    posted: null,
  };
  if (!source.sections) {
    return [{ ...base, sourceId: `${source.id}:page`, url: source.url, aliases: [canonicalUrl(source.url)], title: source.title, body: text.replaceAll(MARK, '') }];
  }
  const items = sectionsOf(text, source.sections, today).map(({ title, body }) => {
    const url = `${source.url}#${slug(title)}`;
    return { ...base, sourceId: `${source.id}:${slug(title)}`, url, aliases: [], title: `${source.titlePrefix ?? ''}${title}`, body };
  });
  Object.defineProperty(items, 'rowsSeen', { value: text.split(MARK).length - 1 }); // headings found
  return items;
}
