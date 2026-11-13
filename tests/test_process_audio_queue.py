import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


os.environ.setdefault("WORKER_API_URL", "https://worker.invalid")
os.environ.setdefault("WORKER_API_SECRET", "test-secret")
os.environ.setdefault("BOT_TOKEN", "test-token")
os.environ.setdefault("CHANNEL_ID", "@test-channel")

audio_queue = importlib.import_module("scripts.process_audio_queue")


class AudioQueueTests(unittest.TestCase):
    def test_api_rejects_worker_ok_false_response(self):
        response = Mock(status_code=200)
        response.raise_for_status.return_value = None
        response.json.return_value = {"ok": False, "error": "job is not processing"}
        with patch.object(audio_queue.requests, "post", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "job is not processing"):
                audio_queue.api("/api/audio/complete", {"id": 7})

    def test_send_audio_runs_delivery_marker_before_network_request(self):
        events = []
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"ok": True}
        with tempfile.TemporaryDirectory() as tmp:
            mp3 = Path(tmp) / "audio.mp3"
            mp3.write_bytes(b"mp3")
            def post(*args, **kwargs):
                events.append("telegram-send")
                return response
            with patch.object(audio_queue.requests, "post", side_effect=post):
                audio_queue.send_audio(mp3, "title", before_send=lambda: events.append("marker"))
        self.assertEqual(events, ["marker", "telegram-send"])

    def test_process_one_marks_started_before_send_and_completes(self):
        events = []
        claim = {"job": {"id": 17, "kind": "telegram_file",
                         "telegram_file_id": "file-id", "title": "sample"}}
        def api(path, payload=None):
            events.append((path, payload))
            if path == "/api/audio/claim":
                return claim
            return {"ok": True}
        def download(job, folder):
            source = folder / "source.mp4"
            source.write_bytes(b"video")
            return source
        def extract(source, target):
            target.write_bytes(b"mp3")
            return target
        def send(path, title):
            events.append(("telegram-send", title))
        with patch.object(audio_queue, "api", side_effect=api), \
             patch.object(audio_queue, "download_video", side_effect=download), \
             patch.object(audio_queue, "extract_audio_mp3", side_effect=extract), \
             patch.object(audio_queue, "send_audio", side_effect=send):
            self.assertTrue(audio_queue.process_one())
        names = [event[0] for event in events]
        self.assertLess(names.index("/api/audio/started"), names.index("telegram-send"))
        self.assertLess(names.index("telegram-send"), names.index("/api/audio/complete"))

    def test_process_one_marks_failure_when_extraction_fails(self):
        events = []
        def api(path, payload=None):
            events.append((path, payload))
            if path == "/api/audio/claim":
                return {"job": {"id": 18, "kind": "telegram_file",
                                "telegram_file_id": "file-id"}}
            return {"ok": True}
        with patch.object(audio_queue, "api", side_effect=api), \
             patch.object(audio_queue, "download_video", side_effect=RuntimeError("download failed")):
            self.assertTrue(audio_queue.process_one())
        self.assertIn("/api/audio/fail", [event[0] for event in events])
        self.assertNotIn("/api/audio/started", [event[0] for event in events])


if __name__ == "__main__":
    unittest.main()
