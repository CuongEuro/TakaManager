import { NextRequest, NextResponse } from "next/server";
import { syncAdAccount, syncAllAdAccounts } from "@/lib/adsync";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  // sinceDays may be 0 ("Hôm nay") → only treat null/undefined as "not provided".
  const sinceDays =
    b.sinceDays !== undefined && b.sinceDays !== null ? Number(b.sinceDays) : undefined;
  // Explicit window (chunked / custom range). ISO date strings.
  const since = b.since ? String(b.since) : undefined;
  const until = b.until ? String(b.until) : undefined;
  const deep = b.deep === true;
  const ads = b.ads === undefined ? undefined : Boolean(b.ads);
  try {
    if (b.accountId) {
      const result = await syncAdAccount(String(b.accountId), session.oid, {
        sinceDays,
        since,
        until,
        deep,
        ads,
      });
      return NextResponse.json({ results: [result] });
    }
    const results = await syncAllAdAccounts(session.oid, { sinceDays, deep, ads });
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
