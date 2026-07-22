// ---------------------------------------------------------------------------
// SYNC ORCHESTRATOR — pull Shopify orders into the DB (idempotent).
// Products are derived from order lines (title + image + handle) — we do
// NOT fetch the full catalog, so syncs stay small/fast and need no read_inventory.
// Upserts by (storeId, externalId) so re-running never duplicates.
//
// Two entry points:
//  - syncStore / syncAllStores: pull the whole window in one call (used by cron).
//  - syncStorePage: pull ONE page (cursor-based) so the browser can loop and
//    never hit the serverless time limit. This is what the Stores UI uses.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import {
  fetchOrdersPage,
  fetchOrdersSince,
  fetchProductMedia,
  fetchRefundsPage,
  fetchOrderLinesForCosts,
  fetchProductVariantCatalogs,
  fetchVariantCosts,
  findProductVariantCatalog,
  preserveUnitCostSnapshot,
  resolveCatalogVariantCost,
  ShopifyCreds,
  ShopifyOrderCostLine,
  ShopifyOrderLineNorm,
  ShopifyOrderNorm,
} from "@/lib/shopify";
import { customRange, DEFAULT_TZ } from "@/lib/dates";

export interface SyncResult {
  storeId: string;
  storeName: string;
  products: number;
  orders: number;
  since: string;
  ok: boolean;
  error?: string;
}

export interface SyncOpts {
  sinceDays?: number;
  since?: Date; // explicit start date (overrides sinceDays)
}

// --- shared helpers --------------------------------------------------------

/** Resolve the credentials for a store (or a reason it can't be synced). */
async function storeCreds(storeId: string, organizationId: string) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store || store.organizationId !== organizationId)
    throw new Error("Store not found");
  const hasClientCreds = !!(store.shopifyClientId && store.shopifyClientSecret);
  if (!store.shopifyDomain || !(store.shopifyToken || hasClientCreds)) {
    return { store, creds: null as ShopifyCreds | null };
  }
  const creds: ShopifyCreds = {
    shopifyDomain: store.shopifyDomain,
    shopifyClientId: store.shopifyClientId,
    shopifyClientSecret: store.shopifyClientSecret,
    shopifyToken: store.shopifyToken,
    shopifyApiVersion: store.shopifyApiVersion,
  };
  return { store, creds };
}

function resolveSince(opts: SyncOpts, lastSyncedAt: Date | null): Date {
  return opts.since
    ? opts.since
    : opts.sinceDays
    ? daysAgo(opts.sinceDays)
    : lastSyncedAt
    ? new Date(lastSyncedAt.getTime() - 2 * 86400000)
    : daysAgo(7);
}

/** Derive minimal products (title+image+handle) from orders and upsert them.
 *  Returns externalProductId → internal product id, to link line items. */
async function upsertProductsFromOrders(
  orders: ShopifyOrderNorm[],
  storeId: string,
  organizationId: string
): Promise<Map<string, string>> {
  const derived = new Map<
    string,
    { title: string; image: string | null; handle: string | null }
  >();
  for (const o of orders)
    for (const li of o.lineItems) {
      if (!li.externalProductId) continue;
      const prev = derived.get(li.externalProductId);
      if (!prev) {
        derived.set(li.externalProductId, {
          title: li.title,
          image: li.image,
          handle: li.handle,
        });
      } else {
        if (!prev.image && li.image) prev.image = li.image;
        if (!prev.handle && li.handle) prev.handle = li.handle;
      }
    }

  const map = new Map<string, string>();
  for (const [externalId, p] of derived) {
    const saved = await prisma.product.upsert({
      where: { storeId_externalId: { storeId, externalId } },
      create: {
        organizationId,
        storeId,
        externalId,
        title: p.title,
        image: p.image,
        handle: p.handle,
        // baseCost not pulled from Shopify → COGS comes from Cost Rules.
      },
      // Refresh title; only set image when we actually have one so a webhook
      // order (which carries no product image) never wipes a synced image.
      update: {
        title: p.title,
        ...(p.image ? { image: p.image } : {}),
        ...(p.handle ? { handle: p.handle } : {}),
      },
    });
    map.set(externalId, saved.id);
  }
  return map;
}

