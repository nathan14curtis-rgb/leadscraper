/**
 * `site` stage (alias `emails`): crawls each unique website once, up to 6 pages, and keeps
 *   - emails (ranked), attached to every place on that domain
 *   - every outside host the pages use (site_hosts), plus builder/vendor HTML markers
 *   - cleaned page text (site_pages, ~20 KB per site) for the later profile stage
 *   - trailer-for-rent evidence (feeds scope) and U-Haul dealer evidence (feeds chain flags)
 * Pages with a Book / Reserve button or a script loader are re-rendered in Chromium so
 * widgets that only appear after JavaScript runs are seen, including their network requests.
 */
import { readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { config } from '../../config.ts';
import { type DB, log, nowIso } from '../db.ts';
import { runEnrich } from '../enrich.ts';
import { domainOf, normalizeWebsite } from '../normalize.ts';
import { Progress, formatDuration } from '../progress.ts';
import { type ExternalHost, type FoundEmail, type PageExtract, extractFromHtml, scoreEmail } from './extract.ts';
import { labelVendors } from './vendors.ts';

const CANDIDATE_PATHS = ['/contact', '/contact-us', '/about'];

interface Fetched {
  html: string;
  finalUrl: string;
  requestHosts?: ExternalHost[];
}

async function fetchHtml(url: string): Promise<Fetched | null> {
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

/** Renders a page and records the outside hosts of every network request it makes. */
async function renderHtml(browser: Browser, url: string): Promise<Fetched | null> {
  const page = await browser.newPage({ userAgent: config.emails.userAgent });
  const requests = new Map<string, ExternalHost>();
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      if (!/^https?:$/.test(u.protocol)) return;
      const host = u.hostname.toLowerCase().replace(/^www\d?\./, '');
      if (!requests.has(host)) requests.set(host, { host, kind: 'network', url: u.toString().slice(0, 500) });
    } catch {
      /* ignore */
    }
  });
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    return t === 'image' || t === 'media' || t === 'font' ? route.abort() : route.continue();
  });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: config.emails.timeoutMs * 2 });
    const finalUrl = page.url();
    const own = new URL(finalUrl).hostname.toLowerCase().replace(/^www\d?\./, '');
    return { html: await page.content(), finalUrl, requestHosts: [...requests.values()].filter((h) => h.host !== own) };
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
  renders: number;
  hosts: ExternalHost[];
  markers: string[];
  bookingCta: boolean;
  trailerMentions: number;
  uhaulDealer: boolean;
  pages: { url: string; text: string }[];
}

/**
 * Crawls homepage, contact and booking-looking pages (max N pages) and collects emails and
 * site signals. Falls back to a real browser when the homepage is a JS shell with no content,
 * and re-renders pages where an online booking widget is likely.
 */
