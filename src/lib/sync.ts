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
  ShopifyCreds,
  ShopifyOrderNorm,
} from "@/lib/shopify";

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
    for (const li of o.lineItems)
      if (li.externalProductId && !derived.has(li.externalProductId))
        derived.set(li.externalProductId, { title: li.title, image: li.image });

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
      // Refresh title/image only; never clobber a manually-set baseCost.
      update: { title: p.title, image: p.image },
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
    }));

    const common = {
      date: o.date,
      grossRevenue: o.grossRevenue,
      discounts: o.discounts,
      tax: o.tax,
      shippingCharged: o.shippingCharged,
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

// --- page-by-page sync (browser-driven) ------------------------------------

export interface SyncPageOpts extends SyncOpts {
  cursor?: string | null;
  useJourney?: boolean; // pass back what the server returned
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
  try {
    // On the first page (no cursor) also ask Shopify the total for an accurate bar.
    const total = opts.cursor ? null : await fetchOrdersCount(creds, since);

    const page = await fetchOrdersPage(
      creds,
      since,
      opts.cursor ?? null,
      opts.useJourney ?? true
    );
    const productMap = await upsertProductsFromOrders(page.orders, storeId, organizationId);
    await upsertOrders(page.orders, storeId, organizationId, productMap);

    // Mark the store synced when we've consumed the last page.
    if (!page.hasNext)
      await prisma.store.update({
        where: { id: storeId },
        data: { lastSyncedAt: new Date() },
      });

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
    const orders = await fetchOrdersSince(creds, since);
    const productMap = await upsertProductsFromOrders(orders, storeId, organizationId);
    await upsertOrders(orders, storeId, organizationId, productMap);
    await prisma.store.update({
      where: { id: storeId },
      data: { lastSyncedAt: new Date() },
    });
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
