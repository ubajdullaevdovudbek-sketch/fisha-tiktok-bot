import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

import requests


PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".avif"}
MAX_DOWNLOAD_ATTEMPTS = 3
PERMANENT_ERROR_MARKERS = (
    "private", "deleted", "not found", "unavailable", "login",
    "unauthorized", "forbidden", "http error 401", "http error 403",
    "http error 404", "status code 401", "status code 403", "status code 404",
)


class TikTokPhotoDownloadError(RuntimeError):
    """A TikTok Photo Mode download failed with a user-actionable explanation."""



def resolve_tiktok_url(url: str) -> str:
    """Resolve TikTok short links without downloading the response body."""
    if "/photo/" in urlparse(url).path or "/video/" in urlparse(url).path:
        return url
    if urlparse(url).hostname not in {"vt.tiktok.com", "vm.tiktok.com", "tiktok.com", "www.tiktok.com"}:
        return url
    response = requests.get(url, allow_redirects=True, stream=True, timeout=(10, 20))
    try:
        response.raise_for_status()
        return response.url
    finally:
        response.close()


def is_tiktok_photo_url(url: str) -> bool:
    return "/photo/" in urlparse(url).path


def download_tiktok_photos(url: str, target_dir: Path) -> list[Path]:
    """Download every image from a public TikTok Photo Mode post in slide order."""
    target_dir.mkdir(parents=True, exist_ok=True)
    command = [
        "gallery-dl",
        "--config-ignore",
        "--no-input",
        "--quiet",
        "--directory", str(target_dir),
        "--filename", "{num:03}.{extension}",
        "-o", "extractor.tiktok.photos=true",
        "-o", "extractor.tiktok.covers=false",
        "-o", "extractor.tiktok.audio=false",
        "-o", "extractor.tiktok.videos=false",
        url,
    ]
    last_error = "gallery-dl failed"
    for attempt in range(1, MAX_DOWNLOAD_ATTEMPTS + 1):
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=180,
                check=False,
            )
        except subprocess.TimeoutExpired:
            last_error = "download timed out after 180 seconds"
        else:
            if result.returncode == 0:
                break
            detail = (result.stderr or result.stdout or "gallery-dl failed").strip()
            last_error = detail[-700:]
            lowered = last_error.lower()
            if any(marker in lowered for marker in PERMANENT_ERROR_MARKERS):
                raise TikTokPhotoDownloadError(
                    f"TikTok post is private, deleted, unavailable, or requires login: {last_error}"
                )
        if attempt < MAX_DOWNLOAD_ATTEMPTS:
            # Retry transient network/rate-limit/server failures; do not retry
            # known permanent access errors such as private or deleted posts.
            time.sleep(attempt)
    else:
        raise TikTokPhotoDownloadError(
            f"TikTok photo download failed after {MAX_DOWNLOAD_ATTEMPTS} attempts: {last_error}"
        )
    photos = [
        path for path in target_dir.iterdir()
        if path.is_file() and path.suffix.lower() in PHOTO_EXTENSIONS
    ]
    photos.sort(key=lambda path: (int(path.stem) if path.stem.isdigit() else 10**9, path.name))
    if not photos:
        raise TikTokPhotoDownloadError("TikTok Photo Mode returned no images; the post may be unavailable or contain no downloadable slides")
    return photos
