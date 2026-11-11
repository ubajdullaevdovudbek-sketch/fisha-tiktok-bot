import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.tiktok_photos import is_tiktok_photo_url, download_tiktok_photos


class TikTokPhotoTests(unittest.TestCase):
    def test_detects_photo_path(self):
        self.assertTrue(is_tiktok_photo_url("https://www.tiktok.com/@user/photo/123"))
        self.assertFalse(is_tiktok_photo_url("https://www.tiktok.com/@user/video/123"))

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
            with patch("app.tiktok_photos.subprocess.run", side_effect=fake_run):
                photos = download_tiktok_photos("https://www.tiktok.com/@u/photo/1", Path(tmp))
            self.assertEqual([p.name for p in photos], ["001.jpg", "002.jpg"])

    def test_raises_when_gallery_dl_fails(self):
        class Result:
            returncode = 1
            stdout = ""
            stderr = "private post"

        with tempfile.TemporaryDirectory() as tmp:
            with patch("app.tiktok_photos.subprocess.run", return_value=Result()):
                with self.assertRaisesRegex(RuntimeError, "private post"):
                    download_tiktok_photos("https://www.tiktok.com/@u/photo/1", Path(tmp))

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
