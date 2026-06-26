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
    const hasClientCreds = !!(store?.shopifyClientId && store?.shopifyClientSecret);
    if (!store?.shopifyDomain || !(store?.shopifyToken || hasClientCreds)) {
      return NextResponse.json(
        { ok: false, error: "Store chưa có domain + khoá (Client ID/Secret hoặc token)." },
        { status: 400 }
      );
    }
    creds = {
      shopifyDomain: store.shopifyDomain,
      shopifyClientId: store.shopifyClientId,
      shopifyClientSecret: store.shopifyClientSecret,
      shopifyToken: store.shopifyToken,
      shopifyApiVersion: store.shopifyApiVersion,
    };
  } else if (b.shopifyDomain && (b.shopifyToken || (b.shopifyClientId && b.shopifyClientSecret))) {
    creds = {
      shopifyDomain: b.shopifyDomain,
      shopifyClientId: b.shopifyClientId,
      shopifyClientSecret: b.shopifyClientSecret,
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
