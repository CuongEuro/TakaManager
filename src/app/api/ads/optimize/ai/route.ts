import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveRange, RangePreset } from "@/lib/dates";
import { getAdTree } from "@/lib/adinsights";
import { optimizeTree } from "@/lib/optimize";
import { computeStoreBreakEvens } from "@/lib/pnl";
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

  const [tree, bes, store] = await Promise.all([
    getAdTree(range, { organizationId: session.oid, storeId, platform }),
    computeStoreBreakEvens(session.oid, range.start, range.end),
    storeId
      ? prisma.store.findFirst({
          where: { id: storeId, organizationId: session.oid },
          select: { name: true },
        })
      : Promise.resolve(null),
  ]);

  const breakEvenRoas =
    (storeId ? bes.byStore.get(storeId) : undefined) ?? bes.blended;
  const campaignBe = new Map<string, number>();
  for (const c of tree.campaigns) {
    const be = c.storeId ? bes.byStore.get(c.storeId) : undefined;
    if (be) campaignBe.set(c.id, be);
  }
  const pauseMinSpend = Math.max(3000, Math.round(2 * bes.aov));
  const rules = optimizeTree(tree, breakEvenRoas, { campaignBe, pauseMinSpend });

  const result = await aiOptimize(tree, rules, {
    preset,
    storeName: store?.name ?? null,
  });

  return NextResponse.json(result);
}
