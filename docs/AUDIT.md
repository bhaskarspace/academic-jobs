# Source audit

Kept current: every source in `config/sources.yaml` has a row here. Verdicts: **Include**
(crawled), **Partial** (list page indexed, PDFs not fetched because robots.txt disallows them),
**Link-out** (a "search this on X" link with the query filled in), **Exclude**.

Policy: robots.txt is obeyed strictly. A `permission:` field in `config/sources.yaml` (date, who,
how) overrides it only after a webmaster's written consent.

## Verdicts

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

## Reachability from GitHub runners (Phase 1 probe)

`tools/probe.mjs` fetched 73 URLs (every institute page in the audit plus the two
API controls) with the project User-Agent, from the Mac and from a GitHub-hosted runner.
Full results: `docs/probe/`.

| | Mac (Node) | Runner, first run | Runner, after fix |
|---|---|---|---|
| URLs answering 2xx/3xx | 65/73 | 60/73 | 64/73 |

**Finding: GitHub's runners are not blocked from Indian institute sites.** Every failure falls into
one of four groups, and none of them is specific to the runners' location:

1. **Node gave up too early on dual-stack hosts (fixed).** On the first runner run, IIT Delhi,
   IISER Bhopal, NISER and IACS failed after about 250 ms with `ETIMEDOUT`, while curl reached
   them from the same runner. 250 ms is Node's default per-address-family attempt timeout.
   `crawler/lib/http.mjs` (and the probe) now set it to 2.5 s, and all four answer.
2. **Incomplete certificate chains.** IIT Jodhpur, IIT Bhilai, HRI, ARIES and IPR fail with
   `UNABLE_TO_VERIFY_LEAF_SIGNATURE` everywhere, curl on the runner included (`ssl=20`). Their
   servers leave out an intermediate certificate. The fix is to ship the missing intermediates
   in `config/ca/` (Phase 7/8), never to disable verification. HRI and IPR are link-outs under
   robots.txt anyway. Phase 2 added their intermediates (`config/ca/README.md`) so that the
   probe can read their robots.txt: both say `User-agent: * / Disallow: /`, and the probe now
   reports their pages as "skipped (robots.txt)" without fetching them. Jodhpur, Bhilai and ARIES
   still need theirs.
3. **Responses that depend on the HTTP client.** IIT Gandhinagar (Cloudflare challenge) and IMSc's
   `other_positions` page return 403 to Node's `fetch`, and SINP's job page returns 500 to it. curl
   from the same runner gets 200 from all three, so the response depends on the client's headers or
   TLS fingerprint, not on the runner's network. Phase 7 will compare headers before deciding;
   if a site only answers a browser-like client, it becomes a link-out rather than being spoofed.
4. **Transient timeouts.** ISI Kolkata, NCBS and IACS each timed out once from the runner but
   answered on other runs. Retries and the per-source cache handle this.

**Consequence for the plan:** the Mac fallback (Phase 10) is not needed for any host so far. It
stays in the plan until Phases 6 to 8 have run against the full source list for a while. If no
source needs it by then, it is dropped and later phases are renumbered.

URLs that failed somewhere (all others answered 200 in all three runs):

| id | URL | Mac | Runner (first) | Runner (fixed) | curl on runner |
|---|---|---|---|---|---|
| iit-d | https://home.iitd.ac.in/jobs-iitd/index.php | 200 | ETIMEDOUT | 200 | 200 |
| iit-gn | https://iitgn.ac.in/careers | 403 | 403 | 403 | 200 |
| iit-j | https://iitj.ac.in/main/en/recruitments | UNABLE_TO_VERIFY_LEAF_SIGNATURE | UNABLE_TO_VERIFY_LEAF_SIGNATURE | UNABLE_TO_VERIFY_LEAF_SIGNATURE | 000 |
| iit-bhilai | https://iitbhilai.ac.in/ | UNABLE_TO_VERIFY_LEAF_SIGNATURE | UNABLE_TO_VERIFY_LEAF_SIGNATURE | UNABLE_TO_VERIFY_LEAF_SIGNATURE | 000 |
| iiser-bhopal | https://www.iiserb.ac.in/dofa/vacancy | 200 | ETIMEDOUT | 200 | 200 |
| iisc | https://iisc.ac.in/positions-open/ | ERR_HTTP2_STREAM_ERROR | 200 | 200 | 301 |
| hri | https://www.hri.res.in/advertisements/ | UNABLE_TO_VERIFY_LEAF_SIGNATURE | UND_ERR_CONNECT_TIMEOUT | UNABLE_TO_VERIFY_LEAF_SIGNATURE | 000 |
| imsc | https://www.imsc.res.in/other_positions | 200 | 403 | 403 | 200 |
| imsc | https://www.imsc.res.in/facultyrecruitment | 200 | 403 | 200 | 200 |
| sinp | https://www.saha.ac.in/web/job-opportunities | 500 | 500 | 500 | 200 |
| niser | https://www.niser.ac.in/sps/postdoc | 200 | ETIMEDOUT | 200 | 200 |
| iacs | https://iacs.res.in/research-associate | 200 | UND_ERR_CONNECT_TIMEOUT | 200 | 200 |
| isi-kol | https://www.isical.ac.in/public/jobs | 200 | 200 | UND_ERR_CONNECT_TIMEOUT | 000 |
| aries | https://www.aries.res.in/opportunities/project-position | UNABLE_TO_VERIFY_LEAF_SIGNATURE | UNABLE_TO_VERIFY_LEAF_SIGNATURE | UNABLE_TO_VERIFY_LEAF_SIGNATURE | 000 |
| ipr | https://www.ipr.res.in/careers | UNABLE_TO_VERIFY_LEAF_SIGNATURE | UNABLE_TO_VERIFY_LEAF_SIGNATURE | UNABLE_TO_VERIFY_LEAF_SIGNATURE | 000 |
