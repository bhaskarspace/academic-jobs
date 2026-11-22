// Does a title name a research subject? Used to pick a merged posting's title: a title that names
// a subject ("Postdoctoral Research Associate in Mathematical Physics") beats one that doesn't
// ("Three Postdoc Positions"). A subject is any config/fields.yaml pattern or any concept-file
// term (concepts/physics.yaml), matched with the same tokenizer as the index.
import { tokenize } from './tokenize.js';
import { compileConcepts, makePhraseMatcher, phraseList } from './concepts.js';

export function makeSubjectTest({ fields = {}, concepts = {}, variants = {} } = {}) {
  const rules = (fields.rules ?? []).map((r) => new RegExp(r.pattern, 'i'));
  const compiled = compileConcepts(concepts, variants);
  const keys = new Set();
  for (const c of Object.values(compiled)) for (const e of [...c.query, ...c.members]) keys.add(e.key);
  const phrases = makePhraseMatcher(phraseList(compiled));
  return (title) => {
    const t = String(title ?? '');
    if (rules.some((re) => re.test(t))) return true;
    const toks = tokenize(t, { variants });
    return [...toks, ...phrases(toks)].some((x) => keys.has(x.term));
  };
}
