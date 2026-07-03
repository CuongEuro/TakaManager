// ---------------------------------------------------------------------------
// AD INSIGHTS — build a Campaign → AdSet tree with derived KPIs for a range.
// Reads the deep hierarchy (AdEntity + AdMetric). Campaigns that have spend
// (AdSpend) but no adset metrics still appear, flagged dataLevel:"campaign".
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";

export interface Kpis {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  roas: number; // revenue / spend
  cpa: number; // spend / conversions
  ctr: number; // clicks / impressions
  cvr: number; // conversions / clicks
  cpc: number; // spend / clicks
  cpm: number; // spend / impressions * 1000
}

// Current-half vs previous-half deltas over the selected range (≥14 days).
export interface Trend {
  spendDelta: number; // cur/prev − 1
  roasDelta: number;
  cpaDelta: number;
  ctrDelta: number;
  flags: ("WORSENING" | "IMPROVING" | "FATIGUE" | "NEW")[];
}

export interface AdNode extends Kpis {
  id: string;
  externalId: string;
  name: string;
  status: string | null;
  platform: string;
  trend?: Trend | null;
  effRoas?: number; // campaign correction ratio applied (see attribution.ts)
}

export interface AdsetNode extends Kpis {
  id: string;
  externalId: string;
  name: string;
  status: string | null;
  platform: string;
  trend?: Trend | null;
  ads: AdNode[]; // AD/creative tier (may be empty if not synced deep)
  effRoas?: number; // campaign correction ratio applied (see attribution.ts)
}

export interface CampaignNode extends Kpis {
  id: string;
  externalId: string;
  name: string;
  platform: string;
  status: string | null; // ACTIVE | PAUSED | ARCHIVED | null
  storeId: string | null; // campaign mapping ?? account store
  dataLevel: "adset" | "campaign"; // "campaign" = KPIs from AdSpend fallback
  adsets: AdsetNode[];
  // Shopify-attributed reality (filled by the optimize route from
  // computeCampaignAttribution — utm_campaign name matching):
  realOrders?: number;
  realRevenue?: number; // ex-tax
  realRoas?: number; // realRevenue / spend
  // EFFECTIVE metrics (applyEffectiveMetrics): UTM-matched revenue + the
  // channel's unmatched Shopify revenue distributed by the platform's own
  // relative weights. Sums to the channel truth — platform inflation removed.
  effRevenue?: number;
  effOrders?: number;
  effRoas?: number;
  effCpa?: number;
  trend?: Trend | null;
}

export interface AdTree {
  campaigns: CampaignNode[];
  totals: Kpis;
  rangeDays: number; // trends need ≥ 14
}

interface Filters {
  organizationId: string; // tenant scope (required)
  storeId?: string | null;
  platform?: string | null;
  accountId?: string | null;
}

function zero() {
  return { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 };
}

function deriveKpis(m: {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
}): Kpis {
  return {
    ...m,
    roas: m.spend > 0 ? m.revenue / m.spend : 0,
    cpa: m.conversions > 0 ? m.spend / m.conversions : 0,
    ctr: m.impressions > 0 ? m.clicks / m.impressions : 0,
    cvr: m.clicks > 0 ? m.conversions / m.clicks : 0,
    cpc: m.clicks > 0 ? m.spend / m.clicks : 0,
    cpm: m.impressions > 0 ? (m.spend / m.impressions) * 1000 : 0,
  };
}

type Raw = ReturnType<typeof zero>;
const addRaw = (acc: Raw, x: Raw) => {
  acc.spend += x.spend;
  acc.impressions += x.impressions;
  acc.clicks += x.clicks;
  acc.conversions += x.conversions;
  acc.revenue += x.revenue;
};

/** Deltas current-half vs previous-half. null = nothing to compare. */
function computeTrend(cur: Raw, prev: Raw): Trend | null {
  if (cur.spend <= 0 && prev.spend <= 0) return null;
  if (prev.spend <= 0)
    return { spendDelta: 1, roasDelta: 0, cpaDelta: 0, ctrDelta: 0, flags: ["NEW"] };
  const kCur = deriveKpis(cur);
  const kPrev = deriveKpis(prev);
  const delta = (a: number, b: number) => (b > 0 ? a / b - 1 : 0);
  const t: Trend = {
    spendDelta: delta(cur.spend, prev.spend),
    roasDelta: delta(kCur.roas, kPrev.roas),
    cpaDelta: delta(kCur.cpa, kPrev.cpa),
    ctrDelta: delta(kCur.ctr, kPrev.ctr),
    flags: [],
  };
  // Only judge trend on meaningful previous spend (noise guard ¥1500).
  if (prev.spend >= 1500) {
    if (t.roasDelta <= -0.2) t.flags.push("WORSENING");
    else if (t.roasDelta >= 0.2) t.flags.push("IMPROVING");
  }
  // Creative fatigue: CTR down ≥20% while spend held (≥80% of previous half).
  if (
    kPrev.ctr > 0 &&
    t.ctrDelta <= -0.2 &&
    cur.spend >= 0.8 * prev.spend &&
    prev.spend >= 1500
  )
    t.flags.push("FATIGUE");
  return t;
}

