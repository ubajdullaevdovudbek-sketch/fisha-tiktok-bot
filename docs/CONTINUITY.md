# Project continuity checkpoint

Updated: 2026-11-11

## Repository and boundaries
- Repository: `ubajdullaevdovudbek-sketch/fisha-tiktok-bot`
- Working branch: `feature/fast-photo-carousel-no-daily-cap`
- Read the live branch head from GitHub before resuming; this checkpoint is updated by feature commits and must not be treated as a substitute for the current ref.
- Known main baseline before this work: `f07a9ecfc08cf76f0b64079893677a7bc9360917`
- `main` has not been changed. Do not touch `safety/manual-approval`.
- User approved edits on this feature branch only. No PR, merge, deploy, Cloudflare configuration/secret changes, or live channel tests without separate explicit approval.
- Do not send test messages/posts to `@zadrot1705`.

## User priorities
1. Faster and reliable video publishing.
2. TikTok Photo Mode: download all images in order and send as Telegram album.
3. Separate audio extraction/publication is desirable but lowest priority.
- Audio work must not delay regular video publishing; it runs only after the video has been sent.
- Prefer free solutions.

## Current implementation on feature branch
- Cloudflare Worker scheduling gate was removed on this branch only; main remains unchanged.
- `.github/workflows/publish.yml` runs every 5 minutes and sets `MAX_JOBS_PER_RUN=5`.
- `scripts/process_queue.py` processes up to 5 queue jobs per workflow run (clamped 1..10) using `app/queue_runner.py`.
- Batch runner has tests for batch limit, empty queue, upper clamp, and aborting on claim/API errors. Once a job is claimed, processing errors are marked failed and the batch continues to the next job.
- Added `gallery-dl>=1.32.19,<2` to requirements.
- Added `app/tiktok_photos.py`: resolves TikTok short URLs; detects canonical `/photo/` paths; calls gallery-dl with TikTok photo downloads explicitly enabled and audio, video, and covers disabled; sorts downloaded images by slide number.
- Review against gallery-dl documentation found that the filename template used space-padding (`{num:>03}`), which could defeat numeric filename sorting. Changed it to zero-padding (`{num:03}`) and added a test assertion. gallery-dl documents TikTok `photos`, `audio`, and `videos` options; its TikTok filename metadata includes `num`.
- Queue worker routes canonical Photo Mode posts to image downloader; sends image batches via Telegram `sendMediaGroup` (max 10 per album) and single images via `sendPhoto`. Captions are attached only to the first image.
- Regular video jobs still use existing yt-dlp MP4 download and Telegram `sendVideo` flow.
- Video and Telegram-uploaded MP4 jobs now publish the video first, then best-effort extract the full audio track to a 128 kbps MP3 with FFmpeg and send it via Telegram `sendAudio`.
- MP3 extraction/upload failures are logged and do not fail or retry an already-published video job. Photo Mode remains image-only.

## Tests and verification
- Existing isolated tests: 8 tests for batch runner and photo downloader; audio helper tests: 2 tests passed separately.
- Added 5 mocked Telegram photo-publishing tests covering one photo, 2-photo album, splitting 12 photos into groups of 10 + 2, oversized-photo rejection, and Telegram API error handling. These tests are committed but have not yet been executed in GitHub Actions.
- This is not a full repository CI run.
- No real TikTok link download has been validated in this environment.
- No Telegram API call, live queue processing, channel post, Cloudflare deployment, or merge has been performed.
- Workflow cron remains every 5 minutes; batch processing improves throughput but does not make queue pickup instant.
- Per-job processing failures are marked failed and do not stop the current batch; later claimed jobs continue within the configured run limit. Queue claim/API failures still abort the run to avoid repeated failing claims.
- Short-link preflight failure falls back to yt-dlp directly to protect video handling.

