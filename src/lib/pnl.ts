// ---------------------------------------------------------------------------
// P&L ENGINE — turns raw costs + revenue into profit per store / product / day.
// Pure-ish: fetches data for a [start, end) range, computes everything in memory.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { isoDay, DEFAULT_TZ, proratePeriodic } from "@/lib/dates";

export interface PnlInput {
  organizationId: string; // tenant scope (required)
  start: Date;
  end: Date; // exclusive
  storeId?: string | null; // null/undefined = all stores
  timezone?: string; // IANA tz for daily bucketing (default Asia/Tokyo)
}

export interface RevenueBlock {
  grossSales: number; // product subtotal before discount & tax
  discounts: number;
  netSales: number; // grossSales - discounts (pre-tax revenue)
  tax: number; // pass-through, excluded from profit
  shippingCharged: number; // shipping paid by customers
  refunded: number; // total refunded to customers (incl tax), already netted out
  revenue: number; // netSales + shippingCharged (revenue base for profit, ex-tax)
  totalCollected: number; // revenue + tax (what customers actually paid, net of refunds)
}

export interface PnlResult {
  revenue: RevenueBlock;
  orders: { count: number; units: number; aov: number };
  variableA: { total: number; byType: Record<string, number> };
  variableB: {
    total: number;
    byPlatform: Record<string, number>;
    attributedRevenue: number;
    impressions: number;
    clicks: number;
    conversions: number;
  };
  fixed: { total: number; byCategory: Record<string, number> };
  profit: {
    grossProfit: number; // revenue - variableA
    contribution: number; // revenue - variableA - variableB
    netProfit: number; // contribution - fixed
    grossMargin: number; // grossProfit / revenue
    netMargin: number; // netProfit / revenue
  };
  metrics: {
    roas: number; // attributedRevenue / adSpend
    mer: number; // revenue / adSpend (marketing efficiency ratio)
    cpa: number; // adSpend / orders
    breakEvenRoas: number; // MER needed to cover variable costs (before fixed)
    profitPerOrder: number;
  };
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD
  revenue: number;
  adSpend: number;
  netProfit: number;
}

export interface StoreRow {
  storeId: string;
  storeName: string;
  revenue: number;
  adSpend: number;
  netProfit: number;
  netMargin: number;
  roas: number;
}

export interface BestSeller {
  productId: string | null;
  title: string;
  image: string | null;
  orders: number;
  units: number;
  revenue: number;
}

export interface ChannelRow {
  channel: string; // traffic source (FACEBOOK | GOOGLE | ... | OTHER)
  orders: number;
  units: number;
  revenue: number;
}

export interface CatalogRow {
  catalog: string;
  orders: number;
  units: number;
  revenue: number;
}

export interface ChannelEfficiencyRow {
  channel: string;
  isPaid: boolean; // has measurable ad spend
  spend: number; // ad spend on the matching platform
  revenue: number; // Shopify order revenue attributed to this channel
  orders: number;
  roas: number; // revenue / spend (true blended ROAS by channel)
  cpa: number; // spend / orders
}

export interface DashboardData {
  summary: PnlResult;
  daily: DailyPoint[];
  stores: StoreRow[];
  bestSellers: BestSeller[];
  channels: ChannelRow[];
  catalogs: CatalogRow[];
  channelEfficiency: ChannelEfficiencyRow[];
}

// --- helpers --------------------------------------------------------------

type OrderWithItems = {
  id: string;
  storeId: string;
  date: Date;
  grossRevenue: number;
  discounts: number;
  tax: number;
  shippingCharged: number;
  refunded: number; // total refunded to customer (incl tax)
  channel: string | null;
  // Prices on Shopify are tax-inclusive (JP 税込); back out tax per the store's
  // rate. null store → 0 (no back-out).
  store: { taxRate: number } | null;
  lineItems: {
    productId: string | null;
    title: string;
    image: string | null;
    quantity: number;
    price: number;
    product: { baseCost: number; catalog: string | null; image: string | null } | null;
  }[];
};

type Rule = {
  storeId: string | null;
  productId: string | null;
  type: string;
  calcMethod: string;
  amount: number;
  active: boolean;
};

/** Net amount the customer paid, one order = product net + shipping − refunds.
 *  Prices are 税込 so this already includes the consumption tax. */
function orderCollected(o: OrderWithItems): number {
  return o.grossRevenue - o.discounts + o.shippingCharged - o.refunded;
}

