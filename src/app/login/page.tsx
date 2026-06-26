"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, Button, Input, Field } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(d.error || "Đăng nhập thất bại");
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
        <div className="mt-1 text-sm text-slate-400">Đăng nhập vào workspace</div>
      </div>
      <Card>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </Field>
          <Field label="Mật khẩu">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          {err && <div className="text-sm text-rose-600">{err}</div>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Đang đăng nhập..." : "Đăng nhập"}
          </Button>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm text-slate-500">
        Chưa có tài khoản?{" "}
        <Link href="/signup" className="font-medium text-brand-600 hover:underline">
          Tạo tài khoản
        </Link>
      </p>
    </div>
  );
}
