import subprocess
from pathlib import Path


def extract_audio_mp3(video_path: Path, output_path: Path) -> Path:
    """Extract the complete audio track from a video into a 128 kbps MP3."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", str(video_path),
        "-map", "0:a:0",
        "-vn",
        "-codec:a", "libmp3lame",
        "-b:a", "128k",
        "-y", str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False)
    if result.returncode:
        detail = (result.stderr or result.stdout or "ffmpeg failed").strip()
        raise RuntimeError(f"MP3 extraction failed: {detail[-500:]}")
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError("MP3 extraction produced an empty file")
    return output_path
