# Fisha TikTok → Telegram Bot

Personal Telegram bot for collecting TikTok links or uploaded videos, reviewing metadata, queueing approved clips, and publishing on a schedule to a Telegram channel.

## Current scope

- Telegram bot with a private-owner allowlist.
- Accept TikTok URLs and uploaded video files.
- Download public TikTok videos with `yt-dlp` (watermarks are retained).
- Extract available metadata; never invent unavailable author/comment data.
- Queue items for manual approval and scheduled channel publishing.
- Publish captions with source attribution.

## Important constraints

- TikTok metadata and comments are not always available. The most-liked comment is included only when the extractor returns trustworthy comment data.
- Reposting requires permission to use the source video. Attribution does not replace permission.
- Telegram Bot API and hosting providers impose file-size, runtime, and rate limits.
- Cloudflare Workers alone cannot run `yt-dlp`/FFmpeg. This project uses a Python worker process; it needs a host that supports persistent processes and FFmpeg. A free sleeping host cannot guarantee unattended 24/7 publishing.


## Free scheduled deployment (Cloudflare + GitHub Actions)

The hosted mode uses a Cloudflare Worker for the Telegram webhook and D1 for the queue. A public-repository GitHub Actions runner wakes every five minutes, claims at most one eligible video, downloads it with yt-dlp, and publishes it through the Telegram Bot API. This avoids a paid always-on Python host. Scheduled GitHub jobs can start late, so publication is approximate rather than guaranteed to the exact minute.

### Required GitHub repository secrets

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with D1 Edit at the account scope and Workers Scripts Edit (Editor) for the existing `fisha-tiktok-bot` Worker. Cloudflare requires Workers Admin to create a brand-new Worker through the API; to avoid granting that broader permission, create the Worker once in the Cloudflare dashboard first, then scope the token's Workers permission to that Worker.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID.
- `BOT_TOKEN` — Telegram bot token.
- `OWNER_ID` — your numeric Telegram user ID.
- `CHANNEL_ID` — destination channel username or numeric ID.
- `TELEGRAM_WEBHOOK_SECRET` — random secret, 32+ characters.
- `WORKER_API_SECRET` — a different random secret, 32+ characters.
- `WORKER_API_URL` — the deployed Worker URL, stored as a GitHub Actions secret.

Before deployment, open **Workers & Pages** in Cloudflare and create a Worker named exactly `fisha-tiktok-bot` (the initial starter code does not matter; deployment replaces it). This one-time dashboard step avoids granting the API token account-wide Workers Admin permission. Then create the API token with D1 Edit at the account scope and Workers Scripts Edit for this Worker. The deploy workflow creates the D1 database if needed, applies the schema, updates the existing Worker, stores Worker secrets, and registers the Telegram webhook. Run it from **Actions → deploy-cloudflare → Run workflow** after adding the secrets.

After deployment, copy the Worker URL shown in the workflow log into the repository Actions secret `WORKER_API_URL` (for example, `https://fisha-tiktok-bot.<your-workers-subdomain>.workers.dev`). The scheduled publisher workflow uses this secret plus the other secrets above. The publisher validates that all four required values are present before doing any work.

### Telegram channel permissions

Add the bot to the destination channel as an administrator with permission to post messages. Keep the repository public so standard GitHub-hosted runner usage remains eligible for the free public-repository allowance. Do not commit tokens or secrets.

### Limits

- GitHub scheduled runs are best-effort and may be delayed.
- Jobs claimed by a runner that disappears are returned to the queue after 20 minutes.
- Telegram Bot API upload size limits apply; the publisher currently caps source videos at 48 MB.
- TikTok may block downloads or omit author metadata. The bot never fabricates the most-liked comment; currently it does not scrape comments.
- Repost only videos you have permission to use.

## Local run

1. Install Python 3.11+ and FFmpeg.
2. Copy `.env.example` to `.env` and fill in the secrets.
3. Install dependencies: `pip install -r requirements.txt`.
4. Start: `python -m app`.

The bot uses long polling, so no public webhook URL is needed.

## Configuration

See `.env.example`. Never commit `.env`, bot tokens, or API keys.

## Status

The application code, Cloudflare Worker, D1 schema, scheduled publisher workflow, and automated tests are in place. Deployment is not live until the required GitHub Actions secrets are added and the `deploy-cloudflare` workflow succeeds.
