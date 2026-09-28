import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cidFromFeatureId, mergeRecords, parseGuardedJson, placeFromHref, placesFromText } from '../src/maps/parse.ts';

// Synthetic payloads shaped like Maps' positional arrays. Replace/extend with real captures
// from `search --save-fixtures` (test/fixtures/captured/) during the pilot run.
const fx = JSON.parse(readFileSync('test/fixtures/maps_synthetic.json', 'utf8'));

describe('parseGuardedJson', () => {
  it('strips the XSSI prefix and trailing comment', () => {
    expect(parseGuardedJson(")]}'\n[1,2]/*\"\"*/")).toEqual([1, 2]);
    expect(parseGuardedJson('not json')).toBeUndefined();
  });
});

describe('cidFromFeatureId', () => {
  it('converts the hex half to a decimal CID without precision loss', () => {
    expect(cidFromFeatureId('0x87528a0b6d2c7e2f:0x5c3f0a2b1d4e6f70')).toBe(BigInt('0x5c3f0a2b1d4e6f70').toString());
    expect(cidFromFeatureId('nope')).toBeNull();
  });
});

describe('placesFromText', () => {
  it('extracts every place from a search XHR', () => {
    const places = placesFromText(fx.xhr);
    expect(places.map((p) => p.name)).toEqual(['Wasatch Trailer Rentals', 'U-Haul Neighborhood Dealer', 'Happy Valley RV Park']);
    const [p] = places;
    expect(p).toMatchObject({
      placeId: 'ChIJ-fake-place-id-1',
      categories: ['Trailer rental service', 'Trailer dealer'],
      address: '1234 S State St, Salt Lake City, UT 84115',
      lat: 40.7401,
      lng: -111.8882,
      phone: '(801) 555-0123',
      website: 'https://wasatchtrailers.example/',
      rating: 4.7,
      reviewCount: 132,
    });
  });

  it('does not descend into nested related places', () => {
    expect(placesFromText(fx.xhr).some((p) => p.name === 'Related Nested Place')).toBe(false);
  });

  it('decodes double-encoded {"d": ")]}\'..."} payloads', () => {
    expect(placesFromText(fx.wrapped).map((p) => p.name)).toEqual(['U-Haul Neighborhood Dealer']);
  });

  it('finds results inside APP_INITIALIZATION_STATE strings', () => {
    expect(placesFromText(fx.state)).toHaveLength(3);
  });

  it('tolerates missing fields', () => {
    const a: unknown[] = [];
    a[10] = '0x1:0xff';
    a[11] = 'Bare Trailer Co';
    const [p] = placesFromText(JSON.stringify([[a]]));
    expect(p).toMatchObject({ cid: '255', name: 'Bare Trailer Co', categories: [], phone: null, website: null, lat: null });
  });
});

describe('placeFromHref', () => {
  it('pulls cid and coordinates from a result link', () => {
    const p = placeFromHref(
      'https://www.google.com/maps/place/Acme+Trailers/data=!4m7!3m6!1s0x87528a0b6d2c7e2f:0x10!8m2!3d40.1234!4d-111.5678!16s%2Fg%2F1',
      'Acme Trailers',
    );
    expect(p).toEqual({ cid: '16', name: 'Acme Trailers', categories: [], lat: 40.1234, lng: -111.5678 });
  });
});

describe('mergeRecords', () => {
  it('fills gaps without overwriting', () => {
    const [m] = mergeRecords([
      { cid: '1', name: 'A', categories: [], phone: null },
      { cid: '1', name: 'B', categories: ['Trailer dealer'], phone: '801' },
    ]);
    expect(m).toMatchObject({ name: 'A', categories: ['Trailer dealer'], phone: '801' });
  });
});
