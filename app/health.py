from pathlib import Path
from .config import Config


def readiness(cfg: Config) -> list[str]:
    problems = []
    if not cfg.bot_token:
        problems.append("BOT_TOKEN не задан")
    if not cfg.channel_id:
        problems.append("CHANNEL_ID не задан")
    if not cfg.data_dir.exists() or not cfg.data_dir.is_dir():
        problems.append("Папка DATA_DIR недоступна")
    if not Path("/usr/bin/ffmpeg").exists():
        # yt-dlp may still download a ready MP4; this is a warning, not a hard blocker.
        problems.append("FFmpeg не найден: объединение отдельных потоков может не работать")
    return problems
