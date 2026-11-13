# Release readiness: Cloudflare Worker and D1

Last reviewed: 2026-11-13 (code audit refresh). Reviewed feature branch head `0d8996a` and the local-fallback parity changes. This review used repository source and CI metadata only; it did not access or change production.
Everything below distinguishes repository/CI evidence from production facts that remain unverified.

## Current verified state

- Feature branch: `feature/fast-photo-carousel-no-daily-cap`. At the latest comparison it is 173 commits ahead of `main` and 0 behind. This is a commit-count comparison, not proof that a merge is operationally safe; review the full diff and cutover sequence.
- **CI is green on reviewed head `0d8996a5250279c5d2e057e3f22f1aacc5921ce2`.** Both `worker-tests` and `python-tests` completed successfully on that commit (GitHub check-runs API). Re-check CI on the eventual merge commit; this result does not certify later commits.
- Local re-run in an offline sandbox (no package installs possible): `node --check` OK; 37/37 Worker tests that need no Miniflare (35 existing plus 2 new); 13/13 SQLite migration and lifecycle tests; 15/15 Python tests in the modules that import without third-party downloaders. **Not run locally:** `d1-integration.test.mjs` and `d1-migrations.test.mjs` (need Miniflare) and five Python modules (`test_core`, `test_photo_album_resume`, `test_process_audio_queue`, `test_process_queue_api`, `test_telegram_photo_publish`; need `yt_dlp`/`gallery_dl`). CI covers those.
- Secret scan of every added line in `f07a9ec..HEAD`: 0 matches for GitHub tokens, Telegram bot-token shape or private keys. No hard-coded `Bearer` literals outside tests.
- Download-only Photo Mode smoke test passed in CI (run `43352954518` at `68cd304`). A real **Telegram send** of an album or video has never been exercised end to end.
- Migrations `0002`–`0004` were applied earlier to the separate test D1 database `fisha-tiktok-test` (ID `45cefcfb-f76d-4a3a-b48f-4375f65c0527`). Wrangler's recognition of its manually created `d1_migrations` table is **not** verified.
- Production D1 `fisha-tiktok-queue` (ID `d3887cca-dad1-4436-b2f8-3486dadcddc7`) has not been inspected or changed. No production Worker deployment, D1 migration, secret update, webhook change, workflow pause or Telegram publication has been performed.

## Why the branch has many commits ahead

The work was committed in many small commits. The latest comparison reports 173 commits ahead; the file/line totals below are from an earlier comparison and must be refreshed before merge if used for scope estimation:

| Area | Files | Needed for release |
|---|---|---|
| Worker and D1 | `cloudflare/src/index.js`, `schema.sql`, migrations `0002`–`0004`, `wrangler.toml` | Yes |
| Publisher | `scripts/process_queue.py`, `scripts/process_audio_queue.py`, `app/*` | Yes, must ship together with the Worker |
| Workflows | `publish.yml`, `publish-audio.yml`, `deploy-cloudflare.yml`, `tests.yml` | Yes |
| Tests | `cloudflare/tests/*`, `tests/*` | Recommended |
| Smoke test | `tiktok-photo-smoke-test.yml`, `scripts/smoke_test_tiktok_photos.py` | **No.** Download-only, no secrets, but it hard-codes a personal test URL and checks out the feature branch by name, so it stops working once that branch is deleted. Consider dropping it from the merge. |
| Notes | `docs/CONTINUITY.md`, this file | No, working notes |

Deliberate behaviour changes the owner should confirm before merging:

1. The daily cap and publishing time window are removed. The channel can receive posts at any hour, up to 5 jobs per run.
2. New links trigger an immediate GitHub Actions run when the Worker secret `GITHUB_ACTIONS_TOKEN` exists, and an owner-only "publish now" button exists.
3. TikTok Photo Mode carousels are published as ordered Telegram albums, with per-batch resume.
4. MP3 extraction is a separate queue (`audio_jobs`) with its own workflow, `/audio-queue` and `/retry-audio`.
5. An interrupted send is never retried automatically (uncertain delivery).

Dangerous items found: none that publish from the feature branch. `publish.yml`, `publish-audio.yml` and `deploy-cloudflare.yml` are guarded with `if: github.ref == 'refs/heads/main'`. What becomes live at merge time is covered in the cutover section.

