#!/usr/bin/env node
// Build the static site into dist/:
//   dist/index.html, dist/styles.css, dist/app.js (bundled with esbuild)
//   dist/data/index.json   search index built from .out/postings.json
//   dist/data/health.json  last crawl's per-source report
// Usage: node tools/build.mjs [--postings .out/postings.json] [--health .out/health.json] [--out dist]
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildIndex, loadVariants } from '../search/build-index.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const out = opt('out', 'dist');
const postingsFile = opt('postings', '.out/postings.json');
const healthFile = opt('health', '.out/health.json');

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'data'), { recursive: true });

await build({
  entryPoints: ['site/app.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2020'],
  outfile: path.join(out, 'app.js'),
  logLevel: 'warning',
});
for (const f of ['index.html', 'styles.css']) await copyFile(path.join('site', f), path.join(out, f));

const { built, postings } = JSON.parse(await readFile(postingsFile, 'utf8'));
const idx = buildIndex(postings, { variants: await loadVariants(), built });
const json = JSON.stringify(idx);
await writeFile(path.join(out, 'data', 'index.json'), json);
try { await copyFile(healthFile, path.join(out, 'data', 'health.json')); } catch { /* optional */ }

const appSize = (await readFile(path.join(out, 'app.js'))).length;
console.error(`dist: app.js ${(appSize / 1024).toFixed(1)} KB, index ${(json.length / 1e6).toFixed(2)} MB, ${idx.n} postings`);
