import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLOUDFLARE = ROOT / "cloudflare"
SCHEMA = CLOUDFLARE / "schema.sql"
MIGRATIONS = [
    CLOUDFLARE / "migrations" / "0002_delivery_uncertain.sql",
    CLOUDFLARE / "migrations" / "0003_audio_jobs.sql",
    CLOUDFLARE / "migrations" / "0004_photo_album_progress.sql",
]


def legacy_schema_from_current():
    """Reconstruct the pre-0002 videos table and pre-audio schema for migration tests."""
    schema = SCHEMA.read_text(encoding="utf-8")
    schema = schema.replace("  publishing_started_at TEXT,\n", "")
    schema = schema.replace("  album_next_offset INTEGER NOT NULL DEFAULT 0,\n", "")
    audio_marker = "\n\n-- Optional audio work is isolated from the primary video publication queue.\n"
    if audio_marker not in schema:
        raise AssertionError("Current schema no longer contains the audio section marker")
    return schema.split(audio_marker, 1)[0] + "\n"


class D1MigrationSqliteTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(legacy_schema_from_current())
        self.db.execute(
            "INSERT INTO videos(id, kind, source_url, status, source_author, source_caption) "
            "VALUES(41, 'tiktok_url', 'https://tiktok.test/video/41', 'published', 'creator', 'existing caption')"
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_ordered_migrations_preserve_existing_video_and_add_expected_schema(self):
        for migration in MIGRATIONS:
            self.db.executescript(migration.read_text(encoding="utf-8"))

        video = self.db.execute(
            "SELECT id, kind, source_url, status, source_author, source_caption, "
            "publishing_started_at, album_next_offset FROM videos WHERE id=41"
        ).fetchone()
        self.assertEqual(
            video,
            (41, "tiktok_url", "https://tiktok.test/video/41", "published",
             "creator", "existing caption", None, 0),
        )

        columns = {
            row[1] for row in self.db.execute("PRAGMA table_info(videos)").fetchall()
        }
        self.assertIn("publishing_started_at", columns)
        self.assertIn("album_next_offset", columns)

        audio_table = self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='audio_jobs'"
        ).fetchone()
        self.assertEqual(audio_table, ("audio_jobs",))

        audio_indexes = {
            row[1] for row in self.db.execute("PRAGMA index_list(audio_jobs)").fetchall()
        }
        self.assertIn("idx_audio_jobs_queue", audio_indexes)

    def test_audio_jobs_foreign_key_and_unique_video_constraint(self):
        for migration in MIGRATIONS:
            self.db.executescript(migration.read_text(encoding="utf-8"))

        self.db.execute(
            "INSERT INTO audio_jobs(video_id, kind, source_url) "
            "VALUES(41, 'tiktok_url', 'https://tiktok.test/video/41')"
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO audio_jobs(video_id, kind, source_url) "
                "VALUES(41, 'tiktok_url', 'https://tiktok.test/video/41')"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO audio_jobs(video_id, kind, source_url) "
                "VALUES(999, 'tiktok_url', 'https://tiktok.test/video/999')"
            )


if __name__ == "__main__":
    unittest.main()
