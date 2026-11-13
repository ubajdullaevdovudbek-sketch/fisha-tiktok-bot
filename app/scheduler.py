from datetime import datetime, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from aiogram import Bot

from .config import Config
from .db import Store
from .publisher import publish_one


async def publish_due(bot: Bot, store: Store, cfg: Config):
    queue = store.queued()
    if queue:
        await publish_one(bot, store, cfg.channel_id, queue[0])


def build_scheduler(bot: Bot, store: Store, cfg: Config) -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        publish_due,
        "interval",
        minutes=5,
        args=[bot, store, cfg],
        id="publish_queue",
        max_instances=1,
        coalesce=True,
        next_run_time=datetime.now() + timedelta(minutes=1),
    )
    return scheduler
