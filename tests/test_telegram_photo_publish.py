import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, features

# The queue script reads its environment at import time.
os.environ.setdefault("WORKER_API_URL", "https://worker.example")
os.environ.setdefault("WORKER_API_SECRET", "test-secret")
os.environ.setdefault("BOT_TOKEN", "123:test-token")
os.environ.setdefault("CHANNEL_ID", "@test-channel")

from scripts.process_queue import publish_photos, validate_telegram_photo


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
            Image.new("RGB", (32, 24), (index, 0, 0)).save(path, format="JPEG")
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
    def test_dimension_sum_over_10000_rejected_before_any_upload(self, post):
        with tempfile.TemporaryDirectory() as tmp:
            valid = self.make_photos(tmp, 1)[0]
            invalid = Path(tmp) / "too-large-dimensions.jpg"
            Image.new("RGB", (5001, 5000)).save(invalid, format="JPEG")
            with self.assertRaisesRegex(RuntimeError, "10,000-pixel"):
                publish_photos([valid, invalid], "")
        post.assert_not_called()

    @patch("scripts.process_queue.requests.post", return_value=FakeResponse())
    def test_aspect_ratio_over_20_rejected_before_upload(self, post):
        with tempfile.TemporaryDirectory() as tmp:
            photo = Path(tmp) / "panorama.jpg"
            Image.new("RGB", (2100, 100)).save(photo, format="JPEG")
            with self.assertRaisesRegex(RuntimeError, "20:1"):
                publish_photos([photo], "")
        post.assert_not_called()

    def test_webp_photo_passes_preflight(self):
        with tempfile.TemporaryDirectory() as tmp:
            photo = Path(tmp) / "photo.webp"
            Image.new("RGB", (40, 30), (20, 80, 120)).save(photo, format="WEBP")
            validate_telegram_photo(photo)

    @unittest.skipUnless(features.check("avif"), "Pillow AVIF codec is unavailable")
    def test_avif_photo_passes_preflight(self):
        with tempfile.TemporaryDirectory() as tmp:
            photo = Path(tmp) / "photo.avif"
            Image.new("RGB", (40, 30), (20, 80, 120)).save(photo, format="AVIF")
            validate_telegram_photo(photo)

    @patch("scripts.process_queue.requests.post", return_value=FakeResponse())
    def test_corrupt_image_rejected_before_upload(self, post):
        with tempfile.TemporaryDirectory() as tmp:
            photo = Path(tmp) / "broken.jpg"
            photo.write_bytes(b"not an image")
            with self.assertRaisesRegex(RuntimeError, "unreadable"):
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


    @patch("scripts.process_queue.requests.post", return_value=FakeResponse())
    def test_eleven_photos_use_album_of_ten_then_single_photo(self, post):
        with tempfile.TemporaryDirectory() as tmp:
            photos = self.make_photos(tmp, 11)
            publish_photos(photos, "caption")
        self.assertEqual(post.call_count, 2)
        first_url = post.call_args_list[0].args[0]
        second_url = post.call_args_list[1].args[0]
        self.assertTrue(first_url.endswith("/sendMediaGroup"))
        self.assertTrue(second_url.endswith("/sendPhoto"))
        first_media = json.loads(post.call_args_list[0].kwargs["data"]["media"])
        self.assertEqual(len(first_media), 10)
        self.assertEqual(first_media[0]["caption"], "caption")
        self.assertEqual(post.call_args_list[1].kwargs["data"]["caption"], "")

    @patch("scripts.process_queue.requests.post", return_value=FakeResponse())
    def test_photo_batches_preserve_filename_order(self, post):
        with tempfile.TemporaryDirectory() as tmp:
            photos = self.make_photos(tmp, 12)
            publish_photos(photos, "caption")
        uploaded = []
        for call in post.call_args_list:
            if call.args[0].endswith("/sendMediaGroup"):
                media = json.loads(call.kwargs["data"]["media"])
                uploaded.extend(item["media"] for item in media)
            else:
                uploaded.append("single-photo")
        self.assertEqual(len(uploaded), 12)
        first = json.loads(post.call_args_list[0].kwargs["data"]["media"])
        second = json.loads(post.call_args_list[1].kwargs["data"]["media"])
        self.assertEqual([item["media"] for item in first], [f"attach://photo{i}" for i in range(10)])
        self.assertEqual([item["media"] for item in second], ["attach://photo0", "attach://photo1"])


if __name__ == "__main__":
    unittest.main()
