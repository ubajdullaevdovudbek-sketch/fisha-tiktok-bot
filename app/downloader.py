from pathlib import Path
import yt_dlp


def download_tiktok(url: str, target_dir: Path, max_mb: int) -> tuple[Path, dict]:
    target_dir.mkdir(parents=True, exist_ok=True)
    opts = {
        "outtmpl": str(target_dir / "%(id)s.%(ext)s"),
        "format": "mp4/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "max_filesize": max_mb * 1024 * 1024,
        "quiet": True,
        "no_warnings": True,
        "extractor_args": {"tiktok": {"webpage_download": ["true"]}},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        path = Path(ydl.prepare_filename(info))
        if not path.exists():
            mp4 = path.with_suffix(".mp4")
            if mp4.exists():
                path = mp4
        if not path.exists():
            candidates = sorted(target_dir.glob(f"{info.get('id', '*')}.*"), key=lambda p: p.stat().st_mtime, reverse=True)
            if not candidates:
                raise FileNotFoundError("Downloaded file was not found")
            path = candidates[0]
        return path, info
