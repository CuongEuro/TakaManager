// ---------------------------------------------------------------------------
// SYNC ORCHESTRATOR — pull Shopify products + orders into the DB (idempotent).
// Upserts by (storeId, externalId) so re-running never duplicates.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import {
  fetchAllProducts,
  fetchOrdersSince,
  ShopifyCreds,
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

export async function syncStore(
  storeId: string,
  organizationId: string,
  opts: { sinceDays?: number } = {}
): Promise<SyncResult> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store || store.organizationId !== organizationId)
    throw new Error("Store not found");
  if (!store.shopifyDomain || !store.shopifyToken) {
    return {
      storeId,
      storeName: store?.name ?? storeId,
      products: 0,
      orders: 0,
      since: "",
      ok: false,
      error: "Thiếu Shopify domain hoặc access token.",
    };
  }

  const creds: ShopifyCreds = {
    shopifyDomain: store.shopifyDomain,
    shopifyToken: store.shopifyToken,
    shopifyApiVersion: store.shopifyApiVersion,
  };

  // Determine "since": first sync = N days back; otherwise from last sync − 2 days.
  const since = opts.sinceDays
    ? daysAgo(opts.sinceDays)
    : store.lastSyncedAt
    ? new Date(store.lastSyncedAt.getTime() - 2 * 86400000)
    : daysAgo(60);

  try {
    // 1) Products → upsert, build externalId → internal id map.
    const products = await fetchAllProducts(creds);
    const productMap = new Map<string, string>();
    for (const p of products) {
      const saved = await prisma.product.upsert({
        where: { storeId_externalId: { storeId, externalId: p.externalId } },
        create: {
          organizationId,
          storeId,
          externalId: p.externalId,
          title: p.title,
          image: p.image,
          catalog: p.catalog,
          baseCost: p.baseCost,
        },
        update: {
          title: p.title,
          image: p.image,
          catalog: p.catalog,
          // only overwrite baseCost when Shopify provides a cost (>0)
          ...(p.baseCost > 0 ? { baseCost: p.baseCost } : {}),
        },
      });
      productMap.set(p.externalId, saved.id);
    }

    // 2) Orders → upsert, replacing line items each time.
    const orders = await fetchOrdersSince(creds, since);
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

      await prisma.order.upsert({
        where: { storeId_externalId: { storeId, externalId: o.externalId } },
        create: {
          organizationId,
          storeId,
          externalId: o.externalId,
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
          lineItems: { create: lineItemData },
        },
        update: {
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
          lineItems: { deleteMany: {}, create: lineItemData },
        },
      });
    }

    await prisma.store.update({
      where: { id: storeId },
      data: { lastSyncedAt: new Date() },
    });

    return {
      storeId,
      storeName: store.name,
      products: products.length,
      orders: orders.length,
      since: since.toISOString(),
      ok: true,
    };
  } catch (e) {
    return {
      storeId,
      storeName: store.name,
      products: 0,
      orders: 0,
      since: since.toISOString(),
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Sync every store in the org that has Shopify credentials. */
export async function syncAllStores(
  organizationId: string,
  opts: { sinceDays?: number } = {}
): Promise<SyncResult[]> {
  const stores = await prisma.store.findMany({
    where: { organizationId, active: true, shopifyToken: { not: null } },
    select: { id: true },
  });
  const results: SyncResult[] = [];
  for (const s of stores)
    results.push(await syncStore(s.id, organizationId, opts));
  return results;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400000);
}
