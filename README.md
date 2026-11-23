# Yoogle — Video Content Search Engine

Search spoken words inside video files (including multi-hour ones) and jump to the exact moment.

## Architecture
- **Upload:** the browser streams the raw file as the request body; FastAPI writes it to disk in 4 MB blocks (constant memory).
- **Backend:** FastAPI, SQLite (WAL) with an FTS5 index, FFmpeg, `faster-whisper`.
- **Worker:** `app/transcriber.py` extracts 16 kHz mono WAV, transcribes it in 5-minute chunks, commits each chunk atomically and records progress. `app/jobs.py` is the only queue-specific code (swap it for Celery/RQ later).
- **Frontend:** Next.js + Tailwind. Responsive, touch-friendly, live upload and transcription progress.

## Two UI themes
- `frontend/` is the **light yellow** theme (default).
- `frontend-dark/` is the **dark slate + indigo/emerald** theme.

Both have identical features and layout and use the same backend. Run whichever you prefer (or both on different ports).

## Run
```bash
# Backend (ffmpeg + ffprobe must be on PATH)
cd backend
python -m venv venv && source venv/bin/activate     # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --port 8000 --host 0.0.0.0 --timeout-keep-alive 120

# Frontend (use frontend-dark instead for the dark theme)
cd frontend
npm install
npm run dev
```
Open `http://localhost:3000`. From a phone on the same network, open `http://<your-computer-ip>:3000`; the page talks to port 8000 on the same host automatically (override with `NEXT_PUBLIC_API_BASE`).

## Configuration (environment variables)
| Variable | Default | Purpose |
|---|---|---|
| `WHISPER_MODEL` | `base` | `tiny`, `base`, `small`, `medium`, `large-v3` |
| `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` | `cpu` / `int8` | Use `cuda` / `float16` on an NVIDIA GPU |
| `WHISPER_LANGUAGE` | auto | Detected on the first chunk and reused; set e.g. `en` to force |
| `YOOGLE_CHUNK_SEC` | `300` | Chunk length; 600 is fine on 16 GB+ machines |
| `YOOGLE_CHUNK_OVERLAP_SEC` | `2` | Context decoded either side of a chunk |
| `YOOGLE_WORKERS` | `1` | Parallel transcriptions (each loads its own decoder state) |
| `YOOGLE_WORK_DIR` | `backend/work` | Temp WAV location (~115 MB per hour of video) |
| `YOOGLE_UPLOAD_DIR` | `backend/uploads` | Where videos are stored |
| `YOOGLE_MAX_UPLOAD_GB` | `20` | Upload size cap |
| `YOOGLE_CORS_ORIGINS` | `*` | Comma-separated allowed origins |

## Behind a reverse proxy (nginx)
```nginx
client_max_body_size 0;          # or your upload cap
proxy_request_buffering off;     # stream uploads instead of buffering them in the proxy
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

## Failed or interrupted jobs
Finished chunks are saved. Press **Retry processing** in the UI (or `POST /api/videos/{id}/retry`) to continue from the last completed chunk. Jobs that were running when the server stopped are marked failed on the next start so they can be retried.
