"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Me } from "@/components/AppShell";

const NAV = [
  { href: "/", label: "Dashboard", icon: "📊" },
  { href: "/stores", label: "Stores", icon: "🏬" },
  { href: "/costs/fixed", label: "Chi phí cố định", icon: "🏛️" },
  { href: "/costs/variable-a", label: "Biến đổi A (Sản xuất)", icon: "🏭" },
  { href: "/costs/ads", label: "Biến đổi B (Quảng cáo)", icon: "📣" },
  { href: "/ads/accounts", label: "Kết nối Ads", icon: "🔌" },
  { href: "/ads/optimize", label: "Tối ưu Ads", icon: "🎯" },
];

export function Sidebar({
  me,
  open = false,
  onClose,
}: {
  me: Me;
  open?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return (
    <>
      {/* Backdrop (mobile only, when the drawer is open) */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 md:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white transition-transform duration-200 md:static md:z-auto md:w-60 md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-start justify-between px-5 py-5">
          <div className="min-w-0">
            <div className="text-xl font-bold text-slate-900">
              Taka<span className="text-brand-600">Manager</span>
            </div>
            <div className="mt-0.5 truncate text-xs text-slate-400">
              {me.org.name}
            </div>
          </div>
          {/* Close button (mobile only) */}
          <button
            onClick={onClose}
            className="-mr-1 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 md:hidden"
            aria-label="Đóng menu"
          >
            ✕
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3">
          {NAV.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={`mb-1 flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  active
                    ? "bg-brand-50 text-brand-700"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                <span className="text-base">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

      <div className="border-t border-slate-100 px-4 py-3">
        {me.org.inviteCode && (
          <div className="mb-3 rounded-lg bg-slate-50 p-2.5">
            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
              Mã mời thành viên
            </div>
            <div className="mt-0.5 select-all font-mono text-xs text-slate-700">
              {me.org.inviteCode}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-slate-700">
              {me.user.name || me.user.email}
            </div>
            <div className="truncate text-[10px] text-slate-400">
              {me.role === "OWNER" ? "Chủ workspace" : me.role}
            </div>
          </div>
          <button
            onClick={logout}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-rose-600"
            title="Đăng xuất"
          >
            Đăng xuất
          </button>
        </div>
      </div>
      </aside>
    </>
  );
}
