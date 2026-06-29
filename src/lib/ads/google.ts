// ---------------------------------------------------------------------------
// GOOGLE ADS API — via REST searchStream. No official Node SDK, so we call the
// REST endpoint directly with an OAuth access token (from a refresh token).
// Needs: developerToken, clientId, clientSecret, refreshToken, externalId
// (customer id, digits only), optional loginCustomerId (MCC).
// ---------------------------------------------------------------------------
import { AdAccountCreds, AdInsight, AdsetInsight, num, ymd } from "./types";

// Google Ads API now ships monthly and each version sunsets ~6 months after
// release, returning HTML 404 on the old path once gone. Keep this current.
// (v20 sunset 2026-06-10; supported as of 2026-06: v24/v23/v22/v21.)
const API_VERSION = "v24";

async function getAccessToken(creds: AdAccountCreds): Promise<string> {
  if (!creds.clientId || !creds.clientSecret || !creds.refreshToken)
    throw new Error("Google: thiếu clientId/clientSecret/refreshToken");
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok || !json.access_token)
    throw new Error(json.error_description ?? "Google OAuth thất bại");
  return json.access_token as string;
}

function customerId(creds: AdAccountCreds): string {
  return creds.externalId.replace(/[^0-9]/g, "");
}

function headers(creds: AdAccountCreds, token: string): HeadersInit {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": creds.developerToken ?? "",
    "Content-Type": "application/json",
  };
  if (creds.loginCustomerId)
    h["login-customer-id"] = creds.loginCustomerId.replace(/[^0-9]/g, "");
  return h;
}

export async function testGoogle(creds: AdAccountCreds): Promise<string> {
  const token = await getAccessToken(creds);
  const cid = customerId(creds);
  const res = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${cid}/googleAds:searchStream`,
    {
      method: "POST",
      headers: headers(creds, token),
      body: JSON.stringify({
        query:
          "SELECT customer.descriptive_name, customer.currency_code FROM customer LIMIT 1",
      }),
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Ads HTTP ${res.status}: ${text.slice(0, 200)}`);
  const arr = JSON.parse(text);
  const c = arr?.[0]?.results?.[0]?.customer;
  return c ? `${c.descriptiveName} (${c.currencyCode})` : `Customer ${cid}`;
}

interface GoogleResult {
  segments?: { date?: string };
  campaign?: { id?: string; name?: string };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: number;
    conversionsValue?: number;
  };
}

export async function fetchGoogleInsights(
  creds: AdAccountCreds,
  since: Date,
  until: Date = new Date()
): Promise<AdInsight[]> {
  const token = await getAccessToken(creds);
  const cid = customerId(creds);
  const query = `
    SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros,
           metrics.impressions, metrics.clicks, metrics.conversions,
           metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${ymd(since)}' AND '${ymd(until)}'`;

  const res = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${cid}/googleAds:searchStream`,
    { method: "POST", headers: headers(creds, token), body: JSON.stringify({ query }) }
  );
  const text = await res.text();
  if (!res.ok)
    throw new Error(`Google Ads HTTP ${res.status}: ${text.slice(0, 200)}`);

  const chunks = JSON.parse(text) as { results?: GoogleResult[] }[];
  const out: AdInsight[] = [];
  for (const chunk of chunks) {
    for (const r of chunk.results ?? []) {
      out.push({
        date: r.segments?.date ?? "",
        campaignExternalId: r.campaign?.id ?? null,
        campaignName: r.campaign?.name ?? null,
        spend: num(r.metrics?.costMicros) / 1_000_000,
        impressions: num(r.metrics?.impressions),
        clicks: num(r.metrics?.clicks),
        conversions: num(r.metrics?.conversions),
        revenue: num(r.metrics?.conversionsValue),
      });
    }
  }
  return out;
}

interface GoogleAdGroupResult extends GoogleResult {
  campaign?: { id?: string; name?: string };
  adGroup?: { id?: string; name?: string; status?: string };
}

/** Deep fetch: ad group × day insights, carrying parent campaign id/name. */
export async function fetchGoogleAdsets(
  creds: AdAccountCreds,
  since: Date,
  until: Date = new Date()
): Promise<AdsetInsight[]> {
  const token = await getAccessToken(creds);
  const cid = customerId(creds);
  const query = `
    SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
           ad_group.status, segments.date, metrics.cost_micros,
           metrics.impressions, metrics.clicks, metrics.conversions,
           metrics.conversions_value
    FROM ad_group
    WHERE segments.date BETWEEN '${ymd(since)}' AND '${ymd(until)}'`;

  const res = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${cid}/googleAds:searchStream`,
    { method: "POST", headers: headers(creds, token), body: JSON.stringify({ query }) }
  );
  const text = await res.text();
  if (!res.ok)
    throw new Error(`Google Ads HTTP ${res.status}: ${text.slice(0, 200)}`);

  const chunks = JSON.parse(text) as { results?: GoogleAdGroupResult[] }[];
  const out: AdsetInsight[] = [];
  for (const chunk of chunks) {
    for (const r of chunk.results ?? []) {
      out.push({
        campaignExternalId: r.campaign?.id ?? "",
        campaignName: r.campaign?.name ?? "(unknown)",
        adsetExternalId: r.adGroup?.id ?? "",
        adsetName: r.adGroup?.name ?? "(unknown)",
        status: r.adGroup?.status ?? null,
        date: r.segments?.date ?? "",
        spend: num(r.metrics?.costMicros) / 1_000_000,
        impressions: num(r.metrics?.impressions),
        clicks: num(r.metrics?.clicks),
        conversions: num(r.metrics?.conversions),
        revenue: num(r.metrics?.conversionsValue),
      });
    }
  }
  return out;
}
