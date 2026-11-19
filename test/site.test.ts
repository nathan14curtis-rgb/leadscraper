import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { crawlSite, runSite } from '../src/emails/crawl.ts';
import { extractFromHtml } from '../src/emails/extract.ts';
import { classifySite } from '../src/emails/vendors.ts';
import { upsertPlace } from '../src/places.ts';

const home = `<html><head>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto">
  <script src="https://abc123.assets.booqable.com/v2/booqable.js"></script></head>
  <body><nav>Home | Trailers | Contact</nav>
  <h1>Acme Trailers</h1><p>We rent utility trailers and car haulers by the day.</p>
  <a href="/rentals">Book now</a> <a href="/contact">Contact</a>
  <footer>Authorized U-Haul dealer · <a href="https://www.facebook.com/acme">Facebook</a></footer></body></html>`;
const rentals = `<html><body><p>Dump trailer rentals from $79/day.</p>
  <iframe src="https://acme.booqableshop.com/embed"></iframe></body></html>`;
const contact = `<html><body><a href="mailto:rent@acmetrailers.com">Email</a>
  <form action="https://formspree.io/f/xyz"><input type="submit" value="Send"></form></body></html>`;
const toolHire = `<html><body><h1>Ace Tool Hire</h1><p>Mini excavators, compactors and pressure washers.</p></body></html>`;

describe('extractFromHtml site signals', () => {
  const ex = extractFromHtml(home, 'https://www.acmetrailers.com/');
  it('records outside hosts by kind and ignores the site itself', () => {
    const hosts = ex.hosts.map((h) => `${h.kind}:${h.host}`).sort();
    expect(hosts).toEqual(['link:facebook.com', 'script:abc123.assets.booqable.com', 'stylesheet:fonts.googleapis.com']);
  });
  it('finds booking buttons, trailer-rental text and U-Haul dealer evidence', () => {
    expect(ex.bookingCta).toBe(true);
    expect(ex.trailerMentions).toBeGreaterThanOrEqual(1);
    expect(ex.uhaulDealer).toBe(true);
    expect(ex.bookingLinks).toEqual(['https://www.acmetrailers.com/rentals']);
  });
  it('keeps clean text without nav and footer', () => {
    expect(ex.cleanText).toContain('We rent utility trailers');
    expect(ex.cleanText).not.toMatch(/Home \| Trailers|U-Haul/);
  });
  it('sees no trailers on a tool hire site', () => {
    expect(extractFromHtml(toolHire, 'https://acetools.com/').trailerMentions).toBe(0);
  });
});

describe('classifySite', () => {
  it('prefers own customer over competitor over generic booking', () => {
    expect(classifySite([{ host: 'acme.booqableshop.com', kind: 'iframe' }, { host: 'book.lockii.app', kind: 'script' }], true).bookingVendor).toBe('Lockii');
    expect(classifySite([{ host: 'acme.us5.hqrentals.app', kind: 'iframe' }], false)).toEqual({ bookingVendor: 'HQ Rental Software', bookingType: 'competitor', siteBuilder: null });
    expect(classifySite([{ host: 'automateboss-text', kind: 'marker' }, { host: 'leadconnectorhq.com', kind: 'script' }], false)).toEqual({
      bookingVendor: 'Automate Boss', bookingType: 'competitor', siteBuilder: 'HighLevel',
    });
  });
  it('falls back to generic_booking for an unknown Book button, else none', () => {
    expect(classifySite([{ host: 'wordpress', kind: 'marker' }], true)).toEqual({ bookingVendor: null, bookingType: 'generic_booking', siteBuilder: 'WordPress' });
    expect(classifySite([], false).bookingType).toBe('none');
  });
});

describe('site crawl against a local site', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const pages: Record<string, string> = { '/': home, '/rentals': rentals, '/contact': contact };
    server = createServer((req, res) => {
      const body = req.headers.host?.startsWith('localhost') ? (req.url === '/' ? toolHire : undefined) : pages[req.url ?? ''];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' }).end(body ?? 'not found');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('follows booking and contact links and aggregates signals', async () => {
    const r = await crawlSite(`${base}/`, '127.0.0.1');
    expect(r.hosts.map((h) => h.host)).toEqual(expect.arrayContaining(['abc123.assets.booqable.com', 'acme.booqableshop.com', 'formspree.io']));
    expect(r.trailerMentions).toBeGreaterThanOrEqual(2);
    expect(r.emails.map((e) => e.email)).toEqual(['rent@acmetrailers.com']);
    expect(r.pages.map((p) => new URL(p.url).pathname)).toEqual(expect.arrayContaining(['/', '/rentals', '/contact']));
  });

  it('runSite stores hosts, text, vendor labels, scope and U-Haul dealer flags', async () => {
    const db = openDb(':memory:');
    upsertPlace(db, { cid: '1', name: 'Acme Hardware', categories: ['Equipment rental agency'], website: `${base}/` });
    upsertPlace(db, { cid: '2', name: 'Ace Tool Hire', categories: ['Equipment rental agency'], website: `http://localhost:${new URL(base).port}/` });
    await runSite(db, { noBrowser: true });
    const p = (cid: string) => db.prepare(`SELECT * FROM places WHERE cid = ?`).get(cid) as any;
    expect(p('1')).toMatchObject({ booking_vendor: 'Booqable', booking_type: 'competitor', uhaul_dealer: 1, is_chain: 1, chain_brand: 'U-Haul dealer' });
    expect(p('2')).toMatchObject({ scope: 'out_of_scope', site_trailer_mentions: 0, booking_type: 'none' });
    expect((db.prepare(`SELECT COUNT(*) n FROM site_pages WHERE domain = '127.0.0.1'`).get() as any).n).toBeGreaterThanOrEqual(3);
    // Re-running skips domains already crawled at the current site version.
    await runSite(db, { noBrowser: true });
    expect((db.prepare(`SELECT COUNT(*) n FROM email_crawls`).get() as any).n).toBe(2);
  });
});

describe.skipIf(!process.env.BROWSER_TESTS)('site crawl rendering (Chromium)', () => {
  it('re-renders pages with a booking button and records JS-injected widget hosts', async () => {
    const { chromium } = await import('playwright');
    const { config } = await import('../config.ts');
    const page = `<html><body><p>Car hauler rentals.</p><a href="#">Reserve now</a><script>
      var s = document.createElement('script'); s.src = 'data:text/javascript,0'; document.head.appendChild(s);
      var f = document.createElement('iframe'); f.src = 'https://acme.us5.hqrentals.app/public/car-rental/reservations/step1';
      document.body.appendChild(f);
    </script></body></html>`;
    const server = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const browser = await chromium.launch({ headless: true, executablePath: config.chromiumPath });
    try {
      const plain = await crawlSite(url, '127.0.0.1');
      expect(plain.hosts.some((h) => h.host.endsWith('hqrentals.app'))).toBe(false);
      const r = await crawlSite(url, '127.0.0.1', async () => browser);
      expect(r.renders).toBeGreaterThan(0);
      expect(r.hosts.filter((h) => h.host === 'acme.us5.hqrentals.app').map((h) => h.kind).sort()).toEqual(['iframe', 'network']);
    } finally {
      await browser.close();
      server.close();
    }
  }, 60_000);
});
