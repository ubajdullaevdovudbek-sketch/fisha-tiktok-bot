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
from app.photo_validation import validate_telegram_photo
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
    data = response.json()
    if isinstance(data, dict) and data.get("ok") is False:
        raise RuntimeError(data.get("error", f"Worker API {path} failed"))
    return data


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


def publish(path: Path, caption: str, before_send=None):
    if path.stat().st_size > MAX_VIDEO_MB * 1024 * 1024:
        raise RuntimeError(f"Видео превышает лимит {MAX_VIDEO_MB} МБ")
    if before_send:
        before_send()
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


def publish_photos(paths: list[Path], caption: str, before_send=None):
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
        if before_send:
            before_send()
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

            delivery_started = False
            audio_task = None

            def mark_delivery_started():
                nonlocal delivery_started
                if not delivery_started:
                    api("/api/started", {"id": job_id})
                    delivery_started = True

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
                    publish_photos(photos, make_caption(caption, author), before_send=mark_delivery_started)
                    print(f"Published TikTok photo carousel #{job_id} ({len(photos)} images)")
                else:
                    path, metadata = download_tiktok(resolved_url, folder)
                    author = str(metadata.get("uploader") or metadata.get("creator") or author)
                    caption = caption or str(metadata.get("description") or metadata.get("title") or "")
                    final_caption = make_caption(caption, author)
                    publish(path, final_caption, before_send=mark_delivery_started)
                    print(f"Published video #{job_id}")
                    # Defer optional MP3 until the video job is durably completed.
                    audio_title = caption.strip() or str(metadata.get("title") or "TikTok audio")
                    audio_task = {"kind": "tiktok_url", "source_url": source_url, "title": audio_title}
            elif job["kind"] == "telegram_file":
                path = folder / f"telegram_{job_id}.mp4"
                telegram_file(job["telegram_file_id"], path)
                publish(path, make_caption(caption, author), before_send=mark_delivery_started)
                # Defer optional MP3 until the video job is durably completed.
                audio_task = {"kind": "telegram_file", "telegram_file_id": job["telegram_file_id"], "title": caption.strip() or f"Telegram video {job_id}"}
            else:
                raise RuntimeError(f"Unsupported job type: {job['kind']}")

            # Complete the video and persist its optional audio task in one
            # Worker-side D1 transaction, so a crash cannot lose the MP3 job.
            completion = {"id": job_id}
            if audio_task:
                completion["audio_task"] = audio_task
            api("/api/complete", completion)
            if audio_task:
                print(f"Queued optional MP3 extraction for video #{job_id}")
        return True
    except Exception as exc:
        print(f"Job #{job_id} failed; continuing with the next queue item: {exc}")
        try:
            api("/api/fail", {"id": job_id, "error": str(exc)[:500]})
        except Exception as api_error:
            print(f"Could not mark job #{job_id} failed: {api_error}")
        # This item was claimed, so count the attempt and continue. Claim/API
        # errors happen before this try block and still abort the batch.
        return True


def main():
    processed = process_batch(process_one, MAX_JOBS_PER_RUN)
    print(f"Run finished. Claimed/attempted {processed} job(s); limit={MAX_JOBS_PER_RUN}.")


if __name__ == "__main__":
    main()
