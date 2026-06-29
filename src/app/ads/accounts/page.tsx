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

interface AdAccount {
  id: string;
  storeId: string | null;
  storeName: string | null;
  platform: string;
  name: string;
  externalId: string;
  active: boolean;
  taxRate: number;
  lastSyncedAt: string | null;
  configured: boolean;
  campaignCount: number;
  mappedCount: number;
}
interface Store {
  id: string;
  name: string;
}
interface Campaign {
  id: string;
  externalId: string;
  name: string;
  storeId: string | null;
  status: string | null;
}
interface SyncResult {
  accountId: string;
  name: string;
  platform: string;
  rows: number;
  since: string; // ISO start of the synced window
  ok: boolean;
  error?: string;
}

function fmtDay(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("vi-VN");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Calendar date (YYYY-MM-DD) in the BROWSER's local tz — not UTC — so day
// boundaries match what the user sees and align with server-side bucketing.
const dayStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

/** Split [from, to] into ≤maxDays day-aligned chunks (oldest → newest). Long
 * windows are synced chunk-by-chunk so no single request times out. */
function buildChunks(
  from: Date,
  to: Date,
  maxDays = 30
): { since: Date; until: Date }[] {
  const chunks: { since: Date; until: Date }[] = [];
  let s = startOfDay(from);
  const end = startOfDay(to);
  while (s.getTime() <= end.getTime()) {
    const u = new Date(s);
    u.setDate(u.getDate() + maxDays - 1);
    if (u.getTime() > end.getTime()) u.setTime(end.getTime());
    chunks.push({ since: new Date(s), until: new Date(u) });
    s = new Date(u);
    s.setDate(s.getDate() + 1);
  }
  return chunks;
}

/** Resolve the {from,to} window from the picker (preset days or custom dates). */
function resolveRange(
  rangeDays: string,
  customFrom: string,
  customTo: string
): { from: Date; to: Date } | null {
  if (rangeDays === "custom") {
    if (!customFrom || !customTo) return null;
    const from = new Date(customFrom);
    const to = new Date(customTo);
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) return null;
    return { from, to };
  }
  const days = Number(rangeDays);
  return { from: new Date(Date.now() - days * 86400000), to: new Date() };
}

const CRED_FIELDS: Record<string, { key: string; label: string }[]> = {
  FACEBOOK: [{ key: "accessToken", label: "Access Token" }],
  GOOGLE: [
    { key: "developerToken", label: "Developer Token" },
    { key: "clientId", label: "OAuth Client ID" },
    { key: "clientSecret", label: "OAuth Client Secret" },
    { key: "refreshToken", label: "Refresh Token" },
    { key: "loginCustomerId", label: "Login Customer ID (MCC, tuỳ chọn)" },
  ],
  TWITTER: [
    { key: "apiKey", label: "API Key (Consumer Key)" },
    { key: "apiSecret", label: "API Secret" },
    { key: "accessToken", label: "Access Token" },
    { key: "accessSecret", label: "Access Token Secret" },
  ],
};

const EXTID_LABEL: Record<string, string> = {
  FACEBOOK: "Ad Account ID (act_…)",
  GOOGLE: "Customer ID (123-456-7890)",
  TWITTER: "Ads Account ID",
};

const PLATFORMS = AD_PLATFORMS.filter((p) => p !== "OTHER");

