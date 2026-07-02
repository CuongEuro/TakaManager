"use client";

import { useEffect, useState } from "react";
import type { AdTree, CampaignNode, AdsetNode, Trend } from "@/lib/adinsights";
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

interface OptimizeResponse {
  preset: RangePreset;
  storeId: string | null;
  platform: string | null;
  breakEvenRoas: number;
  aov: number;
  tree: AdTree;
  optimize: OptimizeResult;
  attribution: AttributionInfo;
}

const PRESETS: RangePreset[] = ["last7", "thisMonth", "last30", "lastMonth"];

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

export default function OptimizePage() {
  const [preset, setPreset] = useState<RangePreset>("last30");
  const [storeId, setStoreId] = useState("");
  const [platform, setPlatform] = useState("");
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [data, setData] = useState<OptimizeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [ai, setAi] = useState<{ text: string; json: AiStrategy | null } | null>(
    null
  );
  const [aiLoading, setAiLoading] = useState(false);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [reportId, setReportId] = useState("");

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
  }, [preset, storeId, platform]);

  async function askAi() {
    setAiLoading(true);
    setAi(null);
    setReportId("");
    try {
      const r = await fetch("/api/ads/optimize/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset, storeId, platform }),
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

  const recoMap = data ? recoById(data.optimize.recommendations) : new Map();
  const counts = data?.optimize.counts;

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
          </div>
        }
      />

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
                <Card>
                  <div className="text-xs uppercase text-slate-400">Nên scale</div>
                  <div className="mt-1 text-xl font-bold text-emerald-600">
                    {counts.SCALE}
                  </div>
                </Card>
                <Card>
                  <div className="text-xs uppercase text-slate-400">Giảm/Tối ưu</div>
                  <div className="mt-1 text-xl font-bold text-amber-600">
                    {counts.REDUCE}
                  </div>
                </Card>
                <Card>
                  <div className="text-xs uppercase text-slate-400">Nên dừng</div>
                  <div className="mt-1 text-xl font-bold text-rose-600">
                    {counts.PAUSE}
                  </div>
                </Card>
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

          {/* UTM reconciliation — how trustworthy the "Shopify ROAS" column is */}
          {data.attribution && data.attribution.paidOrders > 0 && (
            <Card>
              <details>
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

          {/* Campaign → adset tree */}
          <div className="space-y-3">
            {data.tree.campaigns.map((c) => {
              const reco = recoMap.get(c.id) as Reco | undefined;
              const isOpen = open.has(c.id);
              return (
                <Card key={c.id} className="!p-0">
                  <button
                    onClick={() => {
                      const n = new Set(open);
                      isOpen ? n.delete(c.id) : n.add(c.id);
                      setOpen(n);
                    }}
                    className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-slate-50"
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
                    {c.realRoas != null && (
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
                    {c.realRoas != null &&
                      c.spend >= 3000 &&
                      c.roas > 1.5 * c.realRoas && (
                        <Badge tone="amber">⚠ Platform khai cao</Badge>
                      )}
                    {reco && <Badge tone={ACTION_TONE[reco.action]}>{ACTION_LABELS[reco.action]}</Badge>}
                  </button>

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
                          return (
                            <div
                              key={a.id}
                              className="rounded-lg border border-slate-200 bg-white px-4 py-2.5"
                            >
                              <div className="flex items-center gap-3">
                                <span className="flex-1 text-sm font-medium text-slate-700">
                                  {a.name}
                                  {a.status === "PAUSED" && (
                                    <span className="ml-2 text-xs text-slate-400">(đang tắt)</span>
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
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
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

function KpiInline({ k, be }: { k: AdsetNode | CampaignNode; be: number }) {
  return (
    <div className="hidden items-center gap-4 text-xs text-slate-500 md:flex">
      <span>{formatJPY(k.spend)}</span>
      <span
        className={`font-semibold ${
          k.roas >= be ? "text-emerald-600" : "text-rose-600"
        }`}
      >
        ROAS {formatMultiplier(k.roas)}
      </span>
      <TrendMark t={k.trend} />
      <span title={`CPC ${formatJPY(k.cpc)} · CPM ${formatJPY(k.cpm)}`}>
        CPA {k.conversions > 0 ? formatJPY(k.cpa) : "—"}
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
