from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
JOBS_DIR = DATA_DIR / "jobs"
DB_PATH = DATA_DIR / "queue.sqlite3"
TOKEN_PATH = DATA_DIR / "access_token.txt"
STATIC_DIR = ROOT / "web"
DEMO_VIDEO_ID = "7ifpw18OCwg"
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
LOCAL_VIDEO_SUFFIXES = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".wmv", ".mpeg", ".mpg"}
MAX_UPLOAD_BYTES = int(os.getenv("CULTURE_MAX_UPLOAD_BYTES", str(20 * 1024 * 1024 * 1024)))

LEVELS = {
    "economy": {"label": "경제형", "model": "gpt-5.6-luna"},
    "culture": {"label": "문화역주", "model": "gpt-5.6-terra"},
    "curator": {"label": "고인물판", "model": "gpt-5.6-sol"},
}

SOURCE_LANGUAGES = {
    "auto": "자동 감지",
    "en": "영어",
    "tr": "튀르키예어",
    "fa": "페르시아어",
    "pt": "포르투갈어(브라질 포함)",
    "es": "스페인어",
    "ar": "아랍어",
    "ja": "일본어",
    "zh": "중국어",
    "ru": "러시아어",
    "fr": "프랑스어",
    "de": "독일어",
    "it": "이탈리아어",
    "hi": "힌디어",
    "id": "인도네시아어",
    "vi": "베트남어",
    "th": "태국어",
}

EXPORT_LOCK = threading.Lock()
EXPORT_THREADS: dict[tuple[str, str], threading.Thread] = {}
DOWNLOAD_TICKETS: dict[str, tuple[Path, float, str, str]] = {}
MEDIA_TICKETS: dict[str, tuple[Path, float, str, str]] = {}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def extract_video_id(value: str) -> str:
    value = value.strip()
    if VIDEO_ID_RE.fullmatch(value):
        return value
    parsed = urlparse(value)
    host = parsed.netloc.lower().split(":")[0]
    candidate = ""
    if host in {"youtu.be", "www.youtu.be"}:
        candidate = parsed.path.strip("/").split("/")[0]
    elif host.endswith("youtube.com"):
        if parsed.path == "/watch":
            candidate = parse_qs(parsed.query).get("v", [""])[0]
        elif parsed.path.startswith(("/shorts/", "/embed/", "/live/")):
            parts = parsed.path.strip("/").split("/")
            candidate = parts[1] if len(parts) > 1 else ""
    if not VIDEO_ID_RE.fullmatch(candidate):
        raise ValueError("올바른 YouTube 영상 주소가 아닙니다.")
    return candidate


def canonical_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def init_storage() -> str:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    if not TOKEN_PATH.exists():
        TOKEN_PATH.write_text(secrets.token_urlsafe(24), encoding="utf-8")
    with db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                video_id TEXT NOT NULL,
                url TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                level TEXT NOT NULL,
                status TEXT NOT NULL,
                progress INTEGER NOT NULL DEFAULT 0,
                stage TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_video_id ON jobs(video_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)")
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}
        migrations = {
            "source_type": "ALTER TABLE jobs ADD COLUMN source_type TEXT NOT NULL DEFAULT 'youtube'",
            "source_name": "ALTER TABLE jobs ADD COLUMN source_name TEXT NOT NULL DEFAULT ''",
            "source_file": "ALTER TABLE jobs ADD COLUMN source_file TEXT NOT NULL DEFAULT ''",
            "requested_language": "ALTER TABLE jobs ADD COLUMN requested_language TEXT NOT NULL DEFAULT 'auto'",
            "detected_language": "ALTER TABLE jobs ADD COLUMN detected_language TEXT NOT NULL DEFAULT ''",
            "playlist": "ALTER TABLE jobs ADD COLUMN playlist TEXT NOT NULL DEFAULT '기본 재생목록'",
            "hidden": "ALTER TABLE jobs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
        }
        for name, statement in migrations.items():
            if name not in columns:
                conn.execute(statement)
    seed_demo()
    return TOKEN_PATH.read_text(encoding="utf-8").strip()


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH, timeout=20)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    except Exception:
        conn.rollback()
        raise
    else:
        conn.commit()
    finally:
        conn.close()


def row_to_dict(row: sqlite3.Row) -> dict:
    result = dict(row)
    source_type = result.get("source_type") or "youtube"
    result["source_type"] = source_type
    result["requested_language"] = result.get("requested_language") or "auto"
    result["detected_language"] = result.get("detected_language") or ""
    result["playlist"] = result.get("playlist") or "기본 재생목록"
    result["hidden"] = bool(result.get("hidden", 0))
    result["requested_language_label"] = SOURCE_LANGUAGES.get(result["requested_language"], result["requested_language"])
    result["detected_language_label"] = SOURCE_LANGUAGES.get(result["detected_language"], result["detected_language"])
    result["watch_url"] = (
        f"/app/?focus={result['id']}" if source_type == "local"
        else f"/app/watch.html?v={result['video_id']}"
    )
    result["youtube_url"] = canonical_url(result["video_id"]) if source_type == "youtube" else ""
    result["has_subtitle"] = (JOBS_DIR / result["id"] / "culture.srt").exists()
    result["has_media"] = source_type == "local" and local_source_path(result).is_file()
    return result


def get_job(job_id: str) -> dict | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return row_to_dict(row) if row else None


def get_latest_job_for_video(video_id: str) -> dict | None:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE video_id = ? ORDER BY created_at DESC LIMIT 1",
            (video_id,),
        ).fetchone()
    return row_to_dict(row) if row else None


def list_jobs() -> list[dict]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100").fetchall()
    return [row_to_dict(row) for row in rows]


def update_job(job_id: str, **values: object) -> None:
    values["updated_at"] = utc_now()
    columns = ", ".join(f"{key} = ?" for key in values)
    with db() as conn:
        conn.execute(
            f"UPDATE jobs SET {columns} WHERE id = ?",
            (*values.values(), job_id),
        )