/** Consumption tax to remit for one order: a FLAT rate (the store's taxRate) on
 *  the amount collected. The business must remit 10% on the total taken,
 *  regardless of Shopify's line-level tax (which varies with tax-exempt items /
 *  discounts), so we use the fixed rate, not Shopify's tax field. */
function orderTax(o: OrderWithItems): number {
  const rate = o.store?.taxRate ?? 0;
  return orderCollected(o) * rate;
}

/** Ex-tax (net) revenue for one order = what the customer paid minus tax. */
function orderRevenue(o: OrderWithItems): number {
  return orderCollected(o) - orderTax(o);
}

/** Variable A breakdown for a set of orders given the cost rules. */
function computeVariableA(orders: OrderWithItems[], rules: Rule[]) {
  const byType: Record<string, number> = {};
  const add = (type: string, v: number) => {
    byType[type] = (byType[type] ?? 0) + v;
  };

  const activeRules = rules.filter((r) => r.active);
  const cogsPerUnitRules = activeRules.filter(
    (r) => r.type === "COGS" && r.calcMethod === "PER_UNIT"
  );

  for (const o of orders) {
    const units = o.lineItems.reduce((s, li) => s + li.quantity, 0);
    // % rules apply to the total the customer paid (incl tax, net of refunds) —
    // "tổng khách đã trả", not the ex-tax revenue.
    const pctBase = orderCollected(o);

    // COGS: prefer product.baseCost; else a matching per-unit COGS rule.
    for (const li of o.lineItems) {
      let unitCost = li.product?.baseCost ?? 0;
      if (unitCost <= 0) {
        const rule = cogsPerUnitRules.find(
          (r) =>
            (r.storeId === null || r.storeId === o.storeId) &&
            (r.productId === null || r.productId === li.productId)
        );
        unitCost = rule ? rule.amount : 0;
      }
      add("COGS", unitCost * li.quantity);
    }

    // All other rules (and non-per-unit COGS) applicable to this order's store.
    for (const r of activeRules) {
      if (r.type === "COGS" && r.calcMethod === "PER_UNIT") continue; // done above
      if (r.storeId !== null && r.storeId !== o.storeId) continue;

      if (r.calcMethod === "PER_ORDER") {
        add(r.type, r.amount);
      } else if (r.calcMethod === "PER_UNIT") {
        const u =
          r.productId === null
            ? units
            : o.lineItems
                .filter((li) => li.productId === r.productId)
                .reduce((s, li) => s + li.quantity, 0);
        add(r.type, r.amount * u);
      } else if (r.calcMethod === "PERCENT_OF_REVENUE") {
        const base =
          r.productId === null
            ? pctBase
            : o.lineItems
                .filter((li) => li.productId === r.productId)
                .reduce((s, li) => s + li.price * li.quantity, 0);
        add(r.type, r.amount * base);
      }
    }
  }

  const total = Object.values(byType).reduce((s, v) => s + v, 0);
  return { total, byType };
}

// --- main -----------------------------------------------------------------

export async function computeDashboard(
  input: PnlInput
): Promise<DashboardData> {
  const { organizationId, start, end, storeId } = input;
  const tz = input.timezone ?? DEFAULT_TZ;
  const storeFilter = storeId ? { storeId } : {};

  const [orders, rules, adSpends, fixedCosts, allStores] = await Promise.all([
    prisma.order.findMany({
      where: { organizationId, date: { gte: start, lt: end }, ...storeFilter },
      include: {
        lineItems: { include: { product: true } },
        store: { select: { taxRate: true } },
      },
    }),
    prisma.costRule.findMany({ where: { organizationId, active: true } }),
    prisma.adSpend.findMany({
      where: { organizationId, date: { gte: start, lt: end }, ...storeFilter },
    }),
    prisma.fixedCost.findMany({
      where: {
        organizationId,
        startDate: { lt: end },
        OR: [{ endDate: null }, { endDate: { gt: start } }],
      },
    }),
    prisma.store.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    }),
  ]);

  const summary = buildPnl({
    start,
    end,
    storeId: storeId ?? null,
    timezone: tz,
    orders,
    rules,
    adSpends,
    fixedCosts,
    allOrdersForShare: storeId
      ? await prisma.order.findMany({
          where: { organizationId, date: { gte: start, lt: end } },
          select: {
            grossRevenue: true,
            discounts: true,
            shippingCharged: true,
            refunded: true,
            store: { select: { taxRate: true } },
          },
        })
      : null,
  });

  const daily = buildDailySeries(start, end, orders, adSpends, rules, fixedCosts, storeId ?? null, summary.fixed.total, tz);
  const stores = buildStoreBreakdown(allStores, orders, adSpends, rules);
  const bestSellers = buildBestSellers(orders);
  const channels = buildChannelBreakdown(orders);
  const catalogs = buildCatalogBreakdown(orders);
  const channelEfficiency = buildChannelEfficiency(channels, adSpends);

  return {
    summary,
    daily,
    stores,
    bestSellers,
    channels,
    catalogs,
    channelEfficiency,
  };
}

