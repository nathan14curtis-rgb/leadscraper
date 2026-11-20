/**
 * Turns the outside hosts a site uses (site_hosts) into booking_vendor, booking_type and
 * site_builder, and prints the `hosts` report used to find new vendor patterns.
 * Labels are recomputed from stored hosts, so editing config.vendors needs no re-crawl:
 * run `npm run hosts -- --relabel`.
 */
import { config } from '../../config.ts';
import type { DB } from '../db.ts';

export type BookingType = 'own_customer' | 'competitor' | 'generic_booking' | 'none';
export interface SiteLabel {
  bookingVendor: string | null;
  bookingType: BookingType;
  siteBuilder: string | null;
}
export interface HostRow {
  host: string;
  kind: string;
}

const PRIORITY: Record<string, number> = { own_customer: 0, competitor: 1, generic_booking: 2 };

const matches = (rows: HostRow[], hosts: RegExp[], markers: string[]) =>
  rows.some((r) => (r.kind === 'marker' ? markers.includes(r.host) : hosts.some((re) => re.test(r.host))));

export function classifySite(rows: HostRow[], bookingCta: boolean): SiteLabel {
  const vendor = config.vendors
    .filter((v) => matches(rows, v.hosts, v.markers))
    .sort((a, b) => PRIORITY[a.type] - PRIORITY[b.type])[0];
  const builder = config.siteBuilders.find((b) => matches(rows, b.hosts, b.markers));
  return {
    bookingVendor: vendor?.vendor ?? null,
    // A Book / Reserve button with no known vendor behind it still means online booking.
    bookingType: vendor?.type ?? (bookingCta ? 'generic_booking' : 'none'),
    siteBuilder: builder?.builder ?? null,
  };
}

/** Writes labels onto every place whose domain was crawled successfully (or just `domain`). */
export function labelVendors(db: DB, domain?: string) {
  const crawls = db
    .prepare(`SELECT domain, booking_cta FROM email_crawls WHERE status = 'done' AND is_seed = 0 ${domain ? 'AND domain = ?' : ''}`)
    .all(...(domain ? [domain] : [])) as { domain: string; booking_cta: number | null }[];
  const hostsFor = db.prepare(`SELECT host, kind FROM site_hosts WHERE domain = ?`);
  const upd = db.prepare(`UPDATE places SET booking_vendor = ?, booking_type = ?, site_builder = ? WHERE domain = ?`);
  for (const c of crawls) {
    const l = classifySite(hostsFor.all(c.domain) as HostRow[], c.booking_cta === 1);
    upd.run(l.bookingVendor, l.bookingType, l.siteBuilder, c.domain);
  }
  return crawls.length;
}

const isNoise = (host: string) => config.hostNoise.some((re) => re.test(host));
const vendorFor = (host: string) =>
  config.vendors.find((v) => v.hosts.some((re) => re.test(host)))?.vendor ??
  config.siteBuilders.find((b) => b.hosts.some((re) => re.test(host)))?.builder ??
  '';

/**
 * `hosts`: outside hosts ranked by how many trailer sites use them (noise hidden), so booking
 * vendors rise to the top. `--seeds` instead lists each seed site's hosts, to read a known
 * vendor customer's fingerprint.
 */
export function runHostsReport(db: DB, opts: { seeds?: boolean; all?: boolean; limit?: number; relabel?: boolean } = {}) {
  if (opts.relabel) {
    db.transaction(() => labelVendors(db))();
    console.log('Relabelled booking vendors and site builders from stored hosts.');
  }
  if (opts.seeds) {
    const rows = db
      .prepare(
        `SELECT h.domain, h.host, GROUP_CONCAT(DISTINCT h.kind) kinds, MIN(h.example_url) example
         FROM site_hosts h JOIN email_crawls c ON c.domain = h.domain
         WHERE c.is_seed = 1 GROUP BY h.domain, h.host ORDER BY h.domain, h.host`,
      )
      .all() as { domain: string; host: string; kinds: string; example: string }[];
    let current = '';
    for (const r of rows) {
      if (!opts.all && r.kinds !== 'marker' && isNoise(r.host)) continue;
      if (r.domain !== current) console.log(`\n${(current = r.domain)}`);
      console.log(`  ${r.host.padEnd(40)} ${r.kinds.padEnd(22)} ${vendorFor(r.host).padEnd(18)} ${r.example ?? ''}`);
    }
    if (!rows.length) console.log('No seed sites crawled yet. Run: npm run site -- --urls=data/seed_sites.txt');
    return;
  }
  const total = (db.prepare(`SELECT COUNT(*) n FROM email_crawls WHERE status = 'done' AND is_seed = 0`).get() as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT h.host, COUNT(DISTINCT h.domain) sites, GROUP_CONCAT(DISTINCT h.kind) kinds, MIN(h.example_url) example
       FROM site_hosts h JOIN email_crawls c ON c.domain = h.domain
       WHERE c.is_seed = 0 GROUP BY h.host ORDER BY sites DESC, h.host`,
    )
    .all() as { host: string; sites: number; kinds: string; example: string }[];
  const shown = rows.filter((r) => opts.all || !isNoise(r.host)).slice(0, opts.limit ?? 60);
  console.log(`Outside hosts across ${total} crawled sites${opts.all ? '' : ' (common noise hidden; --all to show)'}:\n`);
  console.log(`${'sites'.padStart(6)}  ${'host'.padEnd(40)} ${'kinds'.padEnd(22)} ${'label'.padEnd(18)} example`);
  for (const r of shown)
    console.log(`${String(r.sites).padStart(6)}  ${r.host.padEnd(40)} ${r.kinds.padEnd(22)} ${vendorFor(r.host).padEnd(18)} ${r.example ?? ''}`);
  const types = db
    .prepare(`SELECT COALESCE(booking_type, 'not crawled') t, COUNT(*) n FROM places WHERE merged_into IS NULL GROUP BY t ORDER BY n DESC`)
    .all() as { t: string; n: number }[];
  console.log(`\nBooking type per place: ${types.map((t) => `${t.t}=${t.n}`).join(', ')}`);
}