## Daily cap and publishing window removal (verified)

- The Worker's `claimJob` contains no date, time-of-day or count logic: it recovers stale claims, then takes the next `queued` row ordered by `force_publish DESC, id`. The old `main` Worker had the gate (`POSTS_PER_DAY`, `PUBLISH_START`, `PUBLISH_END`, spacing between posts).
- `published_local_date` is still written on completion, but only as information; nothing reads it as a gate. The unused helper `minutes()` remains in the Worker as harmless dead code and was intentionally not refactored.
- The publisher scripts and both workflows have no time or count gate. The 5-minute cron is only a wake-up schedule, not a publishing window.
- Fixed in this pass: `cloudflare/wrangler.toml.example` still defined the three variables; they are removed, so a fresh setup from the example cannot bring them back.
- Regression guard: `cloudflare/tests/no-publish-gate.test.mjs`. It fails if any of the three names appears in the Worker, either Wrangler config or either publisher workflow, and it runs the real claim SQL on SQLite with the legacy variables set (`POSTS_PER_DAY=1`, a closed window, three posts already today) and requires every queued job to be claimable in FIFO order. Mutation check: the same behavioural test **fails** against the old `main` Worker (returns 204 instead of 200).
- Local fallback parity was subsequently changed on this feature branch: `app/config.py`, `app/scheduler.py`, `app/__main__.py`, `.env.example`, `README.md`, and `tests/test_core.py` remove the daily cap and time window. The local scheduler checks every five minutes and attempts at most one queued item per tick. This supersedes the older statement above.

## Migrations 0002–0004 (verified offline on SQLite)

- Applied in order to the exact pre-0002 baseline, the result equals `schema.sql`: same tables (`videos`, `webhook_updates`, `audio_jobs`), columns and indexes (column order differs because `ALTER TABLE` appends).
- Existing rows are preserved unchanged. New columns on old rows: `publishing_started_at = NULL`, `album_next_offset = 0`.
- All three are additive. The `videos.status` CHECK constraint is unchanged (uncertain delivery is stored as `failed` with an `UNCERTAIN DELIVERY:` error prefix), so no table rebuild is needed.
- `0002` and `0004` are **not idempotent**: re-applying them fails with "duplicate column name". `0003` is idempotent. If production already contains any of these columns, applying the migration fails, which is why the drift inspection is mandatory.
- Rows that are `processing` while the migration runs have no delivery marker afterwards (see legacy `processing` rows below).

## Compatibility matrix (verified with the real code, mocked network and SQLite)

| Worker | Schema | Publisher | Outcome |
|---|---|---|---|
| old | migrated | old | Works. Every SQL statement the old Worker uses still runs on the migrated schema. |
| new | **not migrated** | any | `/api/claim` fails with "no such column: publishing_started_at". The queue stalls and nothing is sent. Migrate first. |
| new | migrated | old | Compatible (the old publisher only calls claim/complete/fail). One job per run and no delivery-start marker, so weaker duplicate protection. |
| old | migrated | **new** | `/api/started` returns 404, so each claimed job is marked `failed` **before** any Telegram send and needs `/retry ID`. The number of such jobs is bounded by the old Worker's own cap/window gate. `publish-audio.yml` fails red because `/api/audio/claim` does not exist. No message is sent. |
| new | migrated | new | Target state. |

## Publisher and Worker behaviour on errors, recovery and reruns

- Claim is atomic (`UPDATE … WHERE id=? AND status='queued'`). Runs share the concurrency group `fisha-publish-queue` with `cancel-in-progress: false`; per GitHub's concurrency semantics there is at most one running and one pending run (not re-verified here). Extra triggers lose nothing, because the queue lives in D1.
- Claim or Worker API error: the run aborts red, nothing is claimed, the next trigger retries. Verified.
- Failure before the delivery marker: job becomes `failed` with the error text and is not retried automatically. Use `/retry ID`.
- Failure after the marker, including `/api/complete` failing after a successful `sendVideo` (verified: exactly one `sendVideo`, then `/api/fail`, no resend): job becomes `failed` with `UNCERTAIN DELIVERY:`. Check the channel before `/retry`.
- Runner killed or timed out (workflow limit 12 minutes): the next claim, after 20 minutes, requeues `processing` jobs without a marker and fails those with a marker as uncertain.
- `/retry ID` clears the claim timestamp, the delivery marker and the error, and only acts on `failed` rows.
- Photo albums checkpoint every 10-image batch. If Telegram accepts a batch but the subsequent `/api/photo-progress` checkpoint fails, the stored offset remains behind; a manual retry can resend that batch. This is a known residual duplicate-delivery window, not exactly-once delivery. Verify the channel before retrying any uncertain album job.

