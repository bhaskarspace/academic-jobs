// One standing call described on a single page (e.g. "Postdoctoral Research Associate positions,
// apply any time"). Indexed as one rolling posting with no deadline.
import * as cheerio from 'cheerio';
import { clean, canonicalUrl } from '../lib/text.mjs';

export function parsePage(html, source) {
  const $ = cheerio.load(html);
  const $t = $(source.text || 'main').first().clone();
  $t.find('script,style').remove();
  $t.find('p,div,br,li,tr,h1,h2,h3,h4,h5,h6').each((_, el) => { $(el).append('\n'); });
  return clean($t.text());
}

export async function crawl(source, { http }) {
  const res = await http.get(source.url);
  const body = parsePage(res.body, source);
  if (!body) throw new Error(`selector ${source.text} matched nothing`);
  return [{
    source: source.id,
    sourceId: `${source.id}:page`,
    url: source.url,
    aliases: [canonicalUrl(source.url)],
    title: source.title,
    institution: source.institution,
    country: source.country ?? null,
    fixedCategories: source.categories ?? [],
    rolling: true,
    deadline: null,
    posted: null,
    body,
  }];
}
