import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLOUDFLARE = ROOT / "cloudflare"
SCHEMA = CLOUDFLARE / "schema.sql"
MIGRATIONS_DIR = CLOUDFLARE / "migrations"
# Exact schema.sql from Git history right before migration 0002 (kept outside
# cloudflare/migrations so wrangler can never apply it).
BASELINE = CLOUDFLARE / "tests" / "fixtures" / "pre_0002_baseline.sql"
MIGRATIONS = [
    MIGRATIONS_DIR / "0002_delivery_uncertain.sql",
    MIGRATIONS_DIR / "0003_audio_jobs.sql",
    MIGRATIONS_DIR / "0004_photo_album_progress.sql",
    MIGRATIONS_DIR / "0005_photo_batch_reconciliation.sql",
]


def snapshot(db):
    """Order-independent description of tables, columns, indexes and foreign keys."""
    result = {}
    tables = [
        row[0]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    ]
    for table in tables:
        columns = {
            (name, ctype, notnull, default, pk)
            for _, name, ctype, notnull, default, pk in db.execute(
                f"PRAGMA table_info({table})"
            )
        }
        indexes = set()
        for _, index_name, unique, _origin, _partial in db.execute(
            f"PRAGMA index_list({table})"
        ):
            cols = tuple(
                row[2] for row in db.execute(f"PRAGMA index_info({index_name})")
            )
            # Auto-index names are not stable; named indexes are part of the contract.
            key = index_name if not index_name.startswith("sqlite_autoindex") else "auto"
            indexes.add((key, bool(unique), cols))
        foreign_keys = {
            (row[2], row[3], row[4])
            for row in db.execute(f"PRAGMA foreign_key_list({table})")
        }
        result[table] = {
            "columns": columns,
            "indexes": indexes,
            "foreign_keys": foreign_keys,
        }
    return result


class D1MigrationSqliteTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(BASELINE.read_text(encoding="utf-8"))
        self.db.execute(
            "INSERT INTO videos(id, kind, source_url, status, source_author, source_caption) "
            "VALUES(41, 'tiktok_url', 'https://tiktok.test/video/41', 'published', 'creator', 'existing caption')"
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def migrate(self):
        for migration in MIGRATIONS:
            self.db.executescript(migration.read_text(encoding="utf-8"))

    def test_baseline_is_really_pre_0002(self):
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(videos)")}
        self.assertNotIn("publishing_started_at", columns)
        self.assertNotIn("album_next_offset", columns)
        tables = {
            row[0]
            for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        self.assertNotIn("audio_jobs", tables)

    def test_every_migration_file_is_covered_and_in_order(self):
        on_disk = sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql"))
        self.assertEqual(on_disk, [m.name for m in MIGRATIONS])

    def test_ordered_migrations_preserve_existing_video_and_add_expected_schema(self):
        self.migrate()

        video = self.db.execute(
            "SELECT id, kind, source_url, status, source_author, source_caption, "
            "publishing_started_at, album_next_offset, album_pending_offset, album_total_count FROM videos WHERE id=41"
        ).fetchone()
        self.assertEqual(
            video,
            (41, "tiktok_url", "https://tiktok.test/video/41", "published",
             "creator", "existing caption", None, 0, None, None),
        )

        columns = {
            row[1] for row in self.db.execute("PRAGMA table_info(videos)").fetchall()
        }
        self.assertIn("publishing_started_at", columns)
        self.assertIn("album_next_offset", columns)
        self.assertIn("album_pending_offset", columns)
        self.assertIn("album_total_count", columns)

        audio_table = self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='audio_jobs'"
        ).fetchone()
        self.assertEqual(audio_table, ("audio_jobs",))

        audio_indexes = {
            row[1] for row in self.db.execute("PRAGMA index_list(audio_jobs)").fetchall()
        }
        self.assertIn("idx_audio_jobs_queue", audio_indexes)

    def test_migrated_schema_matches_current_schema_sql(self):
        """Guards against schema.sql and migrations drifting apart."""
        self.migrate()
        fresh = sqlite3.connect(":memory:")
        try:
            fresh.executescript(SCHEMA.read_text(encoding="utf-8"))
            self.assertEqual(snapshot(self.db), snapshot(fresh))
        finally:
            fresh.close()

    def test_audio_jobs_foreign_key_and_unique_video_constraint(self):
        self.migrate()

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

    def test_check_constraints_survive_migrations(self):
        self.migrate()
        bad_rows = [
            "INSERT INTO videos(kind, source_url) VALUES('bogus', 'x')",
            "INSERT INTO videos(kind, source_url, status) VALUES('tiktok_url', 'x', 'bogus')",
            "INSERT INTO audio_jobs(video_id, kind) VALUES(41, 'bogus')",
            "INSERT INTO audio_jobs(video_id, kind, status) VALUES(41, 'tiktok_url', 'bogus')",
        ]
        for sql in bad_rows:
            with self.subTest(sql=sql):
                with self.assertRaises(sqlite3.IntegrityError):
                    self.db.execute(sql)

    def test_new_columns_are_writable_and_defaults_apply(self):
        self.migrate()
        self.db.execute(
            "UPDATE videos SET album_next_offset=10, "
            "publishing_started_at='2026-11-12T06:20:00.000Z' WHERE id=41"
        )
        self.assertEqual(
            self.db.execute(
                "SELECT album_next_offset, publishing_started_at, source_caption "
                "FROM videos WHERE id=41"
            ).fetchone(),
            (10, "2026-11-12T06:20:00.000Z", "existing caption"),
        )
        self.db.execute("INSERT INTO videos(kind, source_url) VALUES('tiktok_url', 'y')")
        self.assertEqual(
            self.db.execute(
                "SELECT status, album_next_offset, publishing_started_at "
                "FROM videos WHERE source_url='y'"
            ).fetchone(),
            ("queued", 0, None),
        )

    def test_reapplying_an_alter_migration_fails_instead_of_duplicating(self):
        self.migrate()
        for migration in (MIGRATIONS[0], MIGRATIONS[2], MIGRATIONS[3]):
            with self.subTest(migration=migration.name):
                with self.assertRaises(sqlite3.OperationalError):
                    self.db.executescript(migration.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
