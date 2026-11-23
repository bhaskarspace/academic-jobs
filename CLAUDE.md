# Academic Jobs

A static search engine for academic positions (PhD, postdoc, faculty, fellowship). It covers the
open job boards (INSPIRE-HEP, AcademicJobsOnline, MathJobs) and the recruitment pages of Indian
institutes. GitHub Actions does the collection on a daily cron. The site is plain static files at
https://codebpr.com/academic-jobs/, and all searching happens in the browser.

## Plans
- `PLAN.md` holds the source audit, the architecture and the numbered phases. Read it first, and
  update its status line whenever a phase ships.
- `docs/AUDIT.md` is the source audit table. Keep it current whenever a source changes.
- Phases are numbered 1, 2, 3 and so on, with one PR per phase and no lettered sub-phases. If a
  phase is added or dropped, renumber.

## Layout
- `config/sources.yaml`: the source registry, one entry per source or page. Fields are `id`,
  `adapter`, `url(s)`, `institution`, `country`, `runner: actions|mac`, `tls`, `crawlDelay`,
  `permission`, and the parse hints.
- `config/categories.yaml`, `config/institutions.yaml`, `config/linkouts.yaml`: category rules,
  institution aliases (plus `notDuplicates`, to block a wrong merge), and the link-out boards (bundled into
  `app.js` at build time). A source with `adapter: link-out` is listed, never crawled.
- `crawler/lib/dedupe.mjs` merges cross-source duplicates that share no URL (institution + deadline
  + description shingles). Run `node crawler/run.mjs --all --dry --verbose-dedupe` to see every merge.
- `concepts/physics.yaml`: the concept/synonym file. Bhaskar curates it, so keep its comments and
  its ordering.
- `crawler/run.mjs` is the CLI.
  - `crawler/adapters/` has one adapter per *kind* of source: inspire, ajo (which also serves
    MathJobs), rss, html-list, html-table, wp-json, js-rendered.
  - `crawler/lib/` holds http (UA, robots, rate limits, conditional requests, timeouts), pdf
    (`pdftotext`), dates, normalize, categorize, dedupe, changes, state and health.
- `search/` is shared by the build and the browser: stem, tokenize, concepts, build-index, query.
  The build and the browser must tokenize identically. `search/approach.mjs` (the
  theory/computational/experimental tag, from `config/approach.yaml`) runs only at build time.
- Each build writes `variant-candidates.yaml` to `.out/` and to the site's `data/`, for approving
  variant pairs in batches (into `variants:`, or reject them into `notVariants:`).
- `site/` is the frontend: vanilla JS with no framework, bundled by esbuild into `dist/`.
- `tests/` runs with `node --test`. `tests/fixtures/` holds saved HTML/JSON/PDF responses for
  each adapter. The repo is public, so trim advert text in fixtures to short excerpts (INSPIRE
  metadata is CC0 and can stay whole).
- `.github/workflows/`: `crawl.yml` (cron and dispatch, crawl → build → deploy Pages artifact),
  `ci.yml`, `probe.yml`.

## Commands
- `npm test`
- `npm run build`, then `npx serve dist` to try the search locally.
- Run one source without writing state: `node crawler/run.mjs --source iiser-pune --dry`.
  - `--no-cache` ignores the ETag cache.
  - `--all` runs every source.
  - `--runner mac` runs only the sources marked `runner: mac`.
- Poppler is needed for PDFs: `brew install poppler` on macOS (on CI it's `apt-get install
  poppler-utils`).

## Adding a source
1. Check its access method (API, RSS or HTML), its robots.txt and its ToS. Add a row to
   `docs/AUDIT.md` with the verdict: include, partial or link-out.
2. If an existing adapter fits, add an entry to `config/sources.yaml`. Write a new adapter only for
   a genuinely new kind of page.
3. Save a fixture to `tests/fixtures/<id>/` and add a test that parses it into the expected
   postings, checking title, deadline and category.
4. Run `node crawler/run.mjs --source <id> --dry` against the live site.

## Rules
- Be polite. Use the UA `academic-jobs/0.1 (+https://github.com/bhaskarspace/academic-jobs/issues)`
  and never put an email address in it. Allow at most one request per host every 2 s, and honour
  robots.txt crawl-delay. Use conditional requests. Fetch detail pages and PDFs only for links not
  seen before.
- **Obey robots.txt strictly.**
  - A site that disallows everything becomes a link-out.
  - If only the PDFs are disallowed, index the list-page text and link to the PDF without
    fetching it.
  - A source's `permission:` field (date, plus who granted it and how) is the only thing that
    overrides robots.txt, and it requires written consent.
- Respect copyright. The public site ships the title, institution, dates, a snippet of at most 240
  characters, the URL, and the inverted index (stemmed terms with no word positions). It never
  ships full ad text or PDF text.
- **Never commit data to `main`.** Persistent state lives on the `state` branch, rewritten each run
  as a single force-pushed orphan commit. If the run can't read the state branch it aborts before
  deploying. Never reset state silently.
- Expired postings are hidden by default and never deleted. A posting with no deadline gets a
  flag; it's never dropped.
- `categories` is a set of `{category, confidence}` entries, never a single value. Every rule that
  fires adds an entry, and every guessed entry carries a confidence flag.
- A posting ID is assigned at first sight and stored in state. Later URLs from other sources are
  aliases pointing at that ID. Never recompute an ID from the current canonical URL, because that
  breaks `firstSeen` and "new since your last visit".
- TLS: some Indian hosts send incomplete certificate chains (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`).
  Fix that by adding the missing intermediate under `config/ca/` (with a row in its README).
  `crawler/lib/ca.mjs` loads it for both the crawler and the probe. Never set `tls: insecure`
  for this.
- Email addresses and URLs in advert text are never indexed (the tokenizer drops them).
- Health: `crawler/lib/health.mjs` (link diffs, removed-from-source, warnings), `tools/health-issues.mjs`
  (issues labelled `source-health`), `site/status.html`. A zero-item run keeps the previous items.
  To test a breakage, dispatch `crawl.yml` on a branch: it uses `state-test/<branch>` and never deploys.
  Delete the `state-test/*` branch and close its `[test: …]` issues afterwards.
- Cron times are UTC, set on odd minutes, twice a day 12 h apart (00:47 and 12:47). `crawl.yml` runs in concurrency group `crawl` and uploads the state as an artifact on every run. Each crawl run re-enables its own workflow through the API when it isn't `active`, which works
  around the 60-day inactivity rule. The search and status pages warn when the data is over 26 h old.
- PDFs (`crawler/lib/pdf.mjs`): at most 15 MB, the first 10 pages, 3 per posting, 120 new per source per run; text cached
  under `pdf:v1:<url>` (bump `CACHE_VERSION` to re-extract). The text is indexed as the `pdf` field and never shipped.
  Result notices (selected candidates) are never indexed. Legacy-font (Kruti Dev) lines are dropped by
  `crawler/lib/garble.mjs`; regenerate its word list with `node tools/make-wordlist.mjs` after a full crawl.
- Card facts (`crawler/lib/advert.mjs`: Advt. No., PI, project/funding, age limit) and text-derived deadlines carry a
  confidence; the card marks anything not from the list page with "?".
