import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.db import Store
from app.publisher import make_caption, publish_one
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


class LocalDeliverySafetyTests(unittest.TestCase):
    def make_store(self, tmp):
        store = Store(Path(tmp) / "safe.sqlite3")
        video = Path(tmp) / "clip.mp4"
        video.write_bytes(b"video")
        item_id = store.add(str(video))
        return store, item_id

    def test_only_one_claim_succeeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, item_id = self.make_store(tmp)
            self.assertIsNotNone(store.claim(item_id))
            self.assertIsNone(store.claim(item_id))

    def test_uncertain_failure_requires_explicit_retry_confirmation(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, item_id = self.make_store(tmp)
            self.assertIsNotNone(store.claim(item_id))
            self.assertTrue(store.mark_publishing_started(item_id))
            store.mark_publish_failed(item_id, "connection reset")
            self.assertFalse(store.requeue(item_id))
            self.assertTrue(store.requeue(item_id, confirm_uncertain=True))

    def test_failure_before_send_can_be_retried_normally(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, item_id = self.make_store(tmp)
            self.assertIsNotNone(store.claim(item_id))
            store.mark_publish_failed(item_id, "local validation failed")
            self.assertTrue(store.requeue(item_id))

    def test_stale_claim_without_send_marker_is_recovered(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, item_id = self.make_store(tmp)
            self.assertIsNotNone(store.claim(item_id))
            with store.connect() as db:
                db.execute(
                    "UPDATE videos SET claimed_at=datetime('now','-21 minutes') WHERE id=?",
                    (item_id,),
                )
            self.assertEqual(store.queued()[0]["id"], item_id)

    def test_stale_claim_after_send_marker_becomes_uncertain(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, item_id = self.make_store(tmp)
            self.assertIsNotNone(store.claim(item_id))
            self.assertTrue(store.mark_publishing_started(item_id))
            with store.connect() as db:
                db.execute(
                    "UPDATE videos SET claimed_at=datetime('now','-21 minutes') WHERE id=?",
                    (item_id,),
                )
            self.assertEqual(store.queued(), [])
            item = store.get(item_id)
            self.assertEqual(item["status"], "failed")
            self.assertTrue(item["error"].startswith("UNCERTAIN DELIVERY:"))

    def test_telegram_exception_after_marker_is_uncertain(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, item_id = self.make_store(tmp)
            bot = SimpleNamespace(send_video=AsyncMock(side_effect=RuntimeError("connection reset")))
            item = store.get(item_id)
            result = asyncio.run(publish_one(bot, store, "@channel", item))
            self.assertFalse(result)
            self.assertEqual(store.get(item_id)["status"], "failed")
            self.assertTrue(store.get(item_id)["error"].startswith("UNCERTAIN DELIVERY:"))

    def test_two_publishers_do_not_send_same_item(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, item_id = self.make_store(tmp)
            bot = SimpleNamespace(send_video=AsyncMock())
            item = store.get(item_id)
            async def run_both():
                return await asyncio.gather(
                    publish_one(bot, store, "@channel", item),
                    publish_one(bot, store, "@channel", item),
                )
            results = asyncio.run(run_both())
            self.assertEqual(sum(bool(x) for x in results), 1)
            bot.send_video.assert_awaited_once()
