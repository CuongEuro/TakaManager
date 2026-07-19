import assert from "node:assert/strict";
import test from "node:test";
import { buildChannelTrends } from "@/lib/pnl";

test("builds daily ROAS and CPA per store from Ads spend and Shopify orders", () => {
  const rows = buildChannelTrends(
    [
      { id: "store-a", name: "Tokyo Store" },
      { id: "store-b", name: "Osaka Store" },
    ],
    [
      {
        storeId: "store-a",
        date: new Date("2026-07-19T16:00:00.000Z"),
        channel: "FACEBOOK",
        revenue: 180,
      },
      {
        storeId: "store-a",
        date: new Date("2026-07-20T02:00:00.000Z"),
        channel: "FACEBOOK",
        revenue: 120,
      },
      {
        storeId: "store-a",
        date: new Date("2026-07-20T02:00:00.000Z"),
        channel: "DIRECT",
        revenue: 999,
      },
    ],
    [
      {
        storeId: "store-a",
        date: new Date("2026-07-20T00:00:00.000Z"),
        platform: "FACEBOOK",
        spend: 100,
      },
      {
        storeId: "store-b",
        date: new Date("2026-07-20T00:00:00.000Z"),
        platform: "GOOGLE",
        spend: 200,
      },
    ]
  );

  const facebook = rows.find(
    (row) => row.storeId === "store-a" && row.channel === "FACEBOOK"
  );
  assert.deepEqual(facebook, {
    date: "2026-07-20",
    storeId: "store-a",
    channel: "FACEBOOK",
    spend: 100,
    revenue: 300,
    orders: 2,
    storeName: "Tokyo Store",
    roas: 3,
    cpa: 50,
  });

  const google = rows.find(
    (row) => row.storeId === "store-b" && row.channel === "GOOGLE"
  );
  assert.equal(google?.storeName, "Osaka Store");
  assert.equal(google?.roas, 0);
  assert.equal(google?.cpa, null);
  assert.equal(rows.some((row) => row.channel === "DIRECT"), false);
});
