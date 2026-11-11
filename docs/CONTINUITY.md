# Project continuity checkpoint

Updated: 2026-11-11

## Repository and boundaries
- Repository: `ubajdullaevdovudbek-sketch/fisha-tiktok-bot`
- Working branch: `feature/fast-photo-carousel-no-daily-cap`
- Current feature branch head: `1b422272552a26d6f4edc9c60e657d7399a971cd`
- Known main baseline before this work: `f07a9ecfc08cf76f0b64079893677a7bc9360917`
- `main` has not been changed. Do not touch `safety/manual-approval`.
- User approved edits on this feature branch only. No PR, merge, deploy, Cloudflare configuration/secret changes, or live channel tests without separate explicit approval.
- Do not send test messages/posts to `@zadrot1705`.

## User priorities
1. Faster and reliable video publishing.
2. TikTok Photo Mode: download all images in order and send as Telegram album.
3. Separate audio extraction/publication is desirable but lowest priority.
- Music work must not delay regular video publishing.
- Prefer free solutions.

## Current implementation on feature branch
- Cloudflare Worker scheduling gate was removed on this branch only; main remains unchanged.
- `.github/workflows/publish.yml` runs every 5 minutes and sets `MAX_JOBS_PER_RUN=5`.
- `scripts/process_queue.py` processes up to 5 queue jobs per workflow run (clamped 1..10) using `app/queue_runner.py`.
- Batch runner has tests for batch limit, empty queue, upper clamp, and propagating errors.
- Added `gallery-dl>=1.32.19,<2` to requirements.
- Added `app/tiktok_photos.py`: resolves TikTok short URLs; detects canonical `/photo/` paths; calls gallery-dl with TikTok audio and video downloads disabled; sorts downloaded images by slide number.
- Queue worker routes canonical Photo Mode posts to image downloader; sends image batches via Telegram `sendMediaGroup` (max 10 per album) and single images via `sendPhoto`. Captions are attached only to the first image.
- Regular video jobs still use existing yt-dlp MP4 download and Telegram `sendVideo` flow.
- Separate audio extraction is not implemented.

## Tests and verification
- Ran 8 isolated unit tests locally for batch runner and photo downloader using mocked subprocess; all passed.
- This is not a full repository CI run.
- No real TikTok link download has been validated in this environment.
- No Telegram API call, live queue processing, channel post, Cloudflare deployment, or merge has been performed.
- Workflow cron remains every 5 minutes; batch processing improves throughput but does not make queue pickup instant.
- The queue processor stops its current run if a job raises an error after being marked failed; later jobs wait for next scheduled run.
- Short-link preflight failure falls back to yt-dlp directly to protect video handling.

## Known gaps / next steps
1. Run GitHub Actions tests on this feature branch; ensure the tests workflow is configured to trigger for this branch.
2. Inspect actual gallery-dl behavior against a public TikTok Photo Mode URL (without publishing to Telegram) when safe validation is possible.
3. Add mocked tests for Telegram album payload construction and multi-album splitting.
4. Keep video fast path first; don't add music extraction until video and photo flows are stable.
5. Audio extraction remains a separate third-priority feature.
6. Review full diff before asking user for explicit approval to merge/deploy.
