import tempfile
import unittest
from pathlib import Path

from app.db import Store
from app.publisher import make_caption


class StoreTests(unittest.TestCase):
    def test_add_and_queue(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "test.sqlite3")
            item_id = store.add("/tmp/clip.mp4", "https://www.tiktok.com/@a/video/1", "@creator", "A caption")
            queued = store.queued()
            self.assertEqual(len(queued), 1)
            self.assertEqual(queued[0]["id"], item_id)
            self.assertEqual(queued[0]["source_author"], "@creator")

    def test_status_removes_from_queue(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "test.sqlite3")
            item_id = store.add("/tmp/clip.mp4")
            store.set_status(item_id, "failed", "test")
            self.assertEqual(store.queued(), [])


class CaptionTests(unittest.TestCase):
    def test_author_is_plain_text_not_mention(self):
        caption = make_caption({"source_author": "@creator", "source_caption": "Hello"})
        self.assertIn("Автор оригинала: @creator", caption)
        self.assertNotIn("https://t.me/creator", caption)

    def test_top_comment_only_when_available(self):
        caption = make_caption({"source_caption": "Hello"})
        self.assertNotIn("Популярный комментарий", caption)


if __name__ == "__main__":
    unittest.main()
