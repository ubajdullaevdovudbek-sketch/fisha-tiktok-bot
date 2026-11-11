import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# The queue script reads its environment at import time.
os.environ.setdefault("WORKER_API_URL", "https://worker.example")
os.environ.setdefault("WORKER_API_SECRET", "test-secret")
os.environ.setdefault("BOT_TOKEN", "123:test-token")
os.environ.setdefault("CHANNEL_ID", "@test-channel")

from scripts.process_queue import publish_photos


class FakeResponse:
    status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return {"ok": True, "result": []}


class TelegramPhotoPublishTests(unittest.TestCase):
    def make_photos(self, folder, count):
        paths = []
        for index in range(count):
            path = Path(folder) / f"{index + 1:03}.jpg"
            path.write_bytes(b"image")
            paths.append(path)
        return paths

    @patch("scripts.process_queue.requests.post", return_value=FakeResponse())
    def test_single_photo_uses_send_photo(self, post):
        with tempfile.TemporaryDirectory() as tmp:
            photos = self.make_photos(tmp, 1)
            publish_photos(photos, "caption")
        self.assertTrue(post.call_args.args[0].endswith("/sendPhoto"))
        self.assertEqual(post.call_args.kwargs["data"]["caption"], "caption")

    @patch("scripts.process_queue.requests.post", return_value=FakeResponse())
    def test_two_photos_use_one_media_group_with_first_caption(self, post):
        with tempfile.TemporaryDirectory() as tmp:
            publish_photos(self.make_photos(tmp, 2), "caption")
        self.assertTrue(post.call_args.args[0].endswith("/sendMediaGroup"))
        media = json.loads(post.call_args.kwargs["data"]["media"])
        self.assertEqual(len(media), 2)
        self.assertEqual(media[0]["caption"], "caption")
        self.assertNotIn("caption", media[1])

    @patch("scripts.process_queue.requests.post", return_value=FakeResponse())
    def test_more_than_ten_photos_split_into_groups(self, post):
        with tempfile.TemporaryDirectory() as tmp:
            publish_photos(self.make_photos(tmp, 12), "caption")
        self.assertEqual(post.call_count, 2)
        first = json.loads(post.call_args_list[0].kwargs["data"]["media"])
        second = json.loads(post.call_args_list[1].kwargs["data"]["media"])
        self.assertEqual(len(first), 10)
        self.assertEqual(len(second), 2)
        self.assertEqual(first[0]["caption"], "caption")
        self.assertNotIn("caption", second[0])

    @patch("scripts.process_queue.requests.post", return_value=FakeResponse())
    def test_oversized_photo_is_rejected_before_upload(self, post):
        with tempfile.TemporaryDirectory() as tmp:
            photo = Path(tmp) / "large.jpg"
            with photo.open("wb") as output:
                output.truncate(10 * 1024 * 1024 + 1)
            with self.assertRaisesRegex(RuntimeError, "10 MB"):
                publish_photos([photo], "")
        post.assert_not_called()

    @patch("scripts.process_queue.requests.post", return_value=FakeResponse())
    def test_telegram_api_error_is_reported(self, post):
        response = FakeResponse()
        response.json = lambda: {"ok": False, "description": "bad album"}
        post.return_value = response
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError, "bad album"):
                publish_photos(self.make_photos(tmp, 2), "")


if __name__ == "__main__":
    unittest.main()
