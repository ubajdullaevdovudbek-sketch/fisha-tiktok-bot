from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from aiogram import Bot

from .config import Config
from .db import Store
from .publisher import publish_one


def next_publish_time(cfg: Config, tz: ZoneInfo) -> datetime:
    now = datetime.now(tz)
    start_h, start_m = map(int, cfg.publish_start.split(":"))
    end_h, end_m = map(int, cfg.publish_end.split(":"))
    start = now.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
    end = now.replace(hour=end_h, minute=end_m, second=0, microsecond=0)
    if end <= start:
        end += timedelta(days=1)
    if now < start:
        return start
    if now <= end:
        return now + timedelta(minutes=1)
    return start + timedelta(days=1)


async def publish_due(bot: Bot, store: Store, cfg: Config):
    queue = store.queued()
    if not queue:
        return
    # Publish at most one item per scheduler tick; APScheduler runs every 20 minutes.
    await publish_one(bot, store, cfg.channel_id, queue[0])


def build_scheduler(bot: Bot, store: Store, cfg: Config) -> AsyncIOScheduler:
    tz = ZoneInfo(cfg.timezone)
    scheduler = AsyncIOScheduler(timezone=tz)
    scheduler.add_job(publish_due, "interval", minutes=20, args=[bot, store, cfg], id="publish_queue", max_instances=1, coalesce=True)
    return scheduler
