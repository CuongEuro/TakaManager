"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";

export interface Me {
  user: { email: string; name: string | null };
  org: { id: string; name: string; inviteCode: string | null };
  role: string;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAuthPage = pathname === "/login" || pathname === "/signup";
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    if (isAuthPage) return;
    let active = true;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => active && setMe(d))
      .catch(() => active && setMe(null));
    return () => {
      active = false;
    };
  }, [isAuthPage, pathname]);

  if (isAuthPage) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        {children}
      </div>
    );
  }

  if (me === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-400">
        Đang tải...
      </div>
    );
  }

  if (me === null) {
    router.replace("/login");
    return null;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar me={me} />
      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-7xl px-6 py-6">{children}</div>
      </main>
    </div>
  );
}
