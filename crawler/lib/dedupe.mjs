// Cross-source duplicate detection: the same advert posted on INSPIRE and AJO (or MathJobs) with
// different titles and URLs. Exact URL aliases are handled earlier (state.resolveId); this finds
// the rest by
//   1. institution block: the two institutions agree (config/institutions.yaml aliases, or a shared
//      distinctive word: "Universität Hamburg" / "University of Hamburg"),
//   2. deadline check: both deadlines within DEADLINE_DAYS (or both missing, with a higher bar),
//   3. description similarity: word 3-shingles over the first ~300 words; containment (shared
//      shingles / the smaller set) >= MIN_CONTAINMENT, so a trimmed copy of a longer advert counts.
// Only postings from different sources merge, and a merged group holds at most one posting per
// source (INSPIRE + AJO + MathJobs can all join). Pairs are taken best first; the score adds title
// similarity, so when one group posts several near-identical ads with one deadline (assistant /
// associate / full professor) each pairs with its own counterpart. The merge is recomputed each
// run and never rewrites IDs: the merged posting takes the ID seen first.
// Templated ads: one institution posts its standard text for different searches ("Faculty Position
// in Experimental or Theoretical Physics" / "Faculty Position in Mathematics"). When both titles
// name a subject and the subjects share no word, the texts must be near-identical
// (MIN_CONTAINMENT_SUBJECTS_DIFFER). A title that names no subject ("Three Postdoc Positions")
// doesn't block.
export const SHINGLE = 3;
export const SHINGLE_WORDS = 300;
export const MIN_SHINGLES = 15;
export const MIN_CONTAINMENT = 0.5;
export const MIN_CONTAINMENT_NO_DEADLINE = 0.8;
export const DEADLINE_DAYS = 3;
export const TITLE_WEIGHT = 0.3;
export const MIN_CONTAINMENT_SUBJECTS_DIFFER = 0.9;
// Job words, ranks, counts and connectives: what's left in a title is its subject.
const TITLE_GENERIC = new Set(('position positions post posts postdoc postdocs postdoctoral doctoral research researcher researchers ' +
  'associate associates assistant assistants professor professors professorship lecturer lecturers senior junior faculty fellow fellows ' +
  'fellowship fellowships scholar scholars scientist scientists staff tenure track tenured non regular open rank full visiting ' +
  'teaching program programme call calls opening openings vacancy vacancies job jobs hire hiring prize award one two three four five ' +
  'several multiple various new 2025 2026 2027 2028 and the for with from in at of on or to an a phd student students fall spring year years').split(' '));
export const titleSubject = (t) => new Set(words(t).filter((w) => w.length > 2 && !TITLE_GENERIC.has(w)));

const titleSet = (t) => new Set(words(t).filter((w) => w.length > 2));
export function jaccard(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n || 1);
}

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (t) => fold(t).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);

export function shingles(text) {
  const w = words(text).slice(0, SHINGLE_WORDS);
  const s = new Set();
  for (let i = 0; i + SHINGLE <= w.length; i++) s.add(w.slice(i, i + SHINGLE).join(' '));
  return s;
}

export function containment(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const x of small) if (big.has(x)) n++;
  return n / small.size;
}

const GENERIC = new Set(('university universitat universite universita universidad universiteit college institute institut instituto ' +
  'inst school department dept faculty center centre laboratory lab national research science sciences physics physical ' +
  'theoretical theory mathematics mathematical math applied advanced studies study main and the of for at de der des la le di ' +
  'u univ coll technology technical state royal academy chinese new').split(' '));

/** Institution matcher built from the alias table. */
export function makeInstitutionKey(aliases = {}) {
  const map = new Map();
  const norm = (s) => words(s).join(' ');
  for (const [canon, vs] of Object.entries(aliases)) for (const v of [canon, ...vs]) map.set(norm(v), norm(canon));
  // One posting can list several institutions ("A; B"); each yields a key and distinctive words.
  return (inst) => {
    const keys = new Set();
    const toks = new Set();
    for (const part of String(inst ?? '').split(';')) {
      const whole = norm(part);
      const head = norm(part.split(',')[0]);
      const k = map.get(whole) ?? map.get(head) ?? head;
      if (!k) continue;
      keys.add(k);
      for (const w of [...k.split(' '), ...head.split(' ')]) if (w.length >= 4 && !GENERIC.has(w)) toks.add(w);
    }
    return { keys, toks };
  };
}

