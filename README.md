# 🏛️ iforgotmywayhome (web bot lịch)

Web cho cả nhóm, hai việc chính:

1. **Giao lịch qua Zalo.** Trong nhóm Zalo ai đó nhờ bot "giao @An @Bình họp 9h mai". Bot Zalo **PyloS** (repo [PyloS](https://github.com/roemnao/PyloS), một hệ thống **độc lập**) nhận ra yêu cầu và gọi web này. Web **ghi thẳng vào Google Lịch của từng người được giao**, không cần họ mở web.
2. **Quản lý thời gian cho từng người:** lịch (tháng/tuần, kèm Google Lịch), công việc (ma trận Eisenhower), đề xuất từ AI Gemini (dán văn bản → lịch/việc), nguồn tự động (ICS, trang web), Pomodoro. Mỗi người chỉ thấy dữ liệu của chính mình.

Chạy trên **Vercel (miễn phí)** hoặc trên máy cá nhân. Web **không chạy trên máy ảo** và không có mục quản lý máy ảo. Máy ảo (VPS) là chuyện của PyloS.

## Cách hoạt động

```
Nhóm Zalo ─► PyloS ──(một khoá, chỉ API giao lịch)──► web: ghi lệnh vào hàng của từng người
                                                        └─► máy chủ ghi ngay vào Google Lịch của người đó
```

- **Một kiểu đăng nhập: Google.** Khi đăng nhập, Google hỏi luôn quyền Google Lịch trong cùng một màn hình. Cho phép là xong, máy chủ giữ quyền (refresh token, **mã hoá AES-256-GCM**) và tự đồng bộ: **không phải bấm lại mỗi giờ, không cần mở web, không bị "out"**. Chỉ khi người dùng tự gỡ quyền ở Google thì web hiện nút "Kết nối lại" (một cú bấm).
- **Zalo chỉ là liên kết phụ**, chứng minh bằng mã 6 số nhắn riêng cho bot.
- **PyloS và web chỉ có một kết nối:** giao / sửa / huỷ / xem lịch đã giao, liên kết Zalo, lịch/việc riêng của người nhắn (kèm `zaloUid`). PyloS **không** nhận cấu hình từ web, **không** gửi nhịp tim hay session lên web.

## Phân quyền

| Vai trò | Sử dụng bình thường | Quản lý bot lịch | Tài khoản người dùng |
|---|:-:|:-:|:-:|
| **Owner** | ✔ | ✔ | xem + cấp quyền, gỡ Zalo, xoá |
| **Technician** | ✔ | ✔ | chỉ xem |
| **User** | ✔ | ✘ | ✘ |

- **Sử dụng bình thường:** Tổng quan, Lịch, Công việc, Đề xuất, Nguồn, **Tài khoản** (hồ sơ, Google Lịch, Zalo, lịch được giao đã ghi, điều khoản, xoá tài khoản).
- **Quản lý bot lịch** (Owner, Technician): tab *Nhật ký bot lịch*, *Cài đặt bot lịch*, *Bot Zalo nhắc việc*, *Kết nối AI agent* (khoá cho PyloS), *Khoá & trạng thái* (Gemini, token Zalo, Google OAuth, lưu trữ, cron).
- **Tài khoản người dùng** (Owner, Technician): danh sách, trạng thái Google/Zalo, nhật ký phân quyền. Chỉ Owner đổi quyền; phải còn ít nhất một Owner.
- Quyền được kiểm tra ở **máy chủ** mỗi yêu cầu (`src/roles.js`), đổi quyền có hiệu lực ngay.
- **Owner đầu tiên:** đặt biến `OWNER_EMAILS` (Gmail của bạn, cách nhau dấu phẩy), đăng nhập bằng Gmail đó. Đây cũng là đường cứu hộ khi mất hết Owner.

## 🚀 Đưa lên Vercel

1. **Sao lưu trước** nếu đang có dữ liệu: `UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/backup.mjs`.
2. **Tạo project:** https://vercel.com/new → repo `quanlythoigian` → Import.
3. **Biến môi trường** (Settings → Environment Variables, đổi xong phải **Redeploy**):

   | Tên | Giá trị |
   |---|---|
   | `OWNER_EMAILS` | Gmail của bạn |
   | `TOKEN_ENC_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Đừng đổi về sau** (đổi là mọi người phải kết nối lại Google Lịch). Production và Preview dùng khoá khác nhau |
   | `CRON_SECRET` | chuỗi ngẫu nhiên dài, không dấu cách và ký tự đặc biệt |
   | `PRIMARY_HOST` | tên miền chính, vd `iforgotmywayhome.vercel.app` |
   | `GEMINI_API_KEY`, `ZALO_BOT_TOKEN` | (hoặc nhập trên web ở *Khoá & trạng thái*) |

   **Môi trường Preview** nên đặt thêm `KV_PREFIX=qltg-preview:` và `STORAGE_KEY=quanlythoigian-preview:db` để bản thử không đụng dữ liệu thật.
4. **Upstash Redis (bắt buộc, miễn phí):** tab **Storage → Create Database → Upstash for Redis → Connect**, rồi Redeploy.
5. **Google** (mục dưới), **cron** (mục dưới), **nối PyloS** (mục dưới).

## 🔑 Google: đăng nhập + Google Lịch

1. https://console.cloud.google.com → tạo project, bật **Google Calendar API**.
2. **Google Auth Platform → Branding:** *App name* `iforgotmywayhome`, email hỗ trợ, link `https://<tên miền>/privacy.html` và `/terms.html`.
3. **Data access → Add or remove scopes:** `openid`, `email`, `profile`, `https://www.googleapis.com/auth/calendar.events`.
4. **Audience: External, rồi bấm _Publish app_ (In production).** ⚠️ Nếu để *Testing*, quyền lâu dài của **mọi người hết hạn sau 7 ngày** và họ bị bắt kết nối lại. Chưa xác minh vẫn dùng được tối đa **100 người** (màn hình "Google hasn't verified this app": Nâng cao → Đi tới). Quá 100 người thì gửi Google xác minh quyền `calendar.events` (cần video demo, chính sách quyền riêng tư).
5. **Clients → Create client → Web application:**
   - *Authorized JavaScript origins:* `https://<tên miền chính>`
   - *Authorized redirect URIs:* `https://<tên miền chính>/api/google/callback`
   (Hai dòng này có sẵn để chép ở *Quản lý bot lịch → Khoá & trạng thái → Google*.)
6. Dán **Client ID** và **Client secret** vào đó rồi Lưu.

Mẫu giải trình khi Google hỏi về scope: *Web ghi lịch được giao trong nhóm Zalo vào Google Lịch của chính người dùng (thêm, sửa, xoá sự kiện do web tạo) và hiện lịch của họ trên web. `calendar.readonly` không ghi được; `calendar.events` là quyền hẹp nhất cho phép ghi sự kiện. Quyền được lưu mã hoá, không chia sẻ, không dùng quảng cáo hay huấn luyện AI; người dùng ngắt được bất cứ lúc nào.*

## ⏰ Cron (bắt buộc để lịch lỗi tạm thời được ghi bù)

Vercel miễn phí chỉ cron 1 lần/ngày. Tạo job miễn phí ở https://cron-job.org: URL `https://<tên miền>/api/cron?key=<CRON_SECRET>`, GET, **mỗi 5 phút**, timeout 30 giây. Cron chạy lại lệnh Google bị lỗi tạm thời (mạng, Google quá tải), đồng bộ nguồn và Google Lịch theo lô (tối đa 20 người/lần, xoay vòng), gửi nhắc việc Zalo. Lịch được giao **vẫn được ghi ngay lúc bot giao**; cron chỉ là lưới an toàn.

## 🤖 Nối bot Zalo PyloS

1. Đăng nhập (Owner hoặc Technician) → **Quản lý bot lịch → Kết nối AI agent → Tạo khoá**, chép khoá.
2. Trong `settings.env` của PyloS (máy Windows và VPS):
   ```
   SCHEDULE_API_URL=https://<tên miền>
   SCHEDULE_API_KEY=<khoá vừa tạo>
   ```
3. Khởi động lại PyloS. Mô tả API: `/api/agent/openapi.json`.

| API (xác thực `Authorization: Bearer <khoá>`) | Việc |
|---|---|
| `POST /api/agent/zalo-link` `{code, zaloUid, zaloName}` | liên kết Zalo của người gửi mã với tài khoản Google của họ |
| `POST /api/agent/assign` `{title, start, end?, allDay?, note?, assignees:[{zaloUid, name}], source}` | giao lịch; ghi vào Google Lịch của từng người đã liên kết; trả `{eventId, assigned, unlinked, appUrl}` |
| `PATCH /api/agent/assign/:id` · `DELETE …` · `GET …` | sửa (người mới nhận lệnh thêm, người bị bỏ bị xoá khỏi Google Lịch), huỷ, xem tình trạng |
| `POST /api/agent/events`, `GET/POST /api/agent/tasks`, `PATCH …/tasks/:id`, `GET …/agenda`, `POST …/message` | lịch / việc **riêng** của người nhắn, bắt buộc kèm `zaloUid` (chưa liên kết → 404 kèm `appUrl`) |
| `config`, `heartbeat`, `sessions`, `device-login` | **đã bỏ**, trả `410` (PyloS đã tách khỏi web) |

## 🔄 Chuyển từ bản cũ (một tài khoản quản trị mật khẩu)

- Đăng nhập mật khẩu `APP_PASSWORD` / tài khoản quản trị **không còn**. Đặt `OWNER_EMAILS`, đăng nhập bằng Google.
- **Dữ liệu cũ của chủ web** (lịch, việc, đề xuất, nguồn, Google Lịch, ghép nối Zalo nhắc việc) tự chuyển sang tài khoản Owner ở lần đăng nhập đầu của Owner (hoặc cron, hoặc nút *Chuyển dữ liệu cũ* ở *Khoá & trạng thái*). **Không xoá bản cũ** để quay lại được; dọn bằng `node scripts/cleanup-w5.mjs` sau khi ổn.
- Mọi người được hỏi đồng ý điều khoản lại (đổi phiên bản `2026-11-01`) và nên đăng nhập lại để cho phép Google Lịch (quyền trước đây nằm trong trình duyệt, không chuyển sang máy chủ được). Lịch đã ghi trước đây không bị tạo trùng (cùng ID cố định).
- Tên miền cũ (`quanlythoigian-azure…`) vẫn nhận API của PyloS, webhook Zalo, cron; mọi trang chuyển (308) về `PRIMARY_HOST`.

## 💻 Chạy trên máy

Cần Node.js ≥ 20.12.
```bash
npm install
cp .env.example .env     # điền OWNER_EMAILS, GEMINI_API_KEY, Google Client...
npm start                # http://localhost:3000
npm test                 # kiểm thử đơn vị
npm run test:e2e         # trình duyệt thật, 3 vai trò (cần Playwright + Chromium); SHOTS_DIR=thư-mục để lưu ảnh
```
Dữ liệu trên máy: `data/db.json`, `data/kv.json`. Google OAuth khi chạy máy cần thêm `http://localhost:3000/api/google/callback`.

> ⚠️ **Không bao giờ commit key vào repo.** Key chỉ nằm trong `.env` hoặc Environment Variables của Vercel.

## Biến môi trường

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `OWNER_EMAILS` | Gmail Owner (cũng là đường cứu hộ) | trống |
| `TOKEN_ENC_KEY` | Khoá mã hoá quyền Google Lịch (base64, 32 byte) | trống (trên Vercel bắt buộc) |
| `CRON_SECRET` | Bảo vệ `/api/cron?key=` | trống |
| `PRIMARY_HOST` (cũ: `APP_HOST`) | Tên miền chính | trống: dùng host hiện tại |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `ZALO_BOT_TOKEN` | Có thể nhập trên web | trống |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Có thể nhập trên web | trống |
| `KV_PREFIX`, `STORAGE_KEY` | Tiền tố khoá Redis (tách Preview/Production) | `qltg:`, `quanlythoigian:db` |
| `APP_TIMEZONE` | Múi giờ | `Asia/Ho_Chi_Minh` |
| `SYNC_INTERVAL_MINUTES`, `REMIND_BEFORE_MINUTES`, `DAILY_SUMMARY_HOUR` | Chu kỳ đồng bộ, nhắc, tóm tắt | 30, 15, 7 |
| `ZALO_MODE`, `ZALO_WEBHOOK_SECRET`, `ZALO_CHAT_ID` | Bot Zalo nhắc việc của web | polling |

## Giới hạn mỗi người (`src/limits.js`)
Tối đa 5 nguồn (2 nguồn trang web), 2.000 lịch, 1.000 việc, 20 lần AI trích lịch mỗi ngày. Nguồn không được trỏ vào địa chỉ nội bộ.

## Cấu trúc
```
api/index.js, server.js   điểm vào Vercel / chạy trên máy
src/app.js                API Express: đăng nhập Google, /api/me (dữ liệu riêng), /api/admin (theo quyền), /api/agent (PyloS)
src/roles.js              Owner / Technician / User và bảng quyền
src/members.js            tài khoản, điều khoản, mã liên kết Zalo, hàng lệnh, đổi quyền + nhật ký
src/userstore.js          dữ liệu riêng từng người (udata:<id>), Owner chính
src/gtoken.js, gsync.js   quyền Google Lịch (mã hoá) và ghi lịch từ máy chủ
src/calsync.js            áp lệnh thêm/sửa/xoá vào Google Lịch (ID cố định, không trùng)
src/calbot.js, calbot-log.js   bot lịch: giao/sửa/huỷ lịch, nhật ký 90 ngày
src/google.js, sources.js, gemini.js, zalo.js, cron.js, migrate.js, kv.js, storage.js
views/app.html            một giao diện cho mọi người; public/app/*.js: main (sử dụng), account, admin-bot, admin-accounts
scripts/backup.mjs, cleanup-w5.mjs   sao lưu Upstash, dọn dữ liệu cũ
test/                     npm test (58 test); test/e2e: npm run test:e2e
docs/KE-HOACH-CAP-NHAT-2026-11-01.md   kế hoạch cập nhật
```

## Giới hạn
- Không đẩy thông báo (chưa có Web Push).
- Quá 100 người dùng cần gửi Google xác minh quyền `calendar.events`.
- Gói miễn phí của Upstash có giới hạn lệnh mỗi tháng: theo dõi mục *Usage* vài ngày đầu; tăng chu kỳ cron nếu cần.
- Bot Zalo nhắc việc của web (nhắc trước giờ, tóm tắt sáng) chỉ nhắc cho Owner chính.
