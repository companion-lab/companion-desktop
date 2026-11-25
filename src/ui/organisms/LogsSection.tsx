import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SectionCard } from "../molecules/SectionCard";

type LogEntry = {
  /** Epoch millis (Rust side). */
  ts: number;
  level: string;
  /** Emitting webview label ("main", "settings", "web"). */
  source: string;
  message: string;
};

type LevelFilter = "all" | "info" | "warn" | "error";

const LEVELS: LevelFilter[] = ["all", "info", "warn", "error"];
// Matches the Rust sink's ring buffer cap — anything past this is gone from
// the backend anyway, so capping the local list keeps memory bounded too.
const MAX_ENTRIES = 2000;

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Clipboard on http origins (no async clipboard API) with a textarea fallback. */
function copyText(text: string): void {
  if (navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}

function fallbackCopy(text: string): void {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(area);
  }
}

function fmtEntry(e: LogEntry): string {
  return `[${fmtTime(e.ts)}] [${e.level}] [${e.source}] ${e.message}`;
}

/**
 * Settings > Logs: a live view of the app's console output (every webview's
 * console — main, settings, plugin frontends — funnels into the Rust sink
 * this panel reads; see app/src/logs.ts). Filter by level, search, copy the
 * current view out. Logs recorded before this window opened are included —
 * the sink is shared and ring-buffered, not this panel's state.
 */
export function LogsSection() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Follow the tail until the user scrolls up to read history; scrolling
  // back near the bottom re-arms it.
  const stickRef = useRef(true);

  // Initial snapshot + live tail.
  useEffect(() => {
    let alive = true;
    let unlisteners: (() => void)[] = [];
    invoke<LogEntry[]>("log_recent")
      .then((recent) => {
        if (alive) setEntries(recent);
      })
      .catch(() => {
        /* no sink (plain browser dev run): panel stays empty */
      });
    listen<LogEntry>("log-entry", (e) => {
      setEntries((prev) => {
        const trimmed =
          prev.length >= MAX_ENTRIES ? prev.slice(prev.length - MAX_ENTRIES + 1) : prev;
        return [...trimmed, e.payload];
      });
    })
      .then((fn) => {
        unlisteners.push(fn);
      })
      .catch(() => {});
    listen("log-cleared", () => {
      setEntries([]);
    })
      .then((fn) => {
        unlisteners.push(fn);
      })
      .catch(() => {});
    return () => {
      alive = false;
      for (const fn of unlisteners) fn();
      unlisteners = [];
    };
  }, []);

  // Keep the tail visible while following.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, filter, query]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (filter === "all" || e.level === filter) &&
        (!q || e.message.toLowerCase().includes(q) || e.source.toLowerCase().includes(q)),
    );
  }, [entries, filter, query]);

  const clear = () => {
    invoke("log_clear").catch(() => {});
    setEntries([]);
  };

  const copyAll = () => {
    copyText(filtered.map(fmtEntry).join("\n") || "(no log lines)");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <SectionCard
      title="Logs"
      badge={`${filtered.length}/${entries.length}`}
      action={
        <div className="st-logs-actions">
          <button type="button" className="preset-btn" onClick={copyAll}>
            {copied ? "Copied" : "Copy view"}
          </button>
          <button type="button" className="preset-btn" onClick={clear}>
            Clear
          </button>
        </div>
      }
    >
      <div className="st-logs-controls">
        <div className="st-logs-levels" role="group" aria-label="Level filter">
          {LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              className={`preset-btn${filter === l ? " preset-btn-active" : ""}`}
              onClick={() => setFilter(l)}
            >
              {l}
            </button>
          ))}
        </div>
        <input
          type="text"
          className="st-logs-search"
          placeholder="Filter by text…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="st-logs-scroller" ref={scrollerRef} onScroll={onScroll}>
        {filtered.length === 0 ? (
          <span className="st-field-hint">
            {entries.length === 0
              ? "Nothing logged yet — lines appear here as the app and plugins run."
              : "No lines match the current filter."}
          </span>
        ) : (
          filtered.map((e, i) => (
            <div key={i} className={`st-logs-line st-logs-${e.level}`}>
              <span className="st-logs-meta">
                {fmtTime(e.ts)} {e.source} {e.level}
              </span>
              <span className="st-logs-msg">{e.message}</span>
            </div>
          ))
        )}
      </div>
      <span className="st-field-hint">
        Console output from every window and plugin (ring buffer, newest {MAX_ENTRIES} lines).
      </span>
    </SectionCard>
  );
}
