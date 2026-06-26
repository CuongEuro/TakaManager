"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, Button, Input, Field } from "@/components/ui";

export default function SignupPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    orgName: "",
    inviteCode: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set(k: string, v: string) {
    setForm({ ...form, [k]: v });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const body =
      mode === "join"
        ? { name: form.name, email: form.email, password: form.password, inviteCode: form.inviteCode }
        : { name: form.name, email: form.email, password: form.password, orgName: form.orgName };
    const r = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(d.error || "Đăng ký thất bại");
      setBusy(false);
      return;
    }
    router.replace("/");
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 text-center">
        <div className="text-2xl font-bold text-slate-900">
          Taka<span className="text-brand-600">Manager</span>
        </div>
        <div className="mt-1 text-sm text-slate-400">Tạo tài khoản</div>
      </div>
      <Card>
        <div className="mb-4 flex rounded-lg border border-slate-200 p-1">
          <button
            type="button"
            onClick={() => setMode("create")}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium ${
              mode === "create" ? "bg-brand-600 text-white" : "text-slate-500"
            }`}
          >
            Tạo workspace mới
          </button>
          <button
            type="button"
            onClick={() => setMode("join")}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium ${
              mode === "join" ? "bg-brand-600 text-white" : "text-slate-500"
            }`}
          >
            Tham gia bằng mã mời
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <Field label="Tên của bạn">
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              autoComplete="email"
              required
            />
          </Field>
          <Field label="Mật khẩu (tối thiểu 8 ký tự)">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          {mode === "create" ? (
            <Field label="Tên workspace (tuỳ chọn)">
              <Input
                value={form.orgName}
                onChange={(e) => set("orgName", e.target.value)}
                placeholder="VD: Taka POD"
              />
            </Field>
          ) : (
            <Field label="Mã mời">
              <Input
                value={form.inviteCode}
                onChange={(e) => set("inviteCode", e.target.value)}
                placeholder="Dán mã từ chủ workspace"
                required
              />
            </Field>
          )}
          {err && <div className="text-sm text-rose-600">{err}</div>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Đang tạo..." : "Tạo tài khoản"}
          </Button>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm text-slate-500">
        Đã có tài khoản?{" "}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Đăng nhập
        </Link>
      </p>
    </div>
  );
}
