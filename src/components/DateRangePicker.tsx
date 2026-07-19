"use client";

import { useEffect, useRef, useState } from "react";
import { calendarDateInTimeZone } from "@/lib/dates";

export interface DateRange {
  from: Date;
  to: Date;
}

const DOW = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"]; // Mon→Sun

function startOfDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)
  );
}
function addDays(d: Date, n: number): Date {
  const x = startOfDay(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}
function fmt(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(
    d.getUTCMonth() + 1
  ).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
const MONTHS = [
  "Th1", "Th2", "Th3", "Th4", "Th5", "Th6",
  "Th7", "Th8", "Th9", "Th10", "Th11", "Th12",
];

/** Presets, each computed relative to "today" (inclusive windows). */
function presets(today: Date): { label: string; range: () => DateRange }[] {
  const t = startOfDay(today);
  const firstThis = new Date(
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1, 12)
  );
  const firstLast = new Date(
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1, 12)
  );
  const lastLast = new Date(
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0, 12)
  );
  return [
    { label: "Hôm nay", range: () => ({ from: t, to: t }) },
    { label: "Hôm qua", range: () => ({ from: addDays(t, -1), to: addDays(t, -1) }) },
    { label: "7 ngày qua", range: () => ({ from: addDays(t, -6), to: t }) },
    { label: "14 ngày qua", range: () => ({ from: addDays(t, -13), to: t }) },
    { label: "30 ngày qua", range: () => ({ from: addDays(t, -29), to: t }) },
    { label: "90 ngày qua", range: () => ({ from: addDays(t, -89), to: t }) },
    { label: "Tháng này", range: () => ({ from: firstThis, to: t }) },
    { label: "Tháng trước", range: () => ({ from: firstLast, to: lastLast }) },
    { label: "1 năm qua", range: () => ({ from: addDays(t, -364), to: t }) },
  ];
}

/** Build the 6×7 day grid (Mon-start) for a given month. */
function monthGrid(view: Date): Date[] {
  const first = new Date(
    Date.UTC(view.getUTCFullYear(), view.getUTCMonth(), 1, 12)
  );
  const offset = (first.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const start = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function DateRangePicker({
  value,
  onChange,
  disabled,
  maxDate,
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  disabled?: boolean;
  maxDate?: Date;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<Date>(value.from);
  const [to, setTo] = useState<Date | null>(value.to);
  const [view, setView] = useState<Date>(
    new Date(Date.UTC(value.to.getUTCFullYear(), value.to.getUTCMonth(), 1, 12))
  );
  const max = startOfDay(maxDate ?? calendarDateInTimeZone());
  const wrapRef = useRef<HTMLDivElement>(null);

  // Sync local draft when opening or when the external value changes.
  useEffect(() => {
    if (open) {
      setFrom(value.from);
      setTo(value.to);
      setView(
        new Date(Date.UTC(value.to.getUTCFullYear(), value.to.getUTCMonth(), 1, 12))
      );
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pickDay(d: Date) {
    if (d.getTime() > max.getTime()) return; // no future dates
    if (to === null) {
      // second click → close the range (swap if before the start)
      if (d.getTime() < from.getTime()) {
        setTo(from);
        setFrom(d);
      } else {
        setTo(d);
      }
    } else {
      // range already complete → first click of a new range
      setFrom(d);
      setTo(null);
    }
  }

  function commit(r: DateRange) {
    onChange({ from: startOfDay(r.from), to: startOfDay(r.to) });
    setOpen(false);
  }
  function apply() {
    commit({ from, to: to ?? from });
  }

  const label =
    sameDay(value.from, value.to)
      ? fmt(value.from)
      : `${fmt(value.from)} – ${fmt(value.to)}`;

  const grid = monthGrid(view);
  const inRange = (d: Date) => {
    const end = to ?? from;
    const lo = Math.min(from.getTime(), end.getTime());
    const hi = Math.max(from.getTime(), end.getTime());
    return d.getTime() >= lo && d.getTime() <= hi;
  };

  return (
    <div className="relative w-full sm:w-auto" ref={wrapRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:w-auto"
      >
        <span className="flex items-center gap-1.5">
          <span>📅</span>
          {label}
        </span>
        <span className="text-slate-400">▾</span>
      </button>

      {open && (
        <>
          {/* Dim backdrop on mobile (the panel is a centered modal there) */}
          <div
            className="fixed inset-0 z-40 bg-slate-900/40 sm:hidden"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-none sm:w-auto sm:max-w-none sm:translate-x-0 sm:translate-y-0 sm:overflow-visible"
          >
            <div className="flex flex-col sm:flex-row">
            {/* Presets */}
            <div className="flex max-h-64 flex-row flex-wrap gap-1 overflow-y-auto border-b border-slate-100 p-2 sm:max-h-none sm:w-44 sm:flex-col sm:flex-nowrap sm:border-b-0 sm:border-r">
              {presets(max).map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => commit(p.range())}
                  className="rounded-md px-3 py-1.5 text-left text-sm text-slate-600 hover:bg-brand-50 hover:text-brand-700"
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Calendar */}
            <div className="p-3">
              <div className="mb-2 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() =>
                    setView(
                      new Date(
                        Date.UTC(
                          view.getUTCFullYear(),
                          view.getUTCMonth() - 1,
                          1,
                          12
                        )
                      )
                    )
                  }
                  className="rounded p-1 text-slate-500 hover:bg-slate-100"
                  aria-label="Tháng trước"
                >
                  ‹
                </button>
                <div className="text-sm font-semibold text-slate-700">
                  {MONTHS[view.getUTCMonth()]} {view.getUTCFullYear()}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setView(
                      new Date(
                        Date.UTC(
                          view.getUTCFullYear(),
                          view.getUTCMonth() + 1,
                          1,
                          12
                        )
                      )
                    )
                  }
                  className="rounded p-1 text-slate-500 hover:bg-slate-100"
                  aria-label="Tháng sau"
                >
                  ›
                </button>
              </div>

              <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] font-medium text-slate-400">
                {DOW.map((d) => (
                  <div key={d} className="py-1">
                    {d}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-0.5">
                {grid.map((d, i) => {
                  const otherMonth = d.getUTCMonth() !== view.getUTCMonth();
                  const future = d.getTime() > max.getTime();
                  const selected = inRange(d);
                  const isStart = sameDay(d, from);
                  const isEnd = sameDay(d, to ?? from);
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={future}
                      onClick={() => pickDay(d)}
                      className={`h-8 w-9 rounded text-xs transition ${
                        future
                          ? "cursor-not-allowed text-slate-300"
                          : isStart || isEnd
                          ? "bg-brand-600 font-semibold text-white"
                          : selected
                          ? "bg-brand-50 text-brand-700"
                          : otherMonth
                          ? "text-slate-300 hover:bg-slate-100"
                          : "text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      {d.getUTCDate()}
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 flex items-center justify-between gap-2">
                <div className="text-xs text-slate-500">
                  {fmt(from)} – {fmt(to ?? from)}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
                  >
                    Hủy
                  </button>
                  <button
                    type="button"
                    onClick={apply}
                    className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
                  >
                    Áp dụng
                  </button>
                </div>
              </div>
            </div>
          </div>
          </div>
        </>
      )}
    </div>
  );
}
