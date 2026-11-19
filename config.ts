/**
 * All tunables in one place. Most can be overridden with environment variables so a
 * long unattended run can be re-paced without editing code.
 */
const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));

export const config = {
  dbPath: env.DB_PATH ?? 'leads.db',
  outDir: env.OUT_DIR ?? 'out',
  profileDir: env.PROFILE_DIR ?? 'profiles',

  /**
   * Queries run per cell, in priority order. Later ones only run if earlier ones did not
   * saturate. Each extra grid query adds ~5k searches for the full US, so use the pilot's
   * `status` query-yield table to trim this list (or set GRID_QUERY_COUNT).
   */
  queries: [
    'trailer rental',
    'trailer rentals',
    'utility trailer rental',
    'cargo trailer rental',
    'dump trailer rental',
    'car hauler rental',
    'trailer dealer',
    'trailer hire',
  ],
  gridQueryCount: num(env.GRID_QUERY_COUNT, 8),
  /** City seeds run a shorter query list; the grid already covers the long tail. */
  cityQueryCount: num(env.CITY_QUERY_COUNT, 3),

  /**
   * Google's own category labels. Core labels are trusted as trailer renters. Broad labels
   * (tool hire, box trucks, moving supplies…) are kept but marked scope = needs_check until
   * the site crawl finds trailers for rent on the business's website.
   */
  categoryCore: ['Trailer rental service', 'Trailer dealer', 'Horse trailer dealer', 'Boat trailer dealer', 'Utility trailer dealer'],
  categoryBroad: ['Equipment rental agency', 'Truck rental agency', 'Moving supply store', 'Trailer repair shop', 'Trailer supply store'],
  /** A name like "Smith Trailer Rentals" is as good as a core category. */
  nameRentalPattern: /trailer\s*(rental|rentals|rent|hire)\b|\b(rent|rental|rentals)\b.*\btrailers?\b/i,
  /** Website text that counts as "rents trailers": a trailer term within ~60 chars of rent/rental/hire. */
  siteTrailerRentalPattern:
    /\b(trailers?|car haulers?|dump trailers?|cargo trailers?|utility trailers?|equipment trailers?)\b[^.!?\n]{0,60}\b(rent|rents|rental|rentals|hire|for rent)\b|\b(rent|rental|rentals|hire)\b[^.!?\n]{0,60}\b(trailers?|car haulers?)\b/gi,
  /** Out of scope even if the name says "trailer" (RV/camper rentals, trailer parks). */
  categoryDenyPattern: /\bRV\b|recreational vehicle|camper|motor ?home|travel trailer|mobile home park|trailer park|campground/i,
  nameKeepPattern: /trailer/i,

  grid: {
    /** Level-0 cell size in degrees. */
    cellSize: num(env.GRID_CELL_SIZE, 0.5),
    /** Map zoom for level-0 cells; each subdivision level adds 1. */
    baseZoom: num(env.GRID_BASE_ZOOM, 10),
    /** Stop subdividing past this level (0.5° / 2^6 ≈ 900 m cells). */
    maxLevel: num(env.GRID_MAX_LEVEL, 6),
    regions: [
      { name: 'lower48', minLng: -125.0, minLat: 24.4, maxLng: -66.9, maxLat: 49.4 },
      { name: 'alaska', minLng: -179.5, minLat: 51.0, maxLng: -129.5, maxLat: 71.5 },
      { name: 'hawaii', minLng: -160.5, minLat: 18.5, maxLng: -154.5, maxLat: 22.5 },
    ],
  },

  cities: {
    minPopulation: num(env.CITY_MIN_POP, 10_000),
    zoom: 12,
    /** Cell size used when a city search saturates and is subdivided. */
    cellSize: 0.125,
  },

  search: {
    /** Parallel browser contexts (each with its own persistent profile). */
    contexts: num(env.CONTEXTS, 3),
    /** A search returning at least this many unique places is treated as capped by Google (~120). */
    saturationThreshold: num(env.SATURATION_THRESHOLD, 100),
    /**
     * …and at least this share of them must sit inside the map viewport. When an area runs
     * out of matches, Google pads the list with businesses up to ~150 km away; a search
     * like that has found everything nearby and must not be split.
     */
    saturationInsideShare: num(env.SATURATION_INSIDE_SHARE, 0.9),
    /** Width of the results panel covering the left of the map, in px. */
    resultsPanelPx: 408,
    maxScrolls: 20,
    maxAttempts: 3,
    headless: bool(env.HEADLESS, true),
    /** Skip images/fonts/media to save bandwidth (matters with metered proxies). */
    blockResources: bool(env.BLOCK_RESOURCES, true),
    viewport: { width: 1280, height: 900 },
  },

  delays: {
    actionMs: [2_000, 6_000] as [number, number],
    scrollMs: [1_200, 2_800] as [number, number],
    betweenSearchesMs: [num(env.SEARCH_DELAY_MIN_MS, 5_000), num(env.SEARCH_DELAY_MAX_MS, 15_000)] as [number, number],
    /** Backoff after a block / CAPTCHA page, per context. Last value repeats. */
    blockBackoffMs: [5 * 60_000, 15 * 60_000, 45 * 60_000, 120 * 60_000],
  },

  /** Residential proxy, e.g. http://user:pass@host:port. Only used for Google traffic. */
  proxyUrl: env.PROXY_URL || undefined,
  /** Override the Chromium binary (e.g. /opt/pw-browsers/chromium). */
  chromiumPath: env.CHROMIUM_PATH || undefined,

  emails: {
    concurrency: num(env.EMAIL_CONCURRENCY, 8),
    maxPagesPerSite: 6,
    timeoutMs: 10_000,
    /** Use Playwright for sites whose raw HTML has no usable content. */
    browserFallback: bool(env.EMAIL_BROWSER_FALLBACK, true),
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    /** Domains not worth crawling: chain corporate sites and social/listing hosts. */
    skipDomains: [
      'uhaul.com', 'penske.com', 'pensketruckrental.com', 'budgettruck.com', 'homedepot.com', 'lowes.com',
      'sunbeltrentals.com', 'unitedrentals.com', 'hercrentals.com', 'tractorsupply.com', 'ryder.com',
      'enterprisetrucks.com', 'enterprise.com', 'facebook.com', 'instagram.com', 'yelp.com', 'google.com',
      'business.site', 'linktr.ee', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'linkedin.com',
      'nextdoor.com', 'craigslist.org', 'bbb.org', 'yellowpages.com', 'mapquest.com',
    ],
  },

  site: {
    /** Bumping this re-crawls every domain on the next `site` run. */
    version: 1,
    /** Re-render up to this many pages per site in Chromium when booking looks likely. */
    maxRendersPerSite: 2,
    /** Cleaned page text kept per site for the later profile stage. */
    textCapBytes: 20_000,
  },

  /** Fingerprints found in raw HTML; stored as site_hosts rows with kind = 'marker'. */
  htmlMarkers: [
    { id: 'wordpress', pattern: /\/wp-content\/|\/wp-includes\//i },
    { id: 'lockii-element', pattern: /<lockii-[a-z-]+/i },
    { id: 'booqable-inline', pattern: /booqableOptions|powered by booqable/i },
    { id: 'hq-integration', pattern: /hq-rental-software-integration|\/public\/car-rental\/(reservations|integrations)/i },
    { id: 'automateboss-text', pattern: /automate ?boss/i },
    { id: 'bigrentals-text', pattern: /powered by (big ?rentals|hq ?rent)\b/i },
  ],

  /**
   * Booking software and site builders, matched against a site's external hosts (and the
   * marker ids above). First match by type priority wins: own_customer > competitor >
   * generic_booking. Evidence: see the "Vendor detection" section of the README.
   */
  vendors: [
    // Lockii: book.lockii.app / dash.lockii.app widget.js, cdn.lockii.app, <lockii-*> elements.
    { vendor: 'Lockii', type: 'own_customer', hosts: [/(^|\.)lockii\.app$/], markers: ['lockii-element'] },
    // Booqable: <uuid>.assets.booqable.com/v2/booqable.js, <shop>.booqableshop.com.
    { vendor: 'Booqable', type: 'competitor', hosts: [/(^|\.)booqable\.com$/, /(^|\.)booqableshop\.com$/], markers: ['booqable-inline'] },
    // HQ Rental Software: <tenant>.caagcrm.com / <tenant>.us5.hqrentals.app integrator + iframe.
    { vendor: 'HQ Rental Software', type: 'competitor', hosts: [/(^|\.)caagcrm\.com$/, /(^|\.)hqrentals\.(app|eu|asia)$/], markers: ['hq-integration'] },
    // Big Rentals / HQRent: not yet seen on a customer site; vendor domains only (unverified).
    { vendor: 'Big Rentals', type: 'competitor', hosts: [/(^|\.)bigrentals\.com$/, /(^|\.)hqrent\.com$/], markers: ['bigrentals-text'] },
    // Automate Boss: HighLevel-built sites; no vendor host confirmed, so the footer text is the signal.
    { vendor: 'Automate Boss', type: 'competitor', hosts: [/(^|\.)automateboss/], markers: ['automateboss-text'] },
    // Other online booking tools: a booking flow, but not one of the named competitors.
    { vendor: 'Checkfront', type: 'generic_booking', hosts: [/(^|\.)checkfront\.com$/], markers: [] },
    { vendor: 'FareHarbor', type: 'generic_booking', hosts: [/(^|\.)fareharbor\.com$/], markers: [] },
    { vendor: 'Rentle', type: 'generic_booking', hosts: [/(^|\.)rentle\.(io|store)$/], markers: [] },
    { vendor: 'Point of Rental', type: 'generic_booking', hosts: [/(^|\.)pointofrental\.com$/], markers: [] },
    { vendor: 'Calendly', type: 'generic_booking', hosts: [/(^|\.)calendly\.com$/], markers: [] },
    { vendor: 'Square Appointments', type: 'generic_booking', hosts: [/^(book|app)\.squareup\.com$/, /(^|\.)square\.site$/], markers: [] },
    { vendor: 'Bookeo', type: 'generic_booking', hosts: [/(^|\.)bookeo\.com$/], markers: [] },
    { vendor: 'Acuity', type: 'generic_booking', hosts: [/(^|\.)acuityscheduling\.com$/], markers: [] },
  ] as { vendor: string; type: 'own_customer' | 'competitor' | 'generic_booking'; hosts: RegExp[]; markers: string[] }[],

  siteBuilders: [
    { builder: 'Wix', hosts: [/(^|\.)(wixstatic|parastorage|wix)\.com$/], markers: [] },
    { builder: 'Squarespace', hosts: [/(^|\.)squarespace(-cdn)?\.com$/], markers: [] },
    { builder: 'GoDaddy', hosts: [/(^|\.)(godaddysites|wsimg)\.com$/], markers: [] },
    { builder: 'Weebly', hosts: [/(^|\.)(weebly|editmysite)\.com$/], markers: [] },
    { builder: 'Shopify', hosts: [/(^|\.)(shopify|myshopify)\.com$/], markers: [] },
    { builder: 'Duda', hosts: [/(^|\.)(multiscreensite|dudamobile)\.com$/], markers: [] },
    { builder: 'HighLevel', hosts: [/(^|\.)(leadconnectorhq|msgsndr)\.com$/], markers: [] },
    { builder: 'WordPress', hosts: [], markers: ['wordpress'] },
  ] as { builder: string; hosts: RegExp[]; markers: string[] }[],

  /** Hosts nearly every site uses; hidden from the `hosts` report unless --all. */
  hostNoise: [
    /(^|\.)google(apis|tagmanager|-analytics|usercontent|syndication|adservices)?\.com$/, /(^|\.)gstatic\.com$/,
    /(^|\.)doubleclick\.net$/, /(^|\.)(facebook|fbcdn|instagram|twitter|x|linkedin|youtube|pinterest|tiktok)\.(com|net)$/,
    /(^|\.)fb\.me$/, /(^|\.)youtu\.be$/, /(^|\.)(cloudflare|jsdelivr|unpkg|jquery|bootstrapcdn|cdnjs|fontawesome|typekit)\.(com|net|org)$/,
    /(^|\.)(fonts|use)\.(googleapis|typekit)\.(com|net)$/, /(^|\.)gravatar\.com$/, /(^|\.)w\.org$/, /(^|\.)wordpress\.(org|com)$/,
    /(^|\.)(yelp|bbb|apple|maps\.apple)\.(com|org)$/, /(^|\.)hotjar\.com$/, /(^|\.)bing\.com$/,
  ],

  /** Chain detection: matched against the business name, then against the website domain. */
  chains: [
    { brand: 'U-Haul', name: /\bu[\s-]?haul\b/i, domain: /(^|\.)uhaul\.com$/ },
    { brand: 'Penske', name: /\bpenske\b/i, domain: /(^|\.)(penske|pensketruckrental)\.com$/ },
    { brand: 'Budget Truck Rental', name: /\bbudget truck\b/i, domain: /(^|\.)budgettruck\.com$/ },
    { brand: 'Home Depot', name: /\bhome depot\b/i, domain: /(^|\.)homedepot\.com$/ },
    { brand: "Lowe's", name: /\blowe'?s\b/i, domain: /(^|\.)lowes\.com$/ },
    { brand: 'Sunbelt Rentals', name: /\bsunbelt rentals?\b/i, domain: /(^|\.)sunbeltrentals\.com$/ },
    { brand: 'United Rentals', name: /\bunited rentals\b/i, domain: /(^|\.)unitedrentals\.com$/ },
    { brand: 'Herc Rentals', name: /\bherc rentals\b/i, domain: /(^|\.)hercrentals\.com$/ },
    { brand: 'Tractor Supply', name: /\btractor supply\b/i, domain: /(^|\.)tractorsupply\.com$/ },
    { brand: 'Big Tex Trailers', name: /\bbig tex\b/i, domain: /(^|\.)bigtextrailers\.com$/ },
    { brand: 'PJ Trailers', name: /\bpj trailers\b/i, domain: /(^|\.)pjtrailers\.com$/ },
    { brand: 'Ryder', name: /\bryder\b/i, domain: /(^|\.)ryder\.com$/ },
    { brand: 'Enterprise', name: /\benterprise (truck|rent)/i, domain: /(^|\.)enterprise(trucks)?\.com$/ },
  ],
};

export type Config = typeof config;
