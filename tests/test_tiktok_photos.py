import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.tiktok_photos import is_tiktok_photo_url, download_tiktok_photos


class TikTokPhotoTests(unittest.TestCase):
    def test_detects_photo_path_only_on_tiktok_https_hosts(self):
        self.assertTrue(is_tiktok_photo_url("https://www.tiktok.com/@user/photo/123"))
        self.assertTrue(is_tiktok_photo_url("https://m.tiktok.com/@user/photo/123"))
        self.assertFalse(is_tiktok_photo_url("https://www.tiktok.com/@user/video/123"))
        self.assertFalse(is_tiktok_photo_url("https://example.com/@user/photo/123"))
        self.assertFalse(is_tiktok_photo_url("https://tiktok.com.example.org/@user/photo/123"))
        self.assertFalse(is_tiktok_photo_url("http://www.tiktok.com/@user/photo/123"))

    def test_download_rejects_non_tiktok_photo_url_before_running_gallery_dl(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch("app.tiktok_photos.subprocess.run") as runner:
                with self.assertRaisesRegex(RuntimeError, "HTTPS TikTok Photo Mode URL"):
                    download_tiktok_photos("https://example.com/@u/photo/1", Path(tmp))
        runner.assert_not_called()

    def test_downloads_and_sorts_images_by_slide_number(self):
        class Result:
            returncode = 0
            stdout = ""
            stderr = ""

        def fake_run(command, **kwargs):
            folder = Path(command[command.index("--directory") + 1])
            (folder / "002.jpg").write_bytes(b"second")
            (folder / "001.jpg").write_bytes(b"first")
            (folder / "notes.txt").write_text("ignore")
            return Result()

        with tempfile.TemporaryDirectory() as tmp:
            with patch("app.tiktok_photos.subprocess.run", side_effect=fake_run) as runner:
                photos = download_tiktok_photos("https://www.tiktok.com/@u/photo/1", Path(tmp))
            self.assertEqual([p.name for p in photos], ["001.jpg", "002.jpg"])
            command = runner.call_args.args[0]
            self.assertIn("{num:03}.{extension}", command)
            self.assertIn("extractor.tiktok.photos=true", command)
            self.assertIn("extractor.tiktok.audio=false", command)

    def test_raises_when_gallery_dl_fails(self):
        class Result:
            returncode = 1
            stdout = ""
            stderr = "private post"

        with tempfile.TemporaryDirectory() as tmp:
            with patch("app.tiktok_photos.subprocess.run", return_value=Result()):
                with self.assertRaisesRegex(RuntimeError, "private post"):
                    download_tiktok_photos("https://www.tiktok.com/@u/photo/1", Path(tmp))

    def test_retries_transient_gallery_dl_failure(self):
        class Failed:
            returncode = 1
            stdout = ""
            stderr = "HTTP Error 503: service unavailable"

        class Success:
            returncode = 0
            stdout = ""
            stderr = ""

        def fake_run(command, **kwargs):
            if fake_run.calls == 0:
                fake_run.calls += 1
                return Failed()
            folder = Path(command[command.index("--directory") + 1])
            (folder / "001.jpg").write_bytes(b"image")
            return Success()
        fake_run.calls = 0

        with tempfile.TemporaryDirectory() as tmp:
            with patch("app.tiktok_photos.subprocess.run", side_effect=fake_run) as runner, \
                 patch("app.tiktok_photos.time.sleep"):
                photos = download_tiktok_photos("https://www.tiktok.com/@u/photo/1", Path(tmp))
        self.assertEqual([photo.name for photo in photos], ["001.jpg"])
        self.assertEqual(runner.call_count, 2)

    def test_does_not_retry_private_post(self):
        class Failed:
            returncode = 1
            stdout = ""
            stderr = "private post"

        with tempfile.TemporaryDirectory() as tmp:
            with patch("app.tiktok_photos.subprocess.run", return_value=Failed()) as runner:
                with self.assertRaisesRegex(RuntimeError, "private"):
                    download_tiktok_photos("https://www.tiktok.com/@u/photo/1", Path(tmp))
        self.assertEqual(runner.call_count, 1)

    def test_retries_gallery_dl_timeout_then_reports_clear_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch("app.tiktok_photos.subprocess.run", side_effect=subprocess.TimeoutExpired("gallery-dl", 180)) as runner, \
                 patch("app.tiktok_photos.time.sleep"):
                with self.assertRaisesRegex(RuntimeError, "3 attempts.*timed out"):
                    download_tiktok_photos("https://www.tiktok.com/@u/photo/1", Path(tmp))
        self.assertEqual(runner.call_count, 3)

    def test_raises_when_no_images_returned(self):
        class Result:
            returncode = 0
            stdout = ""
            stderr = ""

        with tempfile.TemporaryDirectory() as tmp:
            with patch("app.tiktok_photos.subprocess.run", return_value=Result()):
                with self.assertRaisesRegex(RuntimeError, "no images"):
                    download_tiktok_photos("https://www.tiktok.com/@u/photo/1", Path(tmp))


if __name__ == "__main__":
    unittest.main()
