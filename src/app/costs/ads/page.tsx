"use client";

import { useState } from "react";
import { useResource } from "@/hooks/useResource";
import {
  PageHeader,
  Card,
  Button,
  Input,
  Select,
  Field,
  Table,
  Th,
  Td,
  Badge,
  EmptyState,
} from "@/components/ui";
import { AD_PLATFORMS, AD_PLATFORM_LABELS } from "@/lib/constants";
import { formatJPY, formatMultiplier } from "@/lib/format";
import { isoDay } from "@/lib/dates";

interface AdSpend {
  id: string;
  storeId: string | null;
  store: { name: string } | null;
  platform: string;
  date: string;
  campaignName: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  source: string;
}
interface Store {
  id: string;
  name: string;
}

const PLATFORM_TONE: Record<string, "blue" | "rose" | "amber" | "slate"> = {
  FACEBOOK: "blue",
  GOOGLE: "amber",
  TWITTER: "slate",
  OTHER: "slate",
};

export default function AdsPage() {
  const { items, loading, create, remove } =
    useResource<AdSpend>("/api/ad-spend");
  const { items: stores } = useResource<Store>("/api/stores");

  const [form, setForm] = useState({
    storeId: "",
    platform: "FACEBOOK",
    date: isoDay(new Date()),
    campaignName: "",
    spend: "",
    revenue: "",
    conversions: "",
  });

  async function add() {
    if (!form.spend || !form.date) return;
    await create({
      storeId: form.storeId || null,
      platform: form.platform,
      date: form.date,
      campaignName: form.campaignName.trim() || null,
      spend: Number(form.spend),
      revenue: form.revenue ? Number(form.revenue) : 0,
      conversions: form.conversions ? Number(form.conversions) : 0,
    });
    setForm({ ...form, campaignName: "", spend: "", revenue: "", conversions: "" });
  }

  return (
    <div>
      <PageHeader
        title="Chi phí biến đổi B — Quảng cáo"
        subtitle="2 cách nhập chi phí Ads: (1) tự động — kết nối tài khoản ở trang 'Kết nối Ads'; (2) thủ công — nhập tay bên dưới. Dòng nhập tay không bị ghi đè khi đồng bộ API."
      />

      <Card className="mb-6">
        <div className="grid gap-3 md:grid-cols-7 md:items-end">
          <Field label="Store">
            <Select
              value={form.storeId}
              onChange={(e) => setForm({ ...form, storeId: e.target.value })}
            >
              <option value="">— Chung —</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Nền tảng">
            <Select
              value={form.platform}
              onChange={(e) => setForm({ ...form, platform: e.target.value })}
            >
              {AD_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {AD_PLATFORM_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Ngày">
            <Input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </Field>
          <Field label="Campaign">
            <Input
              value={form.campaignName}
              onChange={(e) =>
                setForm({ ...form, campaignName: e.target.value })
              }
              placeholder="tuỳ chọn"
            />
          </Field>
          <Field label="Chi phí (¥)">
            <Input
              type="number"
              value={form.spend}
              onChange={(e) => setForm({ ...form, spend: e.target.value })}
            />
          </Field>
          <Field label="Doanh thu attr. (¥)">
            <Input
              type="number"
              value={form.revenue}
              onChange={(e) => setForm({ ...form, revenue: e.target.value })}
            />
          </Field>
          <Button onClick={add}>+ Thêm</Button>
        </div>
      </Card>

      <Card>
        {loading ? (
          <EmptyState message="Đang tải..." />
        ) : items.length === 0 ? (
          <EmptyState message="Chưa có dữ liệu quảng cáo." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Ngày</Th>
                <Th>Nền tảng</Th>
                <Th>Store</Th>
                <Th>Campaign</Th>
                <Th className="text-right">Chi phí</Th>
                <Th className="text-right">DT attr.</Th>
                <Th className="text-right">ROAS</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <Td className="tabular-nums text-slate-500">
                    {a.date.slice(0, 10)}
                  </Td>
                  <Td>
                    <Badge tone={PLATFORM_TONE[a.platform] ?? "slate"}>
                      {AD_PLATFORM_LABELS[a.platform] ?? a.platform}
                    </Badge>
                  </Td>
                  <Td className="text-slate-500">{a.store?.name ?? "—"}</Td>
                  <Td className="text-slate-500">{a.campaignName || "—"}</Td>
                  <Td className="text-right tabular-nums text-rose-500">
                    {formatJPY(a.spend)}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {formatJPY(a.revenue)}
                  </Td>
                  <Td className="text-right tabular-nums font-medium">
                    {a.spend > 0
                      ? formatMultiplier(a.revenue / a.spend)
                      : "—"}
                  </Td>
                  <Td className="text-right">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (confirm("Xóa dòng này?")) remove(a.id);
                      }}
                    >
                      🗑️
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
