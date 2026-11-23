import mimetypes
import os
import re
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Iterator

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse

from app import db
from app.jobs import enqueue_video, start_workers

UPLOAD_DIR = Path(os.getenv("YOOGLE_UPLOAD_DIR", Path(__file__).resolve().parent.parent / "uploads")).resolve()
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}
MAX_UPLOAD_BYTES = int(float(os.getenv("YOOGLE_MAX_UPLOAD_GB", "20")) * 1024**3)
DISK_HEADROOM_BYTES = 2 * 1024**3        # always leave 2 GB free on the upload disk
WRITE_BUFFER_BYTES = 4 * 1024 * 1024     # coalesce network packets into 4 MB disk writes


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    db.mark_interrupted_jobs()
    start_workers()
    yield


app = FastAPI(title="Yoogle - Video Content Search Engine", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("YOOGLE_CORS_ORIGINS", "*").split(","),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Upload: stream the raw request body straight to disk
# --------------------------------------------------------------------------- #
@app.post("/api/videos/upload", status_code=201)
async def upload_video(request: Request, filename: str = Query(..., min_length=1, max_length=255)):
    """
    The browser sends the file as the raw request body (not multipart), e.g.
    `POST /api/videos/upload?filename=talk.mp4` with `Content-Type: application/octet-stream`.

    Multipart `UploadFile` makes Starlette spool the whole body to a temp file first
    (often a small /tmp partition) and then we'd copy it again. Streaming the body
    ourselves writes each byte to disk exactly once, with constant memory.
    """
    title = Path(filename).name
    ext = Path(title).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported format. Use one of: {', '.join(sorted(ALLOWED_EXTENSIONS))}.")

    declared = request.headers.get("content-length")
    if declared and declared.isdigit():
        size = int(declared)
        if size > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"File is larger than the {MAX_UPLOAD_BYTES // 1024**3} GB upload limit.")
        if size + DISK_HEADROOM_BYTES > shutil.disk_usage(UPLOAD_DIR).free:
            raise HTTPException(507, "The server doesn't have enough free disk space for this file.")

    video_id = uuid.uuid4().hex[:12]
    final_path = UPLOAD_DIR / f"{video_id}{ext}"
    part_path = final_path.with_name(final_path.name + ".part")   # never served, never processed

    written = 0
    try:
        with open(part_path, "wb") as out:
            buffer = bytearray()
            async for chunk in request.stream():
                if not chunk:
                    continue
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"File is larger than the {MAX_UPLOAD_BYTES // 1024**3} GB upload limit.")
                buffer += chunk
                if len(buffer) >= WRITE_BUFFER_BYTES:
                    await run_in_threadpool(out.write, buffer)   # disk I/O off the event loop
                    buffer.clear()
            if buffer:
                await run_in_threadpool(out.write, buffer)
        if written == 0:
            raise HTTPException(400, "The uploaded file is empty.")
        os.replace(part_path, final_path)                         # atomic: appears fully written or not at all
    except BaseException:                                         # includes client disconnects / cancellation
        part_path.unlink(missing_ok=True)
        raise

    db.create_video(video_id, title, f"/media/{final_path.name}")
    enqueue_video(video_id, str(final_path))
    return {"video_id": video_id, "title": title, "status": "PROCESSING", "bytes": written}


# --------------------------------------------------------------------------- #
# Media with HTTP Range support (needed so seeking in huge files doesn't download them)
# --------------------------------------------------------------------------- #
def _iter_file(path: Path, start: int, end: int, block: int = 1024 * 1024) -> Iterator[bytes]:
    with open(path, "rb") as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            data = f.read(min(block, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


@app.get("/media/{filename}")
def media(filename: str, request: Request):
    path = (UPLOAD_DIR / filename).resolve()
    if path.parent != UPLOAD_DIR or path.suffix == ".part" or not path.is_file():
        raise HTTPException(404, "Media not found")

    size = path.stat().st_size
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    base_headers = {"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600"}

    match = re.fullmatch(r"bytes=(\d*)-(\d*)", (request.headers.get("range") or "").strip())
    if not match or not (match.group(1) or match.group(2)):
        return FileResponse(path, media_type=content_type, headers=base_headers)

    first, last = match.groups()
    if first == "":                                   # "bytes=-500": the last 500 bytes
        start, end = max(0, size - int(last)), size - 1
    else:
        start = int(first)
        end = min(int(last), size - 1) if last else size - 1
    if start >= size or start > end:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})

    return StreamingResponse(
        _iter_file(path, start, end),
        status_code=206,
        media_type=content_type,
        headers={**base_headers, "Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(end - start + 1)},
    )


# --------------------------------------------------------------------------- #
# Videos
# --------------------------------------------------------------------------- #
@app.get("/api/videos")
def list_videos():
    return db.list_videos()


@app.get("/api/videos/{video_id}")
def get_video(video_id: str):
    video = db.get_video(video_id)
    if not video:
        raise HTTPException(404, "Video not found")
    return video   # includes status, progress_pct, stage, processed_sec, duration_sec


@app.post("/api/videos/{video_id}/retry")
def retry_video(video_id: str):
    """Re-queue a FAILED video. Finished chunks are kept; work resumes at `processed_sec`."""
    video = db.get_video(video_id)
    if not video:
        raise HTTPException(404, "Video not found")
    if video["status"] != "FAILED":
        raise HTTPException(409, "Only failed videos can be retried.")
    path = UPLOAD_DIR / Path(video["file_path"] or "").name
    if not path.is_file():
        raise HTTPException(410, "The original file is no longer on the server. Upload it again.")
    db.update_video(video_id, status="PROCESSING", stage="Queued", error_msg=None)
    enqueue_video(video_id, str(path))
    return db.get_video(video_id)


# --------------------------------------------------------------------------- #
# Search
# --------------------------------------------------------------------------- #
@app.get("/api/search")
def search_transcript(
    video_id: str = Query(...),
    q: str = Query(..., min_length=1),
    limit: int = Query(300, ge=1, le=1000),
):
    """Works while a video is still processing: it searches whatever chunks are committed so far."""
    rows = db.search_segments(video_id, q, limit + 1)
    truncated = len(rows) > limit
    rows = rows[:limit]
    return {
        "video_id": video_id,
        "query": q,
        "count": len(rows),
        "truncated": truncated,
        "results": [dict(r) for r in rows],
    }
