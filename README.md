# TakaManager — Hệ thống Quản lý Dữ liệu & Tối ưu Marketing cho POD

Hệ thống quản lý chi phí, doanh thu, lợi nhuận đa store Shopify và tối ưu quảng cáo
đa nền tảng cho doanh nghiệp POD tại thị trường Nhật Bản.

## Tech stack

- **Next.js 15** (App Router, TypeScript) — full-stack (UI + API).
- **Prisma** ORM — SQLite (dev) → PostgreSQL (cloud).
- **Tailwind CSS** + **Recharts** — dashboard.

## Chạy dự án

```bash
npm install            # cài dependencies
npm run db:push        # tạo / cập nhật database từ schema
npm run db:seed        # nạp dữ liệu mẫu (3 store, ~460 đơn, ads 35 ngày)
npm run dev            # chạy dev server → http://localhost:3000
```

Sau khi seed, đăng nhập demo: **demo@takamanager.com** / **demo1234**.

## Đăng nhập & đa người dùng (multi-tenant)

- **Workspace (Organization)**: mọi dữ liệu (stores, chi phí, ads...) thuộc về 1 workspace
  và **cô lập theo `organizationId`** — user của workspace này không thấy dữ liệu workspace khác.
- **Đăng nhập email + mật khẩu** (hash bằng `scrypt`, session là cookie httpOnly ký HMAC —
  không dùng thư viện native). Đặt `AUTH_SECRET` trong `.env` (production: `openssl rand -hex 32`).
- **Mời thành viên**: chủ workspace chia sẻ **mã mời** (hiện ở thanh bên); thành viên đăng ký
  bằng mã đó để vào chung workspace (owner + nhân sự dùng chung dữ liệu).
- Mọi API route đều kiểm tra session và lọc theo workspace; thao tác sửa/xóa chỉ tác động
  đúng dữ liệu của workspace (cross-tenant → 404). Middleware chặn truy cập khi chưa đăng nhập.

Lệnh hữu ích khác:

```bash
npm run db:studio      # mở Prisma Studio để xem/sửa DB trực quan
npm run build          # build production (kiểm tra type)
npm run start          # chạy bản production
```

> Lưu ý môi trường: nếu `tsx` không chạy được (esbuild bị chặn cài), seed bằng:
> `node --env-file=.env prisma/seed.ts`

## Cấu trúc

```
prisma/
  schema.prisma        # mô hình dữ liệu (Store, FixedCost, CostRule, AdSpend, Order, Product)
  seed.ts              # dữ liệu mẫu
src/
  app/
    page.tsx           # Dashboard lợi nhuận (lọc today/week/month, theo store)
    stores/            # Quản lý store
    costs/fixed/       # Chi phí cố định (Shopify, Klaviyo, Line, cơ sở)
    costs/variable-a/  # Biến đổi A: COGS, phí bán, ship, mực in, nhân sự
    costs/ads/         # Biến đổi B: chi phí quảng cáo
    api/               # REST API cho tất cả tài nguyên + /api/dashboard
  lib/
    pnl.ts             # ⭐ P&L ENGINE — tính lợi nhuận theo store/sản phẩm/ngày
    shopify.ts         # client Shopify Admin API (GraphQL): products + orders + UTM
    sync.ts            # orchestrator Shopify: chuẩn hoá + upsert (idempotent)
    ads/               # ad-platform clients: meta.ts, google.ts, twitter.ts (+ types)
    adsync.ts          # orchestrator Ads: spend → AdSpend + hierarchy → AdEntity/AdMetric
    adinsights.ts      # build Campaign→Adset tree + KPIs (ROAS/CPA/CTR/CVR)
    optimize.ts        # luật cứng: khuyến nghị Scale/Keep/Reduce/Pause theo hoà vốn
    ai.ts              # lớp AI (Claude Opus 4.8) sinh chiến lược tối ưu ads
    dates.ts           # bộ lọc khoảng thời gian
    format.ts          # định dạng JPY, %, x
    constants.ts       # nhãn tiếng Việt cho các loại chi phí
  components/          # UI kit + biểu đồ + sidebar
  hooks/useResource.ts # hook CRUD dùng chung
```

## Công thức lợi nhuận (P&L)

```
Doanh thu (ex-tax) = (subtotal − giảm giá) + phí ship khách trả
  − Biến đổi A  (COGS basecost, phí bán hàng %, ship, mực in, nhân sự, đóng gói)
  = Lợi nhuận gộp
  − Biến đổi B  (quảng cáo Facebook / Google / Twitter)
  = Contribution
  − Chi phí cố định (phân bổ theo ngày; chi phí chung chia theo % doanh thu store)
  = LỢI NHUẬN RÒNG
```