/** Upsert a batch of orders + their line items (idempotent). */
async function upsertOrders(
  orders: ShopifyOrderNorm[],
  storeId: string,
  organizationId: string,
  productMap: Map<string, string>
): Promise<void> {
  for (const o of orders) {
    const existingOrder = await prisma.order.findUnique({
      where: { storeId_externalId: { storeId, externalId: o.externalId } },
      select: {
        lineItems: {
          select: {
            id: true,
            productId: true,
            externalLineItemId: true,
            externalVariantId: true,
            inventoryItemId: true,
            title: true,
            image: true,
            price: true,
            unitCost: true,
          },
        },
      },
    });
    const existing = existingOrder?.lineItems ?? [];
    const used = new Set<string>();

    const takeExisting = (li: ShopifyOrderLineNorm, productId: string | null) => {
      const match = existing.find((old) => {
        if (used.has(old.id)) return false;
        if (li.externalLineItemId && old.externalLineItemId)
          return li.externalLineItemId === old.externalLineItemId;
        if (li.externalVariantId && old.externalVariantId)
          return li.externalVariantId === old.externalVariantId;
        return (
          old.productId === productId &&
          old.title === li.title &&
          Math.abs(old.price - li.price) < 0.0001
        );
      });
      if (match) used.add(match.id);
      return match;
    };

    const lineItemData = o.lineItems.map((li) => {
      const productId = li.externalProductId
        ? productMap.get(li.externalProductId) ?? null
        : null;
      const old = takeExisting(li, productId);
      return {
        productId,
        externalLineItemId: li.externalLineItemId ?? old?.externalLineItemId ?? null,
        externalVariantId: li.externalVariantId ?? old?.externalVariantId ?? null,
        inventoryItemId: li.inventoryItemId ?? old?.inventoryItemId ?? null,
        title: li.title,
        image: li.image ?? old?.image ?? null,
        quantity: li.quantity,
        price: li.price,
        // A positive cost is a historical snapshot. Order edits/re-syncs may
        // add metadata, but must never replace that snapshot with today's cost.
        unitCost: preserveUnitCostSnapshot(old?.unitCost ?? 0, li.unitCost),
      };
    });

    const common = {
      date: o.date,
      grossRevenue: o.grossRevenue,
      discounts: o.discounts,
      tax: o.tax,
      shippingCharged: o.shippingCharged,
      refunded: o.refunded,
      itemsCount: o.itemsCount,
      channel: o.channel,
      utmSource: o.utmSource,
      utmMedium: o.utmMedium,
      utmCampaign: o.utmCampaign,
      sourceName: o.sourceName,
      source: "API",
    };

    await prisma.order.upsert({
      where: { storeId_externalId: { storeId, externalId: o.externalId } },
      create: {
        organizationId,
        storeId,
        externalId: o.externalId,
        ...common,
        lineItems: { create: lineItemData },
      },
      update: { ...common, lineItems: { deleteMany: {}, create: lineItemData } },
    });
  }
}

/** Backfill media for products that arrived through image-less webhooks. */
async function backfillStoreMedia(
  storeId: string,
  organizationId: string,
  creds: ShopifyCreds
): Promise<number> {
  try {
    const missing = await prisma.product.findMany({
      where: {
        organizationId,
        storeId,
        externalId: { not: null },
        OR: [{ image: null }, { handle: null }],
      },
      select: { id: true, externalId: true },
      take: 250,
    });
    if (missing.length === 0) return 0;
    const media = await fetchProductMedia(
      creds,
      missing.map((m) => m.externalId!).filter(Boolean)
    );
    let updated = 0;
    for (const m of missing) {
      const item = m.externalId ? media.get(m.externalId) : undefined;
      if (item?.image || item?.handle) {
        await prisma.product.update({
          where: { id: m.id },
          data: {
            ...(item.image ? { image: item.image } : {}),
            ...(item.handle ? { handle: item.handle } : {}),
          },
        });
        updated++;
      }
    }
    return updated;
  } catch {
    return 0; // media backfill is non-critical
  }
}

export interface ProductMediaPageResult {
  ok: boolean;
  scanned: number;
  updated: number;
  total: number | null;
  nextCursor: string | null;
  hasNext: boolean;
  errors: string[];
}

/** Refresh one bounded page of Shopify product images + handles. The browser
 * loops this endpoint, so large catalogs cannot exhaust a serverless request. */
