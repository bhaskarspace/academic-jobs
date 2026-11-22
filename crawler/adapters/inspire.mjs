// INSPIRE-HEP jobs REST API. Metadata is CC0. contact_details is dropped (bulk email
// collection is not allowed by INSPIRE's terms).
import { htmlToText } from '../lib/text.mjs';
import { postingAliases } from '../lib/aliases.mjs';

const INST_TTL_DAYS = 90;

/** "University of Oxford, Particle Physics Department" from an INSPIRE institution record. */
export function institutionName(meta) {
  const h = (meta.institution_hierarchy ?? []).map((x) => x.name).filter(Boolean);
  return h.length ? [...h].reverse().join(', ') : null;
}

/**
 * Full names (and countries) for INSPIRE institution records, in bulk (100 per request) and cached
 * for INST_TTL_DAYS. Jobs only carry the ICN abbreviation ("U. Oxford (main)").
 */
export async function resolveInstitutions(ids, { http, cache, log, now = new Date() }) {
  const out = new Map();
  const missing = [];
  for (const id of ids) {
    const c = cache ? await cache.get(`inspire-inst:${id}`) : null;
    if (c && Date.parse(now) - Date.parse(c.at) < INST_TTL_DAYS * 86_400_000) out.set(id, c);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const q = encodeURIComponent(`control_number:(${chunk.join(' OR ')})`);
    try {
      const { data } = await http.json(`https://inspirehep.net/api/institutions?q=${q}&size=100&fields=control_number,legacy_ICN,institution_hierarchy,addresses.country_code`, { conditional: false });
      for (const h of data.hits?.hits ?? []) {
        const m = h.metadata;
        const rec = { name: institutionName(m), country: m.addresses?.[0]?.country_code ?? null, at: now.toISOString() };
        out.set(String(m.control_number), rec);
        if (cache) await cache.set(`inspire-inst:${m.control_number}`, rec);
      }
    } catch (e) {
      log?.(`institution names unavailable (${e.message}); keeping abbreviations`);
    }
  }
  if (missing.length) log?.(`looked up ${missing.length} institution records`);
  return out;
}

export async function crawl(source, { http, log, cache }) {
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
        institutionRefs: (m.institutions ?? []).map((i) => /\/institutions\/(\d+)/.exec(i.record?.$ref ?? '')?.[1] ?? null),
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
  // ICN abbreviations -> full names; the abbreviation stays searchable as institutionAlt.
  const ids = [...new Set(items.flatMap((it) => it.institutionRefs).filter(Boolean))];
  const names = await resolveInstitutions(ids, { http, cache, log });
  for (const it of items) {
    const icn = it.institution.split('; ');
    const recs = it.institutionRefs.map((id) => names.get(id) ?? null);
    const full = icn.map((a, i) => recs[i]?.name ?? a);
    if (full.join('; ') !== it.institution) {
      it.institutionAlt = it.institution;
      it.institution = full.join('; ');
    }
    const countries = [...new Set(recs.map((r) => r?.country).filter(Boolean))];
    if (countries.length === 1) it.country = countries[0];
    delete it.institutionRefs;
  }
  log(`${items.length} open jobs`);
  return items;
}
