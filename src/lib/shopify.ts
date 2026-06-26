// ---------------------------------------------------------------------------
// SHOPIFY ADMIN API (GraphQL) client — fetch products & orders for a store.
// Auth: custom app Admin API access token (shpat_...), header X-Shopify-Access-Token.
// ---------------------------------------------------------------------------

export interface ShopifyCreds {
  shopifyDomain: string;
  shopifyToken: string;
  shopifyApiVersion?: string;
}

export interface ShopifyProductNorm {
  externalId: string;
  title: string;
  image: string | null;
  catalog: string | null; // main collection title
  baseCost: number; // unit cost from InventoryItem (used as COGS)
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

function endpoint(creds: ShopifyCreds): string {
  const version = creds.shopifyApiVersion || DEFAULT_VERSION;
  const domain = creds.shopifyDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${domain}/admin/api/${version}/graphql.json`;
}

function num(v: unknown): number {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n) ? 0 : n;
}

export async function shopifyGraphQL<T>(
  creds: ShopifyCreds,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(endpoint(creds), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": creds.shopifyToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new Error(
      `Shopify GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`
    );
  }
  if (!json.data) throw new Error("Shopify: empty response");
  return json.data;
}

/** Test the connection — returns shop name + currency. */
export async function testConnection(
  creds: ShopifyCreds
): Promise<{ name: string; currencyCode: string }> {
  const data = await shopifyGraphQL<{
    shop: { name: string; currencyCode: string };
  }>(creds, `{ shop { name currencyCode } }`);
  return data.shop;
}

const PRODUCTS_QUERY = `
query Products($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      featuredImage { url }
      collections(first: 1) { nodes { title } }
      variants(first: 1) {
        nodes { inventoryItem { unitCost { amount } } }
      }
    }
  }
}`;

interface ProductsResp {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: {
      id: string;
      title: string;
      featuredImage: { url: string } | null;
      collections: { nodes: { title: string }[] };
      variants: { nodes: { inventoryItem: { unitCost: { amount: string } | null } | null }[] };
    }[];
  };
}

export async function fetchAllProducts(
  creds: ShopifyCreds
): Promise<ShopifyProductNorm[]> {
  const out: ShopifyProductNorm[] = [];
  let cursor: string | null = null;
  // hard cap pages to avoid runaway loops
  for (let page = 0; page < 100; page++) {
    const data: ProductsResp = await shopifyGraphQL<ProductsResp>(
      creds,
      PRODUCTS_QUERY,
      { cursor }
    );
    for (const p of data.products.nodes) {
      out.push({
        externalId: p.id,
        title: p.title,
        image: p.featuredImage?.url ?? null,
        catalog: p.collections.nodes[0]?.title ?? null,
        baseCost: num(p.variants.nodes[0]?.inventoryItem?.unitCost?.amount),
      });
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return out;
}

// NOTE: customerJourneySummary is "protected customer data". For a custom app on your
// own store, enable it under the app's "Protected customer data access" (quick toggle).
const ORDERS_QUERY = `
query Orders($cursor: String, $query: String) {
  orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT) {
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
      lineItems(first: 100) {
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

/** Normalize one raw order node (exported for unit-testing the mapping). */
export function normalizeOrder(
  o: OrdersResp["orders"]["nodes"][number]
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
  const attr = classifyChannel(o.customerJourneySummary?.lastVisit ?? null);

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

export async function fetchOrdersSince(
  creds: ShopifyCreds,
  since: Date
): Promise<ShopifyOrderNorm[]> {
  const out: ShopifyOrderNorm[] = [];
  const queryStr = `created_at:>=${since.toISOString()} status:any`;
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const data: OrdersResp = await shopifyGraphQL<OrdersResp>(creds, ORDERS_QUERY, {
      cursor,
      query: queryStr,
    });
    for (const o of data.orders.nodes) out.push(normalizeOrder(o));
    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }
  return out;
}
