// AcademicJobsOnline / MathJobs public JSON feed (same software). The feed's own hint invites
// reuse ("Please let us know if you need any new data fields in the feed").
import { htmlToText } from '../lib/text.mjs';
import { parseDate } from '../lib/dates.mjs';
import { postingAliases } from '../lib/aliases.mjs';

export async function crawl(source, { http, log }) {
  const limit = source.pageSize ?? 500;
  const items = [];
  let total = Infinity;
  for (let page = 1; (page - 1) * limit < total && page <= 20; page++) {
    const { data } = await http.json(`${source.url}?limit=${limit}&page=${page}`, { conditional: false });
    total = Number(data.total_count ?? 0);
    const results = data.results ?? [];
    if (!results.length) break;
    for (const r of results) {
      const url = r.url;
      const type = typeof r.type === 'string' && r.type.trim() && r.type !== 'BEGIN' ? r.type.trim() : null;
      items.push({
        source: source.id,
        sourceId: `${source.id}:${r.id}`,
        url,
        aliases: [`${source.id}:${r.id}`, ...postingAliases([url])],
        applyUrl: r.apply,
        title: r.name,
        institution: [r.univ, r.unit_name].filter(Boolean).join(', '),
        country: r.country || null,
        city: r.city || null,
        scheme: 'ajo',
        values: type ? [type] : [],
        subject: r.subject || '',
        deadline: parseDate(r.deadline_raw) ?? parseDate(r.close_date_raw),
        posted: parseDate(r.open_date_raw),
        body: htmlToText([r.description, r.qualifications].filter(Boolean).join('\n')),
      });
    }
  }
  log(`${items.length} of ${total} postings`);
  return items;
}
