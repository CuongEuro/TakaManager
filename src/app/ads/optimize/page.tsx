"use client";

import { useEffect, useState } from "react";
import type { AdTree, CampaignNode, AdsetNode, AdNode, Trend } from "@/lib/adinsights";
import type { OptimizeResult, Reco, Action } from "@/lib/optimize";
import type { AiStrategy } from "@/lib/ai";
import { ACTION_LABELS } from "@/lib/optimize";
import { RANGE_PRESET_LABELS, RangePreset } from "@/lib/dates";
import { AD_PLATFORM_LABELS } from "@/lib/constants";
import {
  formatJPY,
  formatNumber,
  formatPercent,
  formatMultiplier,
} from "@/lib/format";
import { Card, PageHeader, Select, EmptyState, Badge, Button } from "@/components/ui";

interface AttributionInfo {
  matchRate: number;
  matchRateByPlatform: Record<string, number>;
  paidOrders: number;
  matchedOrders: number;
  taggedOrders: number;
  unmatchedTop: {
    utmCampaign: string;
    channel: string;
    orders: number;
    revenue: number;
  }[];
}

interface CalibrationRow {
  platform: string;
  spend: number;
  platformRevenue: number;
  shopifyRevenue: number;
  shopifyOrders: number;
  matchedRevenue: number;
  overReport: number | null;
  effRoas: number;
  effCpa: number;
}

interface OptimizeResponse {
  preset: RangePreset;
  range: { start: string; end: string; days: number };
  storeId: string | null;
  platform: string | null;
  breakEvenRoas: number;
  aov: number;
  tree: AdTree;
  optimize: OptimizeResult;
  calibration: CalibrationRow[];
  attribution: AttributionInfo;
}

const PRESETS: RangePreset[] = [
  "today",
  "yesterday",
  "last3",
  "last7",
  "last30",
];

interface AlertRow {
  id: string;
  createdAt: string;
  severity: string; // INFO | WARN | CRIT
  type: string;
  platform: string | null;
  entityName: string;
  message: string;
  readAt: string | null;
}

interface ReportMeta {
  id: string;
  createdAt: string;
  preset: string;
  storeId: string | null;
  platform: string | null;
}

const SEVERITY_TONE: Record<string, "rose" | "amber" | "slate"> = {
  CRIT: "rose",
  WARN: "amber",
  INFO: "slate",
};

const AI_ACTION_TONE: Record<string, "green" | "blue" | "amber" | "rose" | "slate"> = {
  SCALE: "green",
  KEEP: "blue",
  REDUCE: "amber",
  PAUSE: "rose",
  FIX_CREATIVE: "amber",
  FIX_LANDING: "amber",
  FIX_TRACKING: "rose",
};

const ACTION_TONE: Record<Action, "green" | "blue" | "amber" | "rose" | "slate"> = {
  SCALE: "green",
  KEEP: "blue",
  REDUCE: "amber",
  PAUSE: "rose",
  REVIEW: "slate",
  NO_DATA: "amber",
  OFF: "slate",
};

// Order the action-filter chips are shown in (most actionable first).
const ACTION_ORDER: Action[] = [
  "SCALE",
  "REDUCE",
  "PAUSE",
  "KEEP",
  "REVIEW",
  "NO_DATA",
  "OFF",
];