def organize_job(job_id: str, payload: dict) -> dict:
    """Update only user-facing library organization fields for one job."""
    job = get_job(job_id)
    if not job:
        raise FileNotFoundError("작업을 찾을 수 없습니다.")
    values: dict[str, object] = {}
    if "hidden" in payload:
        if not isinstance(payload["hidden"], bool):
            raise ValueError("숨김 값이 올바르지 않습니다.")
        values["hidden"] = int(payload["hidden"])
    if "playlist" in payload:
        playlist = re.sub(r"\s+", " ", str(payload["playlist"])).strip()
        if not playlist:
            raise ValueError("재생목록 이름을 입력하세요.")
        if len(playlist) > 40:
            raise ValueError("재생목록 이름은 40자 이내로 입력하세요.")
        values["playlist"] = playlist
    if not values:
        raise ValueError("변경할 항목이 없습니다.")
    update_job(job_id, **values)
    return get_job(job_id)  # type: ignore[return-value]


def delete_job(job_id: str) -> dict:
    """Delete one idle job and its generated files without crossing the job directory boundary."""
    job = get_job(job_id)
    if not job:
        raise FileNotFoundError("작업을 찾을 수 없습니다.")
    if job["status"] not in {"queued", "completed", "failed"}:
        raise RuntimeError("작업 중인 영상은 완료되거나 실패한 뒤 삭제할 수 있습니다.")

    with EXPORT_LOCK:
        if any(key[0] == job_id and thread.is_alive() for key, thread in EXPORT_THREADS.items()):
            raise RuntimeError("내보내기 중인 작업은 완료된 뒤 삭제할 수 있습니다.")

    job_dir = JOBS_DIR / job_id
    deleting_root = DATA_DIR / ".deleting"
    quarantine = deleting_root / f"{job_id}-{uuid.uuid4().hex}"
    moved = False
    try:
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT status FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                raise FileNotFoundError("작업을 찾을 수 없습니다.")
            if row["status"] not in {"queued", "completed", "failed"}:
                raise RuntimeError("작업 중인 영상은 완료되거나 실패한 뒤 삭제할 수 있습니다.")
            if job_dir.exists():
                deleting_root.mkdir(parents=True, exist_ok=True)
                job_dir.replace(quarantine)
                moved = True
            conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
    except Exception:
        if moved and quarantine.exists() and not job_dir.exists():
            quarantine.replace(job_dir)
        raise

    with EXPORT_LOCK:
        for ticket, data in list(MEDIA_TICKETS.items()):
            if data[2] == job_id:
                MEDIA_TICKETS.pop(ticket, None)
        resolved_job_dir = job_dir.resolve()
        for ticket, data in list(DOWNLOAD_TICKETS.items()):
            try:
                belongs_to_job = data[0].resolve().is_relative_to(resolved_job_dir)
            except (OSError, ValueError):
                belongs_to_job = False
            if belongs_to_job:
                DOWNLOAD_TICKETS.pop(ticket, None)
    if moved:
        shutil.rmtree(quarantine, ignore_errors=False)
        if deleting_root.exists() and not any(deleting_root.iterdir()):
            deleting_root.rmdir()
    return job


def normalize_language(value: str) -> str:
    language = (value or "auto").strip().lower()
    if language not in SOURCE_LANGUAGES:
        raise ValueError("지원하지 않는 원문 언어입니다.")
    return language


def normalize_language_hint(value: object) -> str:
    """Reduce media metadata such as pt-BR to a supported Whisper language code."""
    raw = str(value or "").strip().lower().replace("_", "-")
    if not raw:
        return ""
    aliases = {
        "eng": "en",
        "por": "pt",
        "spa": "es",
        "tur": "tr",
        "fas": "fa",
        "per": "fa",
        "jpn": "ja",
        "zho": "zh",
        "chi": "zh",
    }
    language = aliases.get(raw, raw.split("-", 1)[0])
    return language if language in SOURCE_LANGUAGES and language != "auto" else ""


def transcript_quality_issues(transcript: dict) -> list[str]:
    """Return reasons a Whisper transcript is too repetitive to translate safely."""
    texts = [
        str(segment.get("text", "")).strip()
        for segment in transcript.get("segments", [])
        if str(segment.get("text", "")).strip()
    ]
    if not texts:
        return ["발화 구간이 없습니다"]

    normalized = [re.sub(r"[^\w]+", " ", text.casefold(), flags=re.UNICODE).strip() for text in texts]
    normalized = [text for text in normalized if text]
    if not normalized:
        return ["내용이 있는 발화를 찾지 못했습니다"]

    counts = Counter(normalized)
    dominant_text, dominant_count = counts.most_common(1)[0]
    dominant_ratio = dominant_count / len(normalized)
    unique_ratio = len(counts) / len(normalized)
    issues: list[str] = []
    if len(normalized) >= 12 and dominant_count >= 8 and dominant_ratio >= 0.25:
        preview = dominant_text[:40]
        issues.append(f"같은 문구가 {dominant_count}/{len(normalized)}회 반복됩니다: {preview}")
    if len(normalized) >= 20 and len(counts) <= 5 and unique_ratio < 0.18:
        issues.append(f"고유 문구가 {len(counts)}/{len(normalized)}개뿐입니다")
    return issues


def validate_transcript_quality(transcript: dict) -> None:
    issues = transcript_quality_issues(transcript)
    if issues:
        raise ValueError("전사 품질 실패: " + "; ".join(issues))


