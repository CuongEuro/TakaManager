// ---------------------------------------------------------------------------
// X (Twitter) Ads API — OAuth 1.0a (HMAC-SHA1) signed requests.
// Needs: apiKey (consumer key), apiSecret (consumer secret),
// accessToken, accessSecret, externalId (ads account id).
// NOTE: stats parsing is best-effort/experimental — validate with real creds.
// ---------------------------------------------------------------------------
import { createHmac, randomBytes } from "crypto";
import {
  AdAccountCreds,
  AdInsight,
  AdsetInsight,
  AdCreativeInsight,
  normalizeAdStatus,
  num,
  ymd,
} from "./types";
import { customRange } from "@/lib/dates";

export const X_ADS_API_BASE = "https://ads-api.x.com/12";

function requireTwitterCredentials(creds: AdAccountCreds): void {
  const missing = [
    ["Ads Account ID", creds.externalId],
    ["API Key", creds.apiKey],
    ["API Secret", creds.apiSecret],
    ["Access Token", creds.accessToken],
    ["Access Token Secret", creds.accessSecret],
  ]
    .filter(([, value]) => !value?.trim())
    .map(([label]) => label);
  if (missing.length > 0) {
    throw new Error(`X Ads: thiếu ${missing.join(", ")}`);
  }
}

