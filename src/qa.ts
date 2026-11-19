/**
 * `qa`: a random sample of in-scope rows with blank pass/fail columns for the four tests in
 * the lead quality plan, to fill in by hand (rents trailers, phone reaches the business,
 * segment correct, still operating). Open out/qa_sample.csv in a spreadsheet.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import type { DB } from './db.ts';
import { csvCell } from './export.ts';
import { runScore } from './score.ts';

const COLUMNS = [
  'rents_trailers', 'phone_reaches_business', 'segment_correct', 'still_operating', 'notes',
  'name', 'phone', 'website', 'google_url', 'city', 'state', 'segment', 'chain_brand', 'location_count',
  'scope', 'categories', 'reviews_12m', 'last_review_at', 'booking_type', 'booking_vendor', 'lead_score', 'cid',
];

export function runQa(db: DB, opts: { n?: number; state?: string; outDir?: string } = {}) {
  runScore(db, { quiet: true });
  const rows = db
    .prepare(
      `SELECT * FROM places WHERE merged_into IS NULL AND scope = 'in_scope'
         AND COALESCE(booking_type, '') <> 'own_customer' ${opts.state ? 'AND state = @state' : ''}
       ORDER BY random() LIMIT @n`,
    )
    .all({ n: opts.n ?? 100, state: opts.state?.toUpperCase() }) as Record<string, any>[];
  for (const r of rows) r.categories = (JSON.parse(r.categories_json) as string[]).join('; ');
  const outDir = opts.outDir ?? config.outDir;
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'qa_sample.csv');
  writeFileSync(file, [COLUMNS, ...rows.map((r) => COLUMNS.map((c) => r[c]))].map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
  console.log(`QA: ${rows.length} random in-scope rows → ${file}. Mark each test pass/fail; the target is 90% passing all four.`);
}
