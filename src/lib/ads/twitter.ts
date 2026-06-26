// ---------------------------------------------------------------------------
// X (Twitter) Ads API — OAuth 1.0a (HMAC-SHA1) signed requests.
// Needs: apiKey (consumer key), apiSecret (consumer secret),
// accessToken, accessSecret, externalId (ads account id).
// NOTE: stats parsing is best-effort/experimental — validate with real creds.
// ---------------------------------------------------------------------------
import { createHmac, randomBytes } from "crypto";
import { AdAccountCreds, AdInsight, AdsetInsight, num, ymd } from "./types";

const API = "https://ads-api.twitter.com/12";

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
  const url = `${API}${path}`;
  const auth = oauthHeader(creds, "GET", url, query);
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${url}?${qs}`, { headers: { Authorization: auth } });
  const text = await res.text();
  if (!res.ok) throw new Error(`X Ads HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export async function testTwitter(creds: AdAccountCreds): Promise<string> {
  const json = await signedGet(creds, `/accounts/${creds.externalId}`, {});
  return json?.data?.name ?? `Account ${creds.externalId}`;
}

interface Campaign {
  id: string;
  name: string;
}

async function fetchCampaigns(creds: AdAccountCreds): Promise<Campaign[]> {
  const out: Campaign[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const q: Record<string, string> = { count: "200" };
    if (cursor) q.cursor = cursor;
    const json = await signedGet(creds, `/accounts/${creds.externalId}/campaigns`, q);
    for (const c of json.data ?? []) out.push({ id: c.id, name: c.name });
    cursor = json.next_cursor;
    if (!cursor) break;
  }
  return out;
}

export async function fetchTwitterInsights(
  creds: AdAccountCreds,
  since: Date
): Promise<AdInsight[]> {
  const campaigns = await fetchCampaigns(creds);
  if (campaigns.length === 0) return [];

  const start = new Date(since);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const dayCount = Math.max(
    1,
    Math.round((end.getTime() - start.getTime()) / 86400000)
  );
  const byId = new Map(campaigns.map((c) => [c.id, c.name]));
  const out: AdInsight[] = [];

  // stats endpoint accepts up to 20 entity ids per request
  for (let i = 0; i < campaigns.length; i += 20) {
    const batch = campaigns.slice(i, i + 20);
    const json = await signedGet(creds, `/stats/accounts/${creds.externalId}`, {
      entity: "CAMPAIGN",
      entity_ids: batch.map((c) => c.id).join(","),
      metric_groups: "BILLING,ENGAGEMENT",
      granularity: "DAY",
      placement: "ALL_ON_TWITTER",
      start_time: `${ymd(start)}T00:00:00Z`,
      end_time: `${ymd(end)}T00:00:00Z`,
    });

    for (const row of json.data ?? []) {
      const metrics = row.id_data?.[0]?.metrics ?? {};
      const spendArr: (number | null)[] = metrics.billed_charge_local_micro ?? [];
      const imprArr: (number | null)[] = metrics.impressions ?? [];
      const clickArr: (number | null)[] = metrics.clicks ?? [];
      for (let d = 0; d < dayCount; d++) {
        const day = new Date(start);
        day.setDate(start.getDate() + d);
        const spend = num(spendArr[d]) / 1_000_000;
        const impressions = num(imprArr[d]);
        const clicks = num(clickArr[d]);
        if (spend === 0 && impressions === 0 && clicks === 0) continue;
        out.push({
          date: ymd(day),
          campaignName: byId.get(row.id) ?? null,
          spend,
          impressions,
          clicks,
          conversions: 0,
          revenue: 0,
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
  since: Date
): Promise<AdsetInsight[]> {
  const [campaigns, lineItems] = await Promise.all([
    fetchCampaigns(creds),
    fetchLineItems(creds),
  ]);
  if (lineItems.length === 0) return [];
  const campName = new Map(campaigns.map((c) => [c.id, c.name]));

  const start = new Date(since);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const dayCount = Math.max(
    1,
    Math.round((end.getTime() - start.getTime()) / 86400000)
  );
  const liById = new Map(lineItems.map((l) => [l.id, l]));
  const out: AdsetInsight[] = [];

  for (let i = 0; i < lineItems.length; i += 20) {
    const batch = lineItems.slice(i, i + 20);
    const json = await signedGet(creds, `/stats/accounts/${creds.externalId}`, {
      entity: "LINE_ITEM",
      entity_ids: batch.map((l) => l.id).join(","),
      metric_groups: "BILLING,ENGAGEMENT",
      granularity: "DAY",
      placement: "ALL_ON_TWITTER",
      start_time: `${ymd(start)}T00:00:00Z`,
      end_time: `${ymd(end)}T00:00:00Z`,
    });

    for (const row of json.data ?? []) {
      const li = liById.get(row.id);
      if (!li) continue;
      const m = row.id_data?.[0]?.metrics ?? {};
      const spendArr: (number | null)[] = m.billed_charge_local_micro ?? [];
      const imprArr: (number | null)[] = m.impressions ?? [];
      const clickArr: (number | null)[] = m.clicks ?? [];
      for (let d = 0; d < dayCount; d++) {
        const day = new Date(start);
        day.setDate(start.getDate() + d);
        const spend = num(spendArr[d]) / 1_000_000;
        const impressions = num(imprArr[d]);
        const clicks = num(clickArr[d]);
        if (spend === 0 && impressions === 0 && clicks === 0) continue;
        out.push({
          campaignExternalId: li.campaignId,
          campaignName: campName.get(li.campaignId) ?? "(unknown)",
          adsetExternalId: li.id,
          adsetName: li.name,
          status: li.status,
          date: ymd(day),
          spend,
          impressions,
          clicks,
          conversions: 0,
          revenue: 0,
        });
      }
    }
  }
  return out;
}
