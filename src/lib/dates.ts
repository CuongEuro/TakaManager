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

/** ISO date (YYYY-MM-DD) for an instant, in the given timezone. */
export function isoDay(d: Date, timeZone: string = DEFAULT_TZ): string {
  const { y, m, d: day } = partsInTz(d, timeZone);
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
