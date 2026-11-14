# Fisha TikTok → Telegram Bot

Personal Telegram bot for collecting TikTok links or uploaded videos and automatically publishing queued videos or Photo Mode albums to a Telegram channel. Hosted and local modes have no daily publication cap or time-of-day gate.

## Current scope

- Telegram bot with a private-owner allowlist.
- Accept TikTok URLs and uploaded video files.
- Download public TikTok videos with `yt-dlp` (watermarks are retained).
- Extract available metadata; never invent unavailable author/comment data.
- Automatically queue incoming links/files for channel publishing; the hosted mode does not require a manual approval step.
- Handle TikTok Photo Mode carousels as ordered Telegram photo albums (up to 10 images per Telegram media group).
- Automatically request a `publish.yml` run on `main` whenever a new TikTok link is accepted, when the Worker secret `GITHUB_ACTIONS_TOKEN` is configured. Add an owner-only **Опубликовать сейчас** button to prioritize that exact job and request another run on demand. Without the token, both paths safely fall back to the next scheduled runner.
- `/publish` still prioritizes the oldest queued item; without a dispatch token it waits for the next scheduled run.
- Publish captions with source attribution.

### Telegram commands

- `/start` — show bot instructions.
- `/status` — show video queue counts and local scheduler cadence.
- `/queue` — list queued video/photo jobs, with manually prioritized jobs first.
- `/audio-queue` — list queued, processing, and failed MP3 jobs with their audio job IDs.
- `/publish` — prioritize the oldest queued video/photo job for the next scheduled runner.
- `/retry ID` — requeue a new local failure known to have happened before Telegram send began.
- `/retry ID CONFIRM` — requeue an `UNCERTAIN DELIVERY` job only after checking the Telegram channel. Photo Mode jobs with an in-flight batch cannot use this generic retry.
- `/retry-photo ID CONFIRM NEXT_OFFSET` — reconcile an uncertain Photo Mode batch after checking the channel. Choose the pending batch offset to resend that group, or the next block offset (up to 10 images later) to skip the group. The command accepts only those two offsets and only for a failed Photo Mode job with a recorded in-flight batch.
- `/retry-audio ID` — requeue a failed optional MP3 job; check the channel first if the prior send may have succeeded.

## Important constraints

- TikTok metadata and comments are not always available. The most-liked comment is included only when the extractor returns trustworthy comment data.
- Reposting requires permission to use the source video. Attribution does not replace permission.
- Telegram Bot API and hosting providers impose file-size, runtime, and rate limits.
- Cloudflare Workers alone cannot run `yt-dlp`/FFmpeg. This project uses GitHub Actions runners for the Python publisher; a free sleeping host cannot guarantee unattended 24/7 publishing.

## Free scheduled deployment (Cloudflare + GitHub Actions)

The hosted mode uses a Cloudflare Worker for the Telegram webhook and D1 for the queue. A public-repository GitHub Actions runner wakes every five minutes and processes up to five video/photo jobs per run. It downloads regular videos with yt-dlp and Photo Mode slides with gallery-dl, then publishes them through the Telegram Bot API. A separate workflow processes up to three optional audio jobs per run after video completion. MP3 tasks remain recorded in D1, but their publisher is independently gated by `ENABLE_AUDIO_PUBLISH`; enabling video publication does not enable MP3 publication. The hosted Worker has no daily cap or time-of-day window. New TikTok links are deduplicated by canonical video ID or normalized URL. Pre-delivery transient failures are retried up to three total attempts with backoff; once Telegram sending may have started, automatic retry is prohibited and the job is marked for manual reconciliation. Scheduled GitHub jobs can start late, so queue pickup is approximate rather than guaranteed to the exact minute. The `/publish` command marks the oldest queued item for priority; it does not start a runner immediately.

### Required GitHub repository secrets

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with the minimum required Workers Scripts permissions for the `fisha-tiktok-bot` Worker and read access for the account workers subdomain/D1 schema checks. Production D1 writes are not performed by the deploy workflow.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID.
- `BOT_TOKEN` — Telegram bot token.
- `OWNER_ID` — your numeric Telegram user ID.
- `TELEGRAM_WEBHOOK_SECRET` — random secret, 32+ characters.
- `WORKER_API_SECRET` — a different random secret, 32+ characters.
- `CONTROL_READ_SECRET` — optional separate 32+ character read-only dashboard key.
- `ENABLE_PRODUCTION_PUBLISH` — GitHub Actions repository variable; set to `true` only after production approval.
- `ENABLE_AUDIO_PUBLISH` — independent GitHub Actions repository variable for MP3 publishing; leave unset/false while video publishing is being recovered.

