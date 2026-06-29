// ---------------------------------------------------------------------------
// META (Facebook) Marketing API — Insights at campaign × day level.
// Auth: a (long-lived) access token. externalId = ad account id (act_xxxxx).
// ---------------------------------------------------------------------------
import { AdAccountCreds, AdInsight, AdsetInsight, num, ymd } from "./types";

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
  since: Date
): Promise<AdInsight[]> {
  if (!creds.accessToken) throw new Error("Meta: thiếu access token");
  const acct = creds.externalId.startsWith("act_")
    ? creds.externalId
    : `act_${creds.externalId}`;

  const timeRange = JSON.stringify({ since: ymd(since), until: ymd(new Date()) });
  const params = new URLSearchParams({
    level: "campaign",
    time_increment: "1",
    fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values",
    time_range: timeRange,
    limit: "500",
    access_token: creds.accessToken,
  });

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

/** Deep fetch: ad set × day insights, carrying parent campaign id/name. */
export async function fetchMetaAdsets(
  creds: AdAccountCreds,
  since: Date
): Promise<AdsetInsight[]> {
  if (!creds.accessToken) throw new Error("Meta: thiếu access token");
  const acct = creds.externalId.startsWith("act_")
    ? creds.externalId
    : `act_${creds.externalId}`;

  const params = new URLSearchParams({
    level: "adset",
    time_increment: "1",
    fields:
      "campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks,actions,action_values",
    time_range: JSON.stringify({ since: ymd(since), until: ymd(new Date()) }),
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
        adsetExternalId: r.adset_id ?? "",
        adsetName: r.adset_name ?? "(unknown)",
        status: null,
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
