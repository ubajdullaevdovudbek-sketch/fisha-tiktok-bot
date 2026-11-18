"""TikTok Photo Mode downloader with Live Photo motion clips via TikWM.

Returns a mixed, slide-ordered album only when TikWM exposes a complete
parallel images/live_images pair. Otherwise callers should use gallery-dl.
"""
from pathlib import Path
from urllib.parse import urlparse

import requests


TIKWM_API = "https://www.tikwm.com/api/"
CDN_SUFFIXES = ("tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokcdn-alisg.com")
REQUEST_TIMEOUT = (10, 45)


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


def _download(url: str, target: Path) -> None:
    with requests.get(url, stream=True, timeout=REQUEST_TIMEOUT) as response:
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
        if target.suffix == ".mp4" and content_type and content_type not in {
            "video/mp4", "application/octet-stream", "binary/octet-stream"
        }:
            raise TikTokLivePhotoError(f"Expected MP4 motion clip, received {content_type}")
        if target.suffix != ".mp4" and content_type and not content_type.startswith("image/"):
            raise TikTokLivePhotoError(f"Expected image slide, received {content_type}")
        with target.open("wb") as output:
            for chunk in response.iter_content(1024 * 256):
                if chunk:
                    output.write(chunk)
    if not target.exists() or target.stat().st_size == 0:
        raise TikTokLivePhotoError("TikWM returned an empty media file")


def download_tiktok_live_photo_album(url: str, target_dir: Path) -> list[tuple[str, Path]] | None:
    """Download a mixed Live Photo album; return None when the post has no motion data.

    Each result is (media_type, path), where media_type is 'photo' or 'video'.
    A complete index-aligned live_images array is required to avoid pairing a
    motion clip with the wrong still image. Any failure is raised so the caller
    can safely fall back to the existing gallery-dl photo-only path.
    """
    try:
        response = requests.post(
            TIKWM_API,
            data={"url": url, "hd": "1"},
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "Mozilla/5.0",
            },
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise TikTokLivePhotoError(f"TikWM request failed: {exc}") from exc

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
    album: list[tuple[str, Path]] = []
    for index, image_url in enumerate(images):
        motion_url = live_images[index]
        if motion_url:
            media_url = _trusted_media_url(motion_url)
            if not media_url:
                raise TikTokLivePhotoError(f"Untrusted Live Photo URL at slide {index + 1}")
            media_type, suffix = "video", ".mp4"
        else:
            media_url = _trusted_media_url(image_url)
            if not media_url:
                raise TikTokLivePhotoError(f"Untrusted image URL at slide {index + 1}")
            media_type, suffix = "photo", ".jpg"

        path = target_dir / f"slide_{index + 1:03d}{suffix}"
        _download(media_url, path)
        album.append((media_type, path))

    return album
