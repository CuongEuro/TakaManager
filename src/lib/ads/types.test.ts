import test from "node:test";
import assert from "node:assert/strict";
import { adSpendDedupeKey } from "./types";

test("ad spend identity is stable across store mapping and campaign rename", () => {
  const original = adSpendDedupeKey({
    source: "API",
    accountId: "account-1",
    platform: "FACEBOOK",
    date: "2026-07-21",
    campaignExternalId: "campaign-42",
    campaignName: "Old name",
  });
  const renamed = adSpendDedupeKey({
    source: "API",
    accountId: "account-1",
    platform: "FACEBOOK",
    date: "2026-07-21",
    campaignExternalId: "campaign-42",
    campaignName: "New name",
  });

  assert.equal(original, renamed);
});

test("same-name campaigns keep separate provider identities", () => {
  const first = adSpendDedupeKey({
    source: "API",
    accountId: "account-1",
    platform: "FACEBOOK",
    date: "2026-07-21",
    campaignExternalId: "campaign-1",
    campaignName: "Sale",
  });
  const second = adSpendDedupeKey({
    source: "API",
    accountId: "account-1",
    platform: "FACEBOOK",
    date: "2026-07-21",
    campaignExternalId: "campaign-2",
    campaignName: "Sale",
  });

  assert.notEqual(first, second);
});
