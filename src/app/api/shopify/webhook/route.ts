import { after, NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  verifyWebhookHmac,
  normalizeInventoryCostWebhook,
  normalizeWebhookOrder,
} from "@/lib/shopify";
import {
  backfillMissingInventoryCost,
  ingestWebhookOrder,
} from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  // Acknowledge quickly; Shopify expects a response within five seconds. Next's
  // after() keeps the bounded database/API work alive after the response.
  after(async () => {
    try {
      const payload = JSON.parse(raw);
      if (topic.startsWith("orders/")) {
        await ingestWebhookOrder(
          store.id,
          store.organizationId,
          normalizeWebhookOrder(payload)
        );
      } else if (topic === "inventory_items/update") {
        const inventory = normalizeInventoryCostWebhook(payload);
        if (inventory) {
          await backfillMissingInventoryCost(
            store.id,
            store.organizationId,
            inventory.inventoryItemId,
            inventory.unitCost
          );
        }
      }
    } catch (e) {
      console.error("Shopify webhook processing error:", e);
    }
  });

  // Always 200 once HMAC is valid; processing continues in after().
  return NextResponse.json({ ok: true });
}
