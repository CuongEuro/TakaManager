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
}
interface Store {
  id: string;
  name: string;
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
        body: JSON.stringify({ accountId }),
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
        body: JSON.stringify({}),
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
        subtitle="Tự động kéo chi phí quảng cáo từ Meta / Google / X về để tính ROAS theo kênh."
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
                  <Td className="text-slate-500">{a.storeName ?? "Chung"}</Td>
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
