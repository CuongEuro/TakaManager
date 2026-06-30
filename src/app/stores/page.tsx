"use client";

import { useState } from "react";
import Link from "next/link";
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
import { DateRangePicker, DateRange } from "@/components/DateRangePicker";

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class FatalSyncError extends Error {} // never retried (e.g. deploy not ready)

/** True if the error looks like a lost/suspended network connection (laptop
 *  sleep, wifi drop, DNS fail) rather than a server-side error. */
function isOfflineError(msg: string): boolean {
  return (
    !navigator.onLine ||
    /failed to fetch|networkerror|load failed|err_internet|err_network|err_name_not_resolved|err_connection/i.test(
      msg
    )
  );
}

/** Resolve once the browser is back online (or after maxMs as a fallback). Used
 *  to PAUSE — not fail — a sync when the connection drops mid-way. */
function waitForOnline(maxMs = 600000): Promise<void> {
  if (navigator.onLine) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener("online", finish);
      resolve();
    };
    const timer = setTimeout(finish, maxMs);
    const poll = setInterval(() => navigator.onLine && finish(), 2000);
    window.addEventListener("online", finish);
  });
}

// --- resume: remember fully-synced calendar months per store (localStorage) ---
const SYNCED_KEY = "taka:shopify-synced-months";
function loadSynced(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(SYNCED_KEY) || "{}");
  } catch {
    return {};
  }
}
function isMonthSynced(storeId: string, monthKey: string): boolean {
  return !!loadSynced()[`${storeId}|${monthKey}`];
}
function markMonthSynced(storeId: string, monthKey: string) {
  const all = loadSynced();
  all[`${storeId}|${monthKey}`] = true;
  try {
    localStorage.setItem(SYNCED_KEY, JSON.stringify(all));
  } catch {
    /* ignore quota */
  }
}

interface MonthChunk {
  key: string; // YYYY-MM
  since: Date;
  until: Date;
  fullMonth: boolean; // window fully covers this calendar month
}

/** Split [from,to] into calendar-month chunks (oldest→newest). Month keys are
 *  stable across presets, so a month synced once can be skipped on re-run. */
function buildMonthChunks(from: Date, to: Date): MonthChunk[] {
  const chunks: MonthChunk[] = [];
  let y = from.getFullYear();
  let m = from.getMonth();
  const endY = to.getFullYear();
  const endM = to.getMonth();
  while (y < endY || (y === endY && m <= endM)) {
    const monthStart = new Date(y, m, 1, 0, 0, 0, 0);
    const monthEnd = new Date(y, m + 1, 0, 23, 59, 59, 999);
    chunks.push({
      key: `${y}-${String(m + 1).padStart(2, "0")}`,
      since: monthStart < from ? from : monthStart,
      until: monthEnd > to ? to : monthEnd,
      fullMonth: from <= monthStart && to >= monthEnd,
    });
    if (++m > 11) {
      m = 0;
      y++;
    }
  }
  return chunks;
}

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Fetch ONE page. Throws on any non-OK result so the caller can retry. */
async function fetchSyncPage(body: Record<string, unknown>): Promise<PageResp> {
  const res = await fetch("/api/shopify/sync/page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404) {
    throw new FatalSyncError(
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
  return r;
}

/** Fetch a page resiliently. Re-requesting the SAME cursor is idempotent (server
 *  upserts by order id). On a lost connection we WAIT for it to return (no
 *  attempt burned) so laptop-sleep / wifi-drop resumes; transient server errors
 *  retry with backoff. */
async function fetchSyncPageRetry(
  body: Record<string, unknown>,
  onNote: (label: string) => void,
  attempts = 5
): Promise<PageResp> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fetchSyncPage(body);
    } catch (e) {
      if (e instanceof FatalSyncError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (isOfflineError(msg)) {
        onNote("mất kết nối mạng — đang chờ mạng trở lại để tiếp tục…");
        await waitForOnline();
        continue; // back online: retry the same page, no attempt consumed
      }
      attempt++;
      if (attempt >= attempts) throw e;
      onNote(`lỗi tạm thời, đang thử lại lần ${attempt}… (${msg})`);
      await sleep(1000 * attempt);
    }
  }
}

