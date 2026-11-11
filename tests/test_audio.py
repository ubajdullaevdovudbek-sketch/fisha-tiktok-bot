import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.audio import extract_audio_mp3


class AudioExtractionTests(unittest.TestCase):
    def test_extracts_mp3_from_video(self):
        class Result:
            returncode = 0
            stdout = ""
            stderr = ""

        def fake_run(command, **kwargs):
            Path(command[-1]).write_bytes(b"mp3-data")
            self.assertIn("libmp3lame", command)
            self.assertIn("128k", command)
            self.assertIn("-vn", command)
            return Result()

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "audio.mp3"
            with patch("app.audio.subprocess.run", side_effect=fake_run):
                result = extract_audio_mp3(Path(tmp) / "video.mp4", output)
            self.assertEqual(result, output)
            self.assertEqual(output.read_bytes(), b"mp3-data")

    def test_reports_ffmpeg_error(self):
        class Result:
            returncode = 1
            stdout = ""
            stderr = "video has no audio stream"

        with tempfile.TemporaryDirectory() as tmp:
            with patch("app.audio.subprocess.run", return_value=Result()):
                with self.assertRaisesRegex(RuntimeError, "no audio stream"):
                    extract_audio_mp3(Path(tmp) / "video.mp4", Path(tmp) / "audio.mp3")


if __name__ == "__main__":
    unittest.main()
