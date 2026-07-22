import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { customRange, resolveRange, RangePreset, DEFAULT_TZ } from "@/lib/dates";
import { getSession } from "@/lib/auth";
import { shopifyProductUrl } from "@/lib/shopify";

export const dynamic = "force-dynamic";

// Full best-seller list (dashboard's "Top sản phẩm bán chạy" shows only 10):
// every product sold in the window, paginated, with per-product orders/units/
// revenue/COGS/traffic-source breakdown.
//
// Revenue = line value ex-tax (price × qty × (1 − taxRate)) — same basis as the
// dashboard's bestSellers card. COGS follows the store's cogsSource:
//   COST_PER_ITEM → Shopify unitCost × qty
//   RULE          → order-level % / per-order COGS rules spread over the order's
//                   lines by value share; else product.baseCost / per-unit rule.

type VariantAgg = {
  externalVariantId: string | null;
  variantTitle: string | null;
  sku: string | null;
  orderIds: Set<string>;
  orderLines: number;
  units: number;
  costedUnits: number;
  missingOrderLines: number;
  missingUnits: number;
  cogs: number;
  minUnitCost: number | null;
  maxUnitCost: number | null;
};

type Agg = {
  productId: string | null;
  storeId: string;
  title: string;
  image: string | null;
  storefrontUrl: string | null;
  missingBasecost: boolean;
  orders: number;
  units: number;
  revenue: number;
  cogs: number;
  variants: Map<string, VariantAgg>;
  channels: Map<string, number>; // channel → distinct orders
};

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const preset = (sp.get("preset") ?? "last30") as RangePreset;
  const from = sp.get("from");
  const to = sp.get("to");
  const isYMD = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const storeId = sp.get("storeId") || undefined;
  const q = (sp.get("q") ?? "").trim().toLowerCase();
  const sort = sp.get("sort") ?? "revenue"; // revenue | units | orders | cogs | profit
  const basecost = sp.get("basecost") ?? "all"; // all | missing | complete
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(sp.get("pageSize")) || 20));

  const timezone = DEFAULT_TZ;
  const range =
    isYMD(from) && isYMD(to)
      ? customRange(from, to, timezone)
      : resolveRange(preset, timezone);

  const storeFilter = storeId ? { storeId } : {};
  const [orders, rules, storeOptions] = await Promise.all([
    prisma.order.findMany({
      where: {
        organizationId: session.oid,
        date: { gte: range.start, lt: range.end },
        ...storeFilter,
      },
      select: {
        id: true,
        storeId: true,
        channel: true,
        store: {
          select: { taxRate: true, cogsSource: true, shopifyDomain: true },
        },
        lineItems: {
          select: {
            productId: true,
            externalVariantId: true,
            variantTitle: true,
            sku: true,
            title: true,
            image: true,
            quantity: true,
            price: true,
            unitCost: true,
            product: { select: { baseCost: true, image: true, handle: true } },
          },
        },
      },
    }),
    prisma.costRule.findMany({
      where: { organizationId: session.oid, active: true, type: "COGS" },
    }),
    prisma.store.findMany({
      where: { organizationId: session.oid, active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  // Mirrors computeVariableA: any order-level COGS rule suppresses the
  // baseCost/per-unit path (prevents double-count).
  const hasOrderLevelCogs = rules.some((r) => r.calcMethod !== "PER_UNIT");
  const perUnitRules = rules.filter((r) => r.calcMethod === "PER_UNIT");

  const map = new Map<string, Agg>();
  for (const o of orders) {
    const rate = o.store?.taxRate ?? 0;
    const useShopifyCost = o.store?.cogsSource === "COST_PER_ITEM";
    const channel = o.channel ?? "OTHER";
    const storeRules = rules.filter(
      (r) => r.storeId === null || r.storeId === o.storeId
    );
    const orderLineTotal = o.lineItems.reduce(
      (s, li) => s + li.price * li.quantity,
      0
    );
    // PER_ORDER COGS rules can't be tied to one product → spread by value share.
    const perOrderCogs = storeRules
      .filter((r) => r.calcMethod === "PER_ORDER")
      .reduce((s, r) => s + r.amount, 0);

    const seenThisOrder = new Set<string>();
    for (const li of o.lineItems) {
      const key = li.productId ?? `title:${li.title}`;
      const img = li.product?.image ?? li.image ?? null;
      const storefrontUrl = shopifyProductUrl(
        o.store?.shopifyDomain,
        li.product?.handle
      );
      const lineVal = li.price * li.quantity;

      let cogs = 0;
      // Custom charges such as Tip have no Product row and never need Basecost.
      const missingBasecost =
        useShopifyCost && !!li.productId && li.unitCost <= 0;
      if (useShopifyCost) {
        cogs = li.unitCost * li.quantity;
      } else if (hasOrderLevelCogs) {
        for (const r of storeRules) {
          if (r.calcMethod !== "PERCENT_OF_REVENUE") continue;
          if (r.productId !== null && r.productId !== li.productId) continue;
          cogs += r.amount * lineVal;
        }
        if (perOrderCogs > 0 && orderLineTotal > 0)
          cogs += perOrderCogs * (lineVal / orderLineTotal);
      } else {
        let unit = li.product?.baseCost ?? 0;
        if (unit <= 0) {
          const rule = perUnitRules.find(
            (r) =>
              (r.storeId === null || r.storeId === o.storeId) &&
              (r.productId === null || r.productId === li.productId)
          );
          unit = rule ? rule.amount : 0;
        }
        cogs = unit * li.quantity;
      }

      const cur =
        map.get(key) ??
        ({
          productId: li.productId,
          storeId: o.storeId,
          title: li.title,
          image: img,
          storefrontUrl,
          missingBasecost,
          orders: 0,
          units: 0,
          revenue: 0,
          cogs: 0,
          variants: new Map(),
          channels: new Map(),
        } as Agg);
      cur.units += li.quantity;
      cur.revenue += lineVal * (1 - rate);
      cur.cogs += cogs;
      if (!cur.image && img) cur.image = img;
      if (!cur.storefrontUrl && storefrontUrl) cur.storefrontUrl = storefrontUrl;
      if (missingBasecost) cur.missingBasecost = true;

      const variantKey = li.externalVariantId ?? `no-variant:${li.variantTitle ?? li.title}`;
      const variant =
        cur.variants.get(variantKey) ??
        ({
          externalVariantId: li.externalVariantId,
          variantTitle: li.variantTitle,
          sku: li.sku,
          orderIds: new Set(),
          orderLines: 0,
          units: 0,
          costedUnits: 0,
          missingOrderLines: 0,
          missingUnits: 0,
          cogs: 0,
          minUnitCost: null,
          maxUnitCost: null,
        } as VariantAgg);
      variant.orderIds.add(o.id);
      variant.orderLines += 1;
      variant.units += li.quantity;
      variant.cogs += cogs;
      if (!variant.variantTitle && li.variantTitle)
        variant.variantTitle = li.variantTitle;
      if (!variant.sku && li.sku) variant.sku = li.sku;
      if (missingBasecost) {
        variant.missingOrderLines += 1;
        variant.missingUnits += li.quantity;
      } else {
        const unitCost = useShopifyCost
          ? li.unitCost
          : li.quantity > 0
          ? cogs / li.quantity
          : 0;
        variant.costedUnits += li.quantity;
        variant.minUnitCost =
          variant.minUnitCost === null
            ? unitCost
            : Math.min(variant.minUnitCost, unitCost);
        variant.maxUnitCost =
          variant.maxUnitCost === null
            ? unitCost
            : Math.max(variant.maxUnitCost, unitCost);
      }
      cur.variants.set(variantKey, variant);
      // Count each order once per product (an order may repeat a product on
      // several lines — variants).
      if (!seenThisOrder.has(key)) {
        seenThisOrder.add(key);
        cur.orders += 1;
        cur.channels.set(channel, (cur.channels.get(channel) ?? 0) + 1);
      }
      map.set(key, cur);
    }
  }

  let rows = Array.from(map.values());
  if (q) rows = rows.filter((r) => r.title.toLowerCase().includes(q));
  if (basecost === "missing") rows = rows.filter((r) => r.missingBasecost);
  if (basecost === "complete") rows = rows.filter((r) => !r.missingBasecost);

  const summary = {
    products: rows.length,
    orders: rows.reduce((s, r) => s + r.orders, 0),
    units: rows.reduce((s, r) => s + r.units, 0),
    revenue: rows.reduce((s, r) => s + r.revenue, 0),
    cogs: rows.reduce((s, r) => s + r.cogs, 0),
  };

  const sortKey = (r: Agg) =>
    sort === "units"
      ? r.units
      : sort === "orders"
      ? r.orders
      : sort === "cogs"
      ? r.cogs
      : sort === "profit"
      ? r.revenue - r.cogs
      : r.revenue;
  rows.sort((a, b) => sortKey(b) - sortKey(a));

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows
    .slice((safePage - 1) * pageSize, safePage * pageSize)
    .map((r) => {
      const variants = Array.from(r.variants.values())
        .map((variant) => ({
          externalVariantId: variant.externalVariantId,
          variantTitle: variant.variantTitle,
          sku: variant.sku,
          orders: variant.orderIds.size,
          orderLines: variant.orderLines,
          units: variant.units,
          costedUnits: variant.costedUnits,
          missingOrderLines: variant.missingOrderLines,
          missingUnits: variant.missingUnits,
          cogs: variant.cogs,
          averageUnitCost:
            variant.costedUnits > 0
              ? variant.cogs / variant.costedUnits
              : 0,
          minUnitCost: variant.minUnitCost,
          maxUnitCost: variant.maxUnitCost,
        }))
        .sort(
          (a, b) =>
            Number(b.missingOrderLines > 0) - Number(a.missingOrderLines > 0) ||
            (a.variantTitle ?? a.externalVariantId ?? "").localeCompare(
              b.variantTitle ?? b.externalVariantId ?? ""
            )
        );
      return {
        productId: r.productId,
        storeId: r.storeId,
        title: r.title,
        image: r.image,
        storefrontUrl: r.storefrontUrl,
        missingBasecost: r.missingBasecost,
        variantCount: variants.length,
        missingVariants: variants.filter((variant) => variant.missingOrderLines > 0)
          .length,
        missingOrderLines: variants.reduce(
          (sum, variant) => sum + variant.missingOrderLines,
          0
        ),
        missingUnits: variants.reduce(
          (sum, variant) => sum + variant.missingUnits,
          0
        ),
        costedUnits: variants.reduce(
          (sum, variant) => sum + variant.costedUnits,
          0
        ),
        variants,
        orders: r.orders,
        units: r.units,
        revenue: r.revenue,
        cogs: r.cogs,
        grossProfit: r.revenue - r.cogs,
        channels: Array.from(r.channels.entries())
          .map(([channel, orders]) => ({ channel, orders }))
          .sort((a, b) => b.orders - a.orders),
      };
    });

  return NextResponse.json({
    timezone,
    range: { start: range.start, end: range.end, days: range.days },
    storeId: storeId ?? null,
    storeOptions,
    summary,
    total,
    totalPages,
    page: safePage,
    pageSize,
    rows: pageRows,
  });
}
