#!/usr/bin/env node
// Guard: fail if email addresses appear in test fixtures or in the built public index.
//   node tools/check-emails.mjs --fixtures tests/fixtures
//   node tools/check-emails.mjs --index dist/data/index.json [--postings .out/postings.json]
// Fixtures: any address, raw (a@b.org), URL-encoded (a%40b.org) or "a [at] b.org", other than
// placeholder@example.org. The repo is public, and INSPIRE's terms forbid bulk email collection.
// Index: raw addresses anywhere in the JSON, and index terms holding an address with its
// punctuation stripped (adarshpatrigmailcom). With --postings, every address in the crawled text
// is stripped and looked for among the terms; without it, a pattern for common mail domains is used.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLACEHOLDER = 'placeholder@example.org';
const EMAIL = /[A-Za-z0-9._%+-]+(?:@|%40|\s?[[(]at[\])]\s?)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi;
// Stripped addresses at common mail domains: ...gmailcom, ...iiserpuneacin, ...cuhkeducn
const STRIPPED = /^[a-z0-9]{5,}(?:(?:gmail|googlemail|yahoo|hotmail|outlook|icloud|protonmail|qq|163|126)(?:com|co|in|cn)|ac(?:in|uk|cn|jp|kr|il|za|nz|at|be)|edu(?:cn|au|in|hk|tw|sg|pl))$/;

const isPlaceholder = (m) => /placeholder(@|%40)example\.org$/i.test(m);

/** Email-like strings in a text, placeholders excluded. */
export function findEmails(text) {
  return [...String(text).matchAll(EMAIL)].map((m) => m[0]).filter((m) => !isPlaceholder(m));
}

export const strip = (email) => email.toLowerCase().replace(/%40/g, '@').replace(/[^a-z0-9]/g, '');

/** Problems in a built index: raw addresses, and terms that are stripped addresses. */
export function indexLeaks(idx, { postings } = {}) {
  const leaks = findEmails(JSON.stringify(idx)).map((e) => `raw address in index: ${e}`);
  const terms = Object.keys(idx.index ?? {});
  if (postings) {
    const stripped = new Set();
    for (const p of postings) for (const e of findEmails([p.title, p.body, p.snippet].join(' '))) stripped.add(strip(e));
    for (const t of terms) for (const s of stripped) if (s.length >= 8 && t.includes(s)) leaks.push(`term ${t} holds ${s}`);
  }
  for (const t of terms) if (STRIPPED.test(t)) leaks.push(`term ${t} looks like a stripped address`);
  return [...new Set(leaks)];
}

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

export async function fixtureLeaks(dir) {
  const leaks = [];
  for await (const f of walk(dir)) {
    const text = await readFile(f, 'utf8').catch(() => '');
    for (const e of findEmails(text)) leaks.push(`${f}: ${e}`);
  }
  return leaks;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const leaks = [];
  if (opt('fixtures')) leaks.push(...await fixtureLeaks(opt('fixtures')));
  if (opt('index')) {
    const idx = JSON.parse(await readFile(opt('index'), 'utf8'));
    const postings = opt('postings') ? JSON.parse(await readFile(opt('postings'), 'utf8')).postings : undefined;
    leaks.push(...indexLeaks(idx, { postings }));
  }
  if (!opt('fixtures') && !opt('index')) { console.error('pass --fixtures DIR and/or --index FILE'); process.exit(2); }
  for (const l of leaks.slice(0, 50)) console.error(l);
  console.error(leaks.length ? `${leaks.length} email address(es) found; replace them with ${PLACEHOLDER}` : 'no email addresses found');
  process.exitCode = leaks.length ? 1 : 0;
}
