import json
import mimetypes
import os
import subprocess
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path
from urllib.parse import urljoin

import requests
import yt_dlp

from app.audio import extract_audio_mp3
from app.photo_validation import validate_telegram_photo
from app.queue_runner import process_batch
from app.tiktok_photos import download_tiktok_photos, is_tiktok_photo_url, resolve_tiktok_url
from app.tiktok_live_photos import download_tiktok_live_photo_album


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


def validate_live_photo_album(slides):
    """Preflight Telegram Live Photo constraints before starting album delivery."""
    for kind, media in slides:
        if kind != "live_photo":
            continue
        still_path, motion_path = media
        validate_telegram_photo(still_path)
        if motion_path.stat().st_size == 0 or motion_path.stat().st_size > 10 * 1024 * 1024:
            raise RuntimeError(f"Live Photo motion clip must be non-empty and no larger than 10 MB: {motion_path.name}")
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(motion_path)],
            capture_output=True, text=True, timeout=15, check=False,
        )
        if probe.returncode != 0:
            raise RuntimeError(f"Cannot verify Live Photo duration: {motion_path.name}")
        try:
            duration = float(probe.stdout.strip())
        except ValueError as exc:
            raise RuntimeError(f"Cannot read Live Photo duration: {motion_path.name}") from exc
        if duration > 10:
            raise RuntimeError(f"Live Photo motion clip exceeds Telegram's 10-second limit: {motion_path.name}")