def create_job(url: str, level: str, language: str = "auto") -> dict:
    video_id = extract_video_id(url)
    if level not in LEVELS:
        raise ValueError("지원하지 않는 자막 유형입니다.")
    language = normalize_language(language)
    existing = get_latest_job_for_video(video_id)
    if (
        existing
        and existing["status"] in {"queued", "downloading", "translating", "completed"}
        and existing.get("requested_language", "auto") == language
    ):
        return existing
    job_id = str(uuid.uuid4())
    now = utc_now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO jobs (id, video_id, url, level, status, progress, stage, created_at, updated_at, requested_language)
            VALUES (?, ?, ?, ?, 'queued', 0, '대기 중', ?, ?, ?)
            """,
            (job_id, video_id, canonical_url(video_id), level, now, now, language),
        )
    (JOBS_DIR / job_id).mkdir(parents=True, exist_ok=True)
    return get_job(job_id)  # type: ignore[return-value]


def safe_local_filename(value: str) -> str:
    name = Path(value.replace("\\", "/")).name.strip().strip(".")
    name = re.sub(r"[\x00-\x1f<>:\"/\\|?*]", "_", name)
    suffix = Path(name).suffix.lower()
    if not name or suffix not in LOCAL_VIDEO_SUFFIXES:
        raise ValueError("MP4·MOV·WebM·MKV·AVI 등 일반 영상 파일을 선택하세요.")
    stem = Path(name).stem[:120].strip() or "local-video"
    return f"{stem}{suffix}"


def local_source_path(job: dict) -> Path:
    job_dir = (JOBS_DIR / str(job["id"])).resolve()
    filename = Path(str(job.get("source_file") or "")).name
    candidate = (job_dir / filename).resolve()
    if not filename or candidate.parent != job_dir:
        return job_dir / "__missing_local_video__"
    return candidate


def local_playback_path(job: dict) -> Path:
    converted = JOBS_DIR / str(job["id"]) / "playback.mp4"
    return converted if converted.is_file() else local_source_path(job)


def prepare_local_playback(job: dict) -> None:
    original = local_source_path(job)
    if original.suffix.lower() in {".mp4", ".m4v", ".webm"}:
        return
    target = JOBS_DIR / str(job["id"]) / "playback.mp4"
    if target.is_file():
        return
    update_job(job["id"], stage="작업실 재생본 준비 중", progress=86)
    run_process(
        [
            "ffmpeg", "-y", "-i", str(original), "-map", "0:v:0", "-map", "0:a?",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(target),
        ],
        target.parent,
        timeout=7200,
    )


def create_local_job(filename: str, level: str, language: str = "auto") -> tuple[dict, Path]:
    if level not in LEVELS:
        raise ValueError("지원하지 않는 자막 유형입니다.")
    language = normalize_language(language)
    safe_name = safe_local_filename(filename)
    job_id = str(uuid.uuid4())
    local_id = f"local-{uuid.uuid4().hex[:16]}"
    stored_name = f"source{Path(safe_name).suffix.lower()}"
    now = utc_now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO jobs
            (id, video_id, url, title, level, status, progress, stage, created_at, updated_at,
             source_type, source_name, source_file, requested_language)
            VALUES (?, ?, '', ?, ?, 'uploading', 0, '파일 올리는 중', ?, ?, 'local', ?, ?, ?)
            """,
            (job_id, local_id, Path(safe_name).stem, level, now, now, safe_name, stored_name, language),
        )
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    job = get_job(job_id)
    if not job:
        raise RuntimeError("로컬 영상 작업을 만들지 못했습니다.")
    return job, job_dir / stored_name


def seed_demo() -> None:
    if get_latest_job_for_video(DEMO_VIDEO_ID):
        return
    source = ROOT.parent / "CAN I BEAT AUSTIN'S BEST BURGER [7ifpw18OCwg].ko-culture.srt"
    if not source.exists():
        return
    job_id = "demo-7ifpw18OCwg"
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, job_dir / "culture.srt")
    now = utc_now()
    with db() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO jobs
            (id, video_id, url, title, level, status, progress, stage, created_at, updated_at, completed_at)
            VALUES (?, ?, ?, ?, 'culture', 'completed', 100, '감상 가능', ?, ?, ?)
            """,
            (
                job_id,
                DEMO_VIDEO_ID,
                canonical_url(DEMO_VIDEO_ID),
                "CAN I BEAT AUSTIN'S BEST BURGER?",
                now,
                now,
                now,
            ),
        )


def run_process(args: list[str], cwd: Path, stdin: str | None = None, timeout: int = 1800) -> str:
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    completed = subprocess.run(
        args,
        cwd=cwd,
        input=stdin,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        creationflags=creationflags,
        check=False,
    )
    if completed.returncode != 0:
        tail = completed.stdout[-3000:].strip()
        raise RuntimeError(tail or f"명령 실행 실패: {args[0]}")
    return completed.stdout


def write_translation_prompt(job_dir: Path, title: str, level: str) -> str:
    note_density = {
        "economy": "문화역주는 꼭 이해가 막히는 곳에만 2~4개 넣는다.",
        "culture": "문화역주는 꼭 필요한 지점에 4~10개 넣는다.",
        "curator": "문화역주는 8~16개까지 허용하되 대사와 경쟁하지 않게 한다.",
    }[level]
    prompt = f"""당신은 2000년대 한국 팬자막 전성기의 숙련된 영상 번역가다.

작업 폴더의 source.en.srt를 읽고 한국어 문화역주 자막을 만들어라.
영상 제목: {title}
자막 유형: {LEVELS[level]['label']}

필수 기준:
- 겹치고 잘게 쪼개진 YouTube 자동자막을 자연스러운 단위로 합친다.
- 원문의 말투, 욕설, 비꼼, 성적 농담과 캐릭터성을 보존한다.
- 직역보다 한국 시청자가 같은 타이밍에 같은 감정을 느끼는 번역을 우선한다.
- 문화권, 지역, 계층, 밈, 음식명, 말장난 때문에 이해가 막히는 곳에는 '※ 역주:'를 단다.
- {note_density}
- 역주는 최대 두 줄이며, 가능하면 대사가 뜸한 구간에 둔다.
- 고유명사나 불확실한 발화는 지어내지 않는다.
- 모든 타임코드는 오름차순이어야 하고 서로 겹치지 않아야 한다.
- 한 줄은 가급적 24자 이내, 한 자막은 최대 두 줄이다.
- 검열음이 있는 욕설은 씨X, 존X처럼 일부 가린다.

