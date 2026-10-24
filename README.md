# ⏳ Quản lý thời gian

Web quản lý thời gian cá nhân. Web **tự lấy lịch từ các nguồn bạn đưa vào** (lịch ICS, trang web, văn bản), dùng **AI Gemini** để đọc nội dung, và có **bot Zalo** để nhắc việc. Chạy được trên **Vercel (miễn phí)** hoặc trên máy cá nhân.

## Tính năng
- **Tổng quan:** số liệu nhanh trong ngày, lịch trình hôm nay (có vạch "Bây giờ"), việc cần ưu tiên, 3 mục tiêu chính, Pomodoro dạng vòng tròn kèm thống kê 7 ngày.
- **Lịch** dạng **tháng** hoặc **tuần**. Bấm vào một ngày để xem chi tiết; thêm, sửa, xoá lịch trong khung sửa riêng (có tuỳ chọn cả ngày). Màu cho biết nguồn: tự thêm, từ AI/Zalo, đồng bộ ICS, hạn chót việc.
- **Công việc** theo ma trận Eisenhower, có hạn chót, ghi chú và danh sách việc đã xong.
- **Đề xuất:** AI đọc email, tin nhắn hay thông báo và trích ra lịch hẹn, việc cần làm. Bạn sửa rồi duyệt; mục trùng tự bị bỏ.
- **Nguồn tự động:**
  - Lịch ICS/iCal (Google Calendar, Outlook, thời khoá biểu): tự đồng bộ, hỗ trợ sự kiện lặp lại.
  - Trang web: AI chỉ đọc lại khi nội dung thay đổi.
- **Bot Zalo:** gửi nội dung để tạo lịch; lệnh `/homnay`, `/mai`, `/viec`, `/cho`, `/duyet`. Bot nhắc trước mỗi lịch hẹn và gửi tóm tắt lúc 7h sáng. Bot **chỉ phục vụ tài khoản đã ghép nối** bằng mã lấy trên web.
- **Đưa lịch lên điện thoại:** có link `.ics` riêng, có khoá bí mật, để đăng ký vào Google Calendar hoặc iPhone.
- **Tài khoản quản trị** tạo ngay trên web ở lần mở đầu tiên (mật khẩu được băm, không nằm trong code). Có đổi mật khẩu, giao diện tối và sáng, dùng tốt trên điện thoại.