export async function crawlSite(website: string, domain: string, getBrowser?: () => Promise<Browser>): Promise<SiteResult> {
  const origin = new URL(website).origin;
  const queue = [website, `${origin}/`, ...CANDIDATE_PATHS.map((p) => origin + p)];
  const seen = new Set<string>();
  const found = new Map<string, FoundEmail & { url: string }>();
  const hosts = new Map<string, ExternalHost>();
  const markers = new Set<string>();
  const pages: { url: string; text: string }[] = [];
  let pagesFetched = 0;
  let usedBrowser = false;
  let renders = 0;
  let bookingCta = false;
  let trailerMentions = 0;
  let uhaulDealer = false;
  let bookingLinksQueued = 0;
  const canRender = !!getBrowser && config.emails.browserFallback;

  const absorb = (ex: PageExtract, f: Fetched) => {
    for (const h of [...ex.hosts, ...(f.requestHosts ?? [])]) {
      const key = `${h.host}|${h.kind}`;
      if (!hosts.has(key)) hosts.set(key, h);
    }
    ex.markers.forEach((m) => markers.add(m));
  };

  while (queue.length && pagesFetched < config.emails.maxPagesPerSite) {
    const url = queue.shift()!;
    const key = url.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);

    let page = await fetchHtml(url);
    let ex = page ? extractFromHtml(page.html, page.finalUrl) : null;
    const isHome = pagesFetched === 0;
    const thin = !ex || (ex.textLength < 200 && ex.emails.length === 0);
    const bookingLikely = !!ex && (ex.bookingCta || ex.loaderScript);
    if (canRender && ((isHome && thin) || (bookingLikely && renders < config.site.maxRendersPerSite))) {
      // Keep what the plain fetch saw (some hosts are only in the raw HTML), then render.
      if (page && ex) absorb(ex, page);
      const rendered = await renderHtml(await getBrowser!(), url);
      if (rendered) {
        renders++;
        page = rendered;
        ex = extractFromHtml(rendered.html, rendered.finalUrl);
        usedBrowser = true;
      }
    }
    if (!page || !ex) continue; // a failed homepage falls through to the bare origin / contact paths
    pagesFetched++;
    absorb(ex, page);
    bookingCta ||= ex.bookingCta;
    trailerMentions += ex.trailerMentions;
    uhaulDealer ||= ex.uhaulDealer;
    if (ex.cleanText) pages.push({ url: page.finalUrl, text: ex.cleanText });
    for (const e of ex.emails) if (!found.has(e.email)) found.set(e.email, { ...e, url: page.finalUrl });
    // Contact pages first, then up to 2 booking/inventory pages, ahead of the guessed paths.
    const booking = ex.bookingLinks.filter((l) => !seen.has(l.replace(/\/$/, ''))).slice(0, Math.max(0, 2 - bookingLinksQueued));
    bookingLinksQueued += booking.length;
    const contact = ex.contactLinks.sort((a, b) => Number(/contact/i.test(b)) - Number(/contact/i.test(a)));
    for (const l of [...contact, ...booking].reverse()) if (!seen.has(l.replace(/\/$/, ''))) queue.splice(0, 0, l);
  }

  // Cap stored text per site, keeping whole pages where possible.
  let budget = config.site.textCapBytes;
  const keptPages = pages
    .map((p) => {
      const text = p.text.slice(0, Math.max(0, budget));
      budget -= text.length;
      return { url: p.url, text };
    })
    .filter((p) => p.text.length > 0);

  const emails = [...found.values()]
    .map((e) => ({ ...e, confidence: scoreEmail(e.email, e.source, domain) }))
    .sort((a, b) => b.confidence - a.confidence);
  for (const m of markers) hosts.set(`${m}|marker`, { host: m, kind: 'marker', url: '' });
  return {
    emails,
    pagesFetched,
    usedBrowser,
    renders,
    hosts: [...hosts.values()],
    markers: [...markers],
    bookingCta,
    trailerMentions,
    uhaulDealer,
    pages: keptPages,
  };
}