/**
 * Pair Shopify revenue-by-channel with ad-spend-by-platform → ROAS per channel.
 * Platform↔channel match is by identity (FACEBOOK/GOOGLE/TWITTER). Non-paid
 * channels (Klaviyo/Direct/Organic) appear with spend 0.
 */
function buildChannelEfficiency(
  channels: ChannelRow[],
  adSpends: { platform: string; spend: number }[]
): ChannelEfficiencyRow[] {
  const spendByPlatform: Record<string, number> = {};
  for (const a of adSpends)
    spendByPlatform[a.platform] = (spendByPlatform[a.platform] ?? 0) + a.spend;

  const revByChannel: Record<string, { revenue: number; orders: number }> = {};
  for (const c of channels)
    revByChannel[c.channel] = { revenue: c.revenue, orders: c.orders };

  const keys = new Set<string>([
    ...Object.keys(spendByPlatform),
    ...Object.keys(revByChannel),
  ]);

  const rows: ChannelEfficiencyRow[] = [];
  for (const k of keys) {
    const spend = spendByPlatform[k] ?? 0;
    const revenue = revByChannel[k]?.revenue ?? 0;
    const orders = revByChannel[k]?.orders ?? 0;
    rows.push({
      channel: k,
      isPaid: spend > 0,
      spend,
      revenue,
      orders,
      roas: spend > 0 ? revenue / spend : 0,
      cpa: orders > 0 ? spend / orders : 0,
    });
  }
  return rows.sort((a, b) => b.spend - a.spend || b.revenue - a.revenue);
}

function buildChannelBreakdown(orders: OrderWithItems[]): ChannelRow[] {
  const map = new Map<string, ChannelRow>();
  for (const o of orders) {
    const key = o.channel ?? "OTHER";
    const cur =
      map.get(key) ?? ({ channel: key, orders: 0, units: 0, revenue: 0 } as ChannelRow);
    cur.orders += 1;
    cur.units += o.lineItems.reduce((s, li) => s + li.quantity, 0);
    cur.revenue += orderRevenue(o);
    map.set(key, cur);
  }
  return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
}

function buildCatalogBreakdown(orders: OrderWithItems[]): CatalogRow[] {
  const map = new Map<string, CatalogRow>();
  const seen = new Map<string, Set<string>>(); // catalog -> order ids (distinct order count)
  for (const o of orders) {
    for (const li of o.lineItems) {
      const key = li.product?.catalog ?? "Khác / Chưa rõ";
      const cur =
        map.get(key) ?? ({ catalog: key, orders: 0, units: 0, revenue: 0 } as CatalogRow);
      cur.units += li.quantity;
      cur.revenue += li.price * li.quantity * (1 - (o.store?.taxRate ?? 0));
      map.set(key, cur);
      const ids = seen.get(key) ?? new Set<string>();
      ids.add(o.id);
      seen.set(key, ids);
    }
  }
  for (const [key, ids] of seen) {
    const row = map.get(key);
    if (row) row.orders = ids.size;
  }
  return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
}

