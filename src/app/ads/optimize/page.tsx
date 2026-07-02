"use client";

import { useEffect, useState } from "react";
import type { AdTree, CampaignNode, AdsetNode } from "@/lib/adinsights";
import type { OptimizeResult, Reco, Action } from "@/lib/optimize";
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
  const [ai, setAi] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    fetch("/api/stores")
      .then((r) => r.json())
      .then((s) => setStores(s.map((x: { id: string; name: string }) => x)));
  }, []);

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
    try {
      const r = await fetch("/api/ads/optimize/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset, storeId, platform }),
      }).then((x) => x.json());
      setAi(r.ok ? r.text : `⚠ ${r.error}`);
    } catch (e) {
      setAi(`⚠ ${e instanceof Error ? e.message : String(e)}`);
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

          {/* AI strategy */}
          <Card>
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-700">
                Chiến lược AI (Claude)
              </div>
              <Button onClick={askAi} disabled={aiLoading}>
                {aiLoading ? "Đang phân tích..." : "🤖 Hỏi AI chiến lược"}
              </Button>
            </div>
            {ai && (
              <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
                {ai}
              </pre>
            )}
          </Card>

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
