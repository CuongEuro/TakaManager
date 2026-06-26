import { NextRequest, NextResponse } from "next/server";
import { resolveRange, RangePreset } from "@/lib/dates";
import { getAdTree } from "@/lib/adinsights";
import { optimizeTree } from "@/lib/optimize";
import { computeDashboard } from "@/lib/pnl";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const preset = (sp.get("preset") ?? "last30") as RangePreset;
  const storeId = sp.get("storeId") || undefined;
  const platform = sp.get("platform") || undefined;
  const range = resolveRange(preset);

  const [tree, dash] = await Promise.all([
    getAdTree(range, { organizationId: session.oid, storeId, platform }),
    computeDashboard({
      organizationId: session.oid,
      start: range.start,
      end: range.end,
      storeId,
    }),
  ]);

  const breakEvenRoas = dash.summary.metrics.breakEvenRoas || 1.5;
  const optimize = optimizeTree(tree, breakEvenRoas);

  return NextResponse.json({
    preset,
    range,
    storeId: storeId ?? null,
    platform: platform ?? null,
    breakEvenRoas,
    tree,
    optimize,
  });
}
