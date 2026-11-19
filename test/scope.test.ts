import { describe, expect, it } from 'vitest';
import { deriveScope } from '../src/places.ts';

describe('deriveScope', () => {
  it('trusts core trailer categories and "trailer rental" names', () => {
    expect(deriveScope('Wasatch Trailer Co', ['Trailer rental service'], null)).toBe('in_scope');
    expect(deriveScope('Smith Trailer Rentals', ['Equipment rental agency'], null)).toBe('in_scope');
    expect(deriveScope('Rent-A-Trailer', ['Equipment rental agency'], null)).toBe('in_scope');
  });

  it('holds broad categories for the site crawl to decide', () => {
    expect(deriveScope('Ace Tool Hire', ['Equipment rental agency'], null)).toBe('needs_check');
    expect(deriveScope('Ace Tool Hire', ['Equipment rental agency'], 3)).toBe('in_scope');
    expect(deriveScope('Ace Tool Hire', ['Equipment rental agency'], 0)).toBe('out_of_scope');
  });

  it('rejects anything the relevance filter rejects, whatever the site says', () => {
    expect(deriveScope('Sunny Trailer Park', ['Mobile home park'], 5)).toBe('out_of_scope');
    expect(deriveScope('Joe Hardware', ['Hardware store'], null)).toBe('out_of_scope');
  });

  it('treats DOM-only places with no categories as unknown', () => {
    expect(deriveScope('Somewhere LLC', [], null)).toBe('needs_check');
  });
});
