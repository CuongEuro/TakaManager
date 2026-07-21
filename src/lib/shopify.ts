// ---------------------------------------------------------------------------
// SHOPIFY ADMIN API (GraphQL) client — fetch products & orders for a store.
// Auth (2026+): Dev Dashboard apps give a Client ID + Client Secret which we
// exchange for a 24h Admin API access token via the client credentials grant,
// then send as header X-Shopify-Access-Token. Legacy custom-app tokens
// (shpat_...) are still accepted directly if provided.
// Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
// ---------------------------------------------------------------------------
import { createHmac, timingSafeEqual } from "crypto";

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
  externalLineItemId: string | null;
  externalVariantId: string | null;
  inventoryItemId: string | null;
  title: string;
  image: string | null;
  quantity: number;
  price: number; // original unit price
  unitCost: number; // Shopify "Cost per item" (variant), 0 if not fetched/available
}

export interface ShopifyOrderNorm {
  externalId: string;
  date: Date;
  grossRevenue: number; // sum(originalUnitPrice * qty) before discount
  discounts: number;
  tax: number;
  shippingCharged: number;
  refunded: number; // total refunded to customer (incl tax)
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

/** Positive order-line cost is an immutable historical snapshot. */
export function preserveUnitCostSnapshot(stored: number, incoming: number): number {
  return stored > 0 ? stored : incoming;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Transient HTTP statuses worth retrying (gateway hiccups + rate limit).
const RETRYABLE = new Set([429, 500, 502, 503, 504, 520, 522, 524]);

export async function shopifyGraphQL<T>(
  creds: ShopifyCreds,
  query: string,
  variables: Record<string, unknown> = {},
  maxAttempts = 4
): Promise<T> {
  const url = endpoint(creds);
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
): Promise<{ name: string; currencyCode: string; ianaTimezone: string | null }> {
  const c = await resolveCreds(creds);
  const data = await shopifyGraphQL<{
    shop: { name: string; currencyCode: string; ianaTimezone: string | null };
  }>(c, `{ shop { name currencyCode ianaTimezone } }`);
  return data.shop;
}

// NOTE: Products are no longer fetched as a standalone catalog. We derive the
// minimal product info we need (title + image) directly from order line items
// in sync.ts — far less data, and no `read_inventory` scope required.

// Orders query builder.
//  - journey: customerJourneySummary ("protected customer data") for channel
//    attribution. Auto-dropped if the app lacks that access.
//  - cost: variant.inventoryItem.unitCost ("Cost per item") for accurate COGS.
//    Requires the `read_inventory` scope — only requested when a store uses the
//    COST_PER_ITEM COGS source.
function ordersQuery(journey: boolean, cost: boolean): string {
  const journeyBlock = journey
    ? `customerJourneySummary { lastVisit { source sourceType referrerUrl utmParameters { source medium campaign } } }`
    : "";
  const variantBlock = cost
    ? `variant { id inventoryItem { id unitCost { amount } } }`
    : `variant { id }`;
  return `
query Orders($cursor: String, $query: String) {
  orders(first: 10, after: $cursor, query: $query, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      createdAt
      sourceName
      totalDiscountsSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      ${journeyBlock}
      lineItems(first: 50) {
        nodes {
          id
          title
          quantity
          originalUnitPriceSet { shopMoney { amount } }
          product { id featuredImage { url } }
          ${variantBlock}
        }
      }
    }
  }
}`;
}

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
      currentTotalTaxSet: { shopMoney: { amount: string } } | null;
      totalShippingPriceSet: { shopMoney: { amount: string } } | null;
      totalRefundedSet: { shopMoney: { amount: string } } | null;
      customerJourneySummary: { lastVisit: Visit | null } | null;
      lineItems: {
        nodes: {
          id: string;
          title: string;
          quantity: number;
          originalUnitPriceSet: { shopMoney: { amount: string } } | null;
          product: { id: string; featuredImage: { url: string } | null } | null;
          variant: {
            id: string;
            inventoryItem?: {
              id: string;
              unitCost: { amount: string } | null;
            } | null;
          } | null;
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
      externalLineItemId: li.id,
      externalVariantId: li.variant?.id ?? null,
      inventoryItemId: li.variant?.inventoryItem?.id ?? null,
      title: li.title,
      image: li.product?.featuredImage?.url ?? null,
      quantity: li.quantity,
      price,
      unitCost: num(li.variant?.inventoryItem?.unitCost?.amount),
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
    // current* is net of refunds/edits → matches Shopify's Taxes report.
    tax: num(o.currentTotalTaxSet?.shopMoney.amount ?? o.totalTaxSet?.shopMoney.amount),
    shippingCharged: num(o.totalShippingPriceSet?.shopMoney.amount),
    refunded: num(o.totalRefundedSet?.shopMoney.amount),
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

const PRODUCT_IMAGES_QUERY = `
query ProductImages($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product { id featuredImage { url } }
  }
}`;

/** Fetch featuredImage URLs for a set of product GIDs (batched by 100).
 *  Used to backfill images for products derived from orders (incl. webhooks). */
export async function fetchProductImages(
  creds: ShopifyCreds,
  productGids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (productGids.length === 0) return out;
  const c = await resolveCreds(creds);
  for (let i = 0; i < productGids.length; i += 100) {
    const ids = productGids.slice(i, i + 100);
    const data = await shopifyGraphQL<{
      nodes: ({ id: string; featuredImage: { url: string } | null } | null)[];
    }>(c, PRODUCT_IMAGES_QUERY, { ids });
    for (const n of data.nodes) {
      if (n?.featuredImage?.url) out.set(n.id, n.featuredImage.url);
    }
  }
  return out;
}

const VARIANT_COSTS_QUERY = `
query VariantCosts($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id
      inventoryItem { id unitCost { amount } }
    }
  }
}`;

export interface ShopifyVariantCost {
  inventoryItemId: string | null;
  unitCost: number;
}

/** Fetch Cost per item for the exact variants used by order lines. Product-level
 * fallback can choose the wrong size/color; this mapping deliberately cannot. */
export async function fetchVariantCosts(
  creds: ShopifyCreds,
  variantGids: string[]
): Promise<Map<string, ShopifyVariantCost>> {
  const out = new Map<string, ShopifyVariantCost>();
  const uniqueIds = [...new Set(variantGids.filter(Boolean))];
  if (uniqueIds.length === 0) return out;
  const c = await resolveCreds(creds);
  for (let i = 0; i < uniqueIds.length; i += 100) {
    const ids = uniqueIds.slice(i, i + 100);
    const data = await shopifyGraphQL<{
      nodes: (
        | {
            id: string;
            inventoryItem: {
              id: string;
              unitCost: { amount: string } | null;
            } | null;
          }
        | null
      )[];
    }>(c, VARIANT_COSTS_QUERY, { ids });
    for (const node of data.nodes) {
      if (!node?.id) continue;
      out.set(node.id, {
        inventoryItemId: node.inventoryItem?.id ?? null,
        unitCost: num(node.inventoryItem?.unitCost?.amount),
      });
    }
  }
  return out;
}

const ORDER_LINES_FOR_COST_QUERY = `
query OrderLinesForCost($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order {
      id
      lineItems(first: 250) {
        nodes {
          id
          title
          variantTitle
          sku
          quantity
          originalUnitPriceSet { shopMoney { amount } }
          product { id }
          variant { id inventoryItem { id unitCost { amount } } }
        }
      }
    }
  }
}`;

export interface ShopifyOrderCostLine {
  externalLineItemId: string;
  externalProductId: string | null;
  externalVariantId: string | null;
  inventoryItemId: string | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  price: number;
  unitCost: number;
}

/** Read only the order lines needed for a legacy missing-cost backfill. This
 * avoids re-syncing the whole date range while still resolving the exact
 * variant for rows created before variant IDs were stored locally. */
export async function fetchOrderLinesForCosts(
  creds: ShopifyCreds,
  orderGids: string[]
): Promise<Map<string, ShopifyOrderCostLine[]>> {
  const out = new Map<string, ShopifyOrderCostLine[]>();
  const uniqueIds = [...new Set(orderGids.filter(Boolean))];
  if (uniqueIds.length === 0) return out;
  const c = await resolveCreds(creds);
  // 3 x 250 line items stays below Shopify's requested query-cost ceiling.
  for (let i = 0; i < uniqueIds.length; i += 3) {
    const ids = uniqueIds.slice(i, i + 3);
    const data = await shopifyGraphQL<{
      nodes: (
        | {
            id: string;
            lineItems: {
              nodes: {
                id: string;
                title: string;
                variantTitle: string | null;
                sku: string | null;
                quantity: number;
                originalUnitPriceSet: { shopMoney: { amount: string } } | null;
                product: { id: string } | null;
                variant: {
                  id: string;
                  inventoryItem: {
                    id: string;
                    unitCost: { amount: string } | null;
                  } | null;
                } | null;
              }[];
            };
          }
        | null
      )[];
    }>(c, ORDER_LINES_FOR_COST_QUERY, { ids });
    for (const order of data.nodes) {
      if (!order?.id) continue;
      out.set(
        order.id,
        order.lineItems.nodes.map((line) => ({
          externalLineItemId: line.id,
          externalProductId: line.product?.id ?? null,
          externalVariantId: line.variant?.id ?? null,
          inventoryItemId: line.variant?.inventoryItem?.id ?? null,
          title: line.title,
          variantTitle: line.variantTitle,
          sku: line.sku,
          quantity: line.quantity,
          price: num(line.originalUnitPriceSet?.shopMoney.amount),
          unitCost: num(line.variant?.inventoryItem?.unitCost?.amount),
        }))
      );
    }
  }
  return out;
}

const PRODUCT_VARIANT_CATALOG_QUERY = `
query ProductVariantCatalog($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id
      title
      variants(first: 250) {
        nodes { id title sku inventoryItem { id unitCost { amount } } }
      }
    }
  }
}`;

const PRODUCT_VARIANT_CATALOG_BY_TITLE_QUERY = `
query ProductVariantCatalogByTitle($query: String!) {
  products(first: 3, query: $query) {
    nodes {
      id
      title
      variants(first: 250) {
        nodes { id title sku inventoryItem { id unitCost { amount } } }
      }
    }
  }
}`;

export interface ShopifyCatalogVariant extends ShopifyVariantCost {
  externalVariantId: string;
  title: string;
  sku: string | null;
}

export interface ShopifyProductVariantCatalog {
  externalProductId: string;
  title: string;
  variants: ShopifyCatalogVariant[];
}

function normalizedLookup(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function titleCatalogKey(title: string): string {
  return `title:${normalizedLookup(title)}`;
}

function idCatalogKey(id: string): string {
  return `id:${id}`;
}

type ProductVariantCatalogNode = {
  id: string;
  title: string;
  variants: {
    nodes: {
      id: string;
      title: string;
      sku: string | null;
      inventoryItem: {
        id: string;
        unitCost: { amount: string } | null;
      } | null;
    }[];
  };
};

function normalizeCatalog(node: ProductVariantCatalogNode): ShopifyProductVariantCatalog {
  return {
    externalProductId: node.id,
    title: node.title,
    variants: node.variants.nodes.map((variant) => ({
      externalVariantId: variant.id,
      title: variant.title,
      sku: variant.sku,
      inventoryItemId: variant.inventoryItem?.id ?? null,
      unitCost: num(variant.inventoryItem?.unitCost?.amount),
    })),
  };
}

/** Load current variants for unresolved historical lines. Product GID is used
 * first; exact title search is only a fallback for a deleted/recreated product. */
export async function fetchProductVariantCatalogs(
  creds: ShopifyCreds,
  products: { externalProductId: string | null; title: string }[]
): Promise<Map<string, ShopifyProductVariantCatalog>> {
  const out = new Map<string, ShopifyProductVariantCatalog>();
  if (products.length === 0) return out;
  const c = await resolveCreds(creds);
  const ids = [
    ...new Set(
      products
        .map((product) => product.externalProductId)
        .filter((id): id is string => !!id)
    ),
  ];
  for (let i = 0; i < ids.length; i += 3) {
    const data = await shopifyGraphQL<{
      nodes: (ProductVariantCatalogNode | null)[];
    }>(c, PRODUCT_VARIANT_CATALOG_QUERY, { ids: ids.slice(i, i + 3) });
    for (const node of data.nodes) {
      if (!node) continue;
      const catalog = normalizeCatalog(node);
      out.set(idCatalogKey(catalog.externalProductId), catalog);
      out.set(titleCatalogKey(catalog.title), catalog);
    }
  }

  const missingTitles = [
    ...new Set(
      products
        .filter(
          (product) =>
            !product.externalProductId ||
            !out.has(idCatalogKey(product.externalProductId))
        )
        .map((product) => product.title.trim())
        .filter(Boolean)
    ),
  ];
  for (let i = 0; i < missingTitles.length; i += 2) {
    const group = missingTitles.slice(i, i + 2);
    const results = await Promise.all(
      group.map(async (title) => {
        const escaped = title.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const data = await shopifyGraphQL<{
          products: { nodes: ProductVariantCatalogNode[] };
        }>(c, PRODUCT_VARIANT_CATALOG_BY_TITLE_QUERY, {
          query: `title:'${escaped}'`,
        });
        const exact = data.products.nodes.filter(
          (node) => normalizedLookup(node.title) === normalizedLookup(title)
        );
        return exact.length === 1 ? normalizeCatalog(exact[0]) : null;
      })
    );
    for (const catalog of results) {
      if (!catalog) continue;
      out.set(idCatalogKey(catalog.externalProductId), catalog);
      out.set(titleCatalogKey(catalog.title), catalog);
    }
  }
  return out;
}

/** Resolve a historical line against a current catalog without guessing. SKU
 * wins; variant title is used only when it identifies exactly one variant. */
export function resolveCatalogVariantCost(
  line: Pick<ShopifyOrderCostLine, "sku" | "variantTitle">,
  catalog: ShopifyProductVariantCatalog | undefined
): ShopifyCatalogVariant | null {
  if (!catalog) return null;
  const sku = normalizedLookup(line.sku);
  if (sku) {
    const matches = catalog.variants.filter(
      (variant) => normalizedLookup(variant.sku) === sku && variant.unitCost > 0
    );
    if (matches.length === 1) return matches[0];
  }
  const title = normalizedLookup(line.variantTitle);
  if (!title) return null;
  const matches = catalog.variants.filter(
    (variant) => normalizedLookup(variant.title) === title && variant.unitCost > 0
  );
  return matches.length === 1 ? matches[0] : null;
}

export function findProductVariantCatalog(
  catalogs: Map<string, ShopifyProductVariantCatalog>,
  externalProductId: string | null,
  title: string
): ShopifyProductVariantCatalog | undefined {
  return (
    (externalProductId
      ? catalogs.get(idCatalogKey(externalProductId))
      : undefined) ?? catalogs.get(titleCatalogKey(title))
  );
}

const PRODUCT_COSTS_QUERY = `
query ProductCosts($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id
      variants(first: 250) {
        pageInfo { hasNextPage endCursor }
        nodes { inventoryItem { unitCost { amount } } }
      }
    }
  }
}`;

const PRODUCT_COST_PAGE_QUERY = `
query ProductCostPage($id: ID!, $cursor: String!) {
  node(id: $id) {
    ... on Product {
      id
      variants(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { inventoryItem { unitCost { amount } } }
      }
    }
  }
}`;

type VariantCostNode = {
  inventoryItem: { unitCost: { amount: string } | null } | null;
};

type ProductCostNode = {
  id: string;
  variants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: VariantCostNode[];
  };
};

export function firstPositiveUnitCost(variants: VariantCostNode[]): number | null {
  for (const variant of variants) {
    const cost = num(variant?.inventoryItem?.unitCost?.amount);
    if (cost > 0) return cost;
  }
  return null;
}

async function fetchRemainingProductCost(
  creds: ShopifyCreds,
  productId: string,
  firstCursor: string
): Promise<number | null> {
  let cursor: string | null = firstCursor;
  // Shopify currently allows at most 2,048 variants per product. Twenty pages
  // leaves ample headroom and prevents a malformed repeating cursor from
  // keeping a serverless request alive forever.
  for (let page = 0; page < 20 && cursor; page++) {
    const data: { node: ProductCostNode | null } = await shopifyGraphQL<{
      node: ProductCostNode | null;
    }>(
      creds,
      PRODUCT_COST_PAGE_QUERY,
      { id: productId, cursor }
    );
    const node: ProductCostNode | null = data.node;
    if (!node) return null;
    const cost = firstPositiveUnitCost(node.variants.nodes);
    if (cost != null) return cost;
    cursor = node.variants.pageInfo.hasNextPage
      ? node.variants.pageInfo.endCursor
      : null;
  }
  return null;
}

/** Fetch each product's "Cost per item" and scan every variant page until the
 * first positive cost is found. POD products can exceed 100 size/color variants,
 * so reading only the first page produced false missing-cost warnings. */
export async function fetchProductCosts(
  creds: ShopifyCreds,
  productGids: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (productGids.length === 0) return out;
  const c = await resolveCreds(creds);
  const uniqueIds = [...new Set(productGids)];
  const chunks: string[][] = [];
  // Three products × 250 variants stays under Shopify's 1,000-point maximum
  // requested query cost. Run the first page sequentially so large POD catalogs
  // do not flood a store's rate-limit bucket.
  for (let i = 0; i < uniqueIds.length; i += 3)
    chunks.push(uniqueIds.slice(i, i + 3));

  const remaining: { id: string; cursor: string }[] = [];
  for (const ids of chunks) {
    const data = await shopifyGraphQL<{ nodes: (ProductCostNode | null)[] }>(
      c,
      PRODUCT_COSTS_QUERY,
      { ids }
    );
    for (const node of data.nodes) {
      if (!node?.id) continue;
      const cost = firstPositiveUnitCost(node.variants.nodes);
      if (cost != null) {
        out.set(node.id, cost);
      } else if (
        node.variants.pageInfo.hasNextPage &&
        node.variants.pageInfo.endCursor
      ) {
        remaining.push({ id: node.id, cursor: node.variants.pageInfo.endCursor });
      }
    }
  }

  // Only products whose first 250 variants have no cost need more requests.
  // Two workers keep this bounded while avoiding a long serial tail.
  const CONCURRENCY = 2;
  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const group = remaining.slice(i, i + CONCURRENCY);
    const costs = await Promise.all(
      group.map((item) => fetchRemainingProductCost(c, item.id, item.cursor))
    );
    for (let j = 0; j < group.length; j++) {
      const cost = costs[j];
      if (cost != null) out.set(group[j].id, cost);
    }
  }
  return out;
}

/** Total number of orders in the window — best-effort, for an accurate progress
 *  bar. Returns null if the API/version doesn't support ordersCount. */
/** Shopify search query for an order window. `until` (optional) bounds the end
 *  so a date-chunk pulls only its slice — needed for resumable chunked sync. */
function orderRangeQuery(since: Date, until?: Date): string {
  const upper = until ? ` created_at:<=${until.toISOString()}` : "";
  return `created_at:>=${since.toISOString()}${upper} status:any`;
}

export async function fetchOrdersCount(
  creds: ShopifyCreds,
  since: Date,
  until?: Date
): Promise<number | null> {
  try {
    const c = await resolveCreds(creds);
    const queryStr = orderRangeQuery(since, until);
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
  useJourney = true,
  until?: Date,
  includeCost = false
): Promise<OrdersPage> {
  const c = await resolveCreds(creds);
  const queryStr = orderRangeQuery(since, until);
  let used = useJourney;

  let data: OrdersResp;
  try {
    data = await shopifyGraphQL<OrdersResp>(
      c,
      ordersQuery(used, includeCost),
      { cursor, query: queryStr },
      used ? 1 : 2
    );
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    // A missing read_inventory scope (cost per item) is a config error → surface
    // it clearly instead of silently dropping cost.
    if (includeCost && /inventory|unitCost|InventoryItem/i.test(m)) {
      throw new Error(
        "Cần cấp scope 'read_inventory' cho app Shopify để lấy Cost per item, rồi cài lại app lên store. (" +
          m.slice(0, 160) +
          ")"
      );
    }
    // Otherwise fall back to the lighter query when protected data isn't enabled,
    // or the journey-heavy query fails with a gateway/throttle error.
    const accessDenied = /customerJourney|protected|customer data|access denied|not approved|ACCESS_DENIED/i.test(m);
    const gateway = /HTTP (429|5\d\d)|throttl/i.test(m);
    if (used && (accessDenied || gateway)) {
      used = false;
      data = await shopifyGraphQL<OrdersResp>(
        c,
        ordersQuery(false, includeCost),
        { cursor, query: queryStr },
        2
      );
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

// Lightweight query for ONLY refunded orders — no line items, so we can pull
// many per page and just patch the `refunded`/tax on existing orders.
const REFUNDS_QUERY = `
query Refunds($cursor: String, $query: String) {
  orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      totalRefundedSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
    }
  }
}`;

export interface RefundRow {
  externalId: string;
  refunded: number;
  tax: number;
}
export interface RefundsPage {
  refunds: RefundRow[];
  nextCursor: string | null;
  hasNext: boolean;
}

/** One page of REFUNDED orders in [since, until] — only their id + refunded
 *  amount + current tax. Filters to (partially) refunded orders so we scan a
 *  small subset instead of every order.
 *  byUpdated=true windows on updated_at instead of created_at — a refund BUMPS
 *  the order's updated_at, so a short updated_at window catches fresh refunds
 *  even on months-old orders (used by the hourly auto-refresh). */
export async function fetchRefundsPage(
  creds: ShopifyCreds,
  since: Date,
  until: Date | undefined,
  cursor: string | null = null,
  byUpdated = false
): Promise<RefundsPage> {
  const c = await resolveCreds(creds);
  const refundFilter =
    "(financial_status:refunded OR financial_status:partially_refunded)";
  const queryStr = byUpdated
    ? `updated_at:>=${since.toISOString()} status:any ${refundFilter}`
    : `${orderRangeQuery(since, until)} ${refundFilter}`;
  const data = await shopifyGraphQL<{
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        id: string;
        totalRefundedSet: { shopMoney: { amount: string } } | null;
        currentTotalTaxSet: { shopMoney: { amount: string } } | null;
      }[];
    };
  }>(c, REFUNDS_QUERY, { cursor, query: queryStr });
  return {
    refunds: data.orders.nodes.map((n) => ({
      externalId: n.id,
      refunded: num(n.totalRefundedSet?.shopMoney.amount),
      tax: num(n.currentTotalTaxSet?.shopMoney.amount),
    })),
    nextCursor: data.orders.pageInfo.endCursor,
    hasNext: data.orders.pageInfo.hasNextPage,
  };
}

/** Fetch all orders since a date (loops fetchOrdersPage). Used by cron. */
export async function fetchOrdersSince(
  creds: ShopifyCreds,
  since: Date,
  includeCost = false
): Promise<ShopifyOrderNorm[]> {
  const out: ShopifyOrderNorm[] = [];
  let cursor: string | null = null;
  let useJourney = true;
  for (let page = 0; page < 400; page++) {
    const p = await fetchOrdersPage(creds, since, cursor, useJourney, undefined, includeCost);
    useJourney = p.usedJourney; // stay downgraded once we fall back
    out.push(...p.orders);
    if (!p.hasNext) break;
    cursor = p.nextCursor;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WEBHOOKS — real-time order ingestion.
// Shopify signs each webhook body with the app's client secret (HMAC-SHA256,
// base64) in the X-Shopify-Hmac-Sha256 header. We register orders/create +
// orders/updated so new and edited orders flow in without a manual Sync.
// ---------------------------------------------------------------------------

/** Verify a webhook came from Shopify (HMAC-SHA256 of the raw body, base64). */
export function verifyWebhookHmac(
  rawBody: string,
  hmacHeader: string,
  secret: string
): boolean {
  if (!hmacHeader || !secret) return false;
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Minimal shape of the REST order payload Shopify sends in order webhooks.
interface WebhookOrderPayload {
  id: number | string;
  created_at: string;
  total_discounts?: string;
  total_tax?: string;
  current_total_tax?: string; // net of refunds/edits
  total_shipping_price_set?: { shop_money?: { amount?: string } } | null;
  shipping_lines?: { price?: string }[];
  source_name?: string | null;
  landing_site?: string | null;
  referring_site?: string | null;
  refunds?: { transactions?: { amount?: string; kind?: string }[] }[];
  line_items?: {
    id?: number | string | null;
    title: string;
    quantity: number;
    price?: string;
    product_id?: number | string | null;
    variant_id?: number | string | null;
  }[];
}

/** Normalize a webhook (REST) order into the same shape as the GraphQL sync.
 *  Builds GraphQL-style GIDs so upserts hit the SAME row (no duplicates). */
export function normalizeWebhookOrder(p: WebhookOrderPayload): ShopifyOrderNorm {
  let gross = 0;
  let units = 0;
  const lineItems: ShopifyOrderLineNorm[] = (p.line_items ?? []).map((li) => {
    const price = num(li.price);
    gross += price * li.quantity;
    units += li.quantity;
    return {
      externalProductId:
        li.product_id != null ? `gid://shopify/Product/${li.product_id}` : null,
      externalLineItemId:
        li.id != null ? `gid://shopify/LineItem/${li.id}` : null,
      externalVariantId:
        li.variant_id != null ? `gid://shopify/ProductVariant/${li.variant_id}` : null,
      inventoryItemId: null,
      title: li.title,
      image: null, // webhook payload has no product image; a later sync fills it
      quantity: li.quantity,
      price,
      unitCost: 0, // REST webhook has no cost; a later GraphQL sync fills it
    };
  });

  // Best-effort channel from landing_site UTM params + referrer.
  let utm: { source: string | null; medium: string | null; campaign: string | null } = {
    source: null,
    medium: null,
    campaign: null,
  };
  if (p.landing_site && p.landing_site.includes("?")) {
    const qs = new URLSearchParams(p.landing_site.split("?")[1]);
    utm = {
      source: qs.get("utm_source"),
      medium: qs.get("utm_medium"),
      campaign: qs.get("utm_campaign"),
    };
  }
  const attr = classifyChannel({
    source: null,
    sourceType: null,
    referrerUrl: p.referring_site ?? null,
    utmParameters: utm,
  });

  const shipping =
    num(p.total_shipping_price_set?.shop_money?.amount) ||
    (p.shipping_lines ?? []).reduce((s, l) => s + num(l.price), 0);

  // Sum refund transactions (best-effort; a later GraphQL sync sets the exact
  // totalRefundedSet). Only "refund" kind, ignore authorizations/voids.
  const refunded = (p.refunds ?? []).reduce(
    (s, r) =>
      s +
      (r.transactions ?? [])
        .filter((t) => t.kind === "refund")
        .reduce((a, t) => a + num(t.amount), 0),
    0
  );

  return {
    externalId: `gid://shopify/Order/${p.id}`,
    date: new Date(p.created_at),
    grossRevenue: gross,
    discounts: num(p.total_discounts),
    tax: num(p.current_total_tax ?? p.total_tax),
    shippingCharged: shipping,
    refunded,
    itemsCount: units,
    channel: attr.channel,
    utmSource: attr.utmSource,
    utmMedium: attr.utmMedium,
    utmCampaign: attr.utmCampaign,
    sourceName: p.source_name ?? null,
    lineItems,
  };
}

export interface ShopifyInventoryCostWebhook {
  inventoryItemId: string;
  unitCost: number;
}

/** Normalize the REST inventory_items/update payload. A zero cost is valid but
 * never used to overwrite an already captured historical snapshot. */
export function normalizeInventoryCostWebhook(p: {
  id?: number | string | null;
  cost?: string | number | null;
}): ShopifyInventoryCostWebhook | null {
  if (p.id == null) return null;
  return {
    inventoryItemId: `gid://shopify/InventoryItem/${p.id}`,
    unitCost: num(p.cost),
  };
}

const WEBHOOK_CREATE = `
mutation Create($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

/** Subscribe a store to orders/create + orders/updated webhooks pointing at
 *  callbackUrl. "Already exists" is treated as success (idempotent). */
export async function registerOrderWebhooks(
  creds: ShopifyCreds,
  callbackUrl: string
): Promise<{ created: number; errors: string[] }> {
  const c = await resolveCreds(creds);
  const topics = ["ORDERS_CREATE", "ORDERS_UPDATED", "INVENTORY_ITEMS_UPDATE"];
  let created = 0;
  const errors: string[] = [];
  for (const topic of topics) {
    const data = await shopifyGraphQL<{
      webhookSubscriptionCreate: {
        webhookSubscription: { id: string } | null;
        userErrors: { message: string }[];
      };
    }>(c, WEBHOOK_CREATE, { topic, sub: { callbackUrl, format: "JSON" } });
    const r = data.webhookSubscriptionCreate;
    if (r.webhookSubscription) {
      created++;
    } else {
      const msg = r.userErrors.map((e) => e.message).join("; ");
      if (/already|taken|exists/i.test(msg)) created++; // idempotent
      else errors.push(`${topic}: ${msg || "unknown error"}`);
    }
  }
  return { created, errors };
}
