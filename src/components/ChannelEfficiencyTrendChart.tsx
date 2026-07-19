"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChannelTrendPoint } from "@/lib/pnl";
import { AD_PLATFORM_LABELS } from "@/lib/constants";
import { formatJPY, formatMultiplier } from "@/lib/format";
import { Select } from "@/components/ui";

const ALL_STORES = "__all__";
const UNASSIGNED = "__unassigned__";
const COLORS: Record<string, string> = {
  FACEBOOK: "#2563eb",
  GOOGLE: "#ea4335",
  TWITTER: "#0f172a",
  OTHER: "#7c3aed",
};
const FALLBACK_COLORS = ["#0891b2", "#d97706", "#059669", "#db2777"];

type Aggregate = { spend: number; revenue: number; orders: number };
type ChartDatum = Record<string, string | number | null | Aggregate> & {
  date: string;
};

function shortJPY(value: number): string {
  if (Math.abs(value) >= 1_000_000)
    return `¥${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `¥${Math.round(value / 1_000)}k`;
  return `¥${Math.round(value)}`;
}

function metricValue(metric: "roas" | "cpa", value: number): string {
  return metric === "roas" ? formatMultiplier(value) : formatJPY(value);
}

function TrendTooltip({
  active,
  payload,
  label,
  metric,
}: {
  active?: boolean;
  payload?: Array<{
    color?: string;
    dataKey?: string | number;
    name?: string;
    value?: number;
    payload?: ChartDatum;
  }>;
  label?: string;
  metric: "roas" | "cpa";
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-56 rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg">
      <div className="mb-2 font-semibold text-slate-700">{label}</div>
      <div className="space-y-2">
        {payload.map((item) => {
          const key = String(item.dataKey ?? "");
          const meta = item.payload?.[`${key}__meta`] as Aggregate | undefined;
          return (
            <div key={key}>
              <div className="flex items-center justify-between gap-5">
                <span className="flex items-center gap-1.5 text-slate-600">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  {item.name}
                </span>
                <span className="font-semibold text-slate-800">
                  {metricValue(metric, Number(item.value) || 0)}
                </span>
              </div>
              {meta && (
                <div className="mt-0.5 pl-3.5 text-[11px] text-slate-400">
                  Ads {formatJPY(meta.spend)} · DT {formatJPY(meta.revenue)} · {meta.orders} đơn
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ChannelEfficiencyTrendChart({
  data,
  dates,
  dashboardStoreId,
  breakEvenRoas,
  storeBreakEvens,
}: {
  data: ChannelTrendPoint[];
  dates: string[];
  dashboardStoreId: string | null;
  breakEvenRoas: number;
  storeBreakEvens: Record<string, number>;
}) {
  const [selectedStore, setSelectedStore] = useState(
    dashboardStoreId ?? ALL_STORES
  );

  useEffect(() => {
    setSelectedStore(dashboardStoreId ?? ALL_STORES);
  }, [dashboardStoreId]);

  const storeOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of data)
      map.set(row.storeId ?? UNASSIGNED, row.storeName);
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const { chartData, channels } = useMemo(() => {
    const filtered =
      selectedStore === ALL_STORES
        ? data
        : data.filter(
            (row) => (row.storeId ?? UNASSIGNED) === selectedStore
          );
    const aggregates = new Map<string, Aggregate>();
    const totals = new Map<string, number>();
    for (const row of filtered) {
      const key = `${row.date}|${row.channel}`;
      const current = aggregates.get(key) ?? { spend: 0, revenue: 0, orders: 0 };
      current.spend += row.spend;
      current.revenue += row.revenue;
      current.orders += row.orders;
      aggregates.set(key, current);
      totals.set(row.channel, (totals.get(row.channel) ?? 0) + row.spend);
    }
    const activeChannels = Array.from(totals.keys()).sort(
      (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0)
    );
    const points: ChartDatum[] = dates.map((date) => {
      const point: ChartDatum = { date };
      for (const channel of activeChannels) {
        const aggregate = aggregates.get(`${date}|${channel}`) ?? {
          spend: 0,
          revenue: 0,
          orders: 0,
        };
        point[channel] =
          aggregate.spend > 0 ? aggregate.revenue / aggregate.spend : null;
        point[`${channel}__cpa`] =
          aggregate.spend > 0 && aggregate.orders > 0
            ? aggregate.spend / aggregate.orders
            : null;
        point[`${channel}__meta`] = aggregate;
        point[`${channel}__cpa__meta`] = aggregate;
      }
      return point;
    });
    return { chartData: points, channels: activeChannels };
  }, [data, dates, selectedStore]);

  const selectedBreakEven =
    selectedStore === ALL_STORES || selectedStore === UNASSIGNED
      ? breakEvenRoas
      : storeBreakEvens[selectedStore] ?? breakEvenRoas;
  const color = (channel: string, index: number) =>
    COLORS[channel] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];

  if (channels.length === 0)
    return <div className="py-12 text-center text-sm text-slate-400">Chưa có dữ liệu Ads theo kênh.</div>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-xs text-slate-400">
          ROAS = doanh thu Shopify theo traffic source / chi phí Ads. CPA = chi phí Ads / đơn Shopify.
        </p>
        <label className="w-full sm:w-56">
          <span className="mb-1 block text-xs font-medium text-slate-500">Store</span>
          <Select
            value={selectedStore}
            onChange={(event) => setSelectedStore(event.target.value)}
          >
            {!dashboardStoreId && <option value={ALL_STORES}>Tất cả store (gộp)</option>}
            {storeOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-600">ROAS theo ngày</span>
            {selectedBreakEven > 0 && (
              <span className="text-slate-400">
                Hoà vốn {formatMultiplier(selectedBreakEven)}
              </span>
            )}
          </div>
          <ResponsiveContainer width="100%" height={270}>
            <LineChart
              data={chartData}
              margin={{ top: 8, right: 10, left: 0, bottom: 0 }}
              accessibilityLayer
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                tickFormatter={(date: string) => date.slice(5)}
              />
              <YAxis
                width={42}
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                tickFormatter={(value: number) => `${value.toFixed(1)}x`}
              />
              <Tooltip content={<TrendTooltip metric="roas" />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {selectedBreakEven > 0 && (
                <ReferenceLine
                  y={selectedBreakEven}
                  stroke="#f59e0b"
                  strokeDasharray="5 4"
                />
              )}
              {channels.map((channel, index) => (
                <Line
                  key={channel}
                  dataKey={channel}
                  name={AD_PLATFORM_LABELS[channel] ?? channel}
                  type="monotone"
                  stroke={color(channel, index)}
                  strokeWidth={2}
                  dot={chartData.length <= 2 ? { r: 3 } : false}
                  activeDot={{ r: 4 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold text-slate-600">CPA theo ngày</div>
          <ResponsiveContainer width="100%" height={270}>
            <LineChart
              data={chartData}
              margin={{ top: 8, right: 10, left: 8, bottom: 0 }}
              accessibilityLayer
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                tickFormatter={(date: string) => date.slice(5)}
              />
              <YAxis
                width={58}
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                tickFormatter={shortJPY}
              />
              <Tooltip content={<TrendTooltip metric="cpa" />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {channels.map((channel, index) => (
                <Line
                  key={channel}
                  dataKey={`${channel}__cpa`}
                  name={AD_PLATFORM_LABELS[channel] ?? channel}
                  type="monotone"
                  stroke={color(channel, index)}
                  strokeWidth={2}
                  dot={chartData.length <= 2 ? { r: 3 } : false}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
