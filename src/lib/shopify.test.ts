import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchProductCosts,
  fetchOrderLinesForCosts,
  fetchOrdersPage,
  fetchProductMedia,
  fetchVariantCosts,
  firstPositiveUnitCost,
  normalizeInventoryCostWebhook,
  normalizeWebhookOrder,
  preserveUnitCostSnapshot,
  resolveCatalogVariantCost,
  shopifyProductUrl,
} from "./shopify";

test("preserves a positive historical cost during later order syncs", () => {
  assert.equal(preserveUnitCostSnapshot(640, 725), 640);
  assert.equal(preserveUnitCostSnapshot(0, 725), 725);
});

test("resolves a recreated variant by SKU or exact historical title", () => {
  const catalog = {
    externalProductId: "gid://shopify/Product/202",
    title: "Cat shirt",
    variants: [
      {
        externalVariantId: "gid://shopify/ProductVariant/1",
        inventoryItemId: "gid://shopify/InventoryItem/1",
        title: "Cotton / S / White",
        sku: "CAT-S-W",
        unitCost: 436,
      },
      {
        externalVariantId: "gid://shopify/ProductVariant/2",
        inventoryItemId: "gid://shopify/InventoryItem/2",
        title: "Cotton / S / Gray",
        sku: "CAT-S-G",
        unitCost: 462,
      },
    ],
  };

  assert.equal(
    resolveCatalogVariantCost(
      { sku: "CAT-S-G", variantTitle: "old title" },
      catalog
    )?.unitCost,
    462
  );
  assert.equal(
    resolveCatalogVariantCost(
      { sku: null, variantTitle: "  Cotton / S / White  " },
      catalog
    )?.unitCost,
    436
  );
});

test("does not guess a cost when historical variant cannot be identified", () => {
  assert.equal(
    resolveCatalogVariantCost(
      { sku: null, variantTitle: "Cotton / XL / Pink" },
      {
        externalProductId: "gid://shopify/Product/202",
        title: "Cat shirt",
        variants: [
          {
            externalVariantId: "gid://shopify/ProductVariant/1",
            inventoryItemId: "gid://shopify/InventoryItem/1",
            title: "Cotton / S / White",
            sku: null,
            unitCost: 436,
          },
        ],
      }
    ),
    null
  );
});

test("reads historical SKU and variant title for cost recovery", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const orderId = "gid://shopify/Order/99";
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    assert.match(body.query, /variantTitle/);
    assert.match(body.query, /\bsku\b/);
    return new Response(
      JSON.stringify({
        data: {
          nodes: [
            {
              id: orderId,
              lineItems: {
                nodes: [
                  {
                    id: "gid://shopify/LineItem/101",
                    title: "Cat shirt",
                    variantTitle: "Cotton / S / White",
                    sku: "CAT-S-W",
                    quantity: 1,
                    originalUnitPriceSet: { shopMoney: { amount: "4180" } },
                    product: { id: "gid://shopify/Product/202" },
                    variant: null,
                  },
                ],
              },
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const orders = await fetchOrderLinesForCosts(
      { shopifyDomain: "example.myshopify.com", shopifyToken: "test-token" },
      [orderId]
    );
    assert.equal(orders.get(orderId)?.[0].sku, "CAT-S-W");
    assert.equal(orders.get(orderId)?.[0].variantTitle, "Cotton / S / White");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual order sync uses a bounded page without inventory cost", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    assert.match(body.query, /orders\(first: 10/);
    assert.doesNotMatch(body.query, /unitCost/);
    assert.match(body.query, /\bhandle\b/);
    return new Response(
      JSON.stringify({
        data: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const page = await fetchOrdersPage(
      { shopifyDomain: "example.myshopify.com", shopifyToken: "test-token" },
      new Date("2026-07-01T00:00:00Z"),
      null,
      false,
      new Date("2026-08-01T00:00:00Z"),
      false
    );
    assert.equal(page.orders.length, 0);
    assert.equal(page.hasNext, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  assert.equal(order.lineItems[0].handle, null);
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
              product: {
                id: "gid://shopify/Product/202",
                handle: "cat-shirt",
                featuredImage: { url: "https://cdn.shopify.com/cat.jpg" },
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
      productId: "gid://shopify/Product/202",
      productImage: "https://cdn.shopify.com/cat.jpg",
      productHandle: "cat-shirt",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetches product image and storefront handle together", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const productId = "gid://shopify/Product/202";
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { ids: string[] };
    };
    assert.match(body.query, /featuredImage/);
    assert.match(body.query, /\bhandle\b/);
    assert.deepEqual(body.variables.ids, [productId]);
    return new Response(
      JSON.stringify({
        data: {
          nodes: [
            {
              id: productId,
              handle: "cat-shirt",
              featuredImage: { url: "https://cdn.shopify.com/cat.jpg" },
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const media = await fetchProductMedia(
      { shopifyDomain: "example.myshopify.com", shopifyToken: "test-token" },
      [productId]
    );
    assert.deepEqual(media.get(productId), {
      image: "https://cdn.shopify.com/cat.jpg",
      handle: "cat-shirt",
    });
    assert.equal(
      shopifyProductUrl("https://example.myshopify.com/", "cat-shirt"),
      "https://example.myshopify.com/products/cat-shirt"
    );
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
