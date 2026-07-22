import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchProductCosts,
  fetchProductVariantCatalogs,
  fetchOrderLinesForCosts,
  fetchOrdersPage,
  fetchProductMedia,
  fetchVariantCosts,
  firstPositiveUnitCost,
  normalizeInventoryCostWebhook,
  normalizeOrder,
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
      {
        externalVariantId: "gid://shopify/ProductVariant/3",
        inventoryItemId: "gid://shopify/InventoryItem/3",
        title: "綿（コットン） / M / グレー",
        sku: null,
        unitCost: 462,
      },
      {
        externalVariantId: "gid://shopify/ProductVariant/4",
        inventoryItemId: "gid://shopify/InventoryItem/4",
        title: "Tシャツ / 2XL / グレー",
        sku: null,
        unitCost: 737,
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
      { sku: null, variantTitle: "  Cotton／S／White  " },
      catalog
    )?.unitCost,
    436
  );
  assert.equal(
    resolveCatalogVariantCost(
      { sku: null, variantTitle: "コットン（綿） / M / グレー" },
      catalog
    )?.externalVariantId,
    "gid://shopify/ProductVariant/3"
  );
  assert.equal(
    resolveCatalogVariantCost(
      { sku: null, variantTitle: "2XL / グレー / Tシャツ" },
      catalog
    )?.externalVariantId,
    "gid://shopify/ProductVariant/4"
  );
});

test("loads variants beyond Shopify's first catalog page for legacy orders", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const productId = "gid://shopify/Product/202";
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
          nodes: [
            {
              id: "gid://shopify/ProductVariant/1",
              title: "Cotton / S / White",
              sku: null,
              inventoryItem: { id: "gid://shopify/InventoryItem/1", unitCost: { amount: "436" } },
            },
          ],
        }
      : {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/ProductVariant/251",
              title: "コットン（綿） / 2XL / ホワイト",
              sku: null,
              inventoryItem: { id: "gid://shopify/InventoryItem/251", unitCost: { amount: "545" } },
            },
          ],
        };
    const data = firstPage
      ? { nodes: [{ id: productId, title: "Cat shirt", variants }] }
      : { node: { id: productId, title: "Cat shirt", variants } };

    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const catalogs = await fetchProductVariantCatalogs(
      { shopifyDomain: "example.myshopify.com", shopifyToken: "test-token" },
      [{ externalProductId: productId, title: "Cat shirt" }]
    );
    const catalog = catalogs.get(`id:${productId}`);
    assert.equal(catalog?.variants.length, 2);
    assert.equal(
      resolveCatalogVariantCost(
        { sku: null, variantTitle: "コットン(綿)／2XL／ホワイト" },
        catalog
      )?.unitCost,
      545
    );
    assert.deepEqual(cursors, [null, "variant-page-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("does not guess when reordered option values match multiple variants", () => {
  assert.equal(
    resolveCatalogVariantCost(
      { sku: null, variantTitle: "2XL / グレー / Tシャツ" },
      {
        externalProductId: "gid://shopify/Product/202",
        title: "Cat shirt",
        variants: [
          {
            externalVariantId: "gid://shopify/ProductVariant/1",
            inventoryItemId: "gid://shopify/InventoryItem/1",
            title: "Tシャツ / 2XL / グレー",
            sku: null,
            unitCost: 737,
          },
          {
            externalVariantId: "gid://shopify/ProductVariant/2",
            inventoryItemId: "gid://shopify/InventoryItem/2",
            title: "グレー / Tシャツ / 2XL",
            sku: null,
            unitCost: 737,
          },
        ],
      }
    ),
    null
  );
});

test("resolves one renamed option only when size and color identify one variant", () => {
  const catalog = {
    externalProductId: "gid://shopify/Product/7124876886068",
    title: "好きな文字入り 猫Tシャツ｜カスタム対応",
    variants: [
      {
        externalVariantId: "gid://shopify/ProductVariant/1",
        inventoryItemId: "gid://shopify/InventoryItem/1",
        title: "綿（コットン） / 2XL / グレー",
        sku: null,
        unitCost: 644,
      },
      {
        externalVariantId: "gid://shopify/ProductVariant/48037471027252",
        inventoryItemId: "gid://shopify/InventoryItem/2",
        title: "長袖Tシャツ / 2XL / グレー",
        sku: null,
        unitCost: 737,
      },
      {
        externalVariantId: "gid://shopify/ProductVariant/3",
        inventoryItemId: "gid://shopify/InventoryItem/3",
        title: "トレーナ / 2XL / グレー",
        sku: null,
        unitCost: 980,
      },
      {
        externalVariantId: "gid://shopify/ProductVariant/4",
        inventoryItemId: "gid://shopify/InventoryItem/4",
        title: "パーカー / 2XL / グレー",
        sku: null,
        unitCost: 1200,
      },
    ],
  };

  assert.equal(
    resolveCatalogVariantCost(
      { sku: null, variantTitle: "2XL / グレー / Tシャツ" },
      catalog
    )?.externalVariantId,
    "gid://shopify/ProductVariant/48037471027252"
  );
});

