"use client";

import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { formatJPY } from "@/lib/format";

export interface ChartPoint {
  date: string;
  revenue: number;
  adSpend: number;
  netProfit: number;
}

export function DashboardChart({ data }: { data: ChartPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "#94a3b8" }}
          tickFormatter={(d: string) => d.slice(5)}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "#94a3b8" }}
          tickFormatter={(v: number) =>
            v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`
          }
          width={40}
        />
        <Tooltip
          formatter={(value: number, name: string) => [formatJPY(value), name]}
          labelStyle={{ color: "#0f172a", fontWeight: 600 }}
          contentStyle={{
            borderRadius: 8,
            border: "1px solid #e2e8f0",
            fontSize: 12,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="revenue" name="Doanh thu" fill="#bfdbfe" radius={[4, 4, 0, 0]} />
        <Bar dataKey="adSpend" name="Chi phí Ads" fill="#fecaca" radius={[4, 4, 0, 0]} />
        <Line
          dataKey="netProfit"
          name="Lợi nhuận ròng"
          type="monotone"
          stroke="#059669"
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
