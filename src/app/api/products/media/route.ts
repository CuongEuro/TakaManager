import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { refreshProductMediaPage } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  if (!body.storeId) {
    return NextResponse.json({ error: "storeId required" }, { status: 400 });
  }
  try {
    const result = await refreshProductMediaPage(session.oid, {
      storeId: String(body.storeId),
      cursor: body.cursor ? String(body.cursor) : null,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
