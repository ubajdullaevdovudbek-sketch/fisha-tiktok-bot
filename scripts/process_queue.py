import os
import tempfile
from pathlib import Path
from urllib.parse import urljoin

import requests
import yt_dlp


API_URL = os.environ["WORKER_API_URL"].rstrip("/")
API_SECRET = os.environ["WORKER_API_SECRET"]
BOT_TOKEN = os.environ["BOT_TOKEN"]
CHANNEL_ID = os.environ["CHANNEL_ID"]
MAX_VIDEO_MB = int(os.getenv("MAX_VIDEO_MB", "48"))
MAX_JOBS_PER_RUN = max(1, min(10, int(os.getenv("MAX_JOBS_PER_RUN", "5"))))


def api(path: str, payload=None):
    response = requests.post(
        urljoin(API_URL + "/", path.lstrip("/")),
        headers={"Authorization": f"Bearer {API_SECRET}"},
        json=payload or {},
        timeout=30,
    )
    if response.status_code == 204:
        return None
    response.raise_for_status()
    return response.json()


def telegram_file(file_id: str, target: Path) -> None:
    info = requests.get(
        f"https://api.telegram.org/bot{BOT_TOKEN}/getFile",
        params={"file_id": file_id},
        timeout=30,
    )
    info.raise_for_status()
    data = info.json()
    if not data.get("ok"):
        raise RuntimeError("Telegram getFile failed")
    file_path = data["result"]["file_path"]
    url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}"
    with requests.get(url, stream=True, timeout=120) as response:
        response.raise_for_status()
        with target.open("wb") as output:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    output.write(chunk)


def download_tiktok(url: str, folder: Path):
    options = {
        "outtmpl": str(folder / "%(id)s.%(ext)s"),
        "format": "mp4/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "max_filesize": MAX_VIDEO_MB * 1024 * 1024,
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=True)
        path = Path(ydl.prepare_filename(info))
        if not path.exists():
            path = path.with_suffix(".mp4")
        if not path.exists():
            files = list(folder.glob("*"))
            if not files:
                raise FileNotFoundError("Downloaded video not found")
            path = files[0]
        return path, info


def make_caption(caption: str, author: str) -> str:
    parts = []
    if caption.strip():
        parts.append(caption.strip())
    if author.strip():
        parts.append(f"Автор оригинала: {author.strip()}")
    parts.append("Источник: TikTok")
    return "\n\n".join(parts)[:1024]


def publish(path: Path, caption: str):
    if path.stat().st_size > MAX_VIDEO_MB * 1024 * 1024:
        raise RuntimeError(f"Видео превышает лимит {MAX_VIDEO_MB} МБ")
    with path.open("rb") as video:
        response = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendVideo",
            data={"chat_id": CHANNEL_ID, "caption": caption, "supports_streaming": "true"},
            files={"video": (path.name, video, "video/mp4")},
            timeout=300,
        )
    response.raise_for_status()
    result = response.json()
    if not result.get("ok"):
        raise RuntimeError(result.get("description", "Telegram sendVideo failed"))


def process_one() -> bool:
    job_response = api("/api/claim")
    if not job_response:
        return False

    job = job_response["job"]
    job_id = int(job["id"])

    try:
        with tempfile.TemporaryDirectory(prefix="fisha-video-") as tmp:
            folder = Path(tmp)
            author = str(job.get("source_author") or "")
            caption = str(job.get("source_caption") or "")

            if job["kind"] == "tiktok_url":
                path, metadata = download_tiktok(job["source_url"], folder)
                author = str(metadata.get("uploader") or metadata.get("creator") or author)
                caption = caption or str(metadata.get("description") or metadata.get("title") or "")
            elif job["kind"] == "telegram_file":
                path = folder / f"telegram_{job_id}.mp4"
                telegram_file(job["telegram_file_id"], path)
            else:
                raise RuntimeError(f"Unsupported job type: {job['kind']}")

            publish(path, make_caption(caption, author))

        api("/api/complete", {"id": job_id})
        print(f"Published video #{job_id}")
        return True
    except Exception as exc:
        try:
            api("/api/fail", {"id": job_id, "error": str(exc)[:500]})
        except Exception as api_error:
            print(f"Could not mark job failed: {api_error}")
        raise


def main():
    processed = 0
    while processed < MAX_JOBS_PER_RUN:
        if not process_one():
            break
        processed += 1
    print(f"Run finished. Successfully processed {processed} job(s); limit={MAX_JOBS_PER_RUN}.")


if __name__ == "__main__":
    main()
