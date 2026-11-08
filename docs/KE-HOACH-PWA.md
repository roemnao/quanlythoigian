# Kế hoạch: cài web thành ứng dụng trên điện thoại (PWA)

> Mục tiêu: người dùng bấm một nút trong web là có icon **iforgotmywayhome** trên màn hình chính, mở toàn màn hình như app thật
> (giống chess.com trên Chrome). Không cần đưa lên CH Play hay App Store.

## 0. Hiện trạng (đã có sẵn trong repo)

| Thành phần | Nơi | Tình trạng |
|---|---|---|
| Manifest | `src/app.js` (route `/manifest.webmanifest`), `vercel.json` rewrite tới hàm | Có `name`, `short_name`, `start_url`, `scope`, `display: standalone`, màu, icon 192/512/maskable/svg |
| Liên kết manifest, icon iOS | `views/app.html` | Có `<link rel="manifest">`, `apple-touch-icon`, `apple-mobile-web-app-title`, `theme-color` |
| Service worker | `public/sw.js`, đăng ký ở `public/app/main.js` (cuối file) | Lưu khung giao diện, mạng trước rồi mới tới bản lưu, không bao giờ lưu `/api` |
| HTTPS | Vercel | Có |
| CSP | `views/app.html` có `manifest-src`, `worker-src`; `vercel.json` dùng `default-src 'self'` | Cho phép manifest và service worker |

Vậy là **Chrome đã cho cài qua menu ⋮ → "Cài đặt ứng dụng"**. Cái còn thiếu là: người dùng không biết có tính năng này,
iPhone không có hướng dẫn, manifest chưa đủ để Chrome hiện hộp cài đặt đẹp, và chưa kiểm tra đăng nhập Google khi chạy dạng app.

## 1. Việc cần làm

### Giai đoạn A: manifest và thẻ meta đầy đủ (khoảng 1–2 giờ)

File: `src/app.js`, `views/app.html`, ảnh mới trong `public/app/`.

1. Thêm vào manifest:
   - `id: '/'`: định danh cố định của app. Thiếu thì Chrome lấy `start_url`, đổi `start_url` về sau sẽ thành app khác.
   - `start_url: '/?source=pwa'`: để phân biệt lượt mở từ icon (tuỳ chọn, phải giữ `scope: '/'`).
   - `orientation: 'any'`, `categories: ['productivity']`, `dir: 'ltr'`.
   - `screenshots`: ít nhất 1 ảnh điện thoại (`form_factor: 'narrow'`, vd 1080x1920) và 1 ảnh máy tính (`form_factor: 'wide'`,
     vd 1920x1080). Có ảnh thì Chrome Android hiện **hộp cài đặt lớn có ảnh** thay cho thanh nhỏ. Chụp bằng
     `SHOTS_DIR=... npm run test:e2e` (đã có sẵn), lưu vào `public/app/screenshot-narrow.png`, `screenshot-wide.png`.
   - `shortcuts` (nhấn giữ icon): "Thêm lịch" → `/#/lich`, "Công việc" → `/#/cong-viec`, "Đề xuất" → `/#/de-xuat`.
     Cần icon 96x96 cho từng lối tắt (hoặc dùng chung `icon-192.png`).
2. `views/app.html`:
   - Thêm `<meta name="mobile-web-app-capable" content="yes">` và `<meta name="apple-mobile-web-app-capable" content="yes">`.
   - `<meta name="apple-mobile-web-app-status-bar-style" content="default">` (không dùng `black-translucent` vì sẽ phải tự chừa chỗ
     cho thanh trạng thái).
   - `theme-color` theo nền: hai thẻ có `media="(prefers-color-scheme: light)"` / `dark`, và `theme.js` cập nhật thẻ khi người dùng
     bấm nút sáng/tối (web mặc định nền tối, không theo hệ điều hành).
3. Kiểm tra icon maskable: mở https://maskable.app với `icon-maskable-512.png`, biểu tượng phải nằm trong vùng an toàn (hình tròn 80%).

**Xong khi:** Chrome DevTools → Application → Manifest không có cảnh báo; Lighthouse mục "Installable" đạt.

### Giai đoạn B: nút "Cài ứng dụng" trong web (khoảng nửa ngày)

File mới `public/app/install.js` (import từ `main.js`), sửa `views/app.html`, `public/app/app.css`.

1. **Android / máy tính (Chrome, Edge, Samsung Internet):**
   - Bắt sự kiện `beforeinstallprompt`, gọi `e.preventDefault()`, giữ lại sự kiện.
   - Hiện nút **"Cài ứng dụng"** (icon tải xuống `#i-download` đã có) ở: chân thanh bên (máy tính), ngăn "Thêm" (điện thoại),
     và màn hình đăng nhập.
   - Bấm nút → `deferred.prompt()`, chờ `userChoice`; người dùng từ chối thì ẩn nút trong 14 ngày (lưu `localStorage`, bọc try/catch).
   - Sự kiện `appinstalled` → ẩn nút, hiện toast "Đã cài ứng dụng".
