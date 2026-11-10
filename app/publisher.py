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
    path = Path(item["file_path"])
    if not path.exists():
        store.set_status(item["id"], "failed", "Файл не найден в хранилище")
        return False
    try:
        await bot.send_video(chat_id=channel_id, video=FSInputFile(path), caption=make_caption(item))
        store.set_status(item["id"], "published")
        return True
    except Exception as exc:
        store.set_status(item["id"], "failed", str(exc)[:500])
        return False
