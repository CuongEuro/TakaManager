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
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // Sync window (days back) — keep it light, don't pull heavy old history.
  const [rangeDays, setRangeDays] = useState("7");

  // Campaign → store mapping panel state
  const [mapAccount, setMapAccount] = useState<AdAccount | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [mapDraft, setMapDraft] = useState<Record<string, string>>({}); // campaignId → storeId
  const [mapLoading, setMapLoading] = useState(false);
  const [mapSaving, setMapSaving] = useState(false);

  // Edit-account panel state
  const [editAccount, setEditAccount] = useState<AdAccount | null>(null);
  const [editForm, setEditForm] = useState({ storeId: "", name: "", externalId: "" });
  const [editCreds, setEditCreds] = useState<Record<string, string>>({});
  const [editSaving, setEditSaving] = useState(false);

  function openEdit(a: AdAccount) {
    setMapAccount(null);
    setEditAccount(a);
    setEditForm({
      storeId: a.storeId ?? "",
      name: a.name,
      externalId: a.externalId,
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
      ...creds,
    });
    setName("");
    setExternalId("");
    setCreds({});
  }

  async function action(
    endpoint: "test" | "sync",
    accountId: string
  ) {
    setBusy(accountId + endpoint);
    setMsg(null);
    try {
      const r = await fetch(`/api/ads/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          endpoint === "sync"
            ? { accountId, sinceDays: Number(rangeDays) }
            : { accountId }
        ),
      }).then((x) => x.json());
      if (endpoint === "test") {
        setMsg({ ok: r.ok, text: r.ok ? `✓ Kết nối OK: ${r.info}` : `✗ ${r.error}` });
      } else {
        const res = r.results?.[0];
        setMsg({
          ok: !!res?.ok,
          text: res?.ok
            ? `✓ Đã đồng bộ ${res.rows} dòng spend (${res.platform}).`
            : `✗ ${res?.error ?? r.error}`,
        });
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  async function syncAll() {
    setBusy("ALL");
    setMsg(null);
    try {
      const r = await fetch("/api/ads/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sinceDays: Number(rangeDays) }),
      }).then((x) => x.json());
      const ok = (r.results ?? []).filter((x: { ok: boolean }) => x.ok).length;
      setMsg({ ok: ok > 0, text: `Đồng bộ ${ok}/${r.results?.length ?? 0} tài khoản.` });
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Kết nối Ads"
        subtitle="Kết nối để TỰ ĐỘNG kéo chi phí Ads (hoặc nhập tay ở 'Chi phí Ads'). Tài khoản chạy cho 1 store → chọn Store khi thêm. Tài khoản dùng chung nhiều store (hay gặp ở Meta) → để 'Chung' rồi bấm 'Gán store' cho từng campaign."
        actions={
          <div className="flex items-end gap-2">
            <div className="w-36">
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
                </Select>
              </Field>
            </div>
            <Button onClick={syncAll} disabled={busy === "ALL"}>
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
              cho các campaign chưa gán riêng.
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
                        onClick={() => action("test", a.id)}
                        disabled={!a.configured || busy === a.id + "test"}
                      >
                        Test
                      </Button>
                      <Button
                        onClick={() => action("sync", a.id)}
                        disabled={!a.configured || busy === a.id + "sync"}
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
