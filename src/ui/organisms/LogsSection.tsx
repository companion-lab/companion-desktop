import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

type Level = "info" | "warn" | "error";

const LEVELS: Level[] = ["info", "warn", "error"];
// Matches the Rust sink's ring buffer cap — anything past this is gone from
// the backend anyway, so capping the local list keeps memory bounded too.
const MAX_ENTRIES = 2000;
// Don't pretty-print JSON blobs beyond this (LLM request dumps can be big).
const MAX_JSON_DETAIL = 100_000;

/** The sink only carries info/warn/error; anything else renders as info. */
function normalizeLevel(level: string): Level {
  return level === "warn" || level === "error" ? level : "info";
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Absolute, copy-friendly timestamp for the expanded detail view. */
function fmtFull(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${fmtTime(ts)}`;
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

/** Pretty-print when a line is JSON — request/response dumps read far better. */
function prettyDetail(message: string): string {
  const t = message.trim();
  if ((t.startsWith("{") || t.startsWith("[")) && t.length <= MAX_JSON_DETAIL) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON — render raw */
    }
  }
  return message;
}

/** Case-insensitive substring highlighting for the search box. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(q);
  while (at !== -1) {
    if (at > from) out.push(text.slice(from, at));
    out.push(
      <mark key={out.length} className="st-logs-mark">
        {text.slice(at, at + q.length)}
      </mark>,
    );
    from = at + q.length;
    at = lower.indexOf(q, from);
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

function CopyIcon() {
  return (
    <svg className="st-logs-copyicon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
    </svg>
  );
}

function ChevIcon() {
  return (
    <svg className="st-logs-chev" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/**
 * Settings > Logs: a Grafana-style live view of the app's console output.
 * Every webview's console — main, settings, plugin frontends — funnels into
 * the Rust sink this panel reads (see app/src/logs.ts). Errors are tinted and
 * every row expands into a detail view (stack traces, pretty-printed JSON,
 * absolute time), levels are one-click filters with live counts, and the
 * tail can be paused. Logs recorded before this window opened are included —
 * the sink is shared and ring-buffered, not this panel's state.
 */
export function LogsSection() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [levels, setLevels] = useState<Record<Level, boolean>>({
    info: true,
    warn: true,
    error: true,
  });
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  // Mirrors stickRef for the Live/Paused indicator and jump button.
  const [following, setFollowing] = useState(true);
  // Expanded rows, by entry object identity (entries are appended once).
  const [expanded, setExpanded] = useState<Set<LogEntry>>(() => new Set());
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
      setExpanded(new Set());
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

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (stick !== stickRef.current) {
      stickRef.current = stick;
      setFollowing(stick);
    }
  };

  const jumpToLatest = () => {
    stickRef.current = true;
    setFollowing(true);
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const counts = useMemo(() => {
    const c: Record<Level, number> = { info: 0, warn: 0, error: 0 };
    for (const e of entries) c[normalizeLevel(e.level)]++;
    return c;
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) =>
        levels[normalizeLevel(e.level)] &&
        (!q || e.message.toLowerCase().includes(q) || e.source.toLowerCase().includes(q)),
    );
  }, [entries, levels, query]);

  // Keep the tail visible while following (entry tail, wrap toggle, filters).
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [filtered, wrap]);

  const toggleLevel = (l: Level) => {
    setLevels((prev) => ({ ...prev, [l]: !prev[l] }));
  };

  const allActive = levels.info && levels.warn && levels.error;

  const toggleExpanded = (e: LogEntry) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });
  };

  // Clicking a row expands it — unless the user is selecting text to copy.
  const onRowClick = (e: LogEntry) => {
    if (window.getSelection()?.toString()) return;
    toggleExpanded(e);
  };

  const clear = () => {
    invoke("log_clear").catch(() => {});
    setEntries([]);
    setExpanded(new Set());
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
      <div className="st-logs-chiprow" role="group" aria-label="Level filter">
        <button
          type="button"
          className={`st-logs-chip st-logs-chip-all${allActive ? " st-logs-chip-on" : ""}`}
          onClick={() => setLevels({ info: true, warn: true, error: true })}
        >
          all
        </button>
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            className={`st-logs-chip st-logs-chip-${l}${levels[l] ? " st-logs-chip-on" : ""}`}
            onClick={() => toggleLevel(l)}
          >
            {l}
            <span className="st-logs-chip-count">{counts[l]}</span>
          </button>
        ))}
      </div>
      <div className="st-logs-controls">
        <input
          type="text"
          className="st-logs-search"
          placeholder="Filter by text…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
        />
        <button
          type="button"
          className={`preset-btn st-logs-tool${wrap ? " preset-btn-active" : ""}`}
          onClick={() => setWrap((w) => !w)}
        >
          Wrap
        </button>
      </div>
      <div className="st-logs-scroller" ref={scrollerRef} onScroll={onScroll}>
        {filtered.length === 0 ? (
          <span className="st-field-hint">
            {entries.length === 0
              ? "Nothing logged yet — lines appear here as the app and plugins run."
              : "No lines match the current filter."}
          </span>
        ) : (
          filtered.map((e, i) => {
            const lvl = normalizeLevel(e.level);
            const isOpen = expanded.has(e);
            return (
              <Fragment key={i}>
                <div
                  className={`st-logs-line st-logs-${lvl}${isOpen ? " st-logs-open" : ""}`}
                  role="button"
                  aria-expanded={isOpen}
                  tabIndex={0}
                  onClick={() => onRowClick(e)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      onRowClick(e);
                    }
                  }}
                >
                  <ChevIcon />
                  <span className="st-logs-ts">{fmtTime(e.ts)}</span>
                  <span className="st-logs-level">{lvl}</span>
                  <span className="st-logs-src" title={e.source}>
                    {e.source}
                  </span>
                  <span className={`st-logs-msg${wrap ? "" : " st-logs-msg-nowrap"}`}>
                    {highlight(e.message, query)}
                  </span>
                  <button
                    type="button"
                    className="st-logs-copy"
                    aria-label="Copy entry"
                    title="Copy entry"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      copyText(fmtEntry(e));
                    }}
                  >
                    <CopyIcon />
                  </button>
                </div>
                {isOpen && (
                  <div className={`st-logs-detail st-logs-detail-${lvl}`}>
                    <div className="st-logs-detail-meta">
                      <span>
                        <span className="st-logs-detail-k">time</span>
                        {fmtFull(e.ts)}
                      </span>
                      <span>
                        <span className="st-logs-detail-k">level</span>
                        {e.level}
                      </span>
                      <span>
                        <span className="st-logs-detail-k">source</span>
                        {e.source}
                      </span>
                      <span>
                        <span className="st-logs-detail-k">chars</span>
                        {e.message.length}
                      </span>
                    </div>
                    <pre className="st-logs-detail-msg">{prettyDetail(e.message)}</pre>
                  </div>
                )}
              </Fragment>
            );
          })
        )}
      </div>
      <div className="st-logs-status">
        <span className={`st-logs-live${following ? " st-logs-live-on" : ""}`}>
          <span className="st-logs-livedot" />
          {following ? "live" : "paused"}
        </span>
        <span className="st-logs-status-text">
          showing {filtered.length} of {entries.length} · ring buffer keeps newest {MAX_ENTRIES}
        </span>
        {!following && entries.length > 0 && (
          <button type="button" className="st-logs-jump" onClick={jumpToLatest}>
            ↓ latest
          </button>
        )}
      </div>
    </SectionCard>
  );
}
