// ---------------------------------------------------------------------------
// META (Facebook) Marketing API — Insights at campaign × day level.
// Auth: a (long-lived) access token. externalId = ad account id (act_xxxxx).
// ---------------------------------------------------------------------------
import {
  AdAccountCreds,
  AdInsight,
  AdsetInsight,
  AdCreativeInsight,
  normalizeAdStatus,
  num,
  ymd,
} from "./types";

// Meta deprecates each Graph/Marketing API version ~2 years after release.
// Keep current to avoid a hard cutoff. (v20 deprecates 2026-09-24; latest is
// v25 as of 2026-06. Insights fields used here are stable across versions.)
const API_VERSION = "v23.0";
const PURCHASE_KEYS = ["purchase", "omni_purchase"];

interface MetaRow {
  date_start: string;
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: { action_type: string; value: string }[];
  action_values?: { action_type: string; value: string }[];
}

function purchaseValue(rows?: { action_type: string; value: string }[]): number {
  if (!rows) return 0;
  return rows
    .filter((r) => PURCHASE_KEYS.includes(r.action_type))
    .reduce((s, r) => s + num(r.value), 0);
}

export async function testMeta(creds: AdAccountCreds): Promise<string> {
  const acct = creds.externalId.startsWith("act_")
    ? creds.externalId
    : `act_${creds.externalId}`;
  const url = `https://graph.facebook.com/${API_VERSION}/${acct}?fields=name,currency&access_token=${encodeURIComponent(
    creds.accessToken ?? ""
  )}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error)
    throw new Error(json.error?.message ?? `Meta HTTP ${res.status}`);
  return `${json.name} (${json.currency})`;
}

export async function fetchMetaInsights(
  creds: AdAccountCreds,
  since: Date,
  until: Date = new Date()
): Promise<AdInsight[]> {
  if (!creds.accessToken) throw new Error("Meta: thiếu access token");
  const acct = creds.externalId.startsWith("act_")
    ? creds.externalId
    : `act_${creds.externalId}`;

  const timeRange = JSON.stringify({ since: ymd(since), until: ymd(until) });
  const params = new URLSearchParams({
    level: "campaign",
    time_increment: "1",
    fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values",
    time_range: timeRange,
    limit: "500",
    access_token: creds.accessToken,
  });

  // Current campaign statuses (best-effort — the insights API has none). One
  // extra light call so the Active/Inactive filter works after a normal sync.
  let campaignStatus = new Map<string, string | null>();
  try {
    campaignStatus = await fetchStatusMap(creds, "campaigns");
  } catch {
    /* keep null statuses */
  }

  let url: string | null = `https://graph.facebook.com/${API_VERSION}/${acct}/insights?${params}`;
  const out: AdInsight[] = [];

  for (let page = 0; page < 100 && url; page++) {
    const res: Response = await fetch(url);
    const json = await res.json();
    if (!res.ok || json.error)
      throw new Error(json.error?.message ?? `Meta HTTP ${res.status}`);

    for (const r of (json.data ?? []) as MetaRow[]) {
      out.push({
        date: r.date_start,
        campaignExternalId: r.campaign_id ?? null,
        campaignName: r.campaign_name ?? null,
        campaignStatus: campaignStatus.get(r.campaign_id ?? "") ?? null,
        spend: num(r.spend),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        conversions: PURCHASE_KEYS.reduce(
          (s, k) =>
            s + num(r.actions?.find((a) => a.action_type === k)?.value),
          0
        ),
        revenue: purchaseValue(r.action_values),
      });
    }
    url = json.paging?.next ?? null;
  }
  return out;
}

interface MetaAdsetRow extends MetaRow {
  campaign_id?: string;
  adset_id?: string;
  adset_name?: string;
}

/** Current effective_status of every campaign/adset/ad in the account (the
 *  insights API carries no status). 1–2 extra calls per sync. */
async function fetchStatusMap(
  creds: AdAccountCreds,
  edge: "campaigns" | "adsets" | "ads"
): Promise<Map<string, string | null>> {
  const acct = creds.externalId.startsWith("act_")
    ? creds.externalId
    : `act_${creds.externalId}`;
  const params = new URLSearchParams({
    fields: "id,effective_status",
    limit: "500",
    access_token: creds.accessToken ?? "",
  });
  const map = new Map<string, string | null>();
  let url: string | null = `https://graph.facebook.com/${API_VERSION}/${acct}/${edge}?${params}`;
  for (let page = 0; page < 50 && url; page++) {
    const res: Response = await fetch(url);
    const json = await res.json();
    if (!res.ok || json.error)
      throw new Error(json.error?.message ?? `Meta HTTP ${res.status}`);
    for (const r of (json.data ?? []) as { id?: string; effective_status?: string }[]) {
      if (r.id) map.set(r.id, normalizeAdStatus(r.effective_status));
    }
    url = json.paging?.next ?? null;
  }
  return map;
}

