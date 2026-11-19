/**
 * `reviews` stage: for in-scope independents, opens the place page, captures review count,
 * hours, claimed status and description, then opens Reviews sorted by Newest and scrolls
 * until reviews are older than 12 months or 100 are loaded. Stores only counts and dates
 * (last_review_at, reviews_12m, reviews_90d, owner_replies_pct) plus owner_name when owner
 * replies are signed. No reviewer names or review text are kept.
 *
 * Google's review markup has obfuscated class names, so reading is text-based: each
 * [data-review-id] block's lines are scanned for a relative date ("3 months ago") and a
 * "Response from the owner" section. Run with --save-fixtures on a few places first so the
 * raw review payloads can be checked (test/fixtures/captured/).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { config } from '../../config.ts';
import { type DB, log, nowIso } from '../db.ts';
import { Progress, formatDuration } from '../progress.ts';
import { Backoff, BlockedError, assertNotBlocked, handleConsent, jitter, launchContext, randInt, sleep } from './browser.ts';

const MAX_REVIEWS = 100;
const WINDOW_DAYS = 365;
const DAY = 86_400_000;
const UNIT_DAYS: Record<string, number> = { second: 0, minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 };
const RELATIVE = /^(?:Edited\s+)?(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;
const NOT_NAMES = new Set(['team', 'the team', 'staff', 'management', 'us', 'you', 'again', 'everyone', 'all']);

/** "3 months ago" → an approximate Date; null if the text isn't a relative date. */
export function parseRelativeDate(text: string, now: Date): Date | null {
  const m = text.trim().match(RELATIVE);
  if (!m) return null;
  const n = /^an?$/i.test(m[1]) ? 1 : Number(m[1]);
  return new Date(now.getTime() - n * UNIT_DAYS[m[2].toLowerCase()] * DAY);
}

/** Finds a signed name at the end of an owner reply ("… Thanks, Mike", "- Sarah, Owner"). */
export function ownerNameFromReply(reply: string): string | null {
  const tail = reply.trim().slice(-80);
  const name = '([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)';
  const role = '(?:\\s*,?\\s*\\(?(?:[Oo]wner|[Mm]anager|GM|[Oo]wner/[Oo]perator)\\)?)?';
  const patterns = [
    new RegExp(`[-–—~]\\s*${name}${role}[.!]?\\s*$`),
    new RegExp(`(?:[Tt]hanks|[Tt]hank you|[Rr]egards|[Ss]incerely|[Cc]heers|[Bb]est)(?:\\s+again)?[,!.]?\\s*[-–—]?\\s*${name}${role}[.!]?\\s*$`),
  ];
  for (const re of patterns) {
    const m = tail.match(re);
    if (m && !NOT_NAMES.has(m[1].toLowerCase())) return m[1];
  }
  return null;
}

export interface RawReview {
  id: string;
  /** All visible lines of the review block, in order. */
  lines: string[];
}

export interface ReviewSummary {
  loaded: number;
  lastReviewAt: string | null;
  reviews12m: number;
  reviews90d: number;
  ownerRepliesPct: number | null;
  ownerName: string | null;
}

/** Splits a review block into its own date and the owner's reply (if any). */
export function readReview(r: RawReview, now: Date): { date: Date | null; reply: string | null } {
  const replyAt = r.lines.findIndex((l) => /^Response from the owner/i.test(l));
  const own = replyAt >= 0 ? r.lines.slice(0, replyAt) : r.lines;
  const date = own.map((l) => parseRelativeDate(l, now)).find((d) => d) ?? null;
  if (replyAt < 0) return { date, reply: null };
  // The reply section is "Response from the owner", its own date, then the reply text.
  const rest = r.lines.slice(replyAt + 1).filter((l) => !parseRelativeDate(l, now) && !/^(More|Like|Share)$/i.test(l));
  return { date, reply: rest.join('\n') || null };
}

