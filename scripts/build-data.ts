/**
 * Regenerates the bundled data files:
 *   data/us_land.geojson  - US state polygons (Natural Earth 1:50m admin-1, public domain)
 *   data/uscities.csv     - US places with population >= 1000 (GeoNames via all-the-cities, CC BY 4.0)
 *
 * uscities.csv uses simplemaps-compatible column names (city,state_id,lat,lng,population),
 * so the simplemaps free-tier file can be dropped in as a replacement.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const NE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson';

type Ring = number[][];
const round = (n: number) => Math.round(n * 1000) / 1000;

async function buildLand() {
  const res = await fetch(NE_URL);
  if (!res.ok) throw new Error(`Natural Earth download failed: ${res.status}`);
  const src = (await res.json()) as any;
  const features = src.features
    .filter((f: any) => f.properties.adm0_a3 === 'USA' || f.properties.iso_a2 === 'US')
    .map((f: any) => {
      const g = f.geometry;
      const polys: Ring[][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      return {
        type: 'Feature',
        properties: { postal: f.properties.postal, name: f.properties.name },
        geometry: {
          type: 'MultiPolygon',
          coordinates: polys.map((p) => p.map((r) => r.map(([x, y]) => [round(x), round(y)]))),
        },
      };
    });
  writeFileSync('data/us_land.geojson', JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`us_land.geojson: ${features.length} states`);
}

function buildCities() {
  const require = createRequire(import.meta.url);
  const cities = require('all-the-cities') as Array<{
    name: string;
    country: string;
    adminCode: string;
    population: number;
    loc: { coordinates: [number, number] };
  }>;
  const rows = cities
    .filter((c) => c.country === 'US' && c.population >= 1000)
    .sort((a, b) => b.population - a.population)
    .map((c) => {
      const name = c.name.includes(',') || c.name.includes('"') ? `"${c.name.replace(/"/g, '""')}"` : c.name;
      return `${name},${c.adminCode},${c.loc.coordinates[1]},${c.loc.coordinates[0]},${c.population}`;
    });
  writeFileSync('data/uscities.csv', ['city,state_id,lat,lng,population', ...rows].join('\n') + '\n');
  console.log(`uscities.csv: ${rows.length} places`);
}

await buildLand();
buildCities();
