// ---------------------------------------------------------------------------
// CAMPAIGN ATTRIBUTION — join Shopify orders (Order.utmCampaign, snapshotted at
// click time) to ad campaigns BY NAME, giving each campaign a REAL Shopify
// revenue/ROAS next to the platform-reported one (platforms over-attribute:
// view-through, long click windows...). Owner's URLs set utm_campaign to the
// campaign NAME → normalized-name matching.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { orderNetRevenue } from "@/lib/pnl";

/** Normalize a campaign name / utm_campaign for matching: trim, lowercase,
 *  collapse whitespace (platforms and URL encodings disagree on spacing). */
export function normalizeCampaignKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface CampaignReal {
  realOrders: number;
  realRevenue: number; // ex-tax, same formula as the P&L (orderNetRevenue)
}

export interface AttributionResult {
  byCampaignId: Map<string, CampaignReal>;
  paidOrders: number; // orders on a paid channel (FB/GG/TW) in range
  matchedOrders: number; // of those, matched to a known campaign
  taggedOrders: number; // orders carrying any utmCampaign
  matchRate: number; // matched / paid (0 when no paid orders)
  matchRateByPlatform: Record<string, number>;
  unmatchedTop: {
    utmCampaign: string;
    channel: string;
    orders: number;
    revenue: number;
  }[];
}

const PAID_CHANNELS = ["FACEBOOK", "GOOGLE", "TWITTER"];

/**
 * campaigns: the optimize tree's campaigns ({id, name, storeId, platform}).
 * Matching: normalized utm_campaign == normalized campaign name. When several
 * campaigns share a name, prefer the one mapped to the ORDER's store, then the
 * highest spend (deterministic).
 */
export async function computeCampaignAttribution(
  organizationId: string,
  range: { start: Date; end: Date },
  campaigns: {
    id: string;
    name: string;
    storeId: string | null;
    platform: string;
    spend: number;
  }[],
  filters: { storeId?: string | null } = {}
): Promise<AttributionResult> {
  // name key → candidate campaigns (usually 1)
  const byKey = new Map<string, typeof campaigns>();
  for (const c of campaigns) {
    const key = normalizeCampaignKey(c.name);
    if (!key) continue;
    const arr = byKey.get(key);
    if (arr) arr.push(c);
    else byKey.set(key, [c]);
  }

  const orders = await prisma.order.findMany({
    where: {
      organizationId,
      date: { gte: range.start, lt: range.end },
      ...(filters.storeId ? { storeId: filters.storeId } : {}),
      OR: [{ utmCampaign: { not: null } }, { channel: { in: PAID_CHANNELS } }],
    },
    select: {
      storeId: true,
      channel: true,
      utmCampaign: true,
      grossRevenue: true,
      discounts: true,
      shippingCharged: true,
      refunded: true,
      store: { select: { taxRate: true } },
    },
  });

  const byCampaignId = new Map<string, CampaignReal>();
  const unmatched = new Map<string, { channel: string; orders: number; revenue: number }>();
  let paidOrders = 0;
  let matchedOrders = 0;
  let taggedOrders = 0;
  const paidByPlatform: Record<string, number> = {};
  const matchedByPlatform: Record<string, number> = {};

  for (const o of orders) {
    const isPaid = !!o.channel && PAID_CHANNELS.includes(o.channel);
    if (isPaid) {
      paidOrders++;
      paidByPlatform[o.channel!] = (paidByPlatform[o.channel!] ?? 0) + 1;
    }
    if (!o.utmCampaign) continue;
    taggedOrders++;

    const key = normalizeCampaignKey(o.utmCampaign);
    const candidates = byKey.get(key);
    const revenue = orderNetRevenue(o);
    if (candidates && candidates.length > 0) {
      // Disambiguate same-name campaigns: order's store first, then spend.
      const target =
        candidates.find((c) => c.storeId === o.storeId) ??
        [...candidates].sort((a, b) => b.spend - a.spend)[0];
      const cur = byCampaignId.get(target.id) ?? { realOrders: 0, realRevenue: 0 };
      cur.realOrders++;
      cur.realRevenue += revenue;
      byCampaignId.set(target.id, cur);
      if (isPaid) {
        matchedOrders++;
        matchedByPlatform[o.channel!] = (matchedByPlatform[o.channel!] ?? 0) + 1;
      }
    } else {
      const cur = unmatched.get(key) ?? {
        channel: o.channel ?? "OTHER",
        orders: 0,
        revenue: 0,
      };
      cur.orders++;
      cur.revenue += revenue;
      unmatched.set(key, cur);
    }
  }

  const matchRateByPlatform: Record<string, number> = {};
  for (const p of PAID_CHANNELS) {
    const paid = paidByPlatform[p] ?? 0;
    if (paid > 0) matchRateByPlatform[p] = (matchedByPlatform[p] ?? 0) / paid;
  }

  return {
    byCampaignId,
    paidOrders,
    matchedOrders,
    taggedOrders,
    matchRate: paidOrders > 0 ? matchedOrders / paidOrders : 0,
    matchRateByPlatform,
    unmatchedTop: [...unmatched.entries()]
      .map(([utmCampaign, v]) => ({ utmCampaign, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10),
  };
}
