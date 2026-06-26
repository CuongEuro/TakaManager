import { NextRequest, NextResponse } from "next/server";
import { syncAdAccount, syncAllAdAccounts } from "@/lib/adsync";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const sinceDays = b.sinceDays ? Number(b.sinceDays) : undefined;
  try {
    if (b.accountId) {
      const result = await syncAdAccount(String(b.accountId), session.oid, {
        sinceDays,
      });
      return NextResponse.json({ results: [result] });
    }
    const results = await syncAllAdAccounts(session.oid, { sinceDays });
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
