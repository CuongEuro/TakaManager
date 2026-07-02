import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncAllAdAccounts } from "@/lib/adsync";
import { syncAllStores, syncStoreRefundsWindow } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Hobby caps at 60s; light 7-day window keeps it short

// Daily Vercel Cron entry point. Pulls a LIGHT recent window (7 days) for every
// organization: ad spend (Meta/Google/X) AND Shopify orders. The Shopify pass is
// a safety net — it catches anything a missed webhook or a failed manual sync
// left behind (idempotent upserts → no duplicates). Secured by CRON_SECRET:
// Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` when set.
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret)
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET chưa được cấu hình." },
      { status: 503 }
    );
  if (req.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const orgs = await prisma.organization.findMany({ select: { id: true } });
  let accounts = 0;
  let adOk = 0;
  let stores = 0;
  let storeOk = 0;
  for (const org of orgs) {
    const adResults = await syncAllAdAccounts(org.id, { sinceDays: 7 });
    accounts += adResults.length;
    adOk += adResults.filter((r) => r.ok).length;

    const storeResults = await syncAllStores(org.id, { sinceDays: 7 });
    stores += storeResults.length;
    storeOk += storeResults.filter((r) => r.ok).length;

    // Refunds by updated_at: the order re-sync above only covers orders
    // CREATED in the window — this also catches refunds issued recently on
    // OLD orders (a refund bumps updated_at).
    for (const r of storeResults) {
      if (r.ok) await syncStoreRefundsWindow(r.storeId, org.id, { sinceDays: 7 });
    }
  }
  return NextResponse.json({
    ok: true,
    orgs: orgs.length,
    accounts,
    adSynced: adOk,
    stores,
    storesSynced: storeOk,
  });
}

// Vercel Cron uses GET; allow POST too for manual triggering with the secret.
export const GET = handle;
export const POST = handle;
