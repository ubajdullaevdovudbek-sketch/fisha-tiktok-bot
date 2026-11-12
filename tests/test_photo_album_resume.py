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

queue = importlib.import_module("scripts.process_queue")


class PhotoAlbumResumeTests(unittest.TestCase):
    def make_photos(self, folder, count):
        photos = []
        for index in range(count):
            path = Path(folder) / f"{index + 1:03}.jpg"
            path.write_bytes(b"image")
            photos.append(path)
        return photos

    def test_resume_starts_at_saved_offset_and_checkpoints_after_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            photos = self.make_photos(tmp, 12)
            response = Mock()
            response.raise_for_status.return_value = None
            response.json.return_value = {"ok": True}
            checkpoints = []
            with patch.object(queue, "validate_telegram_photo"), \
                 patch.object(queue.requests, "post", return_value=response) as post:
                queue.publish_photos(
                    photos, "caption", start_offset=10,
                    after_batch=checkpoints.append,
                )
            self.assertEqual(post.call_count, 1)
            self.assertIn("sendMediaGroup", post.call_args.args[0])
            self.assertEqual(checkpoints, [12])

    def test_checkpoints_each_successful_batch(self):
        with tempfile.TemporaryDirectory() as tmp:
            photos = self.make_photos(tmp, 12)
            response = Mock()
            response.raise_for_status.return_value = None
            response.json.return_value = {"ok": True}
            checkpoints = []
            with patch.object(queue, "validate_telegram_photo"), \
                 patch.object(queue.requests, "post", return_value=response) as post:
                queue.publish_photos(photos, "caption", after_batch=checkpoints.append)
            self.assertEqual(post.call_count, 2)
            self.assertEqual(checkpoints, [10, 12])

    def test_final_checkpoint_can_be_resumed_without_resending_any_photos(self):
        # After the final group succeeds, the saved offset equals len(photos).
        # If the later /complete call fails, a retry must be a safe no-op.
        for count in (1, 2, 10, 11, 21):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as tmp:
                photos = self.make_photos(tmp, count)
                response = Mock()
                response.raise_for_status.return_value = None
                response.json.return_value = {"ok": True}
                checkpoints = []
                with patch.object(queue, "validate_telegram_photo"), \
                     patch.object(queue.requests, "post", return_value=response) as post:
                    queue.publish_photos(photos, "caption", after_batch=checkpoints.append)
                    self.assertEqual(checkpoints[-1], count)
                    sent_count = post.call_count
                    queue.publish_photos(
                        photos, "caption", start_offset=checkpoints[-1]
                    )
                self.assertEqual(post.call_count, sent_count)

    def test_rejects_non_batch_aligned_saved_offset(self):
        with tempfile.TemporaryDirectory() as tmp:
            photos = self.make_photos(tmp, 12)
            with patch.object(queue, "validate_telegram_photo"):
                with self.assertRaisesRegex(RuntimeError, "Invalid saved photo album offset"):
                    queue.publish_photos(photos, "", start_offset=5)


if __name__ == "__main__":
    unittest.main()
