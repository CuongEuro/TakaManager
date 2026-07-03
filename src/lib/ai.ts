// ---------------------------------------------------------------------------
// AI OPTIMIZER — uses Claude (Anthropic SDK) to turn the campaign→adset KPI tree
// + rule-based recommendations into a media-buying strategy (in Vietnamese).
// v2: sends real Shopify ROAS / per-campaign break-even / trends / budget plan
// and asks for STRUCTURED JSON (falls back to raw text if parsing fails).
// Degrades gracefully when ANTHROPIC_API_KEY is not set.
// ---------------------------------------------------------------------------
import Anthropic from "@anthropic-ai/sdk";
import { AdTree } from "@/lib/adinsights";
import { OptimizeResult } from "@/lib/optimize";
import { PlatformCalibration } from "@/lib/attribution";

export const AI_MODEL = "claude-opus-4-8";

export interface AiAction {
  target: string;
  level: "CAMPAIGN" | "ADSET";
  platform: string;
  action:
    | "SCALE"
    | "REDUCE"
    | "PAUSE"
    | "KEEP"
    | "FIX_CREATIVE"
    | "FIX_LANDING"
    | "FIX_TRACKING";
  detail: string;
  expectedImpact: string;
}

export interface AiStrategy {
  summary: string;
  actions: AiAction[];
  creativeIdeas: string[];
}

export interface AiOptimizeResult {
  ok: boolean;
  text?: string; // raw model output (audit / fallback rendering)
  json?: AiStrategy | null; // parsed structured strategy (null if unparsable)
  error?: string;
}

// Compact the tree so we send only what's needed (control token cost).
function buildPayload(
  tree: AdTree,
  rules: OptimizeResult,
  extra: {
    matchRate?: number;
    aov?: number;
    calibration?: PlatformCalibration[];
  }
) {
  const beByCampaign = new Map<string, number>();
  for (const r of rules.recommendations)
    if (r.level === "CAMPAIGN") beByCampaign.set(r.id, r.breakEven);

  return {
    breakEvenRoas: Number(rules.breakEvenRoas.toFixed(2)),
    aov: Math.round(extra.aov ?? 0),
    utmMatchRate: Number(((extra.matchRate ?? 0) * 100).toFixed(0)), // %
    // Per-platform reconciliation: how much the platform over-reports vs the
    // Shopify channel truth, and the TRUE blended ROAS/CPA per platform.
    platformCalibration: (extra.calibration ?? []).map((p) => ({
      platform: p.platform,
      spend: Math.round(p.spend),
      platformClaimedRevenue: Math.round(p.platformRevenue),
      shopifyRealRevenue: Math.round(p.shopifyRevenue),
      shopifyRealOrders: p.shopifyOrders,
      overReportFactor: p.overReport != null ? Number(p.overReport.toFixed(2)) : null,
      trueRoas: Number(p.effRoas.toFixed(2)),
      trueCpa: Math.round(p.effCpa),
    })),
    totals: {
      spend: Math.round(tree.totals.spend),
      revenue: Math.round(tree.totals.revenue),
      roas: Number(tree.totals.roas.toFixed(2)),
      conversions: Math.round(tree.totals.conversions),
    },
    ruleCounts: rules.counts,
    budgetPlan: rules.budgetPlan.slice(0, 8).map((m) => ({
      platform: m.platform,
      to: m.to,
      dailyAmount: m.dailyAmount,
      estDailyProfit: m.estDailyProfit,
    })),
    campaigns: tree.campaigns.slice(0, 40).map((c) => ({
      name: c.name,
      platform: c.platform,
      status: c.status,
      dataLevel: c.dataLevel,
      breakEven: Number((beByCampaign.get(c.id) ?? rules.breakEvenRoas).toFixed(2)),
      spend: Math.round(c.spend),
      revenue: Math.round(c.revenue),
      roas: Number(c.roas.toFixed(2)),
      realRoasShopify: c.realRoas != null ? Number(c.realRoas.toFixed(2)) : null,
      realOrdersShopify: c.realOrders ?? null,
      effRoas: c.effRoas != null ? Number(c.effRoas.toFixed(2)) : null,
      effOrders: c.effOrders != null ? Math.round(c.effOrders) : null,
      effCpa: c.effCpa != null ? Math.round(c.effCpa) : null,
      conversions: Math.round(c.conversions),
      cpa: Math.round(c.cpa),
      ctr: Number((c.ctr * 100).toFixed(2)),
      cvr: Number((c.cvr * 100).toFixed(2)),
      trend: c.trend
        ? {
            roasDeltaPct: Number((c.trend.roasDelta * 100).toFixed(0)),
            ctrDeltaPct: Number((c.trend.ctrDelta * 100).toFixed(0)),
            flags: c.trend.flags,
          }
        : null,
      adsets: c.adsets.slice(0, 12).map((a) => ({
        name: a.name,
        status: a.status,
        spend: Math.round(a.spend),
        revenue: Math.round(a.revenue),
        roas: Number(a.roas.toFixed(2)),
        conversions: Math.round(a.conversions),
        cpa: Math.round(a.cpa),
        ctr: Number((a.ctr * 100).toFixed(2)),
        cvr: Number((a.cvr * 100).toFixed(2)),
        trendFlags: a.trend?.flags ?? [],
      })),
    })),
  };
}

