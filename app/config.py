from dataclasses import dataclass
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Config:
    bot_token: str
    owner_id: int
    channel_id: str
    timezone: str
    posts_per_day: int
    publish_start: str
    publish_end: str
    data_dir: Path
    max_video_mb: int


def load_config() -> Config:
    token = os.getenv("BOT_TOKEN", "").strip()
    owner = os.getenv("OWNER_ID", "").strip()
    channel = os.getenv("CHANNEL_ID", "").strip()
    if not token or not owner or not channel:
        raise RuntimeError("Set BOT_TOKEN, OWNER_ID and CHANNEL_ID in environment/.env")
    data_dir = Path(os.getenv("DATA_DIR", "./data")).expanduser()
    data_dir.mkdir(parents=True, exist_ok=True)
    return Config(
        bot_token=token,
        owner_id=int(owner),
        channel_id=channel,
        timezone=os.getenv("TIMEZONE", "Asia/Tashkent"),
        posts_per_day=max(1, int(os.getenv("POSTS_PER_DAY", "3"))),
        publish_start=os.getenv("PUBLISH_START", "10:00"),
        publish_end=os.getenv("PUBLISH_END", "21:00"),
        data_dir=data_dir,
        max_video_mb=max(10, int(os.getenv("MAX_VIDEO_MB", "180"))),
    )
