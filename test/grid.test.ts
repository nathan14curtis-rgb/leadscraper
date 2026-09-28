import { describe, expect, it } from 'vitest';
import { LandMask, cellKey, gridCells, subdivide } from '../src/grid.ts';

const mask = new LandMask();

describe('LandMask', () => {
  it('locates points', () => {
    expect(mask.stateAt(40.76, -111.89)).toBe('UT'); // Salt Lake City
    expect(mask.stateAt(21.31, -157.86)).toBe('HI'); // Honolulu
    expect(mask.stateAt(61.22, -149.9)).toBe('AK'); // Anchorage
    expect(mask.stateAt(35, -140)).toBeNull(); // Pacific
    expect(mask.stateAt(45.5, -73.6)).toBeNull(); // Montreal
  });
});

describe('grid', () => {
  it('covers Utah with land cells only', () => {
    const ut = new LandMask(undefined, ['UT']);
    const cells = gridCells(ut);
    expect(cells.length).toBeGreaterThan(90);
    expect(cells.length).toBeLessThan(140);
    expect(new Set(cells.map(cellKey)).size).toBe(cells.length);
  });

  it('subdivides into 4 half-size children one zoom deeper', () => {
    const kids = subdivide({ kind: 'grid', lat: 40.25, lng: -111.75, size: 0.5, zoom: 10, level: 0 });
    expect(kids).toHaveLength(4);
    expect(kids.every((k) => k.size === 0.25 && k.zoom === 11 && k.level === 1)).toBe(true);
    expect(kids.map((k) => [k.lat, k.lng]).sort()).toEqual([[40.125, -111.875], [40.125, -111.625], [40.375, -111.875], [40.375, -111.625]].sort());
  });

  it('drops ocean children', () => {
    const kids = subdivide({ kind: 'grid', lat: 34.0, lng: -118.75, size: 0.5, zoom: 10, level: 0 }, mask);
    expect(kids.length).toBeGreaterThan(0);
    expect(kids.length).toBeLessThanOrEqual(4);
  });
});
