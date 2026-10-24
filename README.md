# ⏳ Quản lý thời gian

Web quản lý thời gian cá nhân, có khả năng **tự lấy lịch từ các nguồn bạn đưa vào** và một **bot Zalo** để nhắc việc.

## Tính năng
- **Hôm nay:** đặt 3 mục tiêu chính, xem lịch trong ngày và các việc đến hạn hoặc quá hạn.
- **Pomodoro:** hẹn giờ có thể tuỳ chỉnh, có âm báo và thông báo, kèm thống kê số phiên tập trung trong 7 ngày.
- **Việc cần làm** chia theo ma trận Eisenhower (4 ô: Làm ngay, Lên lịch, Nhờ/làm nhanh, Bỏ/để sau).
- **Lịch tuần:** thêm và xoá lịch hẹn.
- **Tự động lấy lịch từ các nguồn:**
  - **Lịch ICS/iCal** (Google Calendar, Outlook, thời khoá biểu…): đồng bộ định kỳ và đưa thẳng vào lịch, hỗ trợ cả sự kiện lặp lại.
  - **Trang web:** tải trang về, nếu nội dung có thay đổi thì Gemini đọc và tạo đề xuất.
  - **Dán văn bản** (email, tin nhắn, thông báo…): Gemini trích ra lịch hẹn và việc cần làm.
- **Hàng chờ đề xuất:** mọi thứ AI tìm được đều nằm ở đây để bạn sửa rồi duyệt. Hệ thống tự bỏ các mục trùng.
- **Bot Zalo:** gửi nội dung cho bot để tạo lịch; tra cứu bằng lệnh `/homnay`, `/mai`, `/viec`, `/cho`, `/duyet`; tự nhắc trước mỗi sự kiện và gửi tóm tắt buổi sáng.
- **Xuất lịch:** `/calendar.ics` chứa các lịch tạo trên web (dùng được khi không đặt `APP_PASSWORD`, vì ứng dụng lịch không nhập được mật khẩu).

## Cài đặt & chạy
Cần Node.js ≥ 20.12.

```bash
npm install
cp .env.example .env     # rồi điền các khoá bên dưới
npm start                # mở http://localhost:3000
```

Dữ liệu được lưu trong `data/db.json`. File này đã được đưa vào `.gitignore`, nên không bị đẩy lên GitHub.

## Cấu hình khoá (`.env`)
> ⚠️ Không commit file `.env`. Khoá chỉ nằm trên server, trình duyệt không bao giờ thấy.

### Gemini (miễn phí)
1. Vào https://aistudio.google.com/apikey và tạo API key.
2. Điền vào `GEMINI_API_KEY=`. Có thể đổi model qua `GEMINI_MODEL` (mặc định `gemini-2.5-flash`).

Lưu ý: gói miễn phí giới hạn số lượt gọi, và Google có thể dùng dữ liệu gửi lên để cải thiện sản phẩm, nên tránh gửi thông tin nhạy cảm.

### Zalo Bot
1. Trong ứng dụng Zalo, tìm **"Zalo Bot Manager"** và tạo bot để lấy **Bot Token**.
2. Điền vào `ZALO_BOT_TOKEN=`.
3. Chọn cách nhận tin nhắn:
   - `ZALO_MODE=polling` (mặc định): server tự hỏi Zalo xem có tin mới không. Cách này chạy được ngay trên máy cá nhân.
   - `ZALO_MODE=webhook`: Zalo gọi vào server của bạn. Cần một URL **https công khai**. Đặt `ZALO_WEBHOOK_SECRET` (tự nghĩ một chuỗi ngẫu nhiên), khởi động server rồi đăng ký webhook:
     ```bash
     curl -X POST http://localhost:3000/api/zalo/webhook-setup \
       -H 'Content-Type: application/json' -d '{"baseUrl":"https://ten-mien-cua-ban"}'
     ```
4. Nhắn `/id` cho bot, sau đó điền ID nhận được vào `ZALO_CHAT_ID=` và khởi động lại server.
5. Vào tab **Nguồn & Bot** và bấm **"Gửi tin thử qua Zalo"** để kiểm tra.

Nếu Zalo đổi địa chỉ API thì sửa `ZALO_API_BASE`.

### Tuỳ chọn khác
| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `APP_PASSWORD` | Mật khẩu vào web (nên đặt khi đưa lên mạng) | trống = không cần |
| `TZ` | Múi giờ | `Asia/Ho_Chi_Minh` |
| `SYNC_INTERVAL_MINUTES` | Khoảng cách giữa các lần đồng bộ nguồn | 30 |
| `REMIND_BEFORE_MINUTES` | Nhắc trước sự kiện bao nhiêu phút | 15 |
| `DAILY_SUMMARY_HOUR` | Giờ gửi tóm tắt buổi sáng (để trống để tắt) | 7 |

## Lấy link ICS
- **Google Calendar:** Cài đặt, chọn lịch, mục *Tích hợp lịch*, chép **Địa chỉ bí mật ở định dạng iCal**.
- **Outlook:** Cài đặt, *Lịch được chia sẻ*, *Phát hành lịch*, chép link ICS.

## Cấu trúc
```
server.js          API + phục vụ web
src/db.js          lưu dữ liệu JSON, chống trùng, hàng chờ đề xuất
src/gemini.js      gọi Gemini để trích lịch từ văn bản
src/sources.js     đồng bộ nguồn ICS / trang web
src/zalo.js        bot Zalo (lệnh, webhook, polling)
src/scheduler.js   đồng bộ định kỳ, nhắc việc, tóm tắt buổi sáng
public/            giao diện (HTML/CSS/JS thuần)
test/              kiểm thử: npm test
```