def publish_photos(paths: list[Path] | list[tuple[str, object]], caption: str, before_send=None,
                   start_offset: int = 0, before_batch=None, after_batch=None):
    if not paths:
        raise RuntimeError("No photos to publish")
    if (start_offset < 0 or start_offset > len(paths) or
            (start_offset != len(paths) and start_offset % 10)):
        raise RuntimeError(f"Invalid saved photo album offset: {start_offset}")
    # Normalize legacy photo-only paths and mixed Live Photo slide tuples.
    slides = [(item[0], item[1]) if isinstance(item, tuple) else ("photo", item) for item in paths]
    if any(kind not in {"photo", "video", "live_photo"} for kind, _ in slides):
        raise RuntimeError("Unsupported TikTok album media type")
    # Preflight every file before sending anything. Prefer native Telegram
    # Live Photos when they meet Telegram's 10-second / 10-MB limits. The user
    # only needs motion, so oversized/long clips fall back to ordinary videos.
    for index, (kind, media) in enumerate(slides):
        if kind == "photo":
            validate_telegram_photo(media)
        elif kind == "live_photo":
            still_path, motion_path = media
            validate_telegram_photo(still_path)
            if motion_path.suffix.lower() != ".mp4" or not motion_path.is_file() or motion_path.stat().st_size == 0:
                raise RuntimeError(f"Invalid Live Photo MP4 slide: {motion_path}")
            if motion_path.stat().st_size > MAX_VIDEO_MB * 1024 * 1024:
                # The still remains a safe fallback if the motion file exceeds
                # the Bot API's regular video upload budget.
                slides[index] = ("photo", still_path)
                continue
            duration = None
            if motion_path.stat().st_size <= 10 * 1024 * 1024:
                try:
                    probe = subprocess.run(
                        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                         "-of", "default=noprint_wrappers=1:nokey=1", str(motion_path)],
                        capture_output=True, text=True, timeout=15, check=False,
                    )
                    if probe.returncode == 0:
                        try:
                            duration = float(probe.stdout.strip())
                        except ValueError:
                            duration = None
                except (OSError, subprocess.TimeoutExpired):
                    duration = None
            if motion_path.stat().st_size <= 10 * 1024 * 1024 and duration is not None and duration <= 10:
                continue
            # Telegram native Live Photo limits are stricter than ordinary
            # video limits. Send the motion clip as a regular video instead.
            slides[index] = ("video", motion_path)
        elif kind == "video":
            if media.suffix.lower() != ".mp4" or not media.is_file() or media.stat().st_size == 0:
                raise RuntimeError(f"Invalid MP4 video slide: {media}")
            if media.stat().st_size > MAX_VIDEO_MB * 1024 * 1024:
                raise RuntimeError(f"Video slide exceeds Telegram's safe {MAX_VIDEO_MB} MB upload limit: {media.name}")
        else:
            raise RuntimeError("Unsupported TikTok album media type")

    # Telegram media groups contain at most 10 items. A single image is sent
    # with sendPhoto because sendMediaGroup requires at least two items.
    for offset in range(start_offset, len(slides), 10):
        batch = slides[offset:offset + 10]
        method = ({"photo": "sendPhoto", "video": "sendVideo", "live_photo": "sendLivePhoto"}[batch[0][0]]) if len(batch) == 1 else "sendMediaGroup"
        if before_send:
            before_send()
        if before_batch:
            before_batch(offset, len(paths))
        with ExitStack() as stack:
            if len(batch) == 1:
                media_type, media = batch[0]
                if media_type == "live_photo":
                    still_path, motion_path = media
                    still_handle = stack.enter_context(still_path.open("rb"))
                    motion_handle = stack.enter_context(motion_path.open("rb"))
                    files = {
                        "photo": (still_path.name, still_handle, mimetypes.guess_type(still_path.name)[0] or "image/jpeg"),
                        "live_photo": (motion_path.name, motion_handle, "video/mp4"),
                    }
                else:
                    field = "photo" if media_type == "photo" else "video"
                    handle = stack.enter_context(media.open("rb"))
                    files = {field: (media.name, handle, mimetypes.guess_type(media.name)[0] or "application/octet-stream")}
                response = requests.post(
                    f"https://api.telegram.org/bot{BOT_TOKEN}/{method}",
                    data={"chat_id": CHANNEL_ID, "caption": caption if offset == 0 else ""},
                    files=files,
                    timeout=300,
                )
            else:
                media = []
                files = []
                for index, (media_type, item_media) in enumerate(batch):
                    attach_name = f"slide{index}"
                    if media_type == "live_photo":
                        still_path, motion_path = item_media
                        photo_attach = f"still{index}"
                        video_attach = f"motion{index}"
                        item = {"type": "live_photo", "media": f"attach://{video_attach}",
                                "photo": f"attach://{photo_attach}"}
                        still_handle = stack.enter_context(still_path.open("rb"))
                        motion_handle = stack.enter_context(motion_path.open("rb"))
                        files.append((photo_attach, (still_path.name, still_handle, mimetypes.guess_type(still_path.name)[0] or "image/jpeg")))
                        files.append((video_attach, (motion_path.name, motion_handle, "video/mp4")))
                    else:
                        path = item_media
                        item = {"type": media_type, "media": f"attach://{attach_name}"}
                        if media_type == "video":
                            item["supports_streaming"] = True
                        handle = stack.enter_context(path.open("rb"))
                        files.append((attach_name, (path.name, handle, mimetypes.guess_type(path.name)[0] or "application/octet-stream")))
                    if offset == 0 and index == 0 and caption:
                        item["caption"] = caption
                    media.append(item)
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
        if after_batch:
            after_batch(offset + len(batch))


