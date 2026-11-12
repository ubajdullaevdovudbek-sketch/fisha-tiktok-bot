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
- Change is on `feature/fast-photo-carousel-no-daily-cap`; commits: `c964844` (fix), `15b03a6` (regression test). The complete CI run for the branch head at that stage passed: run `43172625205`.
- No production Worker, production D1, secrets, webhook, or Telegram channel was touched.

## Remaining behavior/documentation alignment
- Hosted mode has no daily-count or publish-window gate. The obsolete `POSTS_PER_DAY`, `PUBLISH_START`, and `PUBLISH_END` variables have been removed from `cloudflare/wrangler.toml`.
- Local `python -m app` remains a legacy fallback with a 3/day, 10:00–21:00 Asia/Tashkent schedule. It is not feature-equivalent to hosted mode; keep this difference explicit.
- Hosted `/publish` and `/queue` now both honor `force_publish DESC, id`. `/publish` sets priority but does not start GitHub Actions immediately.
- README has been updated to describe hosted batch behavior, local-mode limitations, queue commands, and manual retry commands.
- No real TikTok Photo Mode download-only smoke test has been confirmed. No production D1 inspection/migration, Worker deploy, webhook change, or live Telegram channel test has been performed.

## 2026-11-12 continuation: hosted manual publish priority and README alignment
- Fixed hosted `/publish`: queue claiming now selects `force_publish DESC, id`, so the manually prioritized job is claimed before older FIFO jobs; the priority flag is cleared when the job is claimed.
- Updated the hosted `/publish` reply to clarify that it prioritizes the next job but does not start GitHub Actions immediately. Scheduled Actions pickup is best-effort and may be delayed.
- Added a Worker unit test and a real Worker + local Miniflare D1 integration test proving a later manually prioritized job is claimed before an older queued job.
- Updated README to describe hosted behavior accurately: no daily cap/time gate, up to 5 video/photo jobs per run, up to 3 optional audio jobs per run, and the actual `/publish` semantics.
- Explicitly documented that `python -m app` remains a legacy fallback with the 3/day and 10:00–21:00 schedule and does not yet include the hosted Photo Mode album/audio queue pipeline. Do not imply local and hosted modes are feature-equivalent.
- CI run `43174030567` passed both `python-tests` and `worker-tests` for commit `36eaa1e593677d2be739691866756c90756116e5`; this includes the new D1 priority integration test. Later documentation/reply-only commits are being checked by the latest CI run.
- All changes remain on the feature branch. No production D1, Worker, webhook, secrets, or Telegram channel were changed.

## 2026-11-12 continuation: queue visibility and stale-claim lifecycle
- `/queue` now orders queued items by `force_publish DESC, id`, matching the actual hosted claim priority so the owner sees the next-to-run item first.
- Added local D1 integration coverage for stale video/audio claims: jobs abandoned before Telegram delivery starts return to the queue; jobs abandoned after delivery-start markers become `UNCERTAIN DELIVERY` failures instead of being resent automatically.
- These tests exercise the actual Worker endpoints against Miniflare D1, not production D1.
- Current code changes are on the feature branch; production deployment and live Telegram behavior remain unverified and unchanged.

- Removed unused `POSTS_PER_DAY`, `PUBLISH_START`, and `PUBLISH_END` variables from the hosted Wrangler config. They were not enforced by the hosted Worker and misleadingly suggested that the hosted path still had a daily cap/window. The legacy local app still reads its own settings and remains unchanged.

- Latest complete CI for current branch HEAD `06c875776dcb53a6e54647664ac37cdd19a7a78e`: run `43174553371` passed both `python-tests` and `worker-tests`, including the stale video/audio recovery integration tests and D1 migration checks.
- Branch comparison at this checkpoint: feature branch is 136 commits ahead of `main`, 0 behind. `main` remains untouched.

## 2026-11-12 continuation: failed audio retry
- Added owner-only Telegram command `/retry-audio ID` for failed optional audio jobs. It resets `status`, `claimed_at`, `audio_started_at`, and `error` only when the selected audio job is failed.
- The command warns the owner to check the channel first if the prior send may have succeeded; uncertain delivery must never be blindly resent.
- Added a Worker unit test that verifies the SQL state guard and reset fields. README command reference updated.
- CI for this latest code/doc update is running; previous complete run `43174553371` passed both suites on the immediately preceding code head.

- Final CI for the audio retry command and its command-parser guard passed at commit `55e0180ed0c218c9d33e477ad9d2a2e3ae675ac5`: run `43174778676` (both `python-tests` and `worker-tests` successful). The test caught an initial prefix collision because `/retry-audio` also matched `/retry`; the video command now matches only `/retry` or `/retry `, and the audio retry path is separately reachable.
- `/retry-audio ID` is documented in README. The command only requeues failed audio jobs and clears the prior audio delivery marker; the owner must inspect the channel first if the earlier send may have succeeded.

## 2026-11-12 continuation: audio queue visibility
- Added owner-only `/audio-queue`, listing queued, processing, and failed MP3 jobs with their audio job IDs. This makes `/retry-audio ID` usable without inspecting GitHub Actions logs.
- Added a Worker test for the command's SQL filter and Telegram reply, and documented it in README.
- No production services were accessed or changed.
