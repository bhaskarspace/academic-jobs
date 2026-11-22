// Theory / computational / experimental tag from text cues (config/approach.yaml). Build time only.
export const APPROACH_SHORT = { theory: 'th', computational: 'comp', experimental: 'exp' };

export function makeApproachTagger(cfg = {}) {
  const rules = Object.entries(cfg).map(([tag, pats]) => ({ tag, res: pats.map((p) => new RegExp(p, 'i')) }));
  const global = Object.fromEntries(rules.map(({ tag, res }) => [tag, res.map((r) => new RegExp(r.source, 'gi'))]));
  /** @returns {Array<{approach, confidence}>} */
  return ({ title = '', body = '' }) => {
    const out = [];
    for (const { tag, res } of rules) {
      if (res.some((r) => r.test(title))) { out.push({ approach: tag, confidence: 'high' }); continue; }
      const distinct = new Set();
      for (const r of global[tag]) for (const m of body.matchAll(r)) distinct.add(m[0].toLowerCase());
      if (distinct.size >= 2) out.push({ approach: tag, confidence: 'medium' });
      else if (distinct.size === 1) out.push({ approach: tag, confidence: 'low' });
    }
    return out;
  };
}
