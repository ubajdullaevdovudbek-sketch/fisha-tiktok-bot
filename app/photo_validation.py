from pathlib import Path


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
