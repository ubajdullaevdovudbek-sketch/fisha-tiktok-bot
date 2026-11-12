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