export default function OptimizePage() {
  const [preset, setPreset] = useState<RangePreset>("last30");
  const [storeId, setStoreId] = useState("");
  const [platform, setPlatform] = useState("");
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [data, setData] = useState<OptimizeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [openAdsets, setOpenAdsets] = useState<Set<string>>(new Set());
  const [ai, setAi] = useState<{ text: string; json: AiStrategy | null } | null>(
    null
  );
  const [aiLoading, setAiLoading] = useState(false);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [reportId, setReportId] = useState("");
  // Client-side filters over the loaded tree + campaign selection for the AI.
  const [actionFilter, setActionFilter] = useState<Set<Action>>(new Set());
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">(
    "all"
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;
  // "Cập nhật Ads" — sync latest ad data (incl. campaign status for the filter).
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    fetch("/api/stores")
      .then((r) => r.json())
      .then((s) => setStores(s.map((x: { id: string; name: string }) => x)));
    loadAlerts();
    loadReports();
  }, []);

  function loadAlerts() {
    fetch("/api/ads/alerts")
      .then((r) => r.json())
      .then((d) => {
        setAlerts(d.alerts ?? []);
        setUnread(d.unreadCount ?? 0);
      })
      .catch(() => {});
  }

  function loadReports() {
    fetch("/api/ads/ai-reports")
      .then((r) => r.json())
      .then((d) => setReports(d.reports ?? []))
      .catch(() => {});
  }

  async function markAllRead() {
    await fetch("/api/ads/alerts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => {});
    loadAlerts();
  }

  async function openReport(id: string) {
    setReportId(id);
    if (!id) return;
    const r = await fetch(`/api/ads/ai-reports/${id}`).then((x) => x.json());
    if (r.report)
      setAi({ text: r.report.text, json: r.report.json as AiStrategy | null });
  }

  useEffect(() => {
    setLoading(true);
    setAi(null);
    const p = new URLSearchParams({ preset });
    if (storeId) p.set("storeId", storeId);
    if (platform) p.set("platform", platform);
    fetch(`/api/ads/optimize?${p}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setSelected(new Set()); // selection is per data load
        // auto-open campaigns that need action (SCALE/PAUSE)
        const recoMap = recoById(d.optimize.recommendations);
        const auto = new Set<string>();
        d.tree.campaigns.forEach((c: CampaignNode) => {
          const a = recoMap.get(c.id)?.action;
          if (a === "PAUSE" || a === "SCALE") auto.add(c.id);
        });
        setOpen(auto);
      })
      .finally(() => setLoading(false));
  }, [preset, storeId, platform, reloadTick]);

  // Any filter/data change restarts pagination at page 1.
  useEffect(() => {
    setPage(1);
  }, [actionFilter, statusFilter, preset, storeId, platform, reloadTick]);

  // Sync the latest ad data (campaign spend + STATUS, over the visible window)
  // for every active/configured account, then reload the tree. Light sync
  // (deep=false) — fast and reliable; use "Đồng bộ sâu" on Kết nối Ads for
  // adset-level backfill.
  async function updateAds() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const accounts: {
        id: string;
        active: boolean;
        configured: boolean;
      }[] = await fetch("/api/ads/accounts").then((r) => r.json());
      const targets = accounts.filter((a) => a.active && a.configured);
      if (targets.length === 0) {
        setSyncMsg("Chưa có tài khoản Ads nào được cấu hình.");
        return;
      }
      const since = data?.range.start;
      const until = data?.range.end;
      let ok = 0;
      for (const a of targets) {
        try {
          const r = await fetch("/api/ads/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: a.id, since, until, deep: false }),
          }).then((x) => x.json());
          if (r.results?.[0]?.ok) ok++;
        } catch {
          /* keep going — per-account failures are tolerated */
        }
      }
      setSyncMsg(`✓ Đã cập nhật ${ok}/${targets.length} tài khoản Ads.`);
      setReloadTick((t) => t + 1); // reload the tree with fresh status/spend
    } catch (e) {
      setSyncMsg(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function askAi() {
    setAiLoading(true);
    setAi(null);
    setReportId("");
    try {
      const r = await fetch("/api/ads/optimize/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preset,
          storeId,
          platform,
          // Focus the analysis on the chosen campaigns (else all in view).
          campaignIds: selected.size > 0 ? [...selected] : undefined,
        }),
      }).then((x) => x.json());
      setAi(
        r.ok
          ? { text: r.text, json: (r.json as AiStrategy | null) ?? null }
          : { text: `⚠ ${r.error}`, json: null }
      );
      if (r.reportId) loadReports();
    } catch (e) {
      setAi({ text: `⚠ ${e instanceof Error ? e.message : String(e)}`, json: null });
    } finally {
      setAiLoading(false);
    }
  }

  const recoMap: Map<string, Reco> = data
    ? recoById(data.optimize.recommendations)
    : new Map();
  const counts = data?.optimize.counts;

  const isInactive = (c: CampaignNode) =>
    c.status === "PAUSED" || c.status === "ARCHIVED";

  // Campaigns after the action + status filters (drives both the tree and the
  // "select all visible" helper).
  const visibleCampaigns = (data?.tree.campaigns ?? []).filter((c) => {
    const reco = recoMap.get(c.id);
    if (actionFilter.size > 0 && (!reco || !actionFilter.has(reco.action)))
      return false;
    if (statusFilter === "active" && isInactive(c)) return false;
    if (statusFilter === "inactive" && !isInactive(c)) return false;
    return true;
  });

  function toggleAction(a: Action) {
    setActionFilter((prev) => {
      const n = new Set(prev);
      n.has(a) ? n.delete(a) : n.add(a);
      return n;
    });
  }
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  const allVisibleSelected =
    visibleCampaigns.length > 0 &&
    visibleCampaigns.every((c) => selected.has(c.id));

  // Pagination over the filtered list.
  const totalPages = Math.max(1, Math.ceil(visibleCampaigns.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedCampaigns = visibleCampaigns.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  );

  return (
    <div>
      <PageHeader
        title="Tối ưu Ads"
        subtitle="Đọc sâu Campaign → Adset, chấm KPI và đề xuất hành động theo điểm hoà vốn."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-slate-200 bg-white p-1">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setPreset(p)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                    preset === p ? "bg-brand-600 text-white" : "text-slate-500 hover:bg-slate-100"
                  }`}
                >
                  {RANGE_PRESET_LABELS[p]}
                </button>
              ))}
            </div>
            <div className="w-36">
              <Select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                <option value="">Tất cả store</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-32">
              <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">Mọi nền tảng</option>
                <option value="FACEBOOK">Facebook</option>
                <option value="GOOGLE">Google</option>
                <option value="TWITTER">Twitter/X</option>
              </Select>
            </div>
            <Button onClick={updateAds} disabled={syncing || loading}>
              {syncing ? "Đang cập nhật..." : "🔄 Cập nhật Ads"}
            </Button>
          </div>
        }
      />

      {syncMsg && (
        <div
          className={`mb-4 rounded-lg px-4 py-2 text-sm ${
            syncMsg.startsWith("⚠")
              ? "bg-rose-50 text-rose-700"
              : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {syncMsg}
        </div>
      )}

      {loading && !data ? (
        <EmptyState message="Đang tải..." />
      ) : !data || data.tree.campaigns.length === 0 ? (
        <EmptyState message="Chưa có dữ liệu campaign/adset. Hãy Sync ở trang Kết nối Ads (hoặc chạy seed)." />
      ) : (
        <div className="space-y-5">
          {/* Summary bar */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <Card>
              <div className="text-xs uppercase text-slate-400">Hoà vốn ROAS</div>
              <div className="mt-1 text-xl font-bold">
                {formatMultiplier(data.breakEvenRoas)}
              </div>
            </Card>
            <Card>
              <div className="text-xs uppercase text-slate-400">Tổng spend</div>
              <div className="mt-1 text-xl font-bold text-rose-600">
                {formatJPY(data.tree.totals.spend)}
              </div>
            </Card>
            <Card>
              <div className="text-xs uppercase text-slate-400">ROAS tổng</div>
              <div
                className={`mt-1 text-xl font-bold ${
                  data.tree.totals.roas >= data.breakEvenRoas
                    ? "text-emerald-600"
                    : "text-rose-600"
                }`}
              >
                {formatMultiplier(data.tree.totals.roas)}
              </div>
            </Card>
            {counts && (
              <>
                <CountCard
                  label="Nên scale"
                  value={counts.SCALE}
                  color="text-emerald-600"
                  active={actionFilter.has("SCALE")}
                  onClick={() => toggleAction("SCALE")}
                />
                <CountCard
                  label="Giảm/Tối ưu"
                  value={counts.REDUCE}
                  color="text-amber-600"
                  active={actionFilter.has("REDUCE")}
                  onClick={() => toggleAction("REDUCE")}
                />
                <CountCard
                  label="Nên dừng"
                  value={counts.PAUSE}
                  color="text-rose-600"
                  active={actionFilter.has("PAUSE")}
                  onClick={() => toggleAction("PAUSE")}
                />
              </>
            )}
          </div>

          {/* Ad alerts (daily cron) */}
          {alerts.length > 0 && (
            <Card>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-700">
                  🔔 Cảnh báo Ads{" "}
                  {unread > 0 && <Badge tone="rose">{unread} chưa đọc</Badge>}
                </div>
                {unread > 0 && (
                  <Button variant="ghost" onClick={markAllRead}>
                    Đọc tất cả
                  </Button>
                )}
              </div>
              <div className="space-y-1.5">
                {alerts.slice(0, 8).map((a) => (
                  <div
                    key={a.id}
                    className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${
                      a.readAt ? "text-slate-400" : "bg-slate-50 text-slate-600"
                    }`}
                  >
                    <Badge tone={SEVERITY_TONE[a.severity] ?? "slate"}>
                      {a.severity}
                    </Badge>
                    <span className="min-w-0 flex-1">{a.message}</span>
                    <span className="shrink-0 text-xs text-slate-400">
                      {new Date(a.createdAt).toLocaleDateString("vi-VN")}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* AI strategy */}
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-700">
                Chiến lược AI (Claude)
              </div>
              <div className="flex items-center gap-2">
                {reports.length > 0 && (
                  <Select
                    value={reportId}
                    onChange={(e) => openReport(e.target.value)}
                    className="!w-auto text-xs"
                  >
                    <option value="">Lịch sử báo cáo…</option>
                    {reports.map((r) => (
                      <option key={r.id} value={r.id}>
                        {new Date(r.createdAt).toLocaleString("vi-VN")} ·{" "}
                        {RANGE_PRESET_LABELS[r.preset as RangePreset] ?? r.preset}
                      </option>
                    ))}
                  </Select>
                )}
                <Button onClick={askAi} disabled={aiLoading}>
                  {aiLoading ? "Đang phân tích..." : "🤖 Hỏi AI chiến lược"}
                </Button>
              </div>
            </div>
            {ai?.json ? (
              <div className="mt-3 space-y-4">
                <p className="rounded-lg bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
                  {ai.json.summary}
                </p>
                {ai.json.actions.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase text-slate-400">
                          <th className="px-2 py-1.5">Hành động</th>
                          <th className="px-2 py-1.5">Đối tượng</th>
                          <th className="px-2 py-1.5">Chi tiết</th>
                          <th className="px-2 py-1.5">Kỳ vọng</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ai.json.actions.map((a, i) => (
                          <tr key={i} className="border-t border-slate-100 align-top">
                            <td className="px-2 py-2">
                              <Badge tone={AI_ACTION_TONE[a.action] ?? "slate"}>
                                {a.action}
                              </Badge>
                            </td>
                            <td className="px-2 py-2 font-medium text-slate-700">
                              {a.target}
                              <div className="text-[10px] font-normal text-slate-400">
                                {AD_PLATFORM_LABELS[a.platform] ?? a.platform} ·{" "}
                                {a.level}
                              </div>
                            </td>
                            <td className="px-2 py-2 text-slate-600">{a.detail}</td>
                            <td className="px-2 py-2 text-slate-500">
                              {a.expectedImpact}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {ai.json.creativeIdeas.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase text-slate-400">
                      Gợi ý creative / test
                    </div>
                    <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-600">
                      {ai.json.creativeIdeas.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <details>
                  <summary className="cursor-pointer text-xs text-slate-400">
                    Xem nguyên văn AI trả về
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-xs leading-relaxed text-slate-500">
                    {ai.text}
                  </pre>
                </details>
              </div>
            ) : (
              ai && (
                <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
                  {ai.text}
                </pre>
              )
            )}
          </Card>

          {/* Budget reallocation plan */}
          {data.optimize.budgetPlan && data.optimize.budgetPlan.length > 0 && (
            <Card>
              <div className="mb-2 text-sm font-semibold text-slate-700">
                💸 Đề xuất ngân sách
              </div>
              <ul className="space-y-2 text-sm text-slate-600">
                {data.optimize.budgetPlan.map((m, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2">
                    <Badge tone="blue">{AD_PLATFORM_LABELS[m.platform] ?? m.platform}</Badge>
                    <span>
                      Chuyển <b>~{formatJPY(m.dailyAmount)}/ngày</b> từ{" "}
                      <span className="text-slate-400">{m.from.join(", ")}</span> →{" "}
                      <b>{m.to}</b>
                    </span>
                    <Badge tone="green">≈ +{formatJPY(m.estDailyProfit)}/ngày</Badge>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-slate-400">
                Ước tính bảo thủ: tiền chuyển sang chỉ đạt 80% ROAS biên hiện tại của
                campaign đích, cộng phần lỗ tránh được từ campaign nguồn. Mỗi đích
                nhận tối đa +30% ngân sách/ngày.
              </p>
            </Card>
          )}

          {data.tree.rangeDays < 14 && (
            <p className="text-xs text-slate-400">
              Chọn khoảng ≥ 14 ngày để xem xu hướng (↗↘) và cảnh báo creative mệt mỏi.
            </p>
          )}

          {/* Data reconciliation — Shopify truth vs platform claims */}
          {data.attribution && data.attribution.paidOrders > 0 && (
            <Card>
              <div className="mb-2 text-sm font-semibold text-slate-700">
                🔎 Đối soát dữ liệu — Shopify (thật) vs nền tảng (tự báo)
              </div>
              {data.calibration && data.calibration.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase text-slate-400">
                        <th className="px-2 py-1.5">Nền tảng</th>
                        <th className="px-2 py-1.5 text-right">Spend</th>
                        <th className="px-2 py-1.5 text-right">DT nền tảng báo</th>
                        <th className="px-2 py-1.5 text-right">DT Shopify thật</th>
                        <th className="px-2 py-1.5 text-right">Khai cao</th>
                        <th className="px-2 py-1.5 text-right">ROAS thực</th>
                        <th className="px-2 py-1.5 text-right">CPA thực</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.calibration.map((p) => (
                        <tr key={p.platform} className="border-t border-slate-100">
                          <td className="px-2 py-2 font-medium text-slate-700">
                            {AD_PLATFORM_LABELS[p.platform] ?? p.platform}
                          </td>
                          <td className="px-2 py-2 text-right">{formatJPY(p.spend)}</td>
                          <td className="px-2 py-2 text-right text-slate-400">
                            {formatJPY(p.platformRevenue)}
                          </td>
                          <td className="px-2 py-2 text-right font-semibold text-slate-700">
                            {p.shopifyRevenue > 0 ? (
                              <>
                                {formatJPY(p.shopifyRevenue)}
                                <span className="ml-1 text-[10px] font-normal text-slate-400">
                                  {formatNumber(p.shopifyOrders)} đơn
                                </span>
                              </>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-2 py-2 text-right">
                            {p.overReport != null ? (
                              <span
                                className={
                                  p.overReport >= 1.5
                                    ? "font-semibold text-amber-600"
                                    : "text-slate-500"
                                }
                              >
                                ×{p.overReport.toFixed(2)}
                              </span>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td
                            className={`px-2 py-2 text-right font-semibold ${
                              p.shopifyRevenue <= 0
                                ? "text-slate-300"
                                : p.effRoas >= data.breakEvenRoas
                                ? "text-emerald-600"
                                : "text-rose-600"
                            }`}
                          >
                            {p.shopifyRevenue > 0 ? formatMultiplier(p.effRoas) : "—"}
                          </td>
                          <td className="px-2 py-2 text-right">
                            {p.shopifyOrders > 0 ? formatJPY(p.effCpa) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                &quot;ROAS thực / CPA thực&quot; = doanh thu &amp; số đơn Shopify của
                kênh ÷ spend — không phụ thuộc tracking nền tảng. Cột
                &quot;Thực&quot; trên từng campaign = doanh thu khớp UTM + phần còn
                lại của kênh phân bổ theo tỷ trọng nền tảng báo (tổng luôn khớp
                Shopify). Nền tảng &quot;—&quot; là chưa hiệu chỉnh được vì đơn chưa
                phân loại kênh.
              </p>

              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-semibold text-slate-700">
                  Đối soát UTM — khớp {formatPercent(data.attribution.matchRate)} (
                  {formatNumber(data.attribution.matchedOrders)}/
                  {formatNumber(data.attribution.paidOrders)} đơn kênh trả phí)
                </summary>
                <div className="mt-3 space-y-3 text-xs text-slate-500">
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(data.attribution.matchRateByPlatform).map(
                      ([p, r]) => (
                        <Badge key={p} tone={r >= 0.6 ? "green" : "amber"}>
                          {AD_PLATFORM_LABELS[p] ?? p}: {formatPercent(r)}
                        </Badge>
                      )
                    )}
                  </div>
                  {data.attribution.unmatchedTop.length > 0 && (
                    <div>
                      <div className="mb-1 font-medium text-slate-600">
                        utm_campaign chưa khớp campaign nào (top theo doanh thu):
                      </div>
                      <ul className="list-disc space-y-0.5 pl-5">
                        {data.attribution.unmatchedTop.map((u) => (
                          <li key={u.utmCampaign}>
                            <span className="font-mono">{u.utmCampaign}</span> —{" "}
                            {formatNumber(u.orders)} đơn · {formatJPY(u.revenue)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <p>
                    Cột &quot;Shopify&quot; = doanh thu thật từ đơn Shopify có
                    utm_campaign trùng TÊN campaign. Để khớp tối đa: đặt{" "}
                    <code>utm_campaign</code> đúng bằng tên campaign (Meta có thể
                    dùng <code>{"{{campaign.name}}"}</code>), tránh đổi tên campaign
                    đang chạy.
                  </p>
                </div>
              </details>
            </Card>
          )}

          {/* Filters + campaign selection */}
          <Card>
            <div className="flex flex-col gap-3">
              {/* Action filter chips (with live counts) */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-semibold text-slate-500">
                  Hành động:
                </span>
                {ACTION_ORDER.filter((a) => (counts?.[a] ?? 0) > 0).map((a) => {
                  const on = actionFilter.has(a);
                  return (
                    <button
                      key={a}
                      onClick={() => toggleAction(a)}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                        on
                          ? "border-brand-600 bg-brand-600 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {ACTION_LABELS[a]} ({counts?.[a] ?? 0})
                    </button>
                  );
                })}
                {actionFilter.size > 0 && (
                  <button
                    onClick={() => setActionFilter(new Set())}
                    className="ml-1 text-xs text-slate-400 underline hover:text-slate-600"
                  >
                    Bỏ lọc
                  </button>
                )}
              </div>

              {/* Status filter + selection controls */}
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs font-semibold text-slate-500">
                  Trạng thái:
                </span>
                <div className="flex rounded-lg border border-slate-200 bg-white p-1">
                  {(
                    [
                      ["all", "Tất cả"],
                      ["active", "Đang chạy"],
                      ["inactive", "Đã tắt"],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => setStatusFilter(v)}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                        statusFilter === v
                          ? "bg-brand-600 text-white"
                          : "text-slate-500 hover:bg-slate-100"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <span className="ml-auto text-xs text-slate-400">
                  {selected.size > 0
                    ? `Đã chọn ${selected.size} campaign để hỏi AI`
                    : `${visibleCampaigns.length} campaign hiển thị`}
                </span>
                <button
                  onClick={() =>
                    setSelected(
                      allVisibleSelected
                        ? new Set()
                        : new Set(visibleCampaigns.map((c) => c.id))
                    )
                  }
                  className="text-xs font-medium text-brand-600 hover:text-brand-700"
                >
                  {allVisibleSelected ? "Bỏ chọn tất cả" : "Chọn tất cả (đang hiện)"}
                </button>
                {selected.size > 0 && (
                  <Button onClick={askAi} disabled={aiLoading}>
                    {aiLoading
                      ? "Đang phân tích..."
                      : `🤖 Hỏi AI (${selected.size} campaign)`}
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {/* Campaign → adset tree */}
          <div className="space-y-3">
            {visibleCampaigns.length === 0 ? (
              <EmptyState message="Không có campaign nào khớp bộ lọc." />
            ) : (
              pagedCampaigns.map((c) => {
              const reco = recoMap.get(c.id) as Reco | undefined;
              const isOpen = open.has(c.id);
              const checked = selected.has(c.id);
              return (
                <Card key={c.id} className="!p-0">
                  <div className="flex items-center">
                    <label
                      className="flex cursor-pointer items-center pl-4 pr-1"
                      title="Chọn để hỏi AI riêng campaign này"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelect(c.id)}
                        className="h-4 w-4 accent-brand-600"
                      />
                    </label>
                  <button
                    onClick={() => {
                      const n = new Set(open);
                      isOpen ? n.delete(c.id) : n.add(c.id);
                      setOpen(n);
                    }}
                    className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-slate-50"
                  >
                    <span className="text-slate-400">{isOpen ? "▾" : "▸"}</span>
                    <Badge tone="blue">{AD_PLATFORM_LABELS[c.platform] ?? c.platform}</Badge>
                    <span className="flex-1 font-semibold text-slate-800">
                      {c.name}
                      <span className="ml-2 text-xs font-normal text-slate-400">
                        {c.dataLevel === "campaign"
                          ? "chỉ số campaign (chưa có adset)"
                          : `${c.adsets.length} adset`}
                      </span>
                      {(c.status === "PAUSED" || c.status === "ARCHIVED") && (
                        <span className="ml-2 text-xs font-normal text-slate-400">
                          (đã tắt)
                        </span>
                      )}
                      {/* Judged vs its OWN store's break-even when it differs */}
                      {reco &&
                        Math.abs(reco.breakEven - data.breakEvenRoas) /
                          data.breakEvenRoas >
                          0.05 && (
                          <span className="ml-2 text-xs font-normal text-slate-400">
                            HV {formatMultiplier(reco.breakEven)}
                          </span>
                        )}
                    </span>
                    <KpiInline k={c} be={reco?.breakEven ?? data.breakEvenRoas} />
                    {c.effRoas == null && c.realRoas != null && (
                      <span
                        className={`hidden text-xs font-semibold md:inline ${
                          c.realRoas >= (reco?.breakEven ?? data.breakEvenRoas)
                            ? "text-emerald-600"
                            : "text-rose-600"
                        }`}
                        title={`Doanh thu Shopify ${formatJPY(
                          c.realRevenue ?? 0
                        )} · ${formatNumber(c.realOrders ?? 0)} đơn (khớp utm_campaign)`}
                      >
                        Shopify {formatMultiplier(c.realRoas)}
                      </span>
                    )}
                    {(() => {
                      const truth = c.effRoas ?? c.realRoas;
                      return (
                        truth != null &&
                        c.spend >= 3000 &&
                        c.roas > 1.5 * truth && (
                          <Badge tone="amber">⚠ NT khai cao</Badge>
                        )
                      );
                    })()}
                    {reco && <Badge tone={ACTION_TONE[reco.action]}>{ACTION_LABELS[reco.action]}</Badge>}
                  </button>
                  </div>

                  {isOpen && (
                    <div className="border-t border-slate-100 bg-slate-50/50 px-5 py-3">
                      {reco && reco.reasons.length > 0 && (
                        <ul className="mb-3 list-disc space-y-0.5 pl-5 text-xs text-slate-500">
                          {reco.reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      )}
                      <div className="space-y-2">
                        {c.adsets.map((a) => {
                          const ar = recoMap.get(a.id) as Reco | undefined;
                          const hasAds = (a.ads?.length ?? 0) > 0;
                          const adsOpen = openAdsets.has(a.id);
                          return (
                            <div
                              key={a.id}
                              className="rounded-lg border border-slate-200 bg-white px-4 py-2.5"
                            >
                              <div className="flex items-center gap-3">
                                <span className="flex-1 text-sm font-medium text-slate-700">
                                  {hasAds && (
                                    <button
                                      onClick={() => {
                                        const n = new Set(openAdsets);
                                        adsOpen ? n.delete(a.id) : n.add(a.id);
                                        setOpenAdsets(n);
                                      }}
                                      className="mr-1.5 text-slate-400"
                                    >
                                      {adsOpen ? "▾" : "▸"}
                                    </button>
                                  )}
                                  {a.name}
                                  {hasAds && (
                                    <span className="ml-2 text-xs font-normal text-slate-400">
                                      {a.ads.length} quảng cáo
                                    </span>
                                  )}
                                  {(a.status === "PAUSED" ||
                                    a.status === "ARCHIVED") && (
                                    <span className="ml-2 text-xs text-slate-400">(đã tắt)</span>
                                  )}
                                </span>
                                <KpiInline k={a} be={ar?.breakEven ?? data.breakEvenRoas} />
                                {ar && (
                                  <Badge tone={ACTION_TONE[ar.action]}>
                                    {ACTION_LABELS[ar.action]}
                                  </Badge>
                                )}
                              </div>
                              {ar && ar.reasons.length > 0 && (
                                <div className="mt-1.5 text-xs text-slate-500">
                                  {ar.reasons[0]}
                                </div>
                              )}

                              {/* AD (creative) tier */}
                              {hasAds && adsOpen && (
                                <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2">
                                  {a.ads.map((ad) => {
                                    const dr = recoMap.get(ad.id) as Reco | undefined;
                                    return (
                                      <div
                                        key={ad.id}
                                        className="flex items-center gap-3 rounded-md bg-slate-50 px-3 py-1.5"
                                      >
                                        <span className="flex-1 truncate text-xs text-slate-600">
                                          {ad.name}
                                          {(ad.status === "PAUSED" ||
                                            ad.status === "ARCHIVED") && (
                                            <span className="ml-2 text-slate-400">
                                              (đã tắt)
                                            </span>
                                          )}
                                        </span>
                                        <KpiInline
                                          k={ad}
                                          be={dr?.breakEven ?? data.breakEvenRoas}
                                        />
                                        {dr && (
                                          <Badge tone={ACTION_TONE[dr.action]}>
                                            {ACTION_LABELS[dr.action]}
                                          </Badge>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </Card>
              );
              })
            )}
          </div>

          {/* Pagination */}
          {visibleCampaigns.length > PAGE_SIZE && (
            <div className="flex items-center justify-between text-sm text-slate-500">
              <span>
                {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, visibleCampaigns.length)} /{" "}
                {visibleCampaigns.length} campaign
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  ← Trước
                </Button>
                <span className="text-xs">
                  Trang {safePage}/{totalPages}
                </span>
                <Button
                  variant="secondary"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Sau →
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Summary count that doubles as a quick action-filter toggle.
function CountCard({
  label,
  value,
  color,
  active,
  onClick,
}: {
  label: string;
  value: number;
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="text-left">
      <Card
        className={`transition ${
          active ? "!border-brand-500 ring-1 ring-brand-500" : "hover:bg-slate-50"
        }`}
      >
        <div className="text-xs uppercase text-slate-400">{label}</div>
        <div className={`mt-1 text-xl font-bold ${color}`}>{value}</div>
      </Card>
    </button>
  );
}

// Trend arrow next to ROAS: ↗/↘ + % (only when meaningful), 😴 fatigue, 🆕 new.
function TrendMark({ t }: { t?: Trend | null }) {
  if (!t) return null;
  const parts: string[] = [];
  if (t.flags.includes("NEW")) parts.push("🆕");
  else if (Math.abs(t.roasDelta) >= 0.05)
    parts.push(
      `${t.roasDelta > 0 ? "↗" : "↘"} ${t.roasDelta > 0 ? "+" : "−"}${Math.round(
        Math.abs(t.roasDelta) * 100
      )}%`
    );
  if (t.flags.includes("FATIGUE")) parts.push("😴");
  if (parts.length === 0) return null;
  return (
    <span
      className={
        t.flags.includes("WORSENING")
          ? "text-rose-500"
          : t.flags.includes("IMPROVING")
          ? "text-emerald-500"
          : "text-slate-400"
      }
      title="ROAS nửa kỳ sau so với nửa kỳ trước · 😴 = creative mệt mỏi (CTR giảm) · 🆕 = mới chạy"
    >
      {parts.join(" ")}
    </span>
  );
}

function KpiInline({ k, be }: { k: AdsetNode | CampaignNode | AdNode; be: number }) {
  const eff = k.effRoas;
  const effCpa = (k as CampaignNode).effCpa;
  return (
    <div className="hidden items-center gap-4 text-xs text-slate-500 md:flex">
      <span>{formatJPY(k.spend)}</span>
      {eff != null ? (
        <>
          {/* Shopify-anchored ROAS is THE number; platform's claim is muted */}
          <span
            className={`font-semibold ${
              eff >= be ? "text-emerald-600" : "text-rose-600"
            }`}
            title="ROAS THỰC = doanh thu Shopify (khớp UTM + phần kênh chưa khớp phân bổ theo tỷ trọng nền tảng) ÷ spend"
          >
            Thực {formatMultiplier(eff)}
          </span>
          <span className="text-slate-400" title="ROAS nền tảng tự báo (thường khai cao)">
            NT {formatMultiplier(k.roas)}
          </span>
        </>
      ) : (
        <span
          className={`font-semibold ${
            k.roas >= be ? "text-emerald-600" : "text-rose-600"
          }`}
        >
          ROAS {formatMultiplier(k.roas)}
        </span>
      )}
      <TrendMark t={k.trend} />
      <span title={`CPC ${formatJPY(k.cpc)} · CPM ${formatJPY(k.cpm)}`}>
        CPA{" "}
        {effCpa != null && effCpa > 0
          ? `${formatJPY(effCpa)} (thực)`
          : k.conversions > 0
          ? formatJPY(k.cpa)
          : "—"}
      </span>
      <span>CTR {formatPercent(k.ctr)}</span>
      <span>CVR {formatPercent(k.cvr)}</span>
      <span>{formatNumber(k.conversions)} cv</span>
    </div>
  );
}

function recoById(recos: Reco[]): Map<string, Reco> {
  const m = new Map<string, Reco>();
  for (const r of recos) m.set(r.id, r);
  return m;
}