test("does not guess when an old option name matches multiple renamed styles", () => {
  assert.equal(
    resolveCatalogVariantCost(
      { sku: null, variantTitle: "2XL / グレー / Tシャツ" },
      {
        externalProductId: "gid://shopify/Product/202",
        title: "Cat shirt",
        variants: [
          {
            externalVariantId: "gid://shopify/ProductVariant/1",
            inventoryItemId: "gid://shopify/InventoryItem/1",
            title: "長袖Tシャツ / 2XL / グレー",
            sku: null,
            unitCost: 737,
          },
          {
            externalVariantId: "gid://shopify/ProductVariant/2",
            inventoryItemId: "gid://shopify/InventoryItem/2",
            title: "半袖Tシャツ / 2XL / グレー",
            sku: null,
            unitCost: 0,
          },
        ],
      }
    ),
    null
  );
});

test("cost recovery prefers current variant metadata but preserves deleted snapshots", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const orderId = "gid://shopify/Order/99";
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    assert.match(body.query, /variantTitle/);
    assert.match(body.query, /\bsku\b/);
    assert.match(body.query, /variant\s*\{\s*id\s+title\s+sku/);
    return new Response(
      JSON.stringify({
        data: {
          nodes: [
            {
              id: orderId,
              lineItems: {
                nodes: [
                  {
                    id: "gid://shopify/LineItem/100",
                    title: "Cat shirt",
                    variantTitle: "2XL / グレー / Tシャツ",
                    sku: null,
                    quantity: 1,
                    originalUnitPriceSet: { shopMoney: { amount: "4180" } },
                    product: { id: "gid://shopify/Product/7124876886068" },
                    variant: {
                      id: "gid://shopify/ProductVariant/48037471027252",
                      title: "長袖Tシャツ / 2XL / グレー",
                      sku: "LONG-2XL-GRAY",
                      inventoryItem: {
                        id: "gid://shopify/InventoryItem/200",
                        unitCost: { amount: "737" },
                      },
                    },
                  },
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
    assert.equal(orders.get(orderId)?.[0].sku, "LONG-2XL-GRAY");
    assert.equal(
      orders.get(orderId)?.[0].variantTitle,
      "長袖Tシャツ / 2XL / グレー"
    );
    assert.equal(orders.get(orderId)?.[0].unitCost, 737);
    assert.equal(orders.get(orderId)?.[1].sku, "CAT-S-W");
    assert.equal(orders.get(orderId)?.[1].variantTitle, "Cotton / S / White");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("order sync stores the current variant title when Shopify renamed it", () => {
  const order = normalizeOrder(
    {
      id: "gid://shopify/Order/99",
      createdAt: "2026-07-21T00:00:00Z",
      sourceName: "web",
      totalDiscountsSet: null,
      totalTaxSet: null,
      currentTotalTaxSet: null,
      totalShippingPriceSet: null,
      totalRefundedSet: null,
      customerJourneySummary: null,
      lineItems: {
        nodes: [
          {
            id: "gid://shopify/LineItem/100",
            title: "Cat shirt",
            variantTitle: "2XL / グレー / Tシャツ",
            sku: null,
            quantity: 1,
            originalUnitPriceSet: { shopMoney: { amount: "4180" } },
            product: null,
            variant: {
              id: "gid://shopify/ProductVariant/48037471027252",
              title: "長袖Tシャツ / 2XL / グレー",
              sku: "LONG-2XL-GRAY",
              inventoryItem: {
                id: "gid://shopify/InventoryItem/200",
                unitCost: { amount: "737" },
              },
            },
          },
        ],
      },
    },
    false
  );

  assert.equal(order.lineItems[0].externalVariantId, "gid://shopify/ProductVariant/48037471027252");
  assert.equal(order.lineItems[0].variantTitle, "長袖Tシャツ / 2XL / グレー");
  assert.equal(order.lineItems[0].sku, "LONG-2XL-GRAY");
  assert.equal(order.lineItems[0].unitCost, 737);
});

test("manual order sync uses a bounded page without inventory cost", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    assert.match(body.query, /orders\(first: 10/);
    assert.doesNotMatch(body.query, /unitCost/);
    assert.match(body.query, /\bhandle\b/);
    assert.match(body.query, /variantTitle/);
    assert.match(body.query, /\bsku\b/);
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
        variant_title: "Cotton / S / White",
        sku: "CAT-S-W",
        title: "Shirt",
        quantity: 2,
        price: "1200",
      },
      { id: 102, title: "Tip", quantity: 1, price: "100" },
    ],
  });

  assert.equal(order.lineItems[0].externalLineItemId, "gid://shopify/LineItem/101");
  assert.equal(order.lineItems[0].externalVariantId, "gid://shopify/ProductVariant/303");
  assert.equal(order.lineItems[0].variantTitle, "Cotton / S / White");
  assert.equal(order.lineItems[0].sku, "CAT-S-W");
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
              title: "Cotton / S / White",
              sku: "CAT-S-W",
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
      variantTitle: "Cotton / S / White",
      sku: "CAT-S-W",
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
