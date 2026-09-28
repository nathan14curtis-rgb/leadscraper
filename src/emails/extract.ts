/** Pure email extraction from HTML; crawl.ts handles fetching. */
import * as cheerio from 'cheerio';

export type EmailSource = 'mailto' | 'jsonld' | 'cfemail' | 'text';
export interface FoundEmail {
  email: string;
  source: EmailSource;
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}/gi;
const ASSET_TLD = /\.(png|jpe?g|gif|webp|svg|bmp|ico|css|js|mjs|json|woff2?|ttf|eot|mp4|webm|pdf|zip)$/i;
const JUNK = [
  /sentry/i, /wixpress/i, /example\.(com|org|net)$/i, /no-?reply/i, /do-?not-?reply/i, /@(domain|email|yourdomain|yoursite|website|company)\.com$/i,
  /^(your|name|user|username|email|info@example|test|someone|john\.?doe|jane\.?doe)@/i, /@\dx\./i, /@(sentry|wix|squarespace|godaddy|shopify|cloudflare|schema|w3)\./i,
  /\.(local|invalid|test)$/i, /^[0-9a-f]{16,}@/i,
];
export const FREEMAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|me|msn|live|comcast|att|sbcglobal|bellsouth|verizon|charter|cox|protonmail|ymail)\.(com|net)$/i;

export function cleanEmail(raw: string): string | null {
  let e = raw.trim().toLowerCase();
  try {
    e = decodeURIComponent(e);
  } catch {
    /* keep as is */
  }
  e = e.replace(/^mailto:/, '').split('?')[0].replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  const m = e.match(new RegExp(`^${EMAIL_RE.source}$`, 'i'));
  if (!m) return null;
  if (ASSET_TLD.test(e) || JUNK.some((re) => re.test(e))) return null;
  return e;
}

/** Cloudflare "email protection" obfuscation: hex string XOR'd with its first byte. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let s = '';
  for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return s;
}

function jsonLdEmails(v: unknown, out: string[], depth = 0) {
  if (depth > 12 || v == null) return;
  if (Array.isArray(v)) return v.forEach((x) => jsonLdEmails(x, out, depth + 1));
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k.toLowerCase() === 'email' && typeof x === 'string') out.push(x);
      else jsonLdEmails(x, out, depth + 1);
    }
  }
}

export interface PageExtract {
  emails: FoundEmail[];
  contactLinks: string[];
  textLength: number;
}

export function extractFromHtml(html: string, pageUrl: string): PageExtract {
  const $ = cheerio.load(html);
  const found = new Map<string, EmailSource>();
  const add = (raw: string | null | undefined, source: EmailSource) => {
    const e = raw && cleanEmail(raw);
    if (e && !found.has(e)) found.set(e, source);
  };

  $('a[href^="mailto:" i]').each((_, el) => add($(el).attr('href'), 'mailto'));
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const list: string[] = [];
      jsonLdEmails(JSON.parse($(el).text()), list);
      list.forEach((e) => add(e, 'jsonld'));
    } catch {
      /* invalid JSON-LD is common */
    }
  });
  $('[data-cfemail]').each((_, el) => add(decodeCfEmail($(el).attr('data-cfemail') ?? ''), 'cfemail'));
  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) =>
    add(decodeCfEmail(($(el).attr('href') ?? '').split('#')[1] ?? ''), 'cfemail'),
  );

  const base = new URL(pageUrl);
  const contactLinks = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const text = $(el).text();
    if (!/contact|about|reach|location/i.test(`${href} ${text}`)) return;
    try {
      const u = new URL(href, base);
      if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return;
      if (!/^https?:$/.test(u.protocol)) return;
      u.hash = '';
      contactLinks.add(u.toString());
    } catch {
      /* bad href */
    }
  });

  $('script, style, noscript, svg').remove();
  const text = $('body').text().replace(/\s+/g, ' ');
  const deobfuscated = text
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@')
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, '.');
  for (const m of deobfuscated.matchAll(EMAIL_RE)) add(m[0], 'text');
  // Emails in raw attributes/inline scripts that the text pass can't see.
  for (const m of html.matchAll(EMAIL_RE)) add(m[0], 'text');

  return {
    emails: [...found].map(([email, source]) => ({ email, source })),
    contactLinks: [...contactLinks],
    textLength: text.length,
  };
}

/** 0-100. Domain-matching and explicitly linked emails rank highest. */
export function scoreEmail(email: string, source: EmailSource, siteDomain: string): number {
  const host = email.split('@')[1];
  const matches = host === siteDomain || host.endsWith(`.${siteDomain}`) || siteDomain.endsWith(`.${host}`);
  let s = matches ? 60 : FREEMAIL.test(email) ? 35 : 15;
  s += source === 'mailto' || source === 'jsonld' ? 25 : source === 'cfemail' ? 20 : 5;
  if (/^(info|sales|rentals?|contact|office|service|hello|admin|support|booking|reservations?)@/.test(email)) s += 10;
  return Math.min(100, s);
}
