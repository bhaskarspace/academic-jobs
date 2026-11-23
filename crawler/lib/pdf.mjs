// PDF adverts: fetch once per URL, extract text with poppler's pdftotext, cache the result.
//   - caps: files over PDF_MAX_BYTES are skipped (Content-Length, or counted while reading);
//     only the first PDF_MAX_PAGES pages are read. Skips are reported in health.json.
//   - Content-Type is sniffed: a handler URL without ".pdf" (IISER TVM) still works, and an HTML
//     error page served at a .pdf URL is not fed to pdftotext.
//   - image-only PDFs (scans) are flagged for OCR later (Phase 11).
//   - result notices (lists of selected or shortlisted candidates) are recognised and their text
//     is not used: it names people, not a position.
//   - legacy Hindi fonts (Kruti Dev) are dropped line by line (crawler/lib/garble.mjs).
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { dropGarbled } from './garble.mjs';
import { clean } from './text.mjs';

const run = promisify(execFile);
export const PDF_MAX_BYTES = 15 * 1024 * 1024;
export const PDF_MAX_PAGES = 10;
export const PDFS_PER_POSTING = 3;
export const PDF_FETCH_BUDGET = 120; // new PDFs per source per run
const IMAGE_ONLY_CHARS_PER_PAGE = 40;
const CACHE_VERSION = 1; // bump to re-extract every cached PDF after a change here

export const isPdf = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 1024).includes('%PDF-');

const NOTICE = /\b(?:candidates?\s+(?:selected|shortlisted|recommended)|(?:selected|shortlisted|provisionally\s+selected)\s+candidates?|list\s+of\s+(?:selected|shortlisted|eligible|qualified)|result\s+of\s+(?:the\s+)?(?:walk[- ]in|interview|written|selection)|merit\s+list|offer\s+of\s+engagement\s+has\s+been\s+sent)\b/i;

/** Is this the text of a result notice rather than an advert? (Looks at the opening only.) */
export const isResultNotice = (text) => NOTICE.test(String(text ?? '').slice(0, 1500));

/** Extract text from a PDF buffer (first maxPages pages). */
export async function pdfToText(buf, { maxPages = PDF_MAX_PAGES } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aj-pdf-'));
  try {
    const f = path.join(dir, 'a.pdf');
    await writeFile(f, buf);
    let pages = null;
    try {
      const { stdout } = await run('pdfinfo', [f], { timeout: 30_000 });
      pages = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]) || null;
    } catch { /* damaged info dictionary: pdftotext may still work */ }
    const { stdout } = await run('pdftotext', ['-f', '1', '-l', String(maxPages), '-enc', 'UTF-8', f, '-'], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    const readPages = pages ? Math.min(pages, maxPages) : null;
    return { text: stdout.replace(/\f/g, '\n'), pages, readPages };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Turn raw extracted text into what the index may use. */
export function usableText(raw) {
  const { text, dropped } = dropGarbled(clean(raw));
  return { text, garbledLines: dropped };
}

/**
 * Text of one PDF advert, fetched only the first time a URL is seen.
 * @returns {Promise<{url, text, pages?, readPages?, bytes?, imageOnly?, notice?, garbledLines?, skipped?: string}>}
 */
export async function pdfAdvert(url, { http, cache, log = () => {} }) {
  const key = `pdf:v${CACHE_VERSION}:${url}`;
  const hit = cache ? await cache.get(key) : null;
  if (hit) return hit;
  let out;
  try {
    const res = await http.get(url, { binary: true, conditional: false, maxBytes: PDF_MAX_BYTES, accept: 'application/pdf,*/*;q=0.5' });
    if (!isPdf(res.body)) {
      out = { url, text: '', skipped: `not a PDF (${(res.contentType || 'unknown type').split(';')[0]})` };
    } else {
      const { text: raw, pages, readPages } = await pdfToText(res.body);
      const { text, garbledLines } = usableText(raw);
      const imageOnly = (readPages || 1) * IMAGE_ONLY_CHARS_PER_PAGE > raw.replace(/\s+/g, '').length;
      const notice = !imageOnly && isResultNotice(text);
      out = { url, bytes: res.body.length, pages, readPages, text: notice ? '' : text, imageOnly, notice, garbledLines };
      if (pages && readPages < pages) out.truncated = `read ${readPages} of ${pages} pages`;
    }
  } catch (e) {
    if (e.code === 'TOO_LARGE') out = { url, text: '', skipped: `over ${PDF_MAX_BYTES / 1024 / 1024} MB (${(e.bytes / 1024 / 1024).toFixed(1)} MB or more)` };
    else if (e.code === 'ROBOTS_DISALLOWED') out = { url, text: '', skipped: 'robots.txt disallows' };
    else if (e.code === 'ENOENT') throw new Error('pdftotext not found: install poppler (brew install poppler / apt-get install poppler-utils)');
    else {
      log(`pdf failed ${url}: ${e.code || e.message}`);
      return { url, text: '', skipped: `fetch failed (${e.code || e.message})`, transient: true }; // not cached: retried next run
    }
  }
  if (cache) await cache.set(key, out);
  return out;
}

/**
 * Attach PDF text to a source's items: `pdfText` (all usable PDF text) and `pdfInfo` (one entry
 * per PDF, for health and flags). Skips postings whose known deadline has passed.
 * @returns {Promise<{fetched:number, skipped:Array<{url, reason}>, imageOnly:number, notices:number}>}
 */
export async function attachPdfs(items, { http, cache, log, today, budget = PDF_FETCH_BUDGET }) {
  const report = { fetched: 0, skipped: [], imageOnly: 0, notices: 0, truncated: [], deferred: 0 };
  let requests = 0;
  for (const it of items) {
    const urls = (it.pdfUrls ?? []).slice(0, PDFS_PER_POSTING);
    if (!urls.length) continue;
    if (it.deadline && it.deadline < today) continue;
    const infos = [];
    for (const url of urls) {
      const was = cache ? await cache.get(`pdf:v${CACHE_VERSION}:${url}`) : null;
      // A first crawl of a large list would fetch hundreds of PDFs: take them over several runs.
      if (!was && requests >= budget) { report.deferred++; continue; }
      const r = await pdfAdvert(url, { http, cache, log });
      if (!was) requests++;
      if (!was && !r.skipped) report.fetched++;
      if (r.skipped) report.skipped.push({ url, reason: r.skipped });
      if (r.truncated) report.truncated.push({ url, reason: r.truncated });
      if (r.imageOnly) report.imageOnly++;
      if (r.notice) report.notices++;
      infos.push({ url, pages: r.pages ?? null, imageOnly: Boolean(r.imageOnly), notice: Boolean(r.notice), skipped: r.skipped ?? null, text: r.text });
    }
    it.pdfText = infos.map((i) => i.text).filter(Boolean).join('\n\n');
    it.pdfInfo = infos.map(({ text, ...rest }) => rest);
  }
  return report;
}
