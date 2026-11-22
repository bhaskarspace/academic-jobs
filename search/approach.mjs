// Theory / computational / experimental tag from text cues (config/approach.yaml). Build time only.
//
// Per tag: a cue in the title gives high confidence; in the ad text, two or more distinct cues give
// medium and one gives low. Explicit theory cues win:
//   - the institution's group/unit/department name says Theory/Theoretical ("Quantum Matter Theory
//     Group", "Inst. Theor. Phys.") -> theory, high
//   - "theoretical ... physics" in the title or the first ~300 characters -> theory, high
//   - a high-confidence theory posting gets an experimental tag only from an explicit
//     experimental phrase (`explicit.experimental`), not from "theory and experiment" or a
//     "Microkelvin Laboratory" in the department blurb.
export const APPROACH_SHORT = { theory: 'th', computational: 'comp', experimental: 'exp' };
const LEAD_CHARS = 300;
const THEORY_UNIT = /\btheor(y|etical|\.)/i;
const THEORETICAL_PHYSICS = /\btheoretical\b[^.;:]{0,80}?\bphysics\b/i;

export function makeApproachTagger(cfg = {}) {
  const { explicit = {}, ...tags } = cfg;
  const rules = Object.entries(tags).map(([tag, pats]) => ({
    tag,
    res: pats.map((p) => new RegExp(p, 'i')),
    global: pats.map((p) => new RegExp(p, 'gi')),
    explicit: (explicit[tag] ?? []).map((p) => new RegExp(p, 'i')),
  }));
  /** @returns {Array<{approach, confidence}>} */
  return ({ title = '', body = '', unit = '' }) => {
    const out = new Map();
    for (const { tag, res, global } of rules) {
      if (res.some((r) => r.test(title))) { out.set(tag, 'high'); continue; }
      const distinct = new Set();
      for (const r of global) for (const m of body.matchAll(r)) distinct.add(m[0].toLowerCase());
      if (distinct.size >= 2) out.set(tag, 'medium');
      else if (distinct.size === 1) out.set(tag, 'low');
    }
    // Explicit theory cues, unless the title itself says experimental ("Experimental Particle
    // Physics" at an "Inst. Theor. Phys." affiliation stays experimental).
    const titleExp = out.get('experimental') === 'high';
    if (!titleExp && rules.some((r) => r.tag === 'theory')) {
      const unitName = unit.split(',').slice(1).join(',') || unit; // "University X, Theoretical Physics"
      if (THEORY_UNIT.test(unitName) || THEORETICAL_PHYSICS.test(title) || THEORETICAL_PHYSICS.test(body.slice(0, LEAD_CHARS))) {
        out.set('theory', 'high');
      }
    }
    if (out.get('theory') === 'high' && out.has('experimental') && !titleExp) {
      const exp = rules.find((r) => r.tag === 'experimental');
      if (!exp.explicit.some((r) => r.test(body))) out.delete('experimental');
    }
    return [...out].map(([approach, confidence]) => ({ approach, confidence }));
  };
}
