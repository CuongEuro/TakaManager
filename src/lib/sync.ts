// ---------------------------------------------------------------------------
// SYNC ORCHESTRATOR — pull Shopify orders into the DB (idempotent).
// Products are derived from the order line items (title + image only) — we do
// NOT fetch the full catalog, so syncs stay small/fast and need no read_inventory.
// Upserts by (storeId, externalId) so re-running never duplicates.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { fetchOrdersSince, ShopifyCreds } from "@/lib/shopify";

export interface SyncResult {
  storeId: string;
  storeName: string;
  products: number;
  orders: number;
  since: string;
  ok: boolean;
  error?: string;
}

export type SyncPhase =
  | "start"
  | "products_fetch"
  | "products_save"
  | "orders_fetch"
  | "orders_save"
  | "done"
  | "error";

export interface SyncProgress {
  storeId: string;
  storeName: string;
  phase: SyncPhase;
  percent: number; // 0..100 for this store
  message: string;
  products: number;
  orders: number;
  totalProducts?: number;
  totalOrders?: number;
}

export interface SyncOpts {
  sinceDays?: number;
  since?: Date; // explicit start date (overrides sinceDays)
  onProgress?: (p: SyncProgress) => void;
}

// Asymptotic progress for a fetch loop where the total is unknown: approaches
// `to` as pages accumulate without ever reaching it.
function fetchPct(from: number, to: number, page: number): number {
  return Math.round(from + (to - from) * (1 - Math.pow(0.6, page)));
}

export async function syncStore(
  storeId: string,
  organizationId: string,
  opts: SyncOpts = {}
): Promise<SyncResult> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store || store.organizationId !== organizationId)
    throw new Error("Store not found");
  const storeName = store.name;
  const emit = (p: Omit<SyncProgress, "storeId" | "storeName">) =>
    opts.onProgress?.({ storeId, storeName, ...p });

  const hasClientCreds = !!(store.shopifyClientId && store.shopifyClientSecret);
  if (!store.shopifyDomain || !(store.shopifyToken || hasClientCreds)) {
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

  const creds: ShopifyCreds = {
    shopifyDomain: store.shopifyDomain,
    shopifyClientId: store.shopifyClientId,
    shopifyClientSecret: store.shopifyClientSecret,
    shopifyToken: store.shopifyToken,
    shopifyApiVersion: store.shopifyApiVersion,
  };

  // Determine "since": explicit date > N days back > last sync − 2 days > 60d.
  const since = opts.since
    ? opts.since
    : opts.sinceDays
    ? daysAgo(opts.sinceDays)
    : store.lastSyncedAt
    ? new Date(store.lastSyncedAt.getTime() - 2 * 86400000)
    : daysAgo(7);

  emit({ phase: "start", percent: 2, message: "Đang kết nối Shopify…", products: 0, orders: 0 });

  try {
    // 1) Orders → fetch (5→45%). Everything we need (incl. each line's product
    //    title + image) comes from here; no separate catalog fetch.
    const orders = await fetchOrdersSince(creds, since, (count, page) =>
      emit({
        phase: "orders_fetch",
        percent: fetchPct(5, 45, page),
        message: `Đang tải đơn hàng… (${count})`,
        products: 0,
        orders: count,
      })
    );
    const totalOrders = orders.length;

    // 2) Products → derive distinct products (title + image) from line items and
    //    upsert (45→60%). Build externalId → internal id map to link line items.
    const derived = new Map<string, { title: string; image: string | null }>();
    for (const o of orders) {
      for (const li of o.lineItems) {
        if (li.externalProductId && !derived.has(li.externalProductId)) {
          derived.set(li.externalProductId, { title: li.title, image: li.image });
        }
      }
    }
    const totalProducts = derived.size;
    const productMap = new Map<string, string>();
    let pi = 0;
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
      productMap.set(externalId, saved.id);
      pi++;
      if (totalProducts && (pi % Math.max(1, Math.ceil(totalProducts / 15)) === 0 || pi === totalProducts)) {
        emit({
          phase: "products_save",
          percent: 45 + Math.round((15 * pi) / totalProducts),
          message: `Đang lưu sản phẩm… (${pi}/${totalProducts})`,
          products: pi,
          orders: totalOrders,
          totalProducts,
          totalOrders,
        });
      }
    }

    // 3) Orders → upsert (60→100%), replacing line items each time.
    let oi = 0;
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
      oi++;
      if (totalOrders && (oi % Math.max(1, Math.ceil(totalOrders / 25)) === 0 || oi === totalOrders)) {
        emit({
          phase: "orders_save",
          percent: 60 + Math.round((40 * oi) / totalOrders),
          message: `Đang lưu đơn hàng… (${oi}/${totalOrders})`,
          products: totalProducts,
          orders: oi,
          totalProducts,
          totalOrders,
        });
      }
    }

    await prisma.store.update({
      where: { id: storeId },
      data: { lastSyncedAt: new Date() },
    });

    emit({
      phase: "done",
      percent: 100,
      message: `Hoàn tất: ${totalProducts} sản phẩm, ${totalOrders} đơn.`,
      products: totalProducts,
      orders: totalOrders,
      totalProducts,
      totalOrders,
    });

    return {
      storeId,
      storeName,
      products: totalProducts,
      orders: totalOrders,
      since: since.toISOString(),
      ok: true,
    };
  } catch (e) {
    emit({
      phase: "error",
      percent: 100,
      message: e instanceof Error ? e.message : String(e),
      products: 0,
      orders: 0,
    });
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
