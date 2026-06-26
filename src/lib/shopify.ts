// ---------------------------------------------------------------------------
// SHOPIFY ADMIN API (GraphQL) client — fetch products & orders for a store.
// Auth (2026+): Dev Dashboard apps give a Client ID + Client Secret which we
// exchange for a 24h Admin API access token via the client credentials grant,
// then send as header X-Shopify-Access-Token. Legacy custom-app tokens
// (shpat_...) are still accepted directly if provided.
// Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
// ---------------------------------------------------------------------------

export interface ShopifyCreds {
  shopifyDomain: string;
  // New flow: exchange these for a token. Either provide BOTH of these, or a
  // legacy shopifyToken below.
  shopifyClientId?: string | null;
  shopifyClientSecret?: string | null;
  // Legacy admin token (shpat_...) OR the resolved token after an exchange.
  shopifyToken?: string | null;
  shopifyApiVersion?: string;
}

export interface ShopifyOrderLineNorm {
  externalProductId: string | null;
  title: string;
  image: string | null;
  quantity: number;
  price: number; // original unit price
}

export interface ShopifyOrderNorm {
  externalId: string;
  date: Date;
  grossRevenue: number; // sum(originalUnitPrice * qty) before discount
  discounts: number;
  tax: number;
  shippingCharged: number;
  itemsCount: number;
  // attribution
  channel: string; // FACEBOOK | GOOGLE | TWITTER | KLAVIYO | DIRECT | ORGANIC | REFERRAL | OTHER
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  sourceName: string | null;
  lineItems: ShopifyOrderLineNorm[];
}

const DEFAULT_VERSION = "2025-01";

function shopBase(creds: ShopifyCreds): string {
  const domain = creds.shopifyDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}`;
}

function endpoint(creds: ShopifyCreds): string {
  const version = creds.shopifyApiVersion || DEFAULT_VERSION;
  return `${shopBase(creds)}/admin/api/${version}/graphql.json`;
}

/**
 * Resolve an Admin API access token for the store.
 * - New (2026+) Dev Dashboard apps: POST the Client ID + Client Secret to the
 *   client credentials grant endpoint and get back a ~24h access token. Only
 *   works for apps in your own Shopify org installed on stores you own.
 * - Legacy: a stored shpat_ token is returned as-is.
 */
export async function getAccessToken(creds: ShopifyCreds): Promise<string> {
  if (creds.shopifyClientId && creds.shopifyClientSecret) {
    const res = await fetch(`${shopBase(creds)}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.shopifyClientId,
        client_secret: creds.shopifyClientSecret,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Shopify token exchange HTTP ${res.status}: ${text.slice(0, 300)}. ` +
          `Kiểm tra Client ID/Secret và app phải cùng tổ chức + đã cài lên store.`
      );
    }
    let json: { access_token?: string };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Shopify token exchange: phản hồi không hợp lệ: ${text.slice(0, 200)}`);
    }
    if (!json.access_token)
      throw new Error("Shopify token exchange: phản hồi thiếu access_token.");
    return json.access_token;
  }
  if (creds.shopifyToken) return creds.shopifyToken;
  throw new Error(
    "Thiếu thông tin xác thực Shopify: cần Client ID + Client Secret (Dev Dashboard) " +
      "hoặc Admin API token (shpat_...) cũ."
  );
}

/** Return a copy of creds whose shopifyToken is a freshly-resolved token. */
async function resolveCreds(creds: ShopifyCreds): Promise<ShopifyCreds> {
  const token = await getAccessToken(creds);
  return { ...creds, shopifyToken: token };
}

function num(v: unknown): number {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n) ? 0 : n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Transient HTTP statuses worth retrying (gateway hiccups + rate limit).
const RETRYABLE = new Set([429, 500, 502, 503, 504, 520, 522, 524]);

export async function shopifyGraphQL<T>(
  creds: ShopifyCreds,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const url = endpoint(creds);
  const maxAttempts = 4;
  let lastErr = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": creds.shopifyToken ?? "",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const text = await res.text();
      lastErr = `Shopify HTTP ${res.status}: ${text.slice(0, 200)}`;
      // Retry transient gateway/rate-limit errors with exponential backoff.
      if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
        await sleep(800 * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(lastErr);
    }

    const json = (await res.json()) as {
      data?: T;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

    if (json.errors?.length) {
      const throttled = json.errors.some(
        (e) => e.extensions?.code === "THROTTLED" || /throttl/i.test(e.message)
      );
      lastErr = `Shopify GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`;
      if (throttled && attempt < maxAttempts) {
        await sleep(1500 * attempt); // give the cost bucket time to refill
        continue;
      }
      throw new Error(lastErr);
    }

    if (!json.data) throw new Error("Shopify: empty response");
    return json.data;
  }

  throw new Error(lastErr || "Shopify: hết lượt thử lại");
}

