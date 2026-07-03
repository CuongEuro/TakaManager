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
  // CHANNEL TRUTH — total Shopify revenue/orders per paid channel (classified
  // by customer journey), independent of per-campaign UTM hygiene and immune
  // to platform over-reporting. The anchor for effective metrics.
  channelTruth: Record<string, { revenue: number; orders: number }>;
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
  const channelTruth: Record<string, { revenue: number; orders: number }> = {};

  for (const o of orders) {
    const isPaid = !!o.channel && PAID_CHANNELS.includes(o.channel);
    if (isPaid) {
      paidOrders++;
      paidByPlatform[o.channel!] = (paidByPlatform[o.channel!] ?? 0) + 1;
      const ct = (channelTruth[o.channel!] ??= { revenue: 0, orders: 0 });
      ct.revenue += orderNetRevenue(o);
      ct.orders += 1;
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
    channelTruth,
    unmatchedTop: [...unmatched.entries()]
      .map(([utmCampaign, v]) => ({ utmCampaign, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// EFFECTIVE METRICS — reconcile per-campaign numbers with the channel truth.
// Platforms over-report (view-through, long windows), but their RELATIVE
// weighting across campaigns is still informative. So: campaigns keep their
// UTM-matched real revenue, and the channel's UNMATCHED Shopify revenue is
// distributed across campaigns proportionally to platform-reported revenue
// (falling back to spend). Per-platform totals then equal Shopify — no
// inflation possible. Same for orders → a true CPA.
// ---------------------------------------------------------------------------

export interface PlatformCalibration {
  platform: string;
  spend: number;
  platformRevenue: number; // what the platform claims
  shopifyRevenue: number; // channel truth (ex-tax)
  shopifyOrders: number;
  matchedRevenue: number; // portion confirmed by UTM
  overReport: number | null; // platformRevenue / shopifyRevenue (null = n/a)
  effRoas: number; // shopifyRevenue / spend
  effCpa: number; // spend / shopifyOrders
}

/** Mutates campaign nodes (+their adsets/ads) with eff* fields. Platforms with
 *  NO channel-truth revenue are left untouched (nothing to anchor on — e.g.
 *  Protected customer data access not granted → orders carry no channel). */
export function applyEffectiveMetrics(
  campaigns: {
    id: string;
    platform: string;
    spend: number;
    revenue: number;
    conversions: number;
    realRevenue?: number;
    realOrders?: number;
    effRevenue?: number;
    effOrders?: number;
    effRoas?: number;
    effCpa?: number;
    adsets?: { roas: number; effRoas?: number; ads?: { roas: number; effRoas?: number }[] }[];
  }[],
  attr: AttributionResult
): PlatformCalibration[] {
  const byPlatform = new Map<string, typeof campaigns>();
  for (const c of campaigns) {
    const arr = byPlatform.get(c.platform);
    if (arr) arr.push(c);
    else byPlatform.set(c.platform, [c]);
  }

  const out: PlatformCalibration[] = [];
  for (const [platform, camps] of byPlatform) {
    const truth = attr.channelTruth[platform];
    const spend = camps.reduce((s, c) => s + c.spend, 0);
    const platformRevenue = camps.reduce((s, c) => s + c.revenue, 0);
    const matchedRevenue = camps.reduce((s, c) => s + (c.realRevenue ?? 0), 0);
    const matchedOrders = camps.reduce((s, c) => s + (c.realOrders ?? 0), 0);
    if (!truth || truth.revenue <= 0) {
      // No Shopify channel signal → can't calibrate this platform.
      out.push({
        platform,
        spend,
        platformRevenue,
        shopifyRevenue: truth?.revenue ?? 0,
        shopifyOrders: truth?.orders ?? 0,
        matchedRevenue,
        overReport: null,
        effRoas: 0,
        effCpa: 0,
      });
      continue;
    }

    // Distribution weight: platform-reported revenue (relative signal), else
    // spend when the platform reports nothing (e.g. X without pixel).
    const revWeightSum = camps.reduce((s, c) => s + c.revenue, 0);
    const weight = (c: (typeof camps)[number]) =>
      revWeightSum > 0 ? c.revenue : c.spend;
    const weightSum = camps.reduce((s, c) => s + weight(c), 0);

    const unmatchedRevenue = Math.max(0, truth.revenue - matchedRevenue);
    const unmatchedOrders = Math.max(0, truth.orders - matchedOrders);

    for (const c of camps) {
      const share = weightSum > 0 ? weight(c) / weightSum : 0;
      c.effRevenue = (c.realRevenue ?? 0) + unmatchedRevenue * share;
      c.effOrders = (c.realOrders ?? 0) + unmatchedOrders * share;
      c.effRoas = c.spend > 0 ? c.effRevenue / c.spend : 0;
      c.effCpa = c.effOrders > 0 ? c.spend / c.effOrders : 0;
      // Scale the campaign's correction down to its adsets/ads: keep the
      // platform's within-campaign relativity, fix the absolute level.
      const ratio = c.revenue > 0 ? c.effRevenue / c.revenue : null;
      for (const a of c.adsets ?? []) {
        a.effRoas = ratio != null ? a.roas * ratio : c.effRoas;
        for (const ad of a.ads ?? [])
          ad.effRoas = ratio != null ? ad.roas * ratio : c.effRoas;
      }
    }

    out.push({
      platform,
      spend,
      platformRevenue,
      shopifyRevenue: truth.revenue,
      shopifyOrders: truth.orders,
      matchedRevenue,
      overReport:
        truth.revenue > 0 && platformRevenue > 0
          ? platformRevenue / truth.revenue
          : null,
      effRoas: spend > 0 ? truth.revenue / spend : 0,
      effCpa: truth.orders > 0 ? spend / truth.orders : 0,
    });
  }
  return out.sort((a, b) => b.spend - a.spend);
}
