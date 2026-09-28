import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { config } from '../../config.ts';
import { type DB, type PlaceRecord, log, nowIso } from '../db.ts';
import { type Cell, LandMask, insertCell, subdivide } from '../grid.ts';
import { isRelevant, upsertPlace } from '../places.ts';
import { Backoff, BlockedError, assertNotBlocked, handleConsent, jitter, launchContext, sleep } from './browser.ts';
import { mergeRecords, placeFromHref, placesFromText } from './parse.ts';

export interface SearchTask {
  id: number;
  kind: Cell['kind'];
  cell_key: string;
  lat: number;
  lng: number;
  size: number;
  zoom: number;
  query: string;
  query_idx: number;
  level: number;
  attempts: number;
}

export interface SearchResult {
  places: PlaceRecord[];
  reachedEnd: boolean;
  singlePlace: boolean;
  payloads: string[];
}

export function searchUrl(query: string, lat: number, lng: number, zoom: number): string {
  const q = encodeURIComponent(query).replace(/%20/g, '+');
  return `https://www.google.com/maps/search/${q}/@${lat.toFixed(6)},${lng.toFixed(6)},${zoom}z?hl=en&gl=us`;
}

/** XHRs that carry place data: list pagination and place previews. */
export const isDataResponse = (url: string) =>
  (/\/search\?/.test(url) && /[?&]tbm=map\b/.test(url)) || url.includes('/maps/preview/place');