Chỉ số: Net margin, **MER** (DT/Ad spend), ROAS, AOV, LN/đơn, **Break-even MER**.

## Kết nối Shopify (Phase 2)

> ⚠️ **Thay đổi xác thực 2026:** Shopify đã **ngừng** token custom-app cũ (`shpat_...`
> hiện trong Admin) từ **01/01/2026**. App mới tạo ở **Dev Dashboard** chỉ cho
> **Client ID + Client Secret**; TakaManager tự **đổi lấy access token 24h** qua
> *client credentials grant* (`POST /admin/oauth/access_token`). Token cũ vẫn dùng được
> nếu bạn còn.

1. Vào **Shopify Dev Dashboard** (dev/partners) → mở app → **Settings** → copy
   **Client ID** và **Client Secret**.
2. Trong app, cấp **Admin API scopes**: `read_orders`, `read_products`
   (**không cần** `read_inventory`), rồi **cài (install) app lên đúng store**
   (app & store phải **cùng tổ chức**).
3. **(Cho attribution kênh/UTM)** Bật **Protected customer data access** cho app — cần để
   đọc `customerJourneySummary` (nguồn traffic của đơn: Facebook/Google/Twitter/Klaviyo...).
   Chưa bật vẫn đồng bộ được doanh thu/sản phẩm, chỉ thiếu phần phân loại kênh (tự fallback).
4. Vào trang **Stores** trong TakaManager → thêm store với **domain + Client ID + Client
   Secret** (hoặc bấm 🔑 để nhập sau) → **chọn khoảng ngày** (mặc định 7 ngày; có 1/3/7/30/60
   hoặc từ ngày cụ thể) → bấm **Test** → bấm **Sync** (hoặc **Đồng bộ tất cả**), xem thanh %.
5. Hệ thống đổ về Dashboard: **số đơn, doanh thu, đơn theo kênh traffic, best-seller**
   — đủ để giai đoạn sau tối ưu hiệu quả Ads.

> ⚡ **Nhẹ & nhanh:** sync **không kéo toàn bộ catalog**. Sản phẩm (chỉ **tiêu đề + 1 ảnh**)
> được suy ra từ các **đơn trong khoảng ngày đã chọn**. Giá vốn (COGS) khai ở **Biến đổi A**
> (Cost Rules). Kéo theo từng mốc ngắn (7 → 30 → 60) là an toàn vì sync **idempotent**.

> 🧩 **Kéo theo trang (không timeout):** mỗi lần Sync, trình duyệt gọi `POST /api/shopify/sync/page`
> lặp lại theo `cursor` (mỗi request ~25 đơn) cho tới hết → không bao giờ chạm giới hạn thời gian
> serverless; thanh % tính theo tổng đơn thật (`ordersCount`).

### Tự động đồng bộ thời gian thực (Webhook)

Bấm **🔔 Tự động** ở mỗi store để đăng ký webhook `orders/create` + `orders/updated`. Sau đó
**đơn mới / cập nhật từ Shopify sẽ tự đổ về** (không cần bấm Sync).

- Endpoint nhận: `POST /api/shopify/webhook` (công khai, xác thực bằng **HMAC** chữ ký của Shopify
  dùng **Client Secret** của app — không cần đăng nhập; đã allow-list trong `middleware.ts`).
- Webhook dùng **cùng `externalId`** (GID) như sync thủ công → **không trùng/không ghi đè nhầm**.
  Đơn từ webhook tạm thời có thể thiếu phân loại kênh; lần Sync sau sẽ cập nhật đúng cùng dòng.
- Cần app có **Client ID + Client Secret** (đã cài lên store). Trạng thái hiện badge **🔔 Tự động**.
- ⚠️ Cần chạy `npx prisma db push` **một lần** (thêm cột `Store.webhooksEnabled`).

> Đồng bộ là **idempotent** (upsert theo `storeId + externalId`) — chạy lại bao nhiêu lần
> cũng không nhân đôi dữ liệu. Để tự động hằng ngày trên cloud, gọi `POST /api/shopify/sync`
> bằng cron (Vercel Cron / GitHub Actions).

### Chống trùng dữ liệu khi sync lặp (idempotency)

Mọi đường đồng bộ đều an toàn khi chạy lại nhiều lần:
- **Shopify** products/orders: upsert theo `@@unique([storeId, externalId])`; line items thay mới.
- **Ad hierarchy**: `AdEntity` theo `@@unique([accountId, externalId])`, `AdMetric` theo `@@unique([entityId, date])`.
- **Ad spend**: cột `AdSpend.dedupeKey @unique` (mã hoá `source|store|platform|ngày|campaign`,
  encode null) → `upsert` cấp DB; trong một lần sync còn gộp các dòng trùng key. Dòng nhập tay
  (MANUAL) giữ `dedupeKey = null` nên không bao giờ đụng nhau.

