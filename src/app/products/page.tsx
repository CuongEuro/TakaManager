"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DateRangePicker, DateRange } from "@/components/DateRangePicker";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { ORDER_CHANNEL_LABELS } from "@/lib/constants";
import { formatJPY, formatNumber, formatPercent } from "@/lib/format";
import {
  Card,
  PageHeader,
  Select,
  Input,
  EmptyState,
  Table,
  Th,
  Td,
  Badge,
  Button,
} from "@/components/ui";
import {
  addCalendarDays,
  calendarDateInTimeZone,
  calendarYMD,
  parseCalendarDate,
} from "@/lib/dates";

interface ProductRow {
  productId: string | null;
  title: string;
  image: string | null;
  orders: number;
  units: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  channels: { channel: string; orders: number }[];
}

interface TopProductsResponse {
  storeId: string | null;
  storeOptions: { id: string; name: string }[];
  summary: {
    products: number;
    orders: number;
    units: number;
    revenue: number;
    cogs: number;
  };
  total: number;
  totalPages: number;
  page: number;
  pageSize: number;
  rows: ProductRow[];
}

function parseYMD(v: string | null): Date | null {
  return v ? parseCalendarDate(v) : null;
}

const SORT_OPTIONS = [
  { value: "revenue", label: "Doanh thu" },
  { value: "units", label: "Số items" },
  { value: "orders", label: "Số đơn" },
  { value: "profit", label: "LN gộp" },
];

export default function ProductsPage() {
  return (
    <Suspense
      fallback={
        <div className="py-20 text-center text-sm text-slate-400">Đang tải…</div>
      }
    >
      <ProductsInner />
    </Suspense>
  );
}