## 🚀 Đưa lên Vercel
1. **Tạo project:** vào https://vercel.com/new, đăng nhập bằng GitHub, chọn repo `quanlythoigian` rồi bấm **Import**. Không cần đổi cài đặt build.
2. **Thêm biến môi trường** trước khi bấm Deploy (mục *Environment Variables*):

   | Tên | Giá trị |
   |---|---|
   | `GEMINI_API_KEY` | key Gemini (https://aistudio.google.com/apikey) |
   | `ZALO_BOT_TOKEN` | token bot Zalo |

   Bấm **Deploy**.
3. **Thêm nơi lưu dữ liệu (miễn phí):** trong project, vào tab **Storage**, chọn **Create Database**, chọn **Upstash for Redis** (gói Free), rồi **Connect** vào project. Sau đó vào tab **Deployments**, bấm **⋯** ở bản mới nhất và chọn **Redeploy**.
   > Web sẽ không cho tạo tài khoản khi chưa có bước này, vì nếu không có nơi lưu, tài khoản và dữ liệu sẽ mất mỗi khi Vercel khởi động lại.
4. **Tạo tài khoản quản trị:** mở web, nhập tên đăng nhập và mật khẩu ở màn hình **Chào mừng**. Người tạo đầu tiên là chủ web, nên hãy làm ngay sau khi deploy. Muốn đổi mật khẩu sau này: vào **Cài đặt**, mục **Tài khoản**.
5. **Kết nối Zalo:** vào **Cài đặt**:
   - Bấm **Kết nối webhook** (chỉ cần làm 1 lần).
   - Bấm **Lấy mã ghép nối**, mở Zalo rồi nhắn cho bot `/ketnoi <mã>`.
   - Bấm **Gửi tin thử** để kiểm tra.
6. **Nhắc trước giờ hẹn (tuỳ chọn):** gói miễn phí của Vercel chỉ chạy cron **1 lần/ngày** (7h sáng: đồng bộ nguồn và gửi tóm tắt). Muốn được nhắc 15 phút trước mỗi lịch, tạo tác vụ miễn phí tại https://cron-job.org gọi địa chỉ `https://<tên-web>.vercel.app/api/cron` **mỗi 5 phút**. Địa chỉ này có sẵn trong mục Cài đặt để sao chép.

Từ đó, mỗi lần có code mới đẩy lên nhánh chính của repo, Vercel sẽ tự deploy lại.

## 🔑 Đăng nhập bằng Gmail & Google Lịch
Web có thể: **tạo tài khoản / đăng nhập bằng Google**, **liên kết Gmail** vào tài khoản có sẵn, và **đồng bộ 2 chiều với Google Lịch** (lịch Google hiện trên web; lịch tạo trên web, kể cả từ AI/Zalo, tự lên Google Lịch).

Cần một OAuth Client miễn phí của Google:
1. Vào https://console.cloud.google.com, tạo project và bật **Google Calendar API**.
2. Vào **Google Auth Platform**, điền tên ứng dụng và email, chọn **External**. Ở mục **Audience**, bấm **Publish app**. Nếu để chế độ *Testing*, Google sẽ ngắt kết nối lịch sau 7 ngày. Khi đăng nhập, Google có thể cảnh báo "ứng dụng chưa được xác minh": bấm **Nâng cao** rồi **Tiếp tục** (đây là ứng dụng của chính bạn).
3. Vào **Clients**, chọn **Create client**, loại **Web application**. Ở **Authorized redirect URIs**, dán `https://<tên-web>.vercel.app/api/google/callback`; địa chỉ này có sẵn trong Cài đặt → Khoá API → Google để sao chép.
4. Dán **Client ID** và **Client secret** vào **Cài đặt → Khoá API → Google**, rồi bấm Lưu.
5. Trong **Cài đặt**:
   - **Tài khoản → Liên kết với Gmail**: sau đó đăng nhập được bằng nút "Đăng nhập bằng Google".
   - **Google Lịch → Kết nối Google Lịch**: chọn lịch muốn hiện và bật/tắt việc tự đưa lịch lên Google.

Lịch kéo từ Google chỉ xem được trên web; muốn sửa, hãy sửa trên Google Lịch. Web chỉ đồng bộ từ 7 ngày trước đến 90 ngày tới.

## 🤖 Dùng chung bot Zalo với AI agent khác
Mỗi bot Zalo chỉ có **một** địa chỉ nhận tin (webhook). Nếu bot đang gắn với một AI agent khác (n8n, Make, bot tự viết…), làm như sau:
1. Vào **Cài đặt → Bot Zalo → Ai nhận tin nhắn của bot?**, chọn **AI agent của tôi**. Web sẽ **chỉ gửi** nhắc việc và tóm tắt (gửi tin không xung đột), không giành webhook của agent.
2. Nhập ID Zalo của bạn để nhận nhắc việc. Hoặc để agent chuyển tin `/ketnoi <mã>` kèm `chatId` sang API bên dưới.
3. Vào **Kết nối AI agent → Tạo khoá cho agent**. Cho agent gọi API với header `Authorization: Bearer <khoá>`:
   - `POST /api/agent/message` `{text, chatId}`: xử lý tin nhắn/lệnh y như bot, trả về `{reply}` để agent gửi lại.
   - `GET /api/agent/agenda?date=today|tomorrow|YYYY-MM-DD`
   - `POST /api/agent/events`, `GET/POST /api/agent/tasks`, `PATCH /api/agent/tasks/:id`
   - Mô tả đầy đủ (OpenAPI) để nạp làm công cụ: `/api/agent/openapi.json`

## 💻 Chạy trên máy
Cần Node.js ≥ 20.12.
```bash
npm install
cp .env.example .env     # điền GEMINI_API_KEY, ZALO_BOT_TOKEN
npm start                # mở http://localhost:3000
```
Trên máy, dữ liệu lưu ở `data/db.json`. Bot Zalo chạy ở chế độ `polling`, nên không cần tên miền. Hệ thống tự kiểm tra mỗi phút để đồng bộ và nhắc việc.

> ⚠️ **Không bao giờ commit key vào repo** (repo đang công khai). Key chỉ nằm trong `.env` trên máy hoặc trong Environment Variables của Vercel.

## Biến môi trường khác
| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `APP_PASSWORD` | Đăng nhập bằng mật khẩu đặt sẵn, thay cho tài khoản tạo trên web | trống |
| `ADMIN_USERNAME` | Tên đăng nhập đi kèm `APP_PASSWORD` | trống |
| `GEMINI_MODEL` | Model Gemini | `gemini-3.1-flash-lite` |
| `APP_TIMEZONE` | Múi giờ | `Asia/Ho_Chi_Minh` |
| `CRON_SECRET` | Bảo vệ `/api/cron` (cron-job.org gọi `/api/cron?key=...`) | trống |
| `ZALO_WEBHOOK_SECRET` | Chuỗi bí mật webhook | tự sinh từ token |
| `ZALO_CHAT_ID` | Cố định người nhận nhắc việc | dùng tài khoản đã `/ketnoi` |
| `SYNC_INTERVAL_MINUTES` | Khoảng cách giữa các lần đồng bộ nguồn | 30 |
| `REMIND_BEFORE_MINUTES` | Nhắc trước sự kiện bao nhiêu phút | 15 |
| `DAILY_SUMMARY_HOUR` | Giờ gửi tóm tắt (để trống để tắt) | 7 |

## Cấu trúc
```
api/index.js       điểm vào trên Vercel
server.js          chạy trên máy (polling Zalo + cron mỗi phút)
vercel.json        cấu hình Vercel (rewrite, cron hằng ngày)
src/app.js         API Express + đăng nhập
src/auth.js        tài khoản quản trị (băm mật khẩu scrypt, phiên đăng nhập)
src/google.js      đăng nhập Google, đồng bộ Google Lịch
src/config.js      khoá API nhập trên web / biến môi trường
src/storage.js     lưu dữ liệu: Upstash Redis hoặc file JSON
src/db.js          dữ liệu, chống trùng, hàng chờ đề xuất
src/gemini.js      gọi Gemini để trích lịch từ văn bản
src/sources.js     đồng bộ nguồn ICS / trang web
src/zalo.js        bot Zalo (lệnh, ghép nối, webhook, polling)
src/cron.js        đồng bộ định kỳ, nhắc việc, tóm tắt buổi sáng
public/            giao diện (HTML/CSS/JS thuần)
test/              kiểm thử: npm test
```
