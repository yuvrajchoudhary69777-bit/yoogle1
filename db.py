"""
SQLite access layer.

Everything the API and the transcription worker need from the database lives
here, so the worker never writes raw SQL and can later be moved to another
process (or another database) by changing this one module.
"""
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable, Optional, Sequence, Tuple

DB_PATH = Path(os.getenv("YOOGLE_DB", Path(__file__).resolve().parent.parent / "yoogle.db"))

# Columns returned by the API for a video (kept in one place so list + detail match).
VIDEO_COLUMNS = (
    "id, title, source_type, file_path, status, error_msg, created_at, "
    "progress_pct, stage, duration_sec, processed_sec"
)

# Columns added after the first release; created automatically on startup.
_MIGRATIONS = {
    "progress_pct": "REAL NOT NULL DEFAULT 0",   # 0-100 overall progress
    "stage": "TEXT",                              # "Queued", "Extracting audio", "Transcribing chunk 3/12", ...
    "duration_sec": "REAL",                       # media length once known
    "processed_sec": "REAL NOT NULL DEFAULT 0",   # audio already transcribed AND committed (resume point)
}

_UPDATABLE = {"status", "error_msg", "progress_pct", "stage", "duration_sec", "processed_sec"}

Segment = Tuple[float, float, str]  # (start_sec, end_sec, text)


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # WAL lets the UI read progress/search while the worker is committing a chunk.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def db():
    """Open a connection, commit on success, roll back on error, always close."""
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS videos (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                source_type TEXT NOT NULL, -- 'upload' or 'youtube'
                file_path TEXT,
                youtube_id TEXT,
                status TEXT NOT NULL DEFAULT 'PROCESSING',
                error_msg TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id TEXT NOT NULL,
                start_sec REAL NOT NULL,
                end_sec REAL NOT NULL,
                text TEXT NOT NULL,
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
                video_id UNINDEXED,
                segment_id UNINDEXED,
                text
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_segments_video_start ON segments(video_id, start_sec)"
        )

        # Upgrade databases created by the starter project.
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(videos)")}
        for column, ddl in _MIGRATIONS.items():
            if column not in existing:
                conn.execute(f"ALTER TABLE videos ADD COLUMN {column} {ddl}")
        # Videos finished before progress tracking existed should look finished.
        conn.execute(
            "UPDATE videos SET progress_pct = 100, stage = 'Done' "
            "WHERE status = 'READY' AND stage IS NULL"
        )


# --------------------------------------------------------------------------- #
# Repository functions used by the API and the worker
# --------------------------------------------------------------------------- #

def create_video(video_id: str, title: str, file_path: str) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO videos (id, title, source_type, file_path, status, stage, progress_pct) "
            "VALUES (?, ?, 'upload', ?, 'PROCESSING', 'Queued', 0)",
            (video_id, title, file_path),
        )


def get_video(video_id: str) -> Optional[dict]:
    with db() as conn:
        row = conn.execute(f"SELECT {VIDEO_COLUMNS} FROM videos WHERE id = ?", (video_id,)).fetchone()
    return dict(row) if row else None


def list_videos() -> list:
    with db() as conn:
        rows = conn.execute(
            f"SELECT {VIDEO_COLUMNS} FROM videos ORDER BY created_at DESC, rowid DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def update_video(video_id: str, **fields) -> None:
    """Small, single-statement progress/status update (safe to call often)."""
    unknown = set(fields) - _UPDATABLE
    if unknown:
        raise ValueError(f"Cannot update columns: {sorted(unknown)}")
    if not fields:
        return
    assignments = ", ".join(f"{name} = ?" for name in fields)
    with db() as conn:
        conn.execute(
            f"UPDATE videos SET {assignments} WHERE id = ?", (*fields.values(), video_id)
        )


def save_chunk(
    video_id: str,
    segments: Iterable[Segment],
    *,
    processed_sec: float,
    progress_pct: float,
    stage: str,
) -> None:
    """
    Atomically store one chunk's segments (table + FTS index) and advance the
    resume point. Either the whole chunk is saved or none of it is, so a crash
    can never leave half a chunk behind or duplicate text on retry.
    """
    with db() as conn:
        cur = conn.cursor()
        for start, end, text in segments:
            cur.execute(
                "INSERT INTO segments (video_id, start_sec, end_sec, text) VALUES (?, ?, ?, ?)",
                (video_id, start, end, text),
            )
            segment_id = cur.lastrowid
            cur.execute(
                "INSERT INTO segments_fts (video_id, segment_id, text) VALUES (?, ?, ?)",
                (video_id, segment_id, text),
            )
        cur.execute(
            "UPDATE videos SET processed_sec = ?, progress_pct = ?, stage = ? WHERE id = ?",
            (processed_sec, progress_pct, stage, video_id),
        )


def mark_interrupted_jobs() -> int:
    """Jobs left in PROCESSING by a crash/restart become FAILED (and can be retried)."""
    with db() as conn:
        cur = conn.execute(
            "UPDATE videos SET status = 'FAILED', stage = 'Interrupted', "
            "error_msg = 'Processing was interrupted by a server restart. Retry to continue where it stopped.' "
            "WHERE status = 'PROCESSING'"
        )
        return cur.rowcount


def search_segments(video_id: str, query: str, limit: int) -> Sequence[sqlite3.Row]:
    """FTS5 phrase-prefix search, falling back to substring match."""
    clean = query.replace('"', " ").strip()
    if not clean:
        return []
    with db() as conn:
        rows = conn.execute(
            """
            SELECT s.id, s.start_sec, s.end_sec, s.text
            FROM segments_fts f
            JOIN segments s ON s.id = f.segment_id
            WHERE f.video_id = ? AND segments_fts MATCH ?
            ORDER BY s.start_sec ASC
            LIMIT ?
            """,
            (video_id, f'"{clean}"*', limit),
        ).fetchall()
        if not rows:
            escaped = clean.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            rows = conn.execute(
                """
                SELECT id, start_sec, end_sec, text
                FROM segments
                WHERE video_id = ? AND text LIKE ? ESCAPE '\\'
                ORDER BY start_sec ASC
                LIMIT ?
                """,
                (video_id, f"%{escaped}%", limit),
            ).fetchall()
    return rows