/** Test the connection — returns shop name + currency. */
export async function testConnection(
  creds: ShopifyCreds
): Promise<{ name: string; currencyCode: string }> {
  const c = await resolveCreds(creds);
  const data = await shopifyGraphQL<{
    shop: { name: string; currencyCode: string };
  }>(c, `{ shop { name currencyCode } }`);
  return data.shop;
}

// NOTE: Products are no longer fetched as a standalone catalog. We derive the
// minimal product info we need (title + image) directly from order line items
// in sync.ts — far less data, and no `read_inventory` scope required.

// NOTE: customerJourneySummary is "protected customer data". For a custom app on your
// own store, enable it under the app's "Protected customer data access" (quick toggle).
const ORDERS_QUERY = `
query Orders($cursor: String, $query: String) {
  orders(first: 25, after: $cursor, query: $query, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      createdAt
      sourceName
      totalDiscountsSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      customerJourneySummary {
        lastVisit {
          source
          sourceType
          referrerUrl
          utmParameters { source medium campaign }
        }
      }
      lineItems(first: 50) {
        nodes {
          title
          quantity
          originalUnitPriceSet { shopMoney { amount } }
          product { id featuredImage { url } }
        }
      }
    }
  }
}`;

// Fallback query without customerJourneySummary — used automatically when the
// app doesn't have "Protected customer data access" yet (so sync still works,
// just without per-order channel attribution).
const ORDERS_QUERY_BASIC = `
query Orders($cursor: String, $query: String) {
  orders(first: 25, after: $cursor, query: $query, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      createdAt
      sourceName
      totalDiscountsSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      lineItems(first: 50) {
        nodes {
          title
          quantity
          originalUnitPriceSet { shopMoney { amount } }
          product { id featuredImage { url } }
        }
      }
    }
  }
}`;

interface Visit {
  source: string | null;
  sourceType: string | null;
  referrerUrl: string | null;
  utmParameters: {
    source: string | null;
    medium: string | null;
    campaign: string | null;
  } | null;
}

interface OrdersResp {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: {
      id: string;
      createdAt: string;
      sourceName: string | null;
      totalDiscountsSet: { shopMoney: { amount: string } } | null;
      totalTaxSet: { shopMoney: { amount: string } } | null;
      totalShippingPriceSet: { shopMoney: { amount: string } } | null;
      customerJourneySummary: { lastVisit: Visit | null } | null;
      lineItems: {
        nodes: {
          title: string;
          quantity: number;
          originalUnitPriceSet: { shopMoney: { amount: string } } | null;
          product: { id: string; featuredImage: { url: string } | null } | null;
        }[];
      };
    }[];
  };
}

/**
 * Classify an order's traffic source into a channel, from UTM + visit data.
 * Priority: utm_source/medium keywords → visit.source → sourceType → OTHER.
 */
