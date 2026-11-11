import subprocess
from pathlib import Path
from urllib.parse import urlparse

import requests


PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".avif"}


def resolve_tiktok_url(url: str) -> str:
    """Resolve TikTok short links without downloading the response body."""
    if urlparse(url).path.startswith("/photo/") or urlparse(url).path.startswith("/video/"):
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
    return urlparse(url).path.startswith("/photo/")


def download_tiktok_photos(url: str, target_dir: Path) -> list[Path]:
    """Download every image from a public TikTok Photo Mode post in slide order."""
    target_dir.mkdir(parents=True, exist_ok=True)
    command = [
        "gallery-dl",
        "--config-ignore",
        "--no-input",
        "--quiet",
        "--directory", str(target_dir),
        "--filename", "{num:>03}.{extension}",
        "-o", "extractor.tiktok.audio=false",
        "-o", "extractor.tiktok.videos=false",
        url,
    ]
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout or "gallery-dl failed").strip()
        raise RuntimeError(f"TikTok photo download failed: {detail[-700:]}")
    photos = [
        path for path in target_dir.iterdir()
        if path.is_file() and path.suffix.lower() in PHOTO_EXTENSIONS
    ]
    photos.sort(key=lambda path: (int(path.stem) if path.stem.isdigit() else 10**9, path.name))
    if not photos:
        raise RuntimeError("TikTok Photo Mode returned no images")
    return photos
