import asyncio
import logging
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandStart
from aiogram.types import Message

from .config import load_config
from .db import Store
from .downloader import download_tiktok
from .scheduler import build_scheduler

logging.basicConfig(level=logging.INFO)


async def main():
    cfg = load_config()
    bot = Bot(cfg.bot_token)
    dp = Dispatcher()
    store = Store(cfg.data_dir / "queue.sqlite3")
    downloads = cfg.data_dir / "videos"
    scheduler = build_scheduler(bot, store, cfg)

    def is_owner(message: Message) -> bool:
        return bool(message.from_user and message.from_user.id == cfg.owner_id)

    @dp.message(CommandStart())
    async def start(message: Message):
        if not is_owner(message):
            return
        await message.answer("Бот готов принимать TikTok-ссылки и видео. Команды: /queue, /status, /publish")

    @dp.message(Command("status"))
    async def status(message: Message):
        if not is_owner(message):
            return
        q = store.queued()
        await message.answer(f"В очереди: {len(q)}\nПубликация: до {cfg.posts_per_day} роликов в день (настроено; расписание требует постоянного хостинга).")

    @dp.message(Command("queue"))
    async def queue(message: Message):
        if not is_owner(message):
            return
        q = store.queued()
        if not q:
            await message.answer("Очередь пуста.")
            return
        lines = [f"#{x['id']} — {Path(x['file_path']).name}" for x in q[:30]]
        await message.answer("Очередь:\n" + "\n".join(lines))

    @dp.message(Command("publish"))
    async def publish(message: Message):
        if not is_owner(message):
            return
        from .publisher import publish_one
        q = store.queued()
        if not q:
            await message.answer("Очередь пуста.")
            return
        ok = await publish_one(bot, store, cfg.channel_id, q[0])
        await message.answer("Опубликовано." if ok else "Не удалось опубликовать. Проверь логи и доступ бота к каналу.")

    @dp.message(F.text)
    async def text_message(message: Message):
        if not is_owner(message):
            return
        url = (message.text or "").strip()
        if "tiktok.com/" not in url:
            await message.answer("Пришли ссылку TikTok или видеофайл.")
            return
        await message.answer("Скачиваю видео. Водяной знак сохраняется…")
        try:
            path, info = await asyncio.to_thread(download_tiktok, url, downloads, cfg.max_video_mb)
            item_id = store.add(str(path), url, info.get("uploader") or info.get("creator") or "", info.get("description") or info.get("title") or "")
            await message.answer(f"Добавлено в очередь: #{item_id}\nАвтор: {info.get('uploader') or info.get('creator') or 'не удалось определить'}\nКомментарий и описание добавляются только если доступны достоверные данные.")
        except Exception as exc:
            await message.answer(f"Не удалось скачать: {str(exc)[:700]}")

    @dp.message(F.video)
    async def uploaded_video(message: Message):
        if not is_owner(message) or not message.video:
            return
        if message.video.file_size and message.video.file_size > cfg.max_video_mb * 1024 * 1024:
            await message.answer(f"Файл больше лимита {cfg.max_video_mb} МБ.")
            return
        target = downloads / f"telegram_{message.video.file_unique_id}.mp4"
        target.parent.mkdir(parents=True, exist_ok=True)
        await bot.download(message.video, destination=target)
        item_id = store.add(str(target), caption=message.caption or "")
        await message.answer(f"Видео добавлено в очередь: #{item_id}")

    scheduler.start()
    try:
        await dp.start_polling(bot)
    finally:
        scheduler.shutdown(wait=False)
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
