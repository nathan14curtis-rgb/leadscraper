import { chromium, type Browser } from 'playwright';
import { config } from '../../config.ts';
import { type DB, log, nowIso } from '../db.ts';
import { type FoundEmail, extractFromHtml, scoreEmail } from './extract.ts';
import { Progress, formatDuration } from '../progress.ts';

const CANDIDATE_PATHS = ['/contact', '/contact-us', '/about'];

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(config.emails.timeoutMs),
      headers: { 'user-agent': config.emails.userAgent, accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok || !(res.headers.get('content-type') ?? 'text/html').includes('html')) return null;
    const html = (await res.text()).slice(0, 2_000_000);
    return { html, finalUrl: res.url || url };
  } catch {
    return null;
  }
}

async function renderHtml(browser: Browser, url: string): Promise<{ html: string; finalUrl: string } | null> {
  const page = await browser.newPage({ userAgent: config.emails.userAgent });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: config.emails.timeoutMs * 2 });
    return { html: await page.content(), finalUrl: page.url() };
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

export interface SiteResult {
  emails: (FoundEmail & { url: string; confidence: number })[];
  pagesFetched: number;
  usedBrowser: boolean;
}

/**
 * Crawls homepage + likely contact pages (max N pages) and returns ranked emails.
 * Falls back to a real browser when the homepage is a JS shell with no content.
 */
export async function crawlSite(website: string, domain: string, getBrowser?: () => Promise<Browser>): Promise<SiteResult> {
  const origin = new URL(website).origin;
  const queue = [website, `${origin}/`, ...CANDIDATE_PATHS.map((p) => origin + p)];
  const seen = new Set<string>();
  const found = new Map<string, FoundEmail & { url: string }>();
  let pagesFetched = 0;
  let usedBrowser = false;

  while (queue.length && pagesFetched < config.emails.maxPagesPerSite) {
    const url = queue.shift()!;
    const key = url.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);

    let page = await fetchHtml(url);
    let ex = page ? extractFromHtml(page.html, page.finalUrl) : null;
    const isHome = pagesFetched === 0;
    const thin = !ex || (ex.textLength < 200 && ex.emails.length === 0);
    if (isHome && thin && getBrowser && config.emails.browserFallback) {
      const rendered = await renderHtml(await getBrowser(), url);
      if (rendered) {
        page = rendered;
        ex = extractFromHtml(rendered.html, rendered.finalUrl);
        usedBrowser = true;
      }
    }
    if (!page || !ex) continue; // a failed homepage falls through to the bare origin / contact paths
    pagesFetched++;
    for (const e of ex.emails) if (!found.has(e.email)) found.set(e.email, { ...e, url: page.finalUrl });
    // Links whose anchor/href mentions contact go to the front of the queue.
    const links = ex.contactLinks.sort((a, b) => Number(/contact/i.test(b)) - Number(/contact/i.test(a)));
    for (const l of links.reverse()) if (!seen.has(l.replace(/\/$/, ''))) queue.splice(0, 0, l);
  }

  const emails = [...found.values()]
    .map((e) => ({ ...e, confidence: scoreEmail(e.email, e.source, domain) }))
    .sort((a, b) => b.confidence - a.confidence);
  return { emails, pagesFetched, usedBrowser };
}

export function shouldSkipDomain(domain: string): boolean {
  return config.emails.skipDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Crawls each unique website domain once and attaches its emails to every place on it. */
export async function runEmails(db: DB, opts: { limit?: number; noBrowser?: boolean; retryErrors?: boolean } = {}) {
  if (opts.retryErrors) db.prepare(`DELETE FROM email_crawls WHERE status = 'error'`).run();
  const domains = db
    .prepare(
      `SELECT p.domain, MIN(p.website) AS website FROM places p
       LEFT JOIN email_crawls c ON c.domain = p.domain
       WHERE p.domain IS NOT NULL AND p.merged_into IS NULL AND c.domain IS NULL
       GROUP BY p.domain ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ''}`,
    )
    .all() as { domain: string; website: string }[];
  console.log(`Email stage: ${domains.length} domains to crawl.`);

  let browser: Browser | undefined;
  let launching: Promise<Browser> | undefined;
  const getBrowser = opts.noBrowser
    ? undefined
    : () =>
        (launching ??= chromium.launch({ headless: true, executablePath: config.chromiumPath }).then((b) => (browser = b)));

  const saveCrawl = db.prepare(
    `INSERT OR REPLACE INTO email_crawls (domain, status, pages_fetched, emails_found, used_browser, note, crawled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const cidsFor = db.prepare(`SELECT cid FROM places WHERE domain = ? AND merged_into IS NULL`);
  const insertEmail = db.prepare(
    `INSERT INTO emails (cid, email, source_url, confidence, found_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cid, email) DO UPDATE SET confidence = MAX(confidence, excluded.confidence)`,
  );

  let next = 0;
  let done = 0;
  let withEmail = 0;
  let stop = false;
  const onSigint = () => {
    if (stop) process.exit(130);
    stop = true;
    console.log('\nStopping after in-flight sites finish…');
  };
  process.on('SIGINT', onSigint);

  const progress = new Progress('emails', (elapsed) => {
    const perHour = elapsed > 60_000 ? (done / elapsed) * 3_600_000 : 0;
    const left = domains.length - next;
    return `${done.toLocaleString()}/${domains.length.toLocaleString()} sites · ${withEmail.toLocaleString()} with email · ${Math.round(perHour)}/hr${perHour ? ` · ETA ~${formatDuration((left / perHour) * 3_600_000)}` : ''}`;
  });

  const worker = async (w: number) => {
    while (!stop && next < domains.length) {
      const { domain, website } = domains[next++];
      progress.set(w, `crawling ${domain}`);
      const now = nowIso();
      if (shouldSkipDomain(domain)) {
        saveCrawl.run(domain, 'skipped', 0, 0, 0, 'skip list', now);
        continue;
      }
      try {
        const r = await crawlSite(website, domain, getBrowser);
        db.transaction(() => {
          const cids = cidsFor.all(domain) as { cid: string }[];
          for (const e of r.emails) for (const { cid } of cids) insertEmail.run(cid, e.email, e.url, e.confidence, now);
          saveCrawl.run(domain, r.pagesFetched ? 'done' : 'error', r.pagesFetched, r.emails.length, r.usedBrowser ? 1 : 0, r.pagesFetched ? null : 'unreachable', now);
        })();
        if (r.emails.length) withEmail++;
        done++;
        if (r.emails.length)
          console.log(`${done}/${domains.length} ${domain}: ${r.emails.map((e) => e.email).join(', ') || '—'}`);
      } catch (e) {
        saveCrawl.run(domain, 'error', 0, 0, 0, (e as Error).message?.slice(0, 300), now);
        log(db, 'emails', domain, 'error', (e as Error).message?.slice(0, 500));
      }
    }
    progress.remove(w);
  };

  progress.start();
  try {
    await Promise.all(Array.from({ length: config.emails.concurrency }, (_, i) => worker(i)));
  } finally {
    progress.stop();
    process.off('SIGINT', onSigint);
    await browser?.close().catch(() => {});
  }
  console.log(`Email stage: crawled ${done} domains, ${withEmail} with at least one email.`);
}
