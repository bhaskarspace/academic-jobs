// Display names for generic institution names (config/institutions.yaml `display:`). INSPIRE and AJO
// both name some institutes only generically ("Institute of Physics"); the card then shows the city
// as well ("Institute of Physics, Bhubaneswar"). A rule fires only when its `when` pattern matches the
// posting's other evidence (the INSPIRE ICN in institutionAlt, the AJO city, or the country), so other
// institutes of the same name are left alone. Applied after dedupe: display only, the source's own
// name stays searchable (institutionSource).

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Compile `display:` rules: [{name, when, show}], `when` a case-insensitive regex. */
export function compileDisplay(rules = []) {
  return rules.map((r, i) => {
    if (!r?.name || !r?.show || !r?.when) throw new Error(`institutions.yaml display[${i}]: name, when and show are required`);
    return { name: fold(r.name), when: new RegExp(r.when, 'i'), show: r.show };
  });
}

/**
 * The posting with its display institution. Each "; "-separated part is checked on its own, against
 * the matching part of institutionAlt (INSPIRE lists ICNs in the same order) or else the whole of
 * it, the city and the country.
 */
export function displayInstitution(p, rules) {
  if (!rules.length || !p.institution) return p;
  const parts = p.institution.split('; ');
  const alts = String(p.institutionAlt ?? '').split('; ');
  let changed = false;
  const out = parts.map((part, i) => {
    const r = rules.find((x) => x.name === fold(part));
    if (!r) return part;
    const evidence = [alts.length === parts.length ? alts[i] : p.institutionAlt, p.city, p.country].filter(Boolean).join(' | ');
    if (!r.when.test(evidence)) return part;
    changed = true;
    return r.show;
  });
  return changed ? { ...p, institution: out.join('; '), institutionSource: p.institution } : p;
}
