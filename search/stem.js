// Porter2 ("English" Snowball) stemmer.
// Shared by the index build (Node) and the search page (browser): both sides must stem identically.
// Reference: https://snowballstem.org/algorithms/english/stemmer.html

const V = 'aeiouy';
const isV = (c) => V.includes(c);
const DOUBLES = ['bb', 'dd', 'ff', 'gg', 'mm', 'nn', 'pp', 'rr', 'tt'];
const LI_END = 'cdeghkmnrt';

const EXCEPTIONS = {
  skis: 'ski', skies: 'sky', dying: 'die', lying: 'lie', tying: 'tie',
  idly: 'idl', gently: 'gentl', ugly: 'ugli', early: 'earli', only: 'onli', singly: 'singl',
  sky: 'sky', news: 'news', howe: 'howe', atlas: 'atlas', cosmos: 'cosmos', bias: 'bias', andes: 'andes',
};
const POST_1A = new Set(['inning', 'outing', 'canning', 'herring', 'earring', 'proceed', 'exceed', 'succeed']);

function regions(w) {
  let r1 = w.length;
  const m = /^(gener|commun|arsen)/.exec(w);
  if (m) r1 = m[0].length;
  else {
    for (let i = 1; i < w.length; i++) if (!isV(w[i]) && isV(w[i - 1])) { r1 = i + 1; break; }
  }
  let r2 = w.length;
  for (let i = r1 + 1; i < w.length; i++) if (!isV(w[i]) && isV(w[i - 1])) { r2 = i + 1; break; }
  return [r1, r2];
}

// Short syllable ending at the end of `w`.
function endsShortSyllable(w) {
  const n = w.length;
  if (n === 2) return isV(w[0]) && !isV(w[1]);
  if (n < 3) return false;
  const [a, b, c] = [w[n - 3], w[n - 2], w[n - 1]];
  return !isV(a) && isV(b) && !isV(c) && !'wxY'.includes(c);
}
const isShort = (w) => regions(w)[0] >= w.length && endsShortSyllable(w);

const hasVowel = (s) => /[aeiouy]/.test(s);

export function stem(word) {
  let w = word;
  if (w.length <= 2) return w;
  if (EXCEPTIONS[w]) return EXCEPTIONS[w];
  if (w[0] === "'") w = w.slice(1);
  // Mark consonant-y.
  w = w.replace(/^y/, 'Y').replace(/([aeiouy])y/g, '$1Y');
  const [r1, r2] = regions(w);
  const inR1 = (suf) => w.length - suf.length >= r1;
  const inR2 = (suf) => w.length - suf.length >= r2;

  // Step 0
  w = w.replace(/('s'|'s|')$/, '');

  // Step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (/(ied|ies)$/.test(w)) w = w.length > 4 ? w.slice(0, -2) : w.slice(0, -1);
  else if (w.endsWith('us') || w.endsWith('ss')) { /* nothing */ }
  else if (w.endsWith('s') && hasVowel(w.slice(0, -2))) w = w.slice(0, -1);

  if (POST_1A.has(w)) return w;

  // Step 1b
  let m;
  if ((m = /(eedly|eed)$/.exec(w))) {
    if (inR1(m[1])) w = w.slice(0, -m[1].length) + 'ee';
  } else if ((m = /(ingly|edly|ing|ed)$/.exec(w))) {
    const stemPart = w.slice(0, -m[1].length);
    if (hasVowel(stemPart)) {
      w = stemPart;
      if (/(at|bl|iz)$/.test(w)) w += 'e';
      else if (DOUBLES.some((d) => w.endsWith(d))) w = w.slice(0, -1);
      else if (isShort(w)) w += 'e';
    }
  }

  // Step 1c
  if (w.length > 2 && /[yY]$/.test(w) && !isV(w[w.length - 2])) w = w.slice(0, -1) + 'i';

  // Step 2
  const S2 = [
    ['ization', 'ize'], ['ational', 'ate'], ['fulness', 'ful'], ['ousness', 'ous'], ['iveness', 'ive'],
    ['tional', 'tion'], ['biliti', 'ble'], ['lessli', 'less'], ['entli', 'ent'], ['ation', 'ate'],
    ['alism', 'al'], ['aliti', 'al'], ['ousli', 'ous'], ['iviti', 'ive'], ['fulli', 'ful'],
    ['enci', 'ence'], ['anci', 'ance'], ['abli', 'able'], ['izer', 'ize'], ['ator', 'ate'],
    ['alli', 'al'], ['bli', 'ble'], ['ogi', 'og'], ['li', ''],
  ];
  for (const [suf, rep] of S2) {
    if (!w.endsWith(suf)) continue;
    if (inR1(suf)) {
      if (suf === 'ogi') { if (w[w.length - 4] === 'l') w = w.slice(0, -3) + rep; }
      else if (suf === 'li') { if (LI_END.includes(w[w.length - 3])) w = w.slice(0, -2); }
      else w = w.slice(0, -suf.length) + rep;
    }
    break;
  }

  // Step 3
  const S3 = [
    ['ational', 'ate'], ['tional', 'tion'], ['alize', 'al'], ['icate', 'ic'], ['iciti', 'ic'],
    ['ative', ''], ['ical', 'ic'], ['ness', ''], ['ful', ''],
  ];
  for (const [suf, rep] of S3) {
    if (!w.endsWith(suf)) continue;
    if (inR1(suf) && (suf !== 'ative' || inR2(suf))) w = w.slice(0, -suf.length) + rep;
    break;
  }

  // Step 4
  const S4 = ['ement', 'ance', 'ence', 'able', 'ible', 'ment', 'ant', 'ent', 'ism', 'ate', 'iti', 'ous',
    'ive', 'ize', 'ion', 'al', 'er', 'ic'];
  for (const suf of S4) {
    if (!w.endsWith(suf)) continue;
    if (inR2(suf)) {
      if (suf === 'ion') { if (/[st]$/.test(w.slice(0, -3))) w = w.slice(0, -3); }
      else w = w.slice(0, -suf.length);
    }
    break;
  }

  // Step 5
  if (w.endsWith('e')) {
    const base = w.slice(0, -1);
    if (inR2('e') || (inR1('e') && !endsShortSyllable(base))) w = base;
  } else if (w.endsWith('ll') && inR2('l')) w = w.slice(0, -1);

  return w.replace(/Y/g, 'y');
}
