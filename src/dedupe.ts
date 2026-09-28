/**
 * CID is already the primary key, so exact duplicates never exist. This stage merges the
 * same business listed under several CIDs:
 *   1. same normalised phone (toll-free numbers excluded: chains share them)
 *   2. same domain + zip (non-chains only: every Home Depot shares homedepot.com)
 *   3. fuzzy name (Jaro-Winkler >= 0.92) + zip (non-chains only)
 * Every rule also requires the two pins to be within MAX_KM when both have coordinates,
 * so a multi-location independent that uses one phone number keeps all its locations.
 */
import type { DB } from './db.ts';
import { haversineKm, isTollFree, jaroWinkler, normalizeName, normalizePhone } from './normalize.ts';

const MAX_KM = 1.5;
const NAME_SIM = 0.92;

interface Row {
  cid: string;
  name: string;
  phone: string | null;
  domain: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  is_chain: number;
  review_count: number | null;
  filled: number;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

const near = (a: Row, b: Row) =>
  a.lat == null || b.lat == null || a.lng == null || b.lng == null || haversineKm(a.lat, a.lng, b.lat, b.lng) <= MAX_KM;

function groupBy(rows: Row[], key: (r: Row) => string | null): Row[][] {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const g = m.get(k);
    g ? g.push(r) : m.set(k, [r]);
  }
  return [...m.values()].filter((g) => g.length > 1);
}

export function findDuplicates(rows: Row[]): Map<string, string[]> {
  const uf = new UnionFind();
  const pairwise = (groups: Row[][], extra: (a: Row, b: Row) => boolean = () => true) => {
    for (const g of groups)
      for (let i = 0; i < g.length; i++)
        for (let j = i + 1; j < g.length; j++) if (near(g[i], g[j]) && extra(g[i], g[j])) uf.union(g[i].cid, g[j].cid);
  };
  pairwise(
    groupBy(rows, (r) => {
      const p = normalizePhone(r.phone);
      return p && !isTollFree(p) ? p : null;
    }),
  );
  const independents = rows.filter((r) => !r.is_chain);
  pairwise(groupBy(independents, (r) => (r.domain && r.zip ? `${r.domain}|${r.zip}` : null)));
  const names = new Map(independents.map((r) => [r.cid, normalizeName(r.name)]));
  pairwise(
    groupBy(independents, (r) => r.zip),
    (a, b) => jaroWinkler(names.get(a.cid)!, names.get(b.cid)!) >= NAME_SIM,
  );

  const clusters = new Map<string, string[]>();
  for (const r of rows) {
    const root = uf.find(r.cid);
    const c = clusters.get(root);
    c ? c.push(r.cid) : clusters.set(root, [r.cid]);
  }
  // key = canonical cid (most complete, then most reviewed), value = cids merged into it
  const byCid = new Map(rows.map((r) => [r.cid, r]));
  const result = new Map<string, string[]>();
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => {
      const ra = byCid.get(a)!;
      const rb = byCid.get(b)!;
      return rb.filled - ra.filled || (rb.review_count ?? 0) - (ra.review_count ?? 0) || a.localeCompare(b);
    });
    result.set(members[0], members.slice(1));
  }
  return result;
}

const FILL_COLUMNS = ['place_id', 'primary_category', 'address_full', 'street', 'city', 'state', 'zip', 'lat', 'lng', 'phone', 'website', 'domain', 'rating', 'review_count'];

export function runDedupe(db: DB) {
  const rows = db
    .prepare(
      `SELECT cid, name, phone, domain, zip, lat, lng, is_chain, review_count,
         (phone IS NOT NULL) + (website IS NOT NULL) + (address_full IS NOT NULL) + (categories_json <> '[]') AS filled
       FROM places WHERE merged_into IS NULL`,
    )
    .all() as Row[];
  const merges = findDuplicates(rows);

  const getSources = db.prepare(`SELECT source_queries_json FROM places WHERE cid = ?`);
  let merged = 0;
  db.transaction(() => {
    for (const [keep, dupes] of merges) {
      const sources = new Set<string>(JSON.parse((getSources.get(keep) as any).source_queries_json));
      for (const d of dupes) {
        for (const s of JSON.parse((getSources.get(d) as any).source_queries_json)) sources.add(s);
        const fill = FILL_COLUMNS.map((c) => `${c} = COALESCE(${c}, (SELECT ${c} FROM places WHERE cid = @d))`).join(', ');
        db.prepare(`UPDATE places SET ${fill} WHERE cid = @keep`).run({ keep, d });
        db.prepare(
          `INSERT INTO emails (cid, email, source_url, confidence, found_at)
           SELECT @keep, email, source_url, confidence, found_at FROM emails WHERE cid = @d
           ON CONFLICT(cid, email) DO UPDATE SET confidence = MAX(confidence, excluded.confidence)`,
        ).run({ keep, d });
        db.prepare(`DELETE FROM emails WHERE cid = ?`).run(d);
        db.prepare(`UPDATE places SET merged_into = ? WHERE cid = ?`).run(keep, d);
        merged++;
      }
      db.prepare(`UPDATE places SET source_queries_json = ? WHERE cid = ?`).run(JSON.stringify([...sources]), keep);
    }
  })();
  console.log(`Dedupe: ${rows.length} active places, merged ${merged} duplicates into ${merges.size} records.`);
}
