import { NextRequest, NextResponse } from "next/server";
import { syncStore, syncAllStores } from "@/lib/sync";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const sinceDays = b.sinceDays ? Number(b.sinceDays) : undefined;
  const since = b.since ? new Date(String(b.since)) : undefined;

  try {
    if (b.storeId) {
      const result = await syncStore(String(b.storeId), session.oid, { sinceDays, since });
      return NextResponse.json({ results: [result] });
    }
    const results = await syncAllStores(session.oid, { sinceDays, since });
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
