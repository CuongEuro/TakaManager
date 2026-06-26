import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "TakaManager — Quản lý dữ liệu & Marketing POD",
  description: "Hệ thống quản lý chi phí, doanh thu, lợi nhuận và tối ưu Ads cho POD.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
