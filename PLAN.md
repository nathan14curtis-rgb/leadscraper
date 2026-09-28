# Plan: Find every US trailer-rental business via a self-built Google Maps scraper

## Decisions (from Q&A)

| Item | Decision |
|---|---|
| Source | Self-built Google Maps scraper (Playwright). Not the Places API. |
| Budget | Under $200. Target: $0 spend, optional ~$50–100 residential proxy only if blocked. |
| Scope | Utility / cargo / equipment / car-hauler trailers; boat / horse / livestock / dump trailers; trailer dealers that also rent. RV/camper rentals excluded. |
| Chains | Include everything (U-Haul, Penske, Home Depot, Sunbelt, etc.). Flag with `is_chain` + `chain_brand`. |
| Fields | Name, address, phone, website, plus email (from a second crawl of each website). Rating, review count, category, lat/lng come for free. |
| Runtime | Nathan's own machine (residential IP), unattended, resumable over several days. |
| Storage | SQLite (source of truth) + CSV export on demand. |
| Stack | Node 20+, TypeScript, Playwright, better-sqlite3. |

## How Google Maps limits us, and how we get around it

- **120-result cap.** Any single search returns at most ~120 results (20 per scroll page, ~6 pages). A query like "trailer rental" for the whole US is useless.
- **Solution: adaptive grid search.** Tile the US into cells, search each cell's viewport, and if a cell returns the cap (saturated), split it into 4 and re-search. Sparse rural cells finish in one pass; dense metros subdivide 2–3 levels.
- **Category matters more than query.** Google returns businesses whose category or name matches the query. We run several queries per cell and keep any result whose category is in our allowlist, or whose name matches trailer terms.
- **Parse data, not the DOM.** Each Maps page embeds a JSON blob (`window.APP_INITIALIZATION_STATE`) with the full result set: place ID, CID, name, category list, full address, phone, website, lat/lng, rating, review count. Parsing this is far more stable than CSS selectors, which Google changes often.

## Search terms and category allowlist

Queries run per cell (in priority order, later ones only if earlier ones did not saturate):

1. `trailer rental`
2. `trailer rentals`
3. `utility trailer rental`
4. `cargo trailer rental`
5. `dump trailer rental`
6. `car hauler rental`
7. `trailer dealer`
8. `trailer hire` (rarely used in the US, cheap to include)

