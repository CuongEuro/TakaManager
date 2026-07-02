import { NextRequest, NextResponse } from "next/server";
import { resolveRange, RangePreset } from "@/lib/dates";
import { getAdTree } from "@/lib/adinsights";
import { optimizeTree } from "@/lib/optimize";
import { computeStoreBreakEvens } from "@/lib/pnl";
import { computeCampaignAttribution } from "@/lib/attribution";
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

  const [tree, bes] = await Promise.all([
    getAdTree(range, { organizationId: session.oid, storeId, platform }),
    computeStoreBreakEvens(session.oid, range.start, range.end),
  ]);

  // Real Shopify revenue per campaign (utm_campaign = campaign name).
  const attr = await computeCampaignAttribution(
    session.oid,
    range,
    tree.campaigns,
    { storeId }
  );
  for (const c of tree.campaigns) {
    const real = attr.byCampaignId.get(c.id);
    if (real) {
      c.realOrders = real.realOrders;
      c.realRevenue = real.realRevenue;
      c.realRoas = c.spend > 0 ? real.realRevenue / c.spend : 0;
    }
  }

  // Judge every campaign against ITS store's break-even (margins differ per
  // store); the blended number remains the summary bar / fallback.
  const breakEvenRoas =
    (storeId ? bes.byStore.get(storeId) : undefined) ?? bes.blended;
  const campaignBe = new Map<string, number>();
  for (const c of tree.campaigns) {
    const be = c.storeId ? bes.byStore.get(c.storeId) : undefined;
    if (be) campaignBe.set(c.id, be);
  }
  const pauseMinSpend = Math.max(3000, Math.round(2 * bes.aov));
  const optimize = optimizeTree(tree, breakEvenRoas, { campaignBe, pauseMinSpend });

  return NextResponse.json({
    preset,
    range,
    storeId: storeId ?? null,
    platform: platform ?? null,
    breakEvenRoas,
    aov: bes.aov,
    tree,
    optimize,
    attribution: {
      matchRate: attr.matchRate,
      matchRateByPlatform: attr.matchRateByPlatform,
      paidOrders: attr.paidOrders,
      matchedOrders: attr.matchedOrders,
      taggedOrders: attr.taggedOrders,
      unmatchedTop: attr.unmatchedTop,
    },
  });
}
