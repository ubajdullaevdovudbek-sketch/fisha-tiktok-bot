import os
import tempfile
from pathlib import Path
from urllib.parse import urljoin

import requests
import yt_dlp

from app.audio import extract_audio_mp3


API_URL = os.environ["WORKER_API_URL"].rstrip("/")
API_SECRET = os.environ["WORKER_API_SECRET"]
BOT_TOKEN = os.environ["BOT_TOKEN"]
CHANNEL_ID = os.environ["CHANNEL_ID"]
MAX_AUDIO_JOBS = max(1, min(10, int(os.getenv("MAX_AUDIO_JOBS_PER_RUN", "3"))))


def api(path, payload=None):
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


def download_telegram_file(file_id, target):
    info = requests.get(
        f"https://api.telegram.org/bot{BOT_TOKEN}/getFile",
        params={"file_id": file_id},
        timeout=30,
    )
    info.raise_for_status()
    data = info.json()
    if not data.get("ok"):
        raise RuntimeError("Telegram getFile failed")
    file_url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{data['result']['file_path']}"
    with requests.get(file_url, stream=True, timeout=120) as response:
        response.raise_for_status()
        with target.open("wb") as output:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    output.write(chunk)


def download_video(job, folder):
    target = folder / "source.mp4"
    if job["kind"] == "telegram_file":
        download_telegram_file(job["telegram_file_id"], target)
        return target
    options = {
        "outtmpl": str(target),
        "format": "best[ext=mp4]/best",
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "extractor_retries": 2,
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(job["source_url"], download=True)
        path = Path(ydl.prepare_filename(info))
        if path.exists():
            return path
        mp4_path = path.with_suffix(".mp4")
        if mp4_path.exists():
            return mp4_path
    raise FileNotFoundError("Downloaded video for audio extraction was not found")


def send_audio(path, title, before_send=None):
    if path.stat().st_size > 50 * 1024 * 1024:
        raise RuntimeError("Extracted MP3 exceeds Telegram's 50 MB audio limit")
    if before_send:
        before_send()
    with path.open("rb") as audio:
        response = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendAudio",
            data={"chat_id": CHANNEL_ID, "title": title[:64] or "TikTok audio", "performer": "TikTok"},
            files={"audio": (path.name, audio, "audio/mpeg")},
            timeout=300,
        )
    response.raise_for_status()
    result = response.json()
    if not result.get("ok"):
        raise RuntimeError(result.get("description", "Telegram sendAudio failed"))


def process_one():
    claimed = api("/api/audio/claim")
    if not claimed:
        return False
    job = claimed["job"]
    job_id = int(job["id"])
    try:
        with tempfile.TemporaryDirectory(prefix="fisha-audio-") as tmp:
            folder = Path(tmp)
            video = download_video(job, folder)
            mp3 = extract_audio_mp3(video, folder / "audio.mp3")
            api("/api/audio/started", {"id": job_id})
            send_audio(mp3, job.get("title") or "TikTok audio")
        api("/api/audio/complete", {"id": job_id})
        print(f"Completed audio job #{job_id}")
    except Exception as exc:
        print(f"Audio job #{job_id} failed: {exc}")
        try:
            api("/api/audio/fail", {"id": job_id, "error": str(exc)[:500]})
        except Exception as api_error:
            print(f"Could not mark audio job #{job_id} failed: {api_error}")
    return True


def main():
    attempted = 0
    while attempted < MAX_AUDIO_JOBS and process_one():
        attempted += 1
    print(f"Audio run finished. Attempted {attempted} job(s); limit={MAX_AUDIO_JOBS}.")


if __name__ == "__main__":
    main()
