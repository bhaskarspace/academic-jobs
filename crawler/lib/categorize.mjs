// Category assignment. Output is a SET: [{category, confidence}], highest confidence kept per
// category, sorted by confidence then by category order.
const ORDER = ['phd', 'postdoc', 'faculty', 'fellowship', 'other'];
const RANK = { high: 3, medium: 2, low: 1 };

export function makeCategorizer(cfg) {
  const rules = (cfg.rules || []).map((r) => ({ re: new RegExp(r.pattern, 'i'), category: r.category }));
  const structured = cfg.structured || {};

  return function categorize({ scheme, values = [], fixed = [], title = '', body = '' }) {
    const got = new Map();
    const add = (category, confidence) => {
      const prev = got.get(category);
      if (!prev || RANK[confidence] > RANK[prev]) got.set(category, confidence);
    };
    for (const c of fixed) add(c, 'high');
    const table = structured[scheme] || {};
    for (const v of values) {
      if (v == null) continue;
      const m = table[v] ?? table[String(v).trim()];
      for (const c of [].concat(m ?? [])) add(c, 'high');
    }
    for (const r of rules) if (r.re.test(title)) add(r.category, 'medium');
    if (!got.size && body) for (const r of rules) if (r.re.test(body)) add(r.category, 'low');
    if (!got.size) add('other', 'low');
    // "other" is only kept when nothing more specific fired.
    if (got.size > 1) got.delete('other');
    return [...got].map(([category, confidence]) => ({ category, confidence }))
      .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || ORDER.indexOf(a.category) - ORDER.indexOf(b.category));
  };
}

export function makeFieldTagger(cfg) {
  const rules = (cfg.rules || []).map((r) => ({ re: new RegExp(r.pattern, 'i'), tags: r.tags }));
  return function fieldsOf({ arxiv = [], subject = '' }) {
    const out = new Set(arxiv.map((a) => String(a).toLowerCase()));
    for (const part of String(subject || '').split(/[;,]/)) for (const r of rules) if (r.re.test(part)) r.tags.forEach((t) => out.add(t));
    // arXiv sub-tags imply the bucket.
    for (const t of [...out]) {
      if (/^(hep|gr-qc|cond-mat|math-ph|quant-ph|nucl|astro-ph|physics)/.test(t)) out.add('physics');
      if (/^math(\.|$)/.test(t)) out.add('math');
    }
    return [...out].sort();
  };
}
