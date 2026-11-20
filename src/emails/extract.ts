/** Pure extraction of emails and site signals (hosts, markers, booking CTAs, text) from HTML; crawl.ts fetches. */
import * as cheerio from 'cheerio';
import { config } from '../../config.ts';

export type EmailSource = 'mailto' | 'jsonld' | 'cfemail' | 'text';
export interface FoundEmail {
  email: string;
  source: EmailSource;
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}/gi;
const ASSET_TLD = /\.(png|jpe?g|gif|webp|svg|bmp|ico|css|js|mjs|json|woff2?|ttf|eot|mp4|webm|pdf|zip)$/i;
const JUNK = [
  /sentry/i, /wixpress/i, /example\.(com|org|net)$/i, /no-?reply/i, /do-?not-?reply/i, /@(domain|email|yourdomain|yoursite|website|company)\.com$/i,
  /^(your|name|user|username|email|info@example|test|someone|john\.?doe|jane\.?doe)@/i, /@(doe|test|sample|placeholder)\.(com|net|org)$/i, /@\dx\./i, /@(sentry|wix|squarespace|godaddy|shopify|cloudflare|schema|w3)\./i,
  /\.(local|invalid|test)$/i, /^[0-9a-f]{16,}@/i,
  // Booking/website/marketing platforms whose support or privacy addresses appear in embedded widgets and footers.
  /@([a-z0-9-]+\.)*(booqable|lodgify|checkfront|fareharbor|peek|rezdy|rentmy|rentle|bookingkoala|bookeo|squareup|square|weebly|webflow|duda|jimdo|wordpress|elementor|mailchimp|hubspot|constantcontact|psxdigital|dealerspike|dealeron|dealerinspire|godaddysites|editmysite)\.(com|io|net|co)$/i,
];

/**
 * Real TLDs that start like a common TLD. Anything else of the form ".com<letters>" is a TLD with the next
 * word glued on (e.g. "info@acme.comhours" from "info@acme.com" + "Hours").
 */
const GLUE_TLD = /^(com|net|org|edu|gov|biz|info|us)(?=[a-z])/;
const REAL_LONG_TLDS = new Set(['community', 'company', 'computer', 'network', 'organic', 'education', 'business', 'construction', 'consulting', 'contractors']);

function unglueTld(e: string): string {
  const dot = e.lastIndexOf('.');
  const tld = e.slice(dot + 1);
  if (REAL_LONG_TLDS.has(tld)) return e;
  const m = tld.match(GLUE_TLD);
  return m ? e.slice(0, dot + 1) + m[1] : e;
}

/** Strips a phone number glued onto the front of a local part ("801-555-1234info@…" → "info@…"). */
function unglueLeadingPhone(e: string): string {
  return e.replace(/^[^@]*?\d{3}[-.]?\d{4}(?=[a-z][^@]*@)/, '');
}
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
  e = unglueTld(e);
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

export type HostKind = 'script' | 'iframe' | 'link' | 'form_action' | 'stylesheet' | 'network' | 'marker';
export interface ExternalHost {
  host: string;
  kind: HostKind;
  url: string;
}

export interface PageExtract {
  emails: FoundEmail[];
  contactLinks: string[];
  /** Same-site links that look like booking / inventory pages. */
  bookingLinks: string[];
  textLength: number;
  /** Hosts other than the site's own, from scripts, iframes, links, forms and stylesheets. */
  hosts: ExternalHost[];
  /** ids of config.htmlMarkers found in the raw HTML (builder and vendor fingerprints). */
  markers: string[];
  /** A Book / Reserve / Rent now button or link. */
  bookingCta: boolean;
  /** An inline script that injects more scripts (tag managers, widget loaders). */
  loaderScript: boolean;
  /** Trailer-for-rent phrases in the page text (config.siteTrailerRentalPattern). */
  trailerMentions: number;
  /** The site says it is a U-Haul dealer, or links to uhaul.com. */
  uhaulDealer: boolean;
  /** Visible text without scripts, nav, header and footer, for the later profile stage. */
  cleanText: string;
}

const BOOKING_CTA = /\b(book (now|online|a trailer|your trailer)|reserve (now|online|a trailer|today)|rent (now|online)|check availability|online booking|make a reservation)\b/i;
const BOOKING_LINK = /book|reserv|rent|trailer|inventory|fleet|availability/i;
const UHAUL_TEXT = /\b(authorized|neighborhood)\s+u-?haul\b|\bu-?haul\s+(neighborhood\s+)?dealer\b/i;

const bareHost = (h: string) => h.toLowerCase().replace(/^www\d?\./, '');

