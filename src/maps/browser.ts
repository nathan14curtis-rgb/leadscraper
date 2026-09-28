import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from '../../config.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const randInt = ([min, max]: [number, number]) => Math.floor(min + Math.random() * (max - min + 1));
export const jitter = (range: [number, number]) => sleep(randInt(range));

export class BlockedError extends Error {
  constructor(public readonly url: string) {
    super(`Google served an unusual-traffic / CAPTCHA page (${url})`);
  }
}

function proxyOption() {
  if (!config.proxyUrl) return undefined;
  const u = new URL(config.proxyUrl);
  return {
    server: `${u.protocol}//${u.host}`,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

/**
 * One persistent Chromium profile per worker, so cookies and consent survive restarts
 * and each worker looks like a stable returning browser.
 */
export async function launchContext(index: number): Promise<BrowserContext> {
  const dir = join(config.profileDir, `ctx-${index}`);
  mkdirSync(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: config.search.headless,
    executablePath: config.chromiumPath,
    proxy: proxyOption(),
    viewport: config.search.viewport,
    locale: 'en-US',
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  if (config.search.blockResources) {
    await ctx.route('**/*', (route) => {
      const t = route.request().resourceType();
      return t === 'image' || t === 'media' || t === 'font' ? route.abort() : route.continue();
    });
  }
  return ctx;
}

export async function isBlocked(page: Page): Promise<boolean> {
  const url = page.url();
  if (/google\.[a-z.]+\/sorry\//.test(url)) return true;
  const text = await page
    .evaluate(() => document.body?.innerText?.slice(0, 3000) ?? '')
    .catch(() => '');
  return /unusual traffic from your computer network|not a robot|our systems have detected unusual traffic/i.test(text);
}

/** Dismisses consent.google.com if it appears (rare on US IPs). */
export async function handleConsent(page: Page) {
  if (!page.url().includes('consent.google.')) return;
  for (const label of ['Reject all', 'Accept all', 'I agree']) {
    const btn = page.getByRole('button', { name: label }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return;
    }
  }
}

/** Throws BlockedError if the current page is a block page. */
export async function assertNotBlocked(page: Page) {
  if (await isBlocked(page)) throw new BlockedError(page.url());
}

/** Per-worker exponential backoff after blocks; resets after a run of clean searches. */
export class Backoff {
  private strikes = 0;
  private clean = 0;

  async onBlocked(worker: number) {
    const steps = config.delays.blockBackoffMs;
    const wait = steps[Math.min(this.strikes, steps.length - 1)];
    this.strikes++;
    this.clean = 0;
    const until = new Date(Date.now() + wait).toLocaleTimeString();
    console.warn(
      `\x07[worker ${worker}] BLOCKED by Google (strike ${this.strikes}). Pausing ${Math.round(wait / 60000)} min until ${until}.` +
        (config.search.headless ? '' : ' You can solve the CAPTCHA in the open window meanwhile.'),
    );
    await sleep(wait);
  }

  onSuccess() {
    if (++this.clean >= 20) this.strikes = 0;
  }

  get strikeCount() {
    return this.strikes;
  }
}