const SYSTEM_PROMPT = `Bạn là chuyên gia mua quảng cáo (media buyer) cấp cao cho doanh nghiệp Print-on-Demand bán tại thị trường Nhật Bản, chạy đa nền tảng Facebook/Meta, Google, Twitter/X.

Bạn nhận dữ liệu Campaign → Adset kèm KPI (spend, revenue, ROAS, conversions, CPA, CTR%, CVR%), điểm hoà vốn ROAS RIÊNG từng campaign (breakEven — theo biên lợi nhuận store của campaign đó), ROAS THỰC từ Shopify ở 2 mức: realRoasShopify (doanh thu đơn khớp utm_campaign) và effRoas/effCpa/effOrders (SỐ HIỆU CHỈNH: doanh thu Shopify thật của cả kênh phân bổ về từng campaign — tổng luôn khớp Shopify, đã loại bỏ khai khống của nền tảng). Kèm platformCalibration (mỗi nền tảng: doanh thu nền tảng khai vs Shopify thật, hệ số khai cao overReportFactor, trueRoas/trueCpa), xu hướng (trend: WORSENING/IMPROVING/FATIGUE/NEW), và kế hoạch tái phân bổ sơ bộ (budgetPlan).

Nguyên tắc:
- TRACKING NỀN TẢNG KHÔNG ĐÁNG TIN. Thứ tự ưu tiên khi đánh giá: effRoas/effCpa (chuẩn nhất) > realRoasShopify > số nền tảng (chỉ dùng để so TƯƠNG ĐỐI giữa các campaign cùng nền tảng, không dùng giá trị tuyệt đối).
- So ROAS với breakEven CỦA TỪNG campaign. Nêu rõ hệ số khai cao của nền tảng khi nó lớn (overReportFactor ≥ 1.5).
- status PAUSED/ARCHIVED = đã tắt → đừng khuyên tạm dừng nữa.
- Chẩn đoán phễu: CTR thấp = creative; CTR ổn + CVR thấp = landing/giá/offer; FATIGUE = creative mệt mỏi cần mẫu mới.
- WORSENING → đừng scale, cân nhắc giảm sớm. Tiền lớn xử lý trước.
- Không bịa số liệu ngoài dữ liệu được cung cấp.

TRẢ VỀ DUY NHẤT MỘT JSON HỢP LỆ (không markdown fence, không chữ nào ngoài JSON) theo đúng schema:
{
  "summary": "2-4 câu tiếng Việt: bức tranh chung + ưu tiên số 1",
  "actions": [
    {
      "target": "tên campaign/adset",
      "level": "CAMPAIGN" | "ADSET",
      "platform": "FACEBOOK" | "GOOGLE" | "TWITTER",
      "action": "SCALE" | "REDUCE" | "PAUSE" | "KEEP" | "FIX_CREATIVE" | "FIX_LANDING" | "FIX_TRACKING",
      "detail": "làm gì cụ thể, kèm số liệu",
      "expectedImpact": "tác động kỳ vọng"
    }
  ],
  "creativeIdeas": ["2-5 ý tưởng creative/test tiếp theo"]
}
Tối đa 12 actions, sắp theo ưu tiên giảm dần.`;

/** Parse the model output into AiStrategy (strip fences, validate shape). */
export function parseAiStrategy(text: string): AiStrategy | null {
  try {
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    // tolerate stray prose around the JSON object
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const obj = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof obj.summary !== "string" || !Array.isArray(obj.actions))
      return null;
    const actions: AiAction[] = [];
    for (const a of obj.actions as Record<string, unknown>[]) {
      if (!a || typeof a.target !== "string" || typeof a.action !== "string")
        continue;
      actions.push({
        target: a.target,
        level: a.level === "ADSET" ? "ADSET" : "CAMPAIGN",
        platform: typeof a.platform === "string" ? a.platform : "",
        action: a.action as AiAction["action"],
        detail: typeof a.detail === "string" ? a.detail : "",
        expectedImpact:
          typeof a.expectedImpact === "string" ? a.expectedImpact : "",
      });
    }
    return {
      summary: obj.summary,
      actions,
      creativeIdeas: Array.isArray(obj.creativeIdeas)
        ? (obj.creativeIdeas as unknown[]).filter(
            (x): x is string => typeof x === "string"
          )
        : [],
    };
  } catch {
    return null;
  }
}

export async function aiOptimize(
  tree: AdTree,
  rules: OptimizeResult,
  context: {
    preset: string;
    storeName?: string | null;
    matchRate?: number;
    aov?: number;
    calibration?: PlatformCalibration[];
  }
): Promise<AiOptimizeResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      error:
        "Chưa cấu hình ANTHROPIC_API_KEY. Thêm vào file .env để bật chiến lược AI (luật cứng vẫn hoạt động).",
    };
  }
  if (tree.campaigns.length === 0) {
    return { ok: false, error: "Không có dữ liệu campaign để phân tích." };
  }

  const client = new Anthropic();
  const payload = buildPayload(tree, rules, {
    matchRate: context.matchRate,
    aov: context.aov,
    calibration: context.calibration,
  });

  try {
    const response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      // Adaptive thinking is the correct on-mode for Opus 4.8 (budget_tokens 400s);
      // cast because the installed SDK's types predate the "adaptive" variant.
      thinking: { type: "adaptive" } as unknown as Anthropic.ThinkingConfigParam,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Khoảng thời gian: ${context.preset}${
            context.storeName ? ` · Store: ${context.storeName}` : " · Tất cả store"
          }.\n\nDữ liệu hiệu suất (JSON):\n${JSON.stringify(
            payload,
            null,
            2
          )}\n\nTrả về JSON chiến lược theo đúng schema đã nêu.`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return {
      ok: true,
      text: text || "(AI không trả về nội dung.)",
      json: parseAiStrategy(text),
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
