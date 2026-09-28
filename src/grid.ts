import { readFileSync } from 'node:fs';
import { config } from '../config.ts';
import type { DB } from './db.ts';

type Ring = [number, number][];
interface StatePoly {
  postal: string;
  bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
  polygons: Ring[][]; // polygon = [outer, ...holes]
}

export class LandMask {
  readonly states: StatePoly[];

  constructor(geojsonPath = 'data/us_land.geojson', only?: string[]) {
    const fc = JSON.parse(readFileSync(geojsonPath, 'utf8'));
    const want = only?.map((s) => s.toUpperCase());
    this.states = fc.features
      .filter((f: any) => !want || want.includes(f.properties.postal))
      .map((f: any) => {
        const polygons: Ring[][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        let [a, b, c, d] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const poly of polygons)
          for (const [x, y] of poly[0]) {
            a = Math.min(a, x);
            b = Math.min(b, y);
            c = Math.max(c, x);
            d = Math.max(d, y);
          }
        return { postal: f.properties.postal, bbox: [a, b, c, d], polygons };
      });
    if (!this.states.length) throw new Error(`No states matched ${only?.join(',')}`);
  }

  /** Returns the state postal code containing the point, or null for water / outside the US. */
  stateAt(lat: number, lng: number): string | null {
    for (const s of this.states) {
      const [a, b, c, d] = s.bbox;
      if (lng < a || lng > c || lat < b || lat > d) continue;
      for (const poly of s.polygons) {
        if (!inRing(lng, lat, poly[0])) continue;
        if (poly.slice(1).some((hole) => inRing(lng, lat, hole))) continue;
        return s.postal;
      }
    }
    return null;
  }

  /** Bounding box covering the selected states. */
  bbox(): [number, number, number, number] {
    return this.states.reduce(
      ([a, b, c, d], s) => [Math.min(a, s.bbox[0]), Math.min(b, s.bbox[1]), Math.max(c, s.bbox[2]), Math.max(d, s.bbox[3])],
      [Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number],
    );
  }

  /**
   * A cell is kept if any of 9 sample points (centre, corners, edge midpoints) is on land,
   * so coastal cells whose centre is offshore still get searched.
   */
  cellTouchesLand(lat: number, lng: number, size: number): boolean {
    const h = size / 2;
    for (const dy of [0, -h, h]) for (const dx of [0, -h, h]) if (this.stateAt(lat + dy, lng + dx)) return true;
    return false;
  }
}

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Cell {
  kind: 'grid' | 'city';
  lat: number;
  lng: number;
  size: number;
  zoom: number;
  level: number;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
export const cellKey = (c: Pick<Cell, 'kind' | 'level' | 'lat' | 'lng'>) => `${c.kind}:${c.level}:${r6(c.lat)}:${r6(c.lng)}`;

/** Level-0 grid cells snapped to a global lattice, filtered to land. */
export function gridCells(mask: LandMask, size = config.grid.cellSize): Cell[] {
  const [minLng, minLat, maxLng, maxLat] = mask.bbox();
  const regions = config.grid.regions
    .map((r) => [Math.max(r.minLng, minLng), Math.max(r.minLat, minLat), Math.min(r.maxLng, maxLng), Math.min(r.maxLat, maxLat)])
    .filter(([a, b, c, d]) => a < c && b < d);
  const cells: Cell[] = [];
  const seen = new Set<string>();
  for (const [a, b, c, d] of regions) {
    for (let y = Math.floor(b / size) * size; y < d; y += size) {
      for (let x = Math.floor(a / size) * size; x < c; x += size) {
        const cell: Cell = { kind: 'grid', lat: r6(y + size / 2), lng: r6(x + size / 2), size, zoom: config.grid.baseZoom, level: 0 };
        const key = cellKey(cell);
        if (seen.has(key) || !mask.cellTouchesLand(cell.lat, cell.lng, size)) continue;
        seen.add(key);
        cells.push(cell);
      }
    }
  }
  return cells;
}

/** Four quadrant children of a saturated cell, filtered to land. */
export function subdivide(cell: Cell, mask?: LandMask): Cell[] {
  const q = cell.size / 4;
  const size = cell.size / 2;
  return [
    [-q, -q],
    [-q, q],
    [q, -q],
    [q, q],
  ]
    .map(([dy, dx]) => ({ kind: cell.kind, lat: r6(cell.lat + dy), lng: r6(cell.lng + dx), size, zoom: cell.zoom + 1, level: cell.level + 1 }))
    .filter((c) => !mask || mask.cellTouchesLand(c.lat, c.lng, c.size));
}

export interface CityRow {
  city: string;
  state: string;
  lat: number;
  lng: number;
  population: number;
}

/** Reads a simplemaps-style CSV (city,state_id,lat,lng,population; extra columns ignored). */
export function readCities(path = 'data/uscities.csv'): CityRow[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (n: string) => header.indexOf(n);
  const [ci, si, la, ln, po] = ['city', 'state_id', 'lat', 'lng', 'population'].map(idx);
  if ([ci, si, la, ln, po].some((i) => i < 0)) throw new Error(`${path}: expected columns city,state_id,lat,lng,population`);
  return lines.slice(1).map((l) => {
    const f = splitCsvLine(l);
    return { city: f[ci], state: f[si], lat: Number(f[la]), lng: Number(f[ln]), population: Number(f[po]) };
  });
}

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') out.push(cur), (cur = '');
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function queriesFor(kind: Cell['kind']): string[] {
  return config.queries.slice(0, kind === 'city' ? config.cityQueryCount : config.gridQueryCount);
}

/** Inserts one pending search row per (cell, query). Existing rows are left alone. */
export function insertCell(db: DB, cell: Cell, parentId: number | null, fromQueryIdx = 0): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO search_cells (parent_id, kind, cell_key, lat, lng, size, zoom, query, query_idx, level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const key = cellKey(cell);
  let n = 0;
  queriesFor(cell.kind).forEach((q, i) => {
    if (i < fromQueryIdx) return;
    n += stmt.run(parentId, cell.kind, key, cell.lat, cell.lng, cell.size, cell.zoom, q, i, cell.level).changes;
  });
  return n;
}
