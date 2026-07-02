// Normalized ad-insight row (one campaign × one day) used across all platforms.
export interface AdInsight {
  date: string; // YYYY-MM-DD
  campaignExternalId: string | null; // for campaign→store attribution
  campaignName: string | null;
  campaignStatus: string | null; // normalized ACTIVE|PAUSED|ARCHIVED (for filters)
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number; // platform-attributed conversion value
}

// One adset (Meta ad set / Google ad group / X line item) × one day, with its
// parent campaign reference — the deep hierarchy row for optimization.
export interface AdsetInsight {
  campaignExternalId: string;
  campaignName: string;
  campaignStatus: string | null; // normalized: ACTIVE | PAUSED | ARCHIVED
  adsetExternalId: string;
  adsetName: string;
  status: string | null; // normalized adset status
  date: string; // YYYY-MM-DD
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
}

/** Map each platform's status vocabulary onto ACTIVE | PAUSED | ARCHIVED so
 *  the optimizer never suggests pausing something that's already off.
 *  Meta: ACTIVE/PAUSED/CAMPAIGN_PAUSED/ADSET_PAUSED/ARCHIVED/DELETED...
 *  Google: ENABLED/PAUSED/REMOVED. X: ACTIVE/PAUSED/DRAFT... */
export function normalizeAdStatus(s: unknown): string | null {
  if (!s) return null;
  const v = String(s).toUpperCase();
  if (v === "ENABLED" || v === "ACTIVE") return "ACTIVE";
  if (v.includes("PAUSED")) return "PAUSED";
  if (v === "ARCHIVED" || v === "REMOVED" || v === "DELETED") return "ARCHIVED";
  return v;
}

// Credentials/config for one ad account (subset of the AdAccount model).
export interface AdAccountCreds {
  platform: string; // FACEBOOK | GOOGLE | TWITTER
  externalId: string;
  accessToken?: string | null;
  accessSecret?: string | null;
  apiKey?: string | null;
  apiSecret?: string | null;
  refreshToken?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  developerToken?: string | null;
  loginCustomerId?: string | null;
}

/**
 * Deterministic de-dup key for an API-sourced AdSpend row. Encodes nulls as "_"
 * so the column is always non-null for API rows → a single-column UNIQUE index
 * fully enforces idempotency on re-sync (SQLite treats NULLs as distinct, which
 * is why MANUAL rows keep dedupeKey = null and never collide).
 */
export function adSpendDedupeKey(parts: {
  source: string;
  accountId?: string | null; // distinguishes campaigns of same name across accounts
  storeId: string | null;
  platform: string;
  date: string; // YYYY-MM-DD
  campaignName: string | null;
}): string {
  return [
    parts.source,
    parts.accountId ?? "_",
    parts.storeId ?? "_",
    parts.platform,
    parts.date,
    parts.campaignName ?? "_",
  ].join("|");
}

export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function num(v: unknown): number {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n) ? 0 : n;
}
