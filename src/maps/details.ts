import type { Page } from 'playwright';
import { config } from '../../config.ts';
import { type DB, type PlaceRecord, log } from '../db.ts';
import { upsertPlace } from '../places.ts';
import { Backoff, BlockedError, assertNotBlocked, handleConsent, jitter, launchContext, randInt, sleep } from './browser.ts';
import { Progress, formatDuration } from '../progress.ts';
import { isDataResponse } from './search.ts';
import { mergeRecords, placesFromText } from './parse.ts';

interface Row {
  cid: string;
  place_id: string | null;
  name: string;
}

/** Opens a single place page and returns its full record (JSON first, DOM as fallback). */
export async function scrapeDetails(page: Page, cid: string): Promise<PlaceRecord | null> {
  const payloads: string[] = [];
  const pending: Promise<void>[] = [];
  const onResponse = (res: import('playwright').Response) => {
    if (isDataResponse(res.url())) pending.push(res.text().then((t) => void payloads.push(t)).catch(() => {}));
  };
  page.on('response', onResponse);
  try {
    const url = `https://www.google.com/maps?cid=${cid}&hl=en&gl=us`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (page.url().includes('consent.google.')) {
      await handleConsent(page);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    await assertNotBlocked(page);
    await page.waitForSelector('div[role="main"] h1', { timeout: 20_000 }).catch(() => {});
    await jitter(config.delays.actionMs);
    await assertNotBlocked(page);

    const state = await page.evaluate(() => JSON.stringify((window as any).APP_INITIALIZATION_STATE ?? null)).catch(() => null);
    if (state) payloads.push(state);
    await Promise.all(pending);

    const fromJson = mergeRecords(payloads.flatMap(placesFromText)).find((p) => p.cid === cid);
    const dom = await page
      .evaluate(() => {
        const attr = (sel: string, a: string) => document.querySelector(sel)?.getAttribute(a) ?? null;
        const phoneId = attr('[data-item-id^="phone:tel:"]', 'data-item-id');
        const addr = attr('button[data-item-id="address"]', 'aria-label');
        return {
          name: document.querySelector('div[role="main"] h1')?.textContent?.trim() ?? null,
          phone: phoneId ? phoneId.replace(/^phone:tel:/, '') : null,
          website: attr('a[data-item-id="authority"]', 'href'),
          address: addr ? addr.replace(/^Address:\s*/i, '').trim() : null,
          category: document.querySelector('button[jsaction*="category"]')?.textContent?.trim() ?? null,
        };
      })
      .catch(() => null);

    if (!fromJson && !dom?.name) return null;
    return {
      cid,
      name: fromJson?.name ?? dom!.name!,
      placeId: fromJson?.placeId ?? null,
      categories: fromJson?.categories.length ? fromJson.categories : dom?.category ? [dom.category] : [],
      address: fromJson?.address ?? dom?.address ?? null,
      lat: fromJson?.lat ?? null,
      lng: fromJson?.lng ?? null,
      phone: fromJson?.phone ?? dom?.phone ?? null,
      website: fromJson?.website ?? dom?.website ?? null,
      rating: fromJson?.rating ?? null,
      reviewCount: fromJson?.reviewCount ?? null,
    };
  } finally {
    page.off('response', onResponse);
  }
}

/** Visits places whose list record lacked phone, website, address or categories. */
export async function runDetails(db: DB, opts: { contexts?: number; limit?: number } = {}) {
  const rows = db
    .prepare(
      `SELECT cid, place_id, name FROM places
       WHERE details_fetched = 0 AND merged_into IS NULL
         AND (phone IS NULL OR website IS NULL OR address_full IS NULL OR categories_json = '[]')
       ORDER BY random() ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ''}`,
    )
    .all() as Row[];
  console.log(`Details stage: ${rows.length} places need a detail visit.`);
  const markDone = db.prepare('UPDATE places SET details_fetched = 1 WHERE cid = ?');

  let stop = false;
  const onSigint = () => {
    if (stop) process.exit(130);
    stop = true;
    console.log('\nStopping after in-flight pages finish…');
  };
  process.on('SIGINT', onSigint);

  let next = 0;
  let done = 0;
  const progress = new Progress('details', (elapsed) => {
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
          progress.set(w, `opening ${row.name}`);
          const rec = await scrapeDetails(page, row.cid);
          db.transaction(() => {
            if (rec) upsertPlace(db, rec);
            markDone.run(row.cid);
          })();
          backoff.onSuccess();
          done++;
          console.log(`[w${w}] ${done}/${rows.length} ${row.name} → phone=${rec?.phone ?? '-'} web=${rec?.website ?? '-'}`);
        } catch (e) {
          if (e instanceof BlockedError) {
            rows.push(row); // retry later in this run
            log(db, 'details', row.cid, 'blocked', e.url);
            await backoff.onBlocked(w, (until, strike) => progress.set(w, `BLOCKED by Google (strike ${strike}), paused`, until));
            continue;
          }
          markDone.run(row.cid);
          log(db, 'details', row.cid, 'error', (e as Error).message?.slice(0, 500));
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
  console.log(`Details stage: fetched ${done} places.`);
}