export function extractFromHtml(html: string, pageUrl: string): PageExtract {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);
  const siteHost = bareHost(base.hostname);

  const hosts = new Map<string, ExternalHost>();
  const addHost = (raw: string | undefined, kind: HostKind) => {
    if (!raw || /^(mailto|tel|javascript|data|#)/i.test(raw.trim())) return;
    try {
      const u = new URL(raw, base);
      if (!/^https?:$/.test(u.protocol)) return;
      const host = bareHost(u.hostname);
      if (!host || host === siteHost) return;
      const key = `${host}|${kind}`;
      if (!hosts.has(key)) hosts.set(key, { host, kind, url: u.toString().slice(0, 500) });
    } catch {
      /* bad URL */
    }
  };
  $('script[src]').each((_, el) => addHost($(el).attr('src'), 'script'));
  $('iframe[src]').each((_, el) => addHost($(el).attr('src'), 'iframe'));
  $('a[href]').each((_, el) => addHost($(el).attr('href'), 'link'));
  $('form[action]').each((_, el) => addHost($(el).attr('action'), 'form_action'));
  $('link[rel~="stylesheet" i][href]').each((_, el) => addHost($(el).attr('href'), 'stylesheet'));

  const markers = config.htmlMarkers.filter((m) => m.pattern.test(html)).map((m) => m.id);
  const ctaText = $('a, button, input[type="submit"], input[type="button"]')
    .map((_, el) => `${$(el).text()} ${$(el).attr('value') ?? ''} ${$(el).attr('aria-label') ?? ''}`)
    .get()
    .join(' | ');
  const bookingCta = BOOKING_CTA.test(ctaText);
  const loaderScript = $('script:not([src])')
    .map((_, el) => $(el).text())
    .get()
    .some((t) => /createElement\(\s*['"]script['"]\s*\)/.test(t));
  const found = new Map<string, EmailSource>();
  const add = (raw: string | null | undefined, source: EmailSource) => {
    const e = raw && cleanEmail(source === 'text' ? unglueLeadingPhone(raw.toLowerCase()) : raw);
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

  const contactLinks = new Set<string>();
  const bookingLinks = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const text = $(el).text();
    const isContact = /contact|about|reach|location/i.test(`${href} ${text}`);
    const isBooking = BOOKING_LINK.test(`${href} ${text}`);
    if (!isContact && !isBooking) return;
    try {
      const u = new URL(href, base);
      if (bareHost(u.hostname) !== siteHost) return;
      if (!/^https?:$/.test(u.protocol)) return;
      u.hash = '';
      (isContact ? contactLinks : bookingLinks).add(u.toString());
    } catch {
      /* bad href */
    }
  });

  $('script, style, noscript, svg, template').remove();
  // cheerio's .text() joins adjacent elements with no whitespace, gluing an email to the label or
  // phone number before it and the word after it. Pad block-level elements and line breaks first.
  $('br').replaceWith(' ');
  $('p, div, li, td, th, tr, h1, h2, h3, h4, h5, h6, section, article, header, footer, nav, aside, address, dt, dd, label, button, a, span')
    .before(' ')
    .after(' ');
  const text = $('body').text().replace(/\s+/g, ' ');
  const trailerMentions = [...text.matchAll(config.siteTrailerRentalPattern)].length;
  const uhaulDealer = UHAUL_TEXT.test(text) || [...hosts.values()].some((h) => /(^|\.)uhaul\.com$/.test(h.host) && h.kind !== 'stylesheet');
  $('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], form, iframe').remove();
  const cleanText = $('body').text().replace(/\s+/g, ' ').trim();
  const deobfuscated = text
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@')
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, '.');
  for (const m of deobfuscated.matchAll(EMAIL_RE)) add(m[0], 'text');
  // Emails in raw attributes/inline scripts that the text pass can't see.
  // Decode %20 etc. first so "mailto:%20john@…" isn't read as "20john@…".
  for (const m of html.replace(/%[0-9a-f]{2}/gi, ' ').matchAll(EMAIL_RE)) add(m[0], 'text');

  // A text-pass address that is another found address with junk glued on the front
  // ("usinfo@acme.com" next to "info@acme.com") is a parsing artifact.
  for (const [e, source] of [...found]) {
    if (source !== 'text') continue;
    if ([...found.keys()].some((f) => f !== e && e.endsWith(f))) found.delete(e);
  }

  return {
    emails: [...found].map(([email, source]) => ({ email, source })),
    contactLinks: [...contactLinks],
    bookingLinks: [...bookingLinks],
    textLength: text.length,
    hosts: [...hosts.values()],
    markers,
    bookingCta,
    loaderScript,
    trailerMentions,
    uhaulDealer,
    cleanText,
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