const overlap = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
export const sameInstitution = (a, b) => overlap(a.keys, b.keys) || overlap(a.toks, b.toks);

/**
 * @param {Array<{id, sources:[{source, sourceId}], institution, deadline, body}>} postings
 * @returns {Array<{keep, drop, score}>}  pairs to merge (keep = earlier firstSeen, else smaller id)
 */
export function findDuplicates(postings, { aliases = {}, notDuplicates = [] } = {}) {
  const instKey = makeInstitutionKey(aliases);
  const blocked = new Set(notDuplicates.map(([a, b]) => [a, b].sort().join('|')));
  const rows = postings.map((p) => ({
    p, srcs: new Set(p.sources.map((s) => s.source)), ids: p.sources.map((s) => s.sourceId),
    inst: instKey([p.institution, p.institutionAlt].filter(Boolean).join('; ')) /* plus the INSPIRE ICN */, sh: shingles(p.body ?? ''), tt: titleSet(p.title), subj: titleSubject(p.title), day: p.deadline ? Date.parse(p.deadline) / 86_400_000 : null,
  }));
  // Candidate pairs come from shared distinctive words or keys (cheap blocking).
  const byTok = new Map();
  rows.forEach((r, i) => { for (const t of [...r.inst.keys, ...r.inst.toks]) { if (!byTok.has(t)) byTok.set(t, []); byTok.get(t).push(i); } });
  const seen = new Set();
  const cands = [];
  for (const list of byTok.values()) {
    if (list.length > 400) continue; // a word shared by hundreds of postings is not distinctive
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const [i, j] = [list[x], list[y]];
      const k = `${i},${j}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const a = rows[i];
      const b = rows[j];
      if (overlap(a.srcs, b.srcs)) continue;
      if (a.ids.some((ia) => b.ids.some((ib) => blocked.has([ia, ib].sort().join('|'))))) continue;
      if ((a.day == null) !== (b.day == null)) continue;
      if (a.day != null && Math.abs(a.day - b.day) > DEADLINE_DAYS) continue;
      if (a.sh.size < MIN_SHINGLES || b.sh.size < MIN_SHINGLES) continue;
      const c = containment(a.sh, b.sh);
      if (c < (a.day == null ? MIN_CONTAINMENT_NO_DEADLINE : MIN_CONTAINMENT)) continue;
      if (a.subj.size && b.subj.size && !overlap(a.subj, b.subj) && c < MIN_CONTAINMENT_SUBJECTS_DIFFER) continue;
      cands.push({ i, j, c, score: c + TITLE_WEIGHT * jaccard(a.tt, b.tt) });
    }
  }
  cands.sort((u, v) => v.score - u.score);
  // Union-find over rows; a union is allowed only while the two groups share no source.
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const srcOf = rows.map((r) => new Set(r.srcs));
  const out = [];
  for (const { i, j, c } of cands) {
    const [ri, rj] = [find(i), find(j)];
    if (ri === rj || overlap(srcOf[ri], srcOf[rj])) continue;
    const [a, b] = [rows[ri].p, rows[rj].p];
    const first = (a.firstSeen ?? '') < (b.firstSeen ?? '') || ((a.firstSeen ?? '') === (b.firstSeen ?? '') && a.id < b.id);
    const [keep, drop] = first ? [ri, rj] : [rj, ri];
    parent[drop] = keep;
    for (const s of srcOf[drop]) srcOf[keep].add(s);
    out.push({ keep: rows[keep].p.id, drop: rows[drop].p.id, score: Math.round(c * 100) / 100, titles: [rows[i].p.title, rows[j].p.title] });
  }
  return out;
}
