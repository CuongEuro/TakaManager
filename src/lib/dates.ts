// Date-range helpers for the dashboard filters: today / yesterday / week / month.
// Ranges are [start, end) — start inclusive, end exclusive.

export type RangePreset =
  | "today"
  | "yesterday"
  | "last7"
  | "thisWeek"
  | "thisMonth"
  | "lastMonth"
  | "last30";

export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  today: "Hôm nay",
  yesterday: "Hôm qua",
  last7: "7 ngày",
  thisWeek: "Tuần này",
  thisMonth: "Tháng này",
  lastMonth: "Tháng trước",
  last30: "30 ngày",
};

// All day boundaries are computed in the store's timezone (default Japan), NOT
// the server's UTC — so "Hôm nay/Hôm qua" and daily buckets match what the
// merchant sees in Shopify. Stores carry an IANA timezone (e.g. Asia/Tokyo).
export const DEFAULT_TZ = "Asia/Tokyo";

// Offset (ms) between a timezone's wall clock and UTC at a given instant:
// wallClockAsUTC(instant) − instant. Asia/Tokyo → +32400000 (always +9, no DST).
function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  let hour = map.hour;
  if (hour === 24) hour = 0; // some runtimes render midnight as 24
  const asUTC = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second);
  return asUTC - instant.getTime();
}

/** Wall-clock Y / M(1-based) / D of an instant, in the given timezone. */
function partsInTz(instant: Date, timeZone: string): { y: number; m: number; d: number } {
  const wall = new Date(instant.getTime() + tzOffsetMs(instant, timeZone));
  return { y: wall.getUTCFullYear(), m: wall.getUTCMonth() + 1, d: wall.getUTCDate() };
}

/** UTC instant of wall-clock Y-M-D 00:00:00 in the given timezone. */
function zonedMidnight(y: number, m: number, d: number, timeZone: string): Date {
  const guessUTC = Date.UTC(y, m - 1, d, 0, 0, 0);
  const off = tzOffsetMs(new Date(guessUTC), timeZone);
  return new Date(guessUTC - off);
}

export interface DateRange {
  start: Date;
  end: Date; // exclusive
  /** number of days the range spans (used to prorate fixed costs) */
  days: number;
}

export function resolveRange(
  preset: RangePreset,
  timeZone: string = DEFAULT_TZ,
  now: Date = new Date()
): DateRange {
  const t = partsInTz(now, timeZone);
  // Calendar carrier in UTC (noon to avoid any edge), for day/month arithmetic.
  const carrier = new Date(Date.UTC(t.y, t.m - 1, t.d, 12));
  const cAdd = (c: Date, days: number) => {
    const x = new Date(c);
    x.setUTCDate(x.getUTCDate() + days);
    return x;
  };
  const toInstant = (c: Date) =>
    zonedMidnight(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate(), timeZone);

  let startC: Date;
  let endC: Date;
  switch (preset) {
    case "today":
      startC = carrier;
      endC = cAdd(carrier, 1);
      break;
    case "yesterday":
      startC = cAdd(carrier, -1);
      endC = carrier;
      break;
    case "last7":
      startC = cAdd(carrier, -6);
      endC = cAdd(carrier, 1);
      break;
    case "last30":
      startC = cAdd(carrier, -29);
      endC = cAdd(carrier, 1);
      break;
    case "thisWeek": {
      const dow = (carrier.getUTCDay() + 6) % 7; // 0 = Monday
      startC = cAdd(carrier, -dow);
      endC = cAdd(startC, 7);
      break;
    }
    case "thisMonth":
      startC = new Date(Date.UTC(t.y, t.m - 1, 1, 12));
      endC = new Date(Date.UTC(t.y, t.m, 1, 12));
      break;
    case "lastMonth":
      startC = new Date(Date.UTC(t.y, t.m - 2, 1, 12));
      endC = new Date(Date.UTC(t.y, t.m - 1, 1, 12));
      break;
    default:
      startC = carrier;
      endC = cAdd(carrier, 1);
  }

  const start = toInstant(startC);
  const end = toInstant(endC);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
  return { start, end, days };
}

/**
 * Build a [start, end) range from two calendar dates (YYYY-MM-DD), with both day
 * boundaries taken in `timeZone`. `end` is exclusive = start of the day AFTER
 * `toYMD`, so the whole `toYMD` day is included. Used by the custom date picker.
 */
export function customRange(
  fromYMD: string,
  toYMD: string,
  timeZone: string = DEFAULT_TZ
): DateRange {
  const [fy, fm, fd] = fromYMD.split("-").map(Number);
  const [ty, tm, td] = toYMD.split("-").map(Number);
  let start = zonedMidnight(fy, fm, fd, timeZone);
  let end = zonedMidnight(ty, tm, td + 1, timeZone); // d+1 overflows safely
  if (end.getTime() < start.getTime()) [start, end] = [end, start]; // guard swap
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
  return { start, end, days };
}

/** ISO date (YYYY-MM-DD) for an instant, in the given timezone. */
export function isoDay(d: Date, timeZone: string = DEFAULT_TZ): string {
  const { y, m, d: day } = partsInTz(d, timeZone);
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Number of days in a calendar month (month is 1-based). */
export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Number of days in a year (365 or 366). */
export function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

/**
 * Prorate a recurring amount over [start, end) using each calendar day's REAL
 * month/year length (so a monthly fee is amount/28 in February, amount/31 in
 * July, etc.). Works across month boundaries. start/end are UTC instants;
 * day boundaries are taken in `timeZone`.
 */
export function proratePeriodic(
  amount: number,
  cycle: "MONTHLY" | "YEARLY",
  start: Date,
  end: Date,
  timeZone: string = DEFAULT_TZ
): number {
  const endMs = end.getTime();
  let cursor = start.getTime();
  if (endMs <= cursor) return 0;

  let total = 0;
  let guard = 0;
  while (cursor < endMs && guard++ < 100000) {
    const { y, m, d } = partsInTz(new Date(cursor), timeZone);
    const dayStart = zonedMidnight(y, m, d, timeZone).getTime();
    const nextStart = zonedMidnight(y, m, d + 1, timeZone).getTime(); // d+1 overflows safely
    const segEnd = Math.min(endMs, nextStart);
    const dayLen = nextStart - dayStart || 86400000;
    const fraction = (segEnd - cursor) / dayLen; // 1 for whole days, <1 at edges
    const denom = cycle === "YEARLY" ? daysInYear(y) : daysInMonth(y, m);
    total += (amount / denom) * fraction;
    cursor = segEnd;
  }
  return total;
}
