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
import {
  COST_RULE_TYPES,
  COST_RULE_TYPE_LABELS,
  CALC_METHODS,
  CALC_METHOD_LABELS,
} from "@/lib/constants";
import { formatJPY, formatPercent } from "@/lib/format";

interface CostRule {
  id: string;
  storeId: string | null;
  store: { name: string } | null;
  type: string;
  calcMethod: string;
  amount: number;
  active: boolean;
  note: string | null;
}
interface Store {
  id: string;
  name: string;
}

export default function VariableAPage() {
  const { items, loading, create, remove } =
    useResource<CostRule>("/api/cost-rules");
  const { items: stores } = useResource<Store>("/api/stores");

  const [form, setForm] = useState({
    storeId: "",
    type: "COGS",
    calcMethod: "PER_UNIT",
    amount: "",
    note: "",
  });

  const isPercent = form.calcMethod === "PERCENT_OF_REVENUE";

  async function add() {
    if (!form.amount) return;
    await create({
      storeId: form.storeId || null,
      type: form.type,
      calcMethod: form.calcMethod,
      amount: isPercent ? Number(form.amount) / 100 : Number(form.amount),
      note: form.note.trim() || null,
    });
    setForm({ ...form, amount: "", note: "" });
  }

  function fmtAmount(r: CostRule) {
    return r.calcMethod === "PERCENT_OF_REVENUE"
      ? formatPercent(r.amount)
      : formatJPY(r.amount);
  }

  return (
    <div>
      <PageHeader
        title="Chi phí biến đổi A — Sản xuất / Fulfillment"
        subtitle="COGS, phí bán hàng, vận chuyển, mực in, nhân sự... Tự áp dụng vào đơn hàng khi tính P&L."
      />

      <Card className="mb-6">
        <div className="grid gap-3 md:grid-cols-6 md:items-end">
          <Field label="Store (trống = tất cả)">
            <Select
              value={form.storeId}
              onChange={(e) => setForm({ ...form, storeId: e.target.value })}
            >
              <option value="">Tất cả store</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Loại chi phí">
            <Select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              {COST_RULE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {COST_RULE_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Cách tính">
            <Select
              value={form.calcMethod}
              onChange={(e) =>
                setForm({ ...form, calcMethod: e.target.value })
              }
            >
              {CALC_METHODS.map((m) => (
                <option key={m} value={m}>
                  {CALC_METHOD_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={isPercent ? "Giá trị (%)" : "Số tiền (¥)"}>
            <Input
              type="number"
              step="any"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder={isPercent ? "VD: 2.9" : "VD: 800"}
            />
          </Field>
          <Field label="Ghi chú">
            <Input
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="tuỳ chọn"
            />
          </Field>
          <Button onClick={add}>+ Thêm</Button>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          💡 Mẹo: COGS basecost nên đặt <b>Theo sản phẩm (mỗi cái)</b>; phí cổng
          thanh toán Shopify đặt <b>% Doanh thu</b> (vd 3.6%); phí ship/đóng gói
          thường <b>Theo đơn hàng</b>.
        </p>
      </Card>

      <Card>
        {loading ? (
          <EmptyState message="Đang tải..." />
        ) : items.length === 0 ? (
          <EmptyState message="Chưa có quy tắc chi phí nào." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Loại</Th>
                <Th>Phạm vi</Th>
                <Th>Cách tính</Th>
                <Th className="text-right">Giá trị</Th>
                <Th>Ghi chú</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Badge tone="amber">
                      {COST_RULE_TYPE_LABELS[r.type] ?? r.type}
                    </Badge>
                  </Td>
                  <Td className="text-slate-500">
                    {r.store?.name ?? "Tất cả store"}
                  </Td>
                  <Td className="text-slate-500">
                    {CALC_METHOD_LABELS[r.calcMethod] ?? r.calcMethod}
                  </Td>
                  <Td className="text-right tabular-nums font-medium">
                    {fmtAmount(r)}
                  </Td>
                  <Td className="text-slate-400">{r.note || "—"}</Td>
                  <Td className="text-right">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (confirm("Xóa quy tắc này?")) remove(r.id);
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
