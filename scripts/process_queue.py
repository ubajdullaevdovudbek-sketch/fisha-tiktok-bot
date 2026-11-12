import json
import mimetypes
import os
import tempfile
from contextlib import ExitStack
from pathlib import Path
from urllib.parse import urljoin

import requests
import yt_dlp

from app.audio import extract_audio_mp3
from app.queue_runner import process_batch
from app.tiktok_photos import download_tiktok_photos, is_tiktok_photo_url, resolve_tiktok_url


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


def publish_audio(mp3_path: Path, title: str):
    """Send an extracted MP3 as a separate Telegram audio message."""
    if mp3_path.stat().st_size > 50 * 1024 * 1024:
        raise RuntimeError("Extracted MP3 exceeds Telegram's 50 MB audio limit")
    with mp3_path.open("rb") as audio:
        response = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendAudio",
            data={"chat_id": CHANNEL_ID, "title": title[:64] or "TikTok audio", "performer": "TikTok"},
            files={"audio": (mp3_path.name, audio, "audio/mpeg")},
            timeout=300,
        )
    response.raise_for_status()
    result = response.json()
    if not result.get("ok"):
        raise RuntimeError(result.get("description", "Telegram sendAudio failed"))


def publish_audio_best_effort(video_path: Path, folder: Path, title: str):
    """Extract and send audio after video publication; audio errors never fail the job."""
    try:
        mp3_path = extract_audio_mp3(video_path, folder / "audio.mp3")
        publish_audio(mp3_path, title)
        print(f"Published separate MP3 audio: {mp3_path.stat().st_size} bytes")
    except Exception as exc:
        print(f"Audio extraction/publication skipped; video is already published: {exc}")


def validate_telegram_photo(path: Path) -> None:
    """Validate Telegram photo upload constraints without altering image bytes."""
    max_bytes = 10 * 1024 * 1024
    if path.stat().st_size > max_bytes:
        raise RuntimeError(f"Photo exceeds Telegram's 10 MB upload limit: {path.name}")

    try:
        from PIL import Image

        with Image.open(path) as image:
            width, height = image.size
            image.verify()
    except Exception as exc:
        raise RuntimeError(f"Photo is unreadable or has an unsupported image format: {path.name} ({exc})") from exc

    if width <= 0 or height <= 0:
        raise RuntimeError(f"Photo has invalid dimensions: {path.name} ({width}x{height})")
    if width + height > 10_000:
        raise RuntimeError(
            f"Photo dimensions exceed Telegram's 10,000-pixel width+height limit: "
            f"{path.name} ({width}x{height})"
        )
    if max(width, height) / min(width, height) > 20:
        raise RuntimeError(
            f"Photo aspect ratio exceeds Telegram's 20:1 limit: {path.name} ({width}x{height})"
        )


def publish_photos(paths: list[Path], caption: str):
    if not paths:
        raise RuntimeError("No photos to publish")
    # Preflight every image before sending anything, avoiding partial albums
    # caused by a later file violating Telegram's upload constraints.
    for path in paths:
        validate_telegram_photo(path)

    # Telegram media groups contain at most 10 items. A single image is sent
    # with sendPhoto because sendMediaGroup requires at least two items.
    for offset in range(0, len(paths), 10):
        batch = paths[offset:offset + 10]
        method = "sendPhoto" if len(batch) == 1 else "sendMediaGroup"
        with ExitStack() as stack:
            handles = [stack.enter_context(path.open("rb")) for path in batch]
            if method == "sendPhoto":
                response = requests.post(
                    f"https://api.telegram.org/bot{BOT_TOKEN}/sendPhoto",
                    data={"chat_id": CHANNEL_ID, "caption": caption if offset == 0 else ""},
                    files={"photo": (batch[0].name, handles[0], mimetypes.guess_type(batch[0].name)[0] or "application/octet-stream")},
                    timeout=300,
                )
            else:
                media = []
                files = []
                for index, (path, handle) in enumerate(zip(batch, handles)):
                    attach_name = f"photo{index}"
                    item = {"type": "photo", "media": f"attach://{attach_name}"}
                    if offset == 0 and index == 0 and caption:
                        item["caption"] = caption
                    media.append(item)
                    files.append((attach_name, (path.name, handle, mimetypes.guess_type(path.name)[0] or "application/octet-stream")))
                response = requests.post(
                    f"https://api.telegram.org/bot{BOT_TOKEN}/sendMediaGroup",
                    data={"chat_id": CHANNEL_ID, "media": json.dumps(media, ensure_ascii=False)},
                    files=files,
                    timeout=300,
                )
        response.raise_for_status()
        result = response.json()
        if not result.get("ok"):
            raise RuntimeError(result.get("description", f"Telegram API {method} failed"))


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
                source_url = job["source_url"]
                try:
                    resolved_url = resolve_tiktok_url(source_url)
                except requests.RequestException as exc:
                    # Never let short-link resolution block the primary video
                    # path: yt-dlp can resolve TikTok short links itself.
                    print(f"Short-link preflight failed; using yt-dlp directly: {exc}")
                    resolved_url = source_url

                if is_tiktok_photo_url(resolved_url):
                    photos = download_tiktok_photos(resolved_url, folder)
                    publish_photos(photos, make_caption(caption, author))
                    print(f"Published TikTok photo carousel #{job_id} ({len(photos)} images)")
                else:
                    path, metadata = download_tiktok(resolved_url, folder)
                    author = str(metadata.get("uploader") or metadata.get("creator") or author)
                    caption = caption or str(metadata.get("description") or metadata.get("title") or "")
                    final_caption = make_caption(caption, author)
                    publish(path, final_caption)
                    print(f"Published video #{job_id}")
                    # Optional MP3 is deliberately post-publication and best-effort.
                    audio_title = caption.strip() or str(metadata.get("title") or "TikTok audio")
                    publish_audio_best_effort(path, folder, audio_title)
            elif job["kind"] == "telegram_file":
                path = folder / f"telegram_{job_id}.mp4"
                telegram_file(job["telegram_file_id"], path)
                publish(path, make_caption(caption, author))
                # Preserve the original video-first path; MP3 is optional.
                publish_audio_best_effort(path, folder, caption.strip() or f"Telegram video {job_id}")
            else:
                raise RuntimeError(f"Unsupported job type: {job['kind']}")

        api("/api/complete", {"id": job_id})
        return True
    except Exception as exc:
        try:
            api("/api/fail", {"id": job_id, "error": str(exc)[:500]})
        except Exception as api_error:
            print(f"Could not mark job failed: {api_error}")
        raise


def main():
    processed = process_batch(process_one, MAX_JOBS_PER_RUN)
    print(f"Run finished. Successfully processed {processed} job(s); limit={MAX_JOBS_PER_RUN}.")


if __name__ == "__main__":
    main()