export async function refreshProductMediaPage(
  organizationId: string,
  opts: {
    storeId: string;
    cursor?: string | null;
    limit?: number;
    productIds?: string[];
  }
): Promise<ProductMediaPageResult> {
  const { store, creds } = await storeCreds(opts.storeId, organizationId);
  if (!creds) {
    return {
      ok: true,
      scanned: 0,
      updated: 0,
      total: 0,
      nextCursor: null,
      hasNext: false,
      errors: [`${store?.name ?? opts.storeId}: thiếu khoá kết nối Shopify`],
    };
  }

  const limit = Math.min(100, Math.max(10, opts.limit ?? 100));
  const selectedProductIds = opts.productIds
    ? [...new Set(opts.productIds.filter(Boolean))]
    : null;
  if (selectedProductIds && selectedProductIds.length === 0) {
    return {
      ok: true,
      scanned: 0,
      updated: 0,
      total: 0,
      nextCursor: null,
      hasNext: false,
      errors: [],
    };
  }
  const where = {
    organizationId,
    storeId: opts.storeId,
    active: true,
    externalId: { not: null as string | null },
    ...(selectedProductIds || opts.cursor
      ? {
          id: {
            ...(selectedProductIds ? { in: selectedProductIds } : {}),
            ...(opts.cursor ? { gt: opts.cursor } : {}),
          },
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { id: "asc" },
      take: limit + 1,
      select: { id: true, externalId: true },
    }),
    opts.cursor
      ? Promise.resolve(null)
      : prisma.product.count({
          where: {
            organizationId,
            storeId: opts.storeId,
            active: true,
            externalId: { not: null },
            ...(selectedProductIds ? { id: { in: selectedProductIds } } : {}),
          },
        }),
  ]);

  const page = rows.slice(0, limit);
  const hasNext = rows.length > limit;
  const nextCursor = hasNext ? page[page.length - 1]?.id ?? null : null;
  const media = await fetchProductMedia(
    creds,
    page.map((product) => product.externalId!).filter(Boolean)
  );
  const updates = page.flatMap((product) => {
    const item = product.externalId ? media.get(product.externalId) : undefined;
    return item?.image || item?.handle
      ? [{ id: product.id, image: item.image, handle: item.handle }]
      : [];
  });
  if (updates.length > 0) {
    await prisma.$transaction(
      updates.map((product) =>
        prisma.product.update({
          where: { id: product.id },
          data: {
            ...(product.image ? { image: product.image } : {}),
            ...(product.handle ? { handle: product.handle } : {}),
          },
        })
      )
    );
  }

  return {
    ok: true,
    scanned: page.length,
    updated: updates.length,
    total,
    nextCursor,
    hasNext,
    errors: [],
  };
}

/** Ingest a batch of already-normalized orders (used by the webhook receiver).
 *  Idempotent: same externalId → same row. Returns counts. */
export async function ingestOrders(
  storeId: string,
  organizationId: string,
  orders: ShopifyOrderNorm[]
): Promise<{ products: number; orders: number }> {
  const productMap = await upsertProductsFromOrders(orders, storeId, organizationId);
  await upsertOrders(orders, storeId, organizationId, productMap);
  return { products: productMap.size, orders: orders.length };
}

/** Enrich a webhook order from its exact variant IDs, then ingest it once. The
 * order is still saved if Shopify's inventory query fails; a later missing-only
 * backfill can repair those zero-cost lines. */
export async function ingestWebhookOrder(
  storeId: string,
  organizationId: string,
  order: ShopifyOrderNorm
): Promise<{ products: number; orders: number; costsResolved: number }> {
  const { store, creds } = await storeCreds(storeId, organizationId);
  let costsResolved = 0;
  let enriched = order;
  if (creds) {
    try {
      if (store?.cogsSource === "COST_PER_ITEM") {
        const costs = await fetchVariantCosts(
          creds,
          order.lineItems
            .map((line) => line.externalVariantId)
            .filter((id): id is string => !!id)
        );
        enriched = {
          ...order,
          lineItems: order.lineItems.map((line) => {
            const cost = line.externalVariantId
              ? costs.get(line.externalVariantId)
              : undefined;
            if (cost && cost.unitCost > 0) costsResolved++;
            return cost
              ? {
                  ...line,
                  externalProductId: line.externalProductId ?? cost.productId,
                  inventoryItemId: cost.inventoryItemId,
                  unitCost: cost.unitCost,
                  image: line.image ?? cost.productImage,
                  handle: line.handle ?? cost.productHandle,
                }
              : line;
          }),
        };
      } else {
        const media = await fetchProductMedia(
          creds,
          order.lineItems
            .map((line) => line.externalProductId)
            .filter((id): id is string => !!id)
        );
        enriched = {
          ...order,
          lineItems: order.lineItems.map((line) => {
            const item = line.externalProductId
              ? media.get(line.externalProductId)
              : undefined;
            return item
              ? {
                  ...line,
                  image: line.image ?? item.image,
                  handle: line.handle ?? item.handle,
                }
              : line;
          }),
        };
      }
    } catch (error) {
      console.error("Shopify webhook product enrichment error:", error);
    }
  }
  const result = await ingestOrders(storeId, organizationId, [enriched]);
  return { ...result, costsResolved };
}

