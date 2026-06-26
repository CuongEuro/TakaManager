// ---------------------------------------------------------------------------
// AD SYNC ORCHESTRATOR — pull spend from Meta/Google/X into AdSpend (Phase 3).
// Upserts by (storeId, platform, date, campaignName, source=API) — re-runnable.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import {
  AdAccountCreds,
  AdInsight,
  AdsetInsight,
  adSpendDedupeKey,
} from "@/lib/ads/types";
import { fetchMetaInsights, fetchMetaAdsets, testMeta } from "@/lib/ads/meta";
import { fetchGoogleInsights, fetchGoogleAdsets, testGoogle } from "@/lib/ads/google";
import { fetchTwitterInsights, fetchTwitterAdsets, testTwitter } from "@/lib/ads/twitter";

type AdAccountRow = {
  id: string;
  organizationId: string;
  storeId: string | null;
  platform: string;
  name: string;
  externalId: string;
  lastSyncedAt: Date | null;
  accessToken: string | null;
  accessSecret: string | null;
  apiKey: string | null;
  apiSecret: string | null;
  refreshToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  developerToken: string | null;
  loginCustomerId: string | null;
};

function toCreds(a: AdAccountRow): AdAccountCreds {
  return {
    platform: a.platform,
    externalId: a.externalId,
    accessToken: a.accessToken,
    accessSecret: a.accessSecret,
    apiKey: a.apiKey,
    apiSecret: a.apiSecret,
    refreshToken: a.refreshToken,
    clientId: a.clientId,
    clientSecret: a.clientSecret,
    developerToken: a.developerToken,
    loginCustomerId: a.loginCustomerId,
  };
}

function fetchInsights(creds: AdAccountCreds, since: Date): Promise<AdInsight[]> {
  switch (creds.platform) {
    case "FACEBOOK":
      return fetchMetaInsights(creds, since);
    case "GOOGLE":
      return fetchGoogleInsights(creds, since);
    case "TWITTER":
      return fetchTwitterInsights(creds, since);
    default:
      throw new Error(`Nền tảng không hỗ trợ: ${creds.platform}`);
  }
}

function fetchAdsets(creds: AdAccountCreds, since: Date): Promise<AdsetInsight[]> {
  switch (creds.platform) {
    case "FACEBOOK":
      return fetchMetaAdsets(creds, since);
    case "GOOGLE":
      return fetchGoogleAdsets(creds, since);
    case "TWITTER":
      return fetchTwitterAdsets(creds, since);
    default:
      throw new Error(`Nền tảng không hỗ trợ: ${creds.platform}`);
  }
}

