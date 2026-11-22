// Aliases tie one posting's appearances on different sources to one stable ID.
// Only URLs that identify a single posting are used; generic pages ("our jobs page") would
// wrongly merge unrelated postings.
import { canonicalUrl } from './text.mjs';

const POSTING_URL = [
  /^https:\/\/academicjobsonline\.org\/ajo\/jobs\/\d+$/,
  /^https:\/\/mathjobs\.org\/jobs\/(?:list|jobs)\/\d+$/,
  /^https:\/\/inspirehep\.net\/jobs\/\d+$/,
];

export function postingAliases(urls) {
  const out = [];
  for (const u of urls) {
    const c = canonicalUrl(u);
    if (!c) continue;
    // AJO links come as /ajo/jobs/123, /ajo/jobs/123/apply, /ajo/jobs/123?..., normalise to the job.
    const ajo = /^https:\/\/academicjobsonline\.org\/ajo\/jobs\/(\d+)/.exec(c);
    if (ajo) { out.push(`https://academicjobsonline.org/ajo/jobs/${ajo[1]}`); continue; }
    if (POSTING_URL.some((re) => re.test(c))) out.push(c);
  }
  return [...new Set(out)];
}
