# Release readiness: Cloudflare Worker and D1

Last reviewed: 2026-11-13, branch head `7892412848ecd6ef2ee6cc9364725ce8c2a67617`.
Everything below was checked without touching production. Items that were **not** checked are marked as such.

## Current verified state

- Feature branch: `feature/fast-photo-carousel-no-daily-cap`. It is 163 commits ahead of `main` (`f07a9ec`) and 0 behind, so a merge is a plain fast-forward-style change with no conflicts to resolve.
- **CI on the head commit is green.** GitHub Actions run `43374892654` (`tests`, push) at exactly `7892412…`: job `python-tests` passed (SQLite migration suites plus the full `unittest discover`) and job `worker-tests` passed (syntax check, local Miniflare D1 migration checks, Worker access-control and D1 integration tests). The red runs on `cdbb7f2` and `5db1a4e` were test-fixture iterations on the dispatch tests, fixed by `7892412`.
- Local re-run in an offline sandbox: `node --check` OK; 35/35 Worker unit tests; 13/13 SQLite migration and lifecycle tests. Not run locally: the Miniflare tests and five Python modules that import `yt_dlp`/`gallery_dl` (not installable offline). Those are covered by the CI run above.
- Secret scan of every added line in `f07a9ec..HEAD`: 0 matches for GitHub tokens, Telegram bot-token shape, or private keys. No hard-coded `Bearer` literals outside tests.
- Download-only Photo Mode smoke test passed in CI (run `43352954518` at `68cd304`). A real **Telegram send** of a photo album or video has never been exercised end to end.
- Earlier: migrations `0002`–`0004` were applied to the separate test D1 database `fisha-tiktok-test` (ID `45cefcfb-f76d-4a3a-b48f-4375f65c0527`). Wrangler's recognition of its manually created `d1_migrations` table is **not** verified.
- Production D1 `fisha-tiktok-queue` (ID `d3887cca-dad1-4436-b2f8-3486dadcddc7`) has not been inspected or changed. No production Worker deployment, D1 migration, secret update, webhook change, or Telegram publication has been performed.

## Why the branch is 163 commits ahead

The work was committed one file at a time, often with repeated messages (for example several commits titled "Keep uncertain delivery in failed state for manual review"). The net change against `main` is 39 files, +3390/−91:

| Area | Files | Needed for release |
|---|---|---|
| Worker and D1 | `cloudflare/src/index.js`, `schema.sql`, migrations `0002`–`0004`, `wrangler.toml` | Yes |
| Publisher | `scripts/process_queue.py`, `scripts/process_audio_queue.py`, `app/*` | Yes, must ship together with the Worker |
| Workflows | `publish.yml`, `publish-audio.yml`, `deploy-cloudflare.yml`, `tests.yml` | Yes |
| Tests | `cloudflare/tests/*`, `tests/*` | Recommended |
| Smoke test | `tiktok-photo-smoke-test.yml`, `scripts/smoke_test_tiktok_photos.py` | **No.** Download-only, no secrets, but it hard-codes a personal test URL and checks out the feature branch by name, so it stops working once that branch is deleted. Consider dropping it from the merge. |
| Notes | `docs/CONTINUITY.md`, this file | No, working notes |

Deliberate behaviour changes the owner should confirm before merging:

1. The daily cap and publishing time window are removed (`POSTS_PER_DAY`, `PUBLISH_START`, `PUBLISH_END` are gone). The channel can now receive posts at any hour, up to 5 jobs per run.
2. New links trigger an immediate GitHub Actions run when the Worker secret `GITHUB_ACTIONS_TOKEN` exists, and an owner-only "publish now" button exists.
3. TikTok Photo Mode carousels are published as ordered Telegram albums, with per-batch resume.
4. MP3 extraction is a separate queue (`audio_jobs`) with its own workflow, `/audio-queue` and `/retry-audio`.
5. Delivery-uncertainty protection: an interrupted send is never retried automatically.

Dangerous items found: none that publish from the feature branch. `publish.yml`, `publish-audio.yml` and `deploy-cloudflare.yml` are guarded with `if: github.ref == 'refs/heads/main'`. What becomes live at merge time is covered under blocker 6.

## Migrations 0002–0004 (verified offline on SQLite)

