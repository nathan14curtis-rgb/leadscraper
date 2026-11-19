# leadscraper

Finds US trailer-rental businesses (utility, cargo, equipment, car-hauler, boat, horse, livestock and dump trailers, plus trailer dealers that rent) by running an adaptive-grid Google Maps scraper. It then crawls each business website and Maps reviews to build a ranked list of independent trailer renters for callers. See [PLAN.md](PLAN.md) for the design and its trade-offs, including the Google ToS risk.

## Setup

Requires Node 20+.

```sh
npm install
npx playwright install chromium   # or set CHROMIUM_PATH to an existing Chromium
npm test                          # parser / grid / email / pipeline tests
BROWSER_TESTS=1 npm test          # also drives Chromium against a mocked Maps page
```

## Running it

Each stage is resumable, so you can stop with Ctrl-C and re-run the same command to continue. State lives in `leads.db` (SQLite).

```sh
# 1. Pilot: Utah only
npm run seed -- --region=UT
npm run search -- --contexts=2       # watch for "BLOCKED"; it backs off automatically
npm run status                       # progress, and new places contributed by each query
npm run details
npm run enrich && npm run dedupe
npm run site                         # emails, booking vendor, trailer evidence, page text
npm run groups                       # single_yard / multi_location / chain
npm run reviews                      # review recency for independents
npm run export -- --state=UT         # → out/leads.csv (ranked by lead_score), out/leads_emails.csv
npm run qa -- --state=UT             # → out/qa_sample.csv: 100 rows to check by hand

# 2. Full run (multi-day, unattended), only once the Utah QA passes 90%
npm run seed -- --region=all
npm run search                       # re-run after reboots; it picks up where it stopped
npm run details && npm run enrich && npm run dedupe && npm run site && npm run groups && npm run reviews && npm run export
```

While `search`, `details`, `site` and `reviews` run, the bottom of the terminal shows a live status block. It has a spinner, run time, progress, rate and ETA, plus one line per browser saying what it's doing right now (loading, scrolling page 3, pausing 8s, BLOCKED with a countdown). If the spinner is moving, it's running. When output goes to a file instead of a terminal, it prints a one-line heartbeat every minute. Set `NO_PROGRESS=1` to turn the status block off.

```
⠴ search · running 2h 14m · 1,284/9,110 searches done · 3,902 places · 574/hr · ETA ~13h 38m
  w0  "trailer rental" @41.625,-111.875 z11 · scrolling · page 3 · 60 results so far · 4s
  w1  pausing between searches · 9s left
  w2  BLOCKED by Google (strike 1), paused · 4m 12s left
```

