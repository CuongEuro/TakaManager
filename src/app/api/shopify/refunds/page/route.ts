import { NextRequest, NextResponse } from "next/server";
import { syncStoreRefundsPage } from "@/lib/sync";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sync ONE page of REFUNDED orders for a store (patch `refunded` on existing
// orders). The browser calls this repeatedly with the returned cursor — much
// cheaper than a full order re-sync when you only need refund data.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  if (!b.storeId)
    return NextResponse.json({ error: "storeId required" }, { status: 400 });

  const result = await syncStoreRefundsPage(String(b.storeId), session.oid, {
    sinceDays: b.sinceDays ? Number(b.sinceDays) : undefined,
    since: b.since ? new Date(String(b.since)) : undefined,
    until: b.until ? new Date(String(b.until)) : undefined,
    cursor: b.cursor ? String(b.cursor) : null,
  });

  return NextResponse.json(result);
}
