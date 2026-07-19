// ---------------------------------------------------------------------------
// AD ALERTS — daily rule evaluation over CAMPAIGN-level AdMetric (last 14d),
// run by the cron after the ad sync. Creates AdAlert rows (in-app inbox).
// Campaign-level only: adset alerts would multiply the noise.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { computeStoreBreakEvens } from "@/lib/pnl";
import { formatJPY, formatMultiplier } from "@/lib/format";
import { isoDay } from "@/lib/dates";

const DAY = 86400000;

type DayRow = { spend: number; revenue: number };

/** Evaluate alert rules for one org. Returns the number of alerts created.
 *  Dedupe: an identical (type, accountId, entityName) alert within the last
 *  3 days suppresses re-creation, so the daily cron doesn't spam. */
export async function evaluateAdAlerts(organizationId: string): Promise<number> {
  const now = new Date();
  const since14 = new Date(now.getTime() - 14 * DAY);
  const since30 = new Date(now.getTime() - 30 * DAY);

  const [campaigns, bes, accounts] = await Promise.all([
    prisma.adEntity.findMany({
      where: { organizationId, level: "CAMPAIGN" },
      include: { metrics: { where: { date: { gte: since14 } } } },
    }),
    computeStoreBreakEvens(organizationId, since30, now),
    prisma.adAccount.findMany({
      where: { organizationId },
      select: { id: true, storeId: true },
    }),
  ]);
  const accountStore = new Map(accounts.map((a) => [a.id, a.storeId]));

  // Platform-wide zero-conversion detection (tracking gap → ONE alert).
  const platAgg = new Map<string, { spend: number; conv: number }>();
  for (const c of campaigns) {
    const p = platAgg.get(c.platform) ?? { spend: 0, conv: 0 };
    for (const m of c.metrics) {
      p.spend += m.spend;
      p.conv += m.conversions;
    }
    platAgg.set(c.platform, p);
  }

  const candidates: {
    severity: string;
    type: string;
    platform: string | null;
    accountId: string | null;
    entityName: string;
    message: string;
  }[] = [];

  for (const [platform, agg] of platAgg) {
    if (agg.spend >= 5000 && agg.conv === 0)
      candidates.push({
        severity: "WARN",
        type: "TRACKING",
        platform,
        accountId: null,
        entityName: platform,
        message: `${platform}: đã tiêu ${formatJPY(
          agg.spend
        )} trong 14 ngày nhưng KHÔNG có chuyển đổi nào được ghi nhận — kiểm tra conversion tracking.`,
      });
  }

  for (const c of campaigns) {
    if (c.status === "PAUSED" || c.status === "ARCHIVED") continue;
    if (c.metrics.length === 0) continue;
    const platformNoConv =
      (platAgg.get(c.platform)?.conv ?? 0) === 0 &&
      (platAgg.get(c.platform)?.spend ?? 0) >= 5000;

    const storeId = c.storeId ?? accountStore.get(c.accountId) ?? null;
    const be = (storeId ? bes.byStore.get(storeId) : undefined) ?? bes.blended;

    // Daily buckets (calendar days).
    const byDay = new Map<string, DayRow & { conv: number; impr: number; clicks: number }>();
    for (const m of c.metrics) {
      const k = isoDay(m.date);
      const cur = byDay.get(k) ?? { spend: 0, revenue: 0, conv: 0, impr: 0, clicks: 0 };
      cur.spend += m.spend;
      cur.revenue += m.revenue;
      cur.conv += m.conversions;
      cur.impr += m.impressions;
      cur.clicks += m.clicks;
      byDay.set(k, cur);
    }
    // Last 3 FULL days (yesterday backwards — today is partial).
    const last3: (DayRow & { conv: number })[] = [];
    for (let i = 1; i <= 3; i++) {
      const k = isoDay(new Date(now.getTime() - i * DAY));
      const d = byDay.get(k);
      last3.push(d ?? { spend: 0, revenue: 0, conv: 0, impr: 0, clicks: 0 });
    }
    const spend3 = last3.reduce((s, d) => s + d.spend, 0);
    const conv3 = last3.reduce((s, d) => s + d.conv, 0);

    // (1) CRIT — burning: 3 consecutive days below break-even with real spend.
    const burning =
      spend3 >= 5000 &&
      last3.every((d) => d.spend > 0 && d.revenue / d.spend < be);
    if (burning) {
      const roas3 = spend3 > 0 ? last3.reduce((s, d) => s + d.revenue, 0) / spend3 : 0;
      candidates.push({
        severity: "CRIT",
        type: "BURNING",
        platform: c.platform,
        accountId: c.accountId,
        entityName: c.name,
        message: `"${c.name}" dưới hoà vốn 3 ngày liên tiếp — ROAS 3 ngày ${formatMultiplier(
          roas3
        )} vs hoà vốn ${formatMultiplier(be)}, đã tiêu ${formatJPY(spend3)}.`,
      });
    }

    // (2) WARN — ROAS drop: last7 ≤ 0.7 × prior7.
    const sumWin = (from: number, to: number) => {
      // days ago in [from, to)
      const acc = { spend: 0, revenue: 0 };
      for (let i = from; i < to; i++) {
        const d = byDay.get(isoDay(new Date(now.getTime() - i * DAY)));
        if (d) {
          acc.spend += d.spend;
          acc.revenue += d.revenue;
        }
      }
      return acc;
    };
    const w1 = sumWin(1, 8); // last 7 full days
    const w0 = sumWin(8, 15); // the 7 before
    if (w1.spend >= 3000 && w0.spend >= 3000) {
      const r1 = w1.revenue / w1.spend;
      const r0 = w0.revenue / w0.spend;
      if (r0 > 0 && r1 <= 0.7 * r0) {
        candidates.push({
          severity: "WARN",
          type: "ROAS_DROP",
          platform: c.platform,
          accountId: c.accountId,
          entityName: c.name,
          message: `"${c.name}" ROAS tuần này ${formatMultiplier(
            r1
          )} — giảm ${Math.round((1 - r1 / r0) * 100)}% so với tuần trước (${formatMultiplier(
            r0
          )}).`,
        });
      }
    }

    // (3) WARN — no conversions on real spend (skip when platform-wide zero =
    // tracking issue already alerted).
    if (!platformNoConv && spend3 >= 5000 && conv3 === 0) {
      candidates.push({
        severity: "WARN",
        type: "NO_CONV",
        platform: c.platform,
        accountId: c.accountId,
        entityName: c.name,
        message: `"${c.name}" tiêu ${formatJPY(
          spend3
        )} trong 3 ngày mà 0 chuyển đổi — xem lại target/creative hoặc tạm dừng.`,
      });
    }

    // (4) INFO — creative fatigue: CTR last7 down ≥25% vs prior7, spend held.
    const ctrWin = (from: number, to: number) => {
      let impr = 0,
        clicks = 0,
        spend = 0;
      for (let i = from; i < to; i++) {
        const d = byDay.get(isoDay(new Date(now.getTime() - i * DAY)));
        if (d) {
          impr += d.impr;
          clicks += d.clicks;
          spend += d.spend;
        }
      }
      return { ctr: impr > 0 ? clicks / impr : 0, spend };
    };
    const c1 = ctrWin(1, 8);
    const c0 = ctrWin(8, 15);
    if (
      c0.spend >= 3000 &&
      c1.spend >= 0.8 * c0.spend &&
      c0.ctr > 0 &&
      c1.ctr <= 0.75 * c0.ctr
    ) {
      candidates.push({
        severity: "INFO",
        type: "FATIGUE",
        platform: c.platform,
        accountId: c.accountId,
        entityName: c.name,
        message: `"${c.name}" CTR giảm ${Math.round(
          (1 - c1.ctr / c0.ctr) * 100
        )}% so với tuần trước với spend giữ nguyên — creative mệt mỏi, chuẩn bị mẫu mới.`,
      });
    }
  }

  // Dedupe + insert.
  let created = 0;
  const cutoff = new Date(now.getTime() - 3 * DAY);
  for (const a of candidates) {
    const dup = await prisma.adAlert.findFirst({
      where: {
        organizationId,
        type: a.type,
        accountId: a.accountId,
        entityName: a.entityName,
        createdAt: { gte: cutoff },
      },
      select: { id: true },
    });
    if (dup) continue;
    await prisma.adAlert.create({ data: { organizationId, ...a } });
    created++;
  }
  return created;
}
