/**
 * Google Maps payload parser.
 *
 * Maps ships its data as nested positional JSON arrays, both embedded in the page
 * (window.APP_INITIALIZATION_STATE) and in the XHRs fired while scrolling
 * (/search?tbm=map…) or opening a place (/maps/preview/place…). All of these are
 * prefixed with the XSSI guard `)]}'` and are sometimes double-encoded as strings.
 *
 * Rather than hard-coding the path to the result list (which moves around), we walk the
 * whole tree and pick out any array that looks like a place record: index 10 holds the
 * feature id "0x…:0x…" (whose second half is the CID) and index 11 holds the name.
 * Field offsets inside a place record have been stable for years; they're all read
 * through `at()` so a missing field yields null rather than a crash.
 *
 * Everything Google-shape-specific lives in this file. Fixture tests: test/parse.test.ts.
 */
import type { PlaceRecord } from '../db.ts';

const XSSI = ")]}'";
const FEATURE_ID = /^0x[0-9a-f]+:0x([0-9a-f]+)$/i;

/** Strip the XSSI guard and trailing `/*""*\/` and JSON.parse. Returns undefined if not JSON. */
export function parseGuardedJson(text: string): unknown {
  let t = text.trim();
  if (t.startsWith(XSSI)) t = t.slice(XSSI.length);
  t = t.replace(/\/\*""\*\/\s*$/, '').trim();
  if (!t || (t[0] !== '[' && t[0] !== '{')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Safe positional access: at(a, 4, 7) === a?.[4]?.[7], but never throws on non-arrays. */
export function at(v: unknown, ...path: number[]): unknown {
  let cur: unknown = v;
  for (const i of path) {
    if (!Array.isArray(cur)) return undefined;
    cur = cur[i];
  }
  return cur;
}
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function cidFromFeatureId(fid: string): string | null {
  const m = fid.match(FEATURE_ID);
  return m ? BigInt(`0x${m[1]}`).toString() : null;
}

function looksLikePlace(a: unknown[]): boolean {
  return typeof a[10] === 'string' && FEATURE_ID.test(a[10]) && typeof a[11] === 'string';
}

/**
 * Finds place records anywhere inside a decoded payload. Strings that are themselves
 * guarded JSON (common inside APP_INITIALIZATION_STATE and the `d` field of newer XHRs)
 * are decoded and searched too. A detected place is not searched further, so nested
 * "people also search for" entries don't leak in.
 */
export function extractPlaces(root: unknown): PlaceRecord[] {
  const out = new Map<string, PlaceRecord>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 60 || v == null) return;
    if (typeof v === 'string') {
      if (v.length > 50 && (v.startsWith(XSSI) || v.startsWith('[['))) {
        const inner = parseGuardedJson(v);
        if (inner !== undefined) visit(inner, depth + 1);
      }
      return;
    }
    if (Array.isArray(v)) {
      if (looksLikePlace(v)) {
        const p = placeFromArray(v);
        if (p && !out.has(p.cid)) out.set(p.cid, p);
        return;
      }
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (typeof v === 'object') for (const x of Object.values(v as object)) visit(x, depth + 1);
  };
  visit(root, 0);
  return [...out.values()];
}

/** Decodes one place record array. See the file header for why these offsets. */
export function placeFromArray(a: unknown[]): PlaceRecord | null {
  const cid = cidFromFeatureId(a[10] as string);
  const name = str(a[11]);
  if (!cid || !name) return null;

  const categories = Array.isArray(a[13]) ? (a[13] as unknown[]).map(str).filter((c): c is string => !!c) : [];

  const addressLines = Array.isArray(a[2]) ? (a[2] as unknown[]).map(str).filter(Boolean) : [];
  let address = str(a[39]) ?? (addressLines.length ? addressLines.join(', ') : null);
  if (!address) {
    // a[18] is "Name, full address"
    const full = str(a[18]);
    if (full?.startsWith(`${name}, `)) address = full.slice(name.length + 2);
  }

  let website = str(at(a, 7, 0));
  if (website && website.startsWith('/url?')) website = `https://www.google.com${website}`;

  return {
    cid,
    placeId: str(a[78]),
    name,
    categories,
    address,
    lat: numOrNull(at(a, 9, 2)),
    lng: numOrNull(at(a, 9, 3)),
    phone: str(at(a, 178, 0, 0)) ?? findPhone(a[178]),
    website,
    rating: numOrNull(at(a, 4, 7)),
    // Review count moved from a[4][8] to a[37][1] (seen in real 2026 captures); keep both.
    // Only when a[37] is the [null, count, …] shape; unrated places reuse the slot for photos.
    reviewCount: (at(a, 37, 0) === null ? numOrNull(at(a, 37, 1)) : null) ?? numOrNull(at(a, 4, 8)),
  };
}

const PHONE = /^\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/;
function findPhone(v: unknown, depth = 0): string | null {
  if (depth > 5) return null;
  if (typeof v === 'string') return PHONE.test(v.trim()) ? v.trim() : null;
  if (Array.isArray(v)) for (const x of v) {
    const p = findPhone(x, depth + 1);
    if (p) return p;
  }
  return null;
}

/** Parses any raw payload text (page state JSON, XHR body). */
export function placesFromText(text: string): PlaceRecord[] {
  const root = parseGuardedJson(text);
  return root === undefined ? [] : extractPlaces(root);
}

/**
 * Minimal record from a result-list anchor href, used when JSON parsing yields nothing.
 * Hrefs look like /maps/place/Name/data=!4m7!3m6!1s0x…:0x…!8m2!3d40.7!4d-111.9!16s…
 */
export function placeFromHref(href: string, label: string | null): PlaceRecord | null {
  const fid = href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i)?.[1];
  const cid = fid ? cidFromFeatureId(fid) : null;
  const name = label?.trim() || decodeURIComponent(href.match(/\/maps\/place\/([^/]+)/)?.[1] ?? '').replace(/\+/g, ' ');
  if (!cid || !name) return null;
  const lat = Number(href.match(/!3d(-?[\d.]+)/)?.[1]);
  const lng = Number(href.match(/!4d(-?[\d.]+)/)?.[1]);
  return { cid, name, categories: [], lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null };
}

/** Merge records for the same CID, preferring non-null fields. */
export function mergeRecords(records: PlaceRecord[]): PlaceRecord[] {
  const by = new Map<string, PlaceRecord>();
  for (const r of records) {
    const prev = by.get(r.cid);
    if (!prev) {
      by.set(r.cid, { ...r });
      continue;
    }
    for (const [k, v] of Object.entries(r) as [keyof PlaceRecord, unknown][]) {
      const cur = prev[k];
      const empty = cur == null || (Array.isArray(cur) && cur.length === 0);
      if (empty && v != null) (prev as any)[k] = v;
    }
  }
  return [...by.values()];
}