## Manual workflow run with an empty queue

A manual run of `publish.yml` or `publish-audio.yml` on an empty queue sends nothing to Telegram.

- Workflow network steps before the script are a Cloudflare subdomain lookup and a Worker `/health` GET.
- The script makes one `POST /api/claim` (or `/api/audio/claim`), receives 204 and exits. Verified for both scripts with the real code: 0 send-type Telegram calls.
- No Worker `/api/*` handler calls Telegram or GitHub; those calls exist only in the Telegram webhook handler.

"Empty" must mean all of the following, because a claim first requeues stale work and then publishes it: no `queued` rows in `videos`; no `processing` row older than 20 minutes without a delivery marker; for `publish-audio.yml`, no `queued` rows in `audio_jobs`. Emptiness is established only from production D1, never assumed (see below). Before the merge a manual run is skipped by the `main` guard, so it cannot be used as a pre-merge test.

## Cutover safety

### Pausing the publishers (reversible)

- **Method:** disable the `publish-queue` workflow (Actions tab → workflow → Disable, or `gh workflow disable publish.yml`); re-enable with `gh workflow enable publish.yml` (or the REST API). Per GitHub's documentation this is reversible, keeps the workflow file, and does **not** cancel runs that already exist. No jobs are lost: the queue lives in D1 and the webhook keeps queueing new links meanwhile. Publishing is paused for the whole window, so expect delays of tens of minutes.
- **Wait for in-flight runs first** (Actions tab, or `gh run list --status in_progress`) so a run that is mid-send is not cut off. Observed on `main` on 2026-11-13: scheduled runs were 48–55 minutes apart in practice, not 5.
- **Not verified** (the GitHub page is silent, and testing would change the live schedule): whether a disabled workflow also blocks its `push` trigger, and whether the disabled state survives a merge that modifies the workflow file. Therefore, after the merge and **before** the deploy, confirm `publish-queue` still shows as disabled and that no run started; if it does not, disable it again before continuing.
- `publish-audio.yml` does not exist on `main`, so it cannot be disabled in advance. At the merge it appears enabled and fires once; against the old Worker it fails red at `/api/audio/claim` and sends nothing. Optionally disable `publish-audio-queue` right after the merge to avoid red runs until the deploy; leaving it enabled afterwards is harmless because no audio jobs exist until the new publisher completes a video.
- **Safety net if the pause does not hold:** the new publisher against the old Worker marks claimed jobs `failed` before any Telegram call (verified), bounded by the old gate. That is recoverable with `/retry ID` after checking the channel; nothing is published unintentionally.
- Not recommended as a pause: deleting workflow files, editing the cron, rotating secrets, or disabling Actions repository-wide (this also stops tests and deploys).

### Protecting the old queue

- **Never assume the queue is empty.** The only authoritative check is a read-only inspection of production D1 (needs approval), repeated immediately before the merge because new links keep arriving. The owner's `/status` and `/queue` commands read the same table through the Worker and are a secondary check only.
- **Backlog flush hazard.** The old gate may have left a backlog. The new Worker has no daily cap or time window. The publisher workflow's configured per-run batch limit is separate from those removed gates; with the token set a new link may trigger an immediate run. Before resuming, the owner decides: accept the flush, or hold the backlog.
- **Hold (reversible, needs separate approval; proposed, not executed):**
  `UPDATE videos SET status='failed', force_publish=0, error='HELD before cutover' WHERE status='queued';`
  Release individual jobs later with `/retry ID`. `failed` rows are never recovered automatically and no schema change is needed.