export default function AdAccountsPage() {
  const { items, loading, create, remove, load } =
    useResource<AdAccount>("/api/ads/accounts");
  const { items: stores } = useResource<Store>("/api/stores");

  const [platform, setPlatform] = useState("FACEBOOK");
  const [storeId, setStoreId] = useState("");
  const [name, setName] = useState("");
  const [externalId, setExternalId] = useState("");
  const [tax, setTax] = useState("10"); // % thuế, mặc định 10%
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // Sync window. Presets are "days back"; "custom" uses the date inputs below.
  const [rangeDays, setRangeDays] = useState("7");
  const [customFrom, setCustomFrom] = useState(() =>
    dayStr(new Date(Date.now() - 90 * 86400000))
  );
  const [customTo, setCustomTo] = useState(() => dayStr(new Date()));
  // Bulk-sync progress + per-account results (browser-driven, one account at a time).
  const [syncProg, setSyncProg] = useState<{ done: number; total: number } | null>(null);
  const [syncResults, setSyncResults] = useState<SyncResult[]>([]);

  // Campaign → store mapping panel state
  const [mapAccount, setMapAccount] = useState<AdAccount | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [mapDraft, setMapDraft] = useState<Record<string, string>>({}); // campaignId → storeId
  const [mapLoading, setMapLoading] = useState(false);
  const [mapSaving, setMapSaving] = useState(false);

  // Edit-account panel state
  const [editAccount, setEditAccount] = useState<AdAccount | null>(null);
  const [editForm, setEditForm] = useState({
    storeId: "",
    name: "",
    externalId: "",
    tax: "",
  });
  const [editCreds, setEditCreds] = useState<Record<string, string>>({});
  const [editSaving, setEditSaving] = useState(false);

  function openEdit(a: AdAccount) {
    setMapAccount(null);
    setEditAccount(a);
    setEditForm({
      storeId: a.storeId ?? "",
      name: a.name,
      externalId: a.externalId,
      tax: String(+((a.taxRate ?? 0) * 100).toFixed(2)),
    });
    setEditCreds({});
  }

  async function saveEdit() {
    if (!editAccount || !editForm.name.trim() || !editForm.externalId.trim()) return;
    setEditSaving(true);
    setMsg(null);
    try {
      // Only send creds the user actually typed (blank = keep existing).
      const creds = Object.fromEntries(
        Object.entries(editCreds).filter(([, v]) => v.trim() !== "")
      );
      const r = await fetch(`/api/ads/accounts/${editAccount.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId: editForm.storeId || null,
          name: editForm.name.trim(),
          externalId: editForm.externalId.trim(),
          taxRate: (Number(editForm.tax) || 0) / 100,
          ...creds,
        }),
      });
      setMsg(
        r.ok
          ? { ok: true, text: `✓ Đã cập nhật tài khoản "${editForm.name.trim()}".` }
          : { ok: false, text: `✗ Cập nhật thất bại (HTTP ${r.status}).` }
      );
      setEditAccount(null);
      await load();
    } finally {
      setEditSaving(false);
    }
  }

  async function openMapping(a: AdAccount) {
    setEditAccount(null);
    setMapAccount(a);
    setCampaigns([]);
    setMapDraft({});
    setMapLoading(true);
    try {
      const r = await fetch(`/api/ads/accounts/${a.id}/campaigns`).then((x) => x.json());
      const list: Campaign[] = r.campaigns ?? [];
      setCampaigns(list);
      setMapDraft(Object.fromEntries(list.map((c) => [c.id, c.storeId ?? ""])));
    } finally {
      setMapLoading(false);
    }
  }

  async function saveMapping() {
    if (!mapAccount) return;
    setMapSaving(true);
    setMsg(null);
    try {
      const mappings = campaigns.map((c) => ({ id: c.id, storeId: mapDraft[c.id] || null }));
      const r = await fetch(`/api/ads/accounts/${mapAccount.id}/campaigns`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings }),
      }).then((x) => x.json());
      setMsg({
        ok: !!r.ok,
        text: r.ok
          ? r.resync?.ok
            ? "✓ Đã gán campaign → store và đồng bộ lại chi phí."
            : `✓ Đã lưu mapping. ⚠️ Đồng bộ lại lỗi: ${r.resync?.error ?? "?"} (bấm Sync lại sau).`
          : `✗ ${r.error ?? "Lưu mapping thất bại"}`,
      });
      setMapAccount(null);
      await load();
    } finally {
      setMapSaving(false);
    }
  }

  async function add() {
    if (!name.trim() || !externalId.trim()) return;
    await create({
      platform,
      storeId: storeId || null,
      name: name.trim(),
      externalId: externalId.trim(),
      taxRate: (Number(tax) || 0) / 100,
      ...creds,
    });
    setName("");
    setExternalId("");
    setTax("10");
    setCreds({});
  }

  async function testAccount(accountId: string) {
    setBusy(accountId + "test");
    setMsg(null);
    try {
      const r = await fetch("/api/ads/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      }).then((x) => x.json());
      setMsg({ ok: r.ok, text: r.ok ? `✓ Kết nối OK: ${r.info}` : `✗ ${r.error}` });
    } finally {
      setBusy(null);
    }
  }

  // Sync ONE chunk (a sub-window) with auto-retry. Throws if it keeps failing.
  async function syncChunkRetry(
    accountId: string,
    since: Date,
    until: Date,
    attempts = 3
  ): Promise<SyncResult> {
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        const r = await fetch("/api/ads/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId,
            since: dayStr(since), // calendar dates → server buckets by day
            until: dayStr(until),
          }),
        }).then((x) => x.json());
        const res: SyncResult | undefined = r.results?.[0];
        if (!res || !res.ok) throw new Error(res?.error ?? r.error ?? "Đồng bộ lỗi");
        return res;
      } catch (e) {
        lastErr = e;
        if (i < attempts) await sleep(700 * i); // backoff before auto-retry
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // Sync one account over [from,to] by chunking. Failed chunks auto-retry; if a
  // chunk still fails it is reported but other chunks proceed (no data loss for
  // the parts that succeeded — each chunk is idempotent server-side).
  async function syncAccountRange(
    a: AdAccount,
    from: Date,
    to: Date,
    onStep: () => void
  ): Promise<SyncResult> {
    let rows = 0;
    let ok = true;
    let error: string | undefined;
    for (const c of buildChunks(from, to)) {
      try {
        const res = await syncChunkRetry(a.id, c.since, c.until);
        rows += res.rows;
      } catch (e) {
        ok = false;
        const m = e instanceof Error ? e.message : String(e);
        error = `Lỗi khoảng ${fmtDay(c.since.toISOString())}–${fmtDay(
          c.until.toISOString()
        )}: ${m}`;
      }
      onStep();
    }
    return {
      accountId: a.id,
      name: a.name,
      platform: a.platform,
      rows,
      since: from.toISOString(),
      ok,
      error,
    };
  }

  async function syncOne(a: AdAccount) {
    const range = resolveRange(rangeDays, customFrom, customTo);
    if (!range) {
      setMsg({ ok: false, text: "Chọn 'Từ ngày' và 'Đến ngày' hợp lệ." });
      return;
    }
    setBusy(a.id + "sync");
    setMsg(null);
    setSyncResults([]);
    const total = buildChunks(range.from, range.to).length;
    let done = 0;
    setSyncProg({ done: 0, total });
    const res = await syncAccountRange(a, range.from, range.to, () => {
      done++;
      setSyncProg({ done, total });
    });
    setSyncResults([res]);
    setMsg({
      ok: res.ok,
      text: res.ok
        ? `✓ ${res.name}: ${res.rows} dòng, từ ${fmtDay(
            range.from.toISOString()
          )} → ${fmtDay(range.to.toISOString())} (${res.platform}).`
        : `✗ ${res.error}`,
    });
    setBusy(null);
    await load();
  }

  async function syncAll() {
    // Browser-driven: each account synced chunk-by-chunk with auto-retry → live
    // progress, per-account results, no long single request that can time out.
    const range = resolveRange(rangeDays, customFrom, customTo);
    if (!range) {
      setMsg({ ok: false, text: "Chọn 'Từ ngày' và 'Đến ngày' hợp lệ." });
      return;
    }
    const targets = items.filter((a) => a.configured && a.active);
    if (targets.length === 0) {
      setMsg({ ok: false, text: "Không có tài khoản đủ khoá để đồng bộ." });
      return;
    }
    setBusy("ALL");
    setMsg(null);
    setSyncResults([]);
    const chunksPer = buildChunks(range.from, range.to).length;
    const total = targets.length * chunksPer;
    let done = 0;
    setSyncProg({ done: 0, total });
    const collected: SyncResult[] = [];
    for (const a of targets) {
      const res = await syncAccountRange(a, range.from, range.to, () => {
        done++;
        setSyncProg({ done, total });
      });
      collected.push(res);
      setSyncResults([...collected]);
    }
    const ok = collected.filter((r) => r.ok).length;
    setMsg({
      ok: ok === targets.length,
      text: `Hoàn tất: ${ok}/${targets.length} tài khoản · ${fmtDay(
        range.from.toISOString()
      )} → ${fmtDay(range.to.toISOString())}.`,
    });
    setBusy(null);
    await load();
  }

  return (
    <div>
      <PageHeader
        title="Kết nối Ads"
        subtitle="Kết nối để TỰ ĐỘNG kéo chi phí Ads (hoặc nhập tay ở 'Chi phí Ads'). Tài khoản chạy cho 1 store → chọn Store khi thêm. Tài khoản dùng chung nhiều store (hay gặp ở Meta) → để 'Chung' rồi bấm 'Gán store' cho từng campaign."
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-40">
              <Field label="Kéo dữ liệu">
                <Select
                  value={rangeDays}
                  onChange={(e) => setRangeDays(e.target.value)}
                  disabled={!!busy}
                >
                  <option value="0">Hôm nay</option>
                  <option value="1">Hôm qua → nay</option>
                  <option value="7">7 ngày</option>
                  <option value="30">30 ngày</option>
                  <option value="60">60 ngày</option>
                  <option value="90">90 ngày</option>
                  <option value="365">1 năm</option>
                  <option value="custom">Tuỳ chọn ngày…</option>
                </Select>
              </Field>
            </div>
            {rangeDays === "custom" && (
              <>
                <div className="w-40">
                  <Field label="Từ ngày">
                    <Input
                      type="date"
                      value={customFrom}
                      max={customTo}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      disabled={!!busy}
                    />
                  </Field>
                </div>
                <div className="w-40">
                  <Field label="Đến ngày">
                    <Input
                      type="date"
                      value={customTo}
                      max={dayStr(new Date())}
                      onChange={(e) => setCustomTo(e.target.value)}
                      disabled={!!busy}
                    />
                  </Field>
                </div>
              </>
            )}
            <Button onClick={syncAll} disabled={!!busy}>
              {busy === "ALL" && syncProg
                ? `Đang đồng bộ ${syncProg.done}/${syncProg.total}...`
                : "🔄 Đồng bộ tất cả"}
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

      {(syncProg || syncResults.length > 0) && (
        <Card className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-700">
              Kết quả đồng bộ{" "}
              {syncProg ? `· ${syncProg.done}/${syncProg.total} phần` : ""}
            </div>
            {!busy && (
              <button
                onClick={() => {
                  setSyncResults([]);
                  setSyncProg(null);
                }}
                className="text-sm text-slate-400 hover:text-slate-600"
              >
                ✗ Đóng
              </button>
            )}
          </div>
          {syncProg && (
            <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full bg-brand-500 transition-all"
                style={{ width: `${(syncProg.done / syncProg.total) * 100}%` }}
              />
            </div>
          )}
          <div className="space-y-1">
            {syncResults.map((r) => (
              <div
                key={r.accountId}
                className="flex items-center justify-between gap-3 rounded-md px-3 py-1.5 text-sm odd:bg-slate-50"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span>{r.ok ? "✅" : "❌"}</span>
                  <span className="truncate font-medium text-slate-700">{r.name}</span>
                  <Badge tone="blue">
                    {AD_PLATFORM_LABELS[r.platform] ?? r.platform}
                  </Badge>
                </span>
                <span
                  className={`max-w-[55%] truncate text-right ${
                    r.ok ? "text-slate-500" : "text-rose-600"
                  }`}
                  title={r.ok ? "" : r.error}
                >
                  {r.ok
                    ? `${r.rows} dòng · từ ${fmtDay(r.since)} → nay`
                    : r.error}
                </span>
              </div>
            ))}
            {busy === "ALL" && syncProg && syncProg.done < syncProg.total && (
              <div className="px-3 py-1.5 text-sm text-slate-400">
                Đang xử lý tài khoản tiếp theo…
              </div>
            )}
          </div>
        </Card>
      )}

      {editAccount && (
        <Card className="mb-6 border-brand-200">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-700">
              Sửa tài khoản · {AD_PLATFORM_LABELS[editAccount.platform] ?? editAccount.platform}
            </div>
            <button
              onClick={() => setEditAccount(null)}
              className="text-sm text-slate-400 hover:text-slate-600"
            >
              ✗ Đóng
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Store">
              <Select
                value={editForm.storeId}
                onChange={(e) => setEditForm({ ...editForm, storeId: e.target.value })}
              >
                <option value="">— Chung —</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tên gợi nhớ">
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
            </Field>
            <Field label={EXTID_LABEL[editAccount.platform]}>
              <Input
                value={editForm.externalId}
                onChange={(e) => setEditForm({ ...editForm, externalId: e.target.value })}
              />
            </Field>
            <Field label="Thuế (%)">
              <Input
                type="number"
                value={editForm.tax}
                onChange={(e) => setEditForm({ ...editForm, tax: e.target.value })}
                placeholder="10"
              />
            </Field>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {(CRED_FIELDS[editAccount.platform] ?? []).map((f) => (
              <Field key={f.key} label={f.label}>
                <Input
                  type="password"
                  value={editCreds[f.key] ?? ""}
                  onChange={(e) => setEditCreds({ ...editCreds, [f.key]: e.target.value })}
                  placeholder="để trống = giữ nguyên"
                  autoComplete="off"
                />
              </Field>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs text-slate-400">
              Khoá để trống sẽ giữ nguyên giá trị cũ. Đổi Store ở đây = store mặc định
              cho các campaign chưa gán riêng. Đổi <b>Thuế (%)</b> → bấm <b>Sync</b> lại
              để áp dụng vào chi phí.
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setEditAccount(null)}>
                Huỷ
              </Button>
              <Button onClick={saveEdit} disabled={editSaving}>
                {editSaving ? "Đang lưu..." : "✓ Lưu thay đổi"}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {mapAccount && (
        <Card className="mb-6 border-brand-200">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-700">
              Gán campaign → store · {mapAccount.name}
            </div>
            <button
              onClick={() => setMapAccount(null)}
              className="text-sm text-slate-400 hover:text-slate-600"
            >
              ✗ Đóng
            </button>
          </div>
          {mapLoading ? (
            <EmptyState message="Đang tải campaign..." />
          ) : campaigns.length === 0 ? (
            <EmptyState message="Chưa có campaign — bấm Sync tài khoản này trước rồi quay lại gán." />
          ) : (
            <>
              <p className="mb-3 text-xs text-slate-400">
                Mỗi campaign gán cho 1 store → chi phí campaign đó tính vào store đó.
                {mapAccount.storeId
                  ? ` Để trống = theo store mặc định của tài khoản (${mapAccount.storeName}).`
                  : " Để trống = chưa gán (chỉ vào tổng “Tất cả store”)."}{" "}
                Lưu xong hệ thống tự đồng bộ lại chi phí.
              </p>
              <div className="max-h-80 space-y-2 overflow-y-auto">
                {campaigns.map((c) => (
                  <div
                    key={c.id}
                    className="grid grid-cols-[1fr_220px] items-center gap-3"
                  >
                    <div className="truncate text-sm text-slate-700" title={c.name}>
                      {c.name}
                    </div>
                    <Select
                      value={mapDraft[c.id] ?? ""}
                      onChange={(e) =>
                        setMapDraft({ ...mapDraft, [c.id]: e.target.value })
                      }
                    >
                      <option value="">
                        {mapAccount.storeId
                          ? `— Mặc định: ${mapAccount.storeName} —`
                          : "— Chưa gán (tổng chung) —"}
                      </option>
                      {stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setMapAccount(null)}>
                  Huỷ
                </Button>
                <Button onClick={saveMapping} disabled={mapSaving}>
                  {mapSaving ? "Đang lưu & đồng bộ..." : "✓ Lưu & đồng bộ lại"}
                </Button>
              </div>
            </>
          )}
        </Card>
      )}

      <Card className="mb-6">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Nền tảng">
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {AD_PLATFORM_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Store (tuỳ chọn)">
            <Select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              <option value="">— Chung —</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tên gợi nhớ">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: FB - Anime" />
          </Field>
          <Field label={EXTID_LABEL[platform]}>
            <Input
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
            />
          </Field>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <Field label="Thuế (%)">
            <Input
              type="number"
              value={tax}
              onChange={(e) => setTax(e.target.value)}
              placeholder="10"
            />
          </Field>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {CRED_FIELDS[platform].map((f) => (
            <Field key={f.key} label={f.label}>
              <Input
                type="password"
                value={creds[f.key] ?? ""}
                onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })}
                autoComplete="off"
              />
            </Field>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-slate-400">
            🔒 Credentials lưu cục bộ trong DB. Trên cloud nên dùng secrets manager.
            {platform === "GOOGLE" &&
              " Google Ads cần OAuth refresh token + developer token đã được duyệt."}
            {platform === "TWITTER" && " X Ads dùng OAuth 1.0a (4 khoá)."}
          </p>
          <Button onClick={add}>+ Thêm tài khoản</Button>
        </div>
      </Card>

      <Card>
        {loading ? (
          <EmptyState message="Đang tải..." />
        ) : items.length === 0 ? (
          <EmptyState message="Chưa có tài khoản Ads nào." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Nền tảng</Th>
                <Th>Tên</Th>
                <Th>Account ID</Th>
                <Th>Store</Th>
                <Th>Thuế</Th>
                <Th>Cấu hình</Th>
                <Th>Sync lần cuối</Th>
                <Th className="text-right">Thao tác</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <Td>
                    <Badge tone="blue">{AD_PLATFORM_LABELS[a.platform] ?? a.platform}</Badge>
                  </Td>
                  <Td className="font-medium text-slate-800">{a.name}</Td>
                  <Td className="text-slate-500">{a.externalId}</Td>
                  <Td className="text-slate-500">
                    <div className="flex flex-col items-start gap-0.5">
                      <span>{a.storeName ?? "Chung"}</span>
                      {a.mappedCount > 0 && (
                        <Badge tone="green">
                          {a.mappedCount}/{a.campaignCount} campaign gán riêng
                        </Badge>
                      )}
                      {/* Only warn when the account has no default store AND nothing mapped */}
                      {!a.storeId && a.mappedCount === 0 && a.campaignCount > 0 && (
                        <Badge tone="amber">Chưa gán campaign nào</Badge>
                      )}
                    </div>
                  </Td>
                  <Td className="text-slate-500">
                    {(a.taxRate * 100).toFixed(a.taxRate * 100 % 1 === 0 ? 0 : 1)}%
                  </Td>
                  <Td>
                    {a.configured ? (
                      <Badge tone="green">Đủ khoá</Badge>
                    ) : (
                      <Badge tone="amber">Thiếu khoá</Badge>
                    )}
                  </Td>
                  <Td className="text-slate-500">
                    {a.lastSyncedAt
                      ? new Date(a.lastSyncedAt).toLocaleString("vi-VN")
                      : "—"}
                  </Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="secondary"
                        onClick={() => openEdit(a)}
                        title="Sửa Store / tên / khoá"
                      >
                        ✏️
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => openMapping(a)}
                        title="Gán campaign → store"
                      >
                        Gán store
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => testAccount(a.id)}
                        disabled={!a.configured || !!busy}
                      >
                        {busy === a.id + "test" ? "..." : "Test"}
                      </Button>
                      <Button
                        onClick={() => syncOne(a)}
                        disabled={!a.configured || !!busy}
                      >
                        {busy === a.id + "sync" ? "..." : "Sync"}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (confirm(`Xóa "${a.name}"?`)) remove(a.id);
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
