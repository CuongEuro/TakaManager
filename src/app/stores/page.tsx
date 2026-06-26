"use client";

import { useState } from "react";
import { useResource } from "@/hooks/useResource";
import {
  PageHeader,
  Card,
  Button,
  Input,
  Field,
  Table,
  Th,
  Td,
  Badge,
  EmptyState,
} from "@/components/ui";
import { formatPercent } from "@/lib/format";

interface Store {
  id: string;
  name: string;
  shopifyDomain: string | null;
  shopifyClientId: string | null;
  shopifyApiVersion: string;
  currency: string;
  taxRate: number;
  active: boolean;
  lastSyncedAt: string | null;
  hasToken: boolean;
  hasClientCreds: boolean;
}

export default function StoresPage() {
  const { items, loading, create, update, remove, load } =
    useResource<Store>("/api/stores");
  const [form, setForm] = useState({
    name: "",
    domain: "",
    clientId: "",
    clientSecret: "",
    taxRate: "10",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string; ok: boolean } | null>(
    null
  );

  async function add() {
    // Cho phép bỏ trống Tên store → lấy tạm theo domain.
    const name = form.name.trim() || form.domain.trim();
    if (!name) {
      setMsg({ id: "ADD", ok: false, text: "✗ Nhập ít nhất Tên store hoặc Domain." });
      return;
    }
    setBusy("ADD");
    setMsg(null);
    try {
      const r = await create({
        name,
        shopifyDomain: form.domain.trim() || null,
        shopifyClientId: form.clientId.trim() || null,
        shopifyClientSecret: form.clientSecret.trim() || null,
        taxRate: Number(form.taxRate) / 100,
      });
      if (r && !r.ok) {
        const e = await r.json().catch(() => ({}));
        setMsg({
          id: "ADD",
          ok: false,
          text: `✗ Không tạo được store (HTTP ${r.status}): ${e.error ?? "lỗi không xác định"}`,
        });
        return;
      }
      setMsg({ id: "ADD", ok: true, text: `✓ Đã thêm store "${name}".` });
      setForm({ name: "", domain: "", clientId: "", clientSecret: "", taxRate: "10" });
    } catch (err) {
      setMsg({
        id: "ADD",
        ok: false,
        text: `✗ Lỗi mạng: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(null);
    }
  }

  async function testConn(id: string) {
    setBusy(id);
    setMsg(null);
    try {
      const r = await fetch("/api/shopify/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: id }),
      }).then((x) => x.json());
      setMsg({
        id,
        ok: r.ok,
        text: r.ok
          ? `✓ Kết nối OK: ${r.shop.name} (${r.shop.currencyCode})`
          : `✗ ${r.error}`,
      });
    } finally {
      setBusy(null);
    }
  }

  async function sync(id: string) {
    setBusy(id);
    setMsg(null);
    try {
      const r = await fetch("/api/shopify/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: id }),
      }).then((x) => x.json());
      const res = r.results?.[0];
      setMsg({
        id,
        ok: !!res?.ok,
        text: res?.ok
          ? `✓ Đã đồng bộ ${res.products} sản phẩm, ${res.orders} đơn.`
          : `✗ ${res?.error ?? r.error ?? "Lỗi không xác định"}`,
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function syncAll() {
    setBusy("ALL");
    setMsg(null);
    try {
      const r = await fetch("/api/shopify/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((x) => x.json());
      const okCount = (r.results ?? []).filter((x: { ok: boolean }) => x.ok).length;
      setMsg({
        id: "ALL",
        ok: okCount > 0,
        text: `Đồng bộ xong ${okCount}/${r.results?.length ?? 0} store.`,
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function setCreds(id: string) {
    const clientId = window.prompt(
      "Shopify Client ID (Dev Dashboard → App → Settings → Client ID):"
    );
    if (clientId === null) return;
    const clientSecret = window.prompt("Shopify Client Secret:");
    if (clientSecret === null) return;
    await update(id, {
      shopifyClientId: clientId.trim(),
      shopifyClientSecret: clientSecret.trim(),
    });
    await load();
  }

  return (
    <div>
      <PageHeader
        title="Stores"
        subtitle="Kết nối Shopify để tự động đồng bộ đơn hàng, sản phẩm & doanh thu."
        actions={
          <Button onClick={syncAll} disabled={busy === "ALL"}>
            {busy === "ALL" ? "Đang đồng bộ..." : "🔄 Đồng bộ tất cả"}
          </Button>
        }
      />

      {msg && (
        <div
          className={`mb-4 rounded-lg px-4 py-2 text-sm ${
            msg.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
          }`}
        >
          {msg.text}
        </div>
      )}

      <Card className="mb-6">
        <div className="grid gap-3 md:grid-cols-2 md:items-end">
          <Field label="Tên store">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="VD: Taka Store JP"
            />
          </Field>
          <Field label="Shopify domain">
            <Input
              value={form.domain}
              onChange={(e) => setForm({ ...form, domain: e.target.value })}
              placeholder="my-shop.myshopify.com"
            />
          </Field>
          <Field label="Client ID">
            <Input
              value={form.clientId}
              onChange={(e) => setForm({ ...form, clientId: e.target.value })}
              placeholder="Dev Dashboard → App → Settings → Client ID"
            />
          </Field>
          <Field label="Client Secret">
            <Input
              type="password"
              value={form.clientSecret}
              onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
              placeholder="Client Secret (bấm 👁 trong Dev Dashboard để xem)"
            />
          </Field>
          <Field label="Thuế (%)">
            <Input
              type="number"
              value={form.taxRate}
              onChange={(e) => setForm({ ...form, taxRate: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button onClick={add} disabled={busy === "ADD"}>
              {busy === "ADD" ? "Đang thêm..." : "+ Thêm store"}
            </Button>
          </div>
        </div>
        <div className="mt-3 space-y-1 text-xs text-slate-400">
          <p>
            💡 <b>Cách lấy Client ID / Secret (Shopify 2026):</b> token{" "}
            <code>shpat_</code> cũ đã bị Shopify ngừng. Tạo app ở{" "}
            <b>Dev Dashboard</b> (partners/dev) → mục <b>Settings</b> → copy{" "}
            <b>Client ID</b> và <b>Client Secret</b>.
          </p>
          <p>
            ⚙️ Trong app, cấp <b>Admin API scopes</b>: <code>read_orders</code>,{" "}
            <code>read_products</code>, <code>read_inventory</code>, rồi{" "}
            <b>cài (install) app lên đúng store</b> (app & store phải cùng tổ chức).
          </p>
          <p>
            🔒 Muốn biết đơn đến từ kênh nào (Facebook/Google/Klaviyo...), bật thêm{" "}
            <b>Protected customer data access</b> cho app. Chưa bật vẫn đồng bộ
            được doanh thu/sản phẩm, chỉ thiếu phần phân loại kênh.
          </p>
        </div>
      </Card>

      <Card>
        {loading ? (
          <EmptyState message="Đang tải..." />
        ) : items.length === 0 ? (
          <EmptyState message="Chưa có store nào." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Tên</Th>
                <Th>Domain</Th>
                <Th>Kết nối</Th>
                <Th>Đồng bộ lần cuối</Th>
                <Th>Thuế</Th>
                <Th className="text-right">Thao tác</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium text-slate-800">{s.name}</Td>
                  <Td className="text-slate-500">{s.shopifyDomain || "—"}</Td>
                  <Td>
                    {s.hasClientCreds ? (
                      <Badge tone="green">Có Client ID/Secret</Badge>
                    ) : s.hasToken ? (
                      <Badge tone="green">Có token (cũ)</Badge>
                    ) : (
                      <Badge tone="amber">Chưa có khoá</Badge>
                    )}
                  </Td>
                  <Td className="text-slate-500">
                    {s.lastSyncedAt
                      ? new Date(s.lastSyncedAt).toLocaleString("vi-VN")
                      : "—"}
                  </Td>
                  <Td>{formatPercent(s.taxRate)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="secondary"
                        onClick={() => setCreds(s.id)}
                        title="Cập nhật Client ID + Secret"
                      >
                        🔑
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => testConn(s.id)}
                        disabled={busy === s.id || !(s.hasToken || s.hasClientCreds)}
                      >
                        Test
                      </Button>
                      <Button
                        onClick={() => sync(s.id)}
                        disabled={busy === s.id || !(s.hasToken || s.hasClientCreds)}
                      >
                        {busy === s.id ? "..." : "Sync"}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (confirm(`Xóa store "${s.name}"?`)) remove(s.id);
                        }}
                      >
                        🗑️
                      </Button>
                    </div>
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
