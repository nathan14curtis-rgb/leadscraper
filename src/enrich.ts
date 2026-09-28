import { config } from '../config.ts';
import type { DB } from './db.ts';
import { domainOf, parseUsAddress } from './normalize.ts';

export function detectChain(name: string, domain: string | null): string | null {
  for (const c of config.chains) {
    if (c.name.test(name) || (domain && c.domain.test(domain))) return c.brand;
  }
  return null;
}

/** Chain flags, address components and domain normalisation. Safe to re-run. */
export function runEnrich(db: DB) {
  const rows = db.prepare(`SELECT cid, name, website, address_full FROM places`).all() as {
    cid: string;
    name: string;
    website: string | null;
    address_full: string | null;
  }[];
  const upd = db.prepare(
    `UPDATE places SET domain = ?, is_chain = ?, chain_brand = ?, street = ?, city = ?, state = ?, zip = ? WHERE cid = ?`,
  );
  let chains = 0;
  let parsed = 0;
  db.transaction(() => {
    for (const r of rows) {
      const domain = domainOf(r.website);
      const brand = detectChain(r.name, domain);
      const a = parseUsAddress(r.address_full);
      if (brand) chains++;
      if (a.state) parsed++;
      upd.run(domain, brand ? 1 : 0, brand, a.street, a.city, a.state, a.zip, r.cid);
    }
  })();
  console.log(`Enrich: ${rows.length} places, ${chains} chain locations, ${parsed} with a parsed state.`);
}
