# Release readiness: Cloudflare Worker and D1

## Current verified state

- Feature branch: `feature/fast-photo-carousel-no-daily-cap`.
- Automated Python and local Miniflare D1 migration tests passed in GitHub Actions run `43167203012` at commit `b6c8400f6efedfe0c96871ca0aac7780a90e9dd9`.
- Migrations `0002_delivery_uncertain.sql`, `0003_audio_jobs.sql`, and `0004_photo_album_progress.sql` were applied to the separate test D1 database `fisha-tiktok-test` (ID `45cefcfb-f76d-4a3a-b48f-4375f65c0527`).
- Wrangler CLI recognition of the manually created test `d1_migrations` table has **not** been verified with Wrangler itself.
- Production D1 `fisha-tiktok-queue` (ID `d3887cca-dad1-4436-b2f8-3486dadcddc7`) has not been inspected or changed as part of this work.
- No production Worker deployment, production D1 migration, secret update, webhook change, or Telegram publication has been performed.

## Release blockers

1. **Production schema baseline is unverified.** Before planning migrations, perform read-only inspection of the production D1 schema and existing migration history. Do not assume it matches the test fixture or the current `schema.sql`.
2. **Wrangler migration tracking is unverified.** The test database was migrated through the Cloudflare connector and its `d1_migrations` table was created manually. A real Wrangler `d1 migrations list --remote` check has not been run.
3. **Migration 0001 is absent.** The repository contains migrations 0002–0004. The pre-0002 baseline exists as a test fixture, not as a production migration. Do not apply the fixture as a migration or create a new 0001 without first reconciling the actual production schema.
4. **The deploy workflow does not apply D1 migrations.** `.github/workflows/deploy-cloudflare.yml` deploys the Worker, sets Worker secrets, and registers the Telegram webhook. It contains no `wrangler d1 migrations apply` step. A Worker deployment must not be treated as a database migration.
5. **README deployment wording must remain consistent with the actual workflow.** Do not claim the deploy workflow provisions or migrates D1 unless the workflow is deliberately changed and reviewed.

## Required gated release sequence

1. Obtain explicit approval for production read-only inspection.
2. Inspect production D1 tables, columns, indexes, constraints, and migration history without writing.
3. Compare the actual production schema with the historical baseline and migrations 0002–0004. Resolve any drift before proposing writes.
4. Verify Wrangler's view of migration history using a compatible Wrangler CLI and authorized credentials. Do not infer compatibility from SQLite tests or connector SQL.
5. Prepare a migration plan showing exact SQL, expected before/after schema, rollback limitations, and the exact production database ID.
6. Obtain separate explicit approval for each production migration and for Worker deployment. These are distinct operations.
7. Only after approval, apply the approved migrations, verify the resulting schema, deploy the Worker, and separately verify health and webhook state.
8. Do not publish a Telegram test message or invoke Telegram Bot API as part of verification unless separately authorized.

## Safety rule

Until every blocker is resolved and the required approvals are explicit, keep work on the feature branch. Do not merge, deploy, migrate production D1, change Cloudflare secrets/configuration, register a webhook, or publish to Telegram.
