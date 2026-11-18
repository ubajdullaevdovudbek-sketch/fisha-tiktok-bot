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

    def test_downloads_motion_and_still_slides_in_original_order_using_get_api(self):
        payload = {"code": 0, "data": {
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
        }}
        responses = [
            self.response(payload),
            self.media_response("image/jpeg", b"jpg-one"),
            self.media_response("video/mp4", b"mp4-one"),
            self.media_response("image/jpeg", b"jpg-two"),
            self.media_response("image/jpeg", b"jpg-three"),
            self.media_response("video/mp4", b"mp4-three"),
        ]
        with tempfile.TemporaryDirectory() as tmp, patch(
            "app.tiktok_live_photos.requests.get", side_effect=responses
        ) as getter:
            album = download_tiktok_live_photo_album(
                "https://www.tiktok.com/@u/photo/123", Path(tmp)
            )

        self.assertEqual([kind for kind, _ in album], ["video", "photo", "video"])
        self.assertEqual([path.name for _, path in album], [
            "slide_001.mp4", "slide_002.jpg", "slide_003.mp4"
        ])
        self.assertEqual(getter.call_count, 6)
        self.assertEqual(getter.call_args_list[0].kwargs["params"], {
            "url": "https://www.tiktok.com/@u/photo/123", "hd": "1"
        })
        self.assertEqual(
            getter.call_args_list[0].kwargs["headers"]["Referer"],
            "https://www.tiktok.com/",
        )

    def test_returns_none_when_api_has_no_live_motion(self):
        payload = {"code": 0, "data": {
            "images": ["https://p16.tiktokcdn.com/a.jpeg"], "live_images": []
        }}
        with patch(
            "app.tiktok_live_photos.requests.get",
            return_value=self.response(payload),
        ):
            self.assertIsNone(download_tiktok_live_photo_album(
                "https://www.tiktok.com/@u/photo/123", Path("/tmp/not-used")
            ))

    def test_pads_short_motion_array_without_shifting_slide_pairing(self):
        payload = {"code": 0, "data": {
            "images": [
                "https://p16.tiktokcdn.com/a.jpeg",
                "https://p16.tiktokcdn.com/b.jpeg",
            ],
            "live_images": ["https://v19.tiktokcdn.com/a.mp4"],
        }}
        responses = [
            self.response(payload),
            self.media_response("image/jpeg", b"still-a"),
            self.media_response("video/mp4", b"motion-a"),
            self.media_response("image/jpeg", b"still-b"),
        ]
        with tempfile.TemporaryDirectory() as tmp, patch(
            "app.tiktok_live_photos.requests.get", side_effect=responses
        ):
            album = download_tiktok_live_photo_album(
                "https://www.tiktok.com/@u/photo/123", Path(tmp)
            )
        self.assertEqual([kind for kind, _ in album], ["video", "photo"])

    def test_rejects_motion_array_longer_than_image_array(self):
        payload = {"code": 0, "data": {
            "images": ["https://p16.tiktokcdn.com/a.jpeg"],
            "live_images": [
                "https://v19.tiktokcdn.com/a.mp4",
                "https://v19.tiktokcdn.com/b.mp4",
            ],
        }}
        with patch(
            "app.tiktok_live_photos.requests.get",
            return_value=self.response(payload),
        ):
            with self.assertRaisesRegex(TikTokLivePhotoError, "alignment mismatch"):
                download_tiktok_live_photo_album(
                    "https://www.tiktok.com/@u/photo/123", Path("/tmp/not-used")
                )

    def test_untrusted_motion_host_falls_back_to_still(self):
        payload = {"code": 0, "data": {
            "images": ["https://p16.tiktokcdn.com/a.jpeg"],
            "live_images": ["https://example.com/a.mp4"],
        }}
        with tempfile.TemporaryDirectory() as tmp, patch(
            "app.tiktok_live_photos.requests.get",
            side_effect=[
                self.response(payload),
                self.media_response("image/jpeg", b"still"),
            ],
        ):
            album = download_tiktok_live_photo_album(
                "https://www.tiktok.com/@u/photo/123", Path(tmp)
            )
        self.assertEqual([kind for kind, _ in album], ["photo"])

    def test_non_mp4_motion_response_falls_back_to_still(self):
        payload = {"code": 0, "data": {
            "images": ["https://p16.tiktokcdn.com/a.jpeg"],
            "live_images": ["https://v19.tiktokcdn.com/a.mp4"],
        }}
        with tempfile.TemporaryDirectory() as tmp, patch(
            "app.tiktok_live_photos.requests.get",
            side_effect=[
                self.response(payload),
                self.media_response("image/jpeg", b"still"),
                self.media_response("text/html", b"error"),
            ],
        ):
            album = download_tiktok_live_photo_album(
                "https://www.tiktok.com/@u/photo/123", Path(tmp)
            )
        self.assertEqual([kind for kind, _ in album], ["photo"])

    def test_oversized_motion_clip_falls_back_to_still(self):
        payload = {"code": 0, "data": {
            "images": ["https://p16.tiktokcdn.com/a.jpeg"],
            "live_images": ["https://v19.tiktokcdn.com/a.mp4"],
        }}
        with tempfile.TemporaryDirectory() as tmp, patch(
            "app.tiktok_live_photos.MAX_LIVE_VIDEO_BYTES", 5
        ), patch(
            "app.tiktok_live_photos.requests.get",
            side_effect=[
                self.response(payload),
                self.media_response("image/jpeg", b"still"),
                self.media_response("video/mp4", b"123456"),
            ],
        ):
            album = download_tiktok_live_photo_album(
                "https://www.tiktok.com/@u/photo/123", Path(tmp)
            )
        self.assertEqual([kind for kind, _ in album], ["photo"])
        self.assertFalse((Path(tmp) / "slide_001.mp4").exists())


if __name__ == "__main__":
    unittest.main()
