// ---------------------------------------------------------------------------
// SYNC ORCHESTRATOR — pull Shopify orders into the DB (idempotent).
// Products are derived from the order line items (title + image only) — we do
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
  fetchOrdersCount,
  fetchOrdersSince,
  fetchProductImages,
  fetchRefundsPage,
  fetchProductCosts,
  ShopifyCreds,
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

/** Derive minimal products (title+image) from a batch of orders and upsert them.
 *  Returns externalProductId → internal product id, to link line items. */
async function upsertProductsFromOrders(
  orders: ShopifyOrderNorm[],
  storeId: string,
  organizationId: string
): Promise<Map<string, string>> {
  const derived = new Map<string, { title: string; image: string | null }>();
  for (const o of orders)
    for (const li of o.lineItems) {
      if (!li.externalProductId) continue;
      const prev = derived.get(li.externalProductId);
      if (!prev) {
        derived.set(li.externalProductId, { title: li.title, image: li.image });
      } else if (!prev.image && li.image) {
        // keep the first non-null image we see for this product in the batch
        prev.image = li.image;
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
        // baseCost not pulled from Shopify → COGS comes from Cost Rules.
      },
      // Refresh title; only set image when we actually have one so a webhook
      // order (which carries no product image) never wipes a synced image.
      update: { title: p.title, ...(p.image ? { image: p.image } : {}) },
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
    const lineItemData = o.lineItems.map((li) => ({
      productId: li.externalProductId
        ? productMap.get(li.externalProductId) ?? null
        : null,
      title: li.title,
      image: li.image,
      quantity: li.quantity,
      price: li.price,
      unitCost: li.unitCost,
    }));

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

/** Backfill featured images for this store's products that are still missing one
 *  (e.g. products that only arrived via image-less webhook orders). Best-effort:
 *  capped per run and never fails the sync. Returns how many were filled. */
async function backfillStoreImages(
  storeId: string,
  organizationId: string,
  creds: ShopifyCreds
): Promise<number> {
  try {
    const missing = await prisma.product.findMany({
      where: { organizationId, storeId, image: null, externalId: { not: null } },
      select: { id: true, externalId: true },
      take: 250,
    });
    if (missing.length === 0) return 0;
    const imgs = await fetchProductImages(
      creds,
      missing.map((m) => m.externalId!).filter(Boolean)
    );
    let updated = 0;
    for (const m of missing) {
      const url = m.externalId ? imgs.get(m.externalId) : undefined;
      if (url) {
        await prisma.product.update({ where: { id: m.id }, data: { image: url } });
        updated++;
      }
    }
    return updated;
  } catch {
    return 0; // image backfill is non-critical
  }
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
    // On the first page (no cursor) also ask Shopify the total for an accurate bar.
    const total = opts.cursor ? null : await fetchOrdersCount(creds, since, until);

    const page = await fetchOrdersPage(
      creds,
      since,
      opts.cursor ?? null,
      opts.useJourney ?? true,
      until,
      store!.cogsSource === "COST_PER_ITEM" // pull Cost per item only if this store uses it
    );
    const productMap = await upsertProductsFromOrders(page.orders, storeId, organizationId);
    await upsertOrders(page.orders, storeId, organizationId, productMap);

    // On the last page, mark synced and backfill missing images — but only when
    // finalizing (the newest chunk), so a long chunked backfill doesn't repeat
    // the image backfill for every chunk.
    if (!page.hasNext && opts.finalize !== false) {
      await prisma.store.update({
        where: { id: storeId },
        data: { lastSyncedAt: new Date() },
      });
      await backfillStoreImages(storeId, organizationId, creds);
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
  opts: { start: Date; end: Date; storeId?: string; limit?: number }
): Promise<MissingBasecostReport> {
  const where = {
    unitCost: { lte: 0 },
    // Tips, donations and other custom order charges are not Shopify products,
    // cannot carry inventory Cost per item, and must not be reported as missing
    // product Basecost.
    productId: { not: null },
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

  try {
    // Distinct products that appear in this store's orders in the window.
    const grouped = await prisma.orderLineItem.groupBy({
      by: ["productId"],
      where: {
        productId: { not: null },
        order: { storeId, date: dateWindow },
      },
    });
    const pids = grouped.map((g) => g.productId).filter((x): x is string => !!x);
    // No orders in the window → nothing to patch (the UI turns products:0
    // into a "sync orders first" hint).
    if (pids.length === 0) {
      const missing = await findMissingBasecosts(organizationId, {
        start: winStart,
        end: winEnd,
        storeId,
      });
      return {
        ...base,
        ok: true,
        missingCount: missing.total,
        missingProducts: missing.items,
        missingTruncated: missing.truncated,
      };
    }

    const products = await prisma.product.findMany({
      where: { id: { in: pids }, externalId: { not: null } },
      select: { id: true, externalId: true },
    });
    const costMap = await fetchProductCosts(
      creds,
      products.map((p) => p.externalId!).filter(Boolean)
    );

    let updated = 0;
    for (const p of products) {
      const cost = p.externalId ? costMap.get(p.externalId) : undefined;
      if (cost == null || cost <= 0) continue;
      const res = await prisma.orderLineItem.updateMany({
        where: { productId: p.id, order: { storeId, date: dateWindow } },
        data: { unitCost: cost },
      });
      updated += res.count;
    }
    const missing = await findMissingBasecosts(organizationId, {
      start: winStart,
      end: winEnd,
      storeId,
    });
    return {
      ...base,
      ok: true,
      products: products.length,
      withCost: costMap.size,
      updated,
      missingCount: missing.total,
      missingProducts: missing.items,
      missingTruncated: missing.truncated,
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

/** Best-effort targeted cost refresh for a newly created/updated webhook order.
 * It avoids waiting for the hourly dashboard refresh or the daily cron. */
export async function syncOrderCosts(
  storeId: string,
  organizationId: string,
  orderExternalId: string
): Promise<number> {
  const { store, creds } = await storeCreds(storeId, organizationId);
  if (!creds || store?.cogsSource !== "COST_PER_ITEM") return 0;

  const order = await prisma.order.findFirst({
    where: { storeId, organizationId, externalId: orderExternalId },
    select: {
      id: true,
      lineItems: {
        where: { productId: { not: null } },
        select: {
          productId: true,
          product: { select: { externalId: true } },
        },
      },
    },
  });
  if (!order) return 0;

  const products = new Map<string, string>();
  for (const line of order.lineItems) {
    if (line.productId && line.product?.externalId)
      products.set(line.productId, line.product.externalId);
  }
  const costs = await fetchProductCosts(creds, [...products.values()]);
  let updated = 0;
  for (const [productId, externalId] of products) {
    const cost = costs.get(externalId);
    if (!cost || cost <= 0) continue;
    const result = await prisma.orderLineItem.updateMany({
      where: { orderId: order.id, productId },
      data: { unitCost: cost },
    });
    updated += result.count;
  }
  return updated;
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
    await backfillStoreImages(storeId, organizationId, creds);
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
