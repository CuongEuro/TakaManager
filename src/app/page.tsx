"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import type { DashboardData } from "@/lib/pnl";
import { DateRangePicker, DateRange } from "@/components/DateRangePicker";
import {
  COST_RULE_TYPE_LABELS,
  FIXED_COST_CATEGORY_LABELS,
  AD_PLATFORM_LABELS,
  ORDER_CHANNEL_LABELS,
} from "@/lib/constants";
import {
  formatJPY,
  formatNumber,
  formatPercent,
  formatMultiplier,
} from "@/lib/format";
import { Card, StatCard, PageHeader, Select, EmptyState, Badge } from "@/components/ui";
import { DashboardChart } from "@/components/DashboardChart";
import { ChannelEfficiencyTrendChart } from "@/components/ChannelEfficiencyTrendChart";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { calendarDateInTimeZone, calendarYMD, DEFAULT_TZ } from "@/lib/dates";
import type { MissingBasecostItem } from "@/lib/sync";

interface DashboardResponse extends DashboardData {
  storeId: string | null;
  storeOptions: { id: string; name: string }[];
  missingBasecost: {
    total: number;
    items: MissingBasecostItem[];
    truncated: boolean;
  };
}

// Human labels for the COGS-source breakdown (PnlResult.variableA.cogsBy).
const COGS_SOURCE_LABELS: Record<string, string> = {
  UNIT_COST: "từ Cost per item (Shopify)",
  RULE_PCT: "từ quy tắc % Biến đổi A",
  RULE_PER_ORDER: "từ quy tắc mỗi đơn",
  BASE_COST: "từ baseCost sản phẩm / quy tắc mỗi cái",
};

// Parse a fetch response as JSON without crashing on non-JSON bodies — a
// timed-out serverless function (504) returns an HTML/text error page, and
// `res.json()` on that throws a cryptic "Unexpected token" instead of a
// message the user can act on.
async function safeJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {
      error:
        res.status === 504
          ? "Quá thời gian chờ (504) — quá nhiều dữ liệu để xử lý trong 1 lần. Thử lại hoặc chọn khoảng ngày ngắn hơn."
          : `Máy chủ lỗi (HTTP ${res.status}).`,
    };
  }
}