2. **iPhone / iPad (Safari):** không có `beforeinstallprompt`.
   - Nhận diện iOS Safari và chưa chạy dạng app (`navigator.standalone !== true`).
   - Hiện một dòng nhắc có thể đóng: "Cài app: bấm nút Chia sẻ rồi chọn **Thêm vào Màn hình chính**", kèm hình nút Chia sẻ (SVG).
   - Trên iOS mà mở bằng Chrome/Firefox (`CriOS`, `FxiOS`): nhắc "mở bằng Safari để cài" (iOS 16.4+ có cho Chrome thêm vào màn hình
     chính nhưng không ổn định giữa các bản).
3. **Đã chạy dạng app** (`matchMedia('(display-mode: standalone)')` hoặc `navigator.standalone`): không hiện gì cả.
4. Không làm phiền: chỉ hiện nhắc sau khi người dùng đã đăng nhập và mở web ít nhất 2 lần (đếm trong `localStorage`).

**Xong khi:** Android thấy nút → bấm → hộp cài của Chrome hiện ra; iPhone thấy dòng hướng dẫn; mở từ icon thì không còn nút.

### Giai đoạn C: service worker (khoảng 2–3 giờ)

File: `public/sw.js`, `public/app/main.js`.

1. **Đổi `CACHE` lên `ifmwh-app-v5`**: bản responsive (commit 972df4c) đã đổi `app.css` và `main.js`. Hiện tại sw.js lấy mạng trước nên
   vẫn ra bản mới, nhưng tăng số để máy đã cài xoá bộ nhớ cũ.
2. Thêm vào `SHELL`: `icon-192.png` và các font `be-vietnam-pro-vietnamese-*.woff2`, `cormorant-garamond-vietnamese-600-normal.woff2`
   để lần mở đầu khi mất mạng không bị đổi font.
3. **Báo có bản mới:** khi service worker mới cài xong (`registration.onupdatefound` → `installing.state === 'installed'` và đã có
   `controller`), hiện toast "Có bản mới · Tải lại". Hiện tại `skipWaiting()` + `clients.claim()` làm trang đang mở đổi service
   worker giữa chừng; giữ như vậy nhưng tải lại trang khi người dùng bấm.
4. **Mất mạng:** thêm banner nhỏ "Đang ngoại tuyến, dữ liệu có thể chưa mới" theo `navigator.onLine` và sự kiện `online`/`offline`.
   Không lưu dữ liệu `/api` (giữ nguyên nguyên tắc hiện tại: dữ liệu luôn từ máy chủ).
5. **Cập nhật định kỳ:** gọi `registration.update()` khi app được mở lại (`visibilitychange` → `visible`), vì app cài trên điện thoại
   có thể chạy nhiều ngày không tải lại.

### Giai đoạn D: chạy dạng app (standalone) cho đúng (khoảng nửa ngày, phần lớn là thử)

1. **Đăng nhập Google trong app đã cài: rủi ro lớn nhất, phải thử trước.**
   - Luồng hiện tại: nút dẫn tới `/api/google/start` → `accounts.google.com` → quay về `/api/google/callback` → đặt cookie
     `qltg_member` → về `/`.
   - **Android:** trang ngoài `scope` (accounts.google.com) mở trong khung Chrome Custom Tab, cookie dùng chung với Chrome, quay về
     callback thì trở lại app. Thường chạy được, cần xác nhận.
   - **iOS:** app cài từ Safari có **kho cookie riêng**, khác Safari. Trang Google mở trong app và quay về callback vẫn trong app thì
     cookie được đặt đúng chỗ. Nếu bị bật ra Safari thì cookie nằm ở Safari, app vẫn chưa đăng nhập. Cần thử trên iPhone thật;
     nếu lỗi thì phương án: sau callback chuyển hướng về `/?signedin=1` bằng `location.replace`, hoặc đăng nhập bằng popup.
   - Cookie `qltg_member` đã có hạn 180 ngày (`src/app.js`, `maxAge`), không phải cookie phiên, nên không bị iOS xoá khi tắt app.
     Giữ nguyên như vậy.
2. **Liên kết ngoài** (`/privacy.html`, `/terms.html` cùng `scope` nên mở trong app; link Zalo, Google Lịch thì mở ngoài):
   đặt `target="_blank" rel="noopener"` cho link ra tên miền khác.
3. **Thanh trạng thái / tai thỏ:** đã có `viewport-fit=cover` và `env(safe-area-inset-bottom)` cho thanh đáy. Thêm
   `padding-top: env(safe-area-inset-top)` cho `.main` khi `@media (display-mode: standalone)`.