def process_one() -> bool:
    claim_started = time.monotonic()
    job_response = api("/api/claim")
    print(f"[timing] queue claim: {time.monotonic() - claim_started:.2f}s")
    if not job_response:
        return False

    job = job_response["job"]
    job_id = int(job["id"])
    job_started = time.monotonic()
    print(f"[timing] job #{job_id} started; kind={job.get('kind')}")

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
                    started = time.monotonic()
                    api("/api/started", {"id": job_id})
                    print(f"[timing] job #{job_id} delivery marker: {time.monotonic() - started:.2f}s")
                    delivery_started = True

            if job["kind"] == "tiktok_url":
                source_url = job["source_url"]
                try:
                    started = time.monotonic()
                    resolved_url = resolve_tiktok_url(source_url)
                    print(f"[timing] job #{job_id} URL resolution: {time.monotonic() - started:.2f}s")
                except requests.RequestException as exc:
                    # Never let short-link resolution block the primary video
                    # path: yt-dlp can resolve TikTok short links itself.
                    print(f"Short-link preflight failed; using yt-dlp directly: {exc}")
                    resolved_url = source_url

                if is_tiktok_photo_url(resolved_url):
                    live_album = None
                    try:
                        live_album = download_tiktok_live_photo_album(resolved_url, folder / "live_album")
                        if live_album is not None:
                            validate_live_photo_album(live_album)
                    except Exception as exc:
                        # TikWM is an optional enhancement. Keep the existing
                        # gallery-dl path as a safe fallback for all failures,
                        # including Telegram's native Live Photo size/duration limits.
                        print(f"TikWM Live Photo extraction unavailable; falling back to still photos: {exc}")
                        live_album = None
                    photos = live_album if live_album is not None else download_tiktok_photos(resolved_url, folder)
                    saved_offset = int(job.get("album_next_offset") or 0)
                    publish_photos(
                        photos,
                        make_caption(caption, author),
                        before_send=mark_delivery_started,
                        start_offset=saved_offset,
                        before_batch=lambda offset, total: api(
                            "/api/photo-batch-start",
                            {"id": job_id, "offset": offset, "total_count": total},
                        ),
                        after_batch=lambda next_offset: api(
                            "/api/photo-progress",
                            {"id": job_id, "next_offset": next_offset},
                        ),
                    )
                    print(f"Published TikTok photo carousel #{job_id} ({len(photos)} slides)")
                else:
                    started = time.monotonic()
                    path, metadata = download_tiktok(resolved_url, folder)
                    print(f"[timing] job #{job_id} TikTok download: {time.monotonic() - started:.2f}s; bytes={path.stat().st_size}")
                    author = str(metadata.get("uploader") or metadata.get("creator") or author)
                    caption = caption or str(metadata.get("description") or metadata.get("title") or "")
                    final_caption = make_caption(caption, author)
                    started = time.monotonic()
                    publish(path, final_caption, before_send=mark_delivery_started)
                    print(f"[timing] job #{job_id} Telegram video upload: {time.monotonic() - started:.2f}s; bytes={path.stat().st_size}")
                    print(f"Published video #{job_id}")
                    # Defer optional MP3 until the video job is durably completed.
                    audio_title = caption.strip() or str(metadata.get("title") or "TikTok audio")
                    audio_task = {"kind": "tiktok_url", "source_url": source_url, "title": audio_title}
            elif job["kind"] == "telegram_file":
                path = folder / f"telegram_{job_id}.mp4"
                started = time.monotonic()
                telegram_file(job["telegram_file_id"], path)
                print(f"[timing] job #{job_id} Telegram source download: {time.monotonic() - started:.2f}s; bytes={path.stat().st_size}")
                started = time.monotonic()
                publish(path, make_caption(caption, author), before_send=mark_delivery_started)
                print(f"[timing] job #{job_id} Telegram channel upload: {time.monotonic() - started:.2f}s; bytes={path.stat().st_size}")
                # Defer optional MP3 until the video job is durably completed.
                audio_task = {"kind": "telegram_file", "telegram_file_id": job["telegram_file_id"], "title": caption.strip() or f"Telegram video {job_id}"}
            else:
                raise RuntimeError(f"Unsupported job type: {job['kind']}")

            # Complete the video and persist its optional audio task in one
            # Worker-side D1 transaction, so a crash cannot lose the MP3 job.
            completion = {"id": job_id}
            if audio_task:
                completion["audio_task"] = audio_task
            started = time.monotonic()
            api("/api/complete", completion)
            print(f"[timing] job #{job_id} queue completion: {time.monotonic() - started:.2f}s")
            if audio_task:
                print(f"Queued optional MP3 extraction for video #{job_id}")
        print(f"[timing] job #{job_id} total: {time.monotonic() - job_started:.2f}s")
        return True
    except Exception as exc:
        print(f"[timing] job #{job_id} failed after {time.monotonic() - job_started:.2f}s")
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
