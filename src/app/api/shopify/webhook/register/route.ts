import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { registerOrderWebhooks, ShopifyCreds } from "@/lib/shopify";

export const dynamic = "force-dynamic";

// Turn on real-time sync for a store: subscribe its Shopify app to
// orders/create + orders/updated webhooks pointing at /api/shopify/webhook.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  if (!b.storeId)
    return NextResponse.json({ error: "storeId required" }, { status: 400 });

  const store = await prisma.store.findFirst({
    where: { id: String(b.storeId), organizationId: session.oid },
  });
  if (!store?.shopifyDomain || !(store.shopifyClientId && store.shopifyClientSecret)) {
    return NextResponse.json(
      { ok: false, error: "Cần domain + Client ID/Secret để bật webhook." },
      { status: 400 }
    );
  }

  // Build the public callback URL from the current deployment host.
  const host = req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  if (!host)
    return NextResponse.json(
      { ok: false, error: "Không xác định được địa chỉ app." },
      { status: 400 }
    );
  const callbackUrl = `${proto}://${host}/api/shopify/webhook`;

  const creds: ShopifyCreds = {
    shopifyDomain: store.shopifyDomain,
    shopifyClientId: store.shopifyClientId,
    shopifyClientSecret: store.shopifyClientSecret,
    shopifyToken: store.shopifyToken,
    shopifyApiVersion: store.shopifyApiVersion,
  };

  try {
    const r = await registerOrderWebhooks(creds, callbackUrl);
    if (r.created === 0 && r.errors.length) {
      return NextResponse.json({ ok: false, error: r.errors.join("; ") });
    }
    await prisma.store.update({
      where: { id: store.id },
      data: { webhooksEnabled: true },
    });
    return NextResponse.json({ ok: true, created: r.created, errors: r.errors, callbackUrl });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
