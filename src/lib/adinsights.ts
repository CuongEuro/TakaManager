// ---------------------------------------------------------------------------
// AD INSIGHTS — build a Campaign → AdSet tree with derived KPIs for a range.
// Reads the deep hierarchy (AdEntity + AdMetric).
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

  const entities = await prisma.adEntity.findMany({
    where,
    include: {
      metrics: { where: { date: { gte: range.start, lt: range.end } } },
    },
  });

  // campaign lookup: `${accountId}|${externalId}` -> { name, id, platform }
  const campaignInfo = new Map<
    string,
    { id: string; externalId: string; name: string; platform: string }
  >();
  for (const e of entities) {
    if (e.level === "CAMPAIGN")
      campaignInfo.set(`${e.accountId}|${e.externalId}`, {
        id: e.id,
        externalId: e.externalId,
        name: e.name,
        platform: e.platform,
      });
  }

  // group adsets under their campaign
  const campMap = new Map<string, CampaignNode>();
  const getCampaign = (key: string, fallback: Omit<CampaignNode, keyof Kpis | "adsets">) => {
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
    });
    camp.adsets.push(adset);
  }

  // roll adsets up to campaigns + compute campaign KPIs
  const campaigns: CampaignNode[] = [];
  const grand = zero();
  for (const c of campMap.values()) {
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
    grand.spend += agg.spend;
    grand.impressions += agg.impressions;
    grand.clicks += agg.clicks;
    grand.conversions += agg.conversions;
    grand.revenue += agg.revenue;
    campaigns.push(c);
  }
  campaigns.sort((a, b) => b.spend - a.spend);

  return { campaigns, totals: deriveKpis(grand) };
}