/** Deep fetch: ad set × day insights, carrying parent campaign id/name. */
export async function fetchMetaAdsets(
  creds: AdAccountCreds,
  since: Date,
  until: Date = new Date()
): Promise<AdsetInsight[]> {
  if (!creds.accessToken) throw new Error("Meta: thiếu access token");
  const acct = creds.externalId.startsWith("act_")
    ? creds.externalId
    : `act_${creds.externalId}`;

  // Statuses are best-effort — a failure here must not kill the metrics sync.
  let campaignStatus = new Map<string, string | null>();
  let adsetStatus = new Map<string, string | null>();
  try {
    [campaignStatus, adsetStatus] = await Promise.all([
      fetchStatusMap(creds, "campaigns"),
      fetchStatusMap(creds, "adsets"),
    ]);
  } catch {
    /* keep null statuses */
  }

  const params = new URLSearchParams({
    level: "adset",
    time_increment: "1",
    fields:
      "campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks,actions,action_values",
    time_range: JSON.stringify({ since: ymd(since), until: ymd(until) }),
    limit: "500",
    access_token: creds.accessToken,
  });

  let url: string | null = `https://graph.facebook.com/${API_VERSION}/${acct}/insights?${params}`;
  const out: AdsetInsight[] = [];

  for (let page = 0; page < 200 && url; page++) {
    const res: Response = await fetch(url);
    const json = await res.json();
    if (!res.ok || json.error)
      throw new Error(json.error?.message ?? `Meta HTTP ${res.status}`);
    for (const r of (json.data ?? []) as MetaAdsetRow[]) {
      out.push({
        campaignExternalId: r.campaign_id ?? "",
        campaignName: r.campaign_name ?? "(unknown)",
        campaignStatus: campaignStatus.get(r.campaign_id ?? "") ?? null,
        adsetExternalId: r.adset_id ?? "",
        adsetName: r.adset_name ?? "(unknown)",
        status: adsetStatus.get(r.adset_id ?? "") ?? null,
        date: r.date_start,
        spend: num(r.spend),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        conversions: PURCHASE_KEYS.reduce(
          (s, k) => s + num(r.actions?.find((a) => a.action_type === k)?.value),
          0
        ),
        revenue: purchaseValue(r.action_values),
      });
    }
    url = json.paging?.next ?? null;
  }
  return out;
}

interface MetaAdRow extends MetaRow {
  adset_id?: string;
  ad_id?: string;
  ad_name?: string;
}

/** Deepest fetch: ad (creative) × day insights, carrying parent ad set id. */
export async function fetchMetaAds(
  creds: AdAccountCreds,
  since: Date,
  until: Date = new Date()
): Promise<AdCreativeInsight[]> {
  if (!creds.accessToken) throw new Error("Meta: thiếu access token");
  const acct = creds.externalId.startsWith("act_")
    ? creds.externalId
    : `act_${creds.externalId}`;

  let adStatus = new Map<string, string | null>();
  try {
    adStatus = await fetchStatusMap(creds, "ads");
  } catch {
    /* keep null statuses */
  }

  const params = new URLSearchParams({
    level: "ad",
    time_increment: "1",
    fields:
      "adset_id,ad_id,ad_name,spend,impressions,clicks,actions,action_values",
    time_range: JSON.stringify({ since: ymd(since), until: ymd(until) }),
    limit: "500",
    access_token: creds.accessToken,
  });

  let url: string | null = `https://graph.facebook.com/${API_VERSION}/${acct}/insights?${params}`;
  const out: AdCreativeInsight[] = [];

  for (let page = 0; page < 300 && url; page++) {
    const res: Response = await fetch(url);
    const json = await res.json();
    if (!res.ok || json.error)
      throw new Error(json.error?.message ?? `Meta HTTP ${res.status}`);
    for (const r of (json.data ?? []) as MetaAdRow[]) {
      out.push({
        adsetExternalId: r.adset_id ?? "",
        adExternalId: r.ad_id ?? "",
        adName: r.ad_name ?? "(unknown)",
        status: adStatus.get(r.ad_id ?? "") ?? null,
        date: r.date_start,
        spend: num(r.spend),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        conversions: PURCHASE_KEYS.reduce(
          (s, k) => s + num(r.actions?.find((a) => a.action_type === k)?.value),
          0
        ),
        revenue: purchaseValue(r.action_values),
      });
    }
    url = json.paging?.next ?? null;
  }
  return out;
}