- Applied in order to the exact pre-0002 baseline, the result equals `schema.sql`: same tables (`videos`, `webhook_updates`, `audio_jobs`), same columns, same indexes (column order differs because `ALTER TABLE` appends).
- Existing rows are preserved unchanged. New columns on old rows: `publishing_started_at = NULL`, `album_next_offset = 0`.
- All three are additive. The `videos.status` CHECK constraint is unchanged (uncertain delivery is stored as `failed` with an `UNCERTAIN DELIVERY:` error prefix), so no table rebuild is needed.
- `0002` and `0004` are **not idempotent**: re-applying them fails with "duplicate column name". `0003` is idempotent (`IF NOT EXISTS`). If production already contains any of these columns, applying the migration will fail, which is why the drift inspection in the sequence below is mandatory.
- Rows that are `processing` while the migration runs have no delivery marker afterwards. Migrate while the queue is empty.

## Compatibility matrix (verified with the real code, mocked network and SQLite)

| Worker | Schema | Publisher | Outcome |
|---|---|---|---|
| old | migrated | old | Works. Every SQL statement the old Worker uses still runs on the migrated schema. |
| new | **not migrated** | any | `/api/claim` fails with "no such column: publishing_started_at". The queue stalls and nothing is sent. Migrate first. |
| new | migrated | old | Compatible (the old publisher only calls claim/complete/fail). One job per run and no delivery-start marker, so weaker duplicate protection. |
| old | migrated | **new** | `/api/started` returns 404, so each claimed job is marked `failed` **before** any Telegram send and needs `/retry ID`. `publish-audio.yml` fails red every run because `/api/audio/claim` does not exist. No message is sent. |
| new | migrated | new | Target state. |

## Publisher behaviour on errors and reruns

- Claim is atomic (`UPDATE … WHERE id=? AND status='queued'`). Runs share the concurrency group `fisha-publish-queue` with `cancel-in-progress: false`; per GitHub's concurrency semantics there is at most one running and one pending run (not re-verified here). Extra triggers therefore lose nothing, because the queue itself lives in D1.
- Claim or Worker API error: the run aborts red, nothing is claimed, and the next trigger retries. Verified.
- Failure before the delivery marker: job becomes `failed` with the error text and is not retried automatically. Use `/retry ID`.
- Failure after the marker, including `/api/complete` failing after a successful `sendVideo` (verified: exactly one `sendVideo`, then `/api/fail`, no resend): job becomes `failed` with `UNCERTAIN DELIVERY:`. Check the channel before `/retry`.
- Runner killed or timed out (workflow limit 12 minutes): the next claim, after 20 minutes, requeues `processing` jobs without a marker and fails those with a marker as uncertain.
- Photo albums checkpoint every 10-image batch. If the checkpoint call fails after Telegram accepted a batch, a manual retry can resend that one batch (a narrow, documented window).

## Manual workflow run with an empty queue

A manual run of `publish.yml` or `publish-audio.yml` on an empty queue sends nothing to Telegram.

- Workflow network steps before the script are a Cloudflare subdomain lookup and a Worker `/health` GET.
- The script makes one `POST /api/claim` (or `/api/audio/claim`), receives 204 and exits. Verified for both scripts with the real code: 0 send-type Telegram calls.
- No Worker `/api/*` handler calls Telegram or GitHub; those calls exist only in the Telegram webhook handler.

"Empty" must mean all of the following, because a claim first requeues stale work and then publishes it:

1. No `queued` rows in `videos`.
2. No `processing` row older than 20 minutes without a delivery marker.
3. For `publish-audio.yml`: no `queued` rows in `audio_jobs`.

Before the merge a manual run is skipped by the `main` guard, so it cannot be used as a pre-merge test.

## GITHUB_ACTIONS_TOKEN (optional, Worker-only)

- Used only to call `workflow_dispatch` for `publish.yml` on `main`. Without it, or if GitHub rejects it, the bot queues the link and the 5-minute schedule picks it up.
- Create a fine-grained token restricted to this repository with the single permission **Actions: write**, give it an expiry, and set a reminder to rotate it.
- Store it only as a Cloudflare Worker secret (dashboard, or interactive `wrangler secret put GITHUB_ACTIONS_TOKEN`). Never paste it into chat, files, issues or CI output. GitHub reserves the `GITHUB_` prefix for repository secret names, so it cannot be a GitHub Actions secret under this name, and the deploy workflow does not set it.
- Secrets are stored separately from deployed code, so a deploy is not expected to remove it; confirm the secret name is still listed in the Cloudflare dashboard after the first deploy.
- Not configured at the time of this review.