Category allowlist (Google's own labels): `Trailer rental service`, `Trailer dealer`, `Trailer supply store`, `Trailer repair shop`, `Truck rental agency`, `Equipment rental agency`, `Moving supply store`, `Horse trailer dealer`, `Boat trailer dealer`, `Utility trailer dealer`. Anything else is kept only if the name contains `trailer`.

Every kept row stores its category list so filtering can be tightened later without re-scraping.

## Grid design

- Start with 0.5° × 0.5° cells (~55 km × 40 km) over the lower 48 + Alaska + Hawaii bounding boxes.
- Skip cells whose center is in the ocean / outside the US using a bundled low-res US land polygon (Natural Earth, free).
- Roughly 3,500 land cells at level 0. Subdivide on saturation: expected ~6,000–8,000 total cell-queries after splitting.
- Supplement the grid with a free US cities CSV (simplemaps `uscities` free tier, ~30k places). Any city of 10k+ population gets a direct search at zoom 12, catching things the grid centroid missed.
- Every cell/query pair is a row in `search_cells` with a status, so the run is resumable after a crash or reboot.

## Pipeline stages (each is its own CLI command, each resumable)

1. **`seed`** — generate grid + city seed rows into SQLite.
2. **`search`** — for each pending cell/query: open `https://www.google.com/maps/search/<query>/@<lat>,<lng>,<zoom>z`, scroll the results panel to the end, parse the embedded JSON, upsert places by CID, mark cell done with result count, enqueue 4 children if saturated.
3. **`details`** — for places missing phone or website (list view often omits them), open the place URL and parse the full record. Most places already have this from step 2; expect 20–40% need a detail visit.
4. **`emails`** — for each unique website domain: fetch homepage, `/contact`, `/contact-us`, `/about`, and any page linked with "contact" in the anchor (max 6 pages, 10s timeout each). Extract `mailto:` links, JSON-LD `email` fields, and regex matches. Drop junk (image filenames, `sentry`, `wixpress`, `example.com`, `noreply`). Rank domain-matching emails first. Plain HTTP fetch with Playwright fallback for JS-only sites. Expected hit rate 35–50%.
5. **`enrich`** — chain detection by name regex (U-Haul, Penske, Budget, Home Depot, Lowe's, Sunbelt, United Rentals, Herc, Tractor Supply, Big Tex, PJ Trailers, Ryder, Enterprise). Address parsing into street / city / state / zip. Domain normalization.
6. **`dedupe`** — primary key is Google CID. Secondary merge on normalized phone, then on domain + zip, then on fuzzy name + zip. Merged rows keep all source queries.
7. **`export`** — write `leads.csv` (one row per business) and `leads_emails.csv` (one row per email). Optional filters: `--no-chains`, `--state=UT`, `--has-email`.

## Database schema (SQLite)

- `places` (cid PK, place_id, name, primary_category, categories_json, address_full, street, city, state, zip, lat, lng, phone, website, domain, rating, review_count, is_chain, chain_brand, google_url, first_seen, last_seen, source_queries_json, details_fetched)
- `search_cells` (id PK, parent_id, lat, lng, zoom, query, level, status [pending/done/saturated/error], result_count, attempts, done_at)
- `emails` (id PK, cid FK, email, source_url, confidence, found_at)
- `crawl_log` (ts, stage, key, outcome, note) — for diagnosing blocks.

## Anti-blocking strategy (the main risk)

- Run headed or `headless: 'new'` Chromium with a persistent user profile so cookies and consent survive.
- 2–3 browser contexts in parallel, random 2–6s delays between actions, 5–15s between searches per context.
- Detect the "unusual traffic" / CAPTCHA page. On detection: pause that context, exponential backoff (5 min, 15, 45, 2 h), alert in the console. Never hammer through it.
- Rotate query order per cell so traffic looks less mechanical.
- If home IP gets blocked repeatedly: add a residential proxy (Webshare / IPRoyal, ~$50–100 for enough GB). Config supports `PROXY_URL` from day one.
- Throughput estimate: ~15–25 s per search including scrolling, 3 contexts → ~500–700 searches/hour → full grid in 12–20 hours of scraping. Spread over 3–5 days at a gentler pace to stay under the radar.

## Expected output size

| Segment | Estimate |
|---|---|
| U-Haul dealers + centers | ~20,000 |
| Other chains (Penske, Home Depot, Sunbelt, etc.) | ~3,000–5,000 |
| Independent trailer rental / dealer businesses | ~6,000–10,000 |
| **Total unique rows** | **~30,000–35,000** |
| Rows with an email | ~10,000–15,000 |

## Build order and timeline

| Phase | Work | Effort |
|---|---|---|
| 1 | Repo scaffold, config, SQLite schema, grid + city seeding, land mask | 1 day |
| 2 | Search scraper: page load, scroll, JSON parse, saturation split, block detection | 2 days |
| 3 | Pilot run on Utah only. Verify counts against a manual spot check of 50 rows. Tune queries and cell size. | 1 day |
| 4 | Details stage + dedupe + chain flagging | 1 day |
| 5 | Email crawler | 1 day |
| 6 | Full US run on Nathan's machine (unattended, resumable) | 3–5 days wall clock |
| 7 | Export, QA, final CSV | 0.5 day |

## Optional cheap supplements (later, if wanted)

- **U-Haul dealer locator** has a public location search. Pulling it directly gives a clean, complete list of ~20k U-Haul points for cross-checking grid coverage.
- **Yelp Fusion API** free tier (500 calls/day) for the "Trailer Rental" category as a second source for dedupe confidence.
- **Plan B if Google blocks hard:** Outscraper's Maps export is roughly $3 per 1,000 records. Pulling 35k rows fits the budget at ~$100 and the rest of this pipeline (emails, dedupe, export) works unchanged on its CSV.

## Risks

- **Google ToS.** Scraping Maps breaches Google's terms. Practical consequence is IP blocking, not legal action for public business data, but it is a real breach. Places API or Outscraper are the compliant alternatives.
- **Layout changes.** Mitigated by parsing the embedded JSON rather than the DOM, but the JSON shape can also shift. The parser is isolated in one module with fixture tests.
- **Rural gaps.** Grid centroid search at zoom 10 may miss small towns. City seeding covers this.
- **Email false positives.** Web forms with no email, or shared emails (gmail accounts) are common. Confidence column lets you filter.
- **Time.** The full run is multi-day on one residential IP. Rushing it triggers blocks.

## Repo layout (proposed)

```
leadscraper/
  package.json          # scripts: seed, search, details, emails, enrich, dedupe, export
  tsconfig.json
  config.ts             # queries, category allowlist, grid size, concurrency, delays, PROXY_URL
  src/
    db.ts               # better-sqlite3 schema + migrations
    grid.ts             # cell generation, land mask, subdivision
    maps/
      browser.ts        # Playwright launch, profile, block detection, backoff
      search.ts         # per-cell search, scroll, saturation
      parse.ts          # APP_INITIALIZATION_STATE parser (fixture-tested)
      details.ts        # per-place detail fetch
    emails/
      crawl.ts          # site crawl + extraction
    enrich.ts           # chain detection, address parse
    dedupe.ts
    export.ts
    cli.ts
  data/
    us_land.geojson     # Natural Earth low-res
    uscities.csv        # simplemaps free tier
  test/
    fixtures/           # saved Maps HTML for parser tests
```
