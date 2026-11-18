import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

from app.tiktok_live_photos import (
    TikTokLivePhotoError,
    download_tiktok_live_photo_album,
)


class TikTokLivePhotoTests(unittest.TestCase):
    def response(self, payload):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = payload
        return response

    def media_response(self, content_type, body):
        response = MagicMock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.raise_for_status.return_value = None
        response.headers = {"Content-Type": content_type}
        response.iter_content.return_value = [body]
        return response

    def test_downloads_native_live_photo_pairs_and_still_slides_in_order(self):
        payload = {
            "code": 0,
            "data": {
                "images": [
                    "https://p16.tiktokcdn-us.com/slide1.jpeg",
                    "https://p16.tiktokcdn-us.com/slide2.jpeg",
                    "https://p16.tiktokcdn-us.com/slide3.jpeg",
                ],
                "live_images": [
                    "https://v19.tiktokcdn-us.com/slide1.mp4",
                    "",
                    "https://v19.tiktokcdn-us.com/slide3.mp4",
                ],
            },
        }
        with tempfile.TemporaryDirectory() as tmp, \\
             patch("app.tiktok_live_photos.requests.post", return_value=self.response(payload)), \\
             patch("app.tiktok_live_photos.requests.get", side_effect=[
                 self.media_response("image/jpeg", b"jpg-one"),
                 self.media_response("video/mp4", b"mp4-one"),
                 self.media_response("image/jpeg", b"jpg-two"),
                 self.media_response("image/jpeg", b"jpg-three"),
                 self.media_response("video/mp4", b"mp4-three"),
             ]) as getter:
            album = download_tiktok_live_photo_album("https://www.tiktok.com/@u/photo/123", Path(tmp))

        self.assertEqual([kind for kind, _ in album], ["live_photo", "photo", "live_photo"])
        self.assertEqual(album[0][1][0].name, "slide_001.jpg")
        self.assertEqual(album[0][1][1].name, "slide_001.mp4")
        self.assertEqual(album[1][1].name, "slide_002.jpg")
        self.assertEqual(album[2][1][0].name, "slide_003.jpg")
        self.assertEqual(album[2][1][1].name, "slide_003.mp4")
        self.assertEqual(getter.call_count, 5)

    def test_returns_none_when_post_has_no_live_motion(self):
        payload = {"code": 0, "data": {"images": ["https://p16.tiktokcdn.com/a.jpeg"], "live_images": []}}
        with patch("app.tiktok_live_photos.requests.post", return_value=self.response(payload)):
            self.assertIsNone(download_tiktok_live_photo_album("https://www.tiktok.com/@u/photo/123", Path("/tmp/not-used")))

    def test_rejects_mismatched_arrays_to_prevent_wrong_pairing(self):
        payload = {"code": 0, "data": {
            "images": ["https://p16.tiktokcdn.com/a.jpeg", "https://p16.tiktokcdn.com/b.jpeg"],
            "live_images": ["https://v19.tiktokcdn.com/a.mp4"],
        }}
        with patch("app.tiktok_live_photos.requests.post", return_value=self.response(payload)):
            with self.assertRaisesRegex(TikTokLivePhotoError, "alignment mismatch"):
                download_tiktok_live_photo_album("https://www.tiktok.com/@u/photo/123", Path("/tmp/not-used"))

    def test_rejects_untrusted_motion_host(self):
        payload = {"code": 0, "data": {
            "images": ["https://p16.tiktokcdn.com/a.jpeg"],
            "live_images": ["https://example.com/a.mp4"],
        }}
        with tempfile.TemporaryDirectory() as tmp, \\
             patch("app.tiktok_live_photos.requests.post", return_value=self.response(payload)), \\
             patch("app.tiktok_live_photos.requests.get", return_value=self.media_response("image/jpeg", b"still")):
            with self.assertRaisesRegex(TikTokLivePhotoError, "Untrusted Live Photo URL"):
                download_tiktok_live_photo_album("https://www.tiktok.com/@u/photo/123", Path(tmp))

    def test_rejects_non_mp4_motion_content(self):
        payload = {"code": 0, "data": {
            "images": ["https://p16.tiktokcdn.com/a.jpeg"],
            "live_images": ["https://v19.tiktokcdn.com/a.mp4"],
        }}
        with tempfile.TemporaryDirectory() as tmp, \
             patch("app.tiktok_live_photos.requests.post", return_value=self.response(payload)), \
             patch("app.tiktok_live_photos.requests.get", side_effect=[
                 self.media_response("image/jpeg", b"still"),
                 self.media_response("text/html", b"error"),
             ]):
            with self.assertRaisesRegex(TikTokLivePhotoError, "Expected MP4"):
                download_tiktok_live_photo_album("https://www.tiktok.com/@u/photo/123", Path(tmp))

    def test_rejects_motion_clip_over_telegram_safe_limit(self):
        payload = {"code": 0, "data": {
            "images": ["https://p16.tiktokcdn.com/a.jpeg"],
            "live_images": ["https://v19.tiktokcdn.com/a.mp4"],
        }}
        oversized = self.media_response("video/mp4", b"123456")
        with tempfile.TemporaryDirectory() as tmp, \
             patch("app.tiktok_live_photos.MAX_LIVE_VIDEO_BYTES", 5), \
             patch("app.tiktok_live_photos.requests.post", return_value=self.response(payload)), \
             patch("app.tiktok_live_photos.requests.get", return_value=oversized):
            with self.assertRaisesRegex(TikTokLivePhotoError, "48 MB"):
                download_tiktok_live_photo_album("https://www.tiktok.com/@u/photo/123", Path(tmp))


if __name__ == "__main__":
    unittest.main()