## Release blockers

1. **Production schema baseline is unverified.** Before planning migrations, perform read-only inspection of the production D1 schema and existing migration history. Do not assume it matches the test fixture or the current `schema.sql`.
2. **Wrangler migration tracking is unverified.** A real Wrangler `d1 migrations list --remote` check has not been run.
3. **Migration 0001 is absent.** The pre-0002 baseline exists as a test fixture, not as a production migration. Do not apply the fixture or create a 0001 without first reconciling the actual production schema.
4. **The deploy workflow does not apply D1 migrations.** It deploys the Worker, sets four Worker secrets, and registers the Telegram webhook. A Worker deployment must not be treated as a database migration.
5. **README deployment wording must stay consistent with the actual workflow.**
6. **Merge and deploy are coupled.** A push to `main` immediately triggers both `publish.yml` and `publish-audio.yml` (the audio workflow does not exist on `main` yet). The deploy workflow only runs from `main`, so the merge necessarily comes first, and for a few minutes the new publisher runs against the old Worker (see the matrix). Harmless only if the queue is empty and the deploy is started immediately after the merge.
7. **Behaviour change needs owner confirmation:** the daily cap and time window are removed (see above).
8. **Not verified end to end:** a real Telegram album or video send, and the real GitHub dispatch with a real token.

## Required gated release sequence

0. Preconditions: CI green on the exact merge commit (done for `7892412`); owner confirms the behaviour changes; queue confirmed empty (owner `/status`, `/queue`, `/audio-queue`).
1. Obtain explicit approval for production read-only inspection.
2. Inspect production D1 tables, columns, indexes, constraints and migration history without writing. Compare with the baseline and migrations `0002`–`0004`. Resolve any drift (for example a column that already exists) before proposing writes.
3. Verify Wrangler's view of migration history with a compatible Wrangler and authorized credentials.
4. Prepare the migration plan: exact SQL, expected before/after schema, the exact database ID.
5. Obtain separate approval for each migration, then apply `0002`, `0003`, `0004` in order and verify the schema. The old Worker keeps working on the migrated schema.
6. Obtain approval to merge. Merge only when the queue is empty, then start the deploy immediately.
7. Obtain approval to run `deploy-cloudflare` (manual `workflow_dispatch` on `main`). It deploys the Worker, re-stores four secrets and **re-registers the Telegram webhook** (same URL and secret); treat that as a webhook change. Verify `/health`.
8. Owner creates the token and stores it as `GITHUB_ACTIONS_TOKEN` (see above).
9. Verify with an empty queue: manually run `publish.yml`, check the run is green and `/status` is unchanged. Do not send test links or messages unless separately authorized, because they publish to the live channel.

## Rollback

- Token problem: delete the Worker secret (the bot falls back to the schedule) and revoke the token in GitHub.
- Bad release: revert the merge on `main` and re-run `deploy-cloudflare`. The old Worker restores the daily cap and window and works on the migrated schema, so no database rollback is needed. Migrations have no down-migration and none is required.
- Stop publishing quickly without code changes: disable `publish-queue` and `publish-audio-queue` in the GitHub Actions UI.
- Jobs marked `failed` during a bad window: verify the channel, then `/retry ID` (`/retry-audio ID` for audio).

## Cost

All components stay on free tiers: GitHub-hosted standard runners are free in public repositories, Cloudflare Workers Free allows 100,000 requests per day and 50 subrequests per invocation (a dispatch adds one), and a fine-grained token costs nothing. GitHub may disable scheduled workflows in a public repository after a long period without activity (not re-verified here); manual or dispatched runs are unaffected.

## Approvals the owner must give

Production read-only D1 inspection; each production migration; the merge to `main`; the `deploy-cloudflare` run (includes the webhook re-registration); creating and storing the token; any Telegram test message or live publication.

## Safety rule

Until every blocker is resolved and the required approvals are explicit, keep work on the feature branch. Do not merge, deploy, migrate production D1, change Cloudflare secrets/configuration, register a webhook, or publish to Telegram.
