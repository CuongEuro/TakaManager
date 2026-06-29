"use client";

import { useEffect, useState } from "react";
import type { DashboardData } from "@/lib/pnl";
import { RANGE_PRESET_LABELS, RangePreset } from "@/lib/dates";
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

interface DashboardResponse extends DashboardData {
  preset: RangePreset;
  storeId: string | null;
  storeOptions: { id: string; name: string }[];
  timezone: string;
}

const PRESETS: RangePreset[] = [
  "today",
  "yesterday",
  "last7",
  "thisWeek",
  "thisMonth",
  "lastMonth",
  "last30",
];

export default function DashboardPage() {
  const [preset, setPreset] = useState<RangePreset>("today");
  const [storeId, setStoreId] = useState<string>("");
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ preset });
    if (storeId) params.set("storeId", storeId);
    fetch(`/api/dashboard?${params}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .finally(() => setLoading(false));
  }, [preset, storeId]);

  const s = data?.summary;
  const netTone = s && s.profit.netProfit >= 0 ? "good" : "bad";
  const channelMax = Math.max(1, ...(data?.channels?.map((c) => c.revenue) ?? []));

  return (
    <div>
      <PageHeader
        title="Dashboard Lợi nhuận"
        subtitle={`Tổng quan doanh thu, chi phí & lợi nhuận theo thời gian — múi giờ ${
          data?.timezone ?? "Asia/Tokyo"
        }.`}
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="flex flex-wrap rounded-lg border border-slate-200 bg-white p-1">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setPreset(p)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                    preset === p
                      ? "bg-brand-600 text-white"
                      : "text-slate-500 hover:bg-slate-100"
                  }`}
                >
                  {RANGE_PRESET_LABELS[p]}
                </button>
              ))}
            </div>
            <div className="w-full sm:w-44">
              <Select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
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
                <Divider />
                <div className="pt-1 text-xs font-semibold uppercase text-slate-400">
                  Biến đổi A (Sản xuất)
                </div>
                {Object.entries(s.variableA.byType).map(([k, v]) => (
                  <PnlRow
                    key={k}
                    label={COST_RULE_TYPE_LABELS[k] ?? k}
                    value={-v}
                    negative
                  />
                ))}
                <PnlRow label="Tổng biến đổi A" value={-s.variableA.total} negative strong />
                <Divider />
                <PnlRow label="Lợi nhuận gộp" value={s.profit.grossProfit} strong />
                <Divider />
                <div className="pt-1 text-xs font-semibold uppercase text-slate-400">
                  Biến đổi B (Quảng cáo)
                </div>
                {Object.entries(s.variableB.byPlatform).map(([k, v]) => (
                  <PnlRow
                    key={k}
                    label={AD_PLATFORM_LABELS[k] ?? k}
                    value={-v}
                    negative
                  />
                ))}
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
              <table className="w-full text-sm">
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
            )}
          </Card>

          {/* Store breakdown + best sellers */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <div className="mb-3 text-sm font-semibold text-slate-700">
                Theo Store
              </div>
              {data && data.stores.length === 0 ? (
                <EmptyState message="Chưa có store nào có dữ liệu." />
              ) : (
                <table className="w-full text-sm">
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
              )}
            </Card>

            <Card>
              <div className="mb-3 text-sm font-semibold text-slate-700">
                Top sản phẩm bán chạy
              </div>
              {data && data.bestSellers.length === 0 ? (
                <EmptyState message="Chưa có dữ liệu đơn hàng." />
              ) : (
                <div className="space-y-2">
                  {data?.bestSellers.map((p, i) => (
                    <div
                      key={p.productId ?? p.title}
                      className="flex items-center gap-3"
                    >
                      <span className="w-5 text-center text-xs font-bold text-slate-400">
                        {i + 1}
                      </span>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={p.image || "https://placehold.co/40x40?text=POD"}
                        alt={p.title}
                        className="h-10 w-10 rounded-md object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-700">
                          {p.title}
                        </div>
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
