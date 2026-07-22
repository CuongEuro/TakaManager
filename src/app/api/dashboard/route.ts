import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveRange, customRange, RangePreset, DEFAULT_TZ } from "@/lib/dates";
import { computeDashboard } from "@/lib/pnl";
import { findMissingBasecosts } from "@/lib/sync";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const preset = (sp.get("preset") ?? "today") as RangePreset;
  const from = sp.get("from"); // YYYY-MM-DD (custom range)
  const to = sp.get("to");
  const isYMD = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const storeId = sp.get("storeId") || undefined;
  const bestSellerPage = Math.max(1, Number(sp.get("productsPage")) || 1);

  // Reporting is fixed to Japan time for every store and every viewer. Do not
  // derive this from the browser, server process, or a stale store setting.
  const timezone = DEFAULT_TZ;

  // Custom from/to (calendar dates in the store tz) wins; else a named preset.
  const range =
    isYMD(from) && isYMD(to)
      ? customRange(from, to, timezone)
      : resolveRange(preset, timezone);
  const [data, storeOptions, missingBasecost] = await Promise.all([
    computeDashboard({
      organizationId: session.oid,
      start: range.start,
      end: range.end,
      storeId,
      timezone,
      bestSellerPage,
      bestSellerPageSize: 10,
    }),
    prisma.store.findMany({
      where: { organizationId: session.oid, active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    findMissingBasecosts(session.oid, {
      start: range.start,
      end: range.end,
      storeId,
    }),
  ]);

  return NextResponse.json({
    preset,
    timezone,
    range: { start: range.start, end: range.end, days: range.days },
    storeId: storeId ?? null,
    storeOptions,
    missingBasecost,
    ...data,
  });
}
