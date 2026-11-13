from pathlib import Path
from aiogram import Bot
from aiogram.types import FSInputFile

from .db import Store


def make_caption(item: dict) -> str:
    parts = []
    if item.get("source_caption"):
        parts.append(item["source_caption"].strip())
    if item.get("source_author"):
        # Plain text, deliberately not a clickable Telegram mention.
        parts.append(f"Автор оригинала: {item['source_author'].strip()}")
    if item.get("top_comment"):
        parts.append(f"Популярный комментарий: {item['top_comment'].strip()}")
    parts.append("Источник: TikTok")
    caption = "\n\n".join(parts)
    return caption[:1024]


async def publish_one(bot: Bot, store: Store, channel_id: str, item: dict):
    # Claim by ID with a conditional UPDATE inside BEGIN IMMEDIATE. The scheduler
    # and /publish command may race, but only one caller can proceed to Telegram.
    claimed = store.claim(int(item["id"]))
    if claimed is None:
        return False

    path = Path(claimed["file_path"])
    if not path.exists():
        store.mark_publish_failed(claimed["id"], "Файл не найден в хранилище")
        return False

    if not store.mark_publishing_started(claimed["id"]):
        store.mark_publish_failed(claimed["id"], "Не удалось зафиксировать начало отправки")
        return False

    try:
        await bot.send_video(
            chat_id=channel_id,
            video=FSInputFile(path),
            caption=make_caption(claimed),
        )
        store.set_status(claimed["id"], "published")
        return True
    except Exception as exc:
        # A transport error does not prove Telegram rejected the message.
        store.mark_publish_failed(claimed["id"], str(exc))
        return False
