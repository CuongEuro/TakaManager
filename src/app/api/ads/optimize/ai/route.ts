import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveRange, RangePreset } from "@/lib/dates";
import { getAdTree } from "@/lib/adinsights";
import { optimizeTree } from "@/lib/optimize";
import { computeStoreBreakEvens } from "@/lib/pnl";
import { computeCampaignAttribution } from "@/lib/attribution";
import { aiOptimize, AI_MODEL } from "@/lib/ai";
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
  // Optional: focus the analysis on a chosen subset of campaigns.
  const campaignIds: string[] | null = Array.isArray(b.campaignIds)
    ? b.campaignIds.filter((x: unknown): x is string => typeof x === "string")
    : null;
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

  // Decorate campaigns with real Shopify revenue so the AI sees both ROAS.
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

  // Narrow to the selected campaigns AFTER decoration → the rules, budget plan
  // and AI payload all scope to just those (attribution match rates stay
  // platform-wide, which is what they measure).
  if (campaignIds && campaignIds.length > 0) {
    const keep = new Set(campaignIds);
    tree.campaigns = tree.campaigns.filter((c) => keep.has(c.id));
  }

  const breakEvenRoas =
    (storeId ? bes.byStore.get(storeId) : undefined) ?? bes.blended;
  const campaignBe = new Map<string, number>();
  for (const c of tree.campaigns) {
    const be = c.storeId ? bes.byStore.get(c.storeId) : undefined;
    if (be) campaignBe.set(c.id, be);
  }
  const pauseMinSpend = Math.max(3000, Math.round(2 * bes.aov));
  const rules = optimizeTree(tree, breakEvenRoas, {
    campaignBe,
    pauseMinSpend,
    matchRateByPlatform: attr.matchRateByPlatform,
  });

  const result = await aiOptimize(tree, rules, {
    preset,
    storeName: store?.name ?? null,
    matchRate: attr.matchRate,
    aov: bes.aov,
  });

  // Keep a history of generated strategies (audit + re-read later).
  let reportId: string | null = null;
  if (result.ok && result.text) {
    try {
      const saved = await prisma.aiReport.create({
        data: {
          organizationId: session.oid,
          preset,
          storeId: storeId ?? null,
          platform: platform ?? null,
          model: AI_MODEL,
          // Prisma Json input wants an index signature — AiStrategy is plain
          // serializable data, so a structural cast is safe here.
          json: result.json
            ? (JSON.parse(JSON.stringify(result.json)) as object)
            : undefined,
          text: result.text,
        },
        select: { id: true },
      });
      reportId = saved.id;
    } catch {
      /* saving must never break the response (e.g. before db push) */
    }
  }

  return NextResponse.json({ ...result, reportId });
}
