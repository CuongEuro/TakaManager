import test from "node:test";
import assert from "node:assert/strict";
import {
  X_ADS_API_BASE,
  buildBaseString,
  oauthHeader,
  percentEncode,
  twitterDayWindow,
} from "./twitter";

test("uses the current X Ads API v12 host", () => {
  assert.equal(X_ADS_API_BASE, "https://ads-api.x.com/12");
});

test("percent-encodes OAuth values using RFC 3986", () => {
  assert.equal(
    percentEncode("Ladies + Gentlemen!"),
    "Ladies%20%2B%20Gentlemen%21"
  );
});

test("builds the signature base string from X's official OAuth example", () => {
  const baseString = buildBaseString(
    "POST",
    "https://api.x.com/1.1/statuses/update.json",
    {
      include_entities: "true",
      oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
      oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: "1318622958",
      oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      oauth_version: "1.0",
      status: "Hello Ladies + Gentlemen, a signed OAuth request!",
    }
  );

  assert.equal(
    baseString,
    "POST&https%3A%2F%2Fapi.x.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521"
  );
});

test("generates X's documented HMAC-SHA1 OAuth signature", () => {
  const header = oauthHeader(
    {
      platform: "TWITTER",
      externalId: "18ce54d4x5t",
      apiKey: "xvz1evFS4wEEPTGEFPHBog",
      apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
      accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    },
    "POST",
    "https://api.x.com/1.1/statuses/update.json",
    {
      include_entities: "true",
      status: "Hello Ladies + Gentlemen, a signed OAuth request!",
    },
    "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    "1318622958"
  );

  assert.match(header, /oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D"/);
});

test("builds an inclusive one-day X window at Tokyo midnight", () => {
  const window = twitterDayWindow(
    new Date("2026-07-24T00:00:00Z"),
    new Date("2026-07-24T00:00:00Z"),
    "Asia/Tokyo"
  );

  assert.deepEqual(window, {
    startTime: "2026-07-23T15:00:00Z",
    endTime: "2026-07-24T15:00:00Z",
    dates: ["2026-07-24"],
  });
});

test("keeps X day boundaries aligned across daylight-saving changes", () => {
  const window = twitterDayWindow(
    new Date("2026-03-08T00:00:00Z"),
    new Date("2026-03-08T00:00:00Z"),
    "America/Los_Angeles"
  );

  assert.deepEqual(window, {
    startTime: "2026-03-08T08:00:00Z",
    endTime: "2026-03-09T07:00:00Z",
    dates: ["2026-03-08"],
  });
});
