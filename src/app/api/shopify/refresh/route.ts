import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { syncStoreRefundsWindow, syncStoreCosts } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Lightweight refresh of RECENT refunds + Cost per item for every connected
// store — the Shopify sibling of /api/ads/refresh. The client calls it at most
// once per hour (localStorage throttle); operations are idempotent patches, so
// an extra run is harmless.
// - Refunds: orders UPDATED in the last `sinceDays` days (a refund bumps
//   updated_at, so refunds on old orders are caught too).
// - Costs: line-item unitCost for orders created in the window, only for
//   stores with cogsSource = COST_PER_ITEM.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  const sinceDays = b.sinceDays ? Math.min(14, Number(b.sinceDays)) : 2;

  const stores = await prisma.store.findMany({
    where: { organizationId: session.oid, active: true },
    select: {
      id: true,
      cogsSource: true,
      shopifyDomain: true,
      shopifyToken: true,
      shopifyClientId: true,
      shopifyClientSecret: true,
    },
  });
  const connected = stores.filter(
    (s) =>
      s.shopifyDomain && (s.shopifyToken || (s.shopifyClientId && s.shopifyClientSecret))
  );

  // Per-store rate limits are independent → refresh stores in parallel to fit
  // the serverless time budget.
  const results = await Promise.all(
    connected.map(async (s) => {
      const refunds = await syncStoreRefundsWindow(s.id, session.oid, { sinceDays });
      const costs =
        s.cogsSource === "COST_PER_ITEM"
          ? await syncStoreCosts(s.id, session.oid, {
              since: new Date(Date.now() - sinceDays * 86400000),
              until: new Date(),
            })
          : null;
      return { refunds, costs };
    })
  );

  let refundsUpdated = 0;
  let costsUpdated = 0;
  const errors: string[] = [];
  for (const r of results) {
    if (r.refunds.ok) refundsUpdated += r.refunds.updated;
    else errors.push(`${r.refunds.storeName}: ${r.refunds.error}`);
    if (r.costs) {
      if (r.costs.ok) costsUpdated += r.costs.updated;
      else errors.push(`${r.costs.storeName}: ${r.costs.error}`);
    }
  }

  return NextResponse.json({
    stores: connected.length,
    refundsUpdated,
    costsUpdated,
    errors,
  });
}