결과는 JSON 스키마에 맞춰 반환한다. srt 필드는 완전한 SRT 본문이어야 한다.
"""
    (job_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
    return prompt


def transcribe_with_whisper(
    job: dict, job_dir: Path, metadata_language: str = ""
) -> tuple[list[dict], str]:
    """Create stable speech segments locally so the LLM never invents subtitle timing."""
    job_id = job["id"]
    if not shutil.which("whisper"):
        raise RuntimeError("Whisper CLI를 찾을 수 없습니다. 정확한 싱크를 위해 설치가 필요합니다.")
    if job.get("source_type") == "local":
        source = local_source_path(job)
        if not source.is_file():
            raise RuntimeError("업로드한 원본 영상을 찾을 수 없습니다.")
        update_job(job_id, stage="로컬 영상에서 음성 꺼내는 중", progress=22)
        run_process(
            [
                "ffmpeg", "-y", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000",
                "-c:a", "pcm_s16le", "source_audio.wav",
            ],
            job_dir,
            timeout=3600,
        )
    else:
        update_job(job_id, stage="원음 내려받는 중", progress=22)
        run_process(
            [
                "yt-dlp", "--no-playlist", "-f", "ba", "-x", "--audio-format", "wav",
                "-o", "source_audio.%(ext)s", job["url"],
            ],
            job_dir,
            timeout=900,
        )
    audio = job_dir / "source_audio.wav"
    if not audio.is_file():
        raise RuntimeError("전사용 음원을 만들지 못했습니다.")
    model = os.getenv("CULTURE_WHISPER_MODEL", "large-v3-turbo")
    update_job(job_id, status="translating", stage="로컬 음성 싱크 잡는 중", progress=34)
    requested_language = normalize_language(str(job.get("requested_language") or "auto"))
    metadata_hint = normalize_language_hint(metadata_language)
    language_hint = requested_language if requested_language != "auto" else metadata_hint
    attempts = [False, True]
    quality_report: list[dict] = []
    transcript: dict = {}
    for attempt_index, conservative in enumerate(attempts, start=1):
        whisper_args = [
            "whisper", str(audio), "--model", model, "--task", "transcribe",
            "--output_dir", str(job_dir), "--output_format", "json", "--verbose", "False",
        ]
        if language_hint:
            whisper_args.extend(["--language", language_hint])
        if conservative:
            whisper_args.extend(["--condition_on_previous_text", "False", "--temperature", "0"])
            update_job(job_id, stage="전사 품질 재검사 중", progress=42)
        run_process(whisper_args, job_dir, timeout=7200)
        transcript_path = job_dir / "source_audio.json"
        transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
        issues = transcript_quality_issues(transcript)
        quality_report.append(
            {
                "attempt": attempt_index,
                "language_hint": language_hint or "auto",
                "conservative": conservative,
                "detected_language": str(transcript.get("language") or ""),
                "issues": issues,
            }
        )
        if not issues:
            break
        shutil.copy2(transcript_path, job_dir / f"source_audio.rejected-{attempt_index}.json")
    (job_dir / "transcription-quality.json").write_text(
        json.dumps(quality_report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    validate_transcript_quality(transcript)
    detected_language = normalize_language_hint(transcript.get("language")) or language_hint
    if detected_language == "auto":
        detected_language = ""
    update_job(job_id, detected_language=detected_language)
    cues = []
    for segment in transcript.get("segments", []):
        text = str(segment.get("text", "")).strip()
        start = round(float(segment.get("start", 0)), 3)
        end = round(float(segment.get("end", 0)), 3)
        if text and end > start:
            cues.append({"id": len(cues) + 1, "start": start, "end": end, "text": text})
    if not cues:
        raise RuntimeError("Whisper 전사에서 발화 구간을 찾지 못했습니다.")
    (job_dir / "aligned_source.json").write_text(
        json.dumps(cues, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return cues, detected_language


def srt_timestamp(seconds: float) -> str:
    millis = max(0, round(seconds * 1000))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def translate_aligned_with_codex(
    job_id: str, job_dir: Path, title: str, level: str, cues: list[dict], source_language: str = ""
) -> None:
    if not shutil.which("codex"):
        raise RuntimeError("Codex CLI를 찾을 수 없습니다. 설치 또는 PATH 설정이 필요합니다.")
    note_density = {
        "economy": "문화역주는 꼭 이해가 막히는 곳에만 2~4개 넣는다.",
        "culture": "문화역주는 꼭 필요한 지점에 4~10개 넣는다.",
        "curator": "문화역주는 8~16개까지 허용하되 대사와 경쟁하지 않게 한다.",
    }[level]
    prompt = f"""당신은 2000년대 한국 팬자막 전성기의 숙련된 영상 번역가다.
aligned_source.json의 모든 발화를 한국어로 번역하고 필요한 문화역주를 작성하라.
영상 제목: {title}
원문 언어: {SOURCE_LANGUAGES.get(source_language, source_language or '자동 감지')}

