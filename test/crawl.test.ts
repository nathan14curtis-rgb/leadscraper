import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawlSite, shouldSkipDomain } from '../src/emails/crawl.ts';

const pages: Record<string, string> = {
  '/': '<html><body><h1>Acme Trailers</h1><p>Utility and cargo trailers for rent in Provo.</p><a href="/get-in-touch">Contact us</a></body></html>',
  '/get-in-touch': '<html><body><a href="mailto:rentals@acmetrailers.com">Email</a> or acme.trailers@gmail.com</body></html>',
  '/about': '<html><body>Family owned since 1990.</body></html>',
};

describe('crawlSite', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = pages[req.url ?? ''];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' }).end(body ?? 'not found');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('follows contact links and ranks emails', async () => {
    const r = await crawlSite(`${base}/`, 'acmetrailers.com');
    // Domain-matching mailto ranks above the freemail address found in text.
    expect(r.emails.map((e) => e.email)).toEqual(['rentals@acmetrailers.com', 'acme.trailers@gmail.com']);
    expect(r.emails[0].url).toBe(`${base}/get-in-touch`);
    expect(r.pagesFetched).toBeGreaterThanOrEqual(2);
    expect(r.pagesFetched).toBeLessThanOrEqual(6);
  });

  it('skips chain and social domains', () => {
    expect(shouldSkipDomain('uhaul.com')).toBe(true);
    expect(shouldSkipDomain('m.facebook.com')).toBe(true);
    expect(shouldSkipDomain('acmetrailers.com')).toBe(false);
  });
});