/** RFC 3986 percent-encoding (stricter than encodeURIComponent). */
export function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** Build the OAuth 1.0a signature base string (method&url&sortedParams). */
export function buildBaseString(
  method: string,
  baseUrl: string,
  params: Record<string, string>
): string {
  const encoded = Object.keys(params)
    .map((k) => [percentEncode(k), percentEncode(params[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(
    encoded
  )}`;
}

/** Build the full Authorization header for an OAuth 1.0a request. */
export function oauthHeader(
  creds: AdAccountCreds,
  method: string,
  url: string,
  queryParams: Record<string, string>,
  nonce = randomBytes(16).toString("hex"),
  timestamp = Math.floor(Date.now() / 1000).toString()
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.apiKey ?? "",
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken ?? "",
    oauth_version: "1.0",
  };

  const baseString = buildBaseString(method, url, { ...oauth, ...queryParams });
  const signingKey = `${percentEncode(creds.apiSecret ?? "")}&${percentEncode(
    creds.accessSecret ?? ""
  )}`;
  const signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
  oauth.oauth_signature = signature;

  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`)
      .join(", ")
  );
}

async function signedGet(
  creds: AdAccountCreds,
  path: string,
  query: Record<string, string>
) {
  requireTwitterCredentials(creds);
  const url = `${X_ADS_API_BASE}${path}`;
  const auth = oauthHeader(creds, "GET", url, query);
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${url}?${qs}`, { headers: { Authorization: auth } });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const json = JSON.parse(text);
      detail =
        json?.errors?.map((e: { message?: string }) => e.message).filter(Boolean).join("; ") ||
        json?.error?.message ||
        detail;
    } catch {
      // Keep the response text when X did not return JSON.
    }
    throw new Error(`X Ads HTTP ${res.status}: ${detail}`);
  }
  return JSON.parse(text);
}

export async function testTwitter(creds: AdAccountCreds): Promise<string> {
  const json = await signedGet(creds, `/accounts/${creds.externalId}`, {});
  return json?.data?.name ?? `Account ${creds.externalId}`;
}

async function accountTimeZone(creds: AdAccountCreds): Promise<string> {
  if (creds.accountTimeZone) return creds.accountTimeZone;
  const json = await signedGet(creds, `/accounts/${creds.externalId}`, {});
  const timeZone = String(json?.data?.timezone ?? "").trim();
  if (!timeZone) throw new Error("X Ads: tài khoản không trả về múi giờ");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`X Ads: múi giờ tài khoản không hợp lệ (${timeZone})`);
  }
  creds.accountTimeZone = timeZone;
  return timeZone;
}

export interface TwitterDayWindow {
  startTime: string;
  endTime: string;
  dates: string[];
}

/**
 * X DAY analytics requires boundaries at midnight in the ad account timezone.
 * The UI's `until` day is inclusive; X's end_time is exclusive.
 */
export function twitterDayWindow(
  since: Date,
  until: Date,
  timeZone: string
): TwitterDayWindow {
  const sinceDay = ymd(since);
  const untilDay = ymd(until);
  const fromDay = sinceDay <= untilDay ? sinceDay : untilDay;
  const toDay = sinceDay <= untilDay ? untilDay : sinceDay;
  const range = customRange(fromDay, toDay, timeZone);
  const cursor = new Date(`${fromDay}T00:00:00Z`);
  const last = new Date(`${toDay}T00:00:00Z`);
  const dates: string[] = [];
  while (cursor.getTime() <= last.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return {
    startTime: range.start.toISOString().replace(".000Z", "Z"),
    endTime: range.end.toISOString().replace(".000Z", "Z"),
    dates,
  };
}

async function twitterWindow(
  creds: AdAccountCreds,
  since: Date,
  until: Date
): Promise<TwitterDayWindow> {
  return twitterDayWindow(since, until, await accountTimeZone(creds));
}

interface Campaign {
  id: string;
  name: string;
  status: string | null;
}

async function fetchCampaigns(creds: AdAccountCreds): Promise<Campaign[]> {
  const out: Campaign[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const q: Record<string, string> = { count: "200" };
    if (cursor) q.cursor = cursor;
    const json = await signedGet(creds, `/accounts/${creds.externalId}/campaigns`, q);
    for (const c of json.data ?? [])
      out.push({
        id: c.id,
        name: c.name,
        status: normalizeAdStatus(c.entity_status),
      });
    cursor = json.next_cursor;
    if (!cursor) break;
  }
  return out;
}

// --- WEB_CONVERSION metric parsing ------------------------------------------
// X returns conversion metrics either as a plain per-day array, or (typical) as
// an attribution object: { post_view: number[], post_engagement: number[],
// assisted: [...], order_quantity: [...], sale_amount: [...] } — amounts in
// local micro. Exact keys are version-dependent → parse defensively and log
// the metric keys once per sync so a mismatch is visible in Vercel logs.
type ConvMetric = unknown;

function convCount(m: ConvMetric, d: number): number {
  if (!m) return 0;
  if (Array.isArray(m)) return num(m[d]);
  const o = m as Record<string, unknown>;
  const pick = (k: string) => {
    const arr = o[k];
    return Array.isArray(arr) ? num(arr[d]) : 0;
  };
  return pick("post_engagement") + pick("post_view");
}

function convSale(m: ConvMetric, d: number): number {
  if (!m) return 0;
  const o = Array.isArray(m) ? null : (m as Record<string, unknown>);
  const arr = o
    ? (o.sale_amount ?? o.sale_amount_local_micro)
    : null;
  return Array.isArray(arr) ? num(arr[d]) / 1_000_000 : 0;
}

let loggedMetricKeys = false;
function logMetricKeysOnce(metrics: Record<string, unknown>) {
  if (loggedMetricKeys) return;
  loggedMetricKeys = true;
  try {
    const cp = metrics.conversion_purchases;
    console.log(
      "[X Ads] stats metric keys:",
      Object.keys(metrics).join(","),
      "| conversion_purchases keys:",
      cp && !Array.isArray(cp) ? Object.keys(cp as object).join(",") : typeof cp
    );
  } catch {
    /* logging only */
  }
}

export async function fetchTwitterInsights(
  creds: AdAccountCreds,
  since: Date,
  until: Date = new Date()
): Promise<AdInsight[]> {
  const [campaigns, window] = await Promise.all([
    fetchCampaigns(creds),
    twitterWindow(creds, since, until),
  ]);
  if (campaigns.length === 0) return [];

  const byId = new Map(campaigns.map((c) => [c.id, c.name]));
  const statusById = new Map(campaigns.map((c) => [c.id, c.status]));
  const out: AdInsight[] = [];

  // stats endpoint accepts up to 20 entity ids per request
  for (let i = 0; i < campaigns.length; i += 20) {
    const batch = campaigns.slice(i, i + 20);
    const json = await signedGet(creds, `/stats/accounts/${creds.externalId}`, {
      entity: "CAMPAIGN",
      entity_ids: batch.map((c) => c.id).join(","),
      metric_groups: "BILLING,ENGAGEMENT,WEB_CONVERSION",
      granularity: "DAY",
      placement: "ALL_ON_TWITTER",
      start_time: window.startTime,
      end_time: window.endTime,
    });

    for (const row of json.data ?? []) {
      const metrics = row.id_data?.[0]?.metrics ?? {};
      logMetricKeysOnce(metrics);
      const spendArr: (number | null)[] = metrics.billed_charge_local_micro ?? [];
      const imprArr: (number | null)[] = metrics.impressions ?? [];
      const clickArr: (number | null)[] = metrics.clicks ?? [];
      const purchases: ConvMetric = metrics.conversion_purchases;
      for (let d = 0; d < window.dates.length; d++) {
        const spend = num(spendArr[d]) / 1_000_000;
        const impressions = num(imprArr[d]);
        const clicks = num(clickArr[d]);
        const conversions = convCount(purchases, d);
        const revenue = convSale(purchases, d);
        // Keep zero-spend days that still carry conversions (view-through).
        if (spend === 0 && impressions === 0 && clicks === 0 && conversions === 0)
          continue;
        out.push({
          date: window.dates[d],
          campaignExternalId: row.id ?? null,
          campaignName: byId.get(row.id) ?? null,
          campaignStatus: statusById.get(row.id) ?? null,
          spend,
          impressions,
          clicks,
          conversions,
          revenue,
        });
      }
    }
  }
  return out;
}

interface LineItem {
  id: string;
  name: string;
  campaignId: string;
  status: string | null;
}

async function fetchLineItems(creds: AdAccountCreds): Promise<LineItem[]> {
  const out: LineItem[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const q: Record<string, string> = { count: "200" };
    if (cursor) q.cursor = cursor;
    const json = await signedGet(creds, `/accounts/${creds.externalId}/line_items`, q);
    for (const li of json.data ?? [])
      out.push({
        id: li.id,
        name: li.name ?? li.id,
        campaignId: li.campaign_id ?? "",
        status: li.entity_status ?? null,
      });
    cursor = json.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/** Deep fetch: line item (≈ad set) × day, carrying parent campaign id/name. */
export async function fetchTwitterAdsets(
  creds: AdAccountCreds,
  since: Date,
  until: Date = new Date()
): Promise<AdsetInsight[]> {
  const [campaigns, lineItems, window] = await Promise.all([
    fetchCampaigns(creds),
    fetchLineItems(creds),
    twitterWindow(creds, since, until),
  ]);
  if (lineItems.length === 0) return [];
  const campName = new Map(campaigns.map((c) => [c.id, c.name]));
  const campStatus = new Map(campaigns.map((c) => [c.id, c.status]));

  const liById = new Map(lineItems.map((l) => [l.id, l]));
  const out: AdsetInsight[] = [];

  for (let i = 0; i < lineItems.length; i += 20) {
    const batch = lineItems.slice(i, i + 20);
    const json = await signedGet(creds, `/stats/accounts/${creds.externalId}`, {
      entity: "LINE_ITEM",
      entity_ids: batch.map((l) => l.id).join(","),
      metric_groups: "BILLING,ENGAGEMENT,WEB_CONVERSION",
      granularity: "DAY",
      placement: "ALL_ON_TWITTER",
      start_time: window.startTime,
      end_time: window.endTime,
    });

    for (const row of json.data ?? []) {
      const li = liById.get(row.id);
      if (!li) continue;
      const m = row.id_data?.[0]?.metrics ?? {};
      const spendArr: (number | null)[] = m.billed_charge_local_micro ?? [];
      const imprArr: (number | null)[] = m.impressions ?? [];
      const clickArr: (number | null)[] = m.clicks ?? [];
      const purchases: ConvMetric = m.conversion_purchases;
      for (let d = 0; d < window.dates.length; d++) {
        const spend = num(spendArr[d]) / 1_000_000;
        const impressions = num(imprArr[d]);
        const clicks = num(clickArr[d]);
        const conversions = convCount(purchases, d);
        const revenue = convSale(purchases, d);
        if (spend === 0 && impressions === 0 && clicks === 0 && conversions === 0)
          continue;
        out.push({
          campaignExternalId: li.campaignId,
          campaignName: campName.get(li.campaignId) ?? "(unknown)",
          campaignStatus: campStatus.get(li.campaignId) ?? null,
          adsetExternalId: li.id,
          adsetName: li.name,
          status: normalizeAdStatus(li.status),
          date: window.dates[d],
          spend,
          impressions,
          clicks,
          conversions,
          revenue,
        });
      }
    }
  }
  return out;
}

interface PromotedTweet {
  id: string; // promoted_tweet id (stats entity)
  lineItemId: string;
  tweetId: string;
}

async function fetchPromotedTweets(creds: AdAccountCreds): Promise<PromotedTweet[]> {
  const out: PromotedTweet[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const q: Record<string, string> = { count: "200" };
    if (cursor) q.cursor = cursor;
    const json = await signedGet(
      creds,
      `/accounts/${creds.externalId}/promoted_tweets`,
      q
    );
    for (const p of json.data ?? [])
      out.push({
        id: p.id,
        lineItemId: p.line_item_id ?? "",
        tweetId: String(p.tweet_id ?? ""),
      });
    cursor = json.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/** Deepest fetch: promoted tweet (≈ad) × day, carrying parent line item id.
 *  X promoted tweets have no friendly name → labelled by tweet id. */
export async function fetchTwitterAds(
  creds: AdAccountCreds,
  since: Date,
  until: Date = new Date()
): Promise<AdCreativeInsight[]> {
  const [promoted, window] = await Promise.all([
    fetchPromotedTweets(creds),
    twitterWindow(creds, since, until),
  ]);
  if (promoted.length === 0) return [];

  const byId = new Map(promoted.map((p) => [p.id, p]));
  const out: AdCreativeInsight[] = [];

  for (let i = 0; i < promoted.length; i += 20) {
    const batch = promoted.slice(i, i + 20);
    const json = await signedGet(creds, `/stats/accounts/${creds.externalId}`, {
      entity: "PROMOTED_TWEET",
      entity_ids: batch.map((p) => p.id).join(","),
      metric_groups: "BILLING,ENGAGEMENT,WEB_CONVERSION",
      granularity: "DAY",
      placement: "ALL_ON_TWITTER",
      start_time: window.startTime,
      end_time: window.endTime,
    });

    for (const row of json.data ?? []) {
      const pt = byId.get(row.id);
      if (!pt) continue;
      const m = row.id_data?.[0]?.metrics ?? {};
      const spendArr: (number | null)[] = m.billed_charge_local_micro ?? [];
      const imprArr: (number | null)[] = m.impressions ?? [];
      const clickArr: (number | null)[] = m.clicks ?? [];
      const purchases: ConvMetric = m.conversion_purchases;
      for (let d = 0; d < window.dates.length; d++) {
        const spend = num(spendArr[d]) / 1_000_000;
        const impressions = num(imprArr[d]);
        const clicks = num(clickArr[d]);
        const conversions = convCount(purchases, d);
        const revenue = convSale(purchases, d);
        if (spend === 0 && impressions === 0 && clicks === 0 && conversions === 0)
          continue;
        out.push({
          adsetExternalId: pt.lineItemId,
          adExternalId: pt.id,
          adName: pt.tweetId ? `Tweet ${pt.tweetId}` : pt.id,
          status: null,
          date: window.dates[d],
          spend,
          impressions,
          clicks,
          conversions,
          revenue,
        });
      }
    }
  }
  return out;
}
