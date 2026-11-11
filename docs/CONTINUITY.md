# Project continuity checkpoint

Updated: 2026-11-11

## Repository
- Repository: `ubajdullaevdovudbek-sketch/fisha-tiktok-bot`
- Working branch: `feature/fast-photo-carousel-no-daily-cap`
- Main branch must remain untouched until the owner explicitly approves merge.
- Do not touch `safety/manual-approval`.

## User priorities
1. Fast, reliable video publishing to Telegram channel `@zadrot1705`.
2. TikTok Photo Mode support: download every image in order and send as a Telegram album.
3. Separate audio extraction/publication is desirable but lowest priority.
- No music extraction should delay normal video publishing.
- Prefer free implementation.

## Safety / permissions
- Feature-branch code edits are approved.
- No merge, PR, deployment, Cloudflare setting/secret changes, or live channel tests without separate explicit approval.
- Do not send test posts to the channel.
- Do not bypass authentication or claim access that is not available.
- Preserve working main branch.

## Current branch work
- Worker scheduler gating was previously removed on this feature branch; main was not changed.
- `scripts/process_queue.py` now supports processing up to 5 jobs per workflow run (configurable by `MAX_JOBS_PER_RUN`, clamped 1..10).
- `.github/workflows/publish.yml` passes `MAX_JOBS_PER_RUN: "5"`.
- GitHub Actions still uses a 5-minute cron schedule. Batch processing improves throughput but does not make queue pickup instant.
- A failed job is marked failed and stops that run; subsequent queued jobs wait for the next run.
- Latest feature branch commit after batch-processing change: `9a6ff93b8272c11be33d6cf4a0585c07989afc5a`.
- Latest known main baseline before feature work: `f07a9ecfc08cf76f0b64079893677a7bc9360917`.
- No deployment, merge, PR, or channel post has been performed.

## Current technical gaps
- Queue worker still downloads and sends only one MP4 per TikTok job.
- Photo carousels are not yet implemented in the queue worker.
- Separate TikTok audio extraction/publication is not implemented.
- Local standalone bot still has its own daily cap/time-window logic in `app/scheduler.py` and `app/config.py`; this is separate from the Cloudflare Worker queue path.
- Need add safe multi-job tests and verify workflow syntax before considering merge.
- Avoid claiming runtime verification: no live queue or Telegram publishing test has been performed.

## Next steps
1. Add tests/static validation for bounded batch processing and failure behavior.
2. Inspect current yt-dlp TikTok metadata for photo carousel formats, then implement photo album support in the queue worker.
3. Keep audio extraction as an independent optional stage after video/photo reliability.
4. Review all changes on feature branch; request explicit approval before PR/merge/deploy/live test.
5. Re-read this checkpoint and inspect current branch head before resuming work in a new chat.


## Follow-up work on 2026-11-11
- Extracted bounded queue loop into `app/queue_runner.py` so it can be tested without network access.
- Added `tests/test_queue_runner.py` covering batch limit, empty queue, upper clamp (10), and propagation of job errors.
- Updated `scripts/process_queue.py` to call the tested helper.
- Ran the four helper unit tests in an isolated local environment: all passed. This is not a full repository CI run and does not verify Telegram/Cloudflare integration.
- Current latest feature branch commit: `a5bf5fa3f776b2d101030f2d420ba4025565a9e5`.
- Photo-mode research: official yt-dlp tracker documents TikTok photo-mode as unsupported/not planned in its core scope. Evaluate a free separate image downloader (e.g. gallery-dl) or carefully isolated TikTok image extraction; do not assume yt-dlp will return all slide images.
- User priority order remains: video speed/reliability first, photo carousels second, separate audio third.
