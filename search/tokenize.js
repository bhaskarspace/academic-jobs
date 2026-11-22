// Tokenizer shared by the index build and the browser. Physics-aware:
//   AdS/CFT  -> ads, cft, adscft        AdS_5 / AdS5 / AdS$_5$ -> ads, ads5
//   N=4 SYM  -> n=4, sym                SU(N), U(1), SL(2,R)   -> su(n), u(1), sl(2,r)
//   TTbar / T\bar{T} / TT̄  -> ttbar    2+1D, (2+1)-dimensional, 2+1 dimensions -> 2+1d
//   many-body -> mani, bodi, manybodi   Greek letters -> spelled names (β -> beta)
// Each token carries the [start, end) span in the original string so the UI can highlight it.
// `variants` (from concepts/physics.yaml) folds morphological variants Porter2 keeps apart,
// e.g. holography/holographic, onto one stem; pass the same table on both sides.

import { stem } from './stem.js';

const GREEK = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ϵ: 'epsilon', ζ: 'zeta', η: 'eta',
  θ: 'theta', ϑ: 'theta', ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', ο: 'omicron',
  π: 'pi', ρ: 'rho', σ: 'sigma', ς: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi', ϕ: 'phi', χ: 'chi',
  ψ: 'psi', ω: 'omega',
};

// Acronyms that Porter2 would mangle or that collide with English words once stemmed
// (AdS -> "ad"). They are indexed as-is.
export const PROTECTED = new Set([
  'ads', 'cft', 'ds', 'sym', 'qft', 'qcd', 'qed', 'tqft', 'eth', 'mbl', 'otoc', 'syk', 'rmt',
  'ttbar', 'bcs', 'dmrg', 'dft', 'cmb', 'lhc', 'gr', 'bec', 'qec', 'nisq', 'peps', 'mps', 'tns',
  'susy', 'sugra', 'bmn', 'abjm', 'jt', 'lqg', 'ml', 'ai', 'hep', 'amo', 'qi', 'qc',
]);

export const STOPWORDS = new Set((
  'a an and are as at be been but by can could did do does for from had has have he her his how i if in ' +
  'into is it its may might more most must no nor not of on or our out over shall she should so such than ' +
  'that the their them then there these they this those through to under up upon us was we were what when ' +
  'where which while who whom why will with within without would you your also any all each other only ' +
  'own same very via per etc ie eg vs'
).split(' '));
// "out" is useful in "out-of-time-order" compounds but noise on its own; compounds keep it in the joined form.

