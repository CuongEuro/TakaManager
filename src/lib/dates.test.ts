import assert from "node:assert/strict";
import test from "node:test";
import { ymd as adsYMD } from "@/lib/ads/types";
import {
  addCalendarDays,
  calendarDateInTimeZone,
  calendarYMD,
  customRange,
  DEFAULT_TZ,
  parseCalendarDate,
  resolveRange,
} from "@/lib/dates";

const TOKYO_NEXT_DAY = new Date("2026-07-19T15:30:00.000Z");

test("the application reporting timezone is fixed to Tokyo", () => {
  assert.equal(DEFAULT_TZ, "Asia/Tokyo");
});

test("today follows Tokyo when Vietnam is still on the previous date", () => {
  const today = calendarDateInTimeZone(TOKYO_NEXT_DAY);
  assert.equal(calendarYMD(today), "2026-07-20");
  assert.equal(calendarYMD(addCalendarDays(today, -1)), "2026-07-19");
});

test("Tokyo report ranges use GMT+9 day boundaries", () => {
  const today = resolveRange("today", "Asia/Tokyo", TOKYO_NEXT_DAY);
  assert.equal(today.start.toISOString(), "2026-07-19T15:00:00.000Z");
  assert.equal(today.end.toISOString(), "2026-07-20T15:00:00.000Z");

  const custom = customRange("2026-07-20", "2026-07-21", "Asia/Tokyo");
  assert.equal(custom.start.toISOString(), "2026-07-19T15:00:00.000Z");
  assert.equal(custom.end.toISOString(), "2026-07-21T15:00:00.000Z");
});

test("a Tokyo day contains both canonical and legacy server-local daily keys", () => {
  const day = customRange("2026-07-20", "2026-07-20", "Asia/Tokyo");
  const canonicalUtcKey = new Date("2026-07-20T00:00:00.000Z");
  const legacyVietnamKey = new Date("2026-07-19T17:00:00.000Z");
  const previousDayKey = new Date("2026-07-19T00:00:00.000Z");

  assert.ok(canonicalUtcKey >= day.start && canonicalUtcKey < day.end);
  assert.ok(legacyVietnamKey >= day.start && legacyVietnamKey < day.end);
  assert.ok(previousDayKey < day.start);
});

test("calendar parsing is strict and independent of the device timezone", () => {
  const parsed = parseCalendarDate("2026-02-28");
  assert.ok(parsed);
  assert.equal(calendarYMD(parsed), "2026-02-28");
  assert.equal(parseCalendarDate("2026-02-30"), null);
});

test("ad provider request dates are derived in Tokyo", () => {
  assert.equal(adsYMD(TOKYO_NEXT_DAY), "2026-07-20");
});
