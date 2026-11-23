"""
Chunked, resumable transcription pipeline.

    video ──ffmpeg──▶ 16 kHz mono WAV on disk ──▶ N time chunks ──▶ faster-whisper ──▶ SQLite
                                                       │
                                     one atomic commit per chunk (+ progress / stage)

Why it scales to multi-hour videos
----------------------------------
* Audio is extracted to a WAV *file* and read back one chunk at a time, so RAM
  use is ~(chunk length x 16 kHz x 6 bytes): about 30 MB for a 5-minute chunk,
  regardless of how long the video is.
* Each chunk is committed atomically. If anything fails at chunk 9/12, chunks
  1-8 stay searchable and `videos.processed_sec` records the resume point.
  Retrying continues from there instead of starting over.
* Chunks overlap by a couple of seconds so words on a boundary are decoded with
  context. Every segment is "owned" by exactly one chunk (the one that contains
  its start time), which prevents duplicates.

Modularity
----------
`process_video(video_id, video_path)` is the only entry point. It depends on
`app.db` for persistence and on nothing in FastAPI, so it can be called from
an in-process thread (see `app.jobs`), Celery, RQ, Arq, or a standalone worker.
"""
from __future__ import annotations

import logging
import math
import os
import shutil
import subprocess
import tempfile
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, List, Optional, Tuple

import numpy as np
from faster_whisper import WhisperModel

from app import db

logger = logging.getLogger("yoogle.transcriber")

# --------------------------------------------------------------------------- #
# Configuration (all overridable with environment variables)
# --------------------------------------------------------------------------- #
MODEL_SIZE = os.getenv("WHISPER_MODEL", "base")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")                  # "cuda" for NVIDIA GPUs
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")     # "float16" on GPU
LANGUAGE = os.getenv("WHISPER_LANGUAGE") or None             # None = detect on first chunk, then reuse

CHUNK_SEC = float(os.getenv("YOOGLE_CHUNK_SEC", "300"))      # 5 minutes; try 600 on big machines
OVERLAP_SEC = float(os.getenv("YOOGLE_CHUNK_OVERLAP_SEC", "2"))
WORK_DIR = Path(os.getenv("YOOGLE_WORK_DIR", Path(__file__).resolve().parent.parent / "work"))

SAMPLE_RATE = 16_000
BYTES_PER_SECOND = SAMPLE_RATE * 2          # mono, 16-bit
EXTRACT_SHARE = 5.0                         # % of the progress bar reserved for audio extraction
PROGRESS_THROTTLE_SEC = 1.0                 # at most ~1 progress write per second

_model: Optional[WhisperModel] = None
_model_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# Model
# --------------------------------------------------------------------------- #
def get_whisper_model() -> WhisperModel:
    global _model
    with _model_lock:
        if _model is None:
            _model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
        return _model


# --------------------------------------------------------------------------- #
# FFmpeg helpers
# --------------------------------------------------------------------------- #
class FFmpegError(RuntimeError):
    pass


