import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { testConnection, ShopifyCreds } from "@/lib/shopify";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));

  let creds: ShopifyCreds | null = null;
  if (b.storeId) {
    const store = await prisma.store.findFirst({
      where: { id: b.storeId, organizationId: session.oid },
    });
    if (!store?.shopifyDomain || !store?.shopifyToken) {
      return NextResponse.json(
        { ok: false, error: "Store chưa có domain/token." },
        { status: 400 }
      );
    }
    creds = {
      shopifyDomain: store.shopifyDomain,
      shopifyToken: store.shopifyToken,
      shopifyApiVersion: store.shopifyApiVersion,
    };
  } else if (b.shopifyDomain && b.shopifyToken) {
    creds = {
      shopifyDomain: b.shopifyDomain,
      shopifyToken: b.shopifyToken,
      shopifyApiVersion: b.shopifyApiVersion,
    };
  }

  if (!creds)
    return NextResponse.json(
      { ok: false, error: "Thiếu thông tin kết nối." },
      { status: 400 }
    );

  try {
    const shop = await testConnection(creds);
    return NextResponse.json({ ok: true, shop });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
