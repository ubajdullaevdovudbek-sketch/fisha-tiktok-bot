from datetime import datetime, timedelta, time, timezone
from zoneinfo import ZoneInfo
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from aiogram import Bot

from .config import Config
from .db import Store
from .publisher import publish_one


def in_publish_window(cfg: Config, tz: ZoneInfo) -> bool:
    now = datetime.now(tz)
    sh, sm = map(int, cfg.publish_start.split(":"))
    eh, em = map(int, cfg.publish_end.split(":"))
    start = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
    end = now.replace(hour=eh, minute=em, second=0, microsecond=0)
    if end <= start:
        return now >= start or now <= end
    return start <= now <= end


async def publish_due(bot: Bot, store: Store, cfg: Config):
    tz = ZoneInfo(cfg.timezone)
    if not in_publish_window(cfg, tz):
        return
    local_now = datetime.now(tz)
    local_start = datetime.combine(local_now.date(), time.min, tzinfo=tz)
    local_end = local_start + timedelta(days=1)
    start_utc = local_start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    end_utc = local_end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    if store.published_between(start_utc, end_utc) >= cfg.posts_per_day:
        return
    queue = store.queued()
    if queue:
        await publish_one(bot, store, cfg.channel_id, queue[0])


def build_scheduler(bot: Bot, store: Store, cfg: Config) -> AsyncIOScheduler:
    tz = ZoneInfo(cfg.timezone)
    start_h, start_m = map(int, cfg.publish_start.split(":"))
    end_h, end_m = map(int, cfg.publish_end.split(":"))
    window_minutes = (end_h * 60 + end_m) - (start_h * 60 + start_m)
    if window_minutes <= 0:
        window_minutes += 24 * 60
    interval = max(20, window_minutes // cfg.posts_per_day)
    scheduler = AsyncIOScheduler(timezone=tz)
    scheduler.add_job(publish_due, "interval", minutes=interval, args=[bot, store, cfg], id="publish_queue", max_instances=1, coalesce=True, next_run_time=datetime.now(tz) + timedelta(minutes=1))
    return scheduler
