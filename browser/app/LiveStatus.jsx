import React, { useEffect, useRef, useState } from "react";
import { getJson } from "./api.js";
import { formatClock } from "./format.js";

// If the collector hasn't reported for this long while "caught up" (it
// reports every 2 minutes), treat it as offline rather than counting down
// to a fetch that won't happen.
const STALE_MS = 10 * 60_000;
// How soon after the scheduled fetch to look for new replays (the fetch
// itself takes a few seconds).
const AFTER_FETCH_MS = 5_000;
// While the collector is pulling a backlog, check this often.
const FETCHING_POLL_MS = 8_000;
// Never wait longer than this between checks (e.g. during a long rate-limit
// pause), so a restarted collector shows up promptly.
const MAX_POLL_MS = 60_000;

function timeAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} hr${h === 1 ? "" : "s"} ago`;
}

/**
 * Live strip on the homepage: when the replay collector will next fetch from
 * bonk.io, a countdown to it, and what the last fetch added. When new
 * replays land it calls onNew(count) so the page can refresh its list.
 *
 * `since` is the newest replay the page is showing ({cycle, id}); new
 * replays are counted from there.
 */
export default function LiveStatus({ since, onNew }) {
  const [status, setStatus] = useState(null);
  const [offset, setOffset] = useState(0); // server clock − browser clock
  const [now, setNow] = useState(() => Date.now());
  const [checking, setChecking] = useState(false);
  const sinceRef = useRef(since);
  sinceRef.current = since;
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;
  const timer = useRef(null);

  // One check: read status, report new replays, schedule the next check.
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    async function check() {
      clearTimeout(timer.current);
      if (document.hidden) return; // resumes on visibilitychange
      setChecking(true);
      try {
        const s = sinceRef.current;
        const q = s ? `?since_cycle=${s.cycle}&since_id=${s.id}` : "";
        const data = await getJson(`/api/status${q}`, { signal: ctrl.signal });
        if (cancelled) return;
        setOffset(Date.parse(data.server_now) - Date.now());
        setStatus(data);
        if (data.added_since > 0) onNewRef.current?.(data.added_since);
        schedule(data);
      } catch (err) {
        if (err.name !== "AbortError" && !cancelled) {
          timer.current = setTimeout(check, MAX_POLL_MS);
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    function schedule(data) {
      let wait = MAX_POLL_MS;
      if (data.status === "fetching") {
        wait = FETCHING_POLL_MS;
      } else if (data.next_fetch_at) {
        const until = Date.parse(data.next_fetch_at) - Date.parse(data.server_now);
        wait = Math.min(Math.max(until + AFTER_FETCH_MS, 3_000), MAX_POLL_MS);
      }
      timer.current = setTimeout(check, wait);
    }

    const onVisible = () => !document.hidden && check();
    document.addEventListener("visibilitychange", onVisible);
    check();

    return () => {
      cancelled = true;
      ctrl.abort();
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Tick once a second for the countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Collector not reporting yet (older scraper deployed): show nothing.
  if (!status || !status.status) return null;

  const serverNow = now + offset;
  const next = status.next_fetch_at ? Date.parse(status.next_fetch_at) : null;
  const reportedAt = status.status_at ? Date.parse(status.status_at) : null;
  const remaining = next != null ? next - serverNow : null;
  const stale = reportedAt != null && serverNow - reportedAt > STALE_MS;

  // Progress through the current wait (for the thin bar under the strip)
  const total = next != null && reportedAt != null ? next - reportedAt : null;
  const progress =
    total > 0 && remaining != null ? Math.min(1, Math.max(0, 1 - remaining / total)) : null;

  let state = status.status;
  if (stale) state = "offline";

  let headline;
  switch (state) {
    case "fetching":
      headline = "Fetching new replays from bonk.io…";
      break;
    case "rate_limited":
      headline =
        remaining > 0
          ? `Paused by bonk.io's rate limit · resumes in ${formatClock(remaining / 1000)}`
          : "Resuming after bonk.io's rate limit…";
      break;
    case "retrying":
      headline =
        remaining > 0 ? `Reconnecting to bonk.io · retry in ${formatClock(remaining / 1000)}` : "Reconnecting…";
      break;
    case "offline":
      headline = "Replay collector isn't reporting right now";
      break;
    default:
      headline =
        remaining > 0 ? (
          <>
            Next fetch in <span className="live__clock">{formatClock(remaining / 1000)}</span>
          </>
        ) : (
          "Checking for new replays…"
        );
  }

  const lastRun =
    status.last_run_at && status.last_run_added != null
      ? `Last fetch added ${status.last_run_added.toLocaleString()} replay${status.last_run_added === 1 ? "" : "s"} · ${timeAgo(serverNow - Date.parse(status.last_run_at))}`
      : null;

  return (
    <div className={`live live--${state}`} aria-busy={checking || undefined}>
      <div className="live__row">
        <span className="live__dot" aria-hidden="true" />
        {/* Countdown text changes every second, so it isn't a live region;
            new replays are announced by the page instead. */}
        <span className="live__headline">{headline}</span>
        {lastRun && <span className="live__last">{lastRun}</span>}
      </div>
      {progress != null && state === "caught_up" && (
        <div className="live__bar" aria-hidden="true">
          <div style={{ transform: `scaleX(${progress})` }} />
        </div>
      )}
    </div>
  );
}