export function shouldSkipDomain(domain: string): boolean {
  return config.emails.skipDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export interface SiteOptions {
  limit?: number;
  noBrowser?: boolean;
  retryErrors?: boolean;
  /** A file of seed URLs (one per line, # comments) to crawl instead of the places' websites. */
  urlsFile?: string;
}

/** Crawls each unique website domain once and stores its emails and site signals. */
export async function runSite(db: DB, opts: SiteOptions = {}) {
  if (opts.retryErrors) db.prepare(`DELETE FROM email_crawls WHERE status = 'error'`).run();
  const seedMode = !!opts.urlsFile;
  const domains: { domain: string; website: string }[] = seedMode
    ? readFileSync(opts.urlsFile!, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean)
        .map((u) => ({ website: normalizeWebsite(u)!, domain: domainOf(u)! }))
        .filter((d) => d.website && d.domain)
    : (db
        .prepare(
          `SELECT p.domain, MIN(p.website) AS website FROM places p
           LEFT JOIN email_crawls c ON c.domain = p.domain
           WHERE p.domain IS NOT NULL AND p.merged_into IS NULL
             AND (c.domain IS NULL OR c.site_version < @version)
           GROUP BY p.domain ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ''}`,
        )
        .all({ version: config.site.version }) as { domain: string; website: string }[]);
  console.log(`Site stage: ${domains.length} ${seedMode ? 'seed sites' : 'domains'} to crawl.`);

  let browser: Browser | undefined;
  let launching: Promise<Browser> | undefined;
  const getBrowser = opts.noBrowser
    ? undefined
    : () => (launching ??= chromium.launch({ headless: true, executablePath: config.chromiumPath }).then((b) => (browser = b)));

  const saveCrawl = db.prepare(
    `INSERT OR REPLACE INTO email_crawls
       (domain, status, pages_fetched, emails_found, used_browser, note, crawled_at, site_version, is_seed, booking_cta, renders)
     VALUES (@domain, @status, @pages, @emails, @browser, @note, @at, @version, @seed, @cta, @renders)`,
  );
  const cidsFor = db.prepare(`SELECT cid FROM places WHERE domain = ? AND merged_into IS NULL`);
  const insertEmail = db.prepare(
    `INSERT INTO emails (cid, email, source_url, confidence, found_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cid, email) DO UPDATE SET confidence = MAX(confidence, excluded.confidence)`,
  );
  const clearHosts = db.prepare(`DELETE FROM site_hosts WHERE domain = ?`);
  const insertHost = db.prepare(`INSERT OR IGNORE INTO site_hosts (domain, host, kind, example_url) VALUES (?, ?, ?, ?)`);
  const clearPages = db.prepare(`DELETE FROM site_pages WHERE domain = ?`);
  const insertPage = db.prepare(`INSERT OR REPLACE INTO site_pages (domain, url, text, fetched_at) VALUES (?, ?, ?, ?)`);
  const setSignals = db.prepare(`UPDATE places SET site_trailer_mentions = ?, uhaul_dealer = ? WHERE domain = ?`);
  const crawlRow = (domain: string, status: string, note: string | null, r?: SiteResult) => ({
    domain,
    status,
    pages: r?.pagesFetched ?? 0,
    emails: r?.emails.length ?? 0,
    browser: r?.usedBrowser ? 1 : 0,
    note,
    at: nowIso(),
    version: config.site.version,
    seed: seedMode ? 1 : 0,
    cta: r ? (r.bookingCta ? 1 : 0) : null,
    renders: r?.renders ?? 0,
  });

  let next = 0;
  let done = 0;
  let withEmail = 0;
  let withVendor = 0;
  let stop = false;
  const onSigint = () => {
    if (stop) process.exit(130);
    stop = true;
    console.log('\nStopping after in-flight sites finish…');
  };
  process.on('SIGINT', onSigint);

  const progress = new Progress('site', (elapsed) => {
    const perHour = elapsed > 60_000 ? (done / elapsed) * 3_600_000 : 0;
    const left = domains.length - next;
    return `${done.toLocaleString()}/${domains.length.toLocaleString()} sites · ${withEmail.toLocaleString()} with email · ${Math.round(perHour)}/hr${perHour ? ` · ETA ~${formatDuration((left / perHour) * 3_600_000)}` : ''}`;
  });

  const worker = async (w: number) => {
    while (!stop && next < domains.length) {
      const { domain, website } = domains[next++];
      progress.set(w, `crawling ${domain}`);
      if (!seedMode && shouldSkipDomain(domain)) {
        saveCrawl.run(crawlRow(domain, 'skipped', 'skip list'));
        continue;
      }
      try {
        const r = await crawlSite(website, domain, getBrowser);
        const ok = r.pagesFetched > 0;
        const now = nowIso();
        db.transaction(() => {
          if (!seedMode) {
            const cids = cidsFor.all(domain) as { cid: string }[];
            for (const e of r.emails) for (const { cid } of cids) insertEmail.run(cid, e.email, e.url, e.confidence, now);
            // Unreachable sites give no scope evidence either way: leave mentions NULL.
            setSignals.run(ok ? r.trailerMentions : null, r.uhaulDealer ? 1 : 0, domain);
          }
          clearHosts.run(domain);
          for (const h of r.hosts) insertHost.run(domain, h.host, h.kind, h.url);
          clearPages.run(domain);
          for (const p of r.pages) insertPage.run(domain, p.url, p.text, now);
          saveCrawl.run(crawlRow(domain, ok ? 'done' : 'error', ok ? null : 'unreachable', r));
          if (ok && !seedMode) labelVendors(db, domain);
        })();
        if (r.emails.length) withEmail++;
        done++;
        const vendor = seedMode || !ok ? null : (db.prepare(`SELECT booking_vendor v FROM places WHERE domain = ? LIMIT 1`).get(domain) as { v: string | null } | undefined)?.v;
        if (vendor) withVendor++;
        if (r.emails.length || vendor || seedMode)
          console.log(
            `${done}/${domains.length} ${domain}: ${r.emails.map((e) => e.email).join(', ') || '—'}${vendor ? ` · booking: ${vendor}` : ''}${seedMode ? ` · ${r.hosts.length} hosts` : ''}`,
          );
      } catch (e) {
        saveCrawl.run(crawlRow(domain, 'error', (e as Error).message?.slice(0, 300) ?? 'error'));
        log(db, 'site', domain, 'error', (e as Error).message?.slice(0, 500));
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
  console.log(`Site stage: crawled ${done} domains, ${withEmail} with at least one email, ${withVendor} with a known booking vendor.`);
  if (seedMode) console.log('Seed hosts: npm run hosts -- --seeds');
  else runEnrich(db); // applies the new scope evidence and U-Haul dealer flags
}
