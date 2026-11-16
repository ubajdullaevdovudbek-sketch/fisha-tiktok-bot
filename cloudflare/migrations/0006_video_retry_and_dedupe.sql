ALTER TABLE videos ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE videos ADD COLUMN next_attempt_at TEXT;
ALTER TABLE videos ADD COLUMN source_key TEXT;
ALTER TABLE videos ADD COLUMN tiktok_video_id TEXT;

CREATE INDEX idx_videos_retry_queue ON videos(status, next_attempt_at, id);
CREATE INDEX idx_videos_tiktok_video_id ON videos(tiktok_video_id) WHERE tiktok_video_id IS NOT NULL;
CREATE UNIQUE INDEX idx_videos_source_key_unique ON videos(source_key) WHERE source_key IS NOT NULL;
