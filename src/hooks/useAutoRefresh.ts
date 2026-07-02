"use client";

import { useEffect } from "react";

/** Run `fn` at most once per `intervalMs` APP-WIDE: the last-run timestamp
 *  lives in localStorage under `key`, so several open pages/tabs share one
 *  schedule instead of each firing its own. Checks on mount and then every
 *  5 minutes while the page stays open (same cadence as the ads refresh).
 *  The stamp is written BEFORE running so concurrent tabs don't double-fire;
 *  callers should keep `fn` idempotent. */
export function useAutoRefresh(
  key: string,
  fn: () => void | Promise<void>,
  opts: { intervalMs?: number; enabled?: boolean } = {}
) {
  const { intervalMs = 3600_000, enabled = true } = opts;
  useEffect(() => {
    if (!enabled) return;
    const check = () => {
      let last = 0;
      try {
        last = Number(localStorage.getItem(key) || 0);
      } catch {
        /* private mode — fall through and run */
      }
      if (Date.now() - last < intervalMs) return;
      try {
        localStorage.setItem(key, String(Date.now()));
      } catch {
        /* ignore quota */
      }
      void fn();
    };
    check();
    const id = setInterval(check, 5 * 60_000);
    return () => clearInterval(id);
  }, [key, fn, intervalMs, enabled]);
}
