"use client";

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

/* -------------------------------------------------------------------------- */
/*  Config & types                                                            */
/* -------------------------------------------------------------------------- */

// Set NEXT_PUBLIC_API_BASE to override. Otherwise use the same host the page was
// opened from, so testing from a phone on your LAN works without extra setup.
const apiBase = (): string =>
  process.env.NEXT_PUBLIC_API_BASE ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:8000`
    : "http://localhost:8000");

const ALLOWED_EXT = [".mp4", ".mov", ".mkv", ".webm", ".avi"];
const PREROLL_SEC = 0.5; // start a little before the matched words

type Status = "PROCESSING" | "READY" | "FAILED";

interface VideoItem {
  id: string;
  title: string;
  file_path: string;
  status: Status;
  error_msg: string | null;
  progress_pct: number;
  stage: string | null;
  duration_sec: number | null;
  processed_sec: number;
}

interface SearchSegment {
  id: number;
  start_sec: number;
  end_sec: number;
  text: string;
}

interface UploadState {
  name: string;
  loaded: number;
  total: number;
  phase: "uploading" | "finalizing" | "error";
  error?: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches the searched words (in order, separated by any punctuation) plus the rest of the last word. */
function buildHighlighter(query: string): RegExp | null {
  const tokens = query.match(new RegExp("[\\p{L}\\p{N}']+", "gu"));
  if (!tokens || tokens.length === 0) return null;
  const body = tokens.map(escapeRegExp).join("[^\\p{L}\\p{N}]+");
  return new RegExp(`(${body}[\\p{L}\\p{N}]*)`, "giu");
}

const glass =
  "rounded-2xl border border-amber-900/15 bg-white/70 backdrop-blur-xl " +
  "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.9),0_20px_40px_-28px_rgba(120,80,0,0.35)]";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-yellow-50";

/* -------------------------------------------------------------------------- */
/*  Upload hook: one streamed request with real byte progress                 */
/* -------------------------------------------------------------------------- */

function useVideoUpload(onUploaded: (videoId: string) => void) {
  const [state, setState] = useState<UploadState | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const lastPaint = useRef(0);
  const active = state?.phase === "uploading" || state?.phase === "finalizing";

  // Warn before closing the tab mid-upload.
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const start = useCallback(
    (file: File) => {
      if (xhrRef.current) return;
      const lower = file.name.toLowerCase();
      if (!ALLOWED_EXT.some((ext) => lower.endsWith(ext))) {
        setState({
          name: file.name,
          loaded: 0,
          total: file.size,
          phase: "error",
          error: `Unsupported format. Choose ${ALLOWED_EXT.join(", ")}.`,
        });
        return;
      }

      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      setState({ name: file.name, loaded: 0, total: file.size, phase: "uploading" });

      // The raw file is the request body: the browser streams it from disk, so even
      // multi-GB files never sit in memory, and the server writes it straight to disk.
      xhr.open("POST", `${apiBase()}/api/videos/upload?filename=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");

      xhr.upload.onprogress = (e) => {
        const now = performance.now();
        if (!e.lengthComputable || now - lastPaint.current < 150) return; // throttle repaints
        lastPaint.current = now;
        setState((s) => (s ? { ...s, loaded: e.loaded, total: e.total } : s));
      };
      xhr.upload.onload = () => setState((s) => (s ? { ...s, loaded: s.total, phase: "finalizing" } : s));

      xhr.onload = () => {
        xhrRef.current = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            setState(null);
            onUploaded(data.video_id);
            return;
          } catch {
            /* fall through to error */
          }
        }
        let detail = "The server rejected the upload.";
        try {
          detail = JSON.parse(xhr.responseText).detail || detail;
        } catch {
          /* keep default */
        }
        setState((s) => (s ? { ...s, phase: "error", error: detail } : s));
      };
      xhr.onerror = () => {
        xhrRef.current = null;
        setState((s) =>
          s
            ? { ...s, phase: "error", error: "Couldn't reach the server. Check your connection and that the backend is running." }
            : s
        );
      };
      xhr.onabort = () => {
        xhrRef.current = null;
        setState(null);
      };
      xhr.send(file);
    },
    [onUploaded]
  );

  const cancel = useCallback(() => xhrRef.current?.abort(), []);
  const dismiss = useCallback(() => setState(null), []);
  return { state, start, cancel, dismiss };
}

