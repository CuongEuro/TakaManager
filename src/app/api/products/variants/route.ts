import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { refreshProductVariantsPage } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const productIds = Array.isArray(body.productIds)
    ? body.productIds.filter(
        (id: unknown): id is string => typeof id === "string" && !!id
      )
    : [];
  const isYMD = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (
    !body.storeId ||
    productIds.length === 0 ||
    !isYMD(body.from) ||
    !isYMD(body.to)
  ) {
    return NextResponse.json(
      { error: "storeId, productIds, from và to là bắt buộc" },
      { status: 400 }
    );
  }
  if (productIds.length > 100) {
    return NextResponse.json(
      { error: "Tối đa 100 sản phẩm mỗi lượt" },
      { status: 400 }
    );
  }

  try {
    const result = await refreshProductVariantsPage(session.oid, {
      storeId: String(body.storeId),
      productIds,
      fromYMD: body.from,
      toYMD: body.to,
      cursor: typeof body.cursor === "string" ? body.cursor : null,
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