function buildPnl(args: {
  start: Date;
  end: Date;
  storeId: string | null;
  orders: OrderWithItems[];
  rules: Rule[];
  adSpends: {
    platform: string;
    spend: number;
    revenue: number;
    impressions: number;
    clicks: number;
    conversions: number;
  }[];
  fixedCosts: {
    storeId: string | null;
    category: string;
    amount: number;
    billingCycle: string;
    startDate: Date;
    endDate: Date | null;
  }[];
  allOrdersForShare:
    | {
        grossRevenue: number;
        discounts: number;
        shippingCharged: number;
        refunded: number;
        store: { taxRate: number } | null;
      }[]
    | null;
  timezone?: string;
}): PnlResult {
  const { start, end, storeId, orders, rules, adSpends, fixedCosts } = args;
  const tz = args.timezone ?? DEFAULT_TZ;

  // Revenue. Tax to remit is a FLAT rate (store taxRate) on the amount collected
  // — the business owes 10% on total taken regardless of Shopify's variable
  // line-level tax. revenue is ex-tax (profit base) = collected × (1 − rate);
  // totalCollected = what customers actually paid (net of refunds).
  const grossSales = sum(orders, (o) => o.grossRevenue);
  const discounts = sum(orders, (o) => o.discounts);
  const shippingCharged = sum(orders, (o) => o.shippingCharged);
  const refunded = sum(orders, (o) => o.refunded); // returns (incl tax)
  const totalCollected = sum(orders, orderCollected); // customer paid, net of refunds
  const tax = sum(orders, orderTax); // consumption tax to remit
  const revenue = totalCollected - tax; // ex-tax revenue base
  const netSales = revenue - shippingCharged; // ex-tax product revenue (approx)
  const units = orders.reduce(
    (s, o) => s + o.lineItems.reduce((a, li) => a + li.quantity, 0),
    0
  );
  const orderCount = orders.length;

  // Variable A
  const variableA = computeVariableA(orders, rules);

  // Variable B
  const adByPlatform: Record<string, number> = {};
  let adTotal = 0,
    attributedRevenue = 0,
    impressions = 0,
    clicks = 0,
    conversions = 0;
  for (const a of adSpends) {
    adByPlatform[a.platform] = (adByPlatform[a.platform] ?? 0) + a.spend;
    adTotal += a.spend;
    attributedRevenue += a.revenue;
    impressions += a.impressions;
    clicks += a.clicks;
    conversions += a.conversions;
  }

  // Fixed costs (prorated to range). For a single store, allocate company-wide
  // (storeId null) fixed costs by this store's revenue share.
  let revenueShare = 1;
  if (storeId && args.allOrdersForShare) {
    const totalRev = args.allOrdersForShare.reduce(
      (s, o) =>
        s +
        (o.grossRevenue - o.discounts + o.shippingCharged - o.refunded) *
          (1 - (o.store?.taxRate ?? 0)),
      0
    );
    revenueShare = totalRev > 0 ? revenue / totalRev : 0;
  }

  const fixedByCategory: Record<string, number> = {};
  for (const fc of fixedCosts) {
    if (storeId && fc.storeId && fc.storeId !== storeId) continue;
    let amount: number;
    if (fc.billingCycle === "ONE_TIME") {
      amount =
        fc.startDate >= start && fc.startDate < end ? fc.amount : 0;
    } else {
      // Prorate over the overlap of the range and the cost's active window,
      // dividing by each day's REAL month/year length (e.g. /28, /30, /31).
      const s = Math.max(start.getTime(), fc.startDate.getTime());
      const e = Math.min(end.getTime(), (fc.endDate ?? end).getTime());
      amount =
        e > s
          ? proratePeriodic(
              fc.amount,
              fc.billingCycle === "YEARLY" ? "YEARLY" : "MONTHLY",
              new Date(s),
              new Date(e),
              tz
            )
          : 0;
    }
    // allocate shared (company-wide) fixed costs by revenue share for store view
    if (storeId && fc.storeId === null) amount *= revenueShare;
    fixedByCategory[fc.category] = (fixedByCategory[fc.category] ?? 0) + amount;
  }
  const fixedTotal = Object.values(fixedByCategory).reduce((s, v) => s + v, 0);

  // Profit
  const grossProfit = revenue - variableA.total;
  const contribution = grossProfit - adTotal;
  const netProfit = contribution - fixedTotal;

  return {
    revenue: {
      grossSales,
      discounts,
      netSales,
      tax,
      shippingCharged,
      refunded,
      revenue,
      totalCollected,
    },
    orders: {
      count: orderCount,
      units,
      aov: orderCount > 0 ? revenue / orderCount : 0,
    },
    variableA,
    variableB: {
      total: adTotal,
      byPlatform: adByPlatform,
      attributedRevenue,
      impressions,
      clicks,
      conversions,
    },
    fixed: { total: fixedTotal, byCategory: fixedByCategory },
    profit: {
      grossProfit,
      contribution,
      netProfit,
      grossMargin: revenue > 0 ? grossProfit / revenue : 0,
      netMargin: revenue > 0 ? netProfit / revenue : 0,
    },
    metrics: {
      roas: adTotal > 0 ? attributedRevenue / adTotal : 0,
      mer: adTotal > 0 ? revenue / adTotal : 0,
      cpa: orderCount > 0 ? adTotal / orderCount : 0,
      breakEvenRoas: grossProfit > 0 ? revenue / grossProfit : 0,
      profitPerOrder: orderCount > 0 ? netProfit / orderCount : 0,
    },
  };
}

