// Seed sample data for the demo workspace. Run: node --env-file=.env prisma/seed.ts
// Login after seeding:  demo@takamanager.com / demo1234
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "crypto";

const prisma = new PrismaClient();

// Must match verifyPassword() in src/lib/auth.ts (scrypt, "salt:hash" hex).
function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 64).toString("hex")}`;
}

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Map a product title to a catalog/collection (for "đến từ catalog nào").
function catalogOf(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("hoodie")) return "Apparel - Hoodies";
  if (t.includes("t-shirt") || t.includes("tee")) return "Apparel - Tops";
  if (t.includes("mug")) return "Drinkware";
  if (t.includes("tote") || t.includes("bag")) return "Bags";
  if (t.includes("phone case")) return "Tech Accessories";
  if (t.includes("poster")) return "Wall Art";
  if (t.includes("sticker")) return "Stickers";
  return "Other";
}

// Weighted traffic-source channel for demo orders.
function pickChannel(): string {
  const r = Math.random();
  if (r < 0.4) return "FACEBOOK";
  if (r < 0.62) return "GOOGLE";
  if (r < 0.75) return "KLAVIYO";
  if (r < 0.85) return "TWITTER";
  if (r < 0.93) return "DIRECT";
  return "ORGANIC";
}

const CHANNEL_UTM: Record<string, { source: string; medium: string }> = {
  FACEBOOK: { source: "facebook", medium: "paid_social" },
  GOOGLE: { source: "google", medium: "cpc" },
  KLAVIYO: { source: "klaviyo", medium: "email" },
  TWITTER: { source: "twitter", medium: "paid_social" },
  DIRECT: { source: "direct", medium: "none" },
  ORGANIC: { source: "google", medium: "organic" },
};

async function main() {
  console.log("Clearing existing data...");
  await prisma.adMetric.deleteMany();
  await prisma.adEntity.deleteMany();
  await prisma.adAccount.deleteMany();
  await prisma.orderLineItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.adSpend.deleteMany();
  await prisma.costRule.deleteMany();
  await prisma.fixedCost.deleteMany();
  await prisma.product.deleteMany();
  await prisma.store.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();

  console.log("Creating demo workspace + user (demo@takamanager.com / demo1234)...");
  const organization = await prisma.organization.create({
    data: { name: "Taka POD Demo", inviteCode: "demo-invite-001" },
  });
  const organizationId = organization.id;
  await prisma.user.create({
    data: {
      email: "demo@takamanager.com",
      name: "Demo Owner",
      passwordHash: hashPassword("demo1234"),
      memberships: { create: { organizationId, role: "OWNER" } },
    },
  });

  console.log("Creating stores...");
  const storeDefs = [
    { name: "Taka JP — Anime", domain: "taka-anime.myshopify.com" },
    { name: "Taka JP — Pets", domain: "taka-pets.myshopify.com" },
    { name: "Taka JP — Family", domain: "taka-family.myshopify.com" },
  ];
  const stores = [];
  for (const s of storeDefs) {
    stores.push(
      await prisma.store.create({
        data: {
          organizationId,
          name: s.name,
          shopifyDomain: s.domain,
          currency: "JPY",
          taxRate: 0.1,
        },
      })
    );
  }

  console.log("Creating products...");
  const productTitles = [
    "Custom Anime T-Shirt",
    "Personalized Pet Hoodie",
    "Family Name Mug",
    "Cat Lover Tote Bag",
    "Custom Photo Phone Case",
    "Japanese Kanji Poster",
    "Couple Matching Tee",
    "Kawaii Sticker Pack",
  ];
  const products = [];
  for (const store of stores) {
    const n = rand(3, 4);
    for (let i = 0; i < n; i++) {
      const title = pick(productTitles);
      products.push(
        await prisma.product.create({
          data: {
            organizationId,
            storeId: store.id,
            title,
            image: `https://picsum.photos/seed/${encodeURIComponent(
              store.id + title + i
            )}/200`,
            catalog: catalogOf(title),
            baseCost: rand(700, 1500), // basecost ¥
          },
        })
      );
    }
  }

  console.log("Creating fixed costs...");
  // backdate so fixed costs fully cover any dashboard range
  const fixedStart = new Date();
  fixedStart.setDate(fixedStart.getDate() - 120);
  // company-wide
  await prisma.fixedCost.createMany({
    data: [
      { category: "KLAVIYO", name: "Klaviyo Email", amount: 9000, billingCycle: "MONTHLY", startDate: fixedStart },
      { category: "LINE", name: "Line Official + Tools", amount: 7000, billingCycle: "MONTHLY", startDate: fixedStart },
      { category: "FACILITY", name: "Xưởng in + kho (thuê)", amount: 180000, billingCycle: "MONTHLY", startDate: fixedStart },
    ].map((d) => ({ ...d, organizationId })),
  });
  // per-store Shopify
  for (const store of stores) {
    await prisma.fixedCost.create({
      data: {
        organizationId,
        storeId: store.id,
        category: "SHOPIFY",
        name: "Shopify Basic",
        amount: 4850,
        billingCycle: "MONTHLY",
        startDate: fixedStart,
      },
    });
  }

  console.log("Creating cost rules (Variable A)...");
  await prisma.costRule.createMany({
    data: [
      { type: "SELLING_FEE", calcMethod: "PERCENT_OF_REVENUE", amount: 0.036, note: "Shopify Payments JP 3.6%" },
      { type: "SHIPPING", calcMethod: "PER_ORDER", amount: 600, note: "Yamato/Japan Post avg" },
      { type: "INK", calcMethod: "PER_UNIT", amount: 150 },
      { type: "PERSONNEL", calcMethod: "PER_ORDER", amount: 300, note: "in + đóng gói" },
      { type: "PACKAGING", calcMethod: "PER_ORDER", amount: 120 },
    ].map((d) => ({ ...d, organizationId })),
  });

  console.log("Creating orders + line items (last 35 days)...");
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let d = 34; d >= 0; d--) {
    const day = new Date(today);
    day.setDate(today.getDate() - d);
    for (const store of stores) {
      const storeProducts = products.filter((p) => p.storeId === store.id);
      const numOrders = rand(2, 7);
      for (let o = 0; o < numOrders; o++) {
        const numItems = rand(1, 3);
        let gross = 0;
        let units = 0;
        const lineItems = [];
        for (let li = 0; li < numItems; li++) {
          const prod = pick(storeProducts);
          const qty = rand(1, 2);
          const price = rand(2500, 4500);
          gross += price * qty;
          units += qty;
          lineItems.push({
            productId: prod.id,
            title: prod.title,
            image: prod.image,
            quantity: qty,
            price,
          });
        }
        const discounts = Math.random() < 0.3 ? rand(200, 800) : 0;
        const tax = Math.round((gross - discounts) * 0.1);
        const channel = pickChannel();
        const utm = CHANNEL_UTM[channel];
        await prisma.order.create({
          data: {
            organizationId,
            storeId: store.id,
            date: day,
            grossRevenue: gross,
            discounts,
            tax,
            shippingCharged: Math.random() < 0.4 ? 0 : 500,
            itemsCount: units,
            channel,
            utmSource: utm.source,
            utmMedium: utm.medium,
            sourceName: "web",
            source: "MANUAL",
            lineItems: { create: lineItems },
          },
        });
      }
    }
  }

  console.log("Creating ad spend (last 35 days)...");
  const platforms = ["FACEBOOK", "GOOGLE", "TWITTER"];
  for (let d = 34; d >= 0; d--) {
    const day = new Date(today);
    day.setDate(today.getDate() - d);
    for (const store of stores) {
      for (const platform of platforms) {
        if (platform === "TWITTER" && Math.random() < 0.5) continue;
        const spend = platform === "FACEBOOK" ? rand(8000, 20000) : rand(3000, 9000);
        const roas = 1.8 + Math.random() * 2.2; // 1.8x – 4x
        await prisma.adSpend.create({
          data: {
            organizationId,
            storeId: store.id,
            platform,
            date: day,
            campaignName: `${platform} - ${store.name.split("—")[1]?.trim() ?? "Camp"}`,
            spend,
            revenue: Math.round(spend * roas),
            impressions: rand(5000, 40000),
            clicks: rand(100, 1200),
            conversions: rand(3, 30),
            source: "MANUAL",
          },
        });
      }
    }
  }

  console.log("Creating ad hierarchy (accounts → campaigns → adsets → metrics)...");
  const adPlatforms = ["FACEBOOK", "GOOGLE", "TWITTER"];
  const campaignThemes = ["Prospecting", "Retargeting", "Lookalike", "Broad"];
  const adsetAngles = [
    "Interest-Anime",
    "Lookalike-1%",
    "Broad-Auto",
    "Retarget-7d",
    "UGC-Video",
    "Carousel-BestSeller",
    "Interest-Pets",
  ];
  for (const store of stores) {
    const theme = store.name.split("—")[1]?.trim() ?? "Store";
    for (const platform of adPlatforms) {
      const account = await prisma.adAccount.create({
        data: {
          organizationId,
          storeId: store.id,
          platform,
          name: `${platform} - ${theme}`,
          externalId:
            platform === "FACEBOOK"
              ? `act_${rand(100000, 999999)}`
              : `${rand(100, 999)}-${rand(100, 999)}-${rand(1000, 9999)}`,
        },
      });
      const nCamp = rand(2, 3);
      for (let ci = 0; ci < nCamp; ci++) {
        const campExt = `c_${account.id}_${ci}`;
        await prisma.adEntity.create({
          data: {
            organizationId,
            accountId: account.id,
            storeId: store.id,
            platform,
            level: "CAMPAIGN",
            externalId: campExt,
            name: `${pick(campaignThemes)} ${ci + 1}`,
          },
        });
        const nAdset = rand(2, 4);
        for (let ai = 0; ai < nAdset; ai++) {
          const adExt = `${campExt}_a${ai}`;
          const quality = Math.random(); // drives the ROAS regime
          const baseRoas = 0.8 + quality * 3.2; // 0.8x – 4x
          const adset = await prisma.adEntity.create({
            data: {
              organizationId,
              accountId: account.id,
              storeId: store.id,
              platform,
              level: "ADSET",
              externalId: adExt,
              name: `${pick(adsetAngles)} ${ai + 1}`,
              parentExternalId: campExt,
              status: quality < 0.15 ? "PAUSED" : "ACTIVE",
            },
          });
          const metrics = [];
          for (let d = 24; d >= 0; d--) {
            const day = new Date(today);
            day.setDate(today.getDate() - d);
            const spend = rand(1500, 8000);
            const impressions = spend * rand(8, 20);
            const clicks = Math.round(impressions * (0.005 + Math.random() * 0.02));
            const roas = baseRoas * (0.8 + Math.random() * 0.4);
            const revenue = Math.round(spend * roas);
            const aov = rand(2500, 4500);
            metrics.push({
              entityId: adset.id,
              date: day,
              spend,
              impressions,
              clicks,
              conversions: Math.max(0, Math.round(revenue / aov)),
              revenue,
            });
          }
          await prisma.adMetric.createMany({ data: metrics });
        }
      }
    }
  }

  const orderCount = await prisma.order.count();
  const adCount = await prisma.adSpend.count();
  const entityCount = await prisma.adEntity.count();
  const metricCount = await prisma.adMetric.count();
  console.log(
    `   ad hierarchy: ${entityCount} entities, ${metricCount} metric rows`
  );
  console.log(
    `✅ Seed done: ${stores.length} stores, ${products.length} products, ${orderCount} orders, ${adCount} ad rows.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
