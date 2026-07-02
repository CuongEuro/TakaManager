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

export interface AdsetNode extends Kpis {
  id: string;
  externalId: string;
  name: string;
  status: string | null;
  platform: string;
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
}

export interface AdTree {
  campaigns: CampaignNode[];
  totals: Kpis;
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

  for (const e of entities) {
    if (e.level !== "ADSET") continue;
    const m = e.metrics.reduce(
      (acc, x) => ({
        spend: acc.spend + x.spend,
        impressions: acc.impressions + x.impressions,
        clicks: acc.clicks + x.clicks,
        conversions: acc.conversions + x.conversions,
        revenue: acc.revenue + x.revenue,
      }),
      zero()
    );
    const adset: AdsetNode = {
      id: e.id,
      externalId: e.externalId,
      name: e.name,
      status: e.status,
      platform: e.platform,
      ...deriveKpis(m),
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
  }

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
      spend: true,
      impressions: true,
      clicks: true,
      conversions: true,
      revenue: true,
    },
  });
  const spendAgg = new Map<string, ReturnType<typeof zero>>();
  for (const r of spendRows) {
    const key = `${r.accountId}|${r.campaignName ?? ""}`;
    const cur = spendAgg.get(key) ?? zero();
    cur.spend += r.spend;
    cur.impressions += r.impressions;
    cur.clicks += r.clicks;
    cur.conversions += r.conversions;
    cur.revenue += r.revenue;
    spendAgg.set(key, cur);
  }
  for (const [key, info] of campaignInfo) {
    if (campMap.has(key)) continue; // has adset data → covered
    const agg = spendAgg.get(`${info.accountId}|${info.name}`);
    if (!agg || agg.spend <= 0) continue;
    campMap.set(key, {
      id: info.id,
      externalId: info.externalId,
      name: info.name,
      platform: info.platform,
      status: info.status,
      storeId: info.storeId,
      dataLevel: "campaign",
      adsets: [],
      ...deriveKpis(agg),
    });
  }

  // roll adsets up to campaigns + compute campaign KPIs
  const campaigns: CampaignNode[] = [];
  const grand = zero();
  for (const c of campMap.values()) {
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
    }
    grand.spend += c.spend;
    grand.impressions += c.impressions;
    grand.clicks += c.clicks;
    grand.conversions += c.conversions;
    grand.revenue += c.revenue;
    campaigns.push(c);
  }
  campaigns.sort((a, b) => b.spend - a.spend);

  return { campaigns, totals: deriveKpis(grand) };
}
