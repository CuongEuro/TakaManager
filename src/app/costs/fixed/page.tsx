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
  FIXED_COST_CATEGORIES,
  FIXED_COST_CATEGORY_LABELS,
  BILLING_CYCLES,
  BILLING_CYCLE_LABELS,
} from "@/lib/constants";
import { formatJPY } from "@/lib/format";

interface FixedCost {
  id: string;
  storeId: string | null;
  store: { name: string } | null;
  category: string;
  name: string;
  amount: number;
  billingCycle: string;
  startDate: string;
  endDate: string | null;
  note: string | null;
}
interface Store {
  id: string;
  name: string;
}

function monthlyEquivalent(amount: number, cycle: string): number {
  if (cycle === "YEARLY") return amount / 12;
  if (cycle === "MONTHLY") return amount;
  return 0; // ONE_TIME
}

// Default "effective from" = first day of the current month, so a monthly cost
// counts in full for the current month instead of only from its creation day.
function firstOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
const toYmd = (iso: string) => (iso ? iso.slice(0, 10) : "");
function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("vi-VN");
}

export default function FixedCostsPage() {
  const { items, loading, create, update, remove } =
    useResource<FixedCost>("/api/fixed-costs");
  const { items: stores } = useResource<Store>("/api/stores");

  const [form, setForm] = useState({
    storeId: "",
    category: "SHOPIFY",
    name: "",
    amount: "",
    billingCycle: "MONTHLY",
    startDate: firstOfMonth(),
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState({
    storeId: "",
    category: "SHOPIFY",
    name: "",
    amount: "",
    billingCycle: "MONTHLY",
    startDate: "",
  });
  const [saving, setSaving] = useState(false);

  async function add() {
    if (!form.name.trim() || !form.amount) return;
    await create({
      storeId: form.storeId || null,
      category: form.category,
      name: form.name.trim(),
      amount: Number(form.amount),
      billingCycle: form.billingCycle,
      startDate: form.startDate || undefined,
    });
    setForm({ ...form, name: "", amount: "" });
  }

  function startEdit(i: FixedCost) {
    setEditingId(i.id);
    setEdit({
      storeId: i.storeId ?? "",
      category: i.category,
      name: i.name,
      amount: String(i.amount),
      billingCycle: i.billingCycle,
      startDate: toYmd(i.startDate),
    });
  }

  async function saveEdit() {
    if (!editingId || !edit.name.trim() || !edit.amount) return;
    setSaving(true);
    try {
      await update(editingId, {
        storeId: edit.storeId || null,
        category: edit.category,
        name: edit.name.trim(),
        amount: Number(edit.amount),
        billingCycle: edit.billingCycle,
        startDate: edit.startDate || undefined,
      });
      setEditingId(null);
    } finally {
      setSaving(false);
    }
  }

  const totalMonthly = items.reduce(
    (s, i) => s + monthlyEquivalent(i.amount, i.billingCycle),
    0
  );

  return (
    <div>
      <PageHeader
        title="Chi phí cố định"
        subtitle="Shopify, Klaviyo, Line, cơ sở... Tự phân bổ theo ngày khi tính P&L."
        actions={
          <Badge tone="blue">
            Tổng ≈ {formatJPY(totalMonthly)} / tháng
          </Badge>
        }
      />

      <Card className="mb-6">
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-7 md:items-end">
          <Field label="Store (trống = toàn công ty)">
            <Select
              value={form.storeId}
              onChange={(e) => setForm({ ...form, storeId: e.target.value })}
            >
              <option value="">Toàn công ty</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Loại">
            <Select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              {FIXED_COST_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {FIXED_COST_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tên khoản phí">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="VD: Shopify Advanced"
            />
          </Field>
          <Field label="Số tiền (¥)">
            <Input
              type="number"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </Field>
          <Field label="Chu kỳ">
            <Select
              value={form.billingCycle}
              onChange={(e) =>
                setForm({ ...form, billingCycle: e.target.value })
              }
            >
              {BILLING_CYCLES.map((c) => (
                <option key={c} value={c}>
                  {BILLING_CYCLE_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Áp dụng từ">
            <Input
              type="date"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            />
          </Field>
          <Button onClick={add}>+ Thêm</Button>
        </div>
      </Card>

      <Card>
        {loading ? (
          <EmptyState message="Đang tải..." />
        ) : items.length === 0 ? (
          <EmptyState message="Chưa có chi phí cố định nào." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Tên</Th>
                <Th>Loại</Th>
                <Th>Phạm vi</Th>
                <Th className="text-right">Số tiền</Th>
                <Th>Chu kỳ</Th>
                <Th>Áp dụng từ</Th>
                <Th className="text-right">≈ /tháng</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) =>
                editingId === i.id ? (
                  <tr key={i.id} className="bg-amber-50/40">
                    <Td>
                      <Input
                        value={edit.name}
                        onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                      />
                    </Td>
                    <Td>
                      <Select
                        value={edit.category}
                        onChange={(e) => setEdit({ ...edit, category: e.target.value })}
                      >
                        {FIXED_COST_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {FIXED_COST_CATEGORY_LABELS[c]}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    <Td>
                      <Select
                        value={edit.storeId}
                        onChange={(e) => setEdit({ ...edit, storeId: e.target.value })}
                      >
                        <option value="">Toàn công ty</option>
                        {stores.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    <Td>
                      <Input
                        type="number"
                        className="text-right"
                        value={edit.amount}
                        onChange={(e) => setEdit({ ...edit, amount: e.target.value })}
                      />
                    </Td>
                    <Td>
                      <Select
                        value={edit.billingCycle}
                        onChange={(e) => setEdit({ ...edit, billingCycle: e.target.value })}
                      >
                        {BILLING_CYCLES.map((c) => (
                          <option key={c} value={c}>
                            {BILLING_CYCLE_LABELS[c]}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    <Td>
                      <Input
                        type="date"
                        value={edit.startDate}
                        onChange={(e) => setEdit({ ...edit, startDate: e.target.value })}
                      />
                    </Td>
                    <Td className="text-right tabular-nums text-slate-500">
                      {formatJPY(
                        monthlyEquivalent(Number(edit.amount) || 0, edit.billingCycle)
                      )}
                    </Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button onClick={saveEdit} disabled={saving}>
                          {saving ? "..." : "✓ Lưu"}
                        </Button>
                        <Button variant="ghost" onClick={() => setEditingId(null)}>
                          ✗
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ) : (
                  <tr key={i.id}>
                    <Td className="font-medium text-slate-800">{i.name}</Td>
                    <Td>
                      <Badge tone="blue">
                        {FIXED_COST_CATEGORY_LABELS[i.category] ?? i.category}
                      </Badge>
                    </Td>
                    <Td className="text-slate-500">
                      {i.store?.name ?? "Toàn công ty"}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {formatJPY(i.amount)}
                    </Td>
                    <Td className="text-slate-500">
                      {BILLING_CYCLE_LABELS[i.billingCycle] ?? i.billingCycle}
                    </Td>
                    <Td className="text-slate-500">{fmtDate(i.startDate)}</Td>
                    <Td className="text-right tabular-nums text-slate-500">
                      {formatJPY(monthlyEquivalent(i.amount, i.billingCycle))}
                    </Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="secondary"
                          onClick={() => startEdit(i)}
                          disabled={!!editingId}
                        >
                          ✏️
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            if (confirm(`Xóa "${i.name}"?`)) remove(i.id);
                          }}
                        >
                          🗑️
                        </Button>
                      </div>
                    </Td>
                  </tr>
                )
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
