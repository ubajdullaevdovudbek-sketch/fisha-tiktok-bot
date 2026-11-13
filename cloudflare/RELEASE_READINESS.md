# Release readiness: Cloudflare Worker and D1

Last reviewed: 2026-11-14. Feature branch: `feature/fast-photo-carousel-no-daily-cap`.
This document separates repository/CI evidence from production observations. No production resource was changed during this review.

## Verified repository state

- Feature branch head at review start: `20dce5c40ff466997c7a6607b1847d1277a1348f`.
- GitHub Actions run [#234](https://github.com/ubajdullaevdovudbek-sketch/fisha-tiktok-bot/actions/runs/43492885930) passed on that exact SHA: `python-tests` and `worker-tests`.
- The passing Worker job includes syntax checks, local Miniflare D1 migration checks and local D1 integration tests. These are not tests against production D1.
- Draft PR [#2](https://github.com/ubajdullaevdovudbek-sketch/fisha-tiktok-bot/pull/2) is open, not merged. No merge to `main` is authorized by this document.
- Intended behavior: remove daily publishing caps and time-of-day windows in hosted and local modes; support ordered/resumable TikTok photo albums and a separate audio queue.
- Production publisher workflows now require both `github.ref == 'refs/heads/main'` and repository variable `ENABLE_PRODUCTION_PUBLISH == 'true'`. A missing or false variable prevents the publishing job from running.
- The deploy workflow is manual-only, main-only, and requires both repository variable `ALLOW_PRODUCTION_DEPLOY == 'true'` and the explicit `confirm_production_deploy` input. It checks production D1 schema read-only, deploys Worker code only, then checks `/health`. It does not run migrations, overwrite secrets, or register/change the Telegram webhook.

## Production observations (read-only; 2026-11-14)

The available Cloudflare MCP inspection exposed Worker name/ID/code and D1 SQL, but not deployment versions, active traffic splits, bindings, or secret metadata.

- Worker: `fisha-tiktok-bot`, ID `193dfcb09ae747fb96f81adc3db65452`.
- Worker metadata: created `2026-11-10 08:46:30 UTC`; modified `2026-11-11 12:15:44 UTC`. The modified timestamp is not proof of a deployment time.
- The script returned by the available code-inspection method contains the older routes and does not contain the new photo-batch/audio routes. Because version/traffic metadata is unavailable, this does not establish the exact active deployment under any gradual rollout.
- Production D1: `fisha-tiktok-queue`, ID `d3887cca-dad1-4436-b2f8-3486dadcddc7`.
- Observed `videos` columns: `id, kind, source_url, telegram_file_id, source_author, source_caption, status, force_publish, created_at, claimed_at, published_at, published_local_date, error`.
- Observed tables: `videos`, `webhook_updates`; observed indexes: `idx_videos_queue`, `idx_videos_published_day`. No `d1_migrations` table was observed.
- The observed `videos.kind` CHECK allows `tiktok_url` and `telegram_file`; `status` allows `queued`, `processing`, `published`, `failed`.
- Queue snapshot: 10 rows (2 queued, 0 processing, 7 published, 1 failed). Last queue/webhook activity observed: 2026-11-13 09:25 UTC; last publication observed: 2026-11-13 13:47 UTC. This is a snapshot, not a live guarantee.
- The available interface did not expose Worker bindings/secrets or exact active version ID. Do not infer these from source code or metadata.

## Migration set and compatibility

The feature branch contains additive migrations, to be considered only after a fresh production schema/history inspection:

1. `0002_delivery_uncertain.sql` adds `videos.publishing_started_at`.
2. `0003_audio_jobs.sql` creates `audio_jobs` and its queue index.
3. `0004_photo_album_progress.sql` adds `videos.album_next_offset INTEGER NOT NULL DEFAULT 0`.
4. `0005_photo_batch_reconciliation.sql` adds `videos.album_pending_offset INTEGER` and `videos.album_total_count INTEGER`.

These migrations have not been applied to production. Migrations 0002, 0004 and 0005 add columns and are not safe to re-run blindly; 0003 uses idempotent table/index creation. Do not rely on a migration-history table until Wrangler's remote migration tracking has been checked. Do not create or apply a guessed 0001 baseline.

The deploy workflow's read-only schema gate requires all four new `videos` columns and the `audio_jobs` table. Passing this gate only proves those objects exist; it does not prove migration history is correct, bindings/secrets are configured, or the Worker is safe to publish.

## Known cutover hazard and guardrails

Before the guard was added, the old production Worker lacked `/api/started`. The new video publisher claims through the old `/api/claim`, then its `/api/started` call fails and its error path can mark that claimed job failed before any Telegram send. The old Worker also lacks `/api/audio/claim`. Therefore publishing must remain disabled until the new Worker and schema are ready.

Current repository safeguards:
- Both publisher jobs are disabled unless `ENABLE_PRODUCTION_PUBLISH` is explicitly set to the string `true`.
- Deploy is disabled unless `ALLOW_PRODUCTION_DEPLOY` and the manual boolean confirmation are both true.
- Deploy performs only a read-only schema check, code deployment and health check. No migration, secret mutation or webhook mutation occurs in that workflow.

Residual behavior risks:
- An interrupted send after the delivery marker is treated as uncertain and must be checked in the Telegram channel before manual retry.
- A photo batch accepted by Telegram but not checkpointed in D1 can be resent after a manual retry. This is a known duplicate-delivery window; do not claim exactly-once delivery.
- Removing the daily cap and time window means an existing queued backlog may publish faster after release. The owner must decide whether to release or hold it before enabling publishing.

## Required release sequence (not executed)

1. Confirm CI is green on the exact PR head/merge candidate and review the complete PR diff.
2. Keep `ENABLE_PRODUCTION_PUBLISH` unset/false. Do not dispatch either publisher.
3. Before cutover, pause the existing video publisher workflow and wait for all in-flight runs to finish. Re-check the disabled state after merge; whether disabling survives a workflow-file merge has not been verified. Do not assume it does.
4. Re-read production D1 immediately before migration: schema, migration history (if present), counts by status, and every queued/processing row. The 2026-11-14 snapshot above can become stale as the webhook continues to queue links.
5. Run `wrangler d1 migrations list --remote` with authorized credentials. Reconcile its output with the actual schema. Stop on any drift, already-existing columns, unknown migration history, or unexpected table/index.
6. Resolve each legacy `processing` row against the Telegram channel before enabling the new publisher. Never bulk-requeue uncertain work. Decide explicitly whether queued backlog is released or held; any production write requires separate owner approval.
7. Apply migrations 0002, 0003, 0004, 0005 in order, one at a time, only after the baseline/history are reconciled and each production write is explicitly approved. Verify the resulting schema and migration tracking.
8. Merge PR #2 only after a separate explicit approval. Immediately verify publishers remain disabled and no run is in progress.
9. Run the guarded deploy workflow manually on `main`, only after a separate explicit approval. It deploys code only; schema must already pass its read-only preflight. Verify `/health`.
10. Verify Worker bindings/secrets and Telegram webhook separately using authorized Cloudflare/Telegram controls. These are not checked by the deploy workflow or by the available MCP inspection.
11. Only after end-to-end readiness is established, explicitly enable `ENABLE_PRODUCTION_PUBLISH=true`. This is a separate production configuration change requiring approval. Watch the first publisher run and inspect the channel.
12. Test real Telegram album/video/audio delivery only with separate explicit authorization; a local test or CI pass is not a live-send test.

## Stop conditions

Stop without deploying or enabling publishers if:
- production schema differs from the observed baseline or contains any of the target columns/tables already;
- migration history is missing, inconsistent, or not understood;
- any legacy `processing` row is unresolved;
- Worker bindings/secrets or webhook cannot be verified;
- CI is not green on the exact release candidate;
- the post-merge publisher disable state is uncertain;
- the owner has not separately approved the relevant production action.

## Explicit production safety boundary

No production D1 migration/write, Worker deploy, secret/config change, Telegram webhook change, workflow enable/dispatch, merge to `main`, or Telegram publication is authorized by this readiness document. Each remains gated by separate explicit approval. Until then, work stays on the feature branch.
