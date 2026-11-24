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
| MathJobs (AMS) | JSON `www.mathjobs.org/jobs/public_job_boards?…` (same software) | robots.txt empty (allow all); no crawl-delay, so 2 s default | Same as AJO | Same as AJO. Validate `type`: some records say "BEGIN" | 1,007 (2026-11-22); about 960 after merging AJO cross-posts | **Include** (Phase 4) |
| EURAXESS | HTML only; any query string returns 403 | Content is CC BY 4.0, but the WAF blocks access | (R1–R4 profile on job pages) | R1 → phd, R2 → postdoc, R3/R4 → faculty | Unmeasurable | **Link-out** `euraxess.ec.europa.eu/jobs/search?keywords={q}` |
| jobs.ac.uk | HTML only; RSS is 404 | ToS behind a bot challenge | n/a | n/a | About 700 physics jobs (unverified) | **Link-out** `jobs.ac.uk/search/?keywords={q}` |
| Physics Today / APS | Madgex RSS works | ToS forbid automated harvesting | Thin: title, blurb, date | n/a | PT 6.7k total | **Link-out** (one each) |
| Nature Careers | Madgex RSS | robots.txt disallows `/jobsrss/` | n/a | n/a | About 375 physics | **Link-out** `/naturecareers/jobs/?keywords={q}` |
| Times Higher Ed Unijobs | Madgex RSS works, but the root robots.txt has `Disallow: /unijobs/jobsrss/*` (the /unijobs/robots.txt doesn't, but only the root file counts) | Website Terms of Use (07 Jul 2026) §10 forbid "data mining, robot, spider, scraping or similar automated data gathering, extraction or publication tools for any purpose" | Thin | Title heuristic | About 300 physics | **Link-out** (decided in Phase 4) |
| AcademicPositions, FindAPostDoc, FindAPhD | Cloudflare 403 | n/a | n/a | n/a | n/a | **Link-out** |
| ICTP, EMS, physics rumor mill | Timed out | n/a | n/a | n/a | Few | **Static link** |
| HigherEdJobs, Indeed, LinkedIn, AMS EIMS, ScholarshipDb | Bot wall, or ToS forbid scraping | n/a | n/a | n/a | n/a | **Exclude** |

### Indian institutes
Every institute's posting fields are title, a posted date and/or last date, and a PDF link. Category comes from the title regex with medium confidence, or from text found only in the PDF with low confidence (see Normalisation).

| Group | Include (static HTML, robots OK) | Partial (list page only, PDF not fetched) | Link-out (robots `Disallow: /`, WAF or JS-only for now) | Volume |
|---|---|---|---|---|
| **IISERs** | All seven since Phase 6: Pune, Kolkata, Mohali, Bhopal, TVM, Tirupati, Berhampur (see "IISERs (Phase 6)" below). Bhopal's adverts sit under `/assets_external/`, which robots.txt allows; Tirupati's jobs pages are server-rendered with `?selected_category=` | — | — | Pune about 216 rows, Berhampur 95 adverts, TVM ~775 (31 pages) |
| **Research institutes** | Since Phase 7 (see "Research institutes (Phase 7)" below): IISc, ICTS, IOP, SINP, RRI, S.N. Bose, IUCAA, TIFR-H, NCRA, ISI Bangalore, ARIES | NISER, JNCASR, IIA | TIFR Mumbai, HRI, IPR (`Disallow: /`); PRL (robots.txt 403); IACS (robots.txt intent); IMSc (Cloudflare blocks runners); ISI Kolkata and NCBS (runner timeouts); CMI (unreachable) | SINP keeps ~230 rows back to 2022 |
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

### NCBS: link-out (2026-11-22)
NCBS (www.ncbs.res.in) has never answered a GitHub runner: connection timeouts on every probe,
including on robots.txt after three tries in Phase 3. It answers from a residential connection.
It is a link-out in `config/sources.yaml` (`adapter: link-out`) rather than a reason to build the
Mac fallback (Phase 10).

### Link-out search URLs (Phase 4, 2026-11-22)
`config/linkouts.yaml` lists each board's search URL with `{q}`. Checked with the project UA:
- jobs.ac.uk, Nature Careers and THE return the search page with the query in it.
- Physics Today, APS (www.apsphysicsjobs.com; careers.aps.org redirects there), AcademicPositions and FindAPostDoc were confirmed by Bhaskar in a real browser, with the query applied (2026-11-23).
- EURAXESS ignores `?keywords=`. Its own search box produces `jobs/search?f%5B0%5D=keywords%3A{q}` (f[0]=keywords:<query>), which was confirmed in a browser ("chaos" leads with "Stability and chaos in the N-body problem…").
- FindAPhD shows automated browsers a Cloudflare check, so it's unconfirmed. It uses the same `Keywords=` parameter as FindAPostDoc.

### PDF adverts (Phase 5, 2026-11-23)
- IISER Pune: 92 PDFs on the first run (all allowed by robots.txt), 3.5 min at one request per 2 s; 36 were result
  notices (selected candidates, not indexed), 1 a scan with no text layer. Bilingual Unicode Devanagari + English;
  no Kruti Dev seen there yet, but the filter is in place for the IISERs and IITs in Phases 6–8.
- Phrasings seen: "Walk-in interviews on 18.11.2026", "on or before 27.11.2026", "Not more than 35 years",
  "Title of the “…” Project", "Funding Agency" (split by the table layout), "ADVERTISEMENT NO. :88/2026".

### IISERs (Phase 6, 2026-11-23)
Checked from the Mac with the project UA. "robots" is the verdict for the paths used; PDFs are
fetched only for open adverts, at most 120 new per source per run.

| IISER | Page (source id) | Kind | robots.txt | Verdict |
|---|---|---|---|---|
| Pune | /education/admissions/phd-programme (`iiser-pune-phd-admissions`), /education/admissions/integrated-phd-programme (`iiser-pune-iphd-admissions`) | programme pages; the dated round appears in the text | `User-agent: *` with no rules | include |
| Kolkata | /web/advertisements (`iiser-kolkata-projects`) | table: post, contact person (PI), department, last date, PDF | 404 (no robots.txt) | include |
| Kolkata | apply.iiserkol.ac.in/pdf/ (`iiser-kolkata-postdoc`) | standing PDF programme | 404 | include |
| Kolkata | /web/admission (`iiser-kolkata-admissions`) | cards; "Click Here" links carry per-session tokens (404 later), so the posting links to the page | 404 | include |
| Kolkata | apply.iiserkol.ac.in/jobs/ (non-teaching), /faculty/ | not academic / one dated faculty advert | 404 | not added |
| Mohali | web.iisermohali.ac.in/noticeportal/iiserm-project-openings?format=feed&type=rss (`iiser-mohali-projects`) | RSS, newest 10, full advert text | 404 | include |
| Mohali | /admission-news (`iiser-mohali-admissions`) | list; results filtered out | Joomla defaults (system folders only) | include |
| Mohali | /faculty-positions | list of past dated adverts | allowed | not added |
| Bhopal | /dofa/vacancy (`iiser-bhopal-pdf`), /careers/rnd (`iiser-bhopal-rnd`) | tables; PDFs under /assets_external/dofa/ and /assets_external/vacancy/ | disallows /old/*, /assets/*, /assets_external/tender/* only | include (was "partial": the adverts are not under /assets/) |
| Bhopal | phdadmission.iiserb.ac.in (`iiser-bhopal-admissions`) | one card per department round | disallows system folders only | include |
| TVM | /openings (`iiser-tvm-openings`) | table, 25 a page, newest first, ~31 pages; read until a page has no open advert | 404 (served as an HTML page) | include |
| TVM | /pages/admission (`iiser-tvm-admissions`) | announcements; results filtered out; detail page per call | 404 | include |
| Tirupati | /jobs/?selected_category=pa-pf and =pdrf (`iiser-tirupati-projects`, `iiser-tirupati-postdoc`) | server-rendered table, paginated (`?page=N%2F`); detail page links the PDF | disallows /wp-admin/ only | include (was link-out: the AJAX list has this server-rendered twin) |
| Tirupati | /admission-phd/, /admission-iphd/ (`iiser-tirupati-*-admissions`) | stacked rounds; one posting per current heading, past years dropped | as above | include |
| Berhampur | /opportunity/contractual, /opportunity/post-doc, /opportunity/phd-admissions | one table per advert (Advt. No., dated, last date; rows per post) | `Allow: /` | include |
| Berhampur | /opportunity/teaching-faculty, /non-teaching-staff | not academic / few | allowed | not added |

Seen while adding them:
- Result-notice detection was too eager. Advert boilerplate ("Selected candidates must submit …",
  "will be informed to the shortlisted candidates through email") marked 4 adverts as notices. Only
  heading-like phrases count now; the PDF cache moved to v3 so everything was re-read.
- Field tags were set by words of the institute's name ("Science **Education** and Research"
  tagged humanities). That phrase is ignored now, and the humanities rule is word-bounded.

### Research institutes (Phase 7, 2026-11-24)
Re-checked from the Mac and from a GitHub runner (`probe.yml` with `--html-headers`: the project UA plus
`Accept: text/html`, `Accept-Language: en`, `Accept-Encoding: identity`; never a browser UA). "robots" is the
verdict for the paths used.

| Institute | Page (source id) | Kind | robots.txt | Verdict |
|---|---|---|---|---|
| IISc | /careers/contractual-positions/ (`iisc-contractual`) | TablePress table: Advt. No., post, department, PDF, start and closing dates | only /wp-admin/ | include. /positions-open/ is now an "IISc in numbers" page |
| ICTS | /opportunities (`icts-opportunities`) | card grid, posted date; deadline from the detail page | Crawl-delay 10 | include. /academic/postdoctoral-fellowships repeats the same calls, so it is not a second source |
| IMSc | /post_doctoral_programme (`imsc-postdoc`), /facultyrecruitment (`imsc-faculty`) | programme pages; the postdoc call is rolling ("Applications are accepted all year round") | Crawl-delay 10 | **link-out** (`imsc-programmes`). The runner probe got 200 at 06:50 UTC, but the branch crawl at 08:54 UTC got 403 from Cloudflare on both pages. The crawl config is kept with `enabled: false` (and fixture-tested) for if they answer again |
| IMSc | /other_positions (`imsc-other`) | advert list | allowed | **link-out**: Cloudflare answers Node with a 403 challenge from runners, with or without ordinary headers, while curl from the same runner gets 200 (a client-fingerprint rule). The other two IMSc pages answer normally |
| IOP Bhubaneswar | /feed/?post_type=job_opening (`iop`) | RSS, newest 10 | only /wp-admin/ | include (the existing `rss` adapter; no wp-json adapter needed) |
| SINP | /web/job-opportunities (`sinp`) | one long table of PDFs with published dates; closing dates in titles | 404 (allow all) | include. The server answers **500** to `Accept-Encoding: gzip` or `deflate` (with the full page as the body) and 200 to identity, br or none, so the source sends `Accept-Encoding: identity`. Merit lists, Hindi copies and undated rows older than 180 days are filtered out |
| RRI | /careers/post-doctoral-fellowships (`rri-postdoc`) | programme page (rolling) | Drupal defaults | include |
| S.N. Bose | JobOpenings.jsp?type=ACADEMIC (`bose`) | table: position, ref., publish and closing dates | only /site-admin | include |
| IACS | /research-associate | table (~480 rows) | the job pages are named in `Disallow:` lines written as full URLs (`Disallow:http://iacs.res.in/research-associate.html`, `faculty-position.html?id=…`), some under `User agent:*` without the hyphen. RFC 9309 parsers ignore those lines, but the intent is clear | **link-out** (decided 2026-11-24). A probe dispatched by mistake fetched /research-associate once from a runner (2026-11-24 06:50 UTC) before it was cancelled; IACS is no longer in `tools/probe-urls.json` |
| IUCAA | /en/opportunities (`iucaa`) | "Current Openings" table (deadline column) and a "throughout the year" table (rolling: `rollingTables`) | Joomla system folders | include. The rolling table's prose still names 2024/25 rounds; those dates are ignored. "Apply Online" form links on web.iucaa.in:8080 are not taken as PDFs (`pdfLinks`) |
| TIFR Hyderabad | /careers/post-doctoral-and-visiting-positions/, /careers/jrf-srf-positions/ (`tifrh-postdoc`, `tifrh-jrf`) | small tables, header row in `<td>`s | only /wp-admin/ | include (not RSS, as the 22 Nov audit said) |
| NCRA | /jobs/academic/pdf (`ncra-postdoc`) | list + detail pages | `Disallow:` (empty) | include. An annual call (deadline 31 October) |
| *Runner-blocked hosts and the Mac* | — | — | — | Decided 2026-11-24: IMSc and ISI Kolkata stay link-outs, and the Mac runner (`runner: mac`) is **not** used to reach them. Crawling a bot-protected site (IMSc's Cloudflare) from a home connection gets past the protection just as a spoofed client would, which the rules exclude. The Mac runner is only for a host that blocks no one and simply can't be reached from GitHub's network; ISI Kolkata isn't treated as one either. Phase 10 (Mac fallback) stays likely to be dropped |
| CMI | /positions/ | — | was 404 on 22 Nov | **link-out**: connection refused on 443 and 80 from the Mac and a runner on 24 Nov. Re-probe later |
| ISI Kolkata | /public/jobs (`isi-kolkata`) | table: issue date, submission deadline, walk-in date; detail page per advert | 404 | **link-out** (`isi-kolkata-linkout`), like NCBS: connection timeouts from runners on 22 Nov and twice on 24 Nov (probe and branch crawl; robots.txt unreachable, so nothing is fetched). Answers from the Mac. The crawl config is kept with `enabled: false` |
| ISI Bangalore | homepage left bar (`isi-bangalore`) | "Job Notifications" PDFs | 404 | include (it has no jobs page) |
| ARIES | /opportunities/project-position (`aries`) | current adverts in boxes above an older table; "[Last date: …]" in titles | Drupal defaults | include. The server sends the GlobalSign GCC **R6** AlphaSSL intermediate for a leaf issued by GCC **R46** AlphaSSL CA 2025, which is now in `config/ca/`. Watchdog 5 min; a cold run (26 detail pages, ~9 s each) took 292 s before list-title dates let expired rows skip their detail page |
| NISER | /career/staff/ft/cr (`niser-fixed-term`) | fixed-term adverts: section, description, deadline | /storage/ disallowed | **partial**: list text only. (/sps/postdoc, in the 22 Nov audit, lists current postdocs, not adverts) |
| JNCASR | /announcements (`jncasr`) | table; job announcements filtered by title | /sites/default/files/ disallowed (unchanged) | **partial** |
| IIA | /iia_jobs/ (`iia`) | table: post, job ID, posted on, last date | `/*.pdf$` disallowed | **partial** |
| TIFR Mumbai, HRI, IPR | — | — | `Disallow: /` for `*` (TIFR allows only Googlebot) | **link-out** (now listed on the status page as sources) |
| PRL | — | — | robots.txt returns 403 | **link-out** |

### Schedule (2026-11-24)
- **Cause.** The 00:47 cron never fired. GitHub runs a scheduled workflow as the user who last committed
  its cron line, and those commits were authored as `bhaskar@Bhaskars-MacBook-Air.local`, which no GitHub
  account owns.
- **Fix.** 4a40ff0 recommitted the cron lines (now 00:43 and 12:43 UTC) under
  `134090427+bhaskarspace@users.noreply.github.com`, and git is set to that identity globally.
  CLAUDE.md now requires it for any commit touching the cron lines.
- **Delays.** The first scheduled run (#15) started at 00:23 UTC on 24 Nov, 11.7 h after its 12:43 slot.
  At 06:38 UTC the 00:43 slot hadn't run yet.
- **Decision.** Keep the two slots and add no external trigger. Revisit only if the status page shows
  a gap over 26 h during the week to 1 Dec.
