import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../config.ts';
import type { PlaceRecord } from '../src/db.ts';
import { openDb } from '../src/db.ts';
import { runDedupe } from '../src/dedupe.ts';
import { detectChain, runEnrich } from '../src/enrich.ts';
import { runExport } from '../src/export.ts';
import { insertCell } from '../src/grid.ts';
import { recordResult, type SearchTask } from '../src/maps/search.ts';
import { isRelevant, upsertPlace } from '../src/places.ts';

const place = (i: number, extra: Partial<PlaceRecord> = {}): PlaceRecord => ({
  cid: String(1000 + i),
  name: `Trailer Place ${i}`,
  categories: ['Trailer rental service'],
  address: `${i} Main St, Provo, UT 84601`,
  lat: 40.2 + i * 0.01,
  lng: -111.6,
  ...extra,
});

describe('isRelevant', () => {
  it('applies allowlist, name rule and RV exclusion', () => {
    expect(isRelevant({ name: 'Joe Hardware', categories: ['Trailer dealer'] })).toBe(true);
    expect(isRelevant({ name: 'Joe Trailer Sales', categories: ['Auto repair shop'] })).toBe(true);
    expect(isRelevant({ name: 'Joe Hardware', categories: ['Hardware store'] })).toBe(false);
    expect(isRelevant({ name: 'Sunny Trailer Park', categories: ['Mobile home park'] })).toBe(false);
    expect(isRelevant({ name: 'Travel Trailer Rentals', categories: ['RV rental agency'] })).toBe(false);
  });
});

describe('search bookkeeping', () => {
  const setup = () => {
    const db = openDb(':memory:');
    insertCell(db, { kind: 'grid', lat: 40.25, lng: -111.75, size: 0.5, zoom: 10, level: 0 }, null);
    const task = (idx: number) => db.prepare('SELECT * FROM search_cells WHERE level = 0 AND query_idx = ?').get(idx) as SearchTask & { status: string };
    return { db, task };
  };

  it('marks an unsaturated search done and leaves later queries pending', () => {
    const { db, task } = setup();
    const r = recordResult(db, task(0), [place(1), place(2, { categories: ['Hardware store'], name: 'Hardware' })]);
    expect(r).toEqual({ kept: 1, saturated: false, children: 0 });
    expect(task(0).status).toBe('done');
    expect(task(1).status).toBe('pending');
  });

  it('splits a saturated cell: skips later queries, children get this and later queries', () => {
    const { db, task } = setup();
    recordResult(db, task(0), []);
    const places = Array.from({ length: config.search.saturationThreshold }, (_, i) => place(i));
    const r = recordResult(db, task(1), places);
    expect(r.saturated).toBe(true);
    expect(task(1).status).toBe('saturated');
    expect(task(2).status).toBe('skipped');
    const kids = db.prepare('SELECT DISTINCT cell_key FROM search_cells WHERE level = 1').all();
    expect(kids).toHaveLength(4);
    const kidQueries = db.prepare('SELECT MIN(query_idx) lo, COUNT(*) n FROM search_cells WHERE level = 1').get() as any;
    expect(kidQueries).toEqual({ lo: 1, n: 4 * (config.queries.length - 1) });
  });
});

describe('enrich → dedupe → export', () => {
  it('flags chains, merges duplicates and writes CSVs', () => {
    const db = openDb(':memory:');
    upsertPlace(db, place(1, { phone: '(801) 555-0001', website: 'https://www.bobstrailers.com/' }), 'trailer rental');
    // Same business, second CID, same phone, 200 m away
    upsertPlace(db, place(2, { name: "Bob's Trailers", lat: 40.211, phone: '801-555-0001' }), 'trailer dealer');
    // Distinct business with the same toll-free phone: must not merge
    upsertPlace(db, place(3, { name: 'U-Haul Neighborhood Dealer', phone: '1-800-468-4285', categories: ['Truck rental agency'] }));
    upsertPlace(db, place(4, { name: 'U-Haul Neighborhood Dealer', phone: '1-800-468-4285', categories: ['Truck rental agency'], lat: 40.24 }));
    db.prepare(`INSERT INTO emails (cid, email, source_url, confidence, found_at) VALUES ('1002', 'bob@bobstrailers.com', 'x', 90, 'now')`).run();

    runEnrich(db);
    expect(db.prepare(`SELECT is_chain, chain_brand, city, state, zip FROM places WHERE cid = '1003'`).get()).toEqual({
      is_chain: 1, chain_brand: 'U-Haul', city: 'Provo', state: 'UT', zip: '84601',
    });
    expect(detectChain('Main Street Hardware', 'uhaul.com')).toBe('U-Haul');

    runDedupe(db);
    const active = db.prepare('SELECT cid FROM places WHERE merged_into IS NULL ORDER BY cid').all().map((r: any) => r.cid);
    expect(active).toEqual(['1001', '1003', '1004']);
    const kept = db.prepare(`SELECT source_queries_json FROM places WHERE cid = '1001'`).get() as any;
    expect(JSON.parse(kept.source_queries_json).sort()).toEqual(['trailer dealer', 'trailer rental']);
    expect(db.prepare(`SELECT cid FROM emails`).all()).toEqual([{ cid: '1001' }]);

    const out = mkdtempSync(join(tmpdir(), 'leads-'));
    runExport(db, { outDir: out, noChains: true });
    const leads = readFileSync(join(out, 'leads.csv'), 'utf8').trim().split('\n');
    expect(leads).toHaveLength(2);
    expect(leads[1]).toContain('bob@bobstrailers.com');
    expect(readFileSync(join(out, 'leads_emails.csv'), 'utf8')).toContain('bob@bobstrailers.com,90');
  });
});
