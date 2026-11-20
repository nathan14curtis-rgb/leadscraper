import { describe, expect, it } from 'vitest';
import { type GroupRow, computeGroups } from '../src/groups.ts';

const row = (cid: string, extra: Partial<GroupRow> = {}): GroupRow => ({
  cid, name: `Place ${cid}`, phone: null, domain: null, state: 'UT', lat: 40.7, lng: -111.9, is_chain: 0, ...extra,
});

describe('computeGroups', () => {
  it('groups by shared domain across states', () => {
    const g = computeGroups([
      row('1', { domain: 'acmetrailers.com' }),
      row('2', { domain: 'acmetrailers.com', state: 'ID', lat: 43.6, lng: -116.2 }),
      row('3', { domain: 'other.com' }),
    ]);
    expect(g.get('1')).toEqual({ groupId: '1', locationCount: 2, groupStates: 'ID,UT', segment: 'multi_location' });
    expect(g.get('2')?.groupId).toBe('1');
    expect(g.get('3')).toEqual({ groupId: null, locationCount: 1, groupStates: 'UT', segment: 'single_yard' });
  });

  it('groups by shared local phone but not toll-free or social domains', () => {
    const g = computeGroups([
      row('1', { phone: '(801) 555-0100' }),
      row('2', { phone: '801-555-0100' }),
      row('3', { phone: '1-800-555-0100', domain: 'facebook.com' }),
      row('4', { phone: '1-800-555-0100', domain: 'facebook.com' }),
    ]);
    expect(g.get('2')?.segment).toBe('multi_location');
    expect(g.get('3')?.segment).toBe('single_yard');
    expect(g.get('4')?.segment).toBe('single_yard');
  });

  it('groups near-identical names only within 100 km', () => {
    const g = computeGroups([
      row('1', { name: 'Big Rig Trailer Rentals' }),
      row('2', { name: 'Big Rig Trailer Rentals LLC', lat: 41.2, lng: -112.0 }), // ~55 km
      row('3', { name: 'Big Rig Trailer Rentals', lat: 37.1, lng: -113.6 }), // St George, ~420 km
    ]);
    expect(g.get('1')?.locationCount).toBe(2);
    expect(g.get('3')?.segment).toBe('single_yard');
  });

  it('marks chains and keeps them out of groups', () => {
    const g = computeGroups([row('1', { is_chain: 1, domain: 'uhaul.com' }), row('2', { is_chain: 1, domain: 'uhaul.com' })]);
    expect(g.get('1')).toEqual({ groupId: null, locationCount: 1, groupStates: null, segment: 'chain' });
  });
});
