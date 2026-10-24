# 🏛️ iforgotmywayhome

Tên chính thức của web **quanlythoigian**. Web làm hai việc:

1. **Giao lịch qua Zalo cho cả nhóm.** Trong nhóm Zalo, ai đó nhờ bot "giao @An @Bình họp 9h mai". Bot Zalo (repo [PyloS](https://github.com/roemnao/PyloS)) nhận ra yêu cầu và báo cho web. Web (gọi là **bot lịch**) ghi lệnh vào hàng của từng người. **Web app** của mỗi người tự ghi lịch đó vào **Google Lịch của chính họ**.
2. **Quản lý thời gian cho chủ web:** lịch, việc cần làm, Pomodoro, tự lấy lịch từ nguồn (ICS, trang web, văn bản) bằng AI Gemini, bot Zalo nhắc việc.

Chạy được trên **Vercel (miễn phí)** hoặc trên máy cá nhân.

## Cách hoạt động: một chiều

```
Nhóm Zalo ─► PyloS (bộ lọc + agent): "giao lịch cho @A, @B"
          ─► web (bot lịch): ghi lệnh thêm / sửa / xoá vào hàng của A và B + ghi log
          ─► web app của A, B chỉ NHẬN lệnh của chính mình rồi ghi vào Google Lịch ngay trong trình duyệt
```

- **Tài khoản chính là Gmail.** Zalo chỉ là liên kết phụ, chứng minh bằng mã 6 số nhắn riêng cho bot.
- Web app **không** đọc hay tìm được dữ liệu nào khác trên máy chủ, và **không** gửi lịch hay dữ liệu Google Lịch ngược lên. Quyền Google Lịch chỉ nằm trong trình duyệt của người dùng.
- Người dùng **không đổi được model AI**. Model của agent, model của bộ lọc và mọi thông số của bot do chủ hệ thống chỉnh ở trang quản trị.

## Tính năng

**Web app cho thành viên** (trang chủ của tên miền app riêng, xem mục *Tên miền* bên dưới; cài được lên màn hình điện thoại như ứng dụng):
- Đăng nhập Gmail (phải đồng ý Điều khoản dịch vụ và Chính sách quyền riêng tư; khi điều khoản đổi phiên bản, app hỏi đồng ý lại).
- Liên kết Zalo: lấy mã 6 số (10 phút, dùng một lần, tối đa 5 mã/giờ), nhắn riêng mã đó cho acc bot.
- Kết nối Google Lịch, tự lấy lệnh mỗi phút khi app đang mở và ghi thêm / sửa / xoá vào lịch chính. Mỗi lịch có ID cố định nên chạy lại không bị trùng.
- Lịch sử các lệnh đã nhận, chỉ lưu trên máy đó. Gỡ liên kết Zalo, đăng xuất, xoá tài khoản ngay trong app.

**Trang quản trị cho chủ hệ thống** (tên miền quản trị), mục **Hệ thống**:
- **Thành viên:** link web app để gửi cho mọi người, danh sách thành viên (Zalo đã liên kết chưa, lần cuối app hỏi lệnh), gỡ Zalo, xoá tài khoản, giới hạn email / tên miền được tạo tài khoản, link mở chat với bot.
- **Nhật ký bot lịch:** mỗi lệnh thêm / sửa / xoá: lúc nào, nhóm nào, ai giao, ai nhận, ai chưa liên kết, và lúc app của từng người lấy lệnh về. Lọc theo ngày và người, tải CSV. Giữ 90 ngày.
- **Cấu hình bot:** model của agent, model của bộ lọc, bật/tắt bộ lọc AI, tên gọi bot, giới hạn, ai được giao lịch, SYSTEM.md / MEMORY.md… Bot áp trong vòng một phút, không cần khởi động lại. Kèm trạng thái bot (nhịp tim, phiên bản, token hôm nay, lỗi gần nhất).
- **Session:** chọn nhóm và ngày, xem từng bước tin → bộ lọc → agent → tool → bot lịch → câu trả lời.

Phần quản lý thời gian của chủ web vẫn như trước: Tổng quan, Lịch (tháng/tuần), Công việc (ma trận Eisenhower), Đề xuất từ AI, Nguồn tự động (ICS, trang web), bot Zalo nhắc việc, link `.ics` cho điện thoại, đồng bộ 2 chiều với Google Lịch của chủ web.

**Giao diện:** phong cách kiến trúc cổ đại (khối đá xám pha pastel, hoa văn meander, nút như cột đá), **nền tối mặc định**, có nút chuyển sang nền sáng (nhớ trong trình duyệt). Font tự lưu trong web, đủ dấu tiếng Việt.

## 🚀 Đưa lên Vercel
1. **Tạo project:** vào https://vercel.com/new, đăng nhập bằng GitHub, chọn repo `quanlythoigian` rồi bấm **Import**. Không cần đổi cài đặt build.
2. **Thêm biến môi trường** trước khi bấm Deploy (mục *Environment Variables*):

   | Tên | Giá trị |
   |---|---|
   | `GEMINI_API_KEY` | key Gemini (https://aistudio.google.com/apikey) |
   | `ZALO_BOT_TOKEN` | token bot Zalo (nếu dùng bot nhắc việc của web) |

   Bấm **Deploy**.
3. **Thêm nơi lưu dữ liệu (bắt buộc, miễn phí):** trong project, vào tab **Storage**, chọn **Create Database**, chọn **Upstash for Redis** (gói Free), rồi **Connect** vào project. Sau đó vào tab **Deployments**, bấm **⋯** ở bản mới nhất và chọn **Redeploy**.
   > Tài khoản thành viên, hàng lệnh, log bot lịch và session đều nằm trong Upstash. Không có bước này, dữ liệu mất mỗi khi Vercel khởi động lại.
4. **Tạo tài khoản quản trị:** mở web, nhập tên đăng nhập và mật khẩu ở màn hình **Chào mừng**. Người tạo đầu tiên là chủ web.
5. **Tách tên miền cho web app** (mục dưới), để người dùng chỉ thấy app, còn trang quản trị ở tên miền khác.
6. **Kết nối Google** (mục dưới) để có đăng nhập Gmail và web app.
7. **Nối bot Zalo PyloS** (mục dưới) để giao lịch trong nhóm.

Mỗi lần có code mới trên nhánh chính, Vercel tự deploy lại.

## 🌐 Tên miền: app người dùng và trang quản trị
Một project Vercel phục vụ hai tên miền: **tên miền app** cho mọi người (web app ở trang chủ) và **tên miền quản trị** cho bạn. Hai bên dùng chung database và code, nhưng:
- Tên miền app chỉ có web app và API của thành viên. Trang quản trị, API quản trị, đăng nhập quản trị không có ở đây.
- Tên miền quản trị không có API của thành viên; link `/app/` cũ tự chuyển sang tên miền app.
- Bot Zalo (`/api/agent/…`), webhook Zalo, cron dùng được ở cả hai.
- Mỗi tên miền có cookie đăng nhập riêng.

Cách bật (gợi ý: giữ `quanlythoigian-azure.vercel.app` cho quản trị, nên không phải đăng ký lại webhook Zalo, cron-job, Google hay địa chỉ trong PyloS):
1. Vercel → project → **Settings → Domains** → **Add** tên miền cho app, ví dụ `iforgotmywayhome.vercel.app` (tên `*.vercel.app` miễn phí nếu còn trống; dùng tên miền riêng của bạn cũng được).
2. **Settings → Environment Variables** → thêm `APP_HOST` = tên miền đó (vd `iforgotmywayhome.vercel.app`) → **Deployments → Redeploy**.
3. Google Cloud → Client: thêm **Authorized JavaScript origin** `https://<tên miền app>` và **Authorized redirect URI** `https://<tên miền app>/api/google/callback` (giữ redirect URI của tên miền quản trị). Hai dòng này có sẵn để sao chép ở trang quản trị → Cài đặt → Khoá API → Google.
4. Gửi mọi người link `https://<tên miền app>/` (có ở Hệ thống → Thành viên). Bạn vẫn vào trang quản trị ở tên miền quản trị.

Chưa đặt `APP_HOST` thì dùng chung một tên miền: trang quản trị ở `/`, web app ở `/app/`.

## 🔑 Google: đăng nhập Gmail và Google Lịch
Cần một OAuth Client miễn phí của Google:
1. Vào https://console.cloud.google.com, tạo project và bật **Google Calendar API**.
2. Vào **Google Auth Platform → Branding**: đặt *App name* là **iforgotmywayhome**, điền email hỗ trợ, và dán link **Chính sách quyền riêng tư** `https://<tên-web>.vercel.app/privacy.html` và **Điều khoản** `https://<tên-web>.vercel.app/terms.html`.
3. Mục **Data access** → **Add or remove scopes**: thêm `openid`, `email`, `profile` và `https://www.googleapis.com/auth/calendar.events`.
4. Mục **Audience**: chọn **External**.
   - Quyền `calendar.events` là quyền nhạy cảm. Khi chưa gửi Google xác minh, ứng dụng tối đa **100 test user**: thêm Gmail của từng thành viên vào danh sách *Test users*. Khi đăng nhập, Google có thể cảnh báo "ứng dụng chưa được xác minh": bấm **Nâng cao** rồi **Tiếp tục**.
   - Muốn mở cho nhiều người hơn, bấm **Publish app** và gửi Google xác minh.
5. Mục **Clients → Create client**, loại **Web application**:
   - **Authorized JavaScript origins:** địa chỉ của web app, vd `https://<tên miền app>` (web app ghi Google Lịch ngay trong trình duyệt nên cần dòng này).
   - **Authorized redirect URIs:** `https://<tên miền quản trị>/api/google/callback`, và nếu đã tách tên miền thì thêm `https://<tên miền app>/api/google/callback`. Các dòng này có sẵn trong Cài đặt → Khoá API → Google để sao chép.
6. Dán **Client ID** và **Client secret** vào **Cài đặt → Khoá API → Google**, rồi bấm Lưu.

Chủ web vẫn dùng được các tính năng cũ: đăng nhập trang quản trị bằng Google, đồng bộ 2 chiều với Google Lịch của chính mình (Cài đặt → Google Lịch).

## 👥 Mời mọi người dùng web app
1. Trang quản trị → **Hệ thống → Thành viên**: điền **tên bot trên Zalo** và **link mở chat với bot** (`https://zalo.me/<số điện thoại acc bot>`), rồi chép link web app (vd `https://iforgotmywayhome.vercel.app/`) gửi cho mọi người. Muốn giới hạn ai được tạo tài khoản, điền danh sách email hoặc tên miền (`an@gmail.com, @congty.vn`).
2. Mỗi người mở link, tick đồng ý điều khoản, **Đăng nhập bằng Google**.
3. Bấm **Lấy mã liên kết**, nhắn riêng 6 số đó cho acc bot trên Zalo. App tự nhận ra khi đã liên kết.
4. Bấm **Kết nối Google Lịch**.

Lưu ý:
- **App phải đang mở** (máy tính hoặc điện thoại) thì lịch mới được ghi; lệnh chưa lấy được chờ tối đa **30 ngày**.
- Quyền Google Lịch trong trình duyệt hết hạn sau khoảng **1 giờ**. Khi có lịch mới mà quyền đã hết, app hiện nút **Cập nhật Google Lịch**: bấm là xong (không phải tick lại). Nếu trình duyệt chặn cửa sổ bật lên, hãy cho phép trang này mở cửa sổ.
- Người được giao khi chưa liên kết Zalo sẽ không nhận lịch đó; bot báo tên họ kèm link app trong nhóm. Sau khi họ liên kết, nhờ bot sửa lịch để giao lại.

## 🤖 Nối bot Zalo PyloS
1. Trang quản trị → **Cài đặt → Kết nối AI agent → Tạo khoá cho agent**, chép khoá.
2. Trên máy chạy PyloS, điền vào `userdata/config/settings.env` (hoặc giao diện quản lý của PyloS):
   ```
   SCHEDULE_API_URL=https://<tên miền quản trị>
   SCHEDULE_API_KEY=<khoá vừa tạo>
   ```
3. Khởi động lại bot. Trang **Hệ thống → Cấu hình bot** hiện *Đang chạy* sau khoảng một phút.

Từ đó:
- Bot nhận thông số ở **Cấu hình bot** (khoá bí mật như key Gemini, token Zalo, phiên đăng nhập Zalo **không bao giờ** lên web; chúng chỉ nằm trên máy chạy bot, và bot cũng từ chối nhận nếu có ai gửi xuống).
- Bot gửi nhịp tim mỗi phút và gửi session (tắt được ở **Cấu hình bot → Session**, vì việc này đưa nội dung chat lên Upstash; mặc định giữ 14 ngày).
- Trong nhóm: "roemnao giao @An @Bình họp 9h mai", "dời cuộc họp lúc nãy sang 10h", "huỷ cuộc họp lúc nãy". Xem README của PyloS.

API cho agent (xác thực `Authorization: Bearer <khoá>`; mô tả OpenAPI ở `/api/agent/openapi.json`):

| API | Việc |
|---|---|
| `POST /api/agent/zalo-link` `{code, zaloUid, zaloName}` | liên kết Zalo của người gửi mã với Gmail của họ |
| `POST /api/agent/assign` `{title, start, end?, allDay?, note?, assignees:[{zaloUid, name}], source}` | giao lịch: lệnh *thêm* cho từng người đã liên kết; trả `{eventId, assigned, unlinked, appUrl}` |
| `PATCH /api/agent/assign/:id` `{…, assignees? \| add? \| remove?}` | sửa: người đã nhận được lệnh *sửa*, người mới nhận *thêm*, người bị bỏ nhận *xoá* |
| `DELETE /api/agent/assign/:id` | huỷ: lệnh *xoá* cho mọi người đã nhận |
| `GET /api/agent/assign/:id` | tình trạng: ai đã liên kết, app của ai đã lấy lệnh |
| `GET /api/agent/config`, `POST /api/agent/heartbeat` | thông số bot, nhịp tim (trả cấu hình mới nếu có) |
| `POST /api/agent/sessions` `{events:[…]}` | session bộ lọc ↔ agent |
| `POST /api/agent/message`, `GET /api/agent/agenda`, `POST /api/agent/events`, `GET/POST /api/agent/tasks`, `PATCH /api/agent/tasks/:id` | lịch riêng của chủ web (như trước) |

## 🛡️ Dữ liệu và điều khoản
- **Lưu ở đâu:** Upstash Redis của chủ web. Mỗi người một khoá riêng; hàng lệnh 30 ngày; log bot lịch và lịch đã giao 90 ngày; session mặc định 14 ngày (tối đa 90); hồ sơ tới khi người dùng xoá tài khoản.
- **Web app** chỉ có các API của chính người đăng nhập (`/api/me…`): xem hồ sơ, lấy mã Zalo, gỡ Zalo, lấy lệnh mới, đồng ý điều khoản, xoá tài khoản. Không có API liệt kê, tìm kiếm, hay ghi lịch ngược lên.
- **Điều khoản dịch vụ** (`/terms.html`) và **Chính sách quyền riêng tư** (`/privacy.html`) là **bản mẫu**, không phải tư vấn pháp lý: hãy đọc và sửa cho đúng cách bạn vận hành. Khi sửa, đổi số phiên bản trong hai trang và `TERMS_VERSION` trong `src/members.js` (có kiểm thử bắt hai chỗ phải khớp) để mọi người được hỏi đồng ý lại.

## 🤖 Dùng chung bot Zalo với AI agent khác
Mỗi bot Zalo chỉ có **một** địa chỉ nhận tin (webhook). Nếu bot nhắc việc của web đang gắn với một AI agent khác (n8n, Make, bot tự viết…):
1. Vào **Cài đặt → Bot Zalo → Ai nhận tin nhắn của bot?**, chọn **AI agent của tôi**. Web sẽ **chỉ gửi** nhắc việc và tóm tắt, không giành webhook của agent.
2. Nhập ID Zalo của bạn để nhận nhắc việc. Hoặc để agent chuyển tin `/ketnoi <mã>` kèm `chatId` sang `POST /api/agent/message`.

## 💻 Chạy trên máy
Cần Node.js ≥ 20.12.
```bash
npm install
cp .env.example .env     # điền GEMINI_API_KEY, ZALO_BOT_TOKEN
npm start                # quản trị: http://localhost:3000, web app: http://localhost:3000/app/
                         # thử hai tên miền: đặt APP_HOST=app.localhost, web app ở http://app.localhost:3000
npm test                 # kiểm thử
npm run test:e2e         # kiểm thử web app bằng trình duyệt thật (cần Playwright + Chromium), Google giả lập
```
Trên máy, dữ liệu lưu ở `data/db.json` và `data/kv.json`. Bot Zalo nhắc việc chạy ở chế độ `polling`, nên không cần tên miền.

> ⚠️ **Không bao giờ commit key vào repo.** Key chỉ nằm trong `.env` trên máy hoặc trong Environment Variables của Vercel.

## Biến môi trường khác
| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `APP_PASSWORD` | Đăng nhập trang quản trị bằng mật khẩu đặt sẵn, thay cho tài khoản tạo trên web | trống |
| `ADMIN_USERNAME` | Tên đăng nhập đi kèm `APP_PASSWORD` | trống |
| `GEMINI_MODEL` | Model Gemini để web tự trích lịch (không phải model của bot Zalo) | `gemini-3.1-flash-lite` |
| `APP_TIMEZONE` | Múi giờ | `Asia/Ho_Chi_Minh` |
| `CRON_SECRET` | Bảo vệ `/api/cron` (cron-job.org gọi `/api/cron?key=...`) | trống |
| `ZALO_WEBHOOK_SECRET` | Chuỗi bí mật webhook | tự sinh từ token |
| `ZALO_CHAT_ID` | Cố định người nhận nhắc việc | dùng tài khoản đã `/ketnoi` |
| `SYNC_INTERVAL_MINUTES` | Khoảng cách giữa các lần đồng bộ nguồn | 30 |
| `REMIND_BEFORE_MINUTES` | Nhắc trước sự kiện bao nhiêu phút | 15 |
| `DAILY_SUMMARY_HOUR` | Giờ gửi tóm tắt (để trống để tắt) | 7 |
| `APP_HOST` | Tên miền riêng của web app (vd `iforgotmywayhome.vercel.app`); mọi tên miền khác là trang quản trị | trống: dùng chung một tên miền |
| `KV_PREFIX` | Tiền tố khoá trong Redis (khi nhiều web dùng chung một Upstash) | `qltg:` |

## Cấu trúc
```
api/index.js         điểm vào trên Vercel
server.js            chạy trên máy (polling Zalo + cron mỗi phút)
src/app.js           API Express: quản trị, thành viên (/api/me), agent (/api/agent), Google; chọn trang theo tên miền
src/kv.js            kho khoá–giá trị (Upstash Redis hoặc file JSON) cho dữ liệu nhiều người
src/members.js       thành viên: đăng nhập Gmail, điều khoản, mã liên kết Zalo, hàng lệnh một chiều
src/calbot.js        bot lịch: giao / sửa / huỷ lịch cho người được tag
src/calbot-log.js    log bot lịch (90 ngày, CSV)
src/system.js        cấu hình bot Zalo, nhịp tim, session bộ lọc ↔ agent
src/auth.js          tài khoản quản trị (mật khẩu băm scrypt, phiên đăng nhập)
src/google.js        đăng nhập Google, đồng bộ Google Lịch của chủ web
src/db.js            dữ liệu của chủ web (lịch, việc, đề xuất…)
src/storage.js       Upstash Redis (REST, pipeline) hoặc file JSON
src/gemini.js, sources.js, zalo.js, cron.js, time.js, config.js
views/admin.html     trang quản trị; views/app.html: web app (gửi từ Express để chọn đúng theo tên miền)
public/theme.css     giao diện chung iforgotmywayhome (+ theme.js: sáng/tối, fonts/: font tự lưu)
public/admin/        JS, CSS của trang quản trị (admin.js, system.js: mục Hệ thống, style.css)
public/app/          JS, CSS, biểu tượng của web app (app.js, sync.js: ghi Google Lịch); public/sw.js: chạy offline
public/terms.html, privacy.html   điều khoản, chính sách (bản mẫu)
test/                kiểm thử: npm test; test/e2e: npm run test:e2e
```

## Giới hạn
- Không đẩy thông báo khi app đang đóng (chưa có Web Push): lịch được ghi khi app mở lại.
- Không đồng bộ ngược từ Google Lịch (cố ý: luồng là một chiều). Người dùng tự xoá lịch trên Google thì lần sửa sau của người giao sẽ tạo lại.
- Quá 100 người dùng cần gửi Google xác minh quyền `calendar.events`.
- Gói miễn phí của Upstash có giới hạn số lệnh mỗi tháng. App chỉ tốn một lệnh mỗi lần hỏi khi không có gì mới (mỗi phút khi đang mở); nhịp tim của bot tốn khoảng 3.000 lệnh/ngày.
