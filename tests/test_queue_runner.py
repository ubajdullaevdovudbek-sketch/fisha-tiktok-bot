import unittest

from app.queue_runner import process_batch


class QueueRunnerTests(unittest.TestCase):
    def test_processes_multiple_jobs_up_to_limit(self):
        remaining = [True, True, True, True]
        calls = []

        def process_one():
            calls.append(1)
            return remaining.pop(0) if remaining else False

        self.assertEqual(process_batch(process_one, 3), 3)
        self.assertEqual(len(calls), 3)

    def test_stops_when_queue_is_empty(self):
        calls = []

        def process_one():
            calls.append(1)
            return False

        self.assertEqual(process_batch(process_one, 5), 0)
        self.assertEqual(len(calls), 1)

    def test_clamps_batch_size(self):
        calls = []

        def process_one():
            calls.append(1)
            return True

        self.assertEqual(process_batch(process_one, 99), 10)
        self.assertEqual(len(calls), 10)

    def test_does_not_swallow_job_errors(self):
        def process_one():
            raise RuntimeError("download failed")

        with self.assertRaisesRegex(RuntimeError, "download failed"):
            process_batch(process_one, 5)


if __name__ == "__main__":
    unittest.main()
