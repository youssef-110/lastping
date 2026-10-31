// Five-field cron parser and next-run calculator (UTC).
// Supports: *, lists (1,2), ranges (1-5), steps (*/15, 10-50/5), month/day names,
// and the @hourly/@daily/@weekly/@monthly/@yearly macros. Day-of-month and
// day-of-week follow Vixie cron: if both are restricted, a day matches when EITHER matches.

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export class CronError extends Error {}

function parseValue(raw: string, min: number, names?: string[], nameOffset = 0): number {
  const lower = raw.toLowerCase();
  if (names) {
    const idx = names.indexOf(lower);
    if (idx !== -1) return idx + nameOffset;
  }
  if (!/^\d+$/.test(raw)) throw new CronError(`invalid value "${raw}"`);
  const n = Number(raw);
  if (n < min) throw new CronError(`value ${n} below ${min}`);
  return n;
}

function parseField(field: string, min: number, max: number, names?: string[], nameOffset = 0): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "") throw new CronError("empty list item");
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) throw new CronError(`invalid step in "${part}"`);
    const step = stepPart === undefined ? 1 : parseValue(stepPart, 1);
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = parseValue(a, min, names, nameOffset);
      hi = parseValue(b, min, names, nameOffset);
    } else {
      lo = parseValue(rangePart, min, names, nameOffset);
      // "5/15" means "from 5 to max, every 15"
      hi = stepPart === undefined ? lo : max;
    }
    if (hi > max || lo > max) throw new CronError(`value out of range ${min}-${max} in "${part}"`);
    if (lo > hi) throw new CronError(`reversed range "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSchedule {
  const trimmed = expr.trim().toLowerCase();
  const source = MACROS[trimmed] ?? trimmed;
  const fields = source.split(/\s+/);
  if (fields.length !== 5) throw new CronError(`expected 5 fields, got ${fields.length}`);
  const [mi, h, dom, mon, dow] = fields;
  const dows = parseField(dow, 0, 7, DAYS);
  if (dows.has(7)) {
    dows.delete(7);
    dows.add(0); // 7 is Sunday too
  }
  return {
    minutes: parseField(mi, 0, 59),
    hours: parseField(h, 0, 23),
    doms: parseField(dom, 1, 31),
    months: parseField(mon, 1, 12, MONTHS, 1),
    dows,
    domStar: dom === "*" || dom.startsWith("*/"),
    dowStar: dow === "*" || dow.startsWith("*/"),
  };
}

function dayMatches(s: CronSchedule, d: Date): boolean {
  const domOk = s.doms.has(d.getUTCDate());
  const dowOk = s.dows.has(d.getUTCDay());
  if (s.domStar && s.dowStar) return true;
  if (s.domStar) return dowOk;
  if (s.dowStar) return domOk;
  return domOk || dowOk;
}

/** First run time strictly after `after` (ms epoch). Throws if none within ~5 years (e.g. "0 0 30 2 *"). */
export function nextRun(s: CronSchedule, after: number): number {
  const d = new Date(after);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  const limit = after + 5 * 366 * 86400_000;
  // Skip whole months/days/hours that cannot match instead of scanning minute by minute.
  while (d.getTime() <= limit) {
    if (!s.months.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(s, d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hours.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!s.minutes.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  throw new CronError("schedule never fires");
}

export function nextRuns(expr: string, after: number, count: number): number[] {
  const s = parseCron(expr);
  const out: number[] = [];
  let t = after;
  for (let i = 0; i < count; i++) {
    t = nextRun(s, t);
    out.push(t);
  }
  return out;
}