export function classifyChannel(visit: Visit | null): {
  channel: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
} {
  const utmSource = visit?.utmParameters?.source ?? null;
  const utmMedium = visit?.utmParameters?.medium ?? null;
  const utmCampaign = visit?.utmParameters?.campaign ?? null;

  const hay = [
    utmSource,
    utmMedium,
    visit?.source,
    visit?.sourceType,
    visit?.referrerUrl,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const has = (...keys: string[]) => keys.some((k) => hay.includes(k));

  let channel = "OTHER";
  if (!hay) channel = "DIRECT"; // no referrer/UTM at all → direct traffic
  else if (has("facebook", "fb", "instagram", "ig", "meta")) channel = "FACEBOOK";
  else if (has("google", "youtube", "gclid", "adwords")) channel = "GOOGLE";
  else if (has("twitter", "x.com", "t.co")) channel = "TWITTER";
  else if (has("klaviyo", "email", "newsletter")) channel = "KLAVIYO";
  else if (has("direct")) channel = "DIRECT";
  else if (has("search", "organic", "bing", "yahoo")) channel = "ORGANIC";
  else if (has("referral", "http")) channel = "REFERRAL";

  return { channel, utmSource, utmMedium, utmCampaign };
}

/** Normalize one raw order node (exported for unit-testing the mapping).
 *  hasJourney=false when the customer-journey field was unavailable (no
 *  protected-data access) → attribution is left UNKNOWN instead of guessing. */
export function normalizeOrder(
  o: OrdersResp["orders"]["nodes"][number],
  hasJourney = true
): ShopifyOrderNorm {
  let gross = 0;
  let units = 0;
  const lineItems: ShopifyOrderLineNorm[] = o.lineItems.nodes.map((li) => {
    const price = num(li.originalUnitPriceSet?.shopMoney.amount);
    gross += price * li.quantity;
    units += li.quantity;
    return {
      externalProductId: li.product?.id ?? null,
      title: li.title,
      image: li.product?.featuredImage?.url ?? null,
      quantity: li.quantity,
      price,
    };
  });
  const attr = hasJourney
    ? classifyChannel(o.customerJourneySummary?.lastVisit ?? null)
    : { channel: "OTHER", utmSource: null, utmMedium: null, utmCampaign: null };

  return {
    externalId: o.id,
    date: new Date(o.createdAt),
    grossRevenue: gross,
    discounts: num(o.totalDiscountsSet?.shopMoney.amount),
    tax: num(o.totalTaxSet?.shopMoney.amount),
    shippingCharged: num(o.totalShippingPriceSet?.shopMoney.amount),
    itemsCount: units,
    channel: attr.channel,
    utmSource: attr.utmSource,
    utmMedium: attr.utmMedium,
    utmCampaign: attr.utmCampaign,
    sourceName: o.sourceName ?? null,
    lineItems,
  };
}

export interface OrdersPage {
  orders: ShopifyOrderNorm[];
  nextCursor: string | null;
  hasNext: boolean;
  usedJourney: boolean;
}

/** Total number of orders in the window — best-effort, for an accurate progress
 *  bar. Returns null if the API/version doesn't support ordersCount. */
export async function fetchOrdersCount(
  creds: ShopifyCreds,
  since: Date
): Promise<number | null> {
  try {
    const c = await resolveCreds(creds);
    const queryStr = `created_at:>=${since.toISOString()} status:any`;
    const data = await shopifyGraphQL<{ ordersCount: { count: number } }>(
      c,
      `query OrdersCount($query: String) { ordersCount(query: $query) { count } }`,
      { query: queryStr }
    );
    return data.ordersCount?.count ?? null;
  } catch {
    return null; // count is optional — never fail the sync over it
  }
}

/** Fetch ONE page of orders from a cursor. Auto-falls back to the lighter query
 *  (no customerJourneySummary) on access-denied or gateway/throttle errors. */
export async function fetchOrdersPage(
  creds: ShopifyCreds,
  since: Date,
  cursor: string | null = null,
  useJourney = true
): Promise<OrdersPage> {
  const c = await resolveCreds(creds);
  const queryStr = `created_at:>=${since.toISOString()} status:any`;
  let used = useJourney;

  let data: OrdersResp;
  try {
    data = await shopifyGraphQL<OrdersResp>(
      c,
      used ? ORDERS_QUERY : ORDERS_QUERY_BASIC,
      { cursor, query: queryStr }
    );
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    // Fall back to the lighter query when protected data isn't enabled, or when
    // the journey-heavy query keeps failing with a gateway/throttle error (the
    // customerJourneySummary field is the usual cause of 502/timeout).
    const accessDenied = /customerJourney|protected|customer data|access denied|not approved|ACCESS_DENIED/i.test(m);
    const gateway = /HTTP (429|5\d\d)|throttl/i.test(m);
    if (used && (accessDenied || gateway)) {
      used = false;
      data = await shopifyGraphQL<OrdersResp>(c, ORDERS_QUERY_BASIC, {
        cursor,
        query: queryStr,
      });
    } else {
      throw e;
    }
  }

  return {
    orders: data.orders.nodes.map((o) => normalizeOrder(o, used)),
    nextCursor: data.orders.pageInfo.endCursor,
    hasNext: data.orders.pageInfo.hasNextPage,
    usedJourney: used,
  };
}

/** Fetch all orders since a date (loops fetchOrdersPage). Used by cron. */
export async function fetchOrdersSince(
  creds: ShopifyCreds,
  since: Date
): Promise<ShopifyOrderNorm[]> {
  const out: ShopifyOrderNorm[] = [];
  let cursor: string | null = null;
  let useJourney = true;
  for (let page = 0; page < 400; page++) {
    const p = await fetchOrdersPage(creds, since, cursor, useJourney);
    useJourney = p.usedJourney; // stay downgraded once we fall back
    out.push(...p.orders);
    if (!p.hasNext) break;
    cursor = p.nextCursor;
  }
  return out;
}
