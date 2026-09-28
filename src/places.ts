import { config } from '../config.ts';
import { type DB, type PlaceRecord, nowIso } from './db.ts';
import { domainOf, formatPhone, normalizeWebsite } from './normalize.ts';

const ALLOW = new Set(config.categoryAllowlist.map((c) => c.toLowerCase()));

/** Scope filter applied to every search result before it is stored. */
export function isRelevant(p: Pick<PlaceRecord, 'name' | 'categories'>): boolean {
  if (p.categories.some((c) => ALLOW.has(c.toLowerCase()))) return true;
  if (!config.nameKeepPattern.test(p.name)) return false;
  return !p.categories.some((c) => config.categoryDenyPattern.test(c)) && !config.categoryDenyPattern.test(p.name);
}

/**
 * Inserts or refreshes a place keyed by CID. New non-null values win; nulls never
 * overwrite data we already have (list results are often sparser than detail pages).
 */
export function upsertPlace(db: DB, p: PlaceRecord, sourceQuery?: string) {
  const now = nowIso();
  const website = normalizeWebsite(p.website);
  const existing = db.prepare('SELECT source_queries_json FROM places WHERE cid = ?').get(p.cid) as
    | { source_queries_json: string }
    | undefined;
  const sources = new Set<string>(existing ? JSON.parse(existing.source_queries_json) : []);
  if (sourceQuery) sources.add(sourceQuery);

  db.prepare(
    `INSERT INTO places (cid, place_id, name, primary_category, categories_json, address_full, lat, lng,
        phone, website, domain, rating, review_count, google_url, first_seen, last_seen, source_queries_json)
     VALUES (@cid, @placeId, @name, @primary, @categories, @address, @lat, @lng,
        @phone, @website, @domain, @rating, @reviews, @url, @now, @now, @sources)
     ON CONFLICT(cid) DO UPDATE SET
        place_id = COALESCE(excluded.place_id, place_id),
        name = excluded.name,
        primary_category = COALESCE(excluded.primary_category, primary_category),
        categories_json = CASE WHEN excluded.categories_json <> '[]' THEN excluded.categories_json ELSE categories_json END,
        address_full = COALESCE(excluded.address_full, address_full),
        lat = COALESCE(excluded.lat, lat),
        lng = COALESCE(excluded.lng, lng),
        phone = COALESCE(excluded.phone, phone),
        website = COALESCE(excluded.website, website),
        domain = COALESCE(excluded.domain, domain),
        rating = COALESCE(excluded.rating, rating),
        review_count = COALESCE(excluded.review_count, review_count),
        last_seen = excluded.last_seen,
        source_queries_json = excluded.source_queries_json`,
  ).run({
    cid: p.cid,
    placeId: p.placeId ?? null,
    name: p.name,
    primary: p.categories[0] ?? null,
    categories: JSON.stringify(p.categories),
    address: p.address ?? null,
    lat: p.lat ?? null,
    lng: p.lng ?? null,
    phone: p.phone ? formatPhone(p.phone) : null,
    website,
    domain: domainOf(website),
    rating: p.rating ?? null,
    reviews: p.reviewCount ?? null,
    url: `https://www.google.com/maps?cid=${p.cid}`,
    now,
    sources: JSON.stringify([...sources]),
  });
}
