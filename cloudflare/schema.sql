CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('tiktok_url', 'telegram_file')),
  source_url TEXT,
  telegram_file_id TEXT,
  source_author TEXT NOT NULL DEFAULT '',
  source_caption TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'published', 'failed')),
  force_publish INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  claimed_at TEXT,
  publishing_started_at TEXT,

  published_at TEXT,
  published_local_date TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_videos_queue ON videos(status, id);
CREATE INDEX IF NOT EXISTS idx_videos_published_day ON videos(status, published_local_date);


-- Prevent duplicate queue entries when Telegram retries webhook updates.
CREATE TABLE IF NOT EXISTS webhook_updates (
  update_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