4. **Không có nút Back của trình duyệt** (iOS): web dùng `location.hash` cho từng mục nên cử chỉ vuốt lùi vẫn chạy; kiểm tra hộp thoại
   `dialog` đóng được bằng nút X (không chỉ bằng Back).
5. `PRIMARY_HOST`: app chỉ cài từ tên miền chính. Nếu người dùng cài từ tên miền phụ (bị chuyển hướng) thì `scope` lệch. Kiểm tra
   chuyển hướng tên miền xảy ra **trước** khi trình duyệt đọc manifest.

### Giai đoạn E: kiểm thử (khoảng nửa ngày)

1. **Tự động** (`test/e2e/app.e2e.mjs`):
   - `/manifest.webmanifest` trả đúng `application/manifest+json`, có `id`, `display`, icon 192 và 512, có `screenshots`.
   - `/sw.js` tải được, đăng ký được (`navigator.serviceWorker.ready` trong ngữ cảnh không chặn service worker).
   - Giả lập sự kiện `beforeinstallprompt` → nút "Cài ứng dụng" hiện; giả lập `display-mode: standalone` → nút ẩn.
   - Ngoại tuyến (`context.setOffline(true)`) sau lần tải đầu: trang `/` vẫn mở, banner "ngoại tuyến" hiện.
2. **Lighthouse** (Chrome DevTools, chế độ Mobile): mục PWA/Installable đạt.
3. **Thiết bị thật** (bắt buộc, giả lập không thay được):

   | Thiết bị | Kiểm tra |
   |---|---|
   | Android + Chrome | Nút cài → hộp cài có ảnh → icon trên màn hình chính → mở toàn màn hình → đăng nhập Google → nhấn giữ icon thấy lối tắt |
   | iPhone + Safari (iOS 17+) | Dòng hướng dẫn → Thêm vào Màn hình chính → mở app → đăng nhập Google có giữ được không → tắt app mở lại vẫn đăng nhập |
   | Máy tính Chrome/Edge | Biểu tượng cài trên thanh địa chỉ, mở cửa sổ riêng |
   | Sau khi deploy bản mới | App đã cài hiện toast "Có bản mới" và tải lại ra giao diện mới |

## 2. Thứ tự làm và thời gian

| Thứ tự | Việc | Ước lượng |
|---|---|---|
| 1 | D.1 thử đăng nhập Google trên Android và iPhone **bằng bản hiện tại** (cài qua menu) | 1 giờ |
| 2 | A manifest + meta + ảnh chụp | 1–2 giờ |
| 3 | C service worker (đổi v5 làm ngay cùng bước 2) | 2–3 giờ |
| 4 | B nút cài + hướng dẫn iOS | nửa ngày |
| 5 | D.2–D.5 | 2–3 giờ |
| 6 | E kiểm thử, deploy Preview trên Vercel, thử thiết bị thật, rồi Production | nửa ngày |

Tổng: khoảng 2 ngày. Bước 1 làm đầu tiên vì nếu đăng nhập Google hỏng trên iOS thì phải đổi cách đăng nhập trước khi khuyến khích
mọi người cài app.

## 3. Không làm trong đợt này

- **Thông báo đẩy (Web Push)** nhắc lịch: cần khoá VAPID, lưu đăng ký theo người dùng, cron gửi; iOS chỉ hỗ trợ khi đã cài app
  (16.4+). Để đợt sau; hiện đã có bot Zalo nhắc việc.
- **Dùng ngoại tuyến có dữ liệu** (xem/sửa lịch khi mất mạng rồi đồng bộ): phức tạp, dễ lệch với Google Lịch.
- **Đưa lên CH Play** bằng Trusted Web Activity (Bubblewrap): làm được sau khi PWA đạt, cần tài khoản Google Play (25 USD) và file
  `/.well-known/assetlinks.json`.
- **App Store:** Apple không nhận app chỉ bọc web.

## 4. Lỗi có thể gặp

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Menu Chrome không có "Cài đặt ứng dụng" | Manifest lỗi, thiếu icon 192/512, service worker chưa đăng ký, không phải HTTPS | DevTools → Application → Manifest xem cảnh báo |
| Cài xong mở ra vẫn có thanh địa chỉ | Trang bị chuyển hướng ra ngoài `scope` (vd sang tên miền khác) | Kiểm tra `PRIMARY_HOST`, `start_url`, `scope` |
| App đã cài vẫn hiện giao diện cũ | Chưa đổi `CACHE` trong `sw.js` | Tăng số phiên bản mỗi lần đổi giao diện |
| iPhone mở app phải đăng nhập lại | Cookie phiên bị xoá khi tắt app, hoặc đăng nhập xong ở Safari chứ không ở app | Cookie có `Max-Age`; xem D.1 |
| Icon bị cắt viền trên Android | Ảnh maskable có nội dung ngoài vùng an toàn | Làm lại `icon-maskable-512.png` với lề 10% |