- **Legacy `processing` rows.** The old publisher never writes the delivery marker, and the old Worker already requeues any `processing` row older than 20 minutes (verified in `main`'s code). After migration such a row also looks "not started", so it can be requeued and sent again even if it was already posted. Never bulk-requeue. Before resuming, list every `processing` row; the owner checks the channel for each one. Delivered: `UPDATE videos SET status='published', claimed_at=NULL, published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), error=NULL WHERE id=? AND status='processing';`. Not delivered: `UPDATE videos SET status='failed', claimed_at=NULL, error='Resolved before cutover: not delivered' WHERE id=? AND status='processing';` then `/retry ID`. Unsure: use the second form and do **not** retry. Each write needs separate approval (proposed, not executed).
- **`UNCERTAIN DELIVERY` rows** cannot exist before migration (the old Worker never writes that prefix). Afterwards they stay `failed` and are retried only by `/retry ID` after checking the channel. List them with `SELECT id, error FROM videos WHERE error LIKE 'UNCERTAIN DELIVERY%';`.
- **Read-only inspection queries (proposed; run only after approval):**

```sql
SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;
SELECT name FROM d1_migrations ORDER BY id;  -- skip if the table does not exist
SELECT status, COUNT(*) AS n FROM videos GROUP BY status;
SELECT id, kind, status, force_publish, claimed_at, published_at, substr(error,1,80) AS error
  FROM videos WHERE status IN ('queued','processing') ORDER BY id;
```

## GITHUB_ACTIONS_TOKEN (optional, Worker-only)

- Used only to call `workflow_dispatch` for `publish.yml` on `main`. Without it, or if GitHub rejects it, the bot queues the link and the next scheduled run picks it up (configured every 5 minutes, observed closer to 50).
- Create a fine-grained token restricted to this repository with the single permission **Actions: write**, give it an expiry, and set a reminder to rotate it.
- Store it only as a Cloudflare Worker secret (dashboard, or interactive `wrangler secret put GITHUB_ACTIONS_TOKEN`). Never paste it into chat, files, issues or CI output. GitHub reserves the `GITHUB_` prefix for repository secret names, so it cannot be a GitHub Actions secret under this name, and the deploy workflow does not set it.
- Secrets are stored separately from deployed code, so a deploy is not expected to remove it; confirm the secret name is still listed in the Cloudflare dashboard after the deploy.
- Set it **after** the deploy and **before** resuming, so no dispatch can fire during the cutover. Not configured at the time of this review.

## Release blockers

1. **Production schema baseline is unverified.** Perform read-only inspection of the production D1 schema and migration history before planning migrations. Do not assume it matches the test fixture or the current `schema.sql`.
2. **Wrangler migration tracking is unverified.** A real `wrangler d1 migrations list --remote` check has not been run.
3. **Migration 0001 is absent.** The pre-0002 baseline exists as a test fixture only. Do not apply it or create a 0001 without first reconciling the actual production schema.
4. **The deploy workflow does not apply D1 migrations.** It deploys the Worker, sets four Worker secrets and registers the Telegram webhook. A deployment must not be treated as a migration.
5. **README deployment wording must stay consistent with the actual workflow.**
6. **Merge and deploy are coupled.** A push to `main` triggers both publishers, and the deploy workflow runs only from `main`, so the merge comes first and the new publisher briefly meets the old Worker. Handled by the pause above.
7. **Backlog flush and legacy `processing` rows** must be decided and resolved with the owner before publishing resumes.
8. **Pause persistence is unverified** (push trigger and survival across the merge). Re-check after the merge, before the deploy.
9. **Behaviour change confirmed:** the owner explicitly approved removing the daily cap and time window from all modes, including the local fallback.
10. **Not verified end to end:** a real Telegram album, video or audio send, and a real GitHub dispatch with a real token.
11. **Code audit refresh (2026-11-13):** reviewed `claimJob`, authenticated API routes (`/api/claim`, `/api/started`, `/api/complete`, `/api/fail`, `/api/photo-progress` and audio equivalents), Python video/photo publishing paths, and `app/queue_runner.py`. The source shows a bearer-secret check for internal API routes, conditional status transitions for claims/completion/failure, and a 20-minute recovery policy distinguishing pre-send claims from jobs with a delivery marker. This is source review, not a live concurrency or Telegram delivery test.
12. **Photo album checkpoint residual risk:** a successful Telegram batch followed by a failed D1 checkpoint can be resent on a manual retry. Check the channel before retrying; do not describe the pipeline as exactly-once.
13. **Current local fallback parity:** no daily cap or time window; one queued item maximum per five-minute scheduler tick. CI on `0d8996a` passed after these changes.
14. **Audit scope limitation:** GitHub source review cannot establish production D1 schema/queue state, Cloudflare secret configuration, deployed Worker version, Telegram webhook state, or actual channel delivery.

## Required gated release sequence

Every step that writes anywhere, or reads production, needs the owner's explicit approval; the owner performs the GitHub and Cloudflare account actions.

1. **Preconditions.** CI is green on the exact merge commit. The owner confirms the behaviour changes and the backlog policy (flush or hold).
2. **Pause.** Disable `publish-queue`; wait until no run is in progress; confirm it shows as disabled.
3. **Read-only inspection of production D1** (schema, migration history, queue; queries above). Stop on any drift, for example a column that already exists.
4. **Wrangler check:** `wrangler d1 migrations list --remote` with authorized credentials.
5. **Resolve** every `processing` row against the channel, and hold or accept the `queued` backlog (writes above, each approved separately).
6. **Migrate**, one approval each: `0002`, `0003`, `0004` in order; verify the resulting schema. The old Worker keeps working on it.
7. **Re-inspect** the queue read-only (links may have arrived during the pause) and confirm there are no `processing` rows.
8. **Merge** to `main`. Immediately confirm `publish-queue` is still disabled and no run started; optionally disable `publish-audio-queue`.
9. **Deploy:** run `deploy-cloudflare` (manual `workflow_dispatch` on `main`). It deploys the Worker, re-stores four secrets and **re-registers the Telegram webhook** (same URL and secret); treat that as a webhook change. Verify `/health`.
10. **Token:** the owner stores `GITHUB_ACTIONS_TOKEN` in Cloudflare (see above).
11. **Resume:** `gh workflow enable publish.yml` (and re-enable the audio workflow if it was disabled). Watch the first run in the Actions log. With the backlog held and no queued jobs it makes only the claim call and sends nothing.
12. **Verify** with an empty queue: a manual run of `publish.yml` is green and `/status` is unchanged. Do not send test links or messages unless separately authorized, because they publish to the live channel.

## Rollback

- **Token problem:** delete the Worker secret (the bot falls back to the schedule) and revoke the token in GitHub.
- **Anything wrong before resume:** keep the publishers disabled and fix forward. The old Worker also works on the migrated schema, so no database rollback is needed; migrations have no down-migration and none is required.
- **Bad release after resume:** disable the publishers, revert the merge on `main` via a pull request and re-run `deploy-cloudflare`. The old Worker restores the daily cap and window. After the revert, `main` has the old publisher again, so re-enable it only then.
- **Jobs marked `failed` during a bad window:** verify the channel, then `/retry ID` (`/retry-audio ID` for audio). Release held jobs one at a time the same way.

## Cost

All components stay on free tiers: GitHub-hosted standard runners are free in public repositories, Cloudflare Workers Free allows 100,000 requests per day and 50 subrequests per invocation (a dispatch adds one), a fine-grained token costs nothing, and disabling or enabling a workflow is free. Per GitHub's documentation, scheduled workflows in a public repository are disabled automatically after 60 days without repository activity; manual and dispatched runs are unaffected.

## Approvals the owner must give

Disabling and re-enabling the workflows; production read-only D1 inspection; each production D1 write (resolving `processing` rows, holding the backlog); each migration; the merge to `main`; the `deploy-cloudflare` run (includes the webhook re-registration); creating and storing the token; any Telegram test message or live publication.

## Safety rule

Until every blocker is resolved and the required approvals are explicit, keep work on the feature branch. Do not merge, deploy, migrate production D1, change Cloudflare secrets/configuration, register a webhook, or publish to Telegram.


## Local fallback parity update (2026-11-13)

The local `python -m app` fallback is aligned with the no-daily-cap/no-time-window decision:

- Removed `POSTS_PER_DAY`, `PUBLISH_START`, `PUBLISH_END`, and the local-only timezone scheduling dependency from runtime configuration and `.env.example`.
- The local scheduler checks the queue every five minutes and attempts at most one queued item per check. There is no daily counter or clock-window gate.
- `/status` reports this behavior.
- Regression tests cover publishing with a queued item and doing nothing when the queue is empty.
- This change is only in the feature branch; it does not change the running local deployment or the hosted Worker until a separately approved release/restart.
