import test from "node:test";
import assert from "node:assert/strict";
import { fetchProductCosts, firstPositiveUnitCost } from "./shopify";

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
