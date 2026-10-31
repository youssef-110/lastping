import { describe, expect, it } from "vitest";
import { CronError, nextRun, nextRuns, parseCron } from "../src/cron";

const t = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe("parseCron", () => {
  it("parses lists, ranges, steps and names", () => {
    const s = parseCron("*/15 9-17 * jan-mar mon,wed,fri");
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect(s.hours.size).toBe(9);
    expect([...s.months]).toEqual([1, 2, 3]);
    expect([...s.dows]).toEqual([1, 3, 5]);
  });

  it("treats 7 as Sunday and expands macros", () => {
    expect([...parseCron("0 0 * * 7").dows]).toEqual([0]);
    expect([...parseCron("@hourly").minutes]).toEqual([0]);
  });

  it("supports start/step like 5/20", () => {
    expect([...parseCron("5/20 * * * *").minutes]).toEqual([5, 25, 45]);
  });

  it.each(["* * * *", "60 * * * *", "* 24 * * *", "5-1 * * * *", "*/0 * * * *", "a * * * *", "1,,2 * * * *", "* * 0 * *"])(
    "rejects %s",
    (expr) => expect(() => parseCron(expr)).toThrow(CronError),
  );
});

describe("nextRun", () => {
  it("finds the next minute strictly after the given time", () => {
    expect(iso(nextRun(parseCron("* * * * *"), t("2026-01-01T10:00:00Z")))).toBe("2026-01-01T10:01:00.000Z");
    expect(iso(nextRun(parseCron("* * * * *"), t("2026-01-01T10:00:30Z")))).toBe("2026-01-01T10:01:00.000Z");
  });

  it("rolls over hours, days, months and years", () => {
    expect(iso(nextRun(parseCron("30 3 * * *"), t("2026-12-31T04:00:00Z")))).toBe("2027-01-01T03:30:00.000Z");
    expect(iso(nextRun(parseCron("0 0 1 * *"), t("2026-01-31T12:00:00Z")))).toBe("2026-02-01T00:00:00.000Z");
  });

  it("handles leap days", () => {
    expect(iso(nextRun(parseCron("0 12 29 2 *"), t("2026-03-01T00:00:00Z")))).toBe("2028-02-29T12:00:00.000Z");
  });

  it("uses OR semantics when both day fields are restricted (Vixie cron)", () => {
    // 2026-11-01 is a Sunday. "on the 15th OR on Mondays" -> Monday the 2nd comes first.
    expect(iso(nextRun(parseCron("0 9 15 * 1"), t("2026-11-01T10:00:00Z")))).toBe("2026-11-02T09:00:00.000Z");
  });

  it("uses AND-free semantics when only weekday is restricted", () => {
    expect(iso(nextRun(parseCron("0 9 * * 5"), t("2026-11-01T10:00:00Z")))).toBe("2026-11-06T09:00:00.000Z");
  });

  it("throws on schedules that never fire", () => {
    expect(() => nextRun(parseCron("0 0 30 2 *"), t("2026-01-01T00:00:00Z"))).toThrow(CronError);
  });

  it("agrees with a brute-force minute scan on random expressions", () => {
    // Property test: the skip-ahead search must match a naive minute-by-minute search.
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const pick = (min: number, max: number) => {
      const r = rand(4);
      if (r === 0) return "*";
      if (r === 1) return `*/${1 + rand(Math.max(1, Math.floor((max - min) / 2)))}`;
      const a = min + rand(max - min + 1);
      if (r === 2) return String(a);
      const b = a + rand(max - a + 1);
      return `${a}-${b}`;
    };
    for (let i = 0; i < 150; i++) {
      const expr = [pick(0, 59), pick(0, 23), pick(1, 28), pick(1, 12), pick(0, 6)].join(" ");
      const s = parseCron(expr);
      const start = t("2026-01-01T00:00:00Z") + rand(365) * 86400_000 + rand(1440) * 60_000;
      const fast = nextRun(s, start);
      let slow = Math.floor(start / 60_000) * 60_000 + 60_000;
      for (;;) {
        const d = new Date(slow);
        const domStar = s.domStar, dowStar = s.dowStar;
        const domOk = s.doms.has(d.getUTCDate()), dowOk = s.dows.has(d.getUTCDay());
        const dayOk = domStar && dowStar ? true : domStar ? dowOk : dowStar ? domOk : domOk || dowOk;
        if (s.minutes.has(d.getUTCMinutes()) && s.hours.has(d.getUTCHours()) && s.months.has(d.getUTCMonth() + 1) && dayOk) break;
        slow += 60_000;
      }
      expect(iso(fast), expr).toBe(iso(slow));
    }
  });

  it("nextRuns returns increasing times", () => {
    const runs = nextRuns("0 */6 * * *", t("2026-01-01T00:00:00Z"), 4);
    expect(runs.map(iso)).toEqual([
      "2026-01-01T06:00:00.000Z",
      "2026-01-01T12:00:00.000Z",
      "2026-01-01T18:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);
  });
});
