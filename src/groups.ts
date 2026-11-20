/**
 * Links independent locations that belong to one business, without merging them (dedupe
 * already merges true duplicates within 1.5 km). Two places are in one group when they:
 *   - share a website domain (social and listing hosts excluded), or
 *   - share a non-toll-free phone number, or
 *   - have near-identical names (Jaro-Winkler >= 0.95) and are within 100 km.
 * Every place then gets a segment: chain, multi_location (group of 2+) or single_yard.
 */
import { config } from '../config.ts';
import type { DB } from './db.ts';
import { haversineKm, isTollFree, jaroWinkler, normalizeName, normalizePhone } from './normalize.ts';

const NAME_SIM = 0.95;
const NAME_MAX_KM = 100;

export interface GroupRow {
  cid: string;
  name: string;
  phone: string | null;
  domain: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  is_chain: number;
}

export type Segment = 'single_yard' | 'multi_location' | 'chain';

export interface GroupInfo {
  groupId: string | null;
  locationCount: number;
  groupStates: string | null;
  segment: Segment;
}

const sharedHost = (domain: string) => config.emails.skipDomains.some((d) => domain === d || domain.endsWith(`.${d}`));

export function computeGroups(rows: GroupRow[]): Map<string, GroupInfo> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const linkBy = (list: GroupRow[], key: (r: GroupRow) => string | null) => {
    const first = new Map<string, string>();
    for (const r of list) {
      const k = key(r);
      if (!k) continue;
      const f = first.get(k);
      f ? union(f, r.cid) : first.set(k, r.cid);
    }
  };

  const independents = rows.filter((r) => !r.is_chain);
  linkBy(independents, (r) => (r.domain && !sharedHost(r.domain) ? r.domain : null));
  linkBy(independents, (r) => {
    const p = normalizePhone(r.phone);
    return p && !isTollFree(p) ? p : null;
  });

  // Names: compare within blocks sharing the first 4 normalised characters (near-identical
  // names virtually always do), which keeps this far from O(n^2) on the full US.
  const names = new Map(independents.map((r) => [r.cid, normalizeName(r.name)]));
  const blocks = new Map<string, GroupRow[]>();
  for (const r of independents) {
    const n = names.get(r.cid)!;
    if (n.length < 4) continue;
    const b = blocks.get(n.slice(0, 4));
    b ? b.push(r) : blocks.set(n.slice(0, 4), [r]);
  }
  for (const b of blocks.values())
    for (let i = 0; i < b.length; i++)
      for (let j = i + 1; j < b.length; j++) {
        const [x, y] = [b[i], b[j]];
        if (jaroWinkler(names.get(x.cid)!, names.get(y.cid)!) < NAME_SIM) continue;
        const near = x.lat != null && x.lng != null && y.lat != null && y.lng != null && haversineKm(x.lat, x.lng, y.lat, y.lng) <= NAME_MAX_KM;
        if (near) union(x.cid, y.cid);
      }

  const members = new Map<string, GroupRow[]>();
  for (const r of independents) {
    const root = find(r.cid);
    const m = members.get(root);
    m ? m.push(r) : members.set(root, [r]);
  }
  const out = new Map<string, GroupInfo>();
  for (const r of rows.filter((r) => r.is_chain)) out.set(r.cid, { groupId: null, locationCount: 1, groupStates: null, segment: 'chain' });
  for (const [root, m] of members) {
    const states = [...new Set(m.map((r) => r.state).filter((s): s is string => !!s))].sort().join(',') || null;
    for (const r of m)
      out.set(
        r.cid,
        m.length > 1
          ? { groupId: root, locationCount: m.length, groupStates: states, segment: 'multi_location' }
          : { groupId: null, locationCount: 1, groupStates: r.state, segment: 'single_yard' },
      );
  }
  return out;
}

export function runGroups(db: DB) {
  const rows = db
    .prepare(
      `SELECT cid, name, phone, domain, state, lat, lng, is_chain FROM places
       WHERE merged_into IS NULL AND COALESCE(scope, '') <> 'out_of_scope'`,
    )
    .all() as GroupRow[];
  const groups = computeGroups(rows);
  const upd = db.prepare(`UPDATE places SET group_id = ?, location_count = ?, group_states = ?, segment = ? WHERE cid = ?`);
  db.transaction(() => {
    db.prepare(`UPDATE places SET group_id = NULL, location_count = NULL, group_states = NULL, segment = NULL`).run();
    for (const [cid, g] of groups) upd.run(g.groupId, g.locationCount, g.groupStates, g.segment, cid);
  })();
  const counts = { single_yard: 0, multi_location: 0, chain: 0 };
  for (const g of groups.values()) counts[g.segment]++;
  const nGroups = new Set([...groups.values()].map((g) => g.groupId).filter(Boolean)).size;
  console.log(
    `Groups: ${counts.single_yard} single yards, ${counts.multi_location} locations in ${nGroups} multi-location businesses, ${counts.chain} chain locations.`,
  );
}