export function summarizeReviews(reviews: RawReview[], now: Date): ReviewSummary {
  const read = reviews.map((r) => readReview(r, now));
  const dates = read.map((r) => r.date).filter((d): d is Date => !!d);
  // Strict: Google says "a year ago" for 12-23 months and "3 months ago" for 3-4 months.
  const since = (days: number) => dates.filter((d) => now.getTime() - d.getTime() < days * DAY).length;
  const names = new Map<string, number>();
  for (const r of read) {
    const n = r.reply ? ownerNameFromReply(r.reply) : null;
    if (n) names.set(n, (names.get(n) ?? 0) + 1);
  }
  const last = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
  return {
    loaded: reviews.length,
    lastReviewAt: last ? last.toISOString().slice(0, 10) : null,
    reviews12m: since(WINDOW_DAYS),
    reviews90d: since(90),
    ownerRepliesPct: reviews.length ? Math.round((read.filter((r) => r.reply).length / reviews.length) * 100) : null,
    ownerName: [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  };
}

export interface PlacePageInfo {
  reviewCount: number | null;
  hours: string | null;
  claimed: boolean | null;
  description: string | null;
}

export interface ReviewsResult extends ReviewSummary, PlacePageInfo {
  payloads: string[];
}

const REVIEW_XHR = /listugcposts|listentitiesreviews|\/maps\/preview\/review/;

/** Reads review blocks currently in the DOM (deduped by review id, nested copies skipped). */
async function readReviewBlocks(page: Page): Promise<RawReview[]> {
  return page.evaluate(() => {
    const out: { id: string; lines: string[] }[] = [];
    const seen = new Set<string>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-review-id]'))) {
      const id = el.getAttribute('data-review-id')!;
      if (seen.has(id) || el.parentElement?.closest(`[data-review-id="${CSS.escape(id)}"]`)) continue;
      seen.add(id);
      out.push({ id, lines: el.innerText.split('\n').map((l) => l.trim()).filter(Boolean) });
    }
    return out;
  });
}

export async function scrapeReviews(page: Page, cid: string, onStep: (s: string) => void = () => {}): Promise<ReviewsResult> {
  const payloads: string[] = [];
  const pending: Promise<void>[] = [];
  const onResponse = (res: import('playwright').Response) => {
    if (REVIEW_XHR.test(res.url())) pending.push(res.text().then((t) => void payloads.push(t)).catch(() => {}));
  };
  page.on('response', onResponse);
  try {
    const url = `https://www.google.com/maps?cid=${cid}&hl=en&gl=us`;
    onStep('opening place');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (page.url().includes('consent.google.')) {
      await handleConsent(page);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    await assertNotBlocked(page);
    await page.waitForSelector('div[role="main"] h1', { timeout: 20_000 }).catch(() => {});
    await jitter(config.delays.actionMs);
    await assertNotBlocked(page);

    const info: PlacePageInfo = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label') ?? '');
      const count = labels.map((l) => l.match(/^([\d,]+)\s+reviews?$/i)).find(Boolean);
      const hours = labels.find((l) => /(Monday|Sunday)/.test(l) && (l.match(/day,/g) ?? []).length >= 3 && /(AM|PM|Closed|Open 24 hours)/.test(l));
      const text = document.body.innerText;
      const about = document.querySelector('div[role="region"][aria-label^="About"]') as HTMLElement | null;
      return {
        reviewCount: count ? Number(count[1].replace(/,/g, '')) : null,
        hours: hours ? hours.replace(/\.?\s*(Hide open hours for the week|Copy open hours)\.?/gi, '').trim() : null,
        claimed: /Claim this business/i.test(text) ? false : document.querySelector('div[role="main"] h1') ? true : null,
        description: about?.innerText.trim().slice(0, 1000) || null,
      };
    });

    onStep('opening reviews');
    const tab = page.getByRole('tab', { name: /^Reviews/i }).first();
    let reviews: RawReview[] = [];
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      await jitter(config.delays.scrollMs);
      const sort = page.getByRole('button', { name: /Sort reviews|Most relevant|^Sort$/i }).first();
      if (await sort.isVisible().catch(() => false)) {
        await sort.click();
        await jitter(config.delays.scrollMs);
        const newest = page.getByRole('menuitemradio', { name: /Newest/i }).first();
        if (await newest.isVisible().catch(() => false)) await newest.click();
        await jitter(config.delays.scrollMs);
      }
      await assertNotBlocked(page);

      const now = new Date();
      let last = -1;
      let stagnant = 0;
      for (let i = 0; i < 40; i++) {
        reviews = await readReviewBlocks(page);
        const dates = reviews.map((r) => readReview(r, now).date).filter((d): d is Date => !!d);
        const oldest = dates.length ? Math.min(...dates.map((d) => d.getTime())) : Date.now();
        onStep(`reading reviews · ${reviews.length} loaded`);
        if (reviews.length >= MAX_REVIEWS || now.getTime() - oldest >= WINDOW_DAYS * DAY) break;
        if (reviews.length === last) {
          if (++stagnant >= 3) break;
        } else stagnant = 0;
        last = reviews.length;
        await page.evaluate(() => {
          const first = document.querySelector('[data-review-id]');
          let el: HTMLElement | null = first?.parentElement ?? null;
          while (el && el.scrollHeight <= el.clientHeight + 5) el = el.parentElement;
          el?.scrollTo(0, el.scrollHeight);
        });
        await jitter(config.delays.scrollMs);
        await assertNotBlocked(page);
      }
      // Expand truncated owner replies so signatures at the end are visible.
      await page.evaluate(() => {
        for (const b of Array.from(document.querySelectorAll<HTMLElement>('[data-review-id] button')))
          if (/^(More|See more)$/i.test(b.innerText.trim()) || /See more/i.test(b.getAttribute('aria-label') ?? '')) b.click();
      });
      await sleep(500);
      reviews = (await readReviewBlocks(page)).slice(0, MAX_REVIEWS);
    }
    await Promise.all(pending);
    return { ...summarizeReviews(reviews, new Date()), ...info, payloads };
  } finally {
    page.off('response', onResponse);
  }
}

