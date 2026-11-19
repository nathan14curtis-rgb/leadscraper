#!/usr/bin/env node
import { config } from '../config.ts';
import { type DB, openDb } from './db.ts';
import { runDedupe } from './dedupe.ts';
import { runEmails } from './emails/crawl.ts';
import { runEnrich } from './enrich.ts';
import { runExport } from './export.ts';
import { type Cell, LandMask, gridCells, insertCell, readCities } from './grid.ts';
import { runDetails } from './maps/details.ts';
import { runSearch } from './maps/search.ts';

type Flags = Record<string, string | boolean>;

export function parseArgs(argv: string[]): { cmd: string; flags: Flags } {
  const [cmd = 'help', ...rest] = argv;
  const flags: Flags = {};
  for (const a of rest) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] ?? true;
  }
  return { cmd, flags };
}
const numFlag = (f: Flags, k: string) => (typeof f[k] === 'string' ? Number(f[k]) : undefined);
const strFlag = (f: Flags, k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);

function seed(db: DB, flags: Flags) {
  const region = strFlag(flags, 'region');
  const states = region && region.toLowerCase() !== 'all' ? region.split(',').map((s) => s.trim().toUpperCase()) : undefined;
  const mask = new LandMask(undefined, states);

  if (flags.reset) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM search_cells`).get() as { n: number }).n;
    console.log(`Clearing ${n.toLocaleString()} planned searches (places are kept)…`);
    // Every row is being deleted, so the self-reference check is pointless; skip it.
    db.pragma('foreign_keys = OFF');
    db.exec(`DELETE FROM search_cells`);
    db.pragma('foreign_keys = ON');
    console.log('Cleared.');
  }
  let rows = 0;
  let cells = 0;
  db.transaction(() => {
    if (!flags['cities-only']) {
      for (const c of gridCells(mask)) {
        rows += insertCell(db, c, null);
        cells++;
      }
    }
    if (!flags['no-cities']) {
      const minPop = numFlag(flags, 'min-pop') ?? config.cities.minPopulation;
      for (const city of readCities()) {
        if (city.population < minPop) continue;
        if (states && !states.includes(city.state)) continue;
        const cell: Cell = { kind: 'city', lat: city.lat, lng: city.lng, size: config.cities.cellSize, zoom: config.cities.zoom, level: 0 };
        rows += insertCell(db, cell, null);
        cells++;
      }
    }
  })();
  console.log(`Seed: ${cells} cells (${states?.join(',') ?? 'all US'}), ${rows} new cell/query rows.`);
}

function status(db: DB) {
  const cells = db.prepare(`SELECT status, COUNT(*) n FROM search_cells GROUP BY status ORDER BY status`).all() as any[];
  const levels = db
    .prepare(`SELECT kind, level, COUNT(*) n, SUM(status IN ('done','saturated','skipped','error')) finished FROM search_cells GROUP BY kind, level ORDER BY kind, level`)
    .all() as any[];
  const places = db
    .prepare(
      `SELECT COUNT(*) total, SUM(merged_into IS NULL) active, SUM(phone IS NOT NULL) phone, SUM(website IS NOT NULL) website,
         SUM(is_chain) chains, SUM(details_fetched) details FROM places`,
    )
    .get() as any;
  const emails = db.prepare(`SELECT COUNT(DISTINCT cid) places, COUNT(*) n FROM emails`).get() as any;
  const crawls = db.prepare(`SELECT status, COUNT(*) n FROM email_crawls GROUP BY status`).all() as any[];
  const yields = db
    .prepare(
      `SELECT j.value AS query, COUNT(*) AS places, SUM(json_array_length(p.source_queries_json) = 1) AS only_this
       FROM places p, json_each(p.source_queries_json) j WHERE p.merged_into IS NULL GROUP BY j.value ORDER BY places DESC`,
    )
    .all() as any[];
  const blocks = db.prepare(`SELECT COUNT(*) n, MAX(ts) last FROM crawl_log WHERE outcome = 'blocked'`).get() as any;

  console.log('Search cells:');
  for (const c of cells) console.log(`  ${c.status.padEnd(10)} ${c.n}`);
  console.log('By level:');
  for (const l of levels) console.log(`  ${l.kind.padEnd(5)} L${l.level}  ${l.finished}/${l.n}`);
  console.log(
    `Places: ${places.total ?? 0} (${places.active ?? 0} active), phone ${places.phone ?? 0}, website ${places.website ?? 0}, chains ${places.chains ?? 0}, detail visits ${places.details ?? 0}`,
  );
  console.log(`Emails: ${emails.n} across ${emails.places} places; domain crawls: ${crawls.map((c) => `${c.status}=${c.n}`).join(', ') || 'none'}`);
  if (yields.length) {
    console.log('Query yield (places found / found by this query only):');
    for (const y of yields) console.log(`  ${y.query.padEnd(24)} ${String(y.places).padStart(6)} / ${y.only_this}`);
  }
  console.log(`Blocks logged: ${blocks.n}${blocks.last ? ` (last ${blocks.last})` : ''}`);
}

const HELP = `leadscraper <command> [flags]

  seed      [--region=UT|UT,ID|all] [--no-cities] [--cities-only] [--min-pop=10000] [--reset]
  search    [--contexts=3] [--limit=N] [--save-fixtures] [--retry-errors]
  details   [--contexts=3] [--limit=N]
  emails    [--limit=N] [--no-browser] [--retry-errors]
  enrich
  dedupe
  export    [--no-chains] [--state=UT] [--has-email] [--min-confidence=50] [--in-scope-only] [--all-scopes] [--out=out]
  status

Environment: DB_PATH, PROXY_URL, CONTEXTS, HEADLESS, CHROMIUM_PATH, … (see config.ts)`;

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (cmd === 'help' || flags.help) return console.log(HELP);
  const db = openDb();
  try {
    switch (cmd) {
      case 'seed':
        return seed(db, flags);
      case 'search':
        return await runSearch(db, { contexts: numFlag(flags, 'contexts'), limit: numFlag(flags, 'limit'), saveFixtures: !!flags['save-fixtures'], retryErrors: !!flags['retry-errors'] });
      case 'details':
        return await runDetails(db, { contexts: numFlag(flags, 'contexts'), limit: numFlag(flags, 'limit') });
      case 'emails':
        return await runEmails(db, { limit: numFlag(flags, 'limit'), noBrowser: !!flags['no-browser'], retryErrors: !!flags['retry-errors'] });
      case 'enrich':
        return runEnrich(db);
      case 'dedupe':
        return runDedupe(db);
      case 'export':
        return runExport(db, {
          noChains: !!flags['no-chains'],
          state: strFlag(flags, 'state'),
          hasEmail: !!flags['has-email'],
          minConfidence: numFlag(flags, 'min-confidence'),
          outDir: strFlag(flags, 'out'),
          inScopeOnly: !!flags['in-scope-only'],
          allScopes: !!flags['all-scopes'],
        });
      case 'status':
        return status(db);
      default:
        console.error(`Unknown command "${cmd}".\n\n${HELP}`);
        process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
