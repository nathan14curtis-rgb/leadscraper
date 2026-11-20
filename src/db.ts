import Database from 'better-sqlite3';
import { config } from '../config.ts';

export type DB = Database.Database;

/** Ordered migrations; index + 1 is the schema version stored in PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE places (
    cid TEXT PRIMARY KEY,
    place_id TEXT,
    name TEXT NOT NULL,
    primary_category TEXT,
    categories_json TEXT NOT NULL DEFAULT '[]',
    address_full TEXT,
    street TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    lat REAL,
    lng REAL,
    phone TEXT,
    website TEXT,
    domain TEXT,
    rating REAL,
    review_count INTEGER,
    is_chain INTEGER NOT NULL DEFAULT 0,
    chain_brand TEXT,
    google_url TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    source_queries_json TEXT NOT NULL DEFAULT '[]',
    details_fetched INTEGER NOT NULL DEFAULT 0,
    merged_into TEXT
  );
  CREATE INDEX places_domain ON places(domain);
  CREATE INDEX places_state ON places(state);
  CREATE INDEX places_merged ON places(merged_into);

  CREATE TABLE search_cells (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES search_cells(id),
    kind TEXT NOT NULL,              -- grid | city
    cell_key TEXT NOT NULL,          -- identifies the geographic cell across its queries
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    size REAL NOT NULL,              -- cell edge in degrees
    zoom INTEGER NOT NULL,
    query TEXT NOT NULL,
    query_idx INTEGER NOT NULL,
    level INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending/running/done/saturated/skipped/error
    result_count INTEGER,
    kept_count INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TEXT,
    done_at TEXT,
    UNIQUE (cell_key, query)
  );
  CREATE INDEX search_cells_status ON search_cells(status, level);
  CREATE INDEX search_cells_key ON search_cells(cell_key, query_idx);

  CREATE TABLE emails (
    id INTEGER PRIMARY KEY,
    cid TEXT NOT NULL REFERENCES places(cid),
    email TEXT NOT NULL,
    source_url TEXT,
    confidence INTEGER NOT NULL,     -- 0-100
    found_at TEXT NOT NULL,
    UNIQUE (cid, email)
  );

  CREATE TABLE email_crawls (
    domain TEXT PRIMARY KEY,
    status TEXT NOT NULL,            -- done | error | skipped
    pages_fetched INTEGER NOT NULL DEFAULT 0,
    emails_found INTEGER NOT NULL DEFAULT 0,
    used_browser INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    crawled_at TEXT NOT NULL
  );

  CREATE TABLE crawl_log (
    ts TEXT NOT NULL,
    stage TEXT NOT NULL,
    key TEXT,
    outcome TEXT NOT NULL,
    note TEXT
  );
  `,
  `ALTER TABLE search_cells ADD COLUMN inside_count INTEGER;`,
  // Without this, deleting rows checks the parent_id reference with a full scan per row.
  `CREATE INDEX IF NOT EXISTS search_cells_parent ON search_cells(parent_id);`,
  // v4: scope (see places.ts deriveScope) and site-crawl evidence feeding it.
  `ALTER TABLE places ADD COLUMN scope TEXT;
   ALTER TABLE places ADD COLUMN site_trailer_mentions INTEGER;
   ALTER TABLE places ADD COLUMN uhaul_dealer INTEGER NOT NULL DEFAULT 0;`,
  // v5: business groups and segment (see groups.ts).
  `ALTER TABLE places ADD COLUMN group_id TEXT;
   ALTER TABLE places ADD COLUMN location_count INTEGER;
   ALTER TABLE places ADD COLUMN group_states TEXT;
   ALTER TABLE places ADD COLUMN segment TEXT;`,
  // v6: site crawl (see emails/crawl.ts): outside hosts, page text, booking labels.
  `ALTER TABLE email_crawls ADD COLUMN site_version INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE email_crawls ADD COLUMN is_seed INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE email_crawls ADD COLUMN booking_cta INTEGER;
   ALTER TABLE email_crawls ADD COLUMN renders INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE site_hosts (
     domain TEXT NOT NULL,
     host TEXT NOT NULL,
     kind TEXT NOT NULL,            -- script/iframe/link/form_action/stylesheet/network/marker
     example_url TEXT,
     PRIMARY KEY (domain, host, kind)
   );
   CREATE INDEX site_hosts_host ON site_hosts(host);
   CREATE TABLE site_pages (
     domain TEXT NOT NULL,
     url TEXT NOT NULL,
     text TEXT NOT NULL,
     fetched_at TEXT NOT NULL,
     PRIMARY KEY (domain, url)
   );
   ALTER TABLE places ADD COLUMN booking_vendor TEXT;
   ALTER TABLE places ADD COLUMN booking_type TEXT;
   ALTER TABLE places ADD COLUMN site_builder TEXT;`,
  // v7: reviews and place-page activity (see maps/reviews.ts). Counts and dates only.
  `ALTER TABLE places ADD COLUMN reviews_fetched_at TEXT;
   ALTER TABLE places ADD COLUMN last_review_at TEXT;
   ALTER TABLE places ADD COLUMN reviews_12m INTEGER;
   ALTER TABLE places ADD COLUMN reviews_90d INTEGER;
   ALTER TABLE places ADD COLUMN owner_replies_pct INTEGER;
   ALTER TABLE places ADD COLUMN owner_name TEXT;
   ALTER TABLE places ADD COLUMN hours_text TEXT;
   ALTER TABLE places ADD COLUMN claimed INTEGER;
   ALTER TABLE places ADD COLUMN description TEXT;`,
  // v8: lead score (see score.ts).
  `ALTER TABLE places ADD COLUMN lead_score INTEGER;
   ALTER TABLE places ADD COLUMN size_band TEXT;`,
];

export function openDb(path = config.dbPath): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export const nowIso = () => new Date().toISOString();

export function log(db: DB, stage: string, key: string | null, outcome: string, note?: string) {
  db.prepare('INSERT INTO crawl_log (ts, stage, key, outcome, note) VALUES (?, ?, ?, ?, ?)').run(
    nowIso(),
    stage,
    key,
    outcome,
    note ?? null,
  );
}

/** A place as produced by the Maps parser. Only cid and name are guaranteed. */
export interface PlaceRecord {
  cid: string;
  placeId?: string | null;
  name: string;
  categories: string[];
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  phone?: string | null;
  website?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
}
