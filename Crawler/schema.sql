CREATE TABLE IF NOT EXISTS crawl_targets (
  topic TEXT NOT NULL,
  source TEXT NOT NULL,
  seed TEXT NOT NULL,
  recrawl_days INTEGER NOT NULL DEFAULT 7,
  PRIMARY KEY (topic, source, seed)
);

CREATE TABLE IF NOT EXISTS crawl_urls (
  url TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  last_crawled_at INTEGER,
  next_crawl_at INTEGER,
  etag TEXT,
  last_modified TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  authors TEXT,
  year INTEGER,
  language TEXT,
  license_hint TEXT,
  landing_url TEXT NOT NULL,
  download_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rankings (
  topic TEXT NOT NULL,
  book_id TEXT NOT NULL,
  score REAL NOT NULL,
  rationale TEXT NOT NULL,
  ranked_at INTEGER NOT NULL,
  PRIMARY KEY (topic, book_id)
);

CREATE TABLE IF NOT EXISTS ranking_jobs (
  job_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS topic_state (
  topic TEXT PRIMARY KEY,
  last_ranked_at INTEGER,
  running_job_id TEXT,
  lock_expires_at INTEGER,
  manual_requested_at INTEGER
);