For immediate automatic dispatch on each incoming TikTok link and the owner-only **Опубликовать сейчас** button, configure the Worker secret `GITHUB_ACTIONS_TOKEN` with a fine-grained GitHub token scoped to this repository and **Actions: write** permission. The Worker dispatches only `publish.yml` on `main`; never put this token in GitHub workflow logs or repository files. If the secret is absent, new links are queued and the button only prioritizes its job; scheduled processing remains the fallback. GitHub-hosted runner startup and TikTok download time still mean this is not guaranteed to be instantaneous.

The destination channel is currently configured as the public username `@zadrot1705` in the publisher workflow, so a separate `CHANNEL_ID` secret is optional. You can override it by adding that secret.

### Cloudflare resources

The Cloudflare account already contains the Worker `fisha-tiktok-bot` and D1 database `fisha-tiktok-queue`. The D1 database and schema must be provisioned and migrated separately before deploying code. The current `deploy-cloudflare` workflow **does not apply D1 migrations**: it deploys the Worker, stores Worker secrets, registers the Telegram webhook, and checks Worker health. Do not treat a successful Worker deployment as proof that the database schema is current. Migration 0006 adds retry metadata and source-key deduplication; it deliberately does not backfill old TikTok IDs or collapse historical duplicates. Verify production D1 schema and migration history separately, then apply approved migrations one at a time before deployment. The API token must have the permissions required for the separately approved operations; Cloudflare's token UI may not offer per-database D1 scoping. Restrict Workers Scripts Edit to the individual Worker using **Specified Workers** → `fisha-tiktok-bot` → **Editor**. Do not grant Workers Admin, DNS, Billing, or account-management permissions.

Run **Actions → deploy-cloudflare → Run workflow** after the required secrets are configured. After deployment, verify the Worker health endpoint and Telegram webhook. The publish workflows resolve the Worker URL from the Cloudflare account subdomain at runtime; no `WORKER_API_URL` secret is required.

### Telegram channel permissions

Add `@Clougptbot` to `@zadrot1705` as an administrator with permission to post messages. Keep the repository public so standard GitHub-hosted runner usage remains eligible for the free public-repository allowance. Do not commit tokens or secrets.

### Limits

- GitHub scheduled runs are best-effort and may be delayed.
- Video/photo jobs are processed in batches of up to five per run; optional audio jobs use a separate batch of up to three.
- Jobs claimed by a runner that disappears are returned to the queue after 20 minutes if Telegram delivery has not started. If delivery may have started, the job is marked `UNCERTAIN DELIVERY` and must be checked in the channel before manual retry. For Photo Mode, each batch offset and album size are persisted before contacting Telegram; confirmed batches advance progress and clear the in-flight marker. An ambiguous batch stays quarantined until `/retry-photo ID CONFIRM NEXT_OFFSET` explicitly chooses whether to resend or skip that batch. Telegram has no idempotency key for media-group sends, so this operator reconciliation reduces accidental duplicates but cannot guarantee exactly-once delivery.
- Telegram Bot API upload size limits apply; the publisher currently caps source videos at 48 MB.
- TikTok may block downloads or omit author metadata. The bot never fabricates the most-liked comment; currently it does not scrape comments.
- Repost only videos you have permission to use.

## Local run

1. Install Python 3.11+ and FFmpeg.
2. Copy `.env.example` to `.env` and fill in the secrets.
3. Install dependencies: `pip install -r requirements.txt`.
4. Start: `python -m app`.

The bot uses long polling, so no public webhook URL is needed. The local fallback also has no daily cap or time-of-day gate: it checks the queue every five minutes and publishes at most one queued item per check. Unlike hosted mode, it does not yet include the hosted Photo Mode album and separate audio-queue workflows.

## Configuration

See `.env.example`. Never commit `.env`, bot tokens, or API keys.

## Status

The feature branch contains the hosted queue, video/photo batch publisher, optional audio queue, and automated tests. The hosted Worker deployment and production D1 schema still require separate read-only verification before release. The feature branch is not live: publish and deploy workflows are restricted to `main`. No real TikTok Photo Mode download smoke test or live Telegram channel test has been confirmed.
