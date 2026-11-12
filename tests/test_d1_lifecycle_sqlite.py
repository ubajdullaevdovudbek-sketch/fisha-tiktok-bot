import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "cloudflare" / "schema.sql"


class D1LifecycleSqliteTests(unittest.TestCase):
    """Exercise the D1 schema and critical SQL against an isolated SQLite DB."""

    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA.read_text(encoding="utf-8"))
        self.db.execute(
            "INSERT INTO videos(id, kind, source_url, status) VALUES(1, 'tiktok_url', 'https://tiktok.test/photo/1', 'processing')"
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_photo_checkpoint_advances_and_never_moves_backwards(self):
        sql = (
            "UPDATE videos SET album_next_offset=MAX(album_next_offset, ?) "
            "WHERE id=? AND status='processing' AND kind='tiktok_url'"
        )
        self.assertEqual(self.db.execute(sql, (10, 1)).rowcount, 1)
        self.assertEqual(self.db.execute(sql, (20, 1)).rowcount, 1)
        self.assertEqual(self.db.execute(sql, (10, 1)).rowcount, 1)
        offset = self.db.execute(
            "SELECT album_next_offset FROM videos WHERE id=1"
        ).fetchone()[0]
        self.assertEqual(offset, 20)

    def test_manual_retry_preserves_album_checkpoint(self):
        self.db.execute(
            "UPDATE videos SET album_next_offset=10, status='failed', "
            "publishing_started_at='2026-11-01T10:00:00Z' WHERE id=1"
        )
        changed = self.db.execute(
            "UPDATE videos SET status='queued', claimed_at=NULL, "
            "publishing_started_at=NULL, error=NULL WHERE id=? AND status='failed'",
            (1,),
        ).rowcount
        self.assertEqual(changed, 1)
        row = self.db.execute(
            "SELECT status, album_next_offset, publishing_started_at FROM videos WHERE id=1"
        ).fetchone()
        self.assertEqual(row, ("queued", 10, None))

    def test_checkpoint_rejected_for_non_processing_or_non_tiktok_jobs(self):
        self.db.execute("UPDATE videos SET status='failed' WHERE id=1")
        changed = self.db.execute(
            "UPDATE videos SET album_next_offset=MAX(album_next_offset, ?) "
            "WHERE id=? AND status='processing' AND kind='tiktok_url'",
            (10, 1),
        ).rowcount
        self.assertEqual(changed, 0)

    def test_audio_enqueue_and_video_completion_are_atomic(self):
        self.db.execute(
            "INSERT INTO videos(id, kind, telegram_file_id, status) "
            "VALUES(2, 'telegram_file', 'file-id', 'processing')"
        )
        try:
            with self.db:
                self.db.execute(
                    "INSERT OR IGNORE INTO audio_jobs(video_id, kind, telegram_file_id, title) "
                    "SELECT ?, ?, ?, ? WHERE EXISTS "
                    "(SELECT 1 FROM videos WHERE id=? AND status='processing')",
                    (2, "telegram_file", "file-id", "test audio", 2),
                )
                self.db.execute(
                    "UPDATE videos SET status='published', published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
                    "WHERE id=? AND status='processing'",
                    (2,),
                )
                raise RuntimeError("simulate transaction failure")
        except RuntimeError:
            pass
        video_status = self.db.execute(
            "SELECT status FROM videos WHERE id=2"
        ).fetchone()[0]
        audio_count = self.db.execute(
            "SELECT COUNT(*) FROM audio_jobs WHERE video_id=2"
        ).fetchone()[0]
        self.assertEqual(video_status, "processing")
        self.assertEqual(audio_count, 0)

    def test_audio_job_is_created_with_successful_video_completion(self):
        self.db.execute(
            "INSERT INTO videos(id, kind, source_url, status) "
            "VALUES(3, 'tiktok_url', 'https://tiktok.test/video/3', 'processing')"
        )
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO audio_jobs(video_id, kind, source_url, title) "
                "SELECT ?, ?, ?, ? WHERE EXISTS "
                "(SELECT 1 FROM videos WHERE id=? AND status='processing')",
                (3, "tiktok_url", "https://tiktok.test/video/3", "audio", 3),
            )
            self.db.execute(
                "UPDATE videos SET status='published' WHERE id=? AND status='processing'",
                (3,),
            )
        self.assertEqual(
            self.db.execute("SELECT status FROM videos WHERE id=3").fetchone()[0],
            "published",
        )
        self.assertEqual(
            self.db.execute("SELECT status FROM audio_jobs WHERE video_id=3").fetchone()[0],
            "queued",
        )


if __name__ == "__main__":
    unittest.main()
