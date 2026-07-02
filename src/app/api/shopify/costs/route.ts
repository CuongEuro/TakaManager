import { NextRequest, NextResponse } from "next/server";
import { syncStoreCosts } from "@/lib/sync";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Refresh "Cost per item" for a store's orders in a window (patch line-item
// unitCost). Cheaper than a full order re-sync — only fetches product costs.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  if (!b.storeId)
    return NextResponse.json({ error: "storeId required" }, { status: 400 });

  // Prefer calendar days (from/to YYYY-MM-DD) — resolved in the STORE's
  // timezone server-side, so the patched window matches the dashboard's days.
  const isYMD = (v: unknown): v is string =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

  const result = await syncStoreCosts(String(b.storeId), session.oid, {
    fromYMD: isYMD(b.from) ? b.from : undefined,
    toYMD: isYMD(b.to) ? b.to : undefined,
    sinceDays: b.sinceDays ? Number(b.sinceDays) : undefined,
    since: b.since ? new Date(String(b.since)) : undefined,
    until: b.until ? new Date(String(b.until)) : undefined,
  });

  return NextResponse.json(result);
}
