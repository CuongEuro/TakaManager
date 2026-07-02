// ---------------------------------------------------------------------------
// RULE-BASED OPTIMIZER — turns the Campaign→AdSet KPI tree into concrete
// per-entity actions (Scale / Keep / Reduce / Pause / Review) with reasons.
// Deterministic; works without any AI key. ROAS is judged vs break-even —
// per-campaign break-even (its store's margin) when available.
// ---------------------------------------------------------------------------
import { AdTree, Kpis } from "@/lib/adinsights";
import { formatJPY, formatMultiplier, formatPercent } from "@/lib/format";

export type Action =
  | "SCALE"
  | "KEEP"
  | "REDUCE"
  | "PAUSE"
  | "REVIEW"
  | "NO_DATA"
  | "OFF";

export const ACTION_LABELS: Record<Action, string> = {
  SCALE: "🚀 Tăng ngân sách",
  KEEP: "✓ Giữ & theo dõi",
  REDUCE: "↓ Giảm / Tối ưu",
  PAUSE: "⛔ Tạm dừng",
  REVIEW: "🔍 Chưa đủ data",
  NO_DATA: "⚠ Thiếu tracking chuyển đổi",
  OFF: "💤 Đã tắt",
};

export interface Reco {
  level: "CAMPAIGN" | "ADSET";
  id: string;
  name: string;
  campaignName?: string;
  action: Action;
  priority: number; // 1 = cao nhất
  roas: number;
  spend: number;
  breakEven: number; // the bar this entity was judged against
  reasons: string[];
}

export interface OptimizeResult {
  breakEvenRoas: number;
  recommendations: Reco[];
  counts: Record<Action, number>;
}

const DEFAULT_MIN_SPEND = 3000; // ¥ over the range — below this we can't judge

const isOff = (status: string | null | undefined) =>
  status === "PAUSED" || status === "ARCHIVED";

function evaluate(
  k: Kpis,
  be: number,
  minSpend: number,
  pauseMinSpend: number,
  noConvData: boolean
): { action: Action; priority: number; reasons: string[] } {
  const reasons: string[] = [];

  if (k.spend < minSpend) {
    reasons.push(
      `Chi tiêu thấp (${formatJPY(k.spend)}) — chưa đủ dữ liệu để kết luận.`
    );
    return { action: "REVIEW", priority: 3, reasons };
  }

  if (k.conversions === 0) {
    // The whole platform reports zero conversions → tracking gap, not a bad
    // campaign. Don't recommend killing spend based on missing data.
    if (noConvData) {
      reasons.push(
        "Nền tảng không trả về dữ liệu chuyển đổi nào — kiểm tra conversion tracking trước khi đánh giá."
      );
      return { action: "NO_DATA", priority: 2, reasons };
    }
    if (k.spend < pauseMinSpend) {
      reasons.push(
        `Đã tiêu ${formatJPY(k.spend)} với 0 chuyển đổi — chưa chạm ngưỡng kết luận ${formatJPY(
          pauseMinSpend
        )} (~2×AOV), theo dõi thêm.`
      );
      return { action: "REVIEW", priority: 2, reasons };
    }
    reasons.push(
      `Đã tiêu ${formatJPY(k.spend)} (≥ ${formatJPY(
        pauseMinSpend
      )} ≈ 2×AOV) nhưng 0 chuyển đổi — nên tạm dừng.`
    );
    return { action: "PAUSE", priority: 1, reasons };
  }

  // creative / landing diagnostics
  if (k.ctr < 0.01)
    reasons.push(`CTR thấp (${formatPercent(k.ctr)}) → creative chưa hấp dẫn.`);
  else if (k.cvr < 0.01)
    reasons.push(
      `CTR ổn nhưng CVR thấp (${formatPercent(k.cvr)}) → landing/offer/giá cần xem lại.`
    );

  let action: Action;
  let priority: number;
  const ratio = be > 0 ? k.roas / be : 0;

  if (k.roas >= be * 1.3 && k.conversions >= 3) {
    action = "SCALE";
    priority = 1;
    reasons.unshift(
      `ROAS ${formatMultiplier(k.roas)} cao hơn hoà vốn (${formatMultiplier(
        be
      )}) — tăng ngân sách 20–30%, giữ nhịp.`
    );
  } else if (k.roas >= be) {
    action = "KEEP";
    priority = 3;
    reasons.unshift(
      `ROAS ${formatMultiplier(k.roas)} trên hoà vốn — duy trì, theo dõi tần suất/CPA.`
    );
  } else if (ratio >= 0.7) {
    action = "REDUCE";
    priority = 2;
    reasons.unshift(
      `ROAS ${formatMultiplier(k.roas)} dưới hoà vốn (${formatMultiplier(
        be
      )}) — giảm budget/bid, tinh chỉnh target & creative.`
    );
  } else {
    action = "PAUSE";
    priority = 1;
    reasons.unshift(
      `ROAS ${formatMultiplier(k.roas)} quá thấp so với hoà vốn — tạm dừng để cắt lỗ.`
    );
  }
  reasons.push(`CPA ${formatJPY(k.cpa)} · ${k.conversions.toFixed(0)} chuyển đổi.`);
  return { action, priority, reasons };
}

