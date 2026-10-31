// Pure check state machine. No I/O: every function takes the current check and a
// timestamp and returns the patch to persist, an optional event to log, and an
// optional transition that should trigger an alert. This keeps the logic testable.
import { nextRun, parseCron } from "./cron";

export type Status = "new" | "up" | "late" | "down" | "paused";
export type Kind = "heartbeat" | "http";
export type Signal = "success" | "start" | "fail";

export interface Check {
  id: string;
  kind: Kind;
  status: Status;
  period_s: number;
  grace_s: number;
  cron: string | null;
  url: string | null;
  interval_s: number;
  expect_status: number;
  last_ping_at: number | null;
  due_at: number | null;
  started_at: number | null;
  last_duration_ms: number | null;
  fail_streak: number;
  created_at: number;
}

export interface Outcome {
  patch: Partial<Check>;
  event?: { kind: string; detail?: string };
  transition?: "up" | "down";
}

/** Consecutive failed probes before an HTTP check is marked down (flap damping). */
export const PROBE_FAILS_TO_DOWN = 2;

export function nextDue(c: Pick<Check, "kind" | "cron" | "period_s" | "interval_s">, from: number): number {
  if (c.kind === "http") return from + c.interval_s * 1000;
  if (c.cron) return nextRun(parseCron(c.cron), from);
  return from + c.period_s * 1000;
}

export function applyPing(c: Check, signal: Signal, now: number, detail?: string): Outcome {
  if (signal === "start") {
    return { patch: { started_at: now }, event: { kind: "start", detail } };
  }
  const duration = c.started_at !== null && now - c.started_at < 86400_000 ? now - c.started_at : null;
  const base: Partial<Check> = {
    last_ping_at: now,
    started_at: null,
    last_duration_ms: duration,
    due_at: nextDue(c, now),
  };
  // State-changing pings are logged as "up"/"down" so uptime can be rebuilt from transitions alone.
  if (signal === "fail") {
    const goesDown = c.status !== "down";
    return {
      patch: { ...base, status: "down" },
      event: { kind: goesDown ? "down" : "fail", detail: detail || "job reported failure" },
      transition: goesDown ? "down" : undefined,
    };
  }
  const recovers = c.status === "down";
  return {
    patch: { ...base, status: "up" },
    event: { kind: recovers ? "up" : "ping", detail },
    transition: recovers ? "up" : undefined,
  };
}

/** Called by the minute sweep for heartbeat checks whose deadline passed. Returns null when nothing changes. */
export function sweepHeartbeat(c: Check, now: number): Outcome | null {
  if (c.kind !== "heartbeat" || c.due_at === null) return null;
  if (c.status !== "up" && c.status !== "late") return null;
  if (now >= c.due_at + c.grace_s * 1000) {
    return { patch: { status: "down" }, event: { kind: "down", detail: "no ping received" }, transition: "down" };
  }
  if (now >= c.due_at && c.status === "up") {
    return { patch: { status: "late" }, event: { kind: "late" } };
  }
  return null;
}

export function applyProbe(c: Check, ok: boolean, now: number, latencyMs: number | null, detail?: string): Outcome {
  const due_at = now + c.interval_s * 1000;
  if (ok) {
    const wasDown = c.status === "down";
    return {
      patch: { due_at, fail_streak: 0, status: "up", last_ping_at: now, last_duration_ms: latencyMs },
      // Only transitions are logged for probes; a log row per healthy probe would burn D1 writes.
      event: wasDown ? { kind: "up" } : undefined,
      transition: wasDown ? "up" : undefined,
    };
  }
  const streak = c.fail_streak + 1;
  const goesDown = streak >= PROBE_FAILS_TO_DOWN && c.status !== "down";
  return {
    patch: { due_at, fail_streak: streak, last_duration_ms: latencyMs, ...(goesDown ? { status: "down" as Status } : {}) },
    event: goesDown ? { kind: "down", detail } : { kind: "probe_fail", detail },
    transition: goesDown ? "down" : undefined,
  };
}

export interface Transition {
  at: number;
  to: "up" | "down";
}

export interface DayBucket {
  day: string; // YYYY-MM-DD (UTC)
  uptime: number | null; // 0..1, null = check did not exist yet
  downMs: number;
}

/**
 * Per-day uptime from a sorted list of up/down transitions.
 * `downAtStart` is the state just before `from` (from the last transition before the window).
 */
export function uptimeByDay(
  transitions: Transition[],
  downAtStart: boolean,
  createdAt: number,
  now: number,
  days: number,
): DayBucket[] {
  const dayMs = 86400_000;
  const todayStart = Math.floor(now / dayMs) * dayMs;
  const from = todayStart - (days - 1) * dayMs;

  // Build closed down-intervals clipped to [from, now].
  const downs: [number, number][] = [];
  let down = downAtStart;
  let since = from;
  for (const t of transitions) {
    if (t.at < from) continue;
    if (t.at > now) break;
    if (t.to === "down" && !down) {
      down = true;
      since = t.at;
    } else if (t.to === "up" && down) {
      downs.push([since, t.at]);
      down = false;
    }
  }
  if (down) downs.push([since, now]);

  const out: DayBucket[] = [];
  for (let i = 0; i < days; i++) {
    const start = from + i * dayMs;
    const end = Math.min(start + dayMs, now);
    const observedStart = Math.max(start, createdAt);
    const day = new Date(start).toISOString().slice(0, 10);
    if (observedStart >= end) {
      out.push({ day, uptime: null, downMs: 0 });
      continue;
    }
    let downMs = 0;
    for (const [a, b] of downs) {
      const lo = Math.max(a, observedStart);
      const hi = Math.min(b, end);
      if (hi > lo) downMs += hi - lo;
    }
    out.push({ day, uptime: 1 - downMs / (end - observedStart), downMs });
  }
  return out;
}
