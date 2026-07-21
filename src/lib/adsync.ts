// ---------------------------------------------------------------------------
// AD SYNC ORCHESTRATOR — pull spend from Meta/Google/X into AdSpend (Phase 3).
// Upserts by (storeId, platform, date, campaignName, source=API) — re-runnable.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import {
  AdAccountCreds,
  AdInsight,
  AdsetInsight,
  AdCreativeInsight,
  adSpendDedupeKey,
} from "@/lib/ads/types";
import {
  fetchMetaInsights,
  fetchMetaAdsets,
  fetchMetaAds,
  testMeta,
} from "@/lib/ads/meta";
import {
  fetchGoogleInsights,
  fetchGoogleAdsets,
  fetchGoogleAds,
  testGoogle,
} from "@/lib/ads/google";
import {
  fetchTwitterInsights,
  fetchTwitterAdsets,
  fetchTwitterAds,
  testTwitter,
} from "@/lib/ads/twitter";
import { customRange, isoDay } from "@/lib/dates";

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

function fetchInsights(
  creds: AdAccountCreds,
  since: Date,
  until: Date
): Promise<AdInsight[]> {
  switch (creds.platform) {
    case "FACEBOOK":
      return fetchMetaInsights(creds, since, until);
    case "GOOGLE":
      return fetchGoogleInsights(creds, since, until);
    case "TWITTER":
      return fetchTwitterInsights(creds, since, until);
    default:
      throw new Error(`Nền tảng không hỗ trợ: ${creds.platform}`);
  }
}

function fetchAdsets(
  creds: AdAccountCreds,
  since: Date,
  until: Date
): Promise<AdsetInsight[]> {
  switch (creds.platform) {
    case "FACEBOOK":
      return fetchMetaAdsets(creds, since, until);
    case "GOOGLE":
      return fetchGoogleAdsets(creds, since, until);
    case "TWITTER":
      return fetchTwitterAdsets(creds, since, until);
    default:
      throw new Error(`Nền tảng không hỗ trợ: ${creds.platform}`);
  }
}

function fetchAdCreatives(
  creds: AdAccountCreds,
  since: Date,
  until: Date
): Promise<AdCreativeInsight[]> {
  switch (creds.platform) {
    case "FACEBOOK":
      return fetchMetaAds(creds, since, until);
    case "GOOGLE":
      return fetchGoogleAds(creds, since, until);
    case "TWITTER":
      return fetchTwitterAds(creds, since, until);
    default:
      return Promise.resolve([]);
  }
}

/** Keep large-account DB writes bounded but no longer fully sequential. A small
 * batch avoids exhausting the Prisma/Postgres connection pool. */
async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = 5
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    out.push(...(await Promise.all(items.slice(i, i + concurrency).map(fn))));
  }
  return out;
}

/** Upsert campaign+adset entities and their daily metrics. Returns adset count.
 *  taxMultiplier: platform spend is pre-tax; store it tax-inclusive so the
 *  optimize tree's ROAS matches AdSpend / the P&L. */