/* -------------------------------------------------------------------------- */
/*  Small presentational components                                           */
/* -------------------------------------------------------------------------- */

function ProgressBar({ value, tone = "emerald", label }: { value: number; tone?: "emerald" | "indigo"; label: string }) {
  const v = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      className="h-2.5 w-full overflow-hidden rounded-full bg-amber-900/10"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none ${
          tone === "indigo" ? "bg-indigo-500" : "bg-emerald-500"
        }`}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const styles: Record<Status, string> = {
    READY: "bg-emerald-500/15 text-emerald-800 ring-emerald-600/25",
    PROCESSING: "bg-amber-400/30 text-amber-900 ring-amber-600/25",
    FAILED: "bg-rose-500/15 text-rose-800 ring-rose-600/25",
  };
  const text: Record<Status, string> = { READY: "Ready", PROCESSING: "Processing", FAILED: "Failed" };
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${styles[status]}`}>{text[status]}</span>
  );
}

function StatusDot({ status }: { status: Status }) {
  const color = status === "READY" ? "bg-emerald-500" : status === "FAILED" ? "bg-rose-500" : "bg-amber-500 motion-safe:animate-pulse";
  return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

const HighlightedText = memo(function HighlightedText({ text, pattern }: { text: string; pattern: RegExp | null }) {
  if (!pattern) return <>{text}</>;
  const parts = text.split(pattern); // odd indexes are the captured matches
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-indigo-200 px-0.5 font-semibold text-indigo-900">
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
});

const ResultRow = memo(function ResultRow({
  seg,
  pattern,
  active,
  onJump,
}: {
  seg: SearchSegment;
  pattern: RegExp | null;
  active: boolean;
  onJump: (seg: SearchSegment) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onJump(seg)}
        aria-current={active ? "true" : undefined}
        className={`flex min-h-[56px] w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors duration-200 motion-reduce:transition-none ${focusRing} ${
          active
            ? "border-emerald-600/50 bg-emerald-100/80"
            : "border-amber-900/10 bg-white/60 hover:border-indigo-500/40 hover:bg-indigo-50 active:bg-indigo-100"
        }`}
      >
        <span
          className={`mt-0.5 shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums ${
            active ? "bg-emerald-600/15 text-emerald-800" : "bg-indigo-600/10 text-indigo-800"
          }`}
        >
          {formatTime(seg.start_sec)}
        </span>
        <span className="min-w-0 flex-1 text-[15px] leading-relaxed text-stone-800">
          <HighlightedText text={seg.text} pattern={pattern} />
        </span>
        {active && <span aria-hidden className="mt-2 h-2 w-2 shrink-0 rounded-full bg-emerald-500 motion-safe:animate-pulse" />}
      </button>
    </li>
  );
});

/**
 * Where the matches are, across the whole video. Emerald shows how much of the video
 * is indexed (useful while a long file is still processing); indigo ticks are matches.
 */