/** Sync ONE chunk (a bounded [since,until] window) page-by-page. */
async function syncChunk(
  storeId: string,
  since: Date,
  until: Date,
  finalize: boolean,
  prefix: string,
  basePercent: number,
  span: number,
  onProgress: (p: ProgressState) => void
): Promise<SyncTotals> {
  let cursor: string | null = null;
  let useJourney = true;
  let products = 0;
  let orders = 0;
  let total: number | null = null;
  let lastPct = basePercent;
  let sinceIso = "";
  const sinceStr = since.toISOString();
  const untilStr = until.toISOString();
  for (let page = 1; page <= 8000; page++) {
    const body: Record<string, unknown> = cursor
      ? { storeId, since: sinceStr, until: untilStr, cursor, useJourney, finalize }
      : { storeId, since: sinceStr, until: untilStr, finalize };
    const r = await fetchSyncPageRetry(body, (label) =>
      onProgress({ percent: lastPct, message: `${prefix}${label}` })
    );

    products += r.pageProducts;
    orders += r.pageOrders;
    sinceIso = r.since;
    useJourney = r.useJourney;
    cursor = r.cursor;
    if (r.total != null) total = r.total;

    const fraction =
      total && total > 0 ? Math.min(0.99, orders / total) : pagePct(page) / 100;
    lastPct = basePercent + Math.round(span * fraction);
    const totalNote = total && total > 0 ? `/${total}` : "";
    onProgress({
      percent: lastPct,
      message: `${prefix}đã xử lý ${orders}${totalNote} đơn…`,
    });

    if (!r.hasNext) break;
  }
  return { ok: true, products, orders, since: sinceIso, useJourney };
}

/** Sync ONE store across [from,to] by calendar-month chunks. Skips months
 *  already fully synced (unless `force`); always re-syncs the current month
 *  (fresh data). Persists each fully-covered past month so re-runs resume. */
async function syncStoreOverRange(
  storeId: string,
  from: Date,
  to: Date,
  force: boolean,
  prefix: string,
  basePercent: number,
  span: number,
  onProgress: (p: ProgressState) => void
): Promise<SyncTotals & { skipped: number }> {
  const chunks = buildMonthChunks(from, to);
  const curKey = currentMonthKey();
  const n = chunks.length;
  let products = 0;
  let orders = 0;
  let useJourney = true;
  let since = "";
  let skipped = 0;
  for (let i = 0; i < n; i++) {
    const c = chunks[i];
    const isCurrent = c.key === curKey;
    const cBase = basePercent + Math.round((span * i) / n);
    const cSpan = Math.max(1, Math.round(span / n));
    if (!force && !isCurrent && isMonthSynced(storeId, c.key)) {
      skipped++;
      onProgress({
        percent: cBase + cSpan,
        message: `${prefix}bỏ qua ${c.key} (đã đồng bộ trước đó)…`,
      });
      continue;
    }
    const t = await syncChunk(
      storeId,
      c.since,
      c.until,
      i === n - 1, // finalize (stamp + image backfill) on the newest chunk only
      `${prefix}${c.key} · `,
      cBase,
      cSpan,
      onProgress
    );
    products += t.products;
    orders += t.orders;
    useJourney = t.useJourney;
    if (!since) since = t.since;
    // Remember only fully-covered, non-current months (safe to skip next time).
    if (c.fullMonth && !isCurrent) markMonthSynced(storeId, c.key);
  }
  return { ok: true, products, orders, since, useJourney, skipped };
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
  // Khoảng ngày kéo dữ liệu — chọn qua bộ chọn ngày (preset + lịch).
  const [range, setRange] = useState<DateRange>(() => ({
    from: new Date(Date.now() - 6 * 86400000),
    to: new Date(),
  }));
  // Bỏ qua các tháng đã đồng bộ trước đó (resume). Tắt = kéo lại từ đầu.
  const [skipSynced, setSkipSynced] = useState(true);

  function rangeLabel(): string {
    return `từ ${fmtDate(range.from.toISOString())} đến ${fmtDate(
      range.to.toISOString()
    )}`;
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
      const { from, to } = range;
      const t = await syncStoreOverRange(id, from, to, !skipSynced, "", 2, 96, (p) =>
        setProgress(p)
      );
      setProgress({ percent: 100, message: "Hoàn tất" });
      const attrNote = t.useJourney ? "" : " (chưa bật phân loại kênh)";
      const skipNote = t.skipped ? ` · bỏ qua ${t.skipped} tháng đã đồng bộ` : "";
      setMsg({
        id,
        ok: true,
        text: `✓ Đã kéo ${t.products} sản phẩm & ${t.orders} đơn (${rangeLabel()})${skipNote}${attrNote}. Số liệu đã lên Dashboard.`,
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
      const { from, to } = range;
      const n = eligible.length;
      for (let i = 0; i < n; i++) {
        const s = eligible[i];
        const base = Math.round((i * 100) / n);
        const span = Math.round(100 / n);
        try {
          const t = await syncStoreOverRange(
            s.id,
            from,
            to,
            !skipSynced,
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
            <div>
              <span className="mb-1 block text-xs font-medium text-slate-500">
                Kéo dữ liệu từ
              </span>
              <DateRangePicker value={range} onChange={setRange} disabled={!!busy} />
            </div>
            <label
              className="flex items-center gap-1.5 pb-2 text-xs text-slate-600"
              title="Bỏ qua các tháng đã đồng bộ trước đó để chạy nhanh; tắt = kéo lại toàn bộ"
            >
              <input
                type="checkbox"
                checked={skipSynced}
                onChange={(e) => setSkipSynced(e.target.checked)}
                disabled={!!busy}
                className="h-3.5 w-3.5 rounded border-slate-300"
              />
              Bỏ qua tháng đã đồng bộ
            </label>
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