/** An inventory cost webhook repairs only rows that are still missing cost.
 * Existing positive snapshots intentionally remain unchanged. */
export async function backfillMissingInventoryCost(
  storeId: string,
  organizationId: string,
  inventoryItemId: string,
  unitCost: number
): Promise<number> {
  if (unitCost <= 0) return 0;
  const result = await prisma.orderLineItem.updateMany({
    where: {
      inventoryItemId,
      unitCost: { lte: 0 },
      order: {
        storeId,
        organizationId,
        store: { cogsSource: "COST_PER_ITEM" },
      },
    },
    data: { unitCost },
  });
  return result.count;
}

// --- page-by-page sync (browser-driven) ------------------------------------

export interface SyncPageOpts extends SyncOpts {
  cursor?: string | null;
  useJourney?: boolean; // pass back what the server returned
  until?: Date; // optional window end — for resumable date-chunked sync
  // When false, don't stamp lastSyncedAt / run image backfill on the chunk's
  // last page (used for all chunks except the newest one).
  finalize?: boolean;
}

export interface SyncPageResult {
  ok: boolean;
  storeId: string;
  storeName: string;
  since: string; // resolved ISO — pass back on the next call so it stays stable
  cursor: string | null; // next page cursor (null when finished)
  hasNext: boolean;
  pageProducts: number; // distinct products upserted on this page
  pageOrders: number; // orders upserted on this page
  useJourney: boolean; // whether channel attribution was available
  total: number | null; // total orders in window (only on the first page)
  error?: string;
}

/** Sync exactly ONE page of orders for a store. Short + safe under any time
 *  limit; the client calls it repeatedly with the returned cursor. */