const TTBAR = /^(t\\bar\{?t\}?|ttbar|tt-bar|t-tbar)$/;
const DIMS = /^\(?(\d)\+(\d)\)?(?:[-]?(?:d|dim|dims|dimensional|dimensions))?$/;
const GROUP = /^[a-z]{1,4}\([a-z0-9,+]{1,6}\)$/;          // su(n) so(3) u(1) sl(2,r)
const SUBSCRIPTED = /^([a-z]{2,6})(?:\$?[_^]\{?|_\$?\{?)?(\d{1,2})\}?\$?$/; // ads5 ads_5 ads_{5} ads$_5$
const NEQ = /^([a-z])=(\d{1,2})$/;                        // n=4

function fold(s) {
  let out = '';
  for (const ch of s) out += GREEK[ch] ?? GREEK[ch.toLowerCase()] ?? ch;
  // Strip diacritics (Schrödinger -> schrodinger) but keep the combining macron used by TT̄.
  return out.normalize('NFKD').toLowerCase()
    .replace(/tt\u0304|t\u0304t|tt\u00af/g, 'ttbar')
    .replace(/[\u0300-\u036f]/g, '');
}

function stemWord(w, variants) {
  if (PROTECTED.has(w)) return w;
  const s = stem(w);
  return variants?.[s] ?? s;
}

// Emit tokens for one chunk (a whitespace-delimited run with outer punctuation stripped).
function chunkTokens(raw, start, out, variants) {
  const c = fold(raw);
  const end = start + raw.length;
  const push = (term, s = start, e = end, joined = false) => out.push(joined ? { term, start: s, end: e, joined } : { term, start: s, end: e });

  if (TTBAR.test(c)) return push('ttbar');
  let m;
  if ((m = DIMS.exec(c))) return push(`${m[1]}+${m[2]}d`);
  if (GROUP.test(c)) return push(c);
  if ((m = NEQ.exec(c))) return push(`${m[1]}=${m[2]}`);
  if ((m = SUBSCRIPTED.exec(c)) && !/^\d+$/.test(m[1])) {
    push(stemWord(m[1], variants));
    return push(m[1] + m[2]);
  }

  // Compounds: split on / - – and emit the parts plus the joined form.
  const parts = [];
  const re = /[a-z0-9]+/g;
  while ((m = re.exec(c))) parts.push({ w: m[0], i: m.index });
  if (!parts.length) return;
  if (parts.length === 1) {
    const w = parts[0].w;
    if (/^\d+$/.test(w)) return;           // bare numbers are not indexed
    if (STOPWORDS.has(w) || w.length < 2) return;
    return push(stemWord(w, variants));
  }
  // The fold can change length (Greek -> names), so part offsets are mapped proportionally;
  // they only drive highlighting, and the joined token always covers the whole chunk.
  const scale = raw.length / c.length;
  for (const { w, i } of parts) {
    if (/^\d+$/.test(w) || STOPWORDS.has(w) || w.length < 2) continue;
    const s = start + Math.round(i * scale);
    push(stemWord(w, variants), s, Math.min(end, s + Math.round(w.length * scale)));
  }
  const joined = parts.map((p) => p.w).join('');
  // `joined` marks the compound form; a query treats it as a bonus, not a requirement.
  if (/[a-z]/.test(joined) && joined.length <= 40) push(stemWord(joined, variants), start, end, true);
}

// Outer punctuation that never belongs to a token. Parentheses are kept when they are part of
// a group name like SU(N) or (2+1)D, and stripped otherwise.
const LEAD = /^[\s"'“”‘’«»\[{<.,;:!?*•·]+/;
const TRAIL = /[\s"'“”‘’«»\]}>.,;:!?*•·]+$/;

export function tokenize(text, { variants } = {}) {
  const out = [];
  if (!text) return out;
  const re = /[^\s,;]+/g;
  let m;
  while ((m = re.exec(text))) {
    let raw = m[0];
    let start = m.index;
    const lead = LEAD.exec(raw);
    if (lead) { raw = raw.slice(lead[0].length); start += lead[0].length; }
    const trail = TRAIL.exec(raw);
    if (trail) raw = raw.slice(0, -trail[0].length);
    if (!raw) continue;
    const c = fold(raw);
    if (!GROUP.test(c) && !DIMS.test(c)) {
      // Strip unbalanced/outer parentheses: "(holography)" -> "holography".
      while (raw.startsWith('(') && !raw.includes(')', 1)) { raw = raw.slice(1); start += 1; }
      while (raw.endsWith(')') && !raw.slice(0, -1).includes('(')) raw = raw.slice(0, -1);
      if (raw.startsWith('(') && raw.endsWith(')')) { raw = raw.slice(1, -1); start += 1; }
    }
    if (raw) chunkTokens(raw, start, out, variants);
  }
  return out;
}

export const terms = (text, opts) => tokenize(text, opts).map((t) => t.term);

// Build the variant map {stem: canonicalStem} from groups of surface words.
export function buildVariants(groups = []) {
  const map = {};
  for (const g of groups) {
    const stems = [...new Set(g.map((w) => {
      const f = fold(w).replace(/[^a-z0-9]/g, ''); // hyphenated words index as their joined form
      return PROTECTED.has(f) ? f : stem(f);
    }))];
    for (const s of stems.slice(1)) map[s] = stems[0];
  }
  return map;
}
