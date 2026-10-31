import { describe, expect, it } from "vitest";
import { applyPing, applyProbe, sweepHeartbeat, uptimeByDay, type Check } from "../src/monitor";

const MIN = 60_000;
const T0 = Date.parse("2026-06-01T12:00:00Z");

function hb(over: Partial<Check> = {}): Check {
  return {
    id: "x", kind: "heartbeat", status: "new", period_s: 3600, grace_s: 300, cron: null, url: null,
    interval_s: 300, expect_status: 200, last_ping_at: null, due_at: null, started_at: null,
    last_duration_ms: null, fail_streak: 0, created_at: T0, ...over,
  };
}

const merge = (c: Check, patch: Partial<Check>) => ({ ...c, ...patch });

describe("heartbeat lifecycle", () => {
  it("new -> up on first ping, no alert", () => {
    const out = applyPing(hb(), "success", T0);
    expect(out.patch.status).toBe("up");
    expect(out.patch.due_at).toBe(T0 + 3600_000);
    expect(out.transition).toBeUndefined();
  });

  it("goes late after the period, down after the grace, and alerts once", () => {
    let c = merge(hb(), applyPing(hb(), "success", T0).patch);
    expect(sweepHeartbeat(c, T0 + 59 * MIN)).toBeNull();
    const late = sweepHeartbeat(c, T0 + 61 * MIN)!;
    expect(late.patch.status).toBe("late");
    expect(late.transition).toBeUndefined();
    c = merge(c, late.patch);
    const down = sweepHeartbeat(c, T0 + 66 * MIN)!;
    expect(down.transition).toBe("down");
    c = merge(c, down.patch);
    expect(sweepHeartbeat(c, T0 + 90 * MIN)).toBeNull(); // no repeat alert
  });

  it("recovers with an up alert on the next ping", () => {
    const c = hb({ status: "down", due_at: T0 });
    const out = applyPing(c, "success", T0 + MIN);
    expect(out.transition).toBe("up");
    expect(out.event?.kind).toBe("up");
  });

  it("measures run duration between /start and success", () => {
    const started = merge(hb({ status: "up" }), applyPing(hb({ status: "up" }), "start", T0).patch);
    const done = applyPing(started, "success", T0 + 42_000);
    expect(done.patch.last_duration_ms).toBe(42_000);
    expect(done.patch.started_at).toBeNull();
  });

  it("explicit /fail alerts once, repeated fails stay quiet", () => {
    const first = applyPing(hb({ status: "up" }), "fail", T0, "exit code 1");
    expect(first.transition).toBe("down");
    expect(first.event).toEqual({ kind: "down", detail: "exit code 1" });
    const again = applyPing(hb({ status: "down" }), "fail", T0 + MIN);
    expect(again.transition).toBeUndefined();
    expect(again.event?.kind).toBe("fail");
  });

  it("schedules the deadline from the cron expression", () => {
    const c = hb({ cron: "0 3 * * *" });
    const out = applyPing(c, "success", Date.parse("2026-06-01T03:00:05Z"));
    expect(new Date(out.patch.due_at!).toISOString()).toBe("2026-06-02T03:00:00.000Z");
  });

  it("never alerts for paused or new checks in the sweep", () => {
    expect(sweepHeartbeat(hb({ status: "paused", due_at: T0 }), T0 + 999 * MIN)).toBeNull();
    expect(sweepHeartbeat(hb({ status: "new", due_at: T0 }), T0 + 999 * MIN)).toBeNull();
  });
});

describe("http probes", () => {
  const http = (over: Partial<Check> = {}) => hb({ kind: "http", url: "https://x.test", status: "up", ...over });

  it("needs two consecutive failures before going down (flap damping)", () => {
    const one = applyProbe(http(), false, T0, null, "HTTP 503");
    expect(one.transition).toBeUndefined();
    expect(one.patch.fail_streak).toBe(1);
    const two = applyProbe(http({ fail_streak: 1 }), false, T0 + 5 * MIN, null, "HTTP 503");
    expect(two.transition).toBe("down");
  });

  it("a success resets the streak", () => {
    const out = applyProbe(http({ fail_streak: 1 }), true, T0, 120);
    expect(out.patch.fail_streak).toBe(0);
    expect(out.event).toBeUndefined();
  });

  it("recovers from down with an up alert", () => {
    const out = applyProbe(http({ status: "down", fail_streak: 4 }), true, T0, 80);
    expect(out.transition).toBe("up");
  });

  it("random probe sequences alert exactly on state edges", () => {
    // Fuzz: alternating up/down alerts, never two of the same in a row.
    let seed = 7;
    let c = http({ status: "new" });
    let lastAlert: string | undefined;
    for (let i = 0; i < 2000; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      const ok = seed % 3 !== 0;
      const out = applyProbe(c, ok, T0 + i * MIN, 10);
      if (out.transition) {
        expect(out.transition).not.toBe(lastAlert);
        lastAlert = out.transition;
      }
      c = merge(c, out.patch);
      if (c.status === "down") expect(c.fail_streak).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("uptimeByDay", () => {
  const day = 86400_000;
  const now = Date.parse("2026-06-10T12:00:00Z");

  it("marks days before creation as null and computes partial days", () => {
    const created = Date.parse("2026-06-09T00:00:00Z");
    const b = uptimeByDay([], false, created, now, 3);
    expect(b.map((x) => x.uptime)).toEqual([null, 1, 1]);
  });

  it("splits an outage across midnight", () => {
    const created = Date.parse("2026-06-01T00:00:00Z");
    const tr = [
      { at: Date.parse("2026-06-08T23:00:00Z"), to: "down" as const },
      { at: Date.parse("2026-06-09T01:00:00Z"), to: "up" as const },
    ];
    const b = uptimeByDay(tr, false, created, now, 3);
    expect(b[0].downMs).toBe(3600_000);
    expect(b[1].downMs).toBe(3600_000);
    expect(b[1].uptime).toBeCloseTo(1 - 1 / 24);
    expect(b[2].uptime).toBe(1);
  });

  it("an ongoing outage runs until now, and state before the window carries in", () => {
    const created = now - 30 * day;
    const b = uptimeByDay([], true, created, now, 2);
    expect(b[0].uptime).toBe(0);
    expect(b[1].uptime).toBe(0);
    expect(b[1].downMs).toBe(12 * 3600_000);
  });
});
