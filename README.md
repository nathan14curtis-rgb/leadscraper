# leadscraper

Finds US trailer-rental businesses (utility, cargo, equipment, car-hauler, boat, horse, livestock and dump trailers, plus trailer dealers that rent) by running an adaptive-grid Google Maps scraper. It then crawls each business website for email addresses. See [PLAN.md](PLAN.md) for the design and its trade-offs, including the Google ToS risk.

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
npm run emails
npm run export -- --state=UT         # → out/leads.csv, out/leads_emails.csv

# 2. Full run (multi-day, unattended)
npm run seed -- --region=all
npm run search                       # re-run after reboots; it picks up where it stopped
npm run details && npm run enrich && npm run dedupe && npm run emails && npm run export
```

| Command | What it does |
|---|---|
| `seed [--region=UT,ID\|all] [--no-cities] [--cities-only] [--min-pop=10000] [--reset]` | Adds grid cells (0.5°, land only) plus one search per city of 10k+ people, with one row per cell/query pair. |
| `search [--contexts=3] [--limit=N] [--save-fixtures] [--retry-errors]` | Runs each pending search and scrolls the list to the end. If a search saturates (≥100 results), the cell splits into 4 children and the cell's remaining queries are skipped. |
| `details [--limit=N]` | Visits place pages missing a phone, website, address or category. |
| `emails [--limit=N] [--no-browser] [--retry-errors]` | Crawls each website domain once: homepage, `/contact`, `/contact-us`, `/about` and pages linked as contact, up to 6 pages. |
| `enrich` | Flags chains by name or domain, parses the address into street/city/state/zip, and normalizes domains. |
| `dedupe` | Merges one business listed under several CIDs, matching on phone, domain+zip or fuzzy name+zip, within 1.5 km. |
| `export [--no-chains] [--state=UT] [--has-email] [--min-confidence=50] [--out=out]` | Writes the CSV exports. |
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

## Data files

- `data/us_land.geojson` holds US state polygons from Natural Earth 1:50m (public domain).
- `data/uscities.csv` holds US places with population ≥1000 from GeoNames via `all-the-cities` (CC BY 4.0). The columns match simplemaps' `uscities.csv`, so that file can replace it directly.
- Regenerate both with `npm run build-data`.