필수 기준:
- translations는 원본과 정확히 같은 개수이며 id도 정확히 일치해야 한다.
- 시간은 이미 음성에서 확정했으므로 합치거나 나누거나 재배열하지 않는다.
- 원문의 말투, 욕설, 비꼼, 성적 농담과 캐릭터성을 보존한다.
- 문화권, 지역, 계층, 밈, 음식명, 말장난 때문에 이해가 막히는 곳만 notes에 넣는다.
- {note_density}
- 역주는 한 문장, 최대 두 줄 분량으로 쓴다.
- 고유명사나 불확실한 발화는 지어내지 않는다.
- 검열음이 있는 욕설은 씨X, 존X처럼 일부 가린다.
"""
    schema = {
        "type": "object",
        "properties": {
            "translations": {
                "type": "array", "minItems": len(cues), "maxItems": len(cues),
                "items": {
                    "type": "object",
                    "properties": {"id": {"type": "integer"}, "text": {"type": "string"}},
                    "required": ["id", "text"], "additionalProperties": False,
                },
            },
            "notes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"cue_id": {"type": "integer"}, "text": {"type": "string"}},
                    "required": ["cue_id", "text"], "additionalProperties": False,
                },
            },
        },
        "required": ["translations", "notes"], "additionalProperties": False,
    }
    schema_path = job_dir / "aligned.schema.json"
    result_path = job_dir / "aligned_translation.json"
    schema_path.write_text(json.dumps(schema, ensure_ascii=False, indent=2), encoding="utf-8")
    (job_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
    update_job(job_id, stage=f"{LEVELS[level]['label']} 번역 중", progress=62)
    run_process(
        [
            "codex", "exec", "-", "--model", os.getenv("CULTURE_SUB_MODEL", LEVELS[level]["model"]),
            "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
            "--output-schema", str(schema_path), "--output-last-message", str(result_path),
            "--cd", str(job_dir),
        ],
        job_dir,
        stdin=prompt,
        timeout=3600,
    )
    result = json.loads(result_path.read_text(encoding="utf-8-sig"))
    translations = result.get("translations", [])
    expected_ids = [cue["id"] for cue in cues]
    if [item.get("id") for item in translations] != expected_ids:
        raise RuntimeError("번역 자막의 구간 번호가 원문과 일치하지 않습니다.")
    note_map: dict[int, list[str]] = {}
    for note in result.get("notes", []):
        cue_id = int(note.get("cue_id", 0))
        if cue_id in expected_ids and str(note.get("text", "")).strip():
            note_map.setdefault(cue_id, []).append(str(note["text"]).strip())
    blocks = []
    for cue, translated in zip(cues, translations):
        lines = [str(translated.get("text", "")).strip()]
        lines.extend(f"※ 역주: {note}" for note in note_map.get(cue["id"], []))
        blocks.append(
            f"{cue['id']}\n{srt_timestamp(cue['start'])} --> {srt_timestamp(cue['end'])}\n"
            + "\n".join(lines)
        )
    (job_dir / "culture.srt").write_text("\n\n".join(blocks) + "\n", encoding="utf-8")
    (job_dir / "translation-notes.md").write_text(
        "\n".join(f"- {n['cue_id']}번: {n['text']}" for n in result.get("notes", [])) + "\n",
        encoding="utf-8",
    )


def translate_with_codex(job_id: str, job_dir: Path, title: str, level: str) -> None:
    if not shutil.which("codex"):
        raise RuntimeError("Codex CLI를 찾을 수 없습니다. 설치 또는 PATH 설정이 필요합니다.")
    prompt = write_translation_prompt(job_dir, title, level)
    schema = {
        "type": "object",
        "properties": {
            "srt": {"type": "string"},
            "notes": {"type": "string"},
        },
        "required": ["srt", "notes"],
        "additionalProperties": False,
    }
    (job_dir / "result.schema.json").write_text(
        json.dumps(schema, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    model = os.getenv("CULTURE_SUB_MODEL", LEVELS[level]["model"])
    result_path = job_dir / "result.json"
    update_job(job_id, stage=f"{LEVELS[level]['label']} 번역 중", progress=58)
    run_process(
        [
            "codex",
            "exec",
            "-",
            "--model",
            model,
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--ephemeral",
            "--output-schema",
            str(job_dir / "result.schema.json"),
            "--output-last-message",
            str(result_path),
            "--cd",
            str(job_dir),
        ],
        job_dir,
        stdin=prompt,
        timeout=3600,
    )
    raw = result_path.read_text(encoding="utf-8-sig").strip()
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("AI 결과를 JSON으로 읽지 못했습니다.") from exc
    srt = result.get("srt", "").strip()
    if "-->" not in srt:
        raise RuntimeError("AI 결과에 유효한 SRT 자막이 없습니다.")
    (job_dir / "culture.srt").write_text(srt + "\n", encoding="utf-8")
    (job_dir / "translation-notes.md").write_text(
        result.get("notes", "").strip() + "\n", encoding="utf-8"
    )


def process_job(job: dict) -> None:
    job_id = job["id"]
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    try:
        update_job(job_id, status="downloading", stage="영상 정보 확인 중", progress=8, error="")
        metadata_language = ""
        if job.get("source_type") == "local":
            source = local_source_path(job)
            if not source.is_file():
                raise RuntimeError("업로드한 원본 영상을 찾을 수 없습니다.")
            title = job.get("source_name") or source.stem
        else:
            metadata_raw = run_process(
                [
                    "yt-dlp",
                    "--no-playlist",
                    "--skip-download",
                    "--print-json",
                    job["url"],
                ],
                job_dir,
                timeout=180,
            )
            metadata_line = next((line for line in reversed(metadata_raw.splitlines()) if line.startswith("{")), "")
            metadata = json.loads(metadata_line)
            title = metadata.get("title") or job["video_id"]
            metadata_language = normalize_language_hint(metadata.get("language"))
        update_job(job_id, title=title, stage="정확한 음성 싱크 준비 중", progress=18)
        cues, detected_language = transcribe_with_whisper(job, job_dir, metadata_language)
        translate_aligned_with_codex(job_id, job_dir, title, job["level"], cues, detected_language)
        if job.get("source_type") == "local":
            prepare_local_playback(job)
        update_job(job_id, stage="자막 형식 검수 중", progress=92)
        validate_srt((job_dir / "culture.srt").read_text(encoding="utf-8-sig"))
        update_job(
            job_id,
            status="completed",
            stage="감상 가능",
            progress=100,
            completed_at=utc_now(),
        )
    except Exception as exc:
        update_job(job_id, status="failed", stage="작업 실패", error=str(exc)[-2500:], progress=0)
    finally:
        # The extracted WAV is only an intermediate transcription artifact.
        # Keep transcripts and subtitles, but minimize retained source media.
        (job_dir / "source_audio.wav").unlink(missing_ok=True)


def validate_srt(text: str) -> None:
    if "-->" not in text:
        raise ValueError("SRT 타임코드가 없습니다.")
    previous_end = -1
    timing_re = re.compile(
        r"(?P<sh>\d{2}):(?P<sm>\d{2}):(?P<ss>\d{2}),(?P<sms>\d{3})\s+-->\s+"
        r"(?P<eh>\d{2}):(?P<em>\d{2}):(?P<es>\d{2}),(?P<ems>\d{3})"
    )
    matches = list(timing_re.finditer(text))
    if not matches:
        raise ValueError("SRT 타임코드를 해석할 수 없습니다.")
    for match in matches:
        start = (((int(match["sh"]) * 60) + int(match["sm"])) * 60 + int(match["ss"])) * 1000 + int(match["sms"])
        end = (((int(match["eh"]) * 60) + int(match["em"])) * 60 + int(match["es"])) * 1000 + int(match["ems"])
        if end <= start:
            raise ValueError("종료 시간이 시작 시간보다 빠른 자막이 있습니다.")
        if start < previous_end:
            raise ValueError("서로 겹치는 자막 타임코드가 있습니다.")
        previous_end = end


def export_state_path(job_id: str) -> Path:
    return JOBS_DIR / job_id / "exports" / "state.json"


def read_export_state(job_id: str) -> dict:
    path = export_state_path(job_id)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def write_export_state(job_id: str, state: dict) -> None:
    path = export_state_path(job_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def export_file(job_id: str, mode: str) -> Path:
    suffix = "culture-subtitled.mp4" if mode == "mp4" else "video-and-srt.zip"
    return JOBS_DIR / job_id / "exports" / suffix


def prepare_export_source(job: dict, export_dir: Path) -> Path:
    source = export_dir / "source.mp4"
    if source.exists():
        return source
    if job.get("source_type") == "local":
        original = local_source_path(job)
        if not original.is_file():
            raise RuntimeError("업로드한 원본 영상을 찾을 수 없습니다.")
        playback = JOBS_DIR / str(job["id"]) / "playback.mp4"
        if playback.is_file():
            shutil.copy2(playback, source)
        else:
            run_process(
                [
                    "ffmpeg", "-y", "-i", str(original), "-map", "0:v:0", "-map", "0:a?",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
                    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(source),
                ],
                export_dir,
                timeout=7200,
            )
    else:
        run_process(
            [
                "yt-dlp", "-f", "bv*[height<=720]+ba/b[height<=720]",
                "--merge-output-format", "mp4", "-o", str(export_dir / "source.%(ext)s"),
                job["youtube_url"],
            ],
            export_dir,
            timeout=3600,
        )
    if not source.is_file():
        raise RuntimeError("내보내기용 MP4를 준비하지 못했습니다.")
    return source


def run_export(job_id: str, mode: str) -> None:
    job = get_job(job_id)
    job_dir = JOBS_DIR / job_id
    export_dir = job_dir / "exports"
    state = read_export_state(job_id)
    try:
        if not job:
            raise RuntimeError("작업을 찾을 수 없습니다.")
        export_dir.mkdir(parents=True, exist_ok=True)
        prepare_label = "로컬 영상을 MP4로 준비하는 중" if job.get("source_type") == "local" else "원본 영상 받는 중"
        state[mode] = {"status": "working", "stage": prepare_label, "error": ""}
        write_export_state(job_id, state)
        source = prepare_export_source(job, export_dir)
        subtitle = job_dir / "culture.srt"
        if mode == "mp4":
            state[mode]["stage"] = "자막 입히는 중"
            write_export_state(job_id, state)
            ass = export_dir / "culture.ass"
            run_process([sys.executable, str(ROOT / "make_ass.py"), str(subtitle), str(ass)], export_dir)
            run_process(
                [
                    "ffmpeg", "-y", "-i", str(source), "-vf", "ass=culture.ass",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
                    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
                    str(export_file(job_id, mode)),
                ],
                export_dir,
                timeout=3600,
            )
        else:
            state[mode]["stage"] = "묶는 중"
            write_export_state(job_id, state)
            target = export_file(job_id, mode)
            with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
                stem = safe_download_stem(job)
                archive.write(source, f"{stem}.mp4")
                archive.write(subtitle, f"{stem}.ko-culture.srt")
        state[mode] = {"status": "ready", "stage": "내보내기 준비됨", "error": ""}
    except Exception as exc:
        state[mode] = {"status": "failed", "stage": "내보내기 실패", "error": str(exc)[-1500:]}
    finally:
        write_export_state(job_id, state)
        with EXPORT_LOCK:
            EXPORT_THREADS.pop((job_id, mode), None)


def start_export(job_id: str, mode: str) -> dict:
    if mode not in {"mp4", "mp4_srt"}:
        raise ValueError("지원하지 않는 내보내기 형식입니다.")
    job = get_job(job_id)
    subtitle = JOBS_DIR / job_id / "culture.srt"
    if not job or job["status"] != "completed" or not subtitle.exists():
        raise ValueError("완료된 문화자막 작업만 내보낼 수 있습니다.")
    target = export_file(job_id, mode)
    if target.exists():
        state = read_export_state(job_id)
        state[mode] = {"status": "ready", "stage": "내보내기 준비됨", "error": ""}
        write_export_state(job_id, state)
        return state[mode]
    with EXPORT_LOCK:
        key = (job_id, mode)
        thread = EXPORT_THREADS.get(key)
        if not thread or not thread.is_alive():
            thread = threading.Thread(target=run_export, args=(job_id, mode), daemon=True)
            EXPORT_THREADS[key] = thread
            thread.start()
    return {"status": "working", "stage": "내보내기 시작", "error": ""}


def create_download_ticket(job_id: str, kind: str) -> str:
    job = get_job(job_id)
    if not job:
        raise ValueError("작업을 찾을 수 없습니다.")
    if kind == "srt":
        path = JOBS_DIR / job_id / "culture.srt"
        filename = f"{safe_download_stem(job)}.ko-culture.srt"
        content_type = "application/x-subrip; charset=utf-8"
    elif kind in {"mp4", "mp4_srt"}:
        path = export_file(job_id, kind)
        stem = safe_download_stem(job)
        filename = f"{stem}.culture.mp4" if kind == "mp4" else f"{stem}.mp4+srt.zip"
        content_type = "video/mp4" if kind == "mp4" else "application/zip"
    else:
        raise ValueError("지원하지 않는 다운로드 형식입니다.")
    if not path.exists():
        raise ValueError("아직 내보내기 파일이 준비되지 않았습니다.")
    ticket = secrets.token_urlsafe(24)
    with EXPORT_LOCK:
        DOWNLOAD_TICKETS[ticket] = (path, time.time() + 300, filename, content_type)
    return ticket


def safe_download_stem(job: dict) -> str:
    value = Path(str(job.get("source_name") or job.get("video_id") or "culture-video")).stem
    value = re.sub(r"[^0-9A-Za-z가-힣._ -]+", "_", value).strip(" ._")
    return value[:100] or "culture-video"


def create_media_ticket(job_id: str) -> str:
    job = get_job(job_id)
    if not job or job.get("source_type") != "local":
        raise ValueError("로컬 영상 작업을 찾을 수 없습니다.")
    if job["status"] != "completed":
        raise ValueError("완료된 작업만 작업실에서 재생할 수 있습니다.")
    path = local_playback_path(job)
    if not path.is_file():
        raise ValueError("업로드한 원본 영상을 찾을 수 없습니다.")
    ticket = secrets.token_urlsafe(24)
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    with EXPORT_LOCK:
        MEDIA_TICKETS[ticket] = (path, time.time() + 6 * 3600, job_id, content_type)
    return ticket


def parse_byte_range(value: str, size: int) -> tuple[int, int] | None:
    if not value:
        return None
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
    if not match or (not match.group(1) and not match.group(2)):
        raise ValueError("지원하지 않는 Range 요청입니다.")
    if match.group(1):
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else size - 1
    else:
        length = int(match.group(2))
        start = max(0, size - length)
        end = size - 1
    if start >= size or start < 0 or end < start:
        raise ValueError("영상 범위를 벗어난 요청입니다.")
    return start, min(end, size - 1)


class QueueWorker(threading.Thread):
    daemon = True

    def run(self) -> None:
        while True:
            with db() as conn:
                row = conn.execute(
                    "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1"
                ).fetchone()
                if row:
                    claimed = conn.execute(
                        "UPDATE jobs SET status = 'downloading', updated_at = ? WHERE id = ? AND status = 'queued'",
                        (utc_now(), row["id"]),
                    ).rowcount
                else:
                    claimed = 0
            if row and claimed:
                process_job(row_to_dict(row))
            else:
                time.sleep(2)


class AppHandler(SimpleHTTPRequestHandler):
    server_version = "CultureSubtitleQueue/0.5"

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stdout.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/app/")
            self.end_headers()
            return
        if parsed.path == "/api/health":
            self.send_json({"ok": True, "service": "문화자막 큐"})
            return
        if parsed.path == "/api/bootstrap":
            if self.client_address[0] not in {"127.0.0.1", "::1"}:
                self.send_json({"error": "로컬 PC에서만 토큰을 자동 발급합니다."}, HTTPStatus.FORBIDDEN)
                return
            self.send_json({"token": self.server.access_token})  # type: ignore[attr-defined]
            return
        match = re.fullmatch(r"/api/download/([A-Za-z0-9_-]+)", parsed.path)
        if match:
            with EXPORT_LOCK:
                ticket_data = DOWNLOAD_TICKETS.pop(match.group(1), None)
            if not ticket_data or ticket_data[1] < time.time() or not ticket_data[0].is_file():
                self.send_json({"error": "다운로드 주소가 만료됐습니다."}, HTTPStatus.NOT_FOUND)
                return
            path, _, filename, content_type = ticket_data
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}")
            self.send_header("Content-Length", str(path.stat().st_size))
            self.end_headers()
            with path.open("rb") as handle:
                shutil.copyfileobj(handle, self.wfile, length=1024 * 1024)
            return
        match = re.fullmatch(r"/api/media/([A-Za-z0-9_-]+)", parsed.path)
        if match:
            with EXPORT_LOCK:
                ticket_data = MEDIA_TICKETS.get(match.group(1))
                if ticket_data and ticket_data[1] < time.time():
                    MEDIA_TICKETS.pop(match.group(1), None)
                    ticket_data = None
            if not ticket_data or not ticket_data[0].is_file():
                self.send_json({"error": "영상 재생 주소가 만료됐습니다."}, HTTPStatus.NOT_FOUND)
                return
            self.serve_media(ticket_data[0], ticket_data[3])
            return
        if parsed.path.startswith("/api/") and not self.authorized():
            self.send_json({"error": "페어링 토큰이 필요합니다."}, HTTPStatus.UNAUTHORIZED)
            return
        if parsed.path == "/api/jobs":
            self.send_json({"jobs": list_jobs()})
            return
        match = re.fullmatch(r"/api/jobs/by-video/([A-Za-z0-9_-]{11})", parsed.path)
        if match:
            job = get_latest_job_for_video(match.group(1))
            self.send_json({"job": job})
            return
        match = re.fullmatch(r"/api/jobs/([A-Za-z0-9_-]+)", parsed.path)
        if match:
            job = get_job(match.group(1))
            if not job:
                self.send_json({"error": "작업을 찾을 수 없습니다."}, HTTPStatus.NOT_FOUND)
            else:
                self.send_json({"job": job})
            return
        match = re.fullmatch(r"/api/jobs/([A-Za-z0-9_-]+)/subtitle\.srt", parsed.path)
        if match:
            job = get_job(match.group(1))
            subtitle = JOBS_DIR / match.group(1) / "culture.srt"
            if not job or not subtitle.exists():
                self.send_json({"error": "완성된 자막이 없습니다."}, HTTPStatus.NOT_FOUND)
                return
            data = subtitle.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/x-subrip; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        match = re.fullmatch(r"/api/jobs/([A-Za-z0-9_-]+)/exports", parsed.path)
        if match:
            if not get_job(match.group(1)):
                self.send_json({"error": "작업을 찾을 수 없습니다."}, HTTPStatus.NOT_FOUND)
            else:
                self.send_json({"exports": read_export_state(match.group(1))})
            return
        match = re.fullmatch(r"/api/jobs/([A-Za-z0-9_-]+)/media-ticket", parsed.path)
        if match:
            try:
                ticket = create_media_ticket(match.group(1))
                self.send_json({"url": f"/api/media/{ticket}", "expires_in": 6 * 3600})
            except ValueError as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/") or not self.authorized():
            self.send_json({"error": "페어링 토큰이 필요합니다."}, HTTPStatus.UNAUTHORIZED)
            return
        if parsed.path == "/api/jobs":
            try:
                payload = self.read_json()
                job = create_job(
                    str(payload.get("url", "")),
                    str(payload.get("level", "culture")),
                    str(payload.get("language", "auto")),
                )
                self.send_json({"job": job}, HTTPStatus.CREATED)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/local-jobs":
            job_id = ""
            target: Path | None = None
            temporary: Path | None = None
            try:
                query = parse_qs(parsed.query)
                filename = query.get("filename", [""])[0]
                level = query.get("level", ["culture"])[0]
                language = query.get("language", ["auto"])[0]
                job, target = create_local_job(filename, level, language)
                job_id = job["id"]
                temporary = target.with_suffix(target.suffix + ".uploading")
                self.read_file_body(temporary)
                temporary.replace(target)
                update_job(job_id, status="queued", stage="대기 중", progress=0)
                self.send_json({"job": get_job(job_id)}, HTTPStatus.CREATED)
            except (ValueError, OSError) as exc:
                if temporary and temporary.exists():
                    temporary.unlink(missing_ok=True)
                if job_id:
                    update_job(job_id, status="failed", stage="업로드 실패", error=str(exc), progress=0)
                self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        match = re.fullmatch(r"/api/jobs/([A-Za-z0-9_-]+)/retry", parsed.path)
        if match:
            job = get_job(match.group(1))
            if not job:
                self.send_json({"error": "작업을 찾을 수 없습니다."}, HTTPStatus.NOT_FOUND)
                return
            update_job(job["id"], status="queued", stage="재시도 대기 중", error="", progress=0)
            self.send_json({"job": get_job(job["id"])})
            return
        match = re.fullmatch(r"/api/jobs/([A-Za-z0-9_-]+)/exports", parsed.path)
        if match:
            try:
                payload = self.read_json()
                mode = str(payload.get("mode", ""))
                self.send_json({"export": start_export(match.group(1), mode)}, HTTPStatus.ACCEPTED)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        match = re.fullmatch(r"/api/jobs/([A-Za-z0-9_-]+)/download-ticket", parsed.path)
        if match:
            try:
                payload = self.read_json()
                ticket = create_download_ticket(match.group(1), str(payload.get("kind", "")))
                self.send_json({"url": f"/api/download/{ticket}"}, HTTPStatus.CREATED)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return
        self.send_json({"error": "지원하지 않는 요청입니다."}, HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/") or not self.authorized():
            self.send_json({"error": "페어링 토큰이 필요합니다."}, HTTPStatus.UNAUTHORIZED)
            return
        match = re.fullmatch(r"/api/jobs/([A-Za-z0-9_-]+)", parsed.path)
        if not match:
            self.send_json({"error": "지원하지 않는 요청입니다."}, HTTPStatus.NOT_FOUND)
            return
        try:
            job = delete_job(match.group(1))
            self.send_json({"deleted": job["id"]})
        except FileNotFoundError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)
        except (RuntimeError, OSError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/") or not self.authorized():
            self.send_json({"error": "페어링 토큰이 필요합니다."}, HTTPStatus.UNAUTHORIZED)
            return
        match = re.fullmatch(r"/api/jobs/([A-Za-z0-9_-]+)", parsed.path)
        if not match:
            self.send_json({"error": "지원하지 않는 요청입니다."}, HTTPStatus.NOT_FOUND)
            return
        try:
            self.send_json({"job": organize_job(match.group(1), self.read_json())})
        except FileNotFoundError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def authorized(self) -> bool:
        expected = f"Bearer {self.server.access_token}"  # type: ignore[attr-defined]
        return secrets.compare_digest(self.headers.get("Authorization", ""), expected)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 100_000:
            raise ValueError("요청이 너무 큽니다.")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def read_file_body(self, target: Path) -> None:
        raw_length = self.headers.get("Content-Length", "")
        if not raw_length.isdigit():
            raise ValueError("영상 파일 크기를 확인할 수 없습니다.")
        length = int(raw_length)
        if length <= 0:
            raise ValueError("빈 영상 파일은 올릴 수 없습니다.")
        if length > MAX_UPLOAD_BYTES:
            raise ValueError(f"영상 파일은 최대 {MAX_UPLOAD_BYTES // (1024 ** 3)}GB까지 올릴 수 있습니다.")
        target.parent.mkdir(parents=True, exist_ok=True)
        remaining = length
        with target.open("wb") as handle:
            while remaining:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError("영상 업로드가 중간에 끊겼습니다.")
                handle.write(chunk)
                remaining -= len(chunk)

    def serve_media(self, path: Path, content_type: str) -> None:
        size = path.stat().st_size
        try:
            requested = parse_byte_range(self.headers.get("Range", ""), size)
        except ValueError:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return
        start, end = requested or (0, size - 1)
        length = end - start + 1
        self.send_response(HTTPStatus.PARTIAL_CONTENT if requested else HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if requested:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining:
                chunk = handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def serve_static(self, request_path: str) -> None:
        relative = request_path[len("/app/") :] if request_path.startswith("/app/") else ""
        if request_path == "/app" or not relative:
            relative = "index.html"
        candidate = (STATIC_DIR / relative).resolve()
        if STATIC_DIR.resolve() not in candidate.parents and candidate != STATIC_DIR.resolve():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    parser = argparse.ArgumentParser(description="문화역주 자막 작업 큐")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8876)
    parser.add_argument("--lan", action="store_true", help="같은 네트워크의 모바일 기기에서 접속 허용")
    parser.add_argument("--no-worker", action="store_true", help="QA용: 대기열 작업자 없이 서버만 실행")
    args = parser.parse_args()
    token = init_storage()
    host = "0.0.0.0" if args.lan else args.host
    server = ThreadingHTTPServer((host, args.port), AppHandler)
    server.access_token = token  # type: ignore[attr-defined]
    if not args.no_worker:
        QueueWorker().start()
    print(f"문화자막 큐: http://127.0.0.1:{args.port}/app/")
    if args.lan:
        print("모바일에서는 이 PC의 로컬 IP와 포트를 사용하세요.")
        print(f"페어링 토큰: {token}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
