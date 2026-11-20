import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import type { DB } from './db.ts';
import { deriveScope } from './places.ts';
import { runScore } from './score.ts';

export interface ExportOptions {
  noChains?: boolean;
  state?: string;
  hasEmail?: boolean;
  minConfidence?: number;
  outDir?: string;
  /** Only rows confirmed as trailer renters (drops needs_check). */
  inScopeOnly?: boolean;
  /** Also export rows the scope rules rejected. */
  allScopes?: boolean;
  /** single_yard | multi_location | chain */
  segment?: string;
  minScore?: number;
  /** Include businesses already using Lockii (left out by default). */
  includeCustomers?: boolean;
}

export function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

/**
 * Caller-facing columns first, in the order of the lead quality plan (trailer_types, summary
 * and opener come with the later profile stage), then reference columns.
 */
export const LEAD_COLUMNS = [
  'lead_score', 'segment', 'name', 'phone', 'best_email', 'website', 'street', 'city', 'state', 'zip',
  'owner_name', 'location_count', 'group_states', 'rating', 'review_count', 'reviews_12m', 'last_review_at',
  'booking_type', 'booking_vendor', 'site_builder', 'scope', 'google_url',
  'size_band', 'chain_brand', 'reviews_90d', 'owner_replies_pct', 'claimed', 'hours_text', 'primary_category',
  'categories', 'email_count', 'group_id', 'lat', 'lng', 'address_full', 'cid', 'place_id', 'first_seen',
  'last_seen', 'source_queries',
] as const;

export function runExport(db: DB, opts: ExportOptions = {}) {
  runScore(db, { quiet: true }); // scores always reflect the latest groups, site and reviews data
  const minConf = opts.minConfidence ?? 0;
  const where = ['p.merged_into IS NULL'];
  const params: Record<string, unknown> = { minConf };
  if (opts.noChains) where.push('p.is_chain = 0');
  if (opts.state) {
    where.push('p.state = @state');
    params.state = opts.state.toUpperCase();
  }
  if (opts.segment) {
    where.push('p.segment = @segment');
    params.segment = opts.segment;
  }
  if (opts.minScore != null) {
    where.push('p.lead_score >= @minScore');
    params.minScore = opts.minScore;
  }
  if (!opts.includeCustomers) where.push(`COALESCE(p.booking_type, '') <> 'own_customer'`);
  const places = db
    .prepare(
      `SELECT p.*,
         (SELECT email FROM emails e WHERE e.cid = p.cid AND e.confidence >= @minConf ORDER BY confidence DESC, email LIMIT 1) AS best_email,
         (SELECT COUNT(*) FROM emails e WHERE e.cid = p.cid AND e.confidence >= @minConf) AS email_count
       FROM places p WHERE ${where.join(' AND ')}
       ORDER BY p.lead_score IS NULL, p.lead_score DESC, p.state, p.city, p.name`,
    )
    .all(params) as Record<string, any>[];

  const rows = places.filter((p) => {
    const categories: string[] = JSON.parse(p.categories_json);
    p.scope ??= deriveScope(p.name, categories, p.site_trailer_mentions);
    if (p.scope === 'out_of_scope' && !opts.allScopes) return false;
    if (opts.inScopeOnly && p.scope !== 'in_scope') return false;
    if (opts.hasEmail && !p.best_email) return false;
    p.categories = categories.join('; ');
    p.source_queries = JSON.parse(p.source_queries_json).join('; ');
    if (p.claimed != null) p.claimed = p.claimed ? 'yes' : 'no';
    return true;
  });

  const outDir = opts.outDir ?? config.outDir;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'leads.csv'), csv([[...LEAD_COLUMNS], ...rows.map((p) => LEAD_COLUMNS.map((c) => p[c]))]));

  const cids = new Set(rows.map((r) => r.cid));
  const emails = (
    db
      .prepare(
        `SELECT e.cid, p.name, e.email, e.confidence, e.source_url, p.domain, p.state, p.segment, p.lead_score
         FROM emails e JOIN places p ON p.cid = e.cid
         WHERE e.confidence >= @minConf ORDER BY p.lead_score IS NULL, p.lead_score DESC, p.name, e.confidence DESC`,
      )
      .all({ minConf }) as Record<string, any>[]
  ).filter((e) => cids.has(e.cid));
  const emailCols = ['cid', 'name', 'email', 'confidence', 'source_url', 'domain', 'state', 'segment', 'lead_score'];
  writeFileSync(join(outDir, 'leads_emails.csv'), csv([emailCols, ...emails.map((e) => emailCols.map((c) => e[c]))]));

  console.log(`Export: ${rows.length} leads → ${join(outDir, 'leads.csv')}, ${emails.length} emails → ${join(outDir, 'leads_emails.csv')}`);
}