## Kết nối Ads (Phase 3)

Vào trang **Kết nối Ads** → thêm tài khoản theo nền tảng → **Test** → **Sync** (hoặc
**Đồng bộ tất cả**). Spend sẽ đổ vào dashboard và ghép với doanh thu theo kênh → **ROAS
theo kênh** (bảng "Hiệu quả theo kênh" có cờ Scale / Cắt-Tối ưu theo điểm hoà vốn MER).

Khoá cần cho mỗi nền tảng:
- **Meta (Facebook):** Ad Account ID (`act_…`) + Access Token (Marketing API).
- **Google Ads:** Customer ID + Developer Token + OAuth Client ID/Secret + Refresh Token
  (+ Login Customer ID nếu dùng MCC). Gọi REST `googleAds:searchStream`.
- **X (Twitter):** Ads Account ID + 4 khoá OAuth 1.0a (API Key/Secret + Access Token/Secret).
  *(Phần parse stats là best-effort — kiểm chứng với khoá thật.)*

> Auto hằng ngày: gọi `POST /api/ads/sync` bằng cron, song song với `POST /api/shopify/sync`.

## Lộ trình (Roadmap)

- **Phase 1 ✅ — Tài chính / P&L:** nhập chi phí, dashboard lợi nhuận, lọc thời gian.
- **Phase 2 ✅ — Shopify:** tự động kéo Order / Product / Revenue / best-seller + attribution.
- **Phase 3 ✅ — Ads:** đồng bộ spend Meta / Google / X; ROAS theo kênh + MER hợp nhất.
- **Phase 4 ✅ — Tối ưu sâu + AI:** đọc sâu Campaign → Adset, chấm KPI, khuyến nghị
  Scale/Giữ/Giảm/Dừng theo điểm hoà vốn; có lớp AI (Claude) đưa chiến lược tổng thể.

## Tối ưu Ads sâu (Phase 4)

Trang **Tối ưu Ads** đọc xuống cấp **Campaign → Adset** (Meta ad set / Google ad group /
X line item), tính KPI từng cấp (ROAS, CPA, CTR, CVR) và đưa **khuyến nghị hành động**:
🚀 Tăng ngân sách / ✓ Giữ / ↓ Giảm-Tối ưu / ⛔ Tạm dừng — so với điểm hoà vốn ROAS,
kèm chẩn đoán theo phễu (CTR thấp = creative; CVR thấp = landing/giá).

- Luật cứng (deterministic) chạy luôn, không cần khoá.
- Nút **🤖 Hỏi AI chiến lược** gọi Claude (Opus 4.8) để có chiến lược tổng thể + theo nền tảng.
  Cần đặt `ANTHROPIC_API_KEY` trong `.env` (nếu chưa có, phần luật cứng vẫn hoạt động).
- Dữ liệu hierarchy được nạp khi **Sync** ở trang Kết nối Ads (cùng lúc với spend).

## Đưa lên GitHub & Deploy production

Hướng dẫn đầy đủ (từng bước, có lệnh copy-paste): xem **[DEPLOY.md](DEPLOY.md)**.

Tóm tắt:

1. **GitHub** — `git init` đã làm sẵn; tạo repo và đẩy lên:
   ```bash
   gh repo create takamanager --private --source=. --remote=origin --push
   # hoặc thủ công:
   git remote add origin https://github.com/<user>/takamanager.git
   git push -u origin main
   ```
2. **PostgreSQL** — tạo DB managed (Neon / Supabase / Railway), lấy `DATABASE_URL`.
3. **Schema** — đổi `provider = "postgresql"` trong `prisma/schema.prisma`.
4. **Vercel** — import repo, đặt biến môi trường `DATABASE_URL`, `AUTH_SECRET`
   (và `ANTHROPIC_API_KEY`, khoá Shopify/Ads nếu dùng), rồi deploy.
5. **Khởi tạo DB** — `npx prisma db push` lên Postgres; tạo tài khoản đầu tiên qua trang `/signup`.
6. **Cron** — gọi `POST /api/shopify/sync` và `POST /api/ads/sync` hằng ngày (Vercel Cron).

> ⚠️ Production **không dùng SQLite** (serverless không giữ file) — bắt buộc PostgreSQL.
> Đặt `AUTH_SECRET` mạnh: `openssl rand -hex 32`.
