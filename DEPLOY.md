# Deploy TakaManager lên Production

Hướng dẫn đưa app lên GitHub và deploy production (Vercel + PostgreSQL).
App đã sẵn sàng: build pass, đã có git repo + commit đầu tiên (không chứa secrets).

---

## 1. Đẩy code lên GitHub

Cần **GitHub CLI** (`gh`) hoặc một repo trống sẵn.

### Cách A — GitHub CLI (khuyến nghị)

```bash
# Cài gh (Windows): winget install GitHub.cli   (rồi mở terminal mới)
gh auth login                 # đăng nhập 1 lần (mở trình duyệt)
cd c/Users/Mr_Dracula/MMO/ToolDev/TakaManager
gh repo create takamanager --private --source=. --remote=origin --push
```

### Cách B — Thủ công (đã có repo trên GitHub)

```bash
git remote add origin https://github.com/<username>/takamanager.git
git branch -M main
git push -u origin main
```

> `.env` (chứa `AUTH_SECRET` + khoá API) và `prisma/dev.db` **đã được .gitignore** — không bị đẩy lên.

---

## 2. Tạo PostgreSQL (managed)

Chọn một nhà cung cấp (free tier đều đủ để bắt đầu):

- **Neon** — https://neon.tech (khuyến nghị, free, serverless Postgres)
- **Supabase** — https://supabase.com
- **Railway** — https://railway.app

Lấy chuỗi `DATABASE_URL` dạng:
`postgresql://user:password@host:5432/takamanager?sslmode=require`

---

## 3. Đổi Prisma sang PostgreSQL

Trong `prisma/schema.prisma`, sửa block `datasource`:

```prisma
datasource db {
  provider = "postgresql"   // đổi từ "sqlite"
  url      = env("DATABASE_URL")
}
```

> Local vẫn có thể tiếp tục dùng SQLite bằng cách giữ một nhánh/biến riêng, nhưng đơn giản
> nhất cho production là đổi hẳn sang postgresql và dùng Postgres cho cả dev.

Đẩy schema lên DB production (chạy local với `DATABASE_URL` trỏ tới Postgres):

```bash
npx prisma db push
```

---

## 4. Deploy lên Vercel

1. Vào https://vercel.com → **Add New → Project** → import repo `takamanager` từ GitHub.
2. Framework tự nhận **Next.js**. Build command để mặc định (`npm run build` đã gồm `prisma generate`).
3. **Environment Variables** (Settings → Environment Variables):

   | Biến | Bắt buộc | Ghi chú |
   |---|---|---|
   | `DATABASE_URL` | ✅ | chuỗi PostgreSQL ở bước 2 |
   | `AUTH_SECRET` | ✅ | `openssl rand -hex 32` |
   | `ANTHROPIC_API_KEY` | tuỳ chọn | để bật chiến lược AI tối ưu ads |
   | `SHOPIFY_*`, `META_*`, ... | tuỳ chọn | nếu sync qua biến môi trường |

4. **Deploy**.

---

## 5. Khởi tạo dữ liệu production

- DB Postgres mới sẽ trống. Mở app đã deploy → trang **/signup** → tạo tài khoản đầu tiên
  (workspace mới, bạn là OWNER). Mời thành viên bằng **mã mời** trong thanh bên.
- (Tuỳ chọn) Nạp dữ liệu demo: chạy `node --env-file=.env prisma/seed.ts` với `DATABASE_URL`
  trỏ tới Postgres — **chỉ dùng cho môi trường thử**, đừng chạy seed trên DB thật.

---

## 6. Tự động đồng bộ hằng ngày (Vercel Cron)

Thêm `vercel.json` ở gốc repo:

```json
{
  "crons": [
    { "path": "/api/shopify/sync", "schedule": "0 1 * * *" },
    { "path": "/api/ads/sync", "schedule": "0 2 * * *" }
  ]
}
```

> Cron của Vercel gọi route bằng GET nội bộ — nếu cần, bổ sung một secret header để xác thực
> và cho 2 route này chấp nhận trigger từ cron (hiện chúng yêu cầu session đăng nhập).

---

## Checklist nhanh

- [ ] `gh auth login` (hoặc tạo repo trống) → `git push`
- [ ] Tạo PostgreSQL, lấy `DATABASE_URL`
- [ ] `provider = "postgresql"` trong schema → `npx prisma db push`
- [ ] Import vào Vercel + đặt `DATABASE_URL`, `AUTH_SECRET`
- [ ] Deploy → mở `/signup` tạo tài khoản
- [ ] (Tuỳ chọn) cấu hình Vercel Cron
