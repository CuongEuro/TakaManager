import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchProductCosts,
  fetchVariantCosts,
  firstPositiveUnitCost,
  normalizeInventoryCostWebhook,
  normalizeWebhookOrder,
  preserveUnitCostSnapshot,
} from "./shopify";

test("preserves a positive historical cost during later order syncs", () => {
  assert.equal(preserveUnitCostSnapshot(640, 725), 640);
  assert.equal(preserveUnitCostSnapshot(0, 725), 725);
});

test("order webhook keeps exact Shopify line and variant IDs", () => {
  const order = normalizeWebhookOrder({
    id: 99,
    created_at: "2026-07-21T00:00:00Z",
    line_items: [
      {
        id: 101,
        product_id: 202,
        variant_id: 303,
        title: "Shirt",
        quantity: 2,
        price: "1200",
      },
      { id: 102, title: "Tip", quantity: 1, price: "100" },
    ],
  });

  assert.equal(order.lineItems[0].externalLineItemId, "gid://shopify/LineItem/101");
  assert.equal(order.lineItems[0].externalVariantId, "gid://shopify/ProductVariant/303");
  assert.equal(order.lineItems[1].externalProductId, null);
  assert.equal(order.lineItems[1].externalVariantId, null);
});

test("normalizes an inventory cost webhook", () => {
  assert.deepEqual(normalizeInventoryCostWebhook({ id: 456, cost: "725.5" }), {
    inventoryItemId: "gid://shopify/InventoryItem/456",
    unitCost: 725.5,
  });
});

test("fetches cost for the exact variant ID", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const variantId = "gid://shopify/ProductVariant/303";
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { variables: { ids: string[] } };
    assert.deepEqual(body.variables.ids, [variantId]);
    return new Response(
      JSON.stringify({
        data: {
          nodes: [
            {
              id: variantId,
              inventoryItem: {
                id: "gid://shopify/InventoryItem/456",
                unitCost: { amount: "725.5" },
              },
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const costs = await fetchVariantCosts(
      { shopifyDomain: "example.myshopify.com", shopifyToken: "test-token" },
      [variantId]
    );
    assert.deepEqual(costs.get(variantId), {
      inventoryItemId: "gid://shopify/InventoryItem/456",
      unitCost: 725.5,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("finds product cost beyond the first ten apparel variants", () => {
  const variants = Array.from({ length: 12 }, (_, index) => ({
    inventoryItem: {
      unitCost: index === 11 ? { amount: "825.50" } : null,
    },
  }));

  assert.equal(firstPositiveUnitCost(variants), 825.5);
});

test("returns null when Shopify has no positive variant cost", () => {
  assert.equal(
    firstPositiveUnitCost([
      { inventoryItem: null },
      { inventoryItem: { unitCost: null } },
      { inventoryItem: { unitCost: { amount: "0" } } },
    ]),
    null
  );
});

test("fetches cost from a later Shopify variant page", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const productId = "gid://shopify/Product/123";
  const cursors: unknown[] = [];

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      variables: { cursor?: string };
    };
    cursors.push(body.variables.cursor ?? null);
    const firstPage = body.variables.cursor == null;
    const variants = firstPage
      ? {
          pageInfo: { hasNextPage: true, endCursor: "variant-page-1" },
          nodes: Array.from({ length: 250 }, () => ({ inventoryItem: null })),
        }
      : {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ inventoryItem: { unitCost: { amount: "640.25" } } }],
        };
    const data = firstPage
      ? { nodes: [{ id: productId, variants }] }
      : { node: { id: productId, variants } };

    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const costs = await fetchProductCosts(
      { shopifyDomain: "example.myshopify.com", shopifyToken: "test-token" },
      [productId]
    );
    assert.equal(costs.get(productId), 640.25);
    assert.deepEqual(cursors, [null, "variant-page-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
