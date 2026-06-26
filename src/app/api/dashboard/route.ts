import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveRange, RangePreset } from "@/lib/dates";
import { computeDashboard } from "@/lib/pnl";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const preset = (sp.get("preset") ?? "thisMonth") as RangePreset;
  const storeId = sp.get("storeId") || undefined;

  const range = resolveRange(preset);
  const [data, storeOptions] = await Promise.all([
    computeDashboard({
      organizationId: session.oid,
      start: range.start,
      end: range.end,
      storeId,
    }),
    prisma.store.findMany({
      where: { organizationId: session.oid, active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return NextResponse.json({
    preset,
    range: { start: range.start, end: range.end, days: range.days },
    storeId: storeId ?? null,
    storeOptions,
    ...data,
  });
}
