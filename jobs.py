"""
Minimal in-process job queue.

The API only ever calls `enqueue_video(video_id, video_path)`. To move
transcription to a dedicated worker later, replace the body of that one function
(e.g. `celery_app.send_task("transcribe", args=[video_id, video_path])` or
`rq_queue.enqueue(process_video, video_id, video_path)`). Nothing else changes,
because `process_video` already reads and writes state through the database.

Why not FastAPI BackgroundTasks? They run immediately and unbounded, so three
uploads would load three Whisper decoders at once. Here a fixed number of worker
threads (default 1) pull from a queue, and the rest wait with stage "Queued".
Threads are daemons so Ctrl+C stops the server immediately; interrupted jobs are
marked FAILED on the next start and can be retried from their last chunk.
"""
import logging
import os
import queue
import threading
from typing import Tuple

from app.transcriber import process_video

logger = logging.getLogger("yoogle.jobs")

_jobs: "queue.Queue[Tuple[str, str]]" = queue.Queue()
_started = False
_start_lock = threading.Lock()


def _worker_loop() -> None:
    while True:
        video_id, video_path = _jobs.get()
        try:
            process_video(video_id, video_path)
        except Exception:  # process_video handles its own errors; this is a last resort
            logger.exception("Unhandled error in worker for %s", video_id)
        finally:
            _jobs.task_done()


def start_workers(count: int = 0) -> None:
    global _started
    with _start_lock:
        if _started:
            return
        count = count or int(os.getenv("YOOGLE_WORKERS", "1"))
        for i in range(max(1, count)):
            threading.Thread(target=_worker_loop, name=f"yoogle-worker-{i}", daemon=True).start()
        _started = True


def enqueue_video(video_id: str, video_path: str) -> None:
    _jobs.put((video_id, video_path))
