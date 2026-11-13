import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.db import Store
from app.publisher import make_caption
from app.scheduler import publish_due


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


class LocalSchedulerTests(unittest.TestCase):
    def test_publishes_queued_item_without_daily_or_time_window_gate(self):
        queued_item = {"id": 17}
        store = SimpleNamespace(queued=lambda: [queued_item])
        cfg = SimpleNamespace(channel_id="@zadrot1705")
        bot = object()

        with patch("app.scheduler.publish_one", new_callable=AsyncMock) as publish:
            asyncio.run(publish_due(bot, store, cfg))
            publish.assert_awaited_once_with(bot, store, "@zadrot1705", queued_item)

    def test_does_nothing_when_queue_is_empty(self):
        store = SimpleNamespace(queued=lambda: [])
        cfg = SimpleNamespace(channel_id="@zadrot1705")

        with patch("app.scheduler.publish_one", new_callable=AsyncMock) as publish:
            asyncio.run(publish_due(object(), store, cfg))
            publish.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
