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

    def test_claim_api_errors_still_abort_batch(self):
        def process_one():
            raise RuntimeError("claim API unavailable")

        with self.assertRaisesRegex(RuntimeError, "claim API unavailable"):
            process_batch(process_one, 5)

    def test_continues_after_a_job_is_marked_failed(self):
        outcomes = iter([True, True, True, False])
        calls = []

        def process_one():
            calls.append(len(calls) + 1)
            return next(outcomes)

        self.assertEqual(process_batch(process_one, 5), 3)
        self.assertEqual(len(calls), 4)


if __name__ == "__main__":
    unittest.main()
