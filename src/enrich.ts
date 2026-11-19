import { config } from '../config.ts';
import type { DB } from './db.ts';
import { domainOf, parseUsAddress } from './normalize.ts';
import { refreshScope } from './places.ts';

export function detectChain(name: string, domain: string | null, uhaulDealer = false): string | null {
  for (const c of config.chains) {
    if (c.name.test(name) || (domain && c.domain.test(domain))) return c.brand;
  }
  // Gas stations and storage sites often rent U-Haul equipment under their own name; the
  // site crawl sets uhaul_dealer when their website says so or links to uhaul.com.
  return uhaulDealer ? 'U-Haul dealer' : null;
}

/** Chain flags, address components and domain normalisation. Safe to re-run. */
export function runEnrich(db: DB) {
  const rows = db.prepare(`SELECT cid, name, website, address_full, uhaul_dealer FROM places`).all() as {
    cid: string;
    name: string;
    website: string | null;
    address_full: string | null;
    uhaul_dealer: number;
  }[];
  const upd = db.prepare(
    `UPDATE places SET domain = ?, is_chain = ?, chain_brand = ?, street = ?, city = ?, state = ?, zip = ? WHERE cid = ?`,
  );
  let chains = 0;
  let parsed = 0;
  db.transaction(() => {
    for (const r of rows) {
      const domain = domainOf(r.website);
      const brand = detectChain(r.name, domain, r.uhaul_dealer === 1);
      const a = parseUsAddress(r.address_full);
      if (brand) chains++;
      if (a.state) parsed++;
      upd.run(domain, brand ? 1 : 0, brand, a.street, a.city, a.state, a.zip, r.cid);
    }
    refreshScope(db);
  })();
  const scopes = db.prepare(`SELECT scope, COUNT(*) n FROM places WHERE merged_into IS NULL GROUP BY scope`).all() as { scope: string; n: number }[];
  console.log(
    `Enrich: ${rows.length} places, ${chains} chain locations, ${parsed} with a parsed state. ` +
      `Scope: ${scopes.map((s) => `${s.scope}=${s.n}`).join(', ')}`,
  );
}
