"use client";

import { useEffect, useRef, useState } from "react";

export interface DateRange {
  from: Date;
  to: Date;
}

const DOW = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"]; // Mon→Sun

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
}
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function fmt(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(
    d.getMonth() + 1
  ).padStart(2, "0")}/${d.getFullYear()}`;
}
const MONTHS = [
  "Th1", "Th2", "Th3", "Th4", "Th5", "Th6",
  "Th7", "Th8", "Th9", "Th10", "Th11", "Th12",
];

/** Presets, each computed relative to "today" (inclusive windows). */
function presets(today: Date): { label: string; range: () => DateRange }[] {
  const t = startOfDay(today);
  const firstThis = new Date(t.getFullYear(), t.getMonth(), 1);
  const firstLast = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  const lastLast = new Date(t.getFullYear(), t.getMonth(), 0);
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
  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7; // Mon=0 … Sun=6
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
    new Date(value.to.getFullYear(), value.to.getMonth(), 1)
  );
  const max = startOfDay(maxDate ?? new Date());
  const wrapRef = useRef<HTMLDivElement>(null);

  // Sync local draft when opening or when the external value changes.
  useEffect(() => {
    if (open) {
      setFrom(value.from);
      setTo(value.to);
      setView(new Date(value.to.getFullYear(), value.to.getMonth(), 1));
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

  function apply() {
    onChange({ from: startOfDay(from), to: startOfDay(to ?? from) });
    setOpen(false);
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
    <div className="relative" ref={wrapRef}>
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
        <div className="absolute right-0 z-40 mt-2 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="flex flex-col sm:flex-row">
            {/* Presets */}
            <div className="flex max-h-64 flex-row flex-wrap gap-1 overflow-y-auto border-b border-slate-100 p-2 sm:max-h-none sm:w-44 sm:flex-col sm:flex-nowrap sm:border-b-0 sm:border-r">
              {presets(max).map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    const r = p.range();
                    setFrom(r.from);
                    setTo(r.to);
                    setView(new Date(r.to.getFullYear(), r.to.getMonth(), 1));
                  }}
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
                    setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))
                  }
                  className="rounded p-1 text-slate-500 hover:bg-slate-100"
                  aria-label="Tháng trước"
                >
                  ‹
                </button>
                <div className="text-sm font-semibold text-slate-700">
                  {MONTHS[view.getMonth()]} {view.getFullYear()}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))
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
                  const otherMonth = d.getMonth() !== view.getMonth();
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
                      {d.getDate()}
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
      )}
    </div>
  );
}
