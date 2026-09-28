/** Small pure helpers shared by the scraper, enrich and dedupe stages. */

/** Google sometimes wraps outbound links as /url?q=<target>. */
export function unwrapGoogleUrl(url: string): string {
  try {
    const u = new URL(url, 'https://www.google.com');
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/url') {
      return u.searchParams.get('q') ?? u.searchParams.get('url') ?? url;
    }
  } catch {
    /* not a URL */
  }
  return url;
}

export function normalizeWebsite(url: string | null | undefined): string | null {
  if (!url) return null;
  let s = unwrapGoogleUrl(url.trim());
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    return new URL(s).toString();
  } catch {
    return null;
  }
}

export function domainOf(url: string | null | undefined): string | null {
  const w = normalizeWebsite(url);
  if (!w) return null;
  const host = new URL(w).hostname.toLowerCase().replace(/^www\d?\./, '').replace(/\.$/, '');
  return host || null;
}

/** Returns 10 US digits, or null if it doesn't look like a NANP number. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

export function isTollFree(phone10: string): boolean {
  return /^8(00|33|44|55|66|77|88)/.test(phone10);
}

export function formatPhone(phone: string | null | undefined): string | null {
  const d = normalizePhone(phone);
  return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (phone ?? null);
}

export const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico',
};
const STATE_BY_NAME = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v.toLowerCase(), k]));

export function stateCode(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (STATES[t.toUpperCase()]) return t.toUpperCase();
  return STATE_BY_NAME[t.toLowerCase()] ?? null;
}

export interface ParsedAddress {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/**
 * Parses Google's one-line US address, e.g.
 *   "1234 S State St Suite 5, Salt Lake City, UT 84115, United States"
 *   "Salt Lake City, UT 84115"            (no street)
 */
export function parseUsAddress(address: string | null | undefined): ParsedAddress {
  const out: ParsedAddress = { street: null, city: null, state: null, zip: null };
  if (!address) return out;
  const parts = address
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length && /^(united states|usa|us)$/i.test(parts[parts.length - 1])) parts.pop();
  if (!parts.length) return out;

  const m = parts[parts.length - 1].match(/^([A-Za-z .]+?)\s*(\d{5})(?:-\d{4})?$|^([A-Za-z .]+)$/);
  if (m) {
    const st = stateCode(m[1] ?? m[3]);
    if (st) {
      out.state = st;
      out.zip = m[2] ?? null;
      parts.pop();
    }
  }
  if (out.state && parts.length) out.city = parts.pop()!;
  if (parts.length) out.street = parts.join(', ');
  return out;
}

/** Lowercase, strip punctuation and legal-entity noise for fuzzy name comparison. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(llc|inc|co|corp|company|ltd|the|of)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Jaro-Winkler similarity in [0, 1]. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aM = new Array(a.length).fill(false);
  const bM = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bM[j] && a[i] === b[j]) {
        aM[i] = bM[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!aM[i]) continue;
    while (!bM[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(lat2 - lat1);
  const dLng = r(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
