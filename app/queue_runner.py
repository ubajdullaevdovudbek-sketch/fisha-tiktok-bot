from collections.abc import Callable


def process_batch(process_one: Callable[[], bool], max_jobs: int) -> int:
    """Process at most max_jobs queue items; stop when the queue is empty."""
    limit = max(1, min(10, int(max_jobs)))
    processed = 0
    while processed < limit:
        if not process_one():
            break
        processed += 1
    return processed
