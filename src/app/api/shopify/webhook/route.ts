import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyWebhookHmac, normalizeWebhookOrder } from "@/lib/shopify";
import { ingestOrders } from "@/lib/sync";

export const dynamic = "force-dynamic";

// Public endpoint — authenticated by Shopify's HMAC signature, NOT a session.
// (Allow-listed in src/middleware.ts.) Registered for orders/create + updated.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256") ?? "";
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const domain = (req.headers.get("x-shopify-shop-domain") ?? "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!domain) return NextResponse.json({ ok: false }, { status: 400 });

  // Find the store this shop maps to (domain may be stored with/without protocol).
  const store = await prisma.store.findFirst({
    where: { shopifyDomain: { contains: domain } },
  });
  if (!store?.shopifyClientSecret) {
    // Unknown shop or no secret to verify against.
    return NextResponse.json({ ok: false, error: "unknown shop" }, { status: 401 });
  }

  if (!verifyWebhookHmac(raw, hmac, store.shopifyClientSecret)) {
    return NextResponse.json({ ok: false, error: "bad hmac" }, { status: 401 });
  }

  // Only order topics carry an order payload we ingest.
  if (topic.startsWith("orders/")) {
    try {
      const payload = JSON.parse(raw);
      const norm = normalizeWebhookOrder(payload);
      await ingestOrders(store.id, store.organizationId, [norm]);
    } catch (e) {
      // Return 200 anyway so Shopify doesn't enter an aggressive retry loop;
      // the error is logged for inspection.
      console.error("Shopify webhook ingest error:", e);
    }
  }

  // Always 200 once HMAC is valid so Shopify marks delivery successful.
  return NextResponse.json({ ok: true });
}