| Command | What it does |
|---|---|
| `seed [--region=UT,ID\|all] [--no-cities] [--cities-only] [--min-pop=10000] [--reset]` | Adds grid cells (0.5°, land only) plus one search per city of 10k+ people, with one row per cell/query pair. |
| `search [--contexts=3] [--limit=N] [--save-fixtures] [--retry-errors]` | Runs each pending search and scrolls the list to the end. If a search saturates (≥100 results and ≥90% of them inside the visible map), the cell splits into 4 children and the cell's remaining queries are skipped. Google pads sparse areas with businesses up to ~150 km away, so a full list on its own doesn't mean the area is full. |
| `details [--limit=N]` | Visits place pages missing a phone, website, address or category. |
| `enrich` | Flags chains by name or domain (including U-Haul dealers found by `site`), parses the address into street/city/state/zip, normalizes domains and sets `scope`. |
| `dedupe` | Merges one business listed under several CIDs, matching on phone, domain+zip or fuzzy name+zip, within 1.5 km. |
| `site [--limit=N] [--no-browser] [--retry-errors] [--urls=FILE]` | Crawls each website once, up to 6 pages (home, contact, booking pages). Stores emails, every outside host, booking vendor, trailer-for-rent evidence and cleaned page text. Re-renders pages with a Book button in Chromium. `emails` is an alias. |
| `hosts [--seeds] [--all] [--relabel]` | Ranks outside hosts by how many trailer sites use them, to find booking vendors. See [Vendor detection](#vendor-detection). |
| `groups` | Links independents sharing a domain, a local phone or a near-identical name within 100 km, without merging them. Sets `segment`. |
| `reviews [--limit=N] [--refresh] [--save-fixtures]` | For in-scope independents: review count, reviews in the last 12 months and 90 days, last review date, owner reply share and signing owner name, hours, claimed status. Counts and dates only. |
| `score` | `lead_score` 0–100 and `size_band` (weights in `config.score`). `export` runs it too. |
| `export [--state=UT] [--segment=single_yard] [--min-score=N] [--in-scope-only] [--no-chains] [--has-email] [--include-customers] [--all-scopes] [--out=out]` | Writes `leads.csv` sorted by `lead_score`, and `leads_emails.csv`. Out-of-scope rows and Lockii customers are left out unless asked for. |
| `qa [--n=100] [--state=UT]` | Random in-scope rows with blank pass/fail columns for the four quality tests. |
| `status` | Shows cell progress per level, place and email counts, per-query yield and blocks. |

## Configuration

Settings live in [`config.ts`](config.ts). The usual environment overrides are:

| Variable | Default | |
|---|---|---|
| `PROXY_URL` | — | `http://user:pass@host:port` residential proxy, used for Google traffic only |
| `CONTEXTS` | 3 | parallel browser profiles |
| `HEADLESS` | true | `HEADLESS=false` shows the windows, so you can solve a CAPTCHA by hand during a backoff |
| `SEARCH_DELAY_MIN_MS` / `SEARCH_DELAY_MAX_MS` | 5000 / 15000 | pause between searches per context |
| `GRID_QUERY_COUNT` / `CITY_QUERY_COUNT` | 8 / 3 | how many of the queries run per grid / city cell |
| `GRID_CELL_SIZE`, `GRID_BASE_ZOOM`, `GRID_MAX_LEVEL` | 0.5, 10, 6 | grid shape |
| `DB_PATH`, `OUT_DIR`, `PROFILE_DIR`, `CHROMIUM_PATH` | | paths |

**Sizing:** seeding the full US creates about 4,900 land grid cells and 4,460 city cells. At the default query counts that's about 52k searches before any subdivision, which is several times the plan's estimate. After the Utah pilot, use the `status` query-yield table to see which queries add places nothing else finds, then lower `GRID_QUERY_COUNT` (or reorder `config.queries`) before seeding the full run. At 2 grid queries the full run is about 23k searches.

## How it works

- **Parsing** (`src/maps/parse.ts`): the parser reads Maps' embedded JSON (`APP_INITIALIZATION_STATE`) and the XHRs fired while scrolling, not CSS selectors. It walks the whole payload for arrays that look like place records (a feature id `0x…:0x…` at index 10 and the name at index 11), so it survives changes to where the result list sits. If the JSON yields nothing, it falls back to the result links in the list. Run `search --save-fixtures` during the pilot to capture real payloads into `test/fixtures/captured/` and turn them into fixture tests.
- **Blocking** (`src/maps/browser.ts`): each worker uses a persistent Chromium profile. On a `/sorry/` or "unusual traffic" page the worker pauses for 5 min, then 15 min, 45 min and 2 h. That search goes back in the queue without using up a retry. Network outages are also retried without using an attempt.
- **Scope filter** (`src/places.ts`): a place is kept if Google's category is in the allowlist, or if its name contains "trailer" and it isn't an RV, camper or trailer-park listing. The full category list is stored, so the filter can be tightened later.

## Scope, segment and score

- **Scope:** `in_scope` means a core trailer category (Trailer rental service, trailer dealers) or a name like "X Trailer Rentals". Broad categories (equipment or truck rental, moving supply, trailer repair or supply) start as `needs_check`. `site` then makes them `in_scope` if the website mentions trailers for rent, or `out_of_scope` if it doesn't. Places with no website, or an unreachable one, stay `needs_check` for the caller to confirm.
- **Segment:** `chain` (a known brand, or a U-Haul dealer), `multi_location` (a group of 2+ independent locations, with `location_count` and `group_states`) or `single_yard`.
- **Lead score:**

  | Signal | Points |
  |---|---|
  | `single_yard` (`multi_location` 15) | 25 |
  | Reviews in the last 12 months: 1–4 / 5–19 / 20+ | 5 / 15 / 20 |
  | Last review within 90 days | 10 |
  | No online booking (competitor or other booking tool: 10) | 15 |
  | Valid phone | 10 |
  | Email on the business's own domain | 10 |
  | `in_scope` (not `needs_check`) | 10 |

  Chains, out-of-scope rows and Lockii customers get no score. A business with no website counts as having no online booking. A site that hasn't been crawled scores 0 for booking.

## Vendor detection

The `site` stage records every outside host a website uses. `config.vendors` maps hosts (and HTML markers) to a booking vendor. Evidence behind the current patterns:

| Vendor | Type | Patterns | Evidence |
|---|---|---|---|
| Lockii | own_customer | `*.lockii.app`, `<lockii-*>` elements | Confirmed in customer site code (`book.lockii.app/widget.js`, `dash.lockii.app/widget.js`) |
| Booqable | competitor | `*.booqable.com`, `*.booqableshop.com`, `booqableOptions` | Confirmed (`<uuid>.assets.booqable.com/v2/booqable.js`, `<shop>.booqableshop.com`) |
| HQ Rental Software | competitor | `*.caagcrm.com`, `*.hqrentals.app/.eu/.asia`, `/public/car-rental/` paths | Confirmed in customer site code and the vendor's plugin |
| Automate Boss | competitor | "AutomateBoss" text | Text only: sites are built on HighLevel and no vendor host has been confirmed |
| Big Rentals | competitor | `bigrentals.com`, `hqrent.com` | Not yet seen on a customer site |

Sites with a Book / Reserve button but no known vendor count as `generic_booking`; sites with neither count as `none`.

To refine the patterns:

1. Add known customer sites to `data/seed_sites.txt`.
2. Run `npm run site -- --urls=data/seed_sites.txt`, then `npm run hosts -- --seeds` to read each site's fingerprint.
3. After the real crawl, `npm run hosts` lists outside hosts by how many trailer sites use them, so unknown booking tools rise to the top.
4. Edit `config.vendors` and run `npm run hosts -- --relabel` to re-apply labels without re-crawling.

## Data files

- `data/us_land.geojson` holds US state polygons from Natural Earth 1:50m (public domain).
- `data/uscities.csv` holds US places with population ≥1000 from GeoNames via `all-the-cities` (CC BY 4.0). The columns match simplemaps' `uscities.csv`, so that file can replace it directly.
- Regenerate both with `npm run build-data`.