export default function DashboardPage() {
  // Default to "today" (single-day range) on open.
  const [range, setRange] = useState<DateRange>(() => {
    const today = calendarDateInTimeZone();
    return { from: today, to: today };
  });
  const [storeId, setStoreId] = useState<string>("");
  const [productsPage, setProductsPage] = useState(1);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingAds, setRefreshingAds] = useState(false);
  const [refreshingCosts, setRefreshingCosts] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  const loadDashboard = useCallback(async (): Promise<DashboardResponse> => {
    const params = new URLSearchParams({
      from: calendarYMD(range.from),
      to: calendarYMD(range.to),
    });
    if (storeId) params.set("storeId", storeId);
    params.set("productsPage", String(productsPage));
    const r = await fetch(`/api/dashboard?${params}`);
    return r.json();
  }, [range, storeId, productsPage]);

  // Load dashboard data whenever range/store changes (no ad refresh here).
  useEffect(() => {
    let active = true;
    setLoading(true);
    loadDashboard()
      .then((d) => active && setData(d))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [loadDashboard]);

  // Refresh ad spend (server-throttled), then silently reload the dashboard.
  // force=true bypasses the server throttle (manual button).
  const doAdsRefresh = useCallback(
    async (force: boolean) => {
      setRefreshingAds(true);
      try {
        const r = await fetch("/api/ads/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(force ? { force: true } : {}),
        }).then(safeJson);
        try {
          localStorage.setItem("taka:ads-last-refresh", String(Date.now()));
        } catch {
          /* ignore quota */
        }
        if (force)
          setRefreshMsg(
            r.error
              ? `⚠ Cập nhật Ads lỗi: ${r.error}`
              : `✓ Đã cập nhật Ads (${r.ok ?? 0}/${r.refreshed ?? 0} tài khoản).`
          );
        if (force || (Number(r.ok) || 0) > 0) setData(await loadDashboard());
      } catch (e) {
        if (force)
          setRefreshMsg(
            `⚠ Cập nhật Ads lỗi: ${e instanceof Error ? e.message : String(e)}`
          );
      } finally {
        setRefreshingAds(false);
      }
    },
    [loadDashboard]
  );

  // Auto-refresh ads at most ONCE PER HOUR (only when viewing a window that
  // includes today). Checks on open and every 5 min while the tab stays open.
  useEffect(() => {
    const HOUR = 3600_000;
    const check = () => {
      if (calendarYMD(range.to) !== calendarYMD(calendarDateInTimeZone())) return;
      const last = Number(localStorage.getItem("taka:ads-last-refresh") || 0);
      if (Date.now() - last >= HOUR) doAdsRefresh(false);
    };
    check();
    const id = setInterval(check, 5 * 60_000);
    return () => clearInterval(id);
  }, [doAdsRefresh, range]);

  // Hourly Shopify refresh (returns + Cost per item, last 2 days by
  // updated_at) — same cadence as ads. Runs for ANY viewed range: a refund
  // issued today changes the ORDER's day, so historical views benefit too.
  // force=true (manual button) always reloads + stamps localStorage so the
  // hourly auto-check doesn't immediately fire again right after.
  const doShopifyRefresh = useCallback(
    async (force = false) => {
      if (force) setRefreshingCosts(true);
      try {
        const r = await fetch("/api/shopify/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            force
              ? {
                  from: calendarYMD(range.from),
                  to: calendarYMD(range.to),
                  ...(storeId ? { storeId } : {}),
                }
              : {}
          ),
        }).then(safeJson);
        try {
          localStorage.setItem("taka:shopify-last-refresh", String(Date.now()));
        } catch {
          /* ignore quota */
        }
        if (force) {
          const errors = Array.isArray(r.errors) ? (r.errors as string[]) : [];
          let costsUpdated = Number(r.costsUpdated) || 0;
          let missingCount = Number(r.missingCount) || 0;
          const costBatches = Array.isArray(r.costBatches)
            ? (r.costBatches as {
                storeId?: unknown;
                hasNext?: unknown;
                nextCursor?: unknown;
              }[])
            : [];

          // The first refresh handles refunds and one small Basecost batch.
          // Continue remaining batches from the browser so each request stays
          // comfortably below the serverless timeout for large stores.
          for (const batch of costBatches) {
            if (!batch.hasNext) continue;
            if (
              typeof batch.storeId !== "string" ||
              typeof batch.nextCursor !== "string" ||
              !batch.nextCursor
            ) {
              errors.push("Thiếu con trỏ để tiếp tục cập nhật Basecost.");
              continue;
            }
            let cursor = batch.nextCursor;
            for (let page = 0; page < 500; page++) {
              const next = await fetch("/api/shopify/costs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  storeId: batch.storeId,
                  from: calendarYMD(range.from),
                  to: calendarYMD(range.to),
                  cursor,
                  limit: 10,
                }),
              }).then(safeJson);
              if (!next.ok) {
                errors.push(String(next.error || "Không thể cập nhật Basecost."));
                break;
              }
              costsUpdated += Number(next.updated) || 0;
              if (!next.hasNext) {
                missingCount += Number(next.missingCount) || 0;
                break;
              }
              if (typeof next.nextCursor !== "string" || !next.nextCursor) {
                errors.push("Thiếu con trỏ để tiếp tục cập nhật Basecost.");
                break;
              }
              cursor = next.nextCursor;
            }
          }
          setRefreshMsg(
            r.error
              ? `⚠ Cập nhật Basecost lỗi: ${r.error}`
              : errors.length > 0
              ? `⚠ ${errors.join(" · ")}`
              : missingCount > 0
              ? `⚠ Đã cập nhật Basecost, còn ${missingCount} sản phẩm chưa có Cost per item.`
              : `✓ Đã cập nhật ${costsUpdated} dòng giá vốn, ${
                  r.refundsUpdated ?? 0
                } hoàn tiền (${r.stores ?? 0} store).`
          );
        }
        if (force || (Number(r.refundsUpdated) || 0) > 0 || (Number(r.costsUpdated) || 0) > 0)
          setData(await loadDashboard());
      } catch (e) {
        if (force)
          setRefreshMsg(
            `⚠ Cập nhật Basecost lỗi: ${e instanceof Error ? e.message : String(e)}`
          );
      } finally {
        if (force) setRefreshingCosts(false);
      }
    },
    [loadDashboard, range, storeId]
  );
  useAutoRefresh("taka:shopify-last-refresh", doShopifyRefresh);

  const refreshAdsNow = () => doAdsRefresh(true);
  const refreshCostsNow = () => doShopifyRefresh(true);

  const s = data?.summary;
  const netTone = s && s.profit.netProfit >= 0 ? "good" : "bad";
  const channelMax = Math.max(1, ...(data?.channels?.map((c) => c.revenue) ?? []));
  // Effective % of the total the customer paid (base for % cost rules).
  const collectedBase = s?.revenue.totalCollected ?? 0;
  const pctOfCollected = (v: number) =>
    collectedBase > 0 ? `${((v / collectedBase) * 100).toFixed(1)}%` : "—";
  // Deep link to the full best-seller list, carrying the current range + store.
  const productsHref = `/products?from=${calendarYMD(range.from)}&to=${calendarYMD(
    range.to
  )}${storeId ? `&storeId=${storeId}` : ""}`;

  return (
    <div>
      <PageHeader
        title="Dashboard Lợi nhuận"
        subtitle={`Tổng quan doanh thu, chi phí & lợi nhuận theo thời gian — múi giờ ${DEFAULT_TZ} (GMT+9).`}
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <DateRangePicker
              value={range}
              onChange={(value) => {
                setRange(value);
                setProductsPage(1);
              }}
            />
            <button
              onClick={refreshAdsNow}
              disabled={refreshingAds}
              title="Tự cập nhật tối đa 1 lần/giờ. Bấm để kéo lại chi phí Ads hôm nay ngay bây giờ."
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {refreshingAds ? "Đang cập nhật Ads…" : "🔄 Cập nhật Ads"}
            </button>
            <button
              onClick={refreshCostsNow}
              disabled={refreshingCosts}
              title="Chỉ truy vấn và bổ sung Basecost còn thiếu trong khoảng ngày đang chọn; không ghi đè chi phí đã lưu."
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {refreshingCosts ? "Đang cập nhật Basecost…" : "🔄 Cập nhật Basecost"}
            </button>
            <div className="w-full sm:w-44">
              <Select
                value={storeId}
                onChange={(e) => {
                  setStoreId(e.target.value);
                  setProductsPage(1);
                }}
              >
                <option value="">Tất cả store</option>
                {data?.storeOptions.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        }
      />

      {refreshMsg && (
        <div
          className={`mb-4 rounded-lg px-4 py-2 text-sm ${
            refreshMsg.startsWith("⚠")
              ? "bg-rose-50 text-rose-700"
              : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {refreshMsg}
        </div>
      )}

      {data?.missingBasecost && data.missingBasecost.total > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-semibold">
                ⚠ {data.missingBasecost.total} sản phẩm chưa có Basecost
              </div>
              <div className="mt-0.5 text-xs text-amber-700">
                Các order trong khoảng đang xem chưa được tính đủ COGS. Hãy nhập
                Cost per item trong Shopify rồi bấm Cập nhật Basecost.
              </div>
            </div>
            <Link
              href="/stores"
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              Mở quản lý Store
            </Link>
          </div>
          <div className="mt-3 max-h-60 overflow-auto rounded-lg border border-amber-200 bg-white/70">
            {data.missingBasecost.items.map((item, index) => (
              <div
                key={`${item.storeId ?? "_"}|${item.productId ?? item.title}|${index}`}
                className="flex items-center justify-between gap-3 border-b border-amber-100 px-3 py-2 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-800">{item.title}</div>
                  <div className="text-xs text-slate-500">{item.storeName}</div>
                </div>
                <div className="shrink-0 text-right text-xs text-amber-800">
                  {item.units} item · {item.orderLines} dòng order
                </div>
              </div>
            ))}
          </div>
          {data.missingBasecost.truncated && (
            <div className="mt-2 text-xs text-amber-700">
              Danh sách đang hiển thị 100 sản phẩm đầu tiên.
            </div>
          )}
        </div>
      )}

      {loading && !data ? (
        <DashboardSkeleton />
      ) : !s ? (
        <EmptyState message="Chưa có dữ liệu." />
      ) : (
        <div className="relative">
          {loading && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center pt-24">
              <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-4 py-2 text-sm font-medium text-slate-600 shadow-sm">
                <Spinner /> Đang tải dữ liệu…
              </div>
            </div>
          )}
          <div
            className={`space-y-6 transition-opacity duration-200 ${
              loading ? "opacity-40" : "opacity-100"
            }`}
          >
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Doanh thu (ex-tax)"
              value={formatJPY(s.revenue.revenue)}
              sub={`${formatNumber(s.orders.count)} đơn · AOV ${formatJPY(
                s.orders.aov
              )}`}
            />
            <StatCard
              label="Lợi nhuận ròng"
              value={formatJPY(s.profit.netProfit)}
              sub={`Biên ${formatPercent(s.profit.netMargin)}`}
              tone={netTone}
            />
            <StatCard
              label="Chi phí Ads"
              value={formatJPY(s.variableB.total)}
              sub={`MER ${formatMultiplier(s.metrics.mer)} · ROAS ${formatMultiplier(
                s.metrics.roas
              )}`}
            />
            <StatCard
              label="Break-even MER"
              value={formatMultiplier(s.metrics.breakEvenRoas)}
              sub={`LN/đơn ${formatJPY(s.metrics.profitPerOrder)}`}
              tone="muted"
            />
          </div>

          {/* Chart + P&L breakdown */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <div className="mb-3 text-sm font-semibold text-slate-700">
                Diễn biến theo ngày
              </div>
              {data && data.daily.length > 0 ? (
                <DashboardChart data={data.daily} />
              ) : (
                <EmptyState message="Không có dữ liệu trong khoảng này." />
              )}
            </Card>

            <Card>
              <div className="mb-3 text-sm font-semibold text-slate-700">
                Bảng P&L
              </div>
              <div className="space-y-1 text-sm">
                <PnlRow label="Doanh thu (ex-tax)" value={s.revenue.revenue} strong />
                <PnlSub label="— trong đó phí ship thu" value={s.revenue.shippingCharged} />
                {s.revenue.refunded > 0 && (
                  <PnlSub label="— đã hoàn hàng (return)" value={-s.revenue.refunded} />
                )}
                <PnlSub label="— thuế thu hộ (nộp nhà nước)" value={s.revenue.tax} />
                <PnlSub label="— tổng khách đã trả (gồm thuế)" value={s.revenue.totalCollected} />
                <Divider />
                <div className="pt-1 text-xs font-semibold uppercase text-slate-400">
                  Biến đổi A (Sản xuất)
                </div>
                {Object.entries(s.variableA.byType).map(([k, v]) => (
                  <div key={k}>
                    <PnlRow
                      label={`${COST_RULE_TYPE_LABELS[k] ?? k} (${pctOfCollected(v)})`}
                      value={-v}
                      negative
                    />
                    {/* COGS: show WHERE it comes from — an inflated number is
                        usually 2 % rules stacking or an unexpected source. */}
                    {k === "COGS" && (
                      <>
                        {Object.entries(s.variableA.cogsBy).map(([src, sv]) => (
                          <PnlSub
                            key={src}
                            label={`— ${COGS_SOURCE_LABELS[src] ?? src}${
                              src === "RULE_PCT" && s.variableA.cogsPctRuleCount > 1
                                ? ` — ⚠ ${s.variableA.cogsPctRuleCount} quy tắc % đang CỘNG DỒN`
                                : ""
                            } (${pctOfCollected(sv)})`}
                            value={-sv}
                          />
                        ))}
                      </>
                    )}
                  </div>
                ))}
                <PnlRow
                  label={`Tổng biến đổi A (${pctOfCollected(s.variableA.total)})`}
                  value={-s.variableA.total}
                  negative
                  strong
                />
                <Divider />
                <PnlRow label="Lợi nhuận gộp" value={s.profit.grossProfit} strong />
                <Divider />
                <div className="pt-1 text-xs font-semibold uppercase text-slate-400">
                  Biến đổi B (Quảng cáo)
                </div>
                {Object.entries(s.variableB.byPlatform).map(([k, v]) => (
                  <PnlRow
                    key={k}
                    label={`${AD_PLATFORM_LABELS[k] ?? k} (${pctOfCollected(v)})`}
                    value={-v}
                    negative
                  />
                ))}
                <div className="px-2 text-xs italic text-slate-400">
                  ↳ đã gồm thuế theo cài đặt thuế của từng tài khoản Ads
                </div>
                <PnlRow label="Contribution" value={s.profit.contribution} strong />
                <Divider />
                <div className="pt-1 text-xs font-semibold uppercase text-slate-400">
                  Chi phí cố định (phân bổ)
                </div>
                {Object.entries(s.fixed.byCategory).map(([k, v]) => (
                  <PnlRow
                    key={k}
                    label={FIXED_COST_CATEGORY_LABELS[k] ?? k}
                    value={-v}
                    negative
                  />
                ))}
                <Divider />
                <PnlRow
                  label="LỢI NHUẬN RÒNG"
                  value={s.profit.netProfit}
                  strong
                  highlight
                />
              </div>
            </Card>
          </div>

          <Card>
            <div className="mb-1 text-sm font-semibold text-slate-700">
              Diễn biến hiệu quả Ads theo Store/Kênh
            </div>
            <p className="mb-3 text-xs text-slate-400">
              So sánh ROAS và CPA thực tế từ chi phí nền tảng Ads với đơn hàng Shopify.
            </p>
            {data && data.channelTrends.length > 0 ? (
              <ChannelEfficiencyTrendChart
                data={data.channelTrends}
                dates={data.daily.map((point) => point.date)}
                dashboardStoreId={data.storeId}
                breakEvenRoas={s.metrics.breakEvenRoas}
                storeBreakEvens={Object.fromEntries(
                  data.stores.map((row) => [row.storeId, row.breakEvenRoas])
                )}
              />
            ) : (
              <EmptyState message="Chưa có dữ liệu Ads theo store và kênh trong khoảng này." />
            )}
          </Card>

          {/* Channel efficiency / ROAS — the Phase 3 payoff */}
          <Card>
            <div className="mb-1 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-700">
                Hiệu quả theo kênh (ROAS)
              </div>
              <div className="text-xs text-slate-400">
                Hoà vốn (break-even MER): {formatMultiplier(s.metrics.breakEvenRoas)}
              </div>
            </div>
            <p className="mb-3 text-xs text-slate-400">
              Ghép doanh thu Shopify theo kênh ↔ chi phí Ads theo nền tảng. ROAS ≥
              break-even là lãi → cân nhắc scale; thấp hơn → tối ưu/cắt.
            </p>
            {data && data.channelEfficiency.length === 0 ? (
              <EmptyState message="Chưa có dữ liệu." />
            ) : (
              <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="text-xs uppercase text-slate-400">
                    <th className="py-1 text-left">Kênh</th>
                    <th className="py-1 text-right">Chi phí Ads</th>
                    <th className="py-1 text-right">Doanh thu</th>
                    <th className="py-1 text-right">Đơn</th>
                    <th className="py-1 text-right">ROAS</th>
                    <th className="py-1 text-right">CPA</th>
                    <th className="py-1 text-right">Đánh giá</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.channelEfficiency.map((c) => {
                    const be = s.metrics.breakEvenRoas || 0;
                    const verdict = !c.isPaid
                      ? { label: "Không Ads", tone: "slate" as const }
                      : c.roas >= be * 1.2
                      ? { label: "🚀 Scale", tone: "green" as const }
                      : c.roas >= be
                      ? { label: "✓ OK", tone: "blue" as const }
                      : { label: "⚠ Cắt/Tối ưu", tone: "rose" as const };
                    return (
                      <tr key={c.channel} className="border-t border-slate-100">
                        <td className="py-1.5 font-medium text-slate-700">
                          {ORDER_CHANNEL_LABELS[c.channel] ?? c.channel}
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-rose-500">
                          {c.spend > 0 ? formatJPY(c.spend) : "—"}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {formatJPY(c.revenue)}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {formatNumber(c.orders)}
                        </td>
                        <td
                          className={`py-1.5 text-right tabular-nums font-semibold ${
                            !c.isPaid
                              ? "text-slate-400"
                              : c.roas >= be
                              ? "text-emerald-600"
                              : "text-rose-600"
                          }`}
                        >
                          {c.isPaid ? formatMultiplier(c.roas) : "—"}
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-slate-500">
                          {c.cpa > 0 ? formatJPY(c.cpa) : "—"}
                        </td>
                        <td className="py-1.5 text-right">
                          <Badge tone={verdict.tone}>{verdict.label}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
          </Card>

          {/* Store breakdown + best sellers */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0">
              <div className="mb-3 text-sm font-semibold text-slate-700">
                Theo Store
              </div>
              {data && data.stores.length === 0 ? (
                <EmptyState message="Chưa có store nào có dữ liệu." />
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full min-w-[440px] text-sm">
                  <thead>
                    <tr className="text-xs uppercase text-slate-400">
                      <th className="py-1 text-left">Store</th>
                      <th className="py-1 text-right">Doanh thu</th>
                      <th className="py-1 text-right">Ads</th>
                      <th className="py-1 text-right">LN ròng</th>
                      <th className="py-1 text-right">Biên</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.stores.map((row) => (
                      <tr key={row.storeId} className="border-t border-slate-100">
                        <td className="py-1.5 font-medium text-slate-700">
                          {row.storeName}
                        </td>
                        <td className="py-1.5 text-right">{formatJPY(row.revenue)}</td>
                        <td className="py-1.5 text-right text-rose-500">
                          {formatJPY(row.adSpend)}
                        </td>
                        <td
                          className={`py-1.5 text-right font-semibold ${
                            row.netProfit >= 0 ? "text-emerald-600" : "text-rose-600"
                          }`}
                        >
                          {formatJPY(row.netProfit)}
                        </td>
                        <td className="py-1.5 text-right text-slate-500">
                          {formatPercent(row.netMargin)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </Card>

            <Card className="min-w-0">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-700">
                  Top sản phẩm bán chạy
                </span>
                <Link
                  href={productsHref}
                  className="text-xs font-medium text-brand-600 hover:text-brand-700"
                >
                  Xem tất cả →
                </Link>
              </div>
              {data && data.bestSellers.length === 0 ? (
                <EmptyState message="Chưa có dữ liệu đơn hàng." />
              ) : (
                <div className="space-y-2">
                  {data?.bestSellers.map((p, i) => (
                    <div
                      key={p.productId ?? p.title}
                      className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-1 transition hover:bg-slate-50"
                    >
                      <span className="w-5 text-center text-xs font-bold text-slate-400">
                        {(data.bestSellersPage - 1) * data.bestSellersPageSize + i + 1}
                      </span>
                      {p.storefrontUrl ? (
                        <a
                          href={p.storefrontUrl}
                          target="_blank"
                          rel="noreferrer"
                          title="Mở sản phẩm trên store"
                        >
                          <ProductThumbnail src={p.image} alt={p.title} />
                        </a>
                      ) : (
                        <ProductThumbnail src={p.image} alt={p.title} />
                      )}
                      <div className="min-w-0 flex-1">
                        {p.storefrontUrl ? (
                          <a
                            href={p.storefrontUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate text-sm font-medium text-brand-700 hover:underline"
                          >
                            {p.title} ↗
                          </a>
                        ) : (
                          <div className="truncate text-sm font-medium text-slate-700">
                            {p.title}
                          </div>
                        )}
                        <div className="text-xs text-slate-400">
                          {formatNumber(p.units)} cái · {formatNumber(p.orders)} đơn
                        </div>
                      </div>
                      <div className="text-sm font-semibold text-slate-700">
                        {formatJPY(p.revenue)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {data && data.bestSellersTotalPages > 1 && (
                <div className="mt-3 flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
                  <button
                    type="button"
                    disabled={data.bestSellersPage <= 1 || loading}
                    onClick={() => setProductsPage((page) => Math.max(1, page - 1))}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                  >
                    ← Trước
                  </button>
                  <span className="text-xs text-slate-500">
                    Trang {data.bestSellersPage}/{data.bestSellersTotalPages}
                  </span>
                  <button
                    type="button"
                    disabled={
                      data.bestSellersPage >= data.bestSellersTotalPages || loading
                    }
                    onClick={() => setProductsPage((page) => page + 1)}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                  >
                    Sau →
                  </button>
                </div>
              )}
            </Card>
          </div>

          {/* Attribution — đơn theo kênh (cho tối ưu Ads) */}
          <Card>
            <div className="mb-3 text-sm font-semibold text-slate-700">
              Đơn theo kênh (traffic source)
            </div>
            {data && data.channels.length === 0 ? (
              <EmptyState message="Chưa có dữ liệu attribution — sẽ có sau khi sync Shopify (UTM)." />
            ) : (
              <div className="space-y-2.5">
                {data?.channels.map((c) => (
                  <div key={c.channel}>
                    <div className="mb-0.5 flex items-center justify-between text-sm">
                      <span className="font-medium text-slate-700">
                        {ORDER_CHANNEL_LABELS[c.channel] ?? c.channel}
                      </span>
                      <span className="text-slate-500">
                        {formatNumber(c.orders)} đơn · {formatJPY(c.revenue)}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded bg-slate-100">
                      <div
                        className="h-2 rounded bg-brand-500"
                        style={{ width: `${(c.revenue / channelMax) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin text-brand-600" viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

// Skeleton shown only on the very first load (before any data exists).
function DashboardSkeleton() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl border border-slate-200 bg-slate-100" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="h-72 rounded-xl border border-slate-200 bg-slate-100 lg:col-span-2" />
        <div className="h-72 rounded-xl border border-slate-200 bg-slate-100" />
      </div>
      <div className="h-40 rounded-xl border border-slate-200 bg-slate-100" />
    </div>
  );
}

function PnlRow({
  label,
  value,
  strong,
  negative,
  highlight,
}: {
  label: string;
  value: number;
  strong?: boolean;
  negative?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between ${
        highlight ? "rounded-md bg-slate-50 px-2 py-1.5" : "px-2"
      }`}
    >
      <span
        className={`${strong ? "font-semibold text-slate-700" : "text-slate-500"}`}
      >
        {label}
      </span>
      <span
        className={`tabular-nums ${
          highlight
            ? value >= 0
              ? "font-bold text-emerald-600"
              : "font-bold text-rose-600"
            : negative
            ? "text-rose-500"
            : strong
            ? "font-semibold text-slate-800"
            : "text-slate-600"
        }`}
      >
        {formatJPY(value)}
      </span>
    </div>
  );
}

function PnlSub({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between px-2 text-xs text-slate-400">
      <span>{label}</span>
      <span className="tabular-nums">{formatJPY(value)}</span>
    </div>
  );
}

function Divider() {
  return <div className="my-1 border-t border-slate-100" />;
}
