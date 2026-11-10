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

## Local run

1. Install Python 3.11+ and FFmpeg.
2. Copy `.env.example` to `.env` and fill in the secrets.
3. Install dependencies: `pip install -r requirements.txt`.
4. Start: `python -m app`.

The bot uses long polling, so no public webhook URL is needed.

## Configuration

See `.env.example`. Never commit `.env`, bot tokens, or API keys.

## Status

Initial scaffold. Hosting/deployment must be configured before unattended scheduled publishing can run.
