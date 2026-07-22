"use client";

import { Fragment, Suspense, useEffect, useState } from "react";
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

interface ProductVariantRow {
  externalVariantId: string | null;
  variantTitle: string | null;
  sku: string | null;
  orders: number;
  orderLines: number;
  units: number;
  costedUnits: number;
  missingOrderLines: number;
  missingUnits: number;
  cogs: number;
  averageUnitCost: number;
  minUnitCost: number | null;
  maxUnitCost: number | null;
}

interface ProductRow {
  productId: string | null;
  storeId: string;
  title: string;
  image: string | null;
  storefrontUrl: string | null;
  missingBasecost: boolean;
  variantCount: number;
  missingVariants: number;
  missingOrderLines: number;
  missingUnits: number;
  costedUnits: number;
  variants: ProductVariantRow[];
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

interface ProductMediaPageResponse {
  ok: boolean;
  scanned: number;
  updated: number;
  total: number | null;
  nextCursor: string | null;
  hasNext: boolean;
  errors: string[];
  error?: string;
}

interface CostSyncResponse {
  ok: boolean;
  updated: number;
  missingCount: number;
  nextCursor: string | null;
  hasNext: boolean;
  error?: string;
}

interface VariantSyncResponse {
  ok: boolean;
  scanned: number;
  found: number;
  updatedCosts: number;
  nextCursor: string | null;
  hasNext: boolean;
  error?: string;
}

function parseYMD(v: string | null): Date | null {
  return v ? parseCalendarDate(v) : null;
}

const SORT_OPTIONS = [
  { value: "revenue", label: "Doanh thu" },
  { value: "units", label: "Số items" },
  { value: "orders", label: "Số đơn" },
  { value: "cogs", label: "Basecost" },
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
  const [basecostFilter, setBasecostFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState<TopProductsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingMedia, setRefreshingMedia] = useState(false);
  const [refreshingCosts, setRefreshingCosts] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(
    new Set()
  );
  const [expandedProductIds, setExpandedProductIds] = useState<Set<string>>(
    new Set()
  );
  const [mediaVersion, setMediaVersion] = useState(0);

  useEffect(() => {
    const id = setTimeout(() => setQDebounced(q), 400);
    return () => clearTimeout(id);
  }, [q]);

  // Any filter change restarts from page 1.
  useEffect(() => {
    setPage(1);
  }, [range, storeId, qDebounced, sort, basecostFilter, pageSize]);

  // Selection deliberately belongs to the visible page so bulk actions stay
  // explicit and never affect products the user can no longer see.
  useEffect(() => {
    setSelectedProductIds(new Set());
    setExpandedProductIds(new Set());
  }, [range, storeId, qDebounced, sort, basecostFilter, pageSize, page]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const params = new URLSearchParams({
      from: calendarYMD(range.from),
      to: calendarYMD(range.to),
      page: String(page),
      pageSize: String(pageSize),
      sort,
      basecost: basecostFilter,
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
  }, [
    range,
    storeId,
    qDebounced,
    sort,
    basecostFilter,
    page,
    pageSize,
    mediaVersion,
  ]);

  async function refreshProductMedia(selectedOnly: boolean) {
    setRefreshingMedia(true);
    setActionMessage("Đang nạp lại ảnh và link từ Shopify…");
    let scanned = 0;
    let updated = 0;
    const errors = new Set<string>();
    const selectedRows =
      data?.rows.filter(
        (row) => row.productId && selectedProductIds.has(row.productId)
      ) ?? [];
    const targets = new Map<string, string[] | undefined>();
    if (selectedOnly) {
      for (const row of selectedRows) {
        if (!row.productId) continue;
        const ids = targets.get(row.storeId) ?? [];
        ids.push(row.productId);
        targets.set(row.storeId, ids);
      }
    } else {
      const targetStoreIds = storeId
        ? [storeId]
        : data?.storeOptions.map((store) => store.id) ?? [];
      targetStoreIds.forEach((id) => targets.set(id, undefined));
    }
    try {
      if (targets.size === 0) {
        throw new Error(
          selectedOnly ? "Hãy tích chọn ít nhất một sản phẩm" : "Không có store để cập nhật"
        );
      }
      // Each request handles at most 100 products, preventing gateway timeouts.
      for (const [targetStoreId, productIds] of targets) {
        let cursor: string | null = null;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const response = await fetch("/api/products/media", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              storeId: targetStoreId,
              ...(productIds ? { productIds } : {}),
              ...(cursor ? { cursor } : {}),
            }),
          });
          const result = (await response
            .json()
            .catch(() => ({}))) as ProductMediaPageResponse;
          if (!response.ok || !result.ok) {
            throw new Error(result.error || `HTTP ${response.status}`);
          }
          scanned += result.scanned;
          updated += result.updated;
          result.errors.forEach((error) => errors.add(error));
          setActionMessage(
            `Đang nạp lại ảnh và link… đã quét ${formatNumber(scanned)} sản phẩm`
          );
          if (!result.hasNext) break;
          if (!result.nextCursor) throw new Error("Thiếu con trỏ trang tiếp theo");
          cursor = result.nextCursor;
        }
      }
      setActionMessage(
        errors.size > 0
          ? `⚠ Đã cập nhật ${formatNumber(updated)} sản phẩm. ${Array.from(
              errors
            ).join(" · ")}`
          : `✓ Đã nạp lại ảnh và link cho ${formatNumber(updated)} sản phẩm.`
      );
      setMediaVersion((version) => version + 1);
      if (selectedOnly) setSelectedProductIds(new Set());
    } catch (error) {
      setActionMessage(
        `⚠ Không thể nạp lại ảnh: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setRefreshingMedia(false);
    }
  }

  async function refreshSelectedBasecosts() {
    const selectedRows =
      data?.rows.filter(
        (row) =>
          row.productId &&
          row.missingBasecost &&
          selectedProductIds.has(row.productId)
      ) ?? [];
    const targets = new Map<string, string[]>();
    for (const row of selectedRows) {
      if (!row.productId) continue;
      const ids = targets.get(row.storeId) ?? [];
      ids.push(row.productId);
      targets.set(row.storeId, ids);
    }
    if (targets.size === 0) {
      setActionMessage("⚠ Hãy tích chọn sản phẩm đang thiếu Basecost.");
      return;
    }

    setRefreshingCosts(true);
    setActionMessage("Đang cập nhật Basecost cho các sản phẩm đã chọn…");
    let updated = 0;
    let missing = 0;
    let scannedVariants = 0;
    try {
      for (const [targetStoreId, productIds] of targets) {
        // First resolve every current exact variant. This fills size/color/SKU
        // metadata and all directly available costs without touching snapshots.
        let variantCursor: string | null = null;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const variantResponse = await fetch("/api/products/variants", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              storeId: targetStoreId,
              productIds,
              from: calendarYMD(range.from),
              to: calendarYMD(range.to),
              cursor: variantCursor,
            }),
          });
          const variantResult = (await variantResponse
            .json()
            .catch(() => ({}))) as VariantSyncResponse;
          if (!variantResponse.ok || !variantResult.ok) {
            throw new Error(variantResult.error || `HTTP ${variantResponse.status}`);
          }
          scannedVariants += Number(variantResult.scanned) || 0;
          updated += Number(variantResult.updatedCosts) || 0;
          setActionMessage(
            `Đang cập nhật Basecost… đã kiểm tra ${formatNumber(
              scannedVariants
            )} variant`
          );
          if (!variantResult.hasNext) break;
          if (!variantResult.nextCursor)
            throw new Error("Thiếu con trỏ variant tiếp theo");
          variantCursor = variantResult.nextCursor;
        }

        // Then repair legacy/deleted variant IDs from the original order line.
        let cursor: string | null = null;
        for (let batch = 0; batch < 500; batch++) {
          const response = await fetch("/api/shopify/costs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              storeId: targetStoreId,
              productIds,
              from: calendarYMD(range.from),
              to: calendarYMD(range.to),
              cursor,
              limit: 20,
            }),
          });
          const result = (await response
            .json()
            .catch(() => ({}))) as CostSyncResponse;
          if (!response.ok || !result.ok) {
            throw new Error(result.error || `HTTP ${response.status}`);
          }
          updated += Number(result.updated) || 0;
          if (!result.hasNext) {
            missing += Number(result.missingCount) || 0;
            break;
          }
          if (!result.nextCursor) throw new Error("Thiếu con trỏ batch tiếp theo");
          cursor = result.nextCursor;
        }
      }
      setActionMessage(
        missing > 0
          ? `⚠ Đã kiểm tra ${formatNumber(scannedVariants)} variant và cập nhật ${formatNumber(
              updated
            )} dòng Basecost; còn ${formatNumber(
              missing
            )} sản phẩm đã chọn có variant chưa có Cost per item trên Shopify.`
          : `✓ Đã kiểm tra ${formatNumber(scannedVariants)} variant và cập nhật ${formatNumber(
              updated
            )} dòng Basecost cho các sản phẩm đã chọn.`
      );
      setSelectedProductIds(new Set());
      setMediaVersion((version) => version + 1);
    } catch (error) {
      setActionMessage(
        `⚠ Không thể cập nhật Basecost: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setRefreshingCosts(false);
    }
  }

  const s = data?.summary;
  const storeName =
    (storeId && data?.storeOptions.find((o) => o.id === storeId)?.name) ||
    "Tất cả store";
  const selectableIds =
    data?.rows.flatMap((row) => (row.productId ? [row.productId] : [])) ?? [];
  const allVisibleSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedProductIds.has(id));
  const selectedMissingCount =
    data?.rows.filter(
      (row) =>
        row.productId &&
        row.missingBasecost &&
        selectedProductIds.has(row.productId)
    ).length ?? 0;

  function toggleVisibleProducts() {
    setSelectedProductIds(
      allVisibleSelected ? new Set() : new Set(selectableIds)
    );
  }

  function toggleProduct(productId: string) {
    setSelectedProductIds((current) => {
      const next = new Set(current);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  }

  function toggleProductDetails(productId: string) {
    setExpandedProductIds((current) => {
      const next = new Set(current);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  }

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
          <div className="flex items-center gap-2 text-xs text-slate-500">
            Basecost
            <Select
              value={basecostFilter}
              onChange={(e) => setBasecostFilter(e.target.value)}
              className="!w-auto"
            >
              <option value="all">Tất cả</option>
              <option value="missing">Chưa đủ Basecost</option>
              <option value="complete">Đã đủ Basecost</option>
            </Select>
          </div>
          <Button
            variant="secondary"
            onClick={() => refreshProductMedia(false)}
            disabled={refreshingMedia || refreshingCosts}
            title="Lấy lại featured image và link sản phẩm từ Shopify theo từng batch"
          >
            {refreshingMedia ? "Đang nạp ảnh…" : "🔄 Nạp toàn bộ ảnh"}
          </Button>
          {loading && (
            <span className="text-xs text-slate-400">Đang tải…</span>
          )}
        </div>

        {selectedProductIds.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2">
            <span className="mr-auto text-sm font-medium text-brand-800">
              Đã chọn {formatNumber(selectedProductIds.size)} sản phẩm
            </span>
            <Button
              variant="secondary"
              onClick={refreshSelectedBasecosts}
              disabled={
                refreshingCosts || refreshingMedia || selectedMissingCount === 0
              }
              title="Chỉ cập nhật các dòng order còn thiếu Basecost của sản phẩm đã chọn"
            >
              {refreshingCosts
                ? "Đang cập nhật Basecost…"
                : `💰 Cập nhật Basecost (${selectedMissingCount})`}
            </Button>
            <Button
              variant="secondary"
              onClick={() => refreshProductMedia(true)}
              disabled={refreshingCosts || refreshingMedia}
            >
              🖼 Cập nhật ảnh & link ({selectedProductIds.size})
            </Button>
            <Button
              variant="ghost"
              onClick={() => setSelectedProductIds(new Set())}
              disabled={refreshingCosts || refreshingMedia}
            >
              Bỏ chọn
            </Button>
          </div>
        )}

        {actionMessage && (
          <div
            className={`mb-3 rounded-lg px-3 py-2 text-xs ${
              actionMessage.startsWith("⚠")
                ? "bg-amber-50 text-amber-800"
                : actionMessage.startsWith("✓")
                ? "bg-emerald-50 text-emerald-700"
                : "bg-brand-50 text-brand-700"
            }`}
          >
            {actionMessage}
          </div>
        )}

        {data && data.rows.length === 0 ? (
          <EmptyState message="Không có sản phẩm nào trong khoảng thời gian / bộ lọc này." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-10 text-center">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleVisibleProducts}
                    disabled={selectableIds.length === 0}
                    aria-label="Chọn tất cả sản phẩm đang hiển thị"
                    className="h-4 w-4 rounded border-slate-300 accent-brand-600"
                  />
                </Th>
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
                const rowKey = p.productId ?? p.title;
                return (
                  <Fragment key={rowKey}>
                  <tr
                    className={
                      p.productId && selectedProductIds.has(p.productId)
                        ? "bg-brand-50/60 hover:bg-brand-50"
                        : "hover:bg-slate-50"
                    }
                  >
                    <Td className="text-center">
                      <input
                        type="checkbox"
                        checked={
                          !!p.productId && selectedProductIds.has(p.productId)
                        }
                        onChange={() => p.productId && toggleProduct(p.productId)}
                        disabled={!p.productId}
                        aria-label={`Chọn ${p.title}`}
                        className="h-4 w-4 rounded border-slate-300 accent-brand-600"
                      />
                    </Td>
                    <Td className="text-center text-xs font-bold text-slate-400">
                      {rank}
                    </Td>
                    <Td>
                      <div className="flex min-w-[220px] items-center gap-3">
                        {p.storefrontUrl ? (
                          <a
                            href={p.storefrontUrl}
                            target="_blank"
                            rel="noreferrer"
                            title="Mở sản phẩm trên store"
                          >
                            <ProductThumbnail src={p.image} alt={p.title} />
                          </a>
                        ) : (
                          <ProductThumbnail src={p.image} alt={p.title} />
                        )}
                        {p.storefrontUrl ? (
                          <a
                            href={p.storefrontUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="line-clamp-2 text-sm font-medium text-brand-700 hover:underline"
                          >
                            {p.title} ↗
                          </a>
                        ) : (
                          <span className="line-clamp-2 text-sm font-medium text-slate-700">
                            {p.title}
                          </span>
                        )}
                      </div>
                    </Td>
                    <Td className="text-right">{formatNumber(p.orders)}</Td>
                    <Td className="text-right">{formatNumber(p.units)}</Td>
                    <Td className="text-right text-slate-500">
                      {formatJPY(p.cogs)}
                      {p.missingBasecost && (
                        <div className="mt-1">
                          <Badge tone="rose">
                            Thiếu {p.missingVariants} variant · {p.missingOrderLines} dòng
                          </Badge>
                        </div>
                      )}
                      {p.costedUnits > 0 && p.cogs > 0 && (
                        <div className="text-[10px] text-slate-400">
                          Bình quân phần đã có: {formatJPY(p.cogs / p.costedUnits)}/cái
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => p.productId && toggleProductDetails(p.productId)}
                        disabled={!p.productId || p.variantCount === 0}
                        className="mt-1 block text-[11px] font-medium text-brand-600 hover:underline disabled:text-slate-300 disabled:no-underline"
                      >
                        {p.productId && expandedProductIds.has(p.productId)
                          ? "Ẩn chi tiết"
                          : `Xem ${p.variantCount} variant`}
                      </button>
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
                  {p.productId && expandedProductIds.has(p.productId) && (
                    <tr className="bg-slate-50/80">
                      <td colSpan={9} className="border-b border-slate-200 px-4 py-4">
                        <VariantCostDetails product={p} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
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

function VariantCostDetails({ product }: { product: ProductRow }) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-700">
            Basecost theo từng variant và dòng order
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            Mỗi dòng order giữ snapshot Cost per item riêng. Nếu Shopify từng đổi
            giá vốn, cùng một variant có thể hiển thị một khoảng giá.
          </p>
          {product.variants.some((variant) => !variant.variantTitle) && (
            <p className="mt-1 text-xs text-amber-700">
              Dữ liệu cũ chưa có tên size/color: tích chọn sản phẩm rồi bấm Cập
              nhật Basecost để bổ sung tên variant và SKU.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="blue">
            Đã có cost {formatNumber(product.costedUnits)}/{formatNumber(product.units)} items
          </Badge>
          {product.missingUnits > 0 && (
            <Badge tone="rose">
              Thiếu {formatNumber(product.missingUnits)} items · {formatNumber(
                product.missingOrderLines
              )} dòng order
            </Badge>
          )}
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[760px] text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">Variant (size / color)</th>
              <th className="px-3 py-2 text-left">SKU</th>
              <th className="px-3 py-2 text-right">Đơn / dòng</th>
              <th className="px-3 py-2 text-right">Items</th>
              <th className="px-3 py-2 text-right">Basecost / item</th>
              <th className="px-3 py-2 text-right">Tổng Basecost</th>
              <th className="px-3 py-2 text-right">Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {product.variants.map((variant, index) => {
              const variantId = variant.externalVariantId?.split("/").pop();
              const label =
                variant.variantTitle ||
                (variantId ? `Variant #${variantId}` : "Không xác định variant");
              const hasRange =
                variant.minUnitCost !== null &&
                variant.maxUnitCost !== null &&
                Math.abs(variant.maxUnitCost - variant.minUnitCost) > 0.0001;
              return (
                <tr
                  key={variant.externalVariantId ?? `${label}-${index}`}
                  className="border-t border-slate-100"
                >
                  <td className="px-3 py-2 font-medium text-slate-700">
                    {label}
                    {variantId && variant.variantTitle && (
                      <div className="text-[10px] font-normal text-slate-400">
                        ID {variantId}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{variant.sku || "—"}</td>
                  <td className="px-3 py-2 text-right text-slate-600">
                    {formatNumber(variant.orders)} / {formatNumber(variant.orderLines)}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-600">
                    {formatNumber(variant.units)}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-600">
                    {variant.costedUnits > 0 ? (
                      <>
                        {hasRange
                          ? `${formatJPY(variant.minUnitCost ?? 0)} – ${formatJPY(
                              variant.maxUnitCost ?? 0
                            )}`
                          : formatJPY(variant.averageUnitCost)}
                        {hasRange && (
                          <div className="text-[10px] text-slate-400">
                            Bình quân {formatJPY(variant.averageUnitCost)}
                          </div>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-medium text-slate-700">
                    {formatJPY(variant.cogs)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {variant.missingOrderLines > 0 ? (
                      <Badge tone="rose">
                        Thiếu {formatNumber(variant.missingOrderLines)} dòng ·{" "}
                        {formatNumber(variant.missingUnits)} items
                      </Badge>
                    ) : (
                      <Badge tone="green">Đã đủ</Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
