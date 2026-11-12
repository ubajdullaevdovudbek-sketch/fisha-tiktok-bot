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
  completed_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_audio_jobs_queue ON audio_jobs(status, id);
