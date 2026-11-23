<!-- Status: plan approved 2026-11-22 with amendments to Phases 1 and 2 (folded in below). Phase 1 shipped 2026-11-22 (PRs #1, #2). Phase 2 shipped 2026-11-22 (PR #4; email hotfix #3). Phase 3 shipped 2026-11-22 (PR #6). Phase 4 shipped 2026-11-22 (PR #7). Phase 5 shipped 2026-11-23 (PR #8). Phase 6 in review. Update this line as phases land. -->

# Academic job search on codebpr.com/academic-jobs/: plan

## Context
Finding a theory postdoc today means checking INSPIRE, AJO, MathJobs and a dozen other boards, plus the recruitment pages of about 60 Indian institutes. Many of those institute ads exist only as PDFs. This tool collects all of them on a schedule into one schema, and a static page searches them in the browser by research concept rather than literal substring. A search for "chaos" should find OTOC, scrambling, RMT and MBL postdocs in both hep-th and cond-mat groups.

The site is static (GitHub Pages project site, the same pattern as `../moksha-patam`), and collection runs in GitHub Actions. **No backend is needed.** The only piece that might need to run somewhere other than Actions is crawling Indian sites, if GitHub's runners can't reach them. The fallback for that is your Mac (launchd), which pushes results to a branch. That fallback costs nothing to host.

Decisions already made with you:
- The User-Agent is `academic-jobs/0.1 (+https://github.com/bhaskarspace/academic-jobs/issues)`. No email address goes in it.
- robots.txt is obeyed strictly.
  - A site that disallows everything becomes a "check this page" link-out.
  - Where only PDFs are disallowed, the crawler indexes the list-page text and links to the PDF without fetching it.
  - A per-source `permission:` field (with the date and the webmaster's reply) overrides robots.txt only after written consent.

## What the audits found (2026-11-22, run from your Mac)
- **Three boards give clean, open data: INSPIRE, AJO and MathJobs.** Together that's about 2,500 open postings.
- **EURAXESS can't be included.** Its WAF returns 403 for any query or RSS URL, and it has no API. It becomes a link-out.
- **jobs.ac.uk's subject RSS feeds are gone (404).** It's also link-out only.
- **Physics Today and APS have working RSS, but their ToS forbid automated harvesting.** Nature Careers' robots.txt disallows `/jobsrss/`. All three become link-outs.
- **AcademicPositions, FindAPostDoc, FindAPhD, HigherEdJobs, Indeed and LinkedIn are behind Cloudflare/Imperva or forbid scraping.** They become link-outs or are excluded.
- **Many institute postdoc programmes already post through AJO** (Perimeter, ICTS, KIAS, YMSC, YITP and the Joint European HEP postdoc). AJO also has the Condensed Matter and QCMT subjects, so cond-mat coverage comes mainly from AJO, not INSPIRE (INSPIRE has only 32 cond-mat postings).
- **The total index is small, roughly 3–6k documents.** That shapes the search design below.

## Source audit

### Job boards
| Source | Access | robots / ToS | Fields | Category mapping | Volume (open) | Verdict |
|---|---|---|---|---|---|---|
| INSPIRE-HEP | REST `inspirehep.net/api/jobs?q=status:open&sort=mostrecent&size=…`; `/api/jobs/facets` | Job paths allowed. Metadata is CC0. Limit 15 requests per 5 s. Bulk email collection is forbidden, so drop `contact_details` | position, institutions, deadline_date, arxiv_categories, ranks, regions (no country), description HTML, urls | ranks: PHD → phd; POSTDOC → postdoc; JUNIOR/SENIOR/STAFF → faculty; VISITOR, MASTER → other (high confidence) | 388 (hep-th 168, math-ph 43, cond-mat 32) | **Include** |
| AcademicJobsOnline | JSON `academicjobsonline.org/ajo/public_job_boards?limit=500&page=N` (gzip) | Crawl-delay 5. `/ajo` allowed. No ToS found; the feed invites reuse | name, univ, unit, subject, type, country/city, open/close/deadline, description, qualifications, url | type: Postdoctoral → postdoc; TT/NTT faculty → faculty; Fellowship or award → fellowship; Student programs → phd (check the title). `deadline_raw` is often `0000-00-00`, so fall back to `close_date` | 1,109 (about 460 physics-ish) | **Include** |
| MathJobs (AMS) | JSON `mathjobs.org/jobs/public_job_boards?…` (same software) | Same as AJO | Same as AJO | Same as AJO. Validate `type`: 20 records say "BEGIN" | about 1,007 | **Include** |
| EURAXESS | HTML only; any query string returns 403 | Content is CC BY 4.0, but the WAF blocks access | (R1–R4 profile on job pages) | R1 → phd, R2 → postdoc, R3/R4 → faculty | Unmeasurable | **Link-out** `euraxess.ec.europa.eu/jobs/search?keywords={q}` |
| jobs.ac.uk | HTML only; RSS is 404 | ToS behind a bot challenge | n/a | n/a | About 700 physics jobs (unverified) | **Link-out** `jobs.ac.uk/search/?keywords={q}` |
| Physics Today / APS | Madgex RSS works | ToS forbid automated harvesting | Thin: title, blurb, date | n/a | PT 6.7k total | **Link-out** (one each) |
| Nature Careers | Madgex RSS | robots.txt disallows `/jobsrss/` | n/a | n/a | About 375 physics | **Link-out** `/naturecareers/jobs/?keywords={q}` |
| Times Higher Ed Unijobs | Madgex RSS works and robots.txt allows it | ToS not yet read | Thin | Title heuristic | About 300 physics | **Link-out** for now; reconsider in phase 4 after reading the ToS |
| AcademicPositions, FindAPostDoc, FindAPhD | Cloudflare 403 | n/a | n/a | n/a | n/a | **Link-out** |
| ICTP, EMS, physics rumor mill | Timed out | n/a | n/a | n/a | Few | **Static link** |
| HigherEdJobs, Indeed, LinkedIn, AMS EIMS, ScholarshipDb | Bot wall, or ToS forbid scraping | n/a | n/a | n/a | n/a | **Exclude** |

### Indian institutes
Every institute's posting fields are title, a posted date and/or last date, and a PDF link. Category comes from the title regex with medium confidence, or from text found only in the PDF with low confidence (see Normalisation).

| Group | Include (static HTML, robots OK) | Partial (list page only, PDF not fetched) | Link-out (robots `Disallow: /`, WAF or JS-only for now) | Volume |
|---|---|---|---|---|
| **IISERs** | Pune (phase 1). Kolkata: table, `DD.MM.YYYY`, encrypted IDs, so key on PDF URL + title. Mohali: Joomla RSS `?format=feed&type=rss`. TVM: `table.data_table` with ISO dates, paginated. Berhampur: table per advert | Bhopal (`/assets/*` disallowed) | Tirupati: AJAX list; the JS phase may recover it | Pune about 216 rows, Berhampur 86 PDFs |
| **Research institutes** | IISc, ICTS (crawl-delay 10), IMSc (crawl-delay 10, 125 PDFs), IOP (RSS `/feed/?post_type=job_opening`), SINP (236-row table), RRI, S.N. Bose (ISO-8859-1), IACS (483-row table), IUCAA, TIFR-H (RSS), NCRA, CMI, ISI Kolkata, ISI Bangalore, ARIES (very slow; one request hung 18 minutes, so it needs hard timeouts), NCBS | NISER (`/storage/` disallowed), JNCASR (`/sites/default/files/` disallowed), IIA (`*.pdf` disallowed) | TIFR Mumbai, HRI and IPR (`Disallow: /`). PRL: robots.txt itself returns 403; treat as link-out until clarified | IACS, SINP, PRL and IMSc each 100–500 PDFs |
| **IITs** (23) | KGP, B, M (crawl-delay 10), K, D, G, R (URL-encode paths with spaces), BBS (www only), H, J, Indore, Mandi, BHU, Palakkad, ISM, Goa (RSS), Dharwad | Patna (`*.pdf` disallowed, Next.js) | Gandhinagar (Cloudflare). Ropar, Tirupati and Jammu (JS SPAs; JS phase). Bhilai (redirects to an error page) | Varies |
| Suggested additions | TIFR-H, NCBS, CMI, ISI Kolkata/Bangalore, IIA, ARIES, NCRA (all above); later: IMSc-affiliated HBNI, which is HTTP only | | | |

Problems the crawler has to handle (all were seen in the audit):
- Bare hosts with bad certificates (`iitkgp`, `iitbbs`), so always use the `www.` host.
- Intermittent connection failures on the first request (KGP, IITB), so retry.
- Hung connections (ARIES), so use a connect timeout, a total timeout and a per-source watchdog.
- Spaces and `&` in PDF URLs.
- Bilingual Hindi/English titles: decode the HTML entities and keep the English after ` / `.
- Several date formats: `Nov 27, 2026`, `DD.MM.YYYY`, ISO, `01 Dec 2026, 05:00 PM`, and free-text walk-in dates.
- PDF handler URLs without a `.pdf` extension (TVM), so sniff the Content-Type.

All of the above was tested from your Mac. **Whether GitHub runners can reach these sites is still unknown, and it's the first task of Phase 1.**

## Architecture
```
GitHub Actions (cron 00:47 UTC daily = 06:17 IST, off the busy :00/:30 slots; plus workflow_dispatch;
                concurrency group `crawl`, so a dispatched run never overlaps the cron run)
  crawl: registry → adapters → raw items      (polite HTTP, robots, cache)
  normalise → categorise → extract dates → dedupe/merge → status
  build index (inverted index + display records) → site/dist
  write health.json; open/close issues on zero-streaks
  push state to `state` branch (single force-pushed commit)
  upload-pages-artifact → deploy-pages        (no data in main history)
[fallback] Mac launchd job: crawls hosts flagged `runner: mac`, pushes to `inbox-mac` branch;
           Actions merges inbox-mac on its next run.
Browser: index.html + app.js (~20 KB) fetch data/index.json(.gz by Pages) → search locally
```

**Stack.** Node 22 ESM, which is moksha-patam's weight class. I'm not adding Python.
- Dependencies:
  - `cheerio` to parse HTML.
  - `fast-xml-parser` for RSS.
  - `robots-parser`.
  - `yaml` for the config and concept files, because YAML allows comments, which you need while curating.
  - `esbuild` to bundle the frontend.
  - `playwright`, added only in the JS-sites phase.
- PDF text comes from poppler's `pdftotext`. It's an apt package on runners and a brew package on the Mac, and it's faster and more robust than pdf.js.
- Tests use `node --test`. Smoke tests use Playwright, as in moksha-patam.
- The frontend is vanilla JS with no framework, bundled into one `app.js`.
- There's one shared `stem.js` (a Porter2 implementation) used both at build time and in the browser, so their tokens always agree.

**Pages.** The repo is public, and Pages is set to deploy from GitHub Actions. That's a different setting from moksha-patam, which serves `main` from `/` with the legacy build. The user site's CNAME automatically makes the project site available at `codebpr.com/academic-jobs/`.

**Persistent state: a `state` branch, rewritten as a single orphan commit each run.**
- The state is the seen-ID map with first-seen and last-seen dates, the per-page link sets used for change detection, ETag/Last-Modified values, zero-run streaks and `health-history.json`. All of it is a few hundred KB.
- Options I considered and rejected:
  - Committing data to `main`, which bloats its history.
  - Actions cache alone, which is evicted after 7 days without use.
  - Workflow artifacts alone, which expire after 90 days.
  - Reading state back from the live site, which is fragile: a bad deploy would lose first-seen dates.
- The run aborts before deploying if it can't read the state branch. It never resets state silently.
- Every run also uploads the state files as a workflow artifact (`state-<run id>`, 90-day retention), so there are rolling snapshots and one buggy run can't overwrite the only copy.
- `crawl.yml` has `concurrency: { group: crawl, cancel-in-progress: false }`, so runs queue rather than race on the state branch.
- The extracted PDF text cache lives in the Actions cache. Losing it only costs refetching.

**The 60-day scheduled-workflow rule.**
- Each run calls `PUT /repos/{repo}/actions/workflows/{id}/enable` with `actions: write`.
- The daily push to `state` also counts as repository activity.
- The status page shows the last run time, so you'll notice if runs stop.

**Search index and copyright trade-off.**
- I recommend a prebuilt inverted index plus display records. The full text is not shipped.
  - Each display record holds the title, institution, country, category, fields, dates, sources, URL and a snippet of at most 240 characters.
  - The index maps each stemmed term (or concept ID) to a list of `[doc, fieldMask, tf]`, with no word positions. Without positions the text can't be reconstructed.
- What this costs:
  - No phrase queries. Multi-word concepts from the concept file ("random matrix", "many-body localization") are indexed as single tokens at build time, which covers the cases that matter.
  - Highlighting only works on the title and snippet. For hidden text the UI shows "matched: *Lyapunov*, *OTOC* (in ad text / PDF)", which still tells you why a job came up.
- Size: about 5k docs × about 150 terms (pruned by tf-idf, keeping every title term and every concept hit) comes to roughly 0.8M postings. Delta-encoded, that's about 1.5 MB raw and about 500 KB gzipped. One file is fine at this volume, and I'll shard by category if it grows past about 2 MB gzipped.

**HTTP etiquette (`crawler/lib/http.mjs`).**
- Requests carry the UA above.
- robots.txt is checked before every path, and its crawl-delay is honoured.
- Each host gets at most one request every 2 s by default, with crawl-delay raising that. Different hosts run concurrently.
- Requests use ETag/If-Modified-Since. On a 304 the cached parse is reused.
- Timeouts are 10 s to connect and 45 s in total, and each source is killed after 5 minutes.
- Failed requests are retried twice with backoff.
- `tls: insecure` is allowed only in a source's config, with a reason, and it's shown in the health report.
- Detail pages and PDFs are fetched only for links not seen before. Known items are just re-checked to update last-seen.

## Normalisation
`Posting` schema:
- `id`: assigned once, at first sight, as a hash of the first URL seen, and stored in state with an alias map (every source URL and source ID → id). Later sightings and merges resolve through the aliases, so the ID never changes when the canonical URL does (for example when INSPIRE picks up an AJO ad). That keeps `firstSeen` and "new since your last visit" stable. When two existing IDs merge, the older one wins and the other becomes an alias.
- `sources[]`: each entry has `{source, url, sourceId}`.
- `url`: the canonical URL.
- `title`, `institution`, `country`.
- `categories`: a set of `{category, confidence}` entries, where category is phd, postdoc, faculty, fellowship or other and confidence is high, medium or low. It's a set because INSPIRE `ranks` is a list (POSTDOC + JUNIOR is common), AJO has "Postdoctoral or Fellowship", and Indian adverts often bundle JRF/SRF/RA in one PDF. The category filter matches if any entry matches.
- `fields[]`: arXiv-style tags such as hep-th, cond-mat or math-ph.
- `posted`, `deadline`, `firstSeen`, `lastSeen`.
- `status`: open, expired, no-deadline or gone-from-source.
- `matchText` (build-time only, never shipped) and `snippet`.

How each part is computed:
- **Category** comes from `config/categories.yaml`.
  - Source-structured mappings come first and give high confidence.
  - Title regexes come next and give medium confidence:
    - JRF/SRF, PhD, Integrated PhD → phd.
    - RA, PDF, NPDF, Post-doctoral, Research Associate → postdoc.
    - Assistant/Associate Professor (Grade I/II), Faculty → faculty.
    - Fellowship, Ramanujan, INSPIRE Faculty → fellowship.
    - Project Assistant/Associate, Project Scientist → other, unless the text says "PhD registration".
  - Body or PDF text comes last and gives low confidence.
  - Every rule that fires adds an entry; nothing overwrites. The UI shows a "category guessed" marker on any entry with medium or low confidence.
- **Fields** come from INSPIRE `arxiv_categories`, the AJO subject (through a mapping table), and concept-file hits (each concept carries default fields).
- **Deadlines** come from a date-extraction module covering the formats listed in the audit. When an ad has several dates, the one near "last date" or "deadline" wins.
  - Past the deadline means expired, which is hidden by default and shown with a toggle.
  - No deadline found gives a `no-deadline` flag. A posting first seen more than 120 days ago gets an extra "possibly stale" tag. Nothing is ever deleted.
- **Dedupe** works in two steps.
  1. Exact canonical-URL match. This includes INSPIRE `urls[]` and `reference_letters` pointing at AJO, and the AJO id.
  2. Otherwise, block by normalised institution (from an alias table in `config/institutions.yaml`), then merge when title token Jaccard is at least 0.8 and the deadlines are within 3 days.
  - A merged posting keeps every source, and the most structured source supplies each field.

## Matching
- **v1 (lexical).** Tokenize, stem, drop stopwords, then BM25F with field weights: title 3, fields/subject 2, snippet and description 1, PDF text 0.7.
  - `concepts/physics.yaml` defines concepts, for example `chaos: [chaos, chaotic, scrambling, OTOC, out-of-time-order, Lyapunov, random matrix, spectral form factor, thermalization, ETH, many-body localization, MBL, nonlinear dynamics, …]`, plus default fields and sub-concepts.
  - At build time every concept hit becomes a `concept:chaos` token.
  - At query time "chaos" expands to the concept token plus its member terms, with an exact hit ranked slightly above an expanded one.
  - The UI shows the matched terms, highlights them in the title and snippet, and puts a "matched via concept *chaos*" chip on the result.
  - Filters are category (primary), field facets (secondary), country, and whether to include expired postings. Sorting is by relevance, deadline or newest. A "new since your last visit" badge uses localStorage.
  - Link-out row: "Also search EURAXESS · jobs.ac.uk · Physics Today · APS · Nature · AcademicPositions · FindAPostDoc/FindAPhD · THE" with the query filled in. Static links cover TIFR, HRI, IPR, ICTP and the rest.
- **Later (semantic, test before committing).** Build a labelled set of about 40 queries × relevant postings (I draft it, you correct it). Measure v1's P@10 and recall@50, then try embeddings: bge-small or MiniLM computed at build time with transformers.js, and the query embedded in the browser.
  - The browser side costs about 25 MB of model download (cached) plus about 1.5 MB of vectors for 5k docs.
  - Ship it only if recall@50 improves by at least 10 points over v1+concepts. If the gain is smaller, a cheaper variant gets the same evaluation: build-time embedding similarity used only to suggest new concept-file terms for you to approve.

## Repo layout
```
config/sources.yaml          registry: one entry per source/page {id, adapter, url(s), institution, country,
                             runner: actions|mac, robots override `permission:`, tls, crawlDelay, parse hints}
config/categories.yaml       category rules;  config/institutions.yaml  aliases
config/linkouts.yaml         link-out boards + static links
concepts/physics.yaml        editable concept/synonym file
crawler/run.mjs              CLI: --source <id> | --all | --runner mac  [--dry] [--no-cache]
crawler/adapters/            inspire.mjs, ajo.mjs (AJO+MathJobs), rss.mjs, html-list.mjs (selector-driven),
                             html-table.mjs, wp-json.mjs, (later) js-rendered.mjs
crawler/lib/                 http.mjs, robots.mjs, pdf.mjs, dates.mjs, normalize.mjs, categorize.mjs,
                             dedupe.mjs, changes.mjs, state.mjs, health.mjs
search/                      stem.js, tokenize.js, concepts.js, build-index.mjs, query.js (shared with site)
site/                        index.html, app.js, styles.css, status.html, status.js
tools/                       probe.mjs (reachability), build.mjs (esbuild → dist/), eval.mjs (labelled set)
tests/                       *.test.mjs + fixtures/ (saved HTML/JSON/PDF per adapter)
docs/AUDIT.md                the source audit table (kept current)
.github/workflows/           crawl.yml (cron+dispatch: crawl→build→deploy), ci.yml (PR tests), probe.yml
mac/                         launchd plist + run-mac.sh (only if the probe requires it)
PLAN.md, CLAUDE.md, README.md
```
Adding a source means one entry in `sources.yaml`, plus a fixture and a test. A new adapter is needed only for a genuinely new kind of page.

## Phases (one PR each)

1. **Thin end-to-end slice.**
   - **First step: the reachability probe.** `probe.yml` runs `tools/probe.mjs` over every institute URL from the audit, from the Actions runner. It records status, time, TLS and robots for each URL in `docs/AUDIT.md` (runner column next to the Mac column).
     - If IISER Pune is unreachable from Actions, the slice uses a reachable IISER (Berhampur or TVM).
     - If every Indian site is blocked, Phase 1 also ships the `inbox-mac` path for that one IISER.
   - Then: the repo scaffold, the schema, `http.mjs` with robots and caching, and three adapters: INSPIRE, AJO, and html-list configured for IISER Pune's openings, academic and postdoctoral pages. Detail pages are parsed, but not PDFs yet.
   - Also: structured category mapping plus the title regex, deadline parsing, plain stemmed BM25F search with field weights and highlighting, the category picker, deadline/newest sort, hiding expired postings, the `state` branch, keepalive, the daily cron and the Pages deploy.
   - Amendments:
     - `categories` is a set with a confidence per entry (see Normalisation).
     - Stable posting IDs: assigned at first sight, stored in state, with an alias map for later URLs (see Normalisation).
     - `crawl.yml` gets a `crawl` concurrency group, uploads the state as a workflow artifact on every run, and runs its cron at 00:47 UTC.
     - Tokenizer tests with physics strings: AdS/CFT, AdS_5, N=4 SYM, SU(N), TTbar, 2+1D, many-body, out-of-time-order, Greek letters (and their spelled-out forms), and holography vs holographic, which Porter2 stems differently. The concept file must list both forms.
   - Acceptance:
     - codebpr.com/academic-jobs/ loads.
     - "holography" + Postdoc returns INSPIRE and AJO hits with highlighted terms.
     - A Pune JRF appears under PhD with a "guessed" marker, and a bundled JRF/SRF/RA advert appears under both PhD and Postdoc.
     - An INSPIRE posting ranked POSTDOC + JUNIOR appears under both Postdoc and Faculty.
     - Sorting by deadline works, and expired postings appear only with the toggle.
     - `docs/AUDIT.md` shows the runner probe results.
     - The Actions tab shows a green scheduled run, the `state` branch holds one commit, and `main` has no data commits.

2. **Concept matching v1.**
   - `concepts/physics.yaml` with about 25 seeded concepts: chaos, holography, black holes, entanglement, topological phases, strongly correlated systems, superconductivity, quantum information, string theory, CFT, integrability, nonequilibrium dynamics, stat-mech, quantum gravity, cosmology, and others.
   - Build-time concept tokens, query expansion, "matched via" chips and field facets.
   - **Field-gated expansion.** A literal hit of the query word counts anywhere. An expanded hit (Lyapunov, random matrix, nonlinear dynamics, thermalization) counts only when the posting's fields overlap the concept's default fields. Otherwise control-engineering jobs on AJO and probability postdocs on MathJobs flood "chaos".
   - **General calls section.** Many strong theory postdocs (ICTS, IMSc, Perimeter, KIAS) and every institute PhD admission call name no topic, so a topic query never matches them. A posting with no concept hits whose fields match the query concept's default fields is listed in a second section under the topic matches, headed e.g. "Open calls in hep-th / cond-mat that don't name a topic".
   - **Variant candidates for review.** At build time, write candidate variant pairs (index terms that share a prefix of 6+ characters but stem differently, e.g. postdoc/postdoctoral) to a review file, so variants are approved in batches instead of being found one search at a time.
   - **Probe obeys robots.txt.** `tools/probe.mjs` checks robots.txt the way the crawler does and skips disallowed paths (Phase 1's probe fetched HRI and IPR pages that robots.txt blocks).
   - **Exact form above stem-only.** The index records which surface forms of a term each posting used (bits above the field bits). A hit on the typed form outranks one that only shares the stem: "topological" ranks a "topological" ad above a "Topology" title.
   - **"Physics" field group.** A one-click facet next to the individual field facets, covering every physics arXiv field (hep-*, gr-qc, cond-mat, quant-ph, math-ph, astro-ph, nucl-*, nlin, physics.*). It drops the MathJobs/AJO maths postings from physics topic queries.
   - **Weak members.** Concept members too broad to count alone (thermalization, Lyapunov, random matrix) count only next to the query word, another member, or a second weak member.
   - **Theory / computational / experimental tag** from text cues (theoretical, numerical, simulation vs experimental, laboratory, fabrication, beamline, cryostat), with confidence, as a filter. Add a few labelled cases of each to the Phase 12 eval set.
   - Acceptance:
     - "chaos" returns at least one posting that never contains the word "chaos" (e.g. an OTOC or MBL ad), and its chip says why.
     - "chaos" doesn't return a control-engineering or probability posting that only matched through an expanded term.
     - "chaos" + Postdoc shows a second "Open calls in hep-th / cond-mat …" section containing at least one topic-less call (e.g. ICTS or Perimeter from AJO).
     - The theory/experiment filter hides an obviously experimental posting.
     - The variant review file lists postdoc/postdoctoral-style pairs, and approving one (moving it into `variants:`) changes the search results after `npm run build`.
     - A probe run reports HRI and IPR pages as "skipped (robots.txt)" without fetching them.
     - Editing the YAML and re-running `npm run build` changes the results.
     - The hep-th and cond-mat facet filters work.
     - "topological" + Postdoc ranks the Leeds, SJTU and Hanyang quantum-matter postdocs above the pure-maths ones (IHES Simons, SDU Quantum Mathematics, Warsaw quantum topology).
     - SYK and Lyapunov: no posting crawled on 2026-11-22 mentions either in its title or full ad text, so "chaos" can't find them yet. Their concept entries are covered by fixture tests, and a real SYK/Lyapunov ad will match "chaos" when one appears.
     - "Show more" appears only when more results exist, and never while "Loading postings…" is up.

3. **Health and change detection.**
   - Per-page link-set diffing gives new-since-last-run counts.
   - Gone-from-source status, `health.json`, a zero-streak counter, and an issue auto-opened after 3 zero runs (auto-closed when the source recovers).
   - `status.html` shows a table of sources: last run, items, new, errors and a streak warning.
   - The health report warns 30 days before any certificate in `config/ca/` expires (and the status page shows it).
   - A suspect run keeps the previous items, marks nothing gone, warns, and counts toward the 3-run issue streak. Suspect means zero items where there were some, or fewer than half of a previous count of 10 or more: a restructure that leaves 3 stray links where there were 216 must not hide 213 postings.
   - Removal depends on the kind of source. On a job board (INSPIRE, AJO, MathJobs), a dropped posting has closed: "removed from source", hidden like an expired posting. On an institute list page (html-list and other HTML kinds), pages trim and paginate adverts that are still open: a dropped posting with a future deadline stays visible until that deadline, marked "no longer on the list page".
   - Dispatching `crawl.yml` on a branch other than main uses `state-test/<branch>` (seeded from `state`), tags its issues with the branch, and doesn't deploy.
   - **robots.txt** is retried like page fetches. When it is still unreachable, the last good copy (kept in state) is used (RFC 9309 permits a cached copy); disallow-all only when there is no copy. The health report shows "skipped: robots.txt unreachable" separately from "skipped: robots.txt disallows". Test cases: IIT Kharagpur and NCBS (the probe keeps its own copies in the Actions cache).
   - **Approach tags: explicit theory cues win.** A group/unit/department name with Theory/Theoretical, or "theoretical … physics" in the title or first ~300 characters, gives Theory with high confidence. A high-confidence Theory posting gets Experimental only from an explicit experimental phrase. Fixtures: UCSD theoretical cond-mat, Academia Sinica Quantum Matter Theory Group, IHES "Postdoctoral position in Physics", Florida theoretical/computational QI.
   - The "Matched:" label leads the match line even when every hit came through a concept.
   - Acceptance: the status page lists every source. Pointing one source at a bad selector on a test branch opens an issue after 3 dispatched runs.

4. **MathJobs, cross-source dedupe and link-outs.**
   - The MathJobs adapter (shared with AJO), the institution alias table, merging duplicates, and the link-out row plus static links.
   - Read the Times Higher Ed ToS and decide whether to include it.
   - **Description similarity.** Title similarity misses some duplicates: the Oxford posting with Mezei, Schafer-Nameki and Sparks appears as INSPIRE "Three Postdoc Positions" and AJO "Postdoctoral Research Associate in Mathematical Physics", both with deadline 30 Nov. Within the institution block, also merge on description similarity (shingles over the first ~300 words) together with the deadline check. Alias "U. Oxford (main)" to "University of Oxford", and use this pair as a test fixture.
   - **Full institution names.** Show INSPIRE institutions by their full names instead of ICN abbreviations like "Bergische U., Wuppertal (main)".
   - Acceptance:
     - A postdoc listed on both INSPIRE and AJO shows once, with both source badges.
     - The Oxford INSPIRE/AJO pair above merges into one posting.
     - A second fixture: NYU's Feinberg fellowship appears as AJO "Postdoctoral Asscociate / Carl Feinberg Institute Fellow" (NYU CCPP) and INSPIRE "Feinberg Postdoctoral Prize Fellowship" (New York U. (main)), both closing 1 Dec. Description shingles merge it the same way as the Oxford pair.
     - The link-out buttons open each board's search with the query already filled in.
   - **How the merge works** (`crawler/lib/dedupe.mjs`).
     - Institutions must agree: the alias table in `config/institutions.yaml`, or a shared distinctive word ("Universität Hamburg" / "University of Hamburg").
     - Deadlines must be within 3 days.
     - Word 3-shingles over the first 300 words must reach a containment of 0.5. That's the share of the smaller set found in the larger, so a trimmed copy of a longer advert counts.
     - Postings merge only across sources, at most one per source per group, best pair first. Title similarity breaks ties, so an institution's near-identical assistant/associate/full-professor ads each pair with their own counterpart.
     - **Templated ads.** When both titles name a subject and the subjects share no word, the texts must be near-identical (0.9). This keeps Caltech's physics and maths searches apart (0.70) and Duke Kunshan's economics and maths searches apart.
     - The merge is recomputed each run and never rewrites IDs; the merged posting keeps the ID seen first. `notDuplicates` in `config/institutions.yaml` blocks a wrong merge.
     - On the 2026-11-22 data it merges 60 pairs. Most are AJO/MathJobs cross-posts, and about 25 are INSPIRE/AJO pairs that share no URL.
   - **Merged titles.** Prefer the one title that names a subject: any `config/fields.yaml` pattern or concept-file term (`search/subject.mjs`). When no title, or more than one, names a subject, the source-priority title stays. The other titles stay searchable (indexed as title text) and show as "Also listed as". Oxford reads "Postdoctoral Research Associate in Mathematical Physics"; NYU stays "Feinberg Postdoctoral Prize Fellowship".
   - **INSPIRE names** come from its institution records: one bulk API request per 100 institutions, cached for 90 days. That gives the full name and the country (INSPIRE jobs have no country). The ICN stays searchable.
   - **Times Higher Education** stays a link-out. Its Website Terms of Use (07 Jul 2026, §10) prohibit "data mining, robot, spider, scraping or similar automated data gathering … for any purpose", and the root robots.txt disallows `/unijobs/jobsrss/*`.
   - **Remembered filters.** The field facet and the approach filter are saved in localStorage, because MathJobs adds about 1,000 maths postings and a physicist should only need to pick Physics once. URL parameters, when present, override the stored choice.
   - **Status page.** A summary line ("5 OK · 1 link-out · 0 warnings · 0 failing"), failing and suspect rows first, each institution's pages grouped under one name, and Last OK kept on one line.
   - **Empty results.** When a search finds nothing, the link-out boards take the result list's place, with the query filled in.

5. **PDF extraction and Indian text heuristics.**
   - `pdftotext` with Content-Type sniffing and the PDF-text cache. Category, deadline and field extraction from the PDF text, with confidence levels.
   - "Image-only PDF" is detected and flagged, ready for OCR later.
   - Acceptance: a Pune ad whose research area appears only in the PDF (e.g. "condensed matter") is found by that keyword, and its result says "matched in PDF".
   - Folded in (2026-11-23):
     - **Schedule.** The 00:47 UTC cron had never fired: 0 `schedule` runs, workflow `active`, Actions enabled, not archived. No cause was confirmed. Changes: a second daily slot 12 h after the first; the keepalive re-enables the workflow only when its state isn't `active` (re-enabling an active workflow on every run was the one suspect found); a "data is N hours old" banner on the search and status pages when the last successful crawl is over 26 h old. Likely cause (found by Bhaskar): GitHub runs a schedule as the user who last committed the cron line, and those commits were authored as `bhaskar@Bhaskars-MacBook-Air.local`, which no account owns. The cron lines were recommitted under the account's noreply address and moved to minute 43 (00:43 and 12:43 UTC).
     - **Legacy Hindi fonts.** `crawler/lib/garble.mjs` drops lines whose words are mostly not English (`config/words-en.txt`, generated by `tools/make-wordlist.mjs` from board postings) and that show the Kruti Dev signature (punctuation or a capital inside a word, a capital + "k" matra, a high share of "k"). Applied to PDF text and institute page bodies. Fixture `tests/fixtures/pdf/krutidev.txt`.
     - **Deadlines from text.** `extractDeadlineInfo`: "last date for receipt of applications", "on or before", walk-in dates (the last date in the window), and "within N days of publication" from the posted date at low confidence. Precedence: list/source (high) > page text (medium) > PDF (medium, or low when relative). Cards say "Walk-in interview" and mark text-derived dates with "?".
     - **Snippets** start at the post description ("invites applications", "may attend walk-in interviews", "Post Name"), skipping the letterhead, Advt. No. and date lines and the institute blurb. A one-line page summary is followed by the PDF's description.
     - **Card facts** (`crawler/lib/advert.mjs`), each with a confidence: Advt. No. (also a weak alias `advt:<institution>:<number>` within a source, used only when unique and only for numbers with a year or office code), PI, project title and funding agency, upper age limit(s) with the relaxation sentence.
     - **Caps.** PDFs over 15 MB are skipped (Content-Length or counted while streaming), at most 10 pages are read, at most 3 PDFs per posting and 120 new PDFs per source per run (the rest wait for the next run). Skipped, truncated, image-only and deferred files are in `health.json` (`pdfs`, and `sources.<id>.pdf`) and on the status page.
     - **Result notices** (selected/shortlisted candidates) are recognised and their text is never indexed: it names people, not a position.
     - The PDF text is a fourth index field (`pdf`, bit 8, weight 0.7; `FORM_SHIFT` 4), never shipped. First Pune run: 92 PDFs in 3.5 min, 36 result notices, 1 scan.

6. **All IISERs.** Kolkata, Mohali (RSS), TVM (paginated), Berhampur, Bhopal (partial) and Tirupati (link-out for now), each with a fixture test.
   - Acceptance: the status page shows each IISER as green or as an explicit link-out, and searching "JRF physics" + PhD returns results from at least four IISERs.
   - Folded in (2026-11-23):
     - **PhD / integrated-PhD admissions pages** for every IISER (`admissions: true` sources): PhD category, fields from the departments the call covers ("physics" expands to its subfields), so the calls appear in the general-calls section of a physics topic search. Field tags no longer count as a posting naming a topic. `emptyOk`: an admissions page between rounds is not a breakage, as long as its list markup still matched.
     - **Pagination** (`pages:` in `crawler/lib/listing.mjs`): read until a page has no open advert. A posting missing from a partial read (or aged out of an RSS feed) that is older than the oldest row read is carried forward, not marked gone.
     - **Acceptance** split: "JRF physics" + PhD counts expired postings for the four-IISER check, and separately "physics" + PhD shows at least one open IISER posting.
     - **Smoke checks that depend on what is currently posted** are warnings, not failures, on live runs (`--url`), so a quiet month between admission rounds doesn't turn the smoke test red. Local-build runs and fixture tests stay strict.
     - **Status page:** a source whose PDF backlog exceeds the 120-per-run cap shows "Backfilling, N waiting".
     - Bhopal is a full include (its adverts are under `/assets_external/`, which robots.txt allows), and Tirupati is included through its server-rendered `/jobs/?selected_category=` pages.
     - New adapters: `html-table` (columns by header), `rss`; `html-list` gained blocks with labelled headers ("Advertisement Number: … Last Date: …"), joined titles, filters; `html-page` gained `sections` (one posting per round on a stacked page).

7. **Research institutes.**
   - IISc, ICTS, IMSc, IOP (wp-json), SINP, RRI, Bose, IACS, IUCAA, TIFR-H, NCRA, CMI, ISI, ARIES and NCBS.
   - NISER, JNCASR and IIA are partial. TIFR, HRI, IPR and PRL are link-outs.
   - Acceptance: an IMSc or ICTS postdoc call is searchable, and ARIES' slowness doesn't stall the run (it's watchdog-killed and reported).

8. **IITs (the static ones).** The 17 IITs from the Include column. Patna is partial. Gandhinagar and Bhilai are link-outs.
   - Acceptance: every IIT on the status page shows green, partial or link-out, none in an unknown state, and "Assistant Professor Grade I" maps to faculty.

9. **JS-rendered sites.**
   - Playwright in the crawl job, used only for sources marked `adapter: js-rendered`: IIT Ropar, IIT Tirupati, IIT Jammu and IISER Tirupati. I'll first look for their JSON endpoints and use one wherever it exists.
   - Acceptance: postings from those sites appear, and the crawl stays under 20 minutes.

10. **Mac fallback hardening.** (Likely to be dropped: NCBS, the only host so far that answers from a residential connection but never from a runner, is a link-out instead. If Phases 6–8 find no other Mac-only host, drop this phase and renumber.)
    - This phase only exists if Phase 1's probe found blocked hosts; otherwise I drop it and renumber.
    - It covers launchd scheduling, retry when the Mac was asleep, and a stale-inbox warning on the status page.
    - Acceptance: hosts marked `runner: mac` update after the Mac's run, and the status page shows when the inbox was last pushed.

11. **OCR for scanned PDFs.** `tesseract` (eng + hin) on flagged image-only PDFs, with the results cached.
    - Acceptance: a known scanned notice becomes searchable.

12. **Labelled evaluation and the semantic-matching experiment.**
    - `tools/eval.mjs`, the labelled set (including the theory/computational/experimental cases added in Phase 2), and a numbers report in PLAN.md. The go/no-go decision is made against the bar set under Matching.
    - Acceptance: you can see the eval report. Embeddings ship only if they clear the bar.

13. **Main-site link.** A small PR to `bhaskarspace.github.io` adding a card the way `games.md` does.
    - Acceptance: codebpr.com links to the tool.

After approval, the first steps are to write this plan to `PLAN.md` and write `CLAUDE.md`. `CLAUDE.md` will cover the layout, `node crawler/run.mjs --source iiser-pune --dry` to run one source locally, the steps for adding a source (registry entry, fixture, test, `docs/AUDIT.md` row), the robots/permission policy, and the rule that state lives on the `state` branch.

## Verification (every phase)
- `npm test` covers the adapter fixtures, date parsing, the category rules, dedupe and the index round-trip.
- `npm run build && npx serve dist` lets you check search locally.
- A Playwright smoke test runs the phase's acceptance queries against `dist/`.
- After merge, run `crawl.yml` by dispatch, check the deploy at codebpr.com/academic-jobs/ and `status.html`, and confirm `main` gained no data commits.
