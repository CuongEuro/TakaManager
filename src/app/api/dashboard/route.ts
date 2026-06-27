import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveRange, RangePreset, DEFAULT_TZ } from "@/lib/dates";
import { computeDashboard } from "@/lib/pnl";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const preset = (sp.get("preset") ?? "thisMonth") as RangePreset;
  const storeId = sp.get("storeId") || undefined;

  // Day boundaries follow the store's timezone (default Japan). For "all stores"
  // use the first store's tz (all the merchant's stores are typically same tz).
  const tzStore = await prisma.store.findFirst({
    where: storeId
      ? { id: storeId, organizationId: session.oid }
      : { organizationId: session.oid, active: true },
    orderBy: { name: "asc" },
    select: { timezone: true },
  });
  const timezone = tzStore?.timezone || DEFAULT_TZ;

  const range = resolveRange(preset, timezone);
  const [data, storeOptions] = await Promise.all([
    computeDashboard({
      organizationId: session.oid,
      start: range.start,
      end: range.end,
      storeId,
      timezone,
    }),
    prisma.store.findMany({
      where: { organizationId: session.oid, active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return NextResponse.json({
    preset,
    timezone,
    range: { start: range.start, end: range.end, days: range.days },
    storeId: storeId ?? null,
    storeOptions,
    ...data,
  });
}