## Known gaps / next steps
1. Run GitHub Actions tests on this feature branch; ensure the tests workflow is configured to trigger for this branch.
2. Verify the new audio extraction tests pass; FFmpeg is installed in the publish workflow already.
2. Inspect actual gallery-dl behavior against a public TikTok Photo Mode URL (without publishing to Telegram) when safe validation is possible; no live post download has yet been validated.
3. Add mocked tests for Telegram album payload construction and multi-album splitting.
4. Keep video fast path first; don't add music extraction until video and photo flows are stable.
5. Audio extraction remains a separate third-priority feature.
6. Review full diff before asking user for explicit approval to merge/deploy.


### Duplicate-publication protection
- Job status remains `processing`. Immediately before the first Telegram upload, the runner calls `/api/started`, which records `publishing_started_at`. The marker is idempotent: repeated calls preserve the original timestamp.
- A stale `processing` job with no delivery marker is automatically requeued after 20 minutes.
- A stale `processing` job with a delivery marker is moved to `failed` with an `UNCERTAIN DELIVERY` error. It is not automatically retried because Telegram may already have accepted the post.
- `/api/complete` and `/api/fail` accept only jobs still in `processing`. If delivery had started, failures are marked as uncertain.
- Before using `/retry ID`, manually check the Telegram channel to confirm whether the post appeared. A verified manual retry clears the old `claimed_at` and `publishing_started_at` values so the previous delivery marker cannot immediately classify the new attempt as stale/uncertain.
- This protection narrows the duplicate window but cannot eliminate the tiny crash window between Telegram accepting a message and the runner receiving/storing the response.

## 2026-11-12 continuation: final album offset recovery
- Found a concrete retry bug in `publish_photos`: validation rejected a saved offset equal to `len(paths)` unless the total photo count was divisible by 10. For albums of 1, 2, 11, 21, etc., the final successful checkpoint could therefore make a retry fail before it reached the no-op completion path (for example, if Worker `/complete` failed after the final Telegram batch was sent).
- Fixed validation to permit exactly `start_offset == len(paths)`, while still requiring intermediate offsets to align to 10. This lets a fully checkpointed album resume as a no-op without resending images.
- Added regression coverage for 1, 2, 10, 11, and 21 photos: after all batches checkpoint, rerunning from the final offset must not call Telegram again. Added a process-level test proving a photo-progress persistence error calls `/api/fail` and never calls `/api/complete`.
- Change is on `feature/fast-photo-carousel-no-daily-cap`; commits: `c964844` (fix), `15b03a6` (regression test). Automated CI for these exact commits is still pending verification; do not report this fix as CI-passed until a run for the new head is confirmed.
- No production Worker, production D1, secrets, webhook, or Telegram channel was touched.

## Remaining behavior/documentation alignment
- Hosted Worker `claimJob` on this feature branch currently has no daily-count or publish-window gate. `.github/workflows/publish.yml` wakes every 5 minutes and allows up to 5 video/photo jobs per run; `publish-audio.yml` allows up to 3 audio jobs per run.
- `cloudflare/wrangler.toml` still declares `POSTS_PER_DAY=3`, `PUBLISH_START=10:00`, and `PUBLISH_END=21:00`, but the hosted Worker no longer reads these values. The separate local `python -m app` mode still enforces the 3/day, 10:00–21:00 Asia/Tashkent schedule in `app/scheduler.py`. This difference must be made explicit or intentionally unified.
- Hosted Telegram `/publish` currently sets `force_publish=1`, while `claimJob` selects queued jobs by `id` and does not order by `force_publish`; in hosted mode this command does not provide a distinct immediate/priority action. Local mode's `/publish` sends the next item immediately. Align or document before release.
- README wording is stale in places: it describes manual approval, one job per five-minute runner, and deployment state that may not match the current feature branch and observed deployed Worker. Update after behavior is finalized.
- No real TikTok Photo Mode download-only smoke test has been confirmed. No production D1 inspection/migration, Worker deploy, webhook change, or live Telegram channel test has been performed.