function Timeline({
  duration,
  indexedSec,
  currentTime,
  results,
  activeId,
  onJump,
}: {
  duration: number;
  indexedSec: number;
  currentTime: number;
  results: SearchSegment[];
  activeId: number | null;
  onJump: (seg: SearchSegment) => void;
}) {
  const pct = (sec: number) => `${Math.min(100, Math.max(0, (sec / duration) * 100))}%`;
  return (
    <div className="mt-4">
      <div className="relative h-9">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-amber-900/10">
          <div className="h-full bg-emerald-500/35 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: pct(indexedSec) }} />
        </div>
        <div className="absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-stone-900/80" style={{ left: pct(currentTime) }} aria-hidden />
        {results.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onJump(r)}
            aria-label={`Jump to ${formatTime(r.start_sec)}`}
            className={`group absolute top-0 flex h-full w-3 -translate-x-1/2 items-center justify-center ${focusRing}`}
            style={{ left: pct(r.start_sec) }}
          >
            <span
              className={`block rounded-sm transition-all duration-200 motion-reduce:transition-none ${
                r.id === activeId ? "h-7 w-1 bg-emerald-500" : "h-5 w-[3px] bg-indigo-500 group-hover:h-7 group-hover:bg-indigo-400"
              }`}
            />
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs tabular-nums text-stone-600">
        <span>00:00</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}

function IconUpload() {
  return (
    <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4m0 0L7 9m5-5 5 5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function YoogleHome() {
  const [videos, setVideos] = useState<VideoItem[] | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchSegment[]>([]);
  const [searchedQuery, setSearchedQuery] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const [playerError, setPlayerError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [dragging, setDragging] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<HTMLDivElement | null>(null);

  /* ---- data: polling (fast while something is processing, slow otherwise) ---- */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase()}/api/videos`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setVideos((await res.json()) as VideoItem[]);
      setServerDown(false);
    } catch {
      setServerDown(true);
      setVideos((v) => v ?? []);
    }
  }, []);

  const anyProcessing = !!videos?.some((v) => v.status === "PROCESSING");

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!document.hidden) await refresh();
      if (!stopped) timer = setTimeout(tick, anyProcessing ? 1500 : 8000);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refresh, anyProcessing]);

  useEffect(() => {
    if (!selectedId && videos && videos.length > 0) setSelectedId(videos[0].id);
  }, [videos, selectedId]);

  const selected = useMemo(() => videos?.find((v) => v.id === selectedId) ?? null, [videos, selectedId]);

  const resetForVideo = useCallback(() => {
    setQuery("");
    setResults([]);
    setSearchedQuery("");
    setTruncated(false);
    setSearchError(null);
    setCurrentTime(0);
    setMediaDuration(null);
    setPlayerError(false);
  }, []);

  const selectVideo = useCallback(
    (id: string) => {
      setSelectedId(id);
      resetForVideo();
    },
    [resetForVideo]
  );

  /* ---- upload ---- */
  const handleUploaded = useCallback(
    async (videoId: string) => {
      await refresh();
      selectVideo(videoId);
    },
    [refresh, selectVideo]
  );
  const upload = useVideoUpload(handleUploaded);

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again
    if (file) upload.start(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) upload.start(file);
  };

  const uploading = upload.state?.phase === "uploading" || upload.state?.phase === "finalizing";

  /* ---- search (debounced, cancels stale requests) ---- */
  const canSearch = !!selected && (selected.status === "READY" || selected.processed_sec > 0);

  useEffect(() => {
    const q = query.trim();
    if (!selectedId || !canSearch || q.length < 2) {
      setResults([]);
      setSearchedQuery("");
      setTruncated(false);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`${apiBase()}/api/search?video_id=${selectedId}&q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        setResults(data.results ?? []);
        setTruncated(!!data.truncated);
        setSearchedQuery(q);
        setSearchError(null);
        setSearching(false);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setSearchError("Search failed. Check that the backend is running, then try again.");
        setSearching(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, selectedId, canSearch]);

  const pattern = useMemo(() => buildHighlighter(searchedQuery), [searchedQuery]);

  /* ---- playback ---- */
  const jumpTo = useCallback((seg: SearchSegment) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, seg.start_sec - PREROLL_SEC);
    setCurrentTime(video.currentTime);
    video.play().catch(() => {
      /* autoplay blocked: the video is still positioned correctly */
    });
    // On phones the results sit below the player; bring it into view without moving it on desktop.
    playerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const activeId = useMemo(
    () => results.find((r) => currentTime >= Math.max(0, r.start_sec - PREROLL_SEC - 0.1) && currentTime < r.end_sec)?.id ?? null,
    [results, currentTime]
  );

  const retry = async () => {
    if (!selected) return;
    setRetrying(true);
    try {
      await fetch(`${apiBase()}/api/videos/${selected.id}/retry`, { method: "POST" });
      await refresh();
    } finally {
      setRetrying(false);
    }
  };

  const duration = selected?.duration_sec ?? mediaDuration;
  const indexedSec = selected ? (selected.status === "READY" ? duration ?? 0 : selected.processed_sec) : 0;
  const showTimeline = !!selected && !!duration && (results.length > 0 || selected.status === "PROCESSING");

  /* ---------------------------------------------------------------------- */
  return (
    <div className="min-h-dvh">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-amber-900/10 bg-yellow-50/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-600/10 text-indigo-700 ring-1 ring-indigo-600/25">
              <IconSearch />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold leading-tight tracking-tight text-stone-900">Yoogle</h1>
              <p className="hidden truncate text-xs text-stone-600 sm:block">Search what's said inside your videos</p>
            </div>
          </div>

          <label
            className={`inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition-colors duration-200 hover:bg-indigo-500 active:bg-indigo-700 focus-within:ring-2 focus-within:ring-indigo-400 focus-within:ring-offset-2 focus-within:ring-offset-yellow-50 ${
              uploading ? "pointer-events-none opacity-50" : ""
            }`}
          >
            <IconUpload />
            Upload video
            <input type="file" accept="video/*,.mkv" className="sr-only" onChange={onPickFile} disabled={uploading} />
          </label>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl space-y-4 px-4 py-4 sm:space-y-5 sm:px-6 sm:py-6 lg:px-8">
        {serverDown && (
          <div role="alert" className="rounded-xl border border-rose-600/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-800">
            Can't reach the Yoogle server at {apiBase()}. Start the backend and this page will reconnect on its own.
          </div>
        )}

        {/* Upload progress */}
        {upload.state && (
          <section className={`${glass} p-4 sm:p-5`} aria-live="polite">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-stone-900">{upload.state.name}</p>
                {upload.state.phase === "error" ? (
                  <p className="mt-1 text-sm text-rose-700">{upload.state.error}</p>
                ) : (
                  <p className="mt-1 text-sm tabular-nums text-stone-600">
                    {upload.state.phase === "finalizing"
                      ? "Upload complete. Saving the file…"
                      : `${formatBytes(upload.state.loaded)} of ${formatBytes(upload.state.total)}`}
                  </p>
                )}
              </div>
              {upload.state.phase === "error" ? (
                <button
                  type="button"
                  onClick={upload.dismiss}
                  className={`min-h-[44px] shrink-0 rounded-xl border border-amber-900/15 px-4 text-sm font-medium text-stone-800 hover:bg-amber-100 ${focusRing}`}
                >
                  Dismiss
                </button>
              ) : (
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-lg font-semibold tabular-nums text-indigo-700">
                    {Math.round((upload.state.loaded / Math.max(1, upload.state.total)) * 100)}%
                  </span>
                  {upload.state.phase === "uploading" && (
                    <button
                      type="button"
                      onClick={upload.cancel}
                      className={`min-h-[44px] rounded-xl border border-amber-900/15 px-4 text-sm font-medium text-stone-800 hover:bg-amber-100 ${focusRing}`}
                    >
                      Cancel upload
                    </button>
                  )}
                </div>
              )}
            </div>
            {upload.state.phase !== "error" && (
              <div className="mt-4">
                <ProgressBar tone="indigo" label="Upload progress" value={(upload.state.loaded / Math.max(1, upload.state.total)) * 100} />
              </div>
            )}
          </section>
        )}

        {/* First load */}
        {videos === null && (
          <div className="grid gap-4 lg:grid-cols-12">
            <div className={`${glass} aspect-video animate-pulse lg:col-span-7 xl:col-span-8`} />
            <div className={`${glass} h-72 animate-pulse lg:col-span-5 xl:col-span-4`} />
          </div>
        )}

        {/* Empty state */}
        {videos !== null && videos.length === 0 && !upload.state && (
          <section
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`${glass} flex flex-col items-center px-6 py-14 text-center transition-colors duration-200 sm:py-20 ${
              dragging ? "border-indigo-500/60 bg-indigo-100/70" : "border-dashed border-amber-900/30"
            }`}
          >
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-indigo-600/10 text-indigo-700 ring-1 ring-indigo-600/25">
              <IconUpload />
            </span>
            <h2 className="mt-5 text-xl font-semibold text-stone-900">Make a video searchable</h2>
            <p className="mt-2 max-w-md text-balance text-sm leading-relaxed text-stone-600">
              Drop a video here, or use Upload video. Hours-long files are fine: they upload in a stream and are indexed in the
              background, and you can start searching before it finishes.
            </p>
            <p className="mt-4 text-xs text-stone-500">MP4, MOV, MKV, WebM or AVI</p>
          </section>
        )}

        {/* Video switcher: horizontal scroll on phones, wraps on larger screens */}
        {videos !== null && videos.length > 0 && (
          <nav aria-label="Your videos">
            <ul className="no-scrollbar -mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
              {videos.map((v) => {
                const isActive = v.id === selectedId;
                return (
                  <li key={v.id} className="shrink-0 snap-start">
                    <button
                      type="button"
                      onClick={() => selectVideo(v.id)}
                      aria-current={isActive ? "true" : undefined}
                      title={v.title}
                      className={`flex min-h-[44px] max-w-[70vw] items-center gap-2.5 rounded-full border px-4 text-sm transition-colors duration-200 motion-reduce:transition-none sm:max-w-xs ${focusRing} ${
                        isActive
                          ? "border-indigo-500/60 bg-indigo-100 text-indigo-900"
                          : "border-amber-900/15 bg-white/60 text-stone-700 hover:border-amber-900/30 hover:bg-white"
                      }`}
                    >
                      <StatusDot status={v.status} />
                      <span className="truncate">{v.title}</span>
                      {v.status === "PROCESSING" && (
                        <span className="shrink-0 text-xs font-semibold tabular-nums text-amber-800">{Math.round(v.progress_pct)}%</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        {/* Stacked on phones/tablets, split view from lg */}
        {selected && (
          <div className="grid gap-4 sm:gap-5 lg:grid-cols-12 lg:gap-6">
            {/* Player column */}
            <div className="min-w-0 space-y-4 lg:col-span-7 xl:col-span-8">
              <section className={`${glass} p-3 sm:p-5`}>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-stone-900 sm:text-lg" title={selected.title}>
                    {selected.title}
                  </h2>
                  <StatusBadge status={selected.status} />
                </div>

                <div
                  ref={playerRef}
                  className="relative aspect-video w-full overflow-hidden rounded-xl bg-black ring-1 ring-amber-900/20 lg:max-h-[68vh]"
                >
                  <video
                    key={selected.id}
                    ref={videoRef}
                    src={`${apiBase()}${selected.file_path}`}
                    controls
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-contain"
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    onLoadedMetadata={(e) => setMediaDuration(e.currentTarget.duration)}
                    onError={() => setPlayerError(true)}
                  />
                  {playerError && (
                    <div className="absolute inset-0 grid place-items-center bg-stone-950/90 p-6 text-center">
                      <p className="max-w-sm text-sm leading-relaxed text-stone-200">
                        Your browser can't play this file format. Search still works. Use an MP4 or WebM file if you want to jump to
                        moments in the player.
                      </p>
                    </div>
                  )}
                </div>

                {showTimeline && duration && (
                  <Timeline
                    duration={duration}
                    indexedSec={indexedSec}
                    currentTime={currentTime}
                    results={results}
                    activeId={activeId}
                    onJump={jumpTo}
                  />
                )}
              </section>

              {/* Live transcription progress */}
              {selected.status === "PROCESSING" && (
                <section className={`${glass} p-4 sm:p-5`} aria-live="polite">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-semibold text-stone-900">{selected.stage || "Starting"}</p>
                    <span className="shrink-0 text-lg font-semibold tabular-nums text-emerald-700">{Math.round(selected.progress_pct)}%</span>
                  </div>
                  <div className="mt-3">
                    <ProgressBar label="Transcription progress" value={selected.progress_pct} />
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-stone-600">
                    {selected.processed_sec > 0
                      ? `The first ${formatTime(selected.processed_sec)} are already searchable. More is added as each chunk finishes.`
                      : "Search opens as soon as the first chunk is indexed. You can close this tab; processing continues on the server."}
                  </p>
                </section>
              )}

              {selected.status === "FAILED" && (
                <section className="rounded-2xl border border-rose-600/30 bg-rose-500/10 p-4 sm:p-5" role="alert">
                  <p className="text-sm font-semibold text-rose-800">Processing stopped</p>
                  <p className="mt-1 break-words text-sm leading-relaxed text-rose-900/80">{selected.error_msg || "Something went wrong."}</p>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={retry}
                      disabled={retrying}
                      className={`min-h-[44px] rounded-xl bg-rose-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-rose-500 disabled:opacity-50 ${focusRing}`}
                    >
                      {retrying ? "Retrying…" : "Retry processing"}
                    </button>
                    {selected.processed_sec > 0 && (
                      <span className="text-sm text-rose-900/70">Continues from {formatTime(selected.processed_sec)}. Finished parts are kept.</span>
                    )}
                  </div>
                </section>
              )}
            </div>

            {/* Search column */}
            <aside className="min-w-0 lg:col-span-5 xl:col-span-4">
              <section className={`${glass} flex flex-col p-4 sm:p-5 lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7.5rem)]`}>
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <h3 className="text-base font-semibold text-stone-900">Search this video</h3>
                  {searchedQuery && !searching && (
                    <span className="text-sm tabular-nums text-stone-600">
                      {results.length}
                      {truncated ? "+" : ""} {results.length === 1 ? "match" : "matches"}
                    </span>
                  )}
                </div>

                <div className="relative">
                  <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-500">
                    <IconSearch />
                  </span>
                  <input
                    type="search"
                    inputMode="search"
                    enterKeyHint="search"
                    autoComplete="off"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    disabled={!canSearch}
                    placeholder={canSearch ? "A word or phrase said in the video" : "Available once the first chunk is indexed"}
                    aria-label="Search spoken words"
                    className="min-h-[48px] w-full rounded-xl border border-amber-900/20 bg-white py-2 pl-11 pr-4 text-base text-stone-900 placeholder:text-stone-500 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 disabled:opacity-50 sm:text-sm"
                  />
                </div>

                {selected.status === "PROCESSING" && selected.processed_sec > 0 && (
                  <p className="mt-3 text-xs leading-relaxed text-amber-800">
                    Searching the first {formatTime(selected.processed_sec)} so far. Search again later to include the rest.
                  </p>
                )}

                <div className="mt-4 min-h-0 flex-1">
                  {searchError && (
                    <p role="alert" className="text-sm text-rose-700">
                      {searchError}
                    </p>
                  )}

                  {!searchError && searching && <p className="text-sm text-stone-600">Searching…</p>}

                  {!searchError && !searching && !searchedQuery && canSearch && (
                    <p className="text-sm leading-relaxed text-stone-500">
                      Type at least two letters. Tap a result to play from just before that moment.
                    </p>
                  )}

                  {!searchError && !searching && searchedQuery && results.length === 0 && (
                    <p className="text-sm leading-relaxed text-stone-600">
                      No matches for “{searchedQuery}”. Try fewer words or a different spelling.
                    </p>
                  )}

                  {results.length > 0 && (
                    <ul className="slim-scrollbar max-h-[55dvh] space-y-2 overflow-y-auto overscroll-contain pr-1 lg:max-h-[calc(100dvh-19rem)]">
                      {results.map((seg) => (
                        <ResultRow key={seg.id} seg={seg} pattern={pattern} active={seg.id === activeId} onJump={jumpTo} />
                      ))}
                      {truncated && (
                        <li className="px-1 pt-1 text-xs text-stone-500">Showing the first {results.length} matches. Add a word to narrow it down.</li>
                      )}
                    </ul>
                  )}
                </div>
              </section>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