function buildDailySeries(
  start: Date,
  end: Date,
  orders: OrderWithItems[],
  adSpends: { date: Date; spend: number }[],
  rules: Rule[],
  _fixedCosts: unknown,
  _storeId: string | null,
  fixedTotal: number,
  tz: string = DEFAULT_TZ
): DailyPoint[] {
  // bucket by day (in the store timezone)
  const days: string[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += 86400000) {
    days.push(isoDay(new Date(t), tz));
  }
  const fixedPerDay = days.length > 0 ? fixedTotal / days.length : 0;

  const map: Record<string, DailyPoint> = {};
  for (const d of days)
    map[d] = { date: d, revenue: 0, adSpend: 0, netProfit: 0 };

  // group orders by day to compute variable A per day
  const ordersByDay: Record<string, OrderWithItems[]> = {};
  for (const o of orders) {
    const d = isoDay(o.date, tz);
    (ordersByDay[d] ??= []).push(o);
  }
  for (const d of Object.keys(ordersByDay)) {
    if (!map[d]) continue;
    const dayOrders = ordersByDay[d];
    const rev = dayOrders.reduce((s, o) => s + orderRevenue(o), 0);
    const varA = computeVariableA(dayOrders, rules).total;
    map[d].revenue = rev;
    map[d].netProfit = rev - varA; // ads & fixed subtracted below
  }
  for (const a of adSpends) {
    const d = isoDay(a.date, tz);
    if (!map[d]) continue;
    map[d].adSpend += a.spend;
  }
  for (const d of days) {
    map[d].netProfit -= map[d].adSpend + fixedPerDay;
  }

  return days.map((d) => map[d]);
}

function buildStoreBreakdown(
  stores: { id: string; name: string }[],
  orders: OrderWithItems[],
  adSpends: { storeId: string | null; spend: number; revenue: number }[],
  rules: Rule[]
): StoreRow[] {
  const rows: StoreRow[] = [];
  for (const s of stores) {
    const sOrders = orders.filter((o) => o.storeId === s.id);
    if (sOrders.length === 0 && !adSpends.some((a) => a.storeId === s.id))
      continue;
    const revenue = sOrders.reduce((acc, o) => acc + orderRevenue(o), 0);
    const varA = computeVariableA(sOrders, rules).total;
    const adSpend = adSpends
      .filter((a) => a.storeId === s.id)
      .reduce((acc, a) => acc + a.spend, 0);
    const attributed = adSpends
      .filter((a) => a.storeId === s.id)
      .reduce((acc, a) => acc + a.revenue, 0);
    const netProfit = revenue - varA - adSpend; // store view excludes shared fixed
    rows.push({
      storeId: s.id,
      storeName: s.name,
      revenue,
      adSpend,
      netProfit,
      netMargin: revenue > 0 ? netProfit / revenue : 0,
      roas: adSpend > 0 ? attributed / adSpend : 0,
    });
  }
  return rows.sort((a, b) => b.revenue - a.revenue);
}

function buildBestSellers(orders: OrderWithItems[]): BestSeller[] {
  const map = new Map<string, BestSeller>();
  for (const o of orders) {
    for (const li of o.lineItems) {
      const key = li.productId ?? `title:${li.title}`;
      // line-item image (may be null on webhook orders) → fall back to the
      // product's stored featured image.
      const img = li.image ?? li.product?.image ?? null;
      const cur =
        map.get(key) ??
        ({
          productId: li.productId,
          title: li.title,
          image: img,
          orders: 0,
          units: 0,
          revenue: 0,
        } as BestSeller);
      cur.units += li.quantity;
      cur.revenue += li.price * li.quantity * (1 - (o.store?.taxRate ?? 0));
      cur.orders += 1;
      if (!cur.image && img) cur.image = img;
      map.set(key, cur);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);
}

function sum<T>(arr: T[], f: (x: T) => number): number {
  return arr.reduce((s, x) => s + f(x), 0);
}