export async function syncStorePage(
  storeId: string,
  organizationId: string,
  opts: SyncPageOpts = {}
): Promise<SyncPageResult> {
  const { store, creds } = await storeCreds(storeId, organizationId);
  const base = {
    storeId,
    storeName: store?.name ?? storeId,
    since: "",
    cursor: null as string | null,
    hasNext: false,
    pageProducts: 0,
    pageOrders: 0,
    useJourney: opts.useJourney ?? true,
    total: null as number | null,
  };
  if (!creds) {
    return {
      ...base,
      ok: false,
      error: "Thiếu Shopify domain hoặc khoá kết nối (Client ID/Secret hoặc token).",
    };
  }

  const since = resolveSince(opts, store!.lastSyncedAt);
  const until = opts.until;
  try {
    // Avoid a separate ordersCount API call: the browser can show page-based
    // progress, and one less Shopify request keeps this serverless call short.
    const total = null;

    const page = await fetchOrdersPage(
      creds,
      since,
      opts.cursor ?? null,
      opts.useJourney ?? true,
      until,
      false // Basecost uses its own missing-only, resumable update flow
    );
    const productMap = await upsertProductsFromOrders(page.orders, storeId, organizationId);
    await upsertOrders(page.orders, storeId, organizationId, productMap);

    // Keep the last page lightweight: stamp completion only. Images for these
    // products were already included in the order query.
    if (!page.hasNext && opts.finalize !== false) {
      await prisma.store.update({
        where: { id: storeId },
        data: { lastSyncedAt: new Date() },
      });
    }

    return {
      ...base,
      ok: true,
      since: since.toISOString(),
      cursor: page.nextCursor,
      hasNext: page.hasNext,
      pageProducts: productMap.size,
      pageOrders: page.orders.length,
      useJourney: page.usedJourney,
      total,
    };
  } catch (e) {
    return {
      ...base,
      ok: false,
      since: since.toISOString(),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// --- refunds-only sync (patch existing orders, no line-item re-pull) --------

export interface RefundsPageResult {
  ok: boolean;
  storeId: string;
  storeName: string;
  cursor: string | null;
  hasNext: boolean;
  pageUpdated: number; // existing orders patched this page
  pageScanned: number; // refunded orders returned this page
  error?: string;
}

/** Sync ONE page of REFUNDED orders for a store: patch `refunded` (+ current
 *  tax) on orders already in the DB. Cheap vs a full re-sync — only refunded
 *  orders, no line items. The browser loops it with the returned cursor. */
export async function syncStoreRefundsPage(
  storeId: string,
  organizationId: string,
  opts: { since?: Date; until?: Date; sinceDays?: number; cursor?: string | null } = {}
): Promise<RefundsPageResult> {
  const { store, creds } = await storeCreds(storeId, organizationId);
  const base = {
    storeId,
    storeName: store?.name ?? storeId,
    cursor: null as string | null,
    hasNext: false,
    pageUpdated: 0,
    pageScanned: 0,
  };
  if (!creds)
    return { ...base, ok: false, error: "Thiếu Shopify domain hoặc khoá kết nối." };

  const since = resolveSince(opts, store!.lastSyncedAt);
  try {
    const page = await fetchRefundsPage(creds, since, opts.until, opts.cursor ?? null);
    let updated = 0;
    for (const r of page.refunds) {
      const res = await prisma.order.updateMany({
        where: { storeId, externalId: r.externalId },
        data: { refunded: r.refunded, tax: r.tax },
      });
      updated += res.count; // count 0 if the order isn't in our DB (skip)
    }
    return {
      ...base,
      ok: true,
      cursor: page.nextCursor,
      hasNext: page.hasNext,
      pageUpdated: updated,
      pageScanned: page.refunds.length,
    };
  } catch (e) {
    return { ...base, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Scan ALL refunded orders whose updated_at falls in the last `sinceDays`
 *  days and patch `refunded`/tax. A refund bumps the order's updated_at, so
 *  this catches fresh refunds even on months-old orders — the hourly
 *  auto-refresh uses it (small window → a page or two, fits a serverless
 *  call, no client paging loop needed). */
export async function syncStoreRefundsWindow(
  storeId: string,
  organizationId: string,
  opts: { sinceDays?: number } = {}
): Promise<{ ok: boolean; storeName: string; updated: number; scanned: number; error?: string }> {
  const { store, creds } = await storeCreds(storeId, organizationId);
  const storeName = store?.name ?? storeId;
  if (!creds)
    return { ok: false, storeName, updated: 0, scanned: 0, error: "Thiếu khoá kết nối." };

  const since = daysAgo(opts.sinceDays ?? 2);
  try {
    let cursor: string | null = null;
    let updated = 0;
    let scanned = 0;
    for (let page = 0; page < 30; page++) {
      const p = await fetchRefundsPage(creds, since, undefined, cursor, true);
      scanned += p.refunds.length;
      for (const r of p.refunds) {
        const res = await prisma.order.updateMany({
          where: { storeId, externalId: r.externalId },
          data: { refunded: r.refunded, tax: r.tax },
        });
        updated += res.count; // 0 if the order isn't in our DB (skip)
      }
      if (!p.hasNext) break;
      cursor = p.nextCursor;
    }
    return { ok: true, storeName, updated, scanned };
  } catch (e) {
    return {
      ok: false,
      storeName,
      updated: 0,
      scanned: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// --- cost-only sync (patch line-item unit costs, no order re-pull) ----------

export interface CostSyncResult {
  ok: boolean;
  storeId: string;
  storeName: string;
  products: number; // distinct products found in the window's orders
  withCost: number; // of those, how many have a Cost per item on Shopify
  updated: number; // line items patched
  missingCount: number;
  missingProducts: MissingBasecostItem[];
  missingTruncated: boolean;
  nextCursor: string | null;
  hasNext: boolean;
  error?: string;
}

export interface MissingBasecostItem {
  productId: string | null;
  externalId: string | null;
  title: string;
  storeId: string | null;
  storeName: string;
  orderLines: number;
  units: number;
}

export interface MissingBasecostReport {
  total: number;
  items: MissingBasecostItem[];
  truncated: boolean;
}

/** List products used by COST_PER_ITEM stores whose order-line cost is still
 * zero. This is the actual P&L gap, so the warning remains visible even when a
 * Shopify cost fetch completed successfully for other products. */
export async function findMissingBasecosts(
  organizationId: string,
  opts: {
    start: Date;
    end: Date;
    storeId?: string;
    limit?: number;
    productIds?: string[];
  }
): Promise<MissingBasecostReport> {
  const where = {
    unitCost: { lte: 0 },
    // Tips, donations and other custom order charges are not Shopify products,
    // cannot carry inventory Cost per item, and must not be reported as missing
    // product Basecost.
    productId: opts.productIds?.length
      ? { in: opts.productIds }
      : { not: null },
    order: {
      organizationId,
      date: { gte: opts.start, lt: opts.end },
      ...(opts.storeId ? { storeId: opts.storeId } : {}),
      store: { cogsSource: "COST_PER_ITEM" },
    },
  };
  const grouped = await prisma.orderLineItem.groupBy({
    by: ["productId", "title"],
    where,
    _count: { _all: true },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
  });
  const limit = opts.limit ?? 100;
  const visible = grouped.slice(0, limit);
  const productIds = visible
    .map((row) => row.productId)
    .filter((id): id is string => !!id);
  const products = await prisma.product.findMany({
    where: { organizationId, id: { in: productIds } },
    select: {
      id: true,
      externalId: true,
      store: { select: { id: true, name: true } },
    },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  return {
    total: grouped.length,
    truncated: grouped.length > visible.length,
    items: visible.map((row) => {
      const product = row.productId ? productById.get(row.productId) : null;
      return {
        productId: row.productId,
        externalId: product?.externalId ?? null,
        title: row.title,
        storeId: product?.store.id ?? opts.storeId ?? null,
        storeName: product?.store.name ?? "Không xác định",
        orderLines: row._count._all,
        units: row._sum.quantity ?? 0,
      };
    }),
  };
}

/** Refresh "Cost per item" for a store: fetch each product's current cost from
 *  Shopify and patch OrderLineItem.unitCost for that store's orders in the
 *  window. Cheap vs a full order re-sync (products « orders).
 *
 *  Window: prefer fromYMD/toYMD (calendar days resolved in the STORE's
 *  timezone — same day boundaries the dashboard uses). The old since/until
 *  instants used server-local setHours(), which on Vercel (UTC) covered only
 *  part of a JST day — a picked day looked like "no costs found". */
export async function syncStoreCosts(
  storeId: string,
  organizationId: string,
  opts: {
    since?: Date;
    until?: Date;
    sinceDays?: number;
    fromYMD?: string;
    toYMD?: string;
    cursor?: string;
    limit?: number;
    productIds?: string[];
  } = {}
): Promise<CostSyncResult> {
  const { store, creds } = await storeCreds(storeId, organizationId);
  const base = {
    storeId,
    storeName: store?.name ?? storeId,
    products: 0,
    withCost: 0,
    updated: 0,
    missingCount: 0,
    missingProducts: [] as MissingBasecostItem[],
    missingTruncated: false,
    nextCursor: null as string | null,
    hasNext: false,
  };
  if (!creds)
    return { ...base, ok: false, error: "Thiếu Shopify domain hoặc khoá kết nối." };

  let winStart: Date;
  let winEnd: Date; // exclusive
  if (opts.fromYMD && opts.toYMD) {
    const r = customRange(opts.fromYMD, opts.toYMD, DEFAULT_TZ);
    winStart = r.start;
    winEnd = r.end;
  } else {
    const since = resolveSince(opts, store!.lastSyncedAt);
    // Legacy instant window: pad a day each side so timezone offsets between
    // the server (UTC) and the store never clip the intended days.
    winStart = new Date(since.getTime() - 86400000);
    winEnd = opts.until
      ? new Date(opts.until.getTime() + 86400000)
      : new Date();
  }
  const dateWindow = { gte: winStart, lt: winEnd };
  const batchLimit = Math.max(1, Math.min(opts.limit ?? 10, 20));
  const selectedProductIds = opts.productIds
    ? [...new Set(opts.productIds.filter(Boolean))]
    : null;
  if (selectedProductIds && selectedProductIds.length === 0) {
    return { ...base, ok: true };
  }

  try {
    // Read only rows that are genuinely missing Basecost.
    const rows = await prisma.orderLineItem.findMany({
      where: {
        ...(opts.cursor ? { id: { gt: opts.cursor } } : {}),
        unitCost: { lte: 0 },
        productId: selectedProductIds
          ? { in: selectedProductIds }
          : { not: null },
        order: { storeId, date: dateWindow },
      },
      select: {
        id: true,
        productId: true,
        externalLineItemId: true,
        externalVariantId: true,
        title: true,
        quantity: true,
        price: true,
        product: { select: { externalId: true } },
        order: { select: { externalId: true } },
      },
      orderBy: { id: "asc" },
      take: batchLimit + 1,
    });
    const hasNext = rows.length > batchLimit;
    const missingLines = rows.slice(0, batchLimit);
    const nextCursor = hasNext ? missingLines[missingLines.length - 1]?.id ?? null : null;
    const batchProductIds = new Set(
      missingLines.map((line) => line.productId).filter((id): id is string => !!id)
    );
    // Nothing missing in the selected window.
    if (missingLines.length === 0) {
      const missing = await findMissingBasecosts(organizationId, {
        start: winStart,
        end: winEnd,
        storeId,
        productIds: selectedProductIds ?? undefined,
      });
      return {
        ...base,
        ok: true,
        missingCount: missing.total,
        missingProducts: missing.items,
        missingTruncated: missing.truncated,
      };
    }

    let updated = 0;
    const resolvedProducts = new Set<string>();
    const variantCosts = await fetchVariantCosts(
      creds,
      missingLines
        .map((line) => line.externalVariantId)
        .filter((id): id is string => !!id)
    );
    for (const [variantId, cost] of variantCosts) {
      const positive = cost.unitCost > 0;
      const res = await prisma.orderLineItem.updateMany({
        where: {
          externalVariantId: variantId,
          unitCost: { lte: 0 },
          ...(selectedProductIds
            ? { productId: { in: selectedProductIds } }
            : {}),
          order: { storeId, date: dateWindow },
        },
        data: {
          inventoryItemId: cost.inventoryItemId,
          ...(positive ? { unitCost: cost.unitCost } : {}),
        },
      });
      if (positive) {
        updated += res.count;
        for (const line of missingLines)
          if (line.externalVariantId === variantId && line.productId)
            resolvedProducts.add(line.productId);
      }
    }

    // Anything not resolved by its stored variant ID is checked against the
    // original order line. This also repairs stale IDs from deleted variants.
    const unresolved = missingLines.filter((line) => {
      const cost = line.externalVariantId
        ? variantCosts.get(line.externalVariantId)
        : undefined;
      return !cost || cost.unitCost <= 0;
    });
    const orderLines = await fetchOrderLinesForCosts(
      creds,
      unresolved
        .map((line) => line.order.externalId)
        .filter((id): id is string => !!id)
    );
    const usedExternalLines = new Set<string>();
    const matchedLines: {
      local: (typeof missingLines)[number];
      remote: ShopifyOrderCostLine;
    }[] = [];
    const normalized = (value: string) => value.trim().replace(/\s+/g, " ");
    for (const local of unresolved) {
      const orderId = local.order.externalId;
      if (!orderId) continue;
      const candidates = (orderLines.get(orderId) ?? []).filter(
        (line) => !usedExternalLines.has(line.externalLineItemId)
      );
      const exact = local.externalLineItemId
        ? candidates.find((line) => line.externalLineItemId === local.externalLineItemId)
        : undefined;
      const tiers = [
        candidates.filter(
          (line) =>
            line.externalProductId === local.product?.externalId &&
            normalized(line.title) === normalized(local.title) &&
            line.quantity === local.quantity &&
            Math.abs(line.price - local.price) < 0.0001
        ),
        candidates.filter(
          (line) =>
            line.externalProductId === local.product?.externalId &&
            normalized(line.title) === normalized(local.title)
        ),
        candidates.filter(
          (line) =>
            normalized(line.title) === normalized(local.title) &&
            line.quantity === local.quantity &&
            Math.abs(line.price - local.price) < 0.0001
        ),
        candidates.filter(
          (line) => normalized(line.title) === normalized(local.title)
        ),
      ];
      const matched = exact ?? tiers.find((matches) => matches.length === 1)?.[0];
      if (!matched) continue;
      usedExternalLines.add(matched.externalLineItemId);
      matchedLines.push({ local, remote: matched });
    }

    const catalogCandidates = matchedLines.filter(
      ({ remote }) => remote.unitCost <= 0
    );
    const catalogs = await fetchProductVariantCatalogs(
      creds,
      catalogCandidates.map(({ local, remote }) => ({
        externalProductId:
          remote.externalProductId ?? local.product?.externalId ?? null,
        title: remote.title,
      }))
    );
    for (const { local, remote } of matchedLines) {
      const catalog = findProductVariantCatalog(
        catalogs,
        remote.externalProductId ?? local.product?.externalId ?? null,
        remote.title
      );
      const catalogVariant =
        remote.unitCost > 0 ? null : resolveCatalogVariantCost(remote, catalog);
      const unitCost =
        remote.unitCost > 0 ? remote.unitCost : catalogVariant?.unitCost ?? 0;
      const variantId =
        remote.unitCost > 0
          ? remote.externalVariantId
          : catalogVariant?.externalVariantId ?? remote.externalVariantId;
      const inventoryItemId =
        remote.unitCost > 0
          ? remote.inventoryItemId
          : catalogVariant?.inventoryItemId ?? remote.inventoryItemId;
      const res = await prisma.orderLineItem.updateMany({
        where: { id: local.id, unitCost: { lte: 0 } },
        data: {
          externalLineItemId: remote.externalLineItemId,
          externalVariantId: variantId,
          inventoryItemId,
          ...(unitCost > 0 ? { unitCost } : {}),
        },
      });
      if (unitCost > 0) {
        updated += res.count;
        if (local.productId) resolvedProducts.add(local.productId);
      }
    }
    const missing = hasNext
      ? { total: 0, items: [] as MissingBasecostItem[], truncated: false }
      : await findMissingBasecosts(organizationId, {
          start: winStart,
          end: winEnd,
          storeId,
          productIds: selectedProductIds ?? undefined,
        });
    return {
      ...base,
      ok: true,
      products: batchProductIds.size,
      withCost: resolvedProducts.size,
      updated,
      missingCount: missing.total,
      missingProducts: missing.items,
      missingTruncated: missing.truncated,
      nextCursor,
      hasNext,
    };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/inventory|unitCost|InventoryItem/i.test(m))
      return {
        ...base,
        ok: false,
        error:
          "Cần cấp scope 'read_inventory' cho app + cài lại app lên store để lấy Cost per item.",
      };
    return { ...base, ok: false, error: m };
  }
}

// --- whole-window sync (cron / API) ----------------------------------------

export async function syncStore(
  storeId: string,
  organizationId: string,
  opts: SyncOpts = {}
): Promise<SyncResult> {
  const { store, creds } = await storeCreds(storeId, organizationId);
  const storeName = store?.name ?? storeId;
  if (!creds) {
    return {
      storeId,
      storeName,
      products: 0,
      orders: 0,
      since: "",
      ok: false,
      error: "Thiếu Shopify domain hoặc khoá kết nối (Client ID/Secret hoặc token).",
    };
  }

  const since = resolveSince(opts, store!.lastSyncedAt);
  try {
    const orders = await fetchOrdersSince(
      creds,
      since,
      store!.cogsSource === "COST_PER_ITEM"
    );
    const productMap = await upsertProductsFromOrders(orders, storeId, organizationId);
    await upsertOrders(orders, storeId, organizationId, productMap);
    await prisma.store.update({
      where: { id: storeId },
      data: { lastSyncedAt: new Date() },
    });
    await backfillStoreMedia(storeId, organizationId, creds);
    return {
      storeId,
      storeName,
      products: productMap.size,
      orders: orders.length,
      since: since.toISOString(),
      ok: true,
    };
  } catch (e) {
    return {
      storeId,
      storeName,
      products: 0,
      orders: 0,
      since: since.toISOString(),
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** IDs of every active store in the org that has usable Shopify credentials. */
export async function listSyncableStoreIds(organizationId: string): Promise<string[]> {
  const stores = await prisma.store.findMany({
    where: {
      organizationId,
      active: true,
      shopifyDomain: { not: null },
      OR: [
        { shopifyToken: { not: null } },
        {
          AND: [
            { shopifyClientId: { not: null } },
            { shopifyClientSecret: { not: null } },
          ],
        },
      ],
    },
    select: { id: true },
    orderBy: { name: "asc" },
  });
  return stores.map((s) => s.id);
}

/** Sync every store in the org that has Shopify credentials. */
export async function syncAllStores(
  organizationId: string,
  opts: SyncOpts = {}
): Promise<SyncResult[]> {
  const ids = await listSyncableStoreIds(organizationId);
  const results: SyncResult[] = [];
  for (const id of ids) results.push(await syncStore(id, organizationId, opts));
  return results;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400000);
}
