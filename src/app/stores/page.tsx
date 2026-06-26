"use client";

import { useState } from "react";
import Link from "next/link";
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
import { formatPercent } from "@/lib/format";

interface SyncTotals {
  ok: boolean;
  products: number;
  orders: number;
  since: string;
  useJourney: boolean;
}

interface ProgressState {
  percent: number;
  message: string;
}

interface PageResp {
  ok: boolean;
  since: string;
  cursor: string | null;
  hasNext: boolean;
  pageProducts: number;
  pageOrders: number;
  useJourney: boolean;
  total: number | null;
  error?: string;
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("vi-VN");
}

// Unknown total → asymptotic bar that approaches (but never hits) `cap` by page.
function pagePct(page: number, cap = 92): number {
  return Math.min(cap, Math.round(cap * (1 - Math.pow(0.78, page))));
}

/** Sync ONE store by looping the per-page endpoint until done. Each request is
 *  small, so it can never hit the serverless time limit. `prefix` labels the
 *  progress message (used when syncing several stores). */
async function syncStorePaged(
  storeId: string,
  sincePayload: Record<string, unknown>,
  prefix: string,
  basePercent: number,
  span: number,
  onProgress: (p: ProgressState) => void
): Promise<SyncTotals> {
  let cursor: string | null = null;
  let since: string | undefined;
  let useJourney = true;
  let products = 0;
  let orders = 0;
  let page = 0;
  let total: number | null = null;
  // hard cap pages to avoid an infinite loop on a misbehaving cursor
  for (page = 1; page <= 4000; page++) {
    const body: Record<string, unknown> = cursor
      ? { storeId, since, cursor, useJourney }
      : { storeId, ...sincePayload };
    const res = await fetch("/api/shopify/sync/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 404) {
      throw new Error(
        "Phiên bản mới chưa sẵn sàng (HTTP 404). Chờ Vercel deploy 'Ready' rồi " +
          "tải lại trang (Ctrl+Shift+R) và thử lại."
      );
    }
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error ?? `HTTP ${res.status}`);
    }
    const r: PageResp = await res.json();
    if (!r.ok) throw new Error(r.error ?? "Lỗi không xác định");

    products += r.pageProducts;
    orders += r.pageOrders;
    since = r.since;
    useJourney = r.useJourney;
    cursor = r.cursor;
    if (r.total != null) total = r.total;

    // Accurate fraction when we know the total; otherwise an asymptotic estimate.
    const fraction =
      total && total > 0
        ? Math.min(0.99, orders / total)
        : pagePct(page) / 100;
    const pct = basePercent + Math.round(span * fraction);
    const totalNote = total && total > 0 ? `/${total}` : "";
    onProgress({ percent: pct, message: `${prefix}đã xử lý ${orders}${totalNote} đơn…` });

    if (!r.hasNext) break;
  }
  return { ok: true, products, orders, since: since ?? "", useJourney };
}

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
  webhooksEnabled: boolean;
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
  const [progress, setProgress] = useState<ProgressState | null>(null);
  // Khoảng ngày kéo dữ liệu (đến hôm nay): preset số ngày hoặc "custom".
  const [rangeMode, setRangeMode] = useState("7");
  const [customDate, setCustomDate] = useState("");

  function sincePayload(): Record<string, unknown> {
    if (rangeMode === "custom")
      return customDate
        ? { since: new Date(customDate + "T00:00:00").toISOString() }
        : { sinceDays: 7 };
    return { sinceDays: Number(rangeMode) };
  }

  function rangeLabel(): string {
    if (rangeMode === "custom")
      return customDate ? `từ ${fmtDate(customDate)} đến hôm nay` : "7 ngày qua";
    return `${rangeMode} ngày qua`;
  }

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
    setProgress({ percent: 2, message: "Bắt đầu…" });
    try {
      const t = await syncStorePaged(id, sincePayload(), "", 2, 96, (p) =>
        setProgress(p)
      );
      setProgress({ percent: 100, message: "Hoàn tất" });
      const attrNote = t.useJourney ? "" : " (chưa bật phân loại kênh)";
      setMsg({
        id,
        ok: true,
        text: `✓ Đã kéo ${t.products} sản phẩm & ${t.orders} đơn (${rangeLabel()}, từ ${fmtDate(
          t.since
        )} → hôm nay)${attrNote}. Số liệu đã lên Dashboard.`,
      });
      await load();
    } catch (e) {
      setMsg({ id, ok: false, text: `✗ ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function syncAll() {
    setBusy("ALL");
    setMsg(null);
    setProgress({ percent: 1, message: "Bắt đầu…" });
    try {
      const eligible = items.filter((s) => s.hasToken || s.hasClientCreds);
      if (eligible.length === 0) {
        setMsg({ id: "ALL", ok: false, text: "✗ Chưa có store nào có khoá kết nối." });
        return;
      }
      let okCount = 0;
      let totProducts = 0;
      let totOrders = 0;
      const n = eligible.length;
      for (let i = 0; i < n; i++) {
        const s = eligible[i];
        const base = Math.round((i * 100) / n);
        const span = Math.round(100 / n);
        try {
          const t = await syncStorePaged(
            s.id,
            sincePayload(),
            `[${i + 1}/${n}] ${s.name}: `,
            base,
            span,
            (p) => setProgress(p)
          );
          okCount++;
          totProducts += t.products;
          totOrders += t.orders;
        } catch (e) {
          // keep going with the other stores; report at the end
          setMsg({
            id: "ALL",
            ok: false,
            text: `⚠️ ${s.name}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      setProgress({ percent: 100, message: "Hoàn tất" });
      setMsg({
        id: "ALL",
        ok: okCount > 0,
        text: `✓ Đồng bộ ${okCount}/${n} store — tổng ${totProducts} sản phẩm, ${totOrders} đơn (${rangeLabel()}). Xem ở Dashboard.`,
      });
      await load();
    } catch (e) {
      setMsg({ id: "ALL", ok: false, text: `✗ ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function enableWebhooks(id: string) {
    setBusy(id);
    setMsg(null);
    try {
      const r = await fetch("/api/shopify/webhook/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: id }),
      }).then((x) => x.json());
      setMsg({
        id,
        ok: !!r.ok,
        text: r.ok
          ? "✓ Đã bật tự động đồng bộ (webhook): đơn mới/cập nhật từ Shopify sẽ tự về, không cần bấm Sync."
          : `✗ ${r.error ?? "Không bật được webhook"}`,
      });
      await load();
    } catch (e) {
      setMsg({ id, ok: false, text: `✗ ${e instanceof Error ? e.message : String(e)}` });
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
        subtitle="Kết nối Shopify → bấm Sync để kéo đơn/sản phẩm về; số liệu hiển thị ở Dashboard."
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-40">
              <Field label="Kéo dữ liệu từ">
                <Select
                  value={rangeMode}
                  onChange={(e) => setRangeMode(e.target.value)}
                  disabled={!!busy}
                >
                  <option value="1">1 ngày (hôm nay)</option>
                  <option value="3">3 ngày qua</option>
                  <option value="7">7 ngày qua</option>
                  <option value="30">30 ngày qua</option>
                  <option value="60">60 ngày qua</option>
                  <option value="custom">Từ ngày cụ thể…</option>
                </Select>
              </Field>
            </div>
            {rangeMode === "custom" && (
              <div className="w-40">
                <Field label="Từ ngày">
                  <Input
                    type="date"
                    value={customDate}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setCustomDate(e.target.value)}
                    disabled={!!busy}
                  />
                </Field>
              </div>
            )}
            <Link
              href="/"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              📊 Xem Dashboard
            </Link>
            <Button onClick={syncAll} disabled={!!busy}>
              {busy === "ALL" ? "Đang đồng bộ..." : "🔄 Đồng bộ tất cả"}
            </Button>
          </div>
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

      {progress && (
        <div className="mb-4 rounded-lg border border-brand-100 bg-brand-50 px-4 py-3">
          <div className="mb-1 flex items-center justify-between text-xs text-slate-600">
            <span className="truncate pr-3">{progress.message}</span>
            <span className="font-semibold tabular-nums">{progress.percent}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-brand-600 transition-all duration-300"
              style={{ width: `${Math.min(100, Math.max(2, progress.percent))}%` }}
            />
          </div>
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
            <code>read_products</code> (KHÔNG cần <code>read_inventory</code>), rồi{" "}
            <b>cài (install) app lên đúng store</b> (app & store phải cùng tổ chức).
          </p>
          <p>
            📦 Hệ thống chỉ lấy <b>tiêu đề + 1 ảnh</b> của sản phẩm từ các đơn trong
            khoảng ngày đã chọn (không kéo toàn bộ catalog) → nhanh & nhẹ. Giá vốn
            (COGS) khai ở mục <b>Biến đổi A</b>.
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
                    <div className="flex flex-wrap items-center gap-1">
                      {s.hasClientCreds ? (
                        <Badge tone="green">Có Client ID/Secret</Badge>
                      ) : s.hasToken ? (
                        <Badge tone="green">Có token (cũ)</Badge>
                      ) : (
                        <Badge tone="amber">Chưa có khoá</Badge>
                      )}
                      {s.webhooksEnabled && <Badge tone="blue">🔔 Tự động</Badge>}
                    </div>
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
                        disabled={!!busy}
                        title="Cập nhật Client ID + Secret"
                      >
                        🔑
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => testConn(s.id)}
                        disabled={!!busy || !(s.hasToken || s.hasClientCreds)}
                      >
                        Test
                      </Button>
                      <Button
                        onClick={() => sync(s.id)}
                        disabled={!!busy || !(s.hasToken || s.hasClientCreds)}
                      >
                        {busy === s.id ? "..." : "Sync"}
                      </Button>
                      <Button
                        variant={s.webhooksEnabled ? "secondary" : "primary"}
                        onClick={() => enableWebhooks(s.id)}
                        disabled={!!busy || !s.hasClientCreds}
                        title={
                          s.webhooksEnabled
                            ? "Tự động đang bật — bấm để đăng ký lại"
                            : "Bật tự động đồng bộ đơn (webhook)"
                        }
                      >
                        {s.webhooksEnabled ? "🔔 Đang bật" : "🔔 Tự động"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!!busy}
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
