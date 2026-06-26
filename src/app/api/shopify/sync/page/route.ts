import { NextRequest, NextResponse } from "next/server";
import { syncStorePage } from "@/lib/sync";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sync ONE page of orders for a store. The browser calls this repeatedly with
// the returned `cursor` until `hasNext` is false — each request is small and
// finishes well within the serverless time limit.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  if (!b.storeId)
    return NextResponse.json({ error: "storeId required" }, { status: 400 });

  const result = await syncStorePage(String(b.storeId), session.oid, {
    sinceDays: b.sinceDays ? Number(b.sinceDays) : undefined,
    since: b.since ? new Date(String(b.since)) : undefined,
    cursor: b.cursor ? String(b.cursor) : null,
    useJourney: b.useJourney === undefined ? true : Boolean(b.useJourney),
  });

  return NextResponse.json(result);
}
