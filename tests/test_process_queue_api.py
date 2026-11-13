import importlib
import os
import unittest
from unittest.mock import Mock, patch


os.environ.setdefault("WORKER_API_URL", "https://worker.invalid")
os.environ.setdefault("WORKER_API_SECRET", "test-secret")
os.environ.setdefault("BOT_TOKEN", "test-token")
os.environ.setdefault("CHANNEL_ID", "@test-channel")

video_queue = importlib.import_module("scripts.process_queue")


class VideoQueueApiTests(unittest.TestCase):
    def test_api_rejects_worker_ok_false_response(self):
        response = Mock(status_code=200)
        response.raise_for_status.return_value = None
        response.json.return_value = {"ok": False, "error": "video is not processing"}
        with patch.object(video_queue.requests, "post", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "video is not processing"):
                video_queue.api("/api/started", {"id": 7})

    def test_api_returns_successful_worker_payload(self):
        response = Mock(status_code=200)
        response.raise_for_status.return_value = None
        response.json.return_value = {"ok": True}
        with patch.object(video_queue.requests, "post", return_value=response):
            self.assertEqual(video_queue.api("/api/complete", {"id": 7}), {"ok": True})

    def test_api_preserves_no_content_claim_response(self):
        response = Mock(status_code=204)
        with patch.object(video_queue.requests, "post", return_value=response):
            self.assertIsNone(video_queue.api("/api/claim"))


if __name__ == "__main__":
    unittest.main()
