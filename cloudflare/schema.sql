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
  album_next_offset INTEGER NOT NULL DEFAULT 0,
  album_pending_offset INTEGER,
  album_total_count INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  source_key TEXT,
  tiktok_video_id TEXT,

  published_at TEXT,
  published_local_date TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_videos_queue ON videos(status, id);
CREATE INDEX IF NOT EXISTS idx_videos_published_day ON videos(status, published_local_date);
CREATE INDEX IF NOT EXISTS idx_videos_retry_queue ON videos(status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_videos_tiktok_video_id ON videos(tiktok_video_id) WHERE tiktok_video_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_source_key_unique ON videos(source_key) WHERE source_key IS NOT NULL;


-- Prevent duplicate queue entries when Telegram retries webhook updates.
CREATE TABLE IF NOT EXISTS webhook_updates (
  update_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


-- Optional audio work is isolated from the primary video publication queue.
CREATE TABLE IF NOT EXISTS audio_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL UNIQUE REFERENCES videos(id),
  kind TEXT NOT NULL CHECK (kind IN ('tiktok_url', 'telegram_file')),
  source_url TEXT,
  telegram_file_id TEXT,
  title TEXT NOT NULL DEFAULT 'TikTok audio',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'published', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  claimed_at TEXT,
  audio_started_at TEXT,
  completed_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_audio_jobs_queue ON audio_jobs(status, id);
