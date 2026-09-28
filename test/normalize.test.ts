import { describe, expect, it } from 'vitest';
import { domainOf, jaroWinkler, normalizeName, normalizePhone, parseUsAddress, unwrapGoogleUrl } from '../src/normalize.ts';

describe('parseUsAddress', () => {
  it('parses a full address', () => {
    expect(parseUsAddress('1234 S State St Suite 5, Salt Lake City, UT 84115, United States')).toEqual({
      street: '1234 S State St Suite 5', city: 'Salt Lake City', state: 'UT', zip: '84115',
    });
  });
  it('handles multi-part streets, zip+4, full state names and missing streets', () => {
    expect(parseUsAddress('Bldg 2, 55 Main St, Provo, Utah 84601-1234')).toEqual({ street: 'Bldg 2, 55 Main St', city: 'Provo', state: 'UT', zip: '84601' });
    expect(parseUsAddress('Ogden, UT')).toEqual({ street: null, city: 'Ogden', state: 'UT', zip: null });
    expect(parseUsAddress(null)).toEqual({ street: null, city: null, state: null, zip: null });
  });
});

describe('domains and phones', () => {
  it('normalises domains', () => {
    expect(domainOf('https://WWW.Example.com/path?x')).toBe('example.com');
    expect(domainOf('example.org')).toBe('example.org');
    expect(domainOf('/url?q=https://www.foo.com/&sa=U')).toBe('foo.com');
    expect(unwrapGoogleUrl('https://www.google.com/url?q=https://a.com/')).toBe('https://a.com/');
  });
  it('normalises phones', () => {
    expect(normalizePhone('+1 (801) 555-0123')).toBe('8015550123');
    expect(normalizePhone('555-0123')).toBeNull();
  });
});

describe('names', () => {
  it('fuzzy-matches near-identical names', () => {
    expect(jaroWinkler(normalizeName("Bob's Trailer Rental LLC"), normalizeName('Bobs Trailer Rental'))).toBeGreaterThan(0.95);
    expect(jaroWinkler(normalizeName('Acme Trailers'), normalizeName('Zion Equipment Rental'))).toBeLessThan(0.7);
  });
});
