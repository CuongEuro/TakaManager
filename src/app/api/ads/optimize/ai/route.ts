import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveRange, RangePreset } from "@/lib/dates";
import { getAdTree } from "@/lib/adinsights";
import { optimizeTree } from "@/lib/optimize";
import { computeDashboard } from "@/lib/pnl";
import { aiOptimize } from "@/lib/ai";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const preset = (b.preset ?? "last30") as RangePreset;
  const storeId = b.storeId || undefined;
  const platform = b.platform || undefined;
  const range = resolveRange(preset);

  const [tree, dash, store] = await Promise.all([
    getAdTree(range, { organizationId: session.oid, storeId, platform }),
    computeDashboard({
      organizationId: session.oid,
      start: range.start,
      end: range.end,
      storeId,
    }),
    storeId
      ? prisma.store.findFirst({
          where: { id: storeId, organizationId: session.oid },
          select: { name: true },
        })
      : Promise.resolve(null),
  ]);

  const breakEvenRoas = dash.summary.metrics.breakEvenRoas || 1.5;
  const rules = optimizeTree(tree, breakEvenRoas);

  const result = await aiOptimize(tree, rules, {
    preset,
    storeName: store?.name ?? null,
  });

  return NextResponse.json(result);
}
