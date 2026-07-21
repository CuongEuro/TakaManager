import test from "node:test";
import assert from "node:assert/strict";
import { firstPositiveUnitCost } from "./shopify";

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