export function optimizeTree(
  tree: AdTree,
  breakEvenRoas: number,
  opts: {
    minSpend?: number;
    /** PAUSE-for-zero-conversions threshold (≈ 2×AOV). */
    pauseMinSpend?: number;
    /** Per-campaign break-even (campaign id → its store's BE). */
    campaignBe?: Map<string, number>;
  } = {}
): OptimizeResult {
  const blended = breakEvenRoas > 0 ? breakEvenRoas : 1;
  const minSpend = opts.minSpend ?? DEFAULT_MIN_SPEND;
  const pauseMinSpend = Math.max(minSpend, opts.pauseMinSpend ?? minSpend);
  const recs: Reco[] = [];

  // Platforms whose data carries ZERO conversions despite real spend — a
  // tracking gap (e.g. X without conversion tracking): flag, don't PAUSE.
  const platConv = new Map<string, { spend: number; conv: number }>();
  for (const c of tree.campaigns) {
    const p = platConv.get(c.platform) ?? { spend: 0, conv: 0 };
    p.spend += c.spend;
    p.conv += c.conversions;
    platConv.set(c.platform, p);
  }
  const noConvPlatforms = new Set(
    [...platConv.entries()]
      .filter(([, v]) => v.spend > minSpend && v.conv === 0)
      .map(([k]) => k)
  );

  for (const c of tree.campaigns) {
    const be = opts.campaignBe?.get(c.id) ?? blended;
    const noConvData = noConvPlatforms.has(c.platform);
    const campaignOff = isOff(c.status);

    let ce: { action: Action; priority: number; reasons: string[] };
    if (campaignOff) {
      ce = {
        action: "OFF",
        priority: 5,
        reasons: ["Campaign đã tắt trên nền tảng — không cần hành động."],
      };
    } else {
      ce = evaluate(c, be, minSpend, pauseMinSpend, noConvData);

      // structural hint: budget reallocation when adsets diverge
      const scalers = c.adsets.filter(
        (a) => !isOff(a.status) && a.spend >= minSpend && a.roas >= be * 1.3
      );
      const losers = c.adsets.filter(
        (a) => !isOff(a.status) && a.spend >= minSpend && a.roas < be * 0.7
      );
      if (scalers.length && losers.length) {
        ce.reasons.push(
          `Tái phân bổ: chuyển ngân sách từ ${losers.length} adset kém sang ${scalers.length} adset tốt trong campaign.`
        );
      }
    }

    recs.push({
      level: "CAMPAIGN",
      id: c.id,
      name: c.name,
      action: ce.action,
      priority: ce.priority,
      roas: c.roas,
      spend: c.spend,
      breakEven: be,
      reasons: ce.reasons,
    });

    for (const a of c.adsets) {
      const ae =
        campaignOff || isOff(a.status)
          ? {
              action: "OFF" as Action,
              priority: 5,
              reasons: [
                campaignOff
                  ? "Campaign cha đã tắt — adset không chạy."
                  : "Adset đã tắt trên nền tảng — không cần hành động.",
              ],
            }
          : evaluate(a, be, minSpend, pauseMinSpend, noConvData);
      recs.push({
        level: "ADSET",
        id: a.id,
        name: a.name,
        campaignName: c.name,
        action: ae.action,
        priority: ae.priority,
        roas: a.roas,
        spend: a.spend,
        breakEven: be,
        reasons: ae.reasons,
      });
    }
  }

  const counts: Record<Action, number> = {
    SCALE: 0,
    KEEP: 0,
    REDUCE: 0,
    PAUSE: 0,
    REVIEW: 0,
    NO_DATA: 0,
    OFF: 0,
  };
  for (const r of recs) counts[r.action]++;

  // sort: highest priority first, then by spend (biggest money first)
  recs.sort((a, b) => a.priority - b.priority || b.spend - a.spend);

  return { breakEvenRoas: blended, recommendations: recs, counts };
}
