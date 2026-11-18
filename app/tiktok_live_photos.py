"""TikTok Photo Mode downloader with ordered video/photo slides."""
from pathlib import Path
from urllib.parse import urlparse

import requests


TIKWM_API = "https://www.tikwm.com/api/"
CDN_SUFFIXES = ("tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokcdn-alisg.com")
REQUEST_TIMEOUT = (10, 45)
MAX_LIVE_VIDEO_BYTES = 48 * 1024 * 1024


class TikTokLivePhotoError(RuntimeError):
    """TikWM could not provide a safe, complete Live Photo album."""


def _trusted_media_url(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not any(host == suffix or host.endswith("." + suffix) for suffix in CDN_SUFFIXES):
        return None
    return value


def _download(url: str, target: Path, expected: str) -> None:
    last_error = None
    for attempt in range(3):
        try:
            with requests.get(url, stream=True, timeout=REQUEST_TIMEOUT, headers={"User-Agent": "Mozilla/5.0"}) as response:
                response.raise_for_status()
                content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
                if expected == "video" and content_type and content_type not in {
                    "video/mp4", "application/octet-stream", "binary/octet-stream"
                }:
                    raise TikTokLivePhotoError(f"Expected MP4 motion clip, received {content_type}")
                if expected == "photo" and content_type and not content_type.startswith("image/"):
                    raise TikTokLivePhotoError(f"Expected image slide, received {content_type}")
                total = 0
                with target.open("wb") as output:
                    for chunk in response.iter_content(1024 * 256):
                        if chunk:
                            total += len(chunk)
                            if target.suffix == ".mp4" and total > MAX_LIVE_VIDEO_BYTES:
                                raise TikTokLivePhotoError("Live Photo MP4 exceeds Telegram's safe 48 MB upload limit")
                            output.write(chunk)
            if not target.exists() or target.stat().st_size == 0:
                raise TikTokLivePhotoError("TikWM returned an empty media file")
            return
        except requests.RequestException as exc:
            last_error = exc
            target.unlink(missing_ok=True)
            if attempt == 2:
                break
            import time
            time.sleep(1.5 * (attempt + 1))
    raise TikTokLivePhotoError(f"Media download failed after 3 attempts: {last_error}")


def download_tiktok_live_photo_album(url: str, target_dir: Path) -> list[tuple[str, object]] | None:
    """Return ordered ('photo', Path) or ('video', Path) slides.

    A complete index-aligned live_images array is required to avoid pairing a
    motion clip with the wrong still. Return None when no Live Photo data exists;
    callers can then use the existing gallery-dl photo-only path.
    """
    payload = None
    last_error = None
    for attempt in range(3):
        try:
            response = requests.post(
                TIKWM_API,
                data={"url": url, "hd": "1"},
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "Mozilla/5.0",
                    "Accept": "application/json, text/plain, */*",
                },
                timeout=REQUEST_TIMEOUT,
            )
            response.raise_for_status()
            payload = response.json()
            break
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            if attempt == 2:
                break
            import time
            time.sleep(1.5 * (attempt + 1))
    if payload is None:
        raise TikTokLivePhotoError(f"TikWM request failed after 3 attempts: {last_error}") from last_error

    data = payload.get("data") if isinstance(payload, dict) and payload.get("code") == 0 else None
    if not isinstance(data, dict):
        message = payload.get("msg", "TikWM did not return usable data") if isinstance(payload, dict) else "Invalid TikWM response"
        raise TikTokLivePhotoError(str(message))

    images = data.get("images")
    live_images = data.get("live_images")
    if not isinstance(images, list) or not images:
        raise TikTokLivePhotoError("TikWM response contains no photo slides")
    if not isinstance(live_images, list) or not live_images:
        return None
    if len(live_images) != len(images):
        raise TikTokLivePhotoError(
            f"Live Photo alignment mismatch: {len(images)} images, {len(live_images)} motion clips"
        )

    target_dir.mkdir(parents=True, exist_ok=True)
    album: list[tuple[str, object]] = []
    for index, image_url in enumerate(images):
        still_url = _trusted_media_url(image_url)
        if not still_url:
            raise TikTokLivePhotoError(f"Untrusted image URL at slide {index + 1}")
        still_path = target_dir / f"slide_{index + 1:03d}.jpg"
        _download(still_url, still_path, "photo")

        motion_url = live_images[index]
        if motion_url:
            motion_url = _trusted_media_url(motion_url)
            motion_path = target_dir / f"slide_{index + 1:03d}.mp4"
            if motion_url:
                try:
                    _download(motion_url, motion_path, "video")
                    album.append(("video", motion_path))
                    continue
                except TikTokLivePhotoError:
                    # Keep the album and its original order if this slide's
                    # motion CDN is temporarily unavailable or returns bad media.
                    motion_path.unlink(missing_ok=True)
        album.append(("photo", still_path))

    return album
