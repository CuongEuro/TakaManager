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

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

export interface DateRange {
  start: Date;
  end: Date; // exclusive
  /** number of days the range spans (used to prorate fixed costs) */
  days: number;
}

export function resolveRange(preset: RangePreset, now = new Date()): DateRange {
  const today = startOfDay(now);

  let start: Date;
  let end: Date;

  switch (preset) {
    case "today":
      start = today;
      end = addDays(today, 1);
      break;
    case "yesterday":
      start = addDays(today, -1);
      end = today;
      break;
    case "last7":
      start = addDays(today, -6);
      end = addDays(today, 1);
      break;
    case "last30":
      start = addDays(today, -29);
      end = addDays(today, 1);
      break;
    case "thisWeek": {
      // Monday as start of week
      const dow = (today.getDay() + 6) % 7; // 0 = Monday
      start = addDays(today, -dow);
      end = addDays(start, 7);
      break;
    }
    case "thisMonth":
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      end = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      break;
    case "lastMonth":
      start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      end = new Date(today.getFullYear(), today.getMonth(), 1);
      break;
    default:
      start = today;
      end = addDays(today, 1);
  }

  const days = Math.max(
    1,
    Math.round((end.getTime() - start.getTime()) / 86400000)
  );
  return { start, end, days };
}

/** ISO date (YYYY-MM-DD) for a Date, in local time. */
export function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}