export async function getAdTree(
  range: { start: Date; end: Date },
  filters: Filters
): Promise<AdTree> {
  const where: {
    organizationId: string;
    storeId?: string;
    platform?: string;
    accountId?: string;
  } = { organizationId: filters.organizationId };
  if (filters.storeId) where.storeId = filters.storeId;
  if (filters.platform) where.platform = filters.platform;
  if (filters.accountId) where.accountId = filters.accountId;

  const rangeDays = Math.max(
    1,
    Math.round((range.end.getTime() - range.start.getTime()) / 86400000)
  );
  const trendOn = rangeDays >= 14; // halves too noisy below 2 weeks
  const mid = new Date((range.start.getTime() + range.end.getTime()) / 2);

  const [entities, accounts] = await Promise.all([
    prisma.adEntity.findMany({
      where,
      include: {
        metrics: { where: { date: { gte: range.start, lt: range.end } } },
      },
    }),
    prisma.adAccount.findMany({
      where: { organizationId: filters.organizationId },
      select: { id: true, storeId: true },
    }),
  ]);
  const accountStore = new Map(accounts.map((a) => [a.id, a.storeId]));

  // campaign lookup: `${accountId}|${externalId}` -> entity info
  const campaignInfo = new Map<
    string,
    {
      id: string;
      externalId: string;
      name: string;
      platform: string;
      status: string | null;
      storeId: string | null;
      accountId: string;
    }
  >();
  for (const e of entities) {
    if (e.level === "CAMPAIGN")
      campaignInfo.set(`${e.accountId}|${e.externalId}`, {
        id: e.id,
        externalId: e.externalId,
        name: e.name,
        platform: e.platform,
        status: e.status,
        // campaign mapping wins; fall back to the account's store
        storeId: e.storeId ?? accountStore.get(e.accountId) ?? null,
        accountId: e.accountId,
      });
  }

  // group adsets under their campaign
  const campMap = new Map<string, CampaignNode>();
  const getCampaign = (
    key: string,
    fallback: Omit<CampaignNode, keyof Kpis | "adsets">
  ) => {
    let c = campMap.get(key);
    if (!c) {
      c = { ...fallback, ...zero(), ...deriveKpis(zero()), adsets: [] };
      campMap.set(key, c);
    }
    return c;
  };

  // per-campaign half-window accumulators (for campaign-level trend)
  const campHalves = new Map<string, { cur: Raw; prev: Raw }>();
  // adset lookup `${accountId}|${externalId}` → node, for attaching ads
  const adsetByKey = new Map<string, AdsetNode>();

  for (const e of entities) {
    if (e.level !== "ADSET") continue;
    const m = zero();
    const cur = zero();
    const prev = zero();
    for (const x of e.metrics) {
      const raw = {
        spend: x.spend,
        impressions: x.impressions,
        clicks: x.clicks,
        conversions: x.conversions,
        revenue: x.revenue,
      };
      addRaw(m, raw);
      addRaw(x.date < mid ? prev : cur, raw);
    }
    const adset: AdsetNode = {
      id: e.id,
      externalId: e.externalId,
      name: e.name,
      status: e.status,
      platform: e.platform,
      ...deriveKpis(m),
      trend: trendOn ? computeTrend(cur, prev) : null,
      ads: [],
    };

    const campKey = `${e.accountId}|${e.parentExternalId}`;
    const info = campaignInfo.get(campKey);
    const camp = getCampaign(campKey, {
      id: info?.id ?? campKey,
      externalId: e.parentExternalId ?? "",
      name: info?.name ?? "(không rõ campaign)",
      platform: e.platform,
      status: info?.status ?? null,
      storeId: info?.storeId ?? accountStore.get(e.accountId) ?? null,
      dataLevel: "adset",
    });
    camp.adsets.push(adset);
    adsetByKey.set(`${e.accountId}|${e.externalId}`, adset);
    let halves = campHalves.get(campKey);
    if (!halves) {
      halves = { cur: zero(), prev: zero() };
      campHalves.set(campKey, halves);
    }
    addRaw(halves.cur, cur);
    addRaw(halves.prev, prev);
  }

  // AD (creative) tier — attach each ad to its parent ad set (by externalId).
  for (const e of entities) {
    if (e.level !== "AD") continue;
    const parent = adsetByKey.get(`${e.accountId}|${e.parentExternalId}`);
    if (!parent) continue; // orphan (parent adset not in range) — skip
    const m = zero();
    const cur = zero();
    const prev = zero();
    for (const x of e.metrics) {
      const raw = {
        spend: x.spend,
        impressions: x.impressions,
        clicks: x.clicks,
        conversions: x.conversions,
        revenue: x.revenue,
      };
      addRaw(m, raw);
      addRaw(x.date < mid ? prev : cur, raw);
    }
    if (m.spend === 0 && m.impressions === 0) continue; // no activity in range
    parent.ads.push({
      id: e.id,
      externalId: e.externalId,
      name: e.name,
      status: e.status,
      platform: e.platform,
      ...deriveKpis(m),
      trend: trendOn ? computeTrend(cur, prev) : null,
    });
  }
  for (const adset of adsetByKey.values())
    adset.ads.sort((a, b) => b.spend - a.spend);

  // Campaigns with spend but NO adset metrics in range (deep sync not run for
  // that window / platform hiccup): fall back to their AdSpend campaign-day
  // rows so they don't vanish from the optimizer. AdSpend carries no campaign
  // externalId → match by (accountId, campaignName); same-name campaigns in
  // one account collapse (accepted).
  const spendRows = await prisma.adSpend.findMany({
    where: {
      organizationId: filters.organizationId,
      source: "API",
      date: { gte: range.start, lt: range.end },
      accountId: filters.accountId ? filters.accountId : { not: null },
      ...(filters.storeId ? { storeId: filters.storeId } : {}),
      ...(filters.platform ? { platform: filters.platform } : {}),
    },
    select: {
      accountId: true,
      campaignName: true,
      date: true,
      spend: true,
      impressions: true,
      clicks: true,
      conversions: true,
      revenue: true,
    },
  });
  const spendAgg = new Map<string, { total: Raw; cur: Raw; prev: Raw }>();
  for (const r of spendRows) {
    const key = `${r.accountId}|${r.campaignName ?? ""}`;
    let agg = spendAgg.get(key);
    if (!agg) {
      agg = { total: zero(), cur: zero(), prev: zero() };
      spendAgg.set(key, agg);
    }
    const raw = {
      spend: r.spend,
      impressions: r.impressions,
      clicks: r.clicks,
      conversions: r.conversions,
      revenue: r.revenue,
    };
    addRaw(agg.total, raw);
    addRaw(r.date < mid ? agg.prev : agg.cur, raw);
  }
  for (const [key, info] of campaignInfo) {
    if (campMap.has(key)) continue; // has adset data → covered
    const agg = spendAgg.get(`${info.accountId}|${info.name}`);
    if (!agg || agg.total.spend <= 0) continue;
    campMap.set(key, {
      id: info.id,
      externalId: info.externalId,
      name: info.name,
      platform: info.platform,
      status: info.status,
      storeId: info.storeId,
      dataLevel: "campaign",
      adsets: [],
      ...deriveKpis(agg.total),
      trend: trendOn ? computeTrend(agg.cur, agg.prev) : null,
    });
  }

  // roll adsets up to campaigns + compute campaign KPIs
  const campaigns: CampaignNode[] = [];
  const grand = zero();
  for (const [key, c] of campMap) {
    if (c.dataLevel === "adset") {
      const agg = c.adsets.reduce(
        (acc, a) => ({
          spend: acc.spend + a.spend,
          impressions: acc.impressions + a.impressions,
          clicks: acc.clicks + a.clicks,
          conversions: acc.conversions + a.conversions,
          revenue: acc.revenue + a.revenue,
        }),
        zero()
      );
      Object.assign(c, deriveKpis(agg));
      c.adsets.sort((a, b) => b.spend - a.spend);
      const halves = campHalves.get(key);
      c.trend =
        trendOn && halves ? computeTrend(halves.cur, halves.prev) : null;
    }
    grand.spend += c.spend;
    grand.impressions += c.impressions;
    grand.clicks += c.clicks;
    grand.conversions += c.conversions;
    grand.revenue += c.revenue;
    campaigns.push(c);
  }
  campaigns.sort((a, b) => b.spend - a.spend);

  return { campaigns, totals: deriveKpis(grand), rangeDays };
}