export async function runReviews(db: DB, opts: { contexts?: number; limit?: number; refresh?: boolean; saveFixtures?: boolean } = {}) {
  const rows = db
    .prepare(
      `SELECT cid, name FROM places
       WHERE merged_into IS NULL AND is_chain = 0 AND COALESCE(scope, 'needs_check') IN ('in_scope', 'needs_check')
         ${opts.refresh ? '' : 'AND reviews_fetched_at IS NULL'}
       ORDER BY random() ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ''}`,
    )
    .all() as { cid: string; name: string }[];
  console.log(`Reviews stage: ${rows.length} independent places to visit.`);
  const save = db.prepare(
    `UPDATE places SET reviews_fetched_at = @at, last_review_at = @last, reviews_12m = @r12, reviews_90d = @r90,
       owner_replies_pct = @replies, owner_name = COALESCE(@owner, owner_name),
       review_count = COALESCE(@count, review_count), hours_text = COALESCE(@hours, hours_text),
       claimed = COALESCE(@claimed, claimed), description = COALESCE(@description, description)
     WHERE cid = @cid`,
  );

  let stop = false;
  const onSigint = () => {
    if (stop) process.exit(130);
    stop = true;
    console.log('\nStopping after in-flight pages finish…');
  };
  process.on('SIGINT', onSigint);

  let next = 0;
  let done = 0;
  const progress = new Progress('reviews', (elapsed) => {
    const perHour = elapsed > 60_000 ? (done / elapsed) * 3_600_000 : 0;
    const left = rows.length - next;
    return `${done.toLocaleString()}/${rows.length.toLocaleString()} places · ${Math.round(perHour)}/hr${perHour ? ` · ETA ~${formatDuration((left / perHour) * 3_600_000)}` : ''}`;
  });
  const worker = async (w: number) => {
    progress.set(w, 'starting', Date.now() + w * 4_000);
    await sleep(w * 4_000);
    progress.set(w, 'launching browser');
    const ctx = await launchContext(w);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const backoff = new Backoff();
    try {
      while (!stop && next < rows.length) {
        const row = rows[next++];
        try {
          const r = await scrapeReviews(page, row.cid, (s) => progress.set(w, `${row.name} · ${s}`));
          if (opts.saveFixtures) {
            const dir = join('test', 'fixtures', 'captured');
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `${Date.now()}-reviews-${row.cid}.json`), JSON.stringify({ cid: row.cid, result: { ...r, payloads: undefined }, payloads: r.payloads }));
          }
          save.run({
            cid: row.cid,
            at: nowIso(),
            last: r.lastReviewAt,
            r12: r.reviews12m,
            r90: r.reviews90d,
            replies: r.ownerRepliesPct,
            owner: r.ownerName,
            count: r.reviewCount,
            hours: r.hours,
            claimed: r.claimed == null ? null : r.claimed ? 1 : 0,
            description: r.description,
          });
          backoff.onSuccess();
          done++;
          console.log(
            `[w${w}] ${row.name} → ${r.reviewCount ?? '?'} reviews, ${r.reviews12m} in 12m, last ${r.lastReviewAt ?? '—'}${r.ownerName ? `, owner ${r.ownerName}` : ''}`,
          );
        } catch (e) {
          if (e instanceof BlockedError) {
            rows.push(row);
            log(db, 'reviews', row.cid, 'blocked', e.url);
            await backoff.onBlocked(w, (until, strike) => progress.set(w, `BLOCKED by Google (strike ${strike}), paused`, until));
            continue;
          }
          db.prepare(`UPDATE places SET reviews_fetched_at = ? WHERE cid = ?`).run(nowIso(), row.cid);
          log(db, 'reviews', row.cid, 'error', (e as Error).message?.slice(0, 500));
        }
        const pause = randInt(config.delays.betweenSearchesMs);
        progress.set(w, 'pausing between places', Date.now() + pause);
        await sleep(pause);
      }
    } finally {
      progress.set(w, 'closing browser');
      await ctx.close().catch(() => {});
      progress.remove(w);
    }
  };
  progress.start();
  try {
    await Promise.all(Array.from({ length: opts.contexts ?? config.search.contexts }, (_, i) => worker(i)));
  } finally {
    progress.stop();
    process.off('SIGINT', onSigint);
  }
  console.log(`Reviews stage: visited ${done} places.`);
}
