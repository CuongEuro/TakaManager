// ---------------------------------------------------------------------------
// AI OPTIMIZER — uses Claude (Anthropic SDK) to turn the campaign→adset KPI tree
// + rule-based recommendations into a media-buying strategy (in Vietnamese).
// Degrades gracefully when ANTHROPIC_API_KEY is not set.
// ---------------------------------------------------------------------------
import Anthropic from "@anthropic-ai/sdk";
import { AdTree } from "@/lib/adinsights";
import { OptimizeResult } from "@/lib/optimize";

export interface AiOptimizeResult {
  ok: boolean;
  text?: string;
  error?: string;
}

// Compact the tree so we send only what's needed (control token cost).
function buildPayload(tree: AdTree, rules: OptimizeResult) {
  return {
    breakEvenRoas: Number(rules.breakEvenRoas.toFixed(2)),
    totals: {
      spend: Math.round(tree.totals.spend),
      revenue: Math.round(tree.totals.revenue),
      roas: Number(tree.totals.roas.toFixed(2)),
      conversions: Math.round(tree.totals.conversions),
    },
    ruleCounts: rules.counts,
    campaigns: tree.campaigns.slice(0, 40).map((c) => ({
      name: c.name,
      platform: c.platform,
      spend: Math.round(c.spend),
      revenue: Math.round(c.revenue),
      roas: Number(c.roas.toFixed(2)),
      conversions: Math.round(c.conversions),
      cpa: Math.round(c.cpa),
      ctr: Number((c.ctr * 100).toFixed(2)),
      cvr: Number((c.cvr * 100).toFixed(2)),
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
      })),
    })),
  };
}

const SYSTEM_PROMPT = `Bạn là chuyên gia mua quảng cáo (media buyer) cấp cao cho doanh nghiệp Print-on-Demand bán tại thị trường Nhật Bản, chạy đa nền tảng Facebook/Meta, Google, Twitter/X.

Bạn nhận dữ liệu hiệu suất theo cấu trúc Campaign → Adset kèm KPI (spend, revenue, ROAS, conversions, CPA, CTR%, CVR%) và một điểm hoà vốn ROAS (break-even). Nhiệm vụ: đưa ra CHIẾN LƯỢC ĐIỀU CHỈNH cụ thể, có thể hành động ngay.

Nguyên tắc:
- ROAS ≥ break-even là có lãi; càng cao hơn càng nên tăng ngân sách (scale). Dưới break-even là đang lỗ → tối ưu hoặc cắt.
- Chẩn đoán theo phễu: CTR thấp = creative chưa hấp dẫn; CTR ổn nhưng CVR thấp = vấn đề landing/giá/offer; CPA cao so với giá trị đơn = cần siết targeting/bid.
- Trong 1 campaign, nếu có adset tốt và adset kém → khuyến nghị tái phân bổ ngân sách.
- Ưu tiên hành động theo mức chi tiêu (tiền lớn xử lý trước).

Trả lời bằng tiếng Việt, ngắn gọn, theo cấu trúc:
1) TỔNG QUAN (2-3 câu: bức tranh chung + ưu tiên số 1).
2) HÀNH ĐỘNG NGAY (bullet: scale gì, cắt gì, sửa gì — nêu tên campaign/adset + lý do số liệu).
3) THEO TỪNG NỀN TẢNG (Facebook/Google/Twitter: nhận định + việc cần làm).
4) GỢI Ý CREATIVE/TEST tiếp theo (2-4 ý).
Không bịa số liệu ngoài dữ liệu được cung cấp.`;

export async function aiOptimize(
  tree: AdTree,
  rules: OptimizeResult,
  context: { preset: string; storeName?: string | null }
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
  const payload = buildPayload(tree, rules);

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
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
          )}\n\nHãy đưa ra chiến lược điều chỉnh ads theo cấu trúc đã hướng dẫn.`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return { ok: true, text: text || "(AI không trả về nội dung.)" };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