async function syncHierarchy(
  account: {
    id: string;
    organizationId: string;
    storeId: string | null;
    platform: string;
  },
  rows: AdsetInsight[],
  taxMultiplier: number,
  adRows: AdCreativeInsight[] = []
): Promise<number> {
  // 1) upsert campaign + adset entities
  const campaigns = new Map<string, { name: string; status: string | null }>();
  const adsets = new Map<string, { name: string; parent: string; status: string | null }>();
  for (const r of rows) {
    if (r.campaignExternalId)
      campaigns.set(r.campaignExternalId, {
        name: r.campaignName,
        status: r.campaignStatus,
      });
    if (r.adsetExternalId)
      adsets.set(r.adsetExternalId, {
        name: r.adsetName,
        parent: r.campaignExternalId,
        status: r.status,
      });
  }

  await mapConcurrent([...campaigns], async ([externalId, c]) => {
    await prisma.adEntity.upsert({
      where: { accountId_externalId: { accountId: account.id, externalId } },
      create: {
        organizationId: account.organizationId,
        accountId: account.id,
        storeId: account.storeId,
        platform: account.platform,
        level: "CAMPAIGN",
        externalId,
        name: c.name,
        status: c.status,
      },
      // Never touch storeId here — it holds the user's campaign→store mapping.
      update: { name: c.name, ...(c.status ? { status: c.status } : {}) },
    });
  });

  const savedAdsets = await mapConcurrent([...adsets], async ([externalId, a]) => {
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
    return [externalId, e.id] as const;
  });
  const adsetIdMap = new Map(savedAdsets); // externalId -> AdEntity.id

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
  await mapConcurrent([...byKey.values()], async (r) => {
    const entityId = adsetIdMap.get(r.adsetExternalId);
    if (!entityId) return;
    const date = new Date(`${r.date}T00:00:00Z`);
    const metric = {
      spend: r.spend * taxMultiplier,
      impressions: r.impressions,
      clicks: r.clicks,
      conversions: r.conversions,
      revenue: r.revenue,
    };
    const dayWindow = customRange(r.date, r.date);
    await prisma.adMetric.deleteMany({
      where: {
        entityId,
        date: { gte: dayWindow.start, lt: dayWindow.end },
      },
    });
    await prisma.adMetric.upsert({
      where: { entityId_date: { entityId, date } },
      create: { entityId, date, ...metric },
      update: metric,
    });
  });

  // 3) AD (creative) tier — entities parented to their ad set + daily metrics.
  if (adRows.length > 0) {
    const ads = new Map<
      string,
      { name: string; parent: string; status: string | null }
    >();
    for (const r of adRows)
      if (r.adExternalId)
        ads.set(r.adExternalId, {
          name: r.adName,
          parent: r.adsetExternalId,
          status: r.status,
        });

    const savedAds = await mapConcurrent([...ads], async ([externalId, a]) => {
      const e = await prisma.adEntity.upsert({
        where: { accountId_externalId: { accountId: account.id, externalId } },
        create: {
          organizationId: account.organizationId,
          accountId: account.id,
          storeId: account.storeId,
          platform: account.platform,
          level: "AD",
          externalId,
          name: a.name,
          parentExternalId: a.parent,
          status: a.status,
        },
        update: { name: a.name, parentExternalId: a.parent, status: a.status },
      });
      return [externalId, e.id] as const;
    });
    const adIdMap = new Map(savedAds);

    const adByKey = new Map<string, AdCreativeInsight>();
    for (const r of adRows) {
      if (!r.adExternalId) continue;
      const key = `${r.adExternalId}|${r.date}`;
      const cur = adByKey.get(key);
      if (cur) {
        cur.spend += r.spend;
        cur.impressions += r.impressions;
        cur.clicks += r.clicks;
        cur.conversions += r.conversions;
        cur.revenue += r.revenue;
      } else {
        adByKey.set(key, { ...r });
      }
    }
    await mapConcurrent([...adByKey.values()], async (r) => {
      const entityId = adIdMap.get(r.adExternalId);
      if (!entityId) return;
      const date = new Date(`${r.date}T00:00:00Z`);
      const metric = {
        spend: r.spend * taxMultiplier,
        impressions: r.impressions,
        clicks: r.clicks,
        conversions: r.conversions,
        revenue: r.revenue,
      };
      const dayWindow = customRange(r.date, r.date);
      await prisma.adMetric.deleteMany({
        where: {
          entityId,
          date: { gte: dayWindow.start, lt: dayWindow.end },
        },
      });
      await prisma.adMetric.upsert({
        where: { entityId_date: { entityId, date } },
        create: { entityId, date, ...metric },
        update: metric,
      });
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
  opts: {
    sinceDays?: number;
    since?: string | Date; // explicit window start (chunked / custom range)
    until?: string | Date; // explicit window end (defaults to today)
    deep?: boolean; // also pull ad set-level detail (heavy). Default false.
    ads?: boolean; // also pull AD/creative-level detail (heaviest). Default true when deep.
  } = {}
): Promise<AdSyncResult> {
  const a = await prisma.adAccount.findUnique({ where: { id: accountId } });
  if (!a || a.organizationId !== organizationId)
    throw new Error("Không tìm thấy tài khoản");

  // Window resolution. Explicit since/until (from chunked or custom-range sync)
  // wins; else sinceDays (0 = today is valid → use != null); else today only.
  // Historical spend is stable and is deliberately not re-requested by the
  // normal refresh path. Users can still select an older window to backfill.
  const until = opts.until != null ? parseDay(opts.until) : new Date();
  const since =
    opts.since != null
      ? parseDay(opts.since)
      : opts.sinceDays != null
      ? daysAgo(opts.sinceDays)
      : daysAgo(0);
  // Tokyo calendar-day boundaries are used only to find legacy rows that have
  // a confirmed replacement in this run; absent provider rows are preserved.
  const window = customRange(isoDay(since), isoDay(until));

  try {
    const creds = toCreds(a);
    // Platform spend is pre-tax; the real cost billed includes consumption/VAT.
    // The SAME multiplier is applied to AdSpend and AdMetric so P&L and the
    // optimize tree agree (JP default 10%).
    const taxMultiplier = 1 + (a.taxRate ?? 0);
    const knownCampaigns = await prisma.adEntity.findMany({
      where: { accountId: a.id, level: "CAMPAIGN" },
      select: { externalId: true, name: true },
    });
    const previousCampaignName = new Map(
      knownCampaigns.map((c) => [c.externalId, c.name])
    );
    // Campaign-level spend (light) — always pulled; retried on transient errors.
    const insights = await withRetry(() => fetchInsights(creds, since, until));

    // Deep ad set-level detail is HEAVY (a common source of Meta "Service
    // temporarily unavailable" on long windows). Pull it only when requested
    // (the newest chunk); older backfill chunks skip it. Campaign entities still
    // get upserted from `insights` below, so attribution keeps working.
    let adsets = 0;
    if (opts.deep === true) {
      const adsetRows = await withRetry(() => fetchAdsets(creds, since, until));
      // AD/creative tier is the heaviest. A requested creative sync must report
      // failure instead of silently claiming that a partial hierarchy is done.
      // Skip it explicitly with ads:false. Default on when deep.
      const adRows =
        opts.ads !== false
          ? await withRetry(() => fetchAdCreatives(creds, since, until))
          : [];
      adsets = await syncHierarchy(
        {
          id: a.id,
          organizationId: a.organizationId,
          storeId: a.storeId,
          platform: a.platform,
        },
        adsetRows,
        taxMultiplier,
        adRows
      );
    }

    // Ensure a CAMPAIGN entity exists for every campaign that has spend (even if
    // the deep adset fetch returned nothing for it) so attribution can map it.
    // Also refresh name + status (from the light insights) so the Active/Inactive
    // filter works after ANY sync. update never touches storeId → preserves the
    // user's campaign→store mapping.
    const insightCampaigns = new Map<
      string,
      { name: string | null; status: string | null }
    >();
    for (const ins of insights)
      if (ins.campaignExternalId)
        insightCampaigns.set(ins.campaignExternalId, {
          name: ins.campaignName,
          status: ins.campaignStatus,
        });
    await mapConcurrent([...insightCampaigns], async ([externalId, c]) => {
      await prisma.adEntity.upsert({
        where: { accountId_externalId: { accountId: a.id, externalId } },
        create: {
          organizationId: a.organizationId,
          accountId: a.id,
          storeId: a.storeId,
          platform: a.platform,
          level: "CAMPAIGN",
          externalId,
          name: c.name ?? "(unknown)",
          status: c.status,
        },
        update: {
          ...(c.name ? { name: c.name } : {}),
          ...(c.status ? { status: c.status } : {}),
        },
      });
    });

    // Campaign → store mapping (campaign-level attribution). A spend row's store
    // is the campaign's mapped store, else the account's store (Google/Twitter =
    // one account per store; Meta = shared account split per campaign).
    const campaignEntities = await prisma.adEntity.findMany({
      where: { accountId: a.id, level: "CAMPAIGN" },
      select: { externalId: true, storeId: true },
    });
    const campaignStore = new Map(
      campaignEntities.map((c) => [c.externalId, c.storeId])
    );
    const resolveStore = (cid: string | null): string | null =>
      (cid ? campaignStore.get(cid) : null) ?? a.storeId;

    // Aggregate by dedupeKey first (collapses same-day/same-campaign rows within
    // this run), with the RESOLVED store.
    const agg = new Map<
      string,
      {
        date: Date;
        storeId: string | null;
        campaignName: string | null;
        spend: number;
        impressions: number;
        clicks: number;
        conversions: number;
        revenue: number;
      }
    >();
    for (const ins of insights) {
      const storeId = resolveStore(ins.campaignExternalId);
      const key = adSpendDedupeKey({
        source: "API",
        accountId: a.id,
        platform: a.platform,
        date: ins.date,
        campaignExternalId: ins.campaignExternalId,
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
          date: new Date(`${ins.date}T00:00:00Z`),
          storeId,
          campaignName: ins.campaignName,
          spend: ins.spend,
          impressions: ins.impressions,
          clicks: ins.clicks,
          conversions: ins.conversions,
          revenue: ins.revenue,
        });
      }
    }

    // Migrate only rows that the provider returned in THIS run from the legacy
    // name/store-based key to the stable v2 provider-ID key. Crucially, rows for
    // campaigns deleted on the ad platform are not returned and remain intact.
    // This preserves historical spend instead of deleting the whole window.
    const returnedDayNames = new Set<string>();
    for (const ins of insights) {
      returnedDayNames.add(`${ins.date}|${ins.campaignName ?? ""}`);
      const previousName = ins.campaignExternalId
        ? previousCampaignName.get(ins.campaignExternalId)
        : null;
      if (previousName) returnedDayNames.add(`${ins.date}|${previousName}`);
    }
    const currentKeys = new Set(agg.keys());
    const existingRows = await prisma.adSpend.findMany({
      where: {
        accountId: a.id,
        source: "API",
        date: { gte: window.start, lt: window.end },
      },
      select: { id: true, date: true, campaignName: true, dedupeKey: true },
    });
    const legacyIds = existingRows
      .filter(
        (r) =>
          !!r.dedupeKey &&
          !r.dedupeKey.startsWith("v2|") &&
          !currentKeys.has(r.dedupeKey) &&
          returnedDayNames.has(
            `${isoDay(r.date)}|${r.campaignName ?? ""}`
          )
      )
      .map((r) => r.id);
    if (legacyIds.length > 0) {
      await prisma.adSpend.deleteMany({ where: { id: { in: legacyIds } } });
    }

    await mapConcurrent([...agg], async ([dedupeKey, row]) => {
      const spend = row.spend * taxMultiplier;
      await prisma.adSpend.upsert({
        where: { dedupeKey },
        create: {
          organizationId: a.organizationId,
          storeId: row.storeId,
          accountId: a.id,
          platform: a.platform,
          date: row.date,
          campaignName: row.campaignName,
          spend,
          impressions: row.impressions,
          clicks: row.clicks,
          conversions: row.conversions,
          revenue: row.revenue,
          source: "API",
          dedupeKey,
        },
        update: {
          storeId: row.storeId,
          accountId: a.id,
          date: row.date,
          campaignName: row.campaignName,
          spend,
          impressions: row.impressions,
          clicks: row.clicks,
          conversions: row.conversions,
          revenue: row.revenue,
        },
      });
    });

    // A historical backfill must not make the dashboard think today's refresh
    // just ran. Stamp only windows that include the current provider day.
    if (isoDay(until) >= isoDay(new Date())) {
      await prisma.adAccount.update({
        where: { id: accountId },
        data: { lastSyncedAt: new Date() },
      });
    }

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
  opts: { sinceDays?: number; deep?: boolean; ads?: boolean } = {}
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

// Transient platform errors worth an in-place retry (Meta "Service temporarily
// unavailable" / code 1-2, rate limits, 5xx, throttling). Permanent errors
// (bad token, permission) don't match → fail fast.
const TRANSIENT = /temporarily unavailable|service unavailable|unexpected error|please (reduce|retry)|reduce the amount|HTTP (429|5\d\d)|throttl|rate limit|timeout|ETIMEDOUT|ECONNRESET/i;

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (i >= attempts || !TRANSIENT.test(m)) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * i)); // backoff: 1.5s,3s,4.5s
    }
  }
  throw lastErr;
}

// Date-only bounds and stored daily metrics use UTC midnight as a stable
// database key. Provider request days are derived in Asia/Tokyo by ads/types.
function parseDay(v: string | Date): Date {
  if (v instanceof Date) return v;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : new Date(v);
}
