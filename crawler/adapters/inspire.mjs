// INSPIRE-HEP jobs REST API. Metadata is CC0. contact_details is dropped (bulk email
// collection is not allowed by INSPIRE's terms).
import { htmlToText } from '../lib/text.mjs';
import { postingAliases } from '../lib/aliases.mjs';

export async function crawl(source, { http, log }) {
  const items = [];
  let url = source.url;
  for (let page = 0; url && page < 50; page++) {
    const { data } = await http.json(url, { conditional: false });
    for (const hit of data.hits?.hits ?? []) {
      const m = hit.metadata;
      if (m.status && m.status !== 'open') continue;
      const cn = m.control_number;
      const own = `https://inspirehep.net/jobs/${cn}`;
      const ext = [...(m.urls ?? []).map((u) => u.value), ...(m.reference_letters?.urls ?? []).map((u) => u.value)].filter(Boolean);
      items.push({
        source: source.id,
        sourceId: `inspire:${cn}`,
        url: own,
        aliases: [`inspire:${cn}`, own],
        // External posting URLs merge only when unambiguous (run.mjs drops ones several items share:
        // KU Leuven files five distinct INSPIRE jobs under one AJO umbrella ad).
        weakAliases: postingAliases(ext),
        applyUrl: ext[0],
        title: m.position,
        institution: (m.institutions ?? []).map((i) => i.value).join('; '),
        region: (m.regions ?? []).join(', '),
        scheme: 'inspire',
        values: m.ranks ?? [],
        arxiv: m.arxiv_categories ?? [],
        deadline: m.deadline_date ?? null,
        posted: (hit.created ?? '').slice(0, 10) || null,
        body: htmlToText(m.description ?? ''),
      });
    }
    url = data.links?.next ?? null;
  }
  log(`${items.length} open jobs`);
  return items;
}
