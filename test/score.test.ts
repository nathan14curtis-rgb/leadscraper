import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { runEnrich } from '../src/enrich.ts';
import { LEAD_COLUMNS, runExport } from '../src/export.ts';
import { runGroups } from '../src/groups.ts';
import { upsertPlace } from '../src/places.ts';
import { type ScoreInput, leadScore, sizeBand } from '../src/score.ts';

const now = new Date('2026-11-19T12:00:00Z');
const base: ScoreInput = {
  segment: 'single_yard', scope: 'in_scope', is_chain: 0, reviews_12m: 25, last_review_at: '2026-11-01',
  booking_type: 'none', website: 'https://a.com/', phone: '(801) 555-0100', domain_email: 1, location_count: 1,
};

describe('leadScore', () => {
  it('gives 100 to the ideal single yard', () => {
    expect(leadScore(base, now)).toBe(100);
  });
  it('applies the plan weights', () => {
    expect(leadScore({ ...base, segment: 'multi_location' }, now)).toBe(90);
    expect(leadScore({ ...base, reviews_12m: 7 }, now)).toBe(95);
    expect(leadScore({ ...base, reviews_12m: 2, last_review_at: '2026-03-01' }, now)).toBe(75);
    expect(leadScore({ ...base, booking_type: 'competitor' }, now)).toBe(95);
    expect(leadScore({ ...base, scope: 'needs_check', domain_email: 0, phone: null }, now)).toBe(70);
  });
  it('treats no website as no online booking, and an uncrawled site as unknown', () => {
    expect(leadScore({ ...base, booking_type: null, website: null }, now)).toBe(100);
    expect(leadScore({ ...base, booking_type: null }, now)).toBe(85);
  });
  it('does not score chains, out-of-scope rows or Lockii customers', () => {
    expect(leadScore({ ...base, is_chain: 1 }, now)).toBeNull();
    expect(leadScore({ ...base, scope: 'out_of_scope' }, now)).toBeNull();
    expect(leadScore({ ...base, booking_type: 'own_customer' }, now)).toBeNull();
  });
});

describe('sizeBand', () => {
  it('bands by recent reviews and locations', () => {
    expect(sizeBand({ is_chain: 0, reviews_12m: 3, location_count: 1 })).toBe('small');
    expect(sizeBand({ is_chain: 0, reviews_12m: 8, location_count: 1 })).toBe('medium');
    expect(sizeBand({ is_chain: 0, reviews_12m: 1, location_count: 3 })).toBe('large');
    expect(sizeBand({ is_chain: 0, reviews_12m: null, location_count: 1 })).toBeNull();
  });
});

describe('enrich → groups → export', () => {
  it('ranks leads, applies segment filters and hides Lockii customers', () => {
    const db = openDb(':memory:');
    const add = (cid: string, name: string, extra: Record<string, unknown> = {}) =>
      upsertPlace(db, {
        cid, name, categories: ['Trailer rental service'], address: `${cid} Main St, Provo, UT 84601`, lat: 40.2, lng: -111.6,
        phone: `801555${cid.padStart(4, '0')}`, ...extra,
      });
    add('1', 'Busy Trailers');
    add('2', 'Quiet Trailers');
    add('3', 'Two Yards Trailers', { website: 'https://twoyards.com/' });
    add('4', 'Two Yards Trailers Ogden', { website: 'https://twoyards.com/ogden', lat: 41.2, lng: -111.97 });
    add('5', 'Lockii Customer Trailers', { website: 'https://lc.com/' });
    add('6', 'U-Haul Neighborhood Dealer', { categories: ['Truck rental agency'] });
    runEnrich(db);
    runGroups(db);
    db.prepare(`UPDATE places SET reviews_12m = 30, last_review_at = date('now') WHERE cid = '1'`).run();
    db.prepare(`UPDATE places SET booking_type = 'own_customer', booking_vendor = 'Lockii' WHERE cid = '5'`).run();

    const out = mkdtempSync(join(tmpdir(), 'leads-'));
    runExport(db, { outDir: out });
    const lines = readFileSync(join(out, 'leads.csv'), 'utf8').trim().split('\n');
    expect(lines[0].split(',')).toEqual([...LEAD_COLUMNS]);
    const names = lines.slice(1).map((l) => l.split(',')[2]);
    expect(names[0]).toBe('Busy Trailers');
    expect(names).not.toContain('Lockii Customer Trailers');
    expect(names[names.length - 1]).toBe('U-Haul Neighborhood Dealer'); // chains have no score and sort last
    expect(lines.find((l) => l.includes('Two Yards Trailers Ogden'))).toContain('multi_location');

    runExport(db, { outDir: out, segment: 'single_yard', minScore: 60 });
    const filtered = readFileSync(join(out, 'leads.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',')[2]);
    expect(filtered).toEqual(['Busy Trailers', 'Quiet Trailers']);

    runExport(db, { outDir: out, includeCustomers: true });
    expect(readFileSync(join(out, 'leads.csv'), 'utf8')).toContain('Lockii Customer Trailers');
  });
});