def probe_duration(path: str) -> Optional[float]:
    """Media duration in seconds via ffprobe, or None if it can't be read."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=60, check=True,
        )
        value = float(result.stdout.strip())
        return value if value > 0 else None
    except Exception:
        return None


def extract_audio(
    video_path: str,
    wav_path: Path,
    duration_hint: Optional[float],
    on_progress: Callable[[float], None],
) -> None:
    """
    Decode the first audio track to 16 kHz mono PCM WAV on disk.
    `on_progress` receives a fraction 0..1 (throttled) when the duration is known.
    """
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", video_path,
        "-map", "0:a:0",            # first audio stream; clear error if there is none
        "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le",
        "-progress", "pipe:1", "-nostats",
        str(wav_path),
    ]
    with tempfile.TemporaryFile("w+") as err_file:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err_file, text=True)
        last_report = 0.0
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                key, _, value = line.strip().partition("=")
                if key not in ("out_time_us", "out_time_ms") or not duration_hint:
                    continue
                try:
                    position = int(value) / 1_000_000
                except ValueError:  # ffmpeg prints "N/A" before the first frame
                    continue
                now = time.monotonic()
                if now - last_report >= PROGRESS_THROTTLE_SEC:
                    last_report = now
                    on_progress(min(position / duration_hint, 1.0))
            code = proc.wait()
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

        if code != 0:
            err_file.seek(0)
            tail = err_file.read()[-600:].strip()
            if "matches no streams" in tail or "does not contain any stream" in tail:
                raise FFmpegError("This file has no audio track to transcribe.")
            raise FFmpegError(f"ffmpeg could not read this file: {tail or f'exit code {code}'}")


# --------------------------------------------------------------------------- #
# Chunking
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Chunk:
    index: int      # 1-based, for display
    total: int
    start: float    # the chunk "owns" segments that start in [start, end)
    end: float


def iter_chunks(duration: float, resume_from: float = 0.0, chunk_sec: float = CHUNK_SEC) -> Iterator[Chunk]:
    total = max(1, math.ceil(duration / chunk_sec))
    start = resume_from
    index = int(start // chunk_sec) + 1
    while start < duration - 0.05:
        end = min(start + chunk_sec, duration)
        yield Chunk(index=index, total=total, start=start, end=end)
        start, index = end, index + 1


def read_audio(wf: wave.Wave_read, start_sec: float, end_sec: float) -> np.ndarray:
    """Read [start_sec, end_sec) from the WAV as float32 in [-1, 1]. Only this slice is held in RAM."""
    first = max(0, int(start_sec * SAMPLE_RATE))
    last = min(wf.getnframes(), int(end_sec * SAMPLE_RATE))
    wf.setpos(first)
    raw = wf.readframes(max(0, last - first))
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def overall_pct(position_sec: float, duration: float) -> float:
    """Map 'seconds transcribed' to the 5-100 % part of the progress bar."""
    fraction = min(max(position_sec / duration, 0.0), 1.0) if duration > 0 else 0.0
    return round(EXTRACT_SHARE + (100.0 - EXTRACT_SHARE) * fraction, 1)


def transcribe_chunk(
    model: WhisperModel,
    wf: wave.Wave_read,
    chunk: Chunk,
    duration: float,
    language: Optional[str],
    on_tick: Callable[[float], None],
) -> Tuple[List[db.Segment], Optional[str]]:
    """Transcribe one chunk and return (segments with absolute timestamps, detected language)."""
    # Decode a little before/after the chunk for context; keep only segments that start inside it.
    read_start = max(0.0, chunk.start - OVERLAP_SEC)
    read_end = min(duration, chunk.end + OVERLAP_SEC)
    audio = read_audio(wf, read_start, read_end)

    segments, info = model.transcribe(
        audio,
        language=language,
        beam_size=5,
        vad_filter=True,                         # skip silence/music: faster, fewer hallucinations
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,        # stops repetition loops on long audio
    )

    rows: List[db.Segment] = []
    for seg in segments:                         # lazy generator: decoding happens here
        abs_start = read_start + seg.start       # <- timestamp offset: chunk start + in-chunk time
        abs_end = read_start + seg.end
        on_tick(min(abs_end, chunk.end))
        text = seg.text.strip()
        if text and chunk.start <= abs_start < chunk.end:
            rows.append((round(abs_start, 2), round(abs_end, 2), text))
    return rows, info.language


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def process_video(video_id: str, video_path: str) -> None:
    """
    Transcribe `video_path` and store segments for `video_id`. Safe to re-run:
    it resumes from `videos.processed_sec`, so a retry never repeats finished chunks.
    Never raises; failures are recorded on the video row.
    """
    wav_path = WORK_DIR / f"{video_id}.wav"
    try:
        WORK_DIR.mkdir(parents=True, exist_ok=True)
        video = db.get_video(video_id)
        if video is None:
            return
        resume_from = float(video.get("processed_sec") or 0.0)

        # ---- 1. Extract audio ------------------------------------------------
        db.update_video(video_id, status="PROCESSING", stage="Extracting audio", error_msg=None)
        duration_hint = probe_duration(video_path)
        if duration_hint:
            db.update_video(video_id, duration_sec=duration_hint)
            needed = duration_hint * BYTES_PER_SECOND * 1.1
            if shutil.disk_usage(WORK_DIR).free < needed:
                raise RuntimeError(
                    f"Not enough free disk space in {WORK_DIR} to extract audio "
                    f"(needs about {needed / 1e6:.0f} MB). Set YOOGLE_WORK_DIR to a larger disk."
                )

        extract_audio(
            video_path, wav_path, duration_hint,
            on_progress=lambda f: db.update_video(video_id, progress_pct=round(EXTRACT_SHARE * f, 1)),
        )

        # ---- 2. Transcribe chunk by chunk -----------------------------------
        with wave.open(str(wav_path), "rb") as wf:
            if (wf.getframerate(), wf.getnchannels(), wf.getsampwidth()) != (SAMPLE_RATE, 1, 2):
                raise RuntimeError("Unexpected audio format after extraction.")
            duration = wf.getnframes() / SAMPLE_RATE
            if duration < 0.5:
                raise RuntimeError("No audio found in this file.")
            db.update_video(video_id, duration_sec=duration)

            db.update_video(video_id, stage="Loading speech model")
            model = get_whisper_model()
            language = LANGUAGE

            last_tick = 0.0

            def tick(position_sec: float) -> None:
                nonlocal last_tick
                now = time.monotonic()
                if now - last_tick >= PROGRESS_THROTTLE_SEC:
                    last_tick = now
                    db.update_video(video_id, progress_pct=overall_pct(position_sec, duration))

            for chunk in iter_chunks(duration, resume_from):
                stage = f"Transcribing chunk {chunk.index}/{chunk.total}"
                db.update_video(video_id, stage=stage, progress_pct=overall_pct(chunk.start, duration))

                rows, detected = transcribe_chunk(model, wf, chunk, duration, language, tick)
                language = language or detected     # lock in the language found on the first chunk

                db.save_chunk(
                    video_id, rows,
                    processed_sec=chunk.end,
                    progress_pct=overall_pct(chunk.end, duration),
                    stage=stage,
                )
                logger.info("%s: chunk %d/%d done (%d segments)", video_id, chunk.index, chunk.total, len(rows))

        db.update_video(
            video_id, status="READY", stage="Done", progress_pct=100,
            processed_sec=duration, error_msg=None,
        )
    except Exception as exc:  # noqa: BLE001 - the worker must never crash the process
        logger.exception("Processing failed for %s", video_id)
        message = str(exc) or exc.__class__.__name__
        db.update_video(video_id, status="FAILED", stage="Failed", error_msg=message[:600])
    finally:
        try:
            wav_path.unlink(missing_ok=True)
        except OSError:
            pass