/** Loads one search, scrolls the result list to the end and returns every place seen. */
export async function scrapeSearch(page: Page, query: string, lat: number, lng: number, zoom: number): Promise<SearchResult> {
  const payloads: string[] = [];
  const pending: Promise<void>[] = [];
  const onResponse = (res: import('playwright').Response) => {
    if (!isDataResponse(res.url())) return;
    pending.push(
      res
        .text()
        .then((t) => void payloads.push(t))
        .catch(() => {}),
    );
  };
  page.on('response', onResponse);
  try {
    const url = searchUrl(query, lat, lng, zoom);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (page.url().includes('consent.google.')) {
      await handleConsent(page);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    await assertNotBlocked(page);
    await page.waitForSelector('div[role="feed"], div[role="main"] h1', { timeout: 20_000 }).catch(() => {});
    await jitter(config.delays.actionMs);
    await assertNotBlocked(page);

    const state = await page
      .evaluate(() => {
        try {
          return JSON.stringify((window as any).APP_INITIALIZATION_STATE ?? null);
        } catch {
          return null;
        }
      })
      .catch(() => null);
    if (state) payloads.push(state);

    const feed = page.locator('div[role="feed"]');
    let reachedEnd = false;
    const singlePlace = !(await feed.count()) && page.url().includes('/maps/place/');
    if (await feed.count()) {
      let last = -1;
      let stagnant = 0;
      for (let i = 0; i < config.search.maxScrolls; i++) {
        reachedEnd = (await page.getByText(/reached the end of the list/i).count()) > 0;
        if (reachedEnd) break;
        const count = await feed.locator('a[href*="/maps/place/"]').count();
        if (count === last) {
          if (++stagnant >= 3) break;
        } else stagnant = 0;
        last = count;
        await feed.evaluate((el) => el.scrollTo(0, el.scrollHeight));
        await jitter(config.delays.scrollMs);
        await assertNotBlocked(page);
      }
    }

    const anchors = await page
      .$$eval('div[role="feed"] a[href*="/maps/place/"]', (els) =>
        els.map((e) => ({ href: e.getAttribute('href') ?? '', label: e.getAttribute('aria-label') })),
      )
      .catch(() => [] as { href: string; label: string | null }[]);

    await Promise.all(pending);
    const fromJson = payloads.flatMap(placesFromText);
    const fromDom = anchors.map((a) => placeFromHref(a.href, a.label)).filter((p): p is PlaceRecord => !!p);
    let places = mergeRecords([...fromJson, ...fromDom]);
    // On a list page, only trust places that are actually in the list (the page state can
    // include unrelated places, e.g. the previously opened one). Fall back to JSON if the
    // DOM gave us nothing to anchor on.
    if (fromDom.length) {
      const inList = new Set(fromDom.map((p) => p.cid));
      places = places.filter((p) => inList.has(p.cid));
    }
    return { places, reachedEnd, singlePlace, payloads };
  } finally {
    page.off('response', onResponse);
  }
}

const PICK_SQL = `
  SELECT id, kind, cell_key, lat, lng, size, zoom, query, query_idx, level, attempts
  FROM search_cells c
  WHERE c.status = 'pending'
    AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= @now)
    AND NOT EXISTS (
      SELECT 1 FROM search_cells e
      WHERE e.cell_key = c.cell_key AND e.query_idx < c.query_idx AND e.status IN ('pending', 'running'))
  ORDER BY c.level, random()
  LIMIT 1`;

/** Stores results and decides done vs. saturated (split into 4 children). */
export function recordResult(db: DB, task: SearchTask, places: PlaceRecord[], mask?: LandMask) {
  return db.transaction(() => {
    let kept = 0;
    for (const p of places) {
      // Records with no categories came from the DOM fallback; keep them and let the
      // details stage decide. Export re-applies the relevance filter.
      if (p.categories.length && !isRelevant(p)) continue;
      upsertPlace(db, p, task.query);
      kept++;
    }
    const saturated = places.length >= config.search.saturationThreshold;
    const split = saturated && task.level < config.grid.maxLevel;
    db.prepare(
      `UPDATE search_cells SET status = ?, result_count = ?, kept_count = ?, done_at = ?, last_error = ?, next_attempt_at = NULL
       WHERE id = ?`,
    ).run(split ? 'saturated' : 'done', places.length, kept, nowIso(), saturated && !split ? 'saturated at max level' : null, task.id);
    let children = 0;
    if (split) {
      db.prepare(`UPDATE search_cells SET status = 'skipped' WHERE cell_key = ? AND query_idx > ? AND status = 'pending'`).run(
        task.cell_key,
        task.query_idx,
      );
      for (const child of subdivide(task, mask)) children += insertCell(db, child, task.id, task.query_idx);
    }
    return { kept, saturated, children };
  })();
}

export interface SearchOptions {
  contexts?: number;
  limit?: number;
  saveFixtures?: boolean;
  retryErrors?: boolean;
}

export async function runSearch(db: DB, opts: SearchOptions = {}) {
  const contexts = opts.contexts ?? config.search.contexts;
  const mask = new LandMask();
  db.prepare(`UPDATE search_cells SET status = 'pending' WHERE status = 'running'`).run();
  if (opts.retryErrors) db.prepare(`UPDATE search_cells SET status = 'pending', attempts = 0, next_attempt_at = NULL WHERE status = 'error'`).run();

  const pick = db.prepare(PICK_SQL);
  const claim = db.transaction((): SearchTask | undefined => {
    const t = pick.get({ now: nowIso() }) as SearchTask | undefined;
    if (t) db.prepare(`UPDATE search_cells SET status = 'running', attempts = attempts + 1 WHERE id = ?`).run(t.id);
    return t;
  });
  const hasWork = () =>
    (db.prepare(`SELECT COUNT(*) n FROM search_cells WHERE status IN ('pending', 'running')`).get() as { n: number }).n > 0;

  let stop = false;
  let started = 0;
  const onSigint = () => {
    if (stop) process.exit(130);
    stop = true;
    console.log('\nStopping after in-flight searches finish (Ctrl-C again to force)…');
  };
  process.on('SIGINT', onSigint);

  const worker = async (w: number) => {
    await sleep(w * 4_000);
    const ctx = await launchContext(w);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const backoff = new Backoff();
    try {
      while (!stop && (opts.limit === undefined || started < opts.limit)) {
        const task = claim();
        if (!task) {
          if (!hasWork()) break;
          await sleep(15_000); // others are running and may enqueue children, or retries are scheduled
          continue;
        }
        started++;
        const label = `[w${w}] L${task.level} "${task.query}" @${task.lat.toFixed(3)},${task.lng.toFixed(3)} z${task.zoom}`;
        try {
          const res = await scrapeSearch(page, task.query, task.lat, task.lng, task.zoom);
          if (opts.saveFixtures) saveFixture(task, res);
          const r = recordResult(db, task, res.places, mask);
          backoff.onSuccess();
          console.log(
            `${label} → ${res.places.length} results, ${r.kept} kept${r.saturated ? ` SATURATED${r.children ? ` → ${r.children} child searches` : ' (max level)'}` : ''}`,
          );
        } catch (e) {
          if (e instanceof BlockedError) {
            db.prepare(`UPDATE search_cells SET status = 'pending', attempts = attempts - 1 WHERE id = ?`).run(task.id);
            log(db, 'search', String(task.id), 'blocked', e.url);
            await backoff.onBlocked(w);
            continue;
          }
          const msg = (e as Error).message?.slice(0, 500) ?? 'unknown error';
          if (/net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|CONNECTION_RESET|PROXY|TUNNEL)/.test(msg)) {
            // Our connection, not this cell: don't burn an attempt, wait for the network.
            db.prepare(`UPDATE search_cells SET status = 'pending', attempts = attempts - 1 WHERE id = ?`).run(task.id);
            console.warn(`${label} → network error, retrying in 60 s: ${msg.split('\n')[0]}`);
            await sleep(60_000);
            continue;
          }
          const final = task.attempts + 1 >= config.search.maxAttempts;
          db.prepare(`UPDATE search_cells SET status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`).run(
            final ? 'error' : 'pending',
            msg,
            final ? null : new Date(Date.now() + 10 * 60_000).toISOString(),
            task.id,
          );
          log(db, 'search', String(task.id), 'error', msg);
          console.warn(`${label} → error: ${msg}`);
        }
        await jitter(config.delays.betweenSearchesMs);
      }
    } finally {
      await ctx.close().catch(() => {});
    }
  };

  try {
    await Promise.all(Array.from({ length: contexts }, (_, i) => worker(i)));
  } finally {
    process.off('SIGINT', onSigint);
  }
  console.log(`Search stage: ran ${started} searches this session.`);
}

function saveFixture(task: SearchTask, res: SearchResult) {
  const dir = join('test', 'fixtures', 'captured');
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${task.query.replace(/\W+/g, '_')}.json`;
  writeFileSync(join(dir, name), JSON.stringify({ task, count: res.places.length, payloads: res.payloads }));
}
