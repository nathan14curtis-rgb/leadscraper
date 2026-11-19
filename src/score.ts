/**
 * `score`: a 0-100 lead_score for every in-scope (or needs_check) independent, so callers
 * work the list top down, plus a size_band kept separate for filtering. Chains, out-of-scope
 * rows and existing Lockii customers get no score. Weights live in config.score.
 */
import { config } from '../config.ts';
import type { DB } from './db.ts';
import { normalizePhone } from './normalize.ts';

export interface ScoreInput {
  segment: string | null;
  scope: string | null;
  is_chain: number;
  reviews_12m: number | null;
  last_review_at: string | null;
  booking_type: string | null;
  website: string | null;
  phone: string | null;
  /** An email whose domain matches the business's website. */
  domain_email: number;
  location_count: number | null;
}

export function leadScore(r: ScoreInput, now = new Date()): number | null {
  if (r.is_chain || r.scope === 'out_of_scope' || r.booking_type === 'own_customer') return null;
  const w = config.score;
  let s = 0;
  s += r.segment === 'single_yard' ? w.singleYard : r.segment === 'multi_location' ? w.multiLocation : 0;
  const n = r.reviews_12m ?? 0;
  s += n >= 20 ? w.reviews12m[2] : n >= 5 ? w.reviews12m[1] : n >= 1 ? w.reviews12m[0] : 0;
  if (r.last_review_at && now.getTime() - Date.parse(r.last_review_at) < 90 * 86_400_000) s += w.recentReview;
  // No website means no online booking; a crawled site's booking_type says what it has.
  const booking = r.booking_type ?? (r.website ? null : 'none');
  s += booking === 'none' ? w.bookingNone : booking === 'competitor' || booking === 'generic_booking' ? w.bookingOther : 0;
  if (normalizePhone(r.phone)) s += w.phone;
  if (r.domain_email) s += w.domainEmail;
  if (r.scope === 'in_scope') s += w.inScope;
  return s;
}

export function sizeBand(r: Pick<ScoreInput, 'is_chain' | 'reviews_12m' | 'location_count'>): 'small' | 'medium' | 'large' | null {
  if (r.is_chain) return null;
  const locs = r.location_count ?? 1;
  const n = r.reviews_12m;
  if (locs >= 3 || (n ?? 0) >= 20) return 'large';
  if (locs === 2 || (n ?? 0) >= 5) return 'medium';
  return n == null ? null : 'small';
}

export function runScore(db: DB, opts: { quiet?: boolean } = {}) {
  const rows = db
    .prepare(
      `SELECT p.cid, p.segment, p.scope, p.is_chain, p.reviews_12m, p.last_review_at, p.booking_type, p.website, p.phone,
         p.location_count,
         EXISTS (SELECT 1 FROM emails e WHERE e.cid = p.cid AND p.domain IS NOT NULL
                 AND (substr(e.email, instr(e.email, '@') + 1) = p.domain OR e.email LIKE '%.' || p.domain)) AS domain_email
       FROM places p WHERE p.merged_into IS NULL`,
    )
    .all() as (ScoreInput & { cid: string })[];
  const upd = db.prepare(`UPDATE places SET lead_score = ?, size_band = ? WHERE cid = ?`);
  const now = new Date();
  let scored = 0;
  db.transaction(() => {
    for (const r of rows) {
      const s = leadScore(r, now);
      if (s != null) scored++;
      upd.run(s, sizeBand(r), r.cid);
    }
  })();
  if (!opts.quiet) {
    const bands = db
      .prepare(
        `SELECT CASE WHEN lead_score >= 70 THEN '70+' WHEN lead_score >= 50 THEN '50-69' WHEN lead_score >= 30 THEN '30-49' ELSE '<30' END b,
           COUNT(*) n FROM places WHERE lead_score IS NOT NULL AND merged_into IS NULL GROUP BY b ORDER BY MIN(lead_score) DESC`,
      )
      .all() as { b: string; n: number }[];
    console.log(`Score: ${scored} leads scored (${bands.map((b) => `${b.b}: ${b.n}`).join(', ')}).`);
  }
}
