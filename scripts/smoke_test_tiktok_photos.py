import sys
from pathlib import Path

from app.tiktok_photos import download_tiktok_photos, is_tiktok_photo_url, resolve_tiktok_url
from app.photo_validation import validate_telegram_photo


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python scripts/smoke_test_tiktok_photos.py <TikTok photo URL>", file=sys.stderr)
        return 2

    source_url = sys.argv[1].strip()
    resolved_url = resolve_tiktok_url(source_url)
    if not is_tiktok_photo_url(resolved_url):
        raise SystemExit(f"URL did not resolve to a TikTok Photo Mode post: {resolved_url}")

    output_dir = Path("smoke-test-output")
    photos = download_tiktok_photos(resolved_url, output_dir)

    print(f"Resolved URL: {resolved_url}")
    print(f"Downloaded photos: {len(photos)}")
    for index, photo in enumerate(photos, start=1):
        size = photo.stat().st_size
        try:
            validate_telegram_photo(photo)
        except RuntimeError as exc:
            raise SystemExit(f"Downloaded image failed Telegram preflight: {exc}") from exc
        print(f"{index:03}: {photo.name} ({size} bytes; Telegram preflight passed)")
    print(f"PASS: images downloaded locally to {output_dir}; nothing was sent to Telegram.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
