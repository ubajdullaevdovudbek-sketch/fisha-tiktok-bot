import sqlite3
from pathlib import Path
from typing import Any


UNCERTAIN_DELIVERY = "UNCERTAIN DELIVERY:"


class Store:
    CLAIM_TIMEOUT_MINUTES = 20

    def __init__(self, path: Path):
        self.path = path
        self.init()

    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        return db

    def init(self):
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_url TEXT,
                file_path TEXT NOT NULL,
                source_author TEXT,
                source_caption TEXT,
                top_comment TEXT,
                status TEXT NOT NULL DEFAULT 'queued',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                published_at TEXT,
                error TEXT
            )""")
            columns = {row["name"] for row in db.execute("PRAGMA table_info(videos)")}
            if "claimed_at" not in columns:
                db.execute("ALTER TABLE videos ADD COLUMN claimed_at TEXT")
            if "publishing_started_at" not in columns:
                db.execute("ALTER TABLE videos ADD COLUMN publishing_started_at TEXT")

            # Rows created by older local publishers have no claim timestamp.
            # Their delivery state cannot be reconstructed, so quarantine them.
            db.execute(
                """UPDATE videos
                   SET status='failed', claimed_at=NULL,
                       error=? || COALESCE(error, 'no previous error recorded')
                   WHERE status='processing' AND claimed_at IS NULL
                     AND (error IS NULL OR error NOT LIKE 'UNCERTAIN DELIVERY:%')""",
                (UNCERTAIN_DELIVERY + " legacy processing row; check channel before retry. Previous error: ",),
            )
            # Older versions marked send exceptions as ordinary failures. Telegram
            # may nevertheless have accepted those sends, so require confirmation.
            db.execute(
                """UPDATE videos
                   SET error=? || COALESCE(error, 'no previous error recorded')
                   WHERE status='failed'
                     AND (error IS NULL OR error NOT LIKE 'UNCERTAIN DELIVERY:%')""",
                (UNCERTAIN_DELIVERY + " legacy failure; check channel before retry. Previous error: ",),
            )

    def add(self, file_path: str, source_url: str = "", author: str = "", caption: str = "", comment: str = "") -> int:
        with self.connect() as db:
            cur = db.execute(
                "INSERT INTO videos(source_url,file_path,source_author,source_caption,top_comment) VALUES(?,?,?,?,?)",
                (source_url, file_path, author, caption, comment),
            )
            return int(cur.lastrowid)

    def queued(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._recover_stale(db)
            rows = db.execute("SELECT * FROM videos WHERE status='queued' ORDER BY id").fetchall()
            return [dict(row) for row in rows]

    def get(self, item_id: int):
        with self.connect() as db:
            row = db.execute("SELECT * FROM videos WHERE id=?", (item_id,)).fetchone()
            return dict(row) if row else None

    def claim(self, item_id: int) -> dict[str, Any] | None:
        """Atomically claim one queued item; competing publishers cannot claim it twice."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._recover_stale(db)
            cur = db.execute(
                """UPDATE videos
                   SET status='processing', claimed_at=CURRENT_TIMESTAMP,
                       publishing_started_at=NULL, error=NULL
                   WHERE id=? AND status='queued'""",
                (item_id,),
            )
            if cur.rowcount != 1:
                return None
            row = db.execute("SELECT * FROM videos WHERE id=?", (item_id,)).fetchone()
            return dict(row) if row else None

    def _recover_stale(self, db):
        # A claim with no send marker is safe to retry. Once the marker exists,
        # Telegram may have accepted the message, so automatic retry is unsafe.
        db.execute(
            """UPDATE videos
               SET status='queued', claimed_at=NULL, error='Recovered stale claim before send'
               WHERE status='processing'
                 AND publishing_started_at IS NULL
                 AND claimed_at < datetime('now', ?)""",
            (f"-{self.CLAIM_TIMEOUT_MINUTES} minutes",),
        )
        db.execute(
            """UPDATE videos
               SET status='failed', claimed_at=NULL,
                   error=?
               WHERE status='processing'
                 AND publishing_started_at IS NOT NULL
                 AND claimed_at < datetime('now', ?)""",
            (UNCERTAIN_DELIVERY + " process stopped after send was initiated; check channel before retry", f"-{self.CLAIM_TIMEOUT_MINUTES} minutes"),
        )

    def mark_publishing_started(self, item_id: int) -> bool:
        with self.connect() as db:
            cur = db.execute(
                """UPDATE videos SET publishing_started_at=CURRENT_TIMESTAMP
                   WHERE id=? AND status='processing' AND publishing_started_at IS NULL""",
                (item_id,),
            )
            return cur.rowcount == 1

    def mark_publish_failed(self, item_id: int, error: str):
        with self.connect() as db:
            row = db.execute(
                "SELECT publishing_started_at FROM videos WHERE id=? AND status='processing'",
                (item_id,),
            ).fetchone()
            if not row:
                return
            message = (str(error)[:450] if row["publishing_started_at"] is None
                       else UNCERTAIN_DELIVERY + " " + str(error)[:430])
            db.execute(
                "UPDATE videos SET status='failed', error=?, claimed_at=NULL WHERE id=? AND status='processing'",
                (message, item_id),
            )

    def set_status(self, item_id: int, status: str, error: str | None = None):
        with self.connect() as db:
            if status == "published":
                db.execute(
                    """UPDATE videos SET status=?, published_at=CURRENT_TIMESTAMP,
                       error=NULL, claimed_at=NULL WHERE id=?""",
                    (status, item_id),
                )
            else:
                db.execute(
                    "UPDATE videos SET status=?, error=?, claimed_at=NULL WHERE id=?",
                    (status, error, item_id),
                )

    def remove(self, item_id: int):
        with self.connect() as db:
            db.execute("DELETE FROM videos WHERE id=? AND status='queued'", (item_id,))

    def published_between(self, start_utc: str, end_utc: str) -> int:
        with self.connect() as db:
            row = db.execute(
                "SELECT COUNT(*) AS n FROM videos WHERE status='published' AND published_at >= ? AND published_at < ?",
                (start_utc, end_utc),
            ).fetchone()
            return int(row["n"])

    def requeue(self, item_id: int, confirm_uncertain: bool = False) -> bool:
        """Retry ordinary failures; uncertain delivery requires explicit owner confirmation."""
        condition = "(error IS NULL OR error NOT LIKE 'UNCERTAIN DELIVERY:%')"
        if confirm_uncertain:
            condition = "1=1"
        with self.connect() as db:
            cur = db.execute(
                """UPDATE videos SET status='queued', error=NULL, claimed_at=NULL,
                   publishing_started_at=NULL
                   WHERE id=? AND status='failed' AND """ + condition,
                (item_id,),
            )
            return cur.rowcount > 0

    def counts(self) -> dict[str, int]:
        with self.connect() as db:
            rows = db.execute("SELECT status, COUNT(*) AS n FROM videos GROUP BY status").fetchall()
            return {row["status"]: int(row["n"]) for row in rows}
