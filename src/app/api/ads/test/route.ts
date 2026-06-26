import { NextRequest, NextResponse } from "next/server";
import { testAdAccount } from "@/lib/adsync";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  if (!b.accountId)
    return NextResponse.json({ ok: false, error: "accountId required" }, { status: 400 });
  const result = await testAdAccount(String(b.accountId), session.oid);
  return NextResponse.json(result);
}
