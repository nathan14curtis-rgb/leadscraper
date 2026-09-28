/**
 * Drives the real search scraper against a mocked Google Maps page (no network).
 * Run with: BROWSER_TESTS=1 npm test   (set CHROMIUM_PATH if Playwright's browser isn't installed)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { config } from '../config.ts';
import { BlockedError, launchContext } from '../src/maps/browser.ts';
import { scrapeSearch } from '../src/maps/search.ts';

const place = (k: number) => {
  const a: unknown[] = [];
  a[10] = `0x1:0x${(0x100 + k).toString(16)}`;
  a[11] = `Trailer Place ${k}`;
  a[13] = ['Trailer rental service'];
  a[9] = [null, null, 40 + k / 1000, -111.5];
  a[178] = [[`(801) 555-${String(1000 + k)}`]];
  return a;
};
const payload = (from: number) => ")]}'\n" + JSON.stringify([[null, Array.from({ length: 20 }, (_, i) => [null, place(from + i)])]]);

const listPage = `<!doctype html><html><body>
<script>window.APP_INITIALIZATION_STATE = [[], null, null, [null, null, ${JSON.stringify(payload(0))}]];</script>
<div role="main"><div role="feed" id="f" style="height:400px;overflow:auto"></div></div>
<script>
  const feed = document.getElementById('f');
  let page = 0, loading = false;
  const add = (from) => { for (let i = 0; i < 20; i++) { const k = from + i; const a = document.createElement('a');
    a.href = 'https://www.google.com/maps/place/P' + k + '/data=!4m7!3m6!1s0x1:0x' + (0x100 + k).toString(16) + '!8m2!3d40.1!4d-111.5';
    a.setAttribute('aria-label', 'Trailer Place ' + k); a.style.cssText = 'display:block;height:60px'; a.textContent = k; feed.appendChild(a); } };
  add(0);
  feed.addEventListener('scroll', async () => {
    if (loading || page >= 2 || feed.scrollTop + feed.clientHeight < feed.scrollHeight - 5) return;
    loading = true; page++;
    await fetch('/search?tbm=map&q=trailer&p=' + page).then((r) => r.text());
    add(page * 20); loading = false;
    if (page >= 2) { const s = document.createElement('div'); s.textContent = "You've reached the end of the list."; feed.appendChild(s); }
  });
</script></body></html>`;

describe.skipIf(!process.env.BROWSER_TESTS)('scrapeSearch (mocked Maps)', () => {
  let ctx: BrowserContext;
  let page: Page;
  beforeAll(async () => {
    config.profileDir = mkdtempSync(join(tmpdir(), 'profiles-'));
    config.delays.actionMs = [50, 100];
    config.delays.scrollMs = [300, 400];
    ctx = await launchContext(0);
    page = ctx.pages()[0] ?? (await ctx.newPage());
  }, 60_000);
  afterAll(async () => ctx?.close());

  it('scrolls to the end and merges page-state, XHR and DOM results', async () => {
    await page.route('https://www.google.com/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/search') {
        const p = Number(url.searchParams.get('p'));
        return route.fulfill({ contentType: 'application/json', body: payload(p * 20) + '/*""*/' });
      }
      return route.fulfill({ contentType: 'text/html', body: listPage });
    });
    const res = await scrapeSearch(page, 'trailer rental', 40.1, -111.5, 11);
    await page.unrouteAll();
    expect(res.reachedEnd).toBe(true);
    expect(res.places).toHaveLength(60);
    expect(res.places.every((p) => p.categories[0] === 'Trailer rental service' && p.phone)).toBe(true);
  }, 60_000);

  it('raises BlockedError on the unusual-traffic page', async () => {
    await page.route('https://www.google.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>Our systems have detected unusual traffic from your computer network.</p>' }),
    );
    await expect(scrapeSearch(page, 'trailer rental', 40.1, -111.5, 11)).rejects.toBeInstanceOf(BlockedError);
    await page.unrouteAll();
  }, 60_000);
});
