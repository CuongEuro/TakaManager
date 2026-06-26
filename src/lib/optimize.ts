// ---------------------------------------------------------------------------
// RULE-BASED OPTIMIZER — turns the Campaign→AdSet KPI tree into concrete
// per-entity actions (Scale / Keep / Reduce / Pause / Review) with reasons.
// Deterministic; works without any AI key. ROAS is judged vs break-even.
// ---------------------------------------------------------------------------
import { AdTree, Kpis } from "@/lib/adinsights";
import { formatJPY, formatMultiplier, formatPercent } from "@/lib/format";

export type Action = "SCALE" | "KEEP" | "REDUCE" | "PAUSE" | "REVIEW";

export const ACTION_LABELS: Record<Action, string> = {
  SCALE: "🚀 Tăng ngân sách",
  KEEP: "✓ Giữ & theo dõi",
  REDUCE: "↓ Giảm / Tối ưu",
  PAUSE: "⛔ Tạm dừng",
  REVIEW: "🔍 Chưa đủ data",
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
  reasons: string[];
}

export interface OptimizeResult {
  breakEvenRoas: number;
  recommendations: Reco[];
  counts: Record<Action, number>;
}

const DEFAULT_MIN_SPEND = 3000; // ¥ over the range — below this we can't judge

function evaluate(
  k: Kpis,
  be: number,
  minSpend: number
): { action: Action; priority: number; reasons: string[] } {
  const reasons: string[] = [];

  if (k.spend < minSpend) {
    reasons.push(
      `Chi tiêu thấp (${formatJPY(k.spend)}) — chưa đủ dữ liệu để kết luận.`
    );
    return { action: "REVIEW", priority: 3, reasons };
  }

  if (k.conversions === 0) {
    reasons.push(
      `Đã tiêu ${formatJPY(k.spend)} nhưng 0 chuyển đổi — nên tạm dừng.`
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
  opts: { minSpend?: number } = {}
): OptimizeResult {
  const be = breakEvenRoas > 0 ? breakEvenRoas : 1;
  const minSpend = opts.minSpend ?? DEFAULT_MIN_SPEND;
  const recs: Reco[] = [];

  for (const c of tree.campaigns) {
    const ce = evaluate(c, be, minSpend);

    // structural hint: budget reallocation when adsets diverge
    const scalers = c.adsets.filter(
      (a) => a.spend >= minSpend && a.roas >= be * 1.3
    );
    const losers = c.adsets.filter(
      (a) => a.spend >= minSpend && a.roas < be * 0.7 && a.conversions >= 0
    );
    if (scalers.length && losers.length) {
      ce.reasons.push(
        `Tái phân bổ: chuyển ngân sách từ ${losers.length} adset kém sang ${scalers.length} adset tốt trong campaign.`
      );
    }

    recs.push({
      level: "CAMPAIGN",
      id: c.id,
      name: c.name,
      action: ce.action,
      priority: ce.priority,
      roas: c.roas,
      spend: c.spend,
      reasons: ce.reasons,
    });

    for (const a of c.adsets) {
      const ae = evaluate(a, be, minSpend);
      recs.push({
        level: "ADSET",
        id: a.id,
        name: a.name,
        campaignName: c.name,
        action: ae.action,
        priority: ae.priority,
        roas: a.roas,
        spend: a.spend,
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
  };
  for (const r of recs) counts[r.action]++;

  // sort: highest priority first, then by spend (biggest money first)
  recs.sort((a, b) => a.priority - b.priority || b.spend - a.spend);

  return { breakEvenRoas: be, recommendations: recs, counts };
}
