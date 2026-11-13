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
- `/retry ID` — requeue an ordinary failed local video job.
- `/retry ID CONFIRM` — explicitly requeue an `UNCERTAIN DELIVERY` local job only after checking the Telegram channel.
- `/retry-audio ID` — requeue a failed optional MP3 job; check the channel first if the prior send may have succeeded.

## Important constraints

- TikTok metadata and comments are not always available. The most-liked comment is included only when the extractor returns trustworthy comment data.
- Reposting requires permission to use the source video. Attribution does not replace permission.
- Telegram Bot API and hosting providers impose file-size, runtime, and rate limits.
- Cloudflare Workers alone cannot run `yt-dlp`/FFmpeg. This project uses GitHub Actions runners for the Python publisher; a free sleeping host cannot guarantee unattended 24/7 publishing.

## Free scheduled deployment (Cloudflare + GitHub Actions)

The hosted mode uses a Cloudflare Worker for the Telegram webhook and D1 for the queue. A public-repository GitHub Actions runner wakes every five minutes and processes up to five video/photo jobs per run. It downloads regular videos with yt-dlp and Photo Mode slides with gallery-dl, then publishes them through the Telegram Bot API. A separate workflow processes up to three optional audio jobs per run after video completion. The hosted Worker has no daily cap or 10:00–21:00 publishing window. Scheduled GitHub jobs can start late, so queue pickup is approximate rather than guaranteed to the exact minute. The `/publish` command marks the oldest queued item for priority; it does not start a runner immediately.

### Required GitHub repository secrets

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with D1 Edit at account scope and Workers Scripts Edit (Editor) scoped to the existing `fisha-tiktok-bot` Worker.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID.
- `BOT_TOKEN` — Telegram bot token.
- `OWNER_ID` — your numeric Telegram user ID.
- `TELEGRAM_WEBHOOK_SECRET` — random secret, 32+ characters.
- `WORKER_API_SECRET` — a different random secret, 32+ characters.
- `WORKER_API_URL` — the deployed Worker URL, stored as a GitHub Actions secret.

For immediate automatic dispatch on each incoming TikTok link and the owner-only **Опубликовать сейчас** button, configure the Worker secret `GITHUB_ACTIONS_TOKEN` with a fine-grained GitHub token scoped to this repository and **Actions: write** permission. The Worker dispatches only `publish.yml` on `main`; never put this token in GitHub workflow logs or repository files. If the secret is absent, new links are queued and the button only prioritizes its job; scheduled processing remains the fallback. GitHub-hosted runner startup and TikTok download time still mean this is not guaranteed to be instantaneous.

The destination channel is currently configured as the public username `@zadrot1705` in the publisher workflow, so a separate `CHANNEL_ID` secret is optional. You can override it by adding that secret.

### Cloudflare resources

The Cloudflare account already contains the Worker `fisha-tiktok-bot` and D1 database `fisha-tiktok-queue`. The D1 database and schema must be provisioned and migrated separately before deploying code. The current `deploy-cloudflare` workflow **does not apply D1 migrations**: it deploys the Worker, stores Worker secrets, registers the Telegram webhook, and checks Worker health. Do not treat a successful Worker deployment as proof that the database schema is current. Inspect the target database and migration history, verify Wrangler migration tracking, and apply only explicitly approved migrations before deployment. The API token must have the permissions required for the separately approved operations; Cloudflare's token UI may not offer per-database D1 scoping. Restrict Workers Scripts Edit to the individual Worker using **Specified Workers** → `fisha-tiktok-bot` → **Editor**. Do not grant Workers Admin, DNS, Billing, or account-management permissions.

Run **Actions → deploy-cloudflare → Run workflow** after the required secrets are configured. After deployment, verify the Worker health endpoint and Telegram webhook. The deploy workflow reports the Worker URL; save it as the GitHub Actions secret `WORKER_API_URL`.

### Telegram channel permissions

Add `@Clougptbot` to `@zadrot1705` as an administrator with permission to post messages. Keep the repository public so standard GitHub-hosted runner usage remains eligible for the free public-repository allowance. Do not commit tokens or secrets.

### Limits

- GitHub scheduled runs are best-effort and may be delayed.
- Video/photo jobs are processed in batches of up to five per run; optional audio jobs use a separate batch of up to three.
- Jobs claimed by a runner that disappears are returned to the queue after 20 minutes if Telegram delivery has not started. If delivery may have started, the job is marked `UNCERTAIN DELIVERY` and must be checked in the channel before manual retry.
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