function ProductsInner() {
  // Deep-linked from the dashboard's "Top sản phẩm bán chạy" card: carries the
  // same range + store so the two views show the same data.
  const sp = useSearchParams();
  const [range, setRange] = useState<DateRange>(() => {
    const from = parseYMD(sp.get("from"));
    const to = parseYMD(sp.get("to"));
    if (from && to) return { from, to };
    const today = calendarDateInTimeZone();
    return { from: addCalendarDays(today, -29), to: today };
  });
  const [storeId, setStoreId] = useState<string>(sp.get("storeId") ?? "");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [sort, setSort] = useState("revenue");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState<TopProductsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const id = setTimeout(() => setQDebounced(q), 400);
    return () => clearTimeout(id);
  }, [q]);

  // Any filter change restarts from page 1.
  useEffect(() => {
    setPage(1);
  }, [range, storeId, qDebounced, sort, pageSize]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const params = new URLSearchParams({
      from: calendarYMD(range.from),
      to: calendarYMD(range.to),
      page: String(page),
      pageSize: String(pageSize),
      sort,
    });
    if (storeId) params.set("storeId", storeId);
    if (qDebounced.trim()) params.set("q", qDebounced.trim());
    fetch(`/api/products/top?${params}`)
      .then((r) => r.json())
      .then((d) => active && setData(d))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [range, storeId, qDebounced, sort, page, pageSize]);

  const s = data?.summary;
  const storeName =
    (storeId && data?.storeOptions.find((o) => o.id === storeId)?.name) ||
    "Tất cả store";

  return (
    <div>
      <PageHeader
        title="Sản phẩm bán chạy"
        subtitle={`Danh sách đầy đủ theo doanh số — ${storeName}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              className="!w-auto"
            >
              <option value="">Tất cả store</option>
              {data?.storeOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
            <DateRangePicker value={range} onChange={setRange} />
          </div>
        }
      />

      {/* Summary strip for the current filter (all pages, not just this one) */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat label="Sản phẩm" value={formatNumber(s?.products ?? 0)} />
        <MiniStat label="Số items" value={formatNumber(s?.units ?? 0)} />
        <MiniStat label="Doanh thu (chưa thuế)" value={formatJPY(s?.revenue ?? 0)} />
        <MiniStat label="Basecost (COGS)" value={formatJPY(s?.cogs ?? 0)} />
      </div>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input
            placeholder="🔍 Tìm theo tên sản phẩm…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="!w-full sm:!w-72"
          />
          <div className="flex items-center gap-2 text-xs text-slate-500">
            Sắp xếp theo
            <Select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="!w-auto"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          {loading && (
            <span className="text-xs text-slate-400">Đang tải…</span>
          )}
        </div>

        {data && data.rows.length === 0 ? (
          <EmptyState message="Không có sản phẩm nào trong khoảng thời gian / bộ lọc này." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-10 text-center">#</Th>
                <Th>Sản phẩm</Th>
                <Th className="text-right">Số đơn</Th>
                <Th className="text-right">Số items</Th>
                <Th className="text-right">Basecost</Th>
                <Th className="text-right">Doanh thu</Th>
                <Th className="text-right">LN gộp</Th>
                <Th>Nguồn traffic</Th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((p, i) => {
                const rank = (data.page - 1) * data.pageSize + i + 1;
                const margin = p.revenue > 0 ? p.grossProfit / p.revenue : 0;
                return (
                  <tr key={p.productId ?? p.title} className="hover:bg-slate-50">
                    <Td className="text-center text-xs font-bold text-slate-400">
                      {rank}
                    </Td>
                    <Td>
                      <div className="flex min-w-[220px] items-center gap-3">
                        <ProductThumbnail
                          src={p.image}
                          alt={p.title}
                        />
                        <span className="line-clamp-2 text-sm font-medium text-slate-700">
                          {p.title}
                        </span>
                      </div>
                    </Td>
                    <Td className="text-right">{formatNumber(p.orders)}</Td>
                    <Td className="text-right">{formatNumber(p.units)}</Td>
                    <Td className="text-right text-slate-500">
                      {formatJPY(p.cogs)}
                      {p.units > 0 && p.cogs > 0 && (
                        <div className="text-[10px] text-slate-400">
                          ≈ {formatJPY(p.cogs / p.units)}/cái
                        </div>
                      )}
                    </Td>
                    <Td className="text-right font-semibold text-slate-700">
                      {formatJPY(p.revenue)}
                    </Td>
                    <Td
                      className={`text-right font-semibold ${
                        p.grossProfit >= 0 ? "text-emerald-600" : "text-rose-600"
                      }`}
                    >
                      {formatJPY(p.grossProfit)}
                      <div className="text-[10px] font-normal text-slate-400">
                        {formatPercent(margin)}
                      </div>
                    </Td>
                    <Td>
                      <div className="flex max-w-[220px] flex-wrap gap-1">
                        {p.channels.slice(0, 3).map((c) => (
                          <Badge key={c.channel} tone="blue">
                            {ORDER_CHANNEL_LABELS[c.channel] ?? c.channel} ·{" "}
                            {formatNumber(c.orders)}
                          </Badge>
                        ))}
                        {p.channels.length > 3 && (
                          <Badge tone="slate">+{p.channels.length - 3}</Badge>
                        )}
                        {p.channels.length === 0 && (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}

        {/* Pagination */}
        {data && data.total > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              Hiển thị
              <Select
                value={String(pageSize)}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="!w-auto"
              >
                {[20, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              / {formatNumber(data.total)} sản phẩm
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← Trước
              </Button>
              <span className="text-sm text-slate-600">
                Trang {data.page}/{data.totalPages}
              </span>
              <Button
                variant="secondary"
                disabled={page >= data.totalPages || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Sau →
              </Button>
            </div>
          </div>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
          Doanh thu = giá bán × số lượng, đã trừ {""}
          thuế thu hộ theo % của store (chưa trừ ship/hoàn hàng — xem P&L trên
          Dashboard cho số tổng chính xác). Basecost theo nguồn COGS của store:
          Cost per item (Shopify) hoặc quy tắc Biến đổi A (% tính trên giá trị
          dòng sản phẩm). Nguồn traffic đếm số đơn theo kênh (UTM) chứa sản phẩm.
        </p>
      </Card>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="!p-3">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-bold text-slate-900">{value}</div>
    </Card>
  );
}