/** Upsert campaign+adset entities and their daily metrics. Returns adset count. */
async function syncHierarchy(
  account: {
    id: string;
    organizationId: string;
    storeId: string | null;
    platform: string;
  },
  rows: AdsetInsight[]
): Promise<number> {
  // 1) upsert campaign + adset entities
  const campaigns = new Map<string, string>(); // externalId -> name
  const adsets = new Map<string, { name: string; parent: string; status: string | null }>();
  for (const r of rows) {
    if (r.campaignExternalId) campaigns.set(r.campaignExternalId, r.campaignName);
    if (r.adsetExternalId)
      adsets.set(r.adsetExternalId, {
        name: r.adsetName,
        parent: r.campaignExternalId,
        status: r.status,
      });
  }

  for (const [externalId, name] of campaigns) {
    await prisma.adEntity.upsert({
      where: { accountId_externalId: { accountId: account.id, externalId } },
      create: {
        organizationId: account.organizationId,
        accountId: account.id,
        storeId: account.storeId,
        platform: account.platform,
        level: "CAMPAIGN",
        externalId,
        name,
      },
      update: { name },
    });
  }

  const adsetIdMap = new Map<string, string>(); // externalId -> AdEntity.id
  for (const [externalId, a] of adsets) {
    const e = await prisma.adEntity.upsert({
      where: { accountId_externalId: { accountId: account.id, externalId } },
      create: {
        organizationId: account.organizationId,
        accountId: account.id,
        storeId: account.storeId,
        platform: account.platform,
        level: "ADSET",
        externalId,
        name: a.name,
        parentExternalId: a.parent,
        status: a.status,
      },
      update: { name: a.name, parentExternalId: a.parent, status: a.status },
    });
    adsetIdMap.set(externalId, e.id);
  }

  // 2) aggregate rows per (adset, date) then upsert metrics
  const byKey = new Map<string, AdsetInsight>();
  for (const r of rows) {
    if (!r.adsetExternalId) continue;
    const key = `${r.adsetExternalId}|${r.date}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.spend += r.spend;
      cur.impressions += r.impressions;
      cur.clicks += r.clicks;
      cur.conversions += r.conversions;
      cur.revenue += r.revenue;
    } else {
      byKey.set(key, { ...r });
    }
  }
  for (const r of byKey.values()) {
    const entityId = adsetIdMap.get(r.adsetExternalId);
    if (!entityId) continue;
    const date = new Date(`${r.date}T00:00:00`);
    await prisma.adMetric.upsert({
      where: { entityId_date: { entityId, date } },
      create: {
        entityId,
        date,
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.clicks,
        conversions: r.conversions,
        revenue: r.revenue,
      },
      update: {
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.clicks,
        conversions: r.conversions,
        revenue: r.revenue,
      },
    });
  }
  return adsets.size;
}

export async function testAdAccount(
  accountId: string,
  organizationId: string
): Promise<{ ok: boolean; info?: string; error?: string }> {
  const a = await prisma.adAccount.findUnique({ where: { id: accountId } });
  if (!a || a.organizationId !== organizationId)
    return { ok: false, error: "Không tìm thấy tài khoản" };
  const creds = toCreds(a);
  try {
    let info: string;
    if (a.platform === "FACEBOOK") info = await testMeta(creds);
    else if (a.platform === "GOOGLE") info = await testGoogle(creds);
    else if (a.platform === "TWITTER") info = await testTwitter(creds);
    else throw new Error("Nền tảng không hỗ trợ");
    return { ok: true, info };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface AdSyncResult {
  accountId: string;
  name: string;
  platform: string;
  rows: number;
  adsets: number;
  since: string;
  ok: boolean;
  error?: string;
}

export async function syncAdAccount(
  accountId: string,
  organizationId: string,
  opts: { sinceDays?: number } = {}
): Promise<AdSyncResult> {
  const a = await prisma.adAccount.findUnique({ where: { id: accountId } });
  if (!a || a.organizationId !== organizationId)
    throw new Error("Không tìm thấy tài khoản");

  const since = opts.sinceDays
    ? daysAgo(opts.sinceDays)
    : a.lastSyncedAt
    ? new Date(a.lastSyncedAt.getTime() - 2 * 86400000)
    : daysAgo(30);

  try {
    const creds = toCreds(a);
    const insights = await fetchInsights(creds, since);

    // Aggregate by dedupeKey first (collapses same-day/same-campaign rows within
    // this run), then upsert by the unique key — idempotent across re-syncs.
    const agg = new Map<
      string,
      {
        date: Date;
        campaignName: string | null;
        spend: number;
        impressions: number;
        clicks: number;
        conversions: number;
        revenue: number;
      }
    >();
    for (const ins of insights) {
      const key = adSpendDedupeKey({
        source: "API",
        storeId: a.storeId,
        platform: a.platform,
        date: ins.date,
        campaignName: ins.campaignName,
      });
      const cur = agg.get(key);
      if (cur) {
        cur.spend += ins.spend;
        cur.impressions += ins.impressions;
        cur.clicks += ins.clicks;
        cur.conversions += ins.conversions;
        cur.revenue += ins.revenue;
      } else {
        agg.set(key, {
          date: new Date(`${ins.date}T00:00:00`),
          campaignName: ins.campaignName,
          spend: ins.spend,
          impressions: ins.impressions,
          clicks: ins.clicks,
          conversions: ins.conversions,
          revenue: ins.revenue,
        });
      }
    }

    for (const [dedupeKey, row] of agg) {
      await prisma.adSpend.upsert({
        where: { dedupeKey },
        create: {
          organizationId: a.organizationId,
          storeId: a.storeId,
          platform: a.platform,
          date: row.date,
          campaignName: row.campaignName,
          spend: row.spend,
          impressions: row.impressions,
          clicks: row.clicks,
          conversions: row.conversions,
          revenue: row.revenue,
          source: "API",
          dedupeKey,
        },
        update: {
          date: row.date,
          spend: row.spend,
          impressions: row.impressions,
          clicks: row.clicks,
          conversions: row.conversions,
          revenue: row.revenue,
        },
      });
    }

    // deep hierarchy: campaign + adset entities & daily metrics
    const adsetRows = await fetchAdsets(creds, since);
    const adsets = await syncHierarchy(
      {
        id: a.id,
        organizationId: a.organizationId,
        storeId: a.storeId,
        platform: a.platform,
      },
      adsetRows
    );

    await prisma.adAccount.update({
      where: { id: accountId },
      data: { lastSyncedAt: new Date() },
    });

    return {
      accountId,
      name: a.name,
      platform: a.platform,
      rows: insights.length,
      adsets,
      since: since.toISOString(),
      ok: true,
    };
  } catch (e) {
    return {
      accountId,
      name: a.name,
      platform: a.platform,
      rows: 0,
      adsets: 0,
      since: since.toISOString(),
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function syncAllAdAccounts(
  organizationId: string,
  opts: { sinceDays?: number } = {}
): Promise<AdSyncResult[]> {
  const accounts = await prisma.adAccount.findMany({
    where: { organizationId, active: true },
    select: { id: true },
  });
  const results: AdSyncResult[] = [];
  for (const a of accounts)
    results.push(await syncAdAccount(a.id, organizationId, opts));
  return results;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400000);
}
