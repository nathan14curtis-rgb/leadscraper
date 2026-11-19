import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import type { DB } from './db.ts';
import { deriveScope } from './places.ts';

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
}

export function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

const LEAD_COLUMNS = [
  'cid', 'name', 'primary_category', 'categories', 'street', 'city', 'state', 'zip', 'address_full',
  'phone', 'website', 'domain', 'best_email', 'email_count', 'rating', 'review_count', 'lat', 'lng',
  'is_chain', 'chain_brand', 'scope', 'google_url', 'place_id', 'first_seen', 'last_seen', 'source_queries',
] as const;

export function runExport(db: DB, opts: ExportOptions = {}) {
  const minConf = opts.minConfidence ?? 0;
  const where = ['p.merged_into IS NULL'];
  const params: Record<string, unknown> = { minConf };
  if (opts.noChains) where.push('p.is_chain = 0');
  if (opts.state) {
    where.push('p.state = @state');
    params.state = opts.state.toUpperCase();
  }
  const places = db
    .prepare(
      `SELECT p.*,
         (SELECT email FROM emails e WHERE e.cid = p.cid AND e.confidence >= @minConf ORDER BY confidence DESC, email LIMIT 1) AS best_email,
         (SELECT COUNT(*) FROM emails e WHERE e.cid = p.cid AND e.confidence >= @minConf) AS email_count
       FROM places p WHERE ${where.join(' AND ')}
       ORDER BY p.state, p.city, p.name`,
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
    return true;
  });

  const outDir = opts.outDir ?? config.outDir;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'leads.csv'), csv([[...LEAD_COLUMNS], ...rows.map((p) => LEAD_COLUMNS.map((c) => p[c]))]));

  const cids = new Set(rows.map((r) => r.cid));
  const emails = (
    db
      .prepare(
        `SELECT e.cid, p.name, e.email, e.confidence, e.source_url, p.domain, p.state, p.is_chain
         FROM emails e JOIN places p ON p.cid = e.cid
         WHERE e.confidence >= @minConf ORDER BY p.state, p.name, e.confidence DESC`,
      )
      .all({ minConf }) as Record<string, any>[]
  ).filter((e) => cids.has(e.cid));
  const emailCols = ['cid', 'name', 'email', 'confidence', 'source_url', 'domain', 'state', 'is_chain'];
  writeFileSync(join(outDir, 'leads_emails.csv'), csv([emailCols, ...emails.map((e) => emailCols.map((c) => e[c]))]));

  console.log(`Export: ${rows.length} leads → ${join(outDir, 'leads.csv')}, ${emails.length} emails → ${join(outDir, 'leads_emails.csv')}`);
}
