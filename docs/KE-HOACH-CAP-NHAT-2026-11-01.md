# Kế hoạch cập nhật 01/11/2026: tách PyloS, giao diện mới, web người dùng đầy đủ, phân quyền, Google Lịch tự động

> File này có **giống hệt nhau** ở hai repo: `roemnao/quanlythoigian` và `roemnao/PyloS` (thư mục `docs/`).
> Sửa ở repo nào thì chép sang repo kia.
>
> Đọc theo thứ tự: mục 0 → 1 → 2, rồi làm từng giai đoạn ở mục 3 (PyloS) và mục 4 (web). Mục 5 là thứ tự đưa lên
> production, mục 6 là kiểm thử toàn hệ thống, mục 7 là bảng lỗi có thể gặp.

Quy ước tên gọi trong file:

| Tên | Là gì |
|---|---|
| **web** / **bot lịch** | repo `quanlythoigian`, chạy trên Vercel. Tên miền app: `iforgotmywayhome.vercel.app`; tên miền quản trị cũ: `quanlythoigian-azure.vercel.app` |
| **PyloS** | repo `PyloS`: bot Zalo (Python) + trang quản lý bot (FastAPI, `127.0.0.1:8081` ở máy Windows, `https://unousgrowth.com` trên VPS) |
| **thành viên** | tài khoản Gmail trên web (`src/members.js`, khoá `user:<id>` trong Upstash) |
| **khoá agent** | `SCHEDULE_API_KEY` mà PyloS dùng để gọi `/api/agent/*` của web |

---

## 0. Mốc ban đầu (đã kiểm tra ngày 01/11/2026)

- Code lấy từ `main` mới nhất của cả hai repo:
  - `quanlythoigian` @ `17b807d` (Merge PR #5)
  - `PyloS` @ `634d475` (Merge PR #18)
- Nhánh làm việc: `claude/beautiful-ramanujan-wq6u6u` ở cả hai repo (đã đặt lại theo `origin/main`).
- Kiểm thử trước khi sửa:
  - web: `npm ci && npm test` → **42/42 qua**.
  - PyloS: `pip install -e ".[dev]" && pytest -q` → **268 qua, 2 bỏ qua, 2 lỗi**. Hai lỗi ở `tests/test_desktop.py` chỉ vì máy
    chạy thử thiếu `pillow` (nhóm `desktop`). Cài `pip install -e ".[dev,desktop]"` thì hết. **Không phải lỗi code.**

Mọi giai đoạn phía dưới phải giữ hai bộ kiểm thử này xanh (cộng các test mới).

---

## 1. Hiện trạng: những chỗ đang dính nhau và đang lỗi

### 1.1 PyloS đang phụ thuộc web ở những chỗ không liên quan tới giao lịch

| # | Chỗ dính | File PyloS | File web |
|---|---|---|---|
| A | **Đăng nhập Gmail vào trang quản lý bot**: PyloS xin mã ở web (`POST /api/agent/device-login`), người dùng mở web app `?device=<mã>` và bấm Cho phép, PyloS hỏi lại (`GET /api/agent/device-login/:mã`), web trả `isAdmin` = Gmail có trùng Gmail của tài khoản quản trị web không | `ui/admin/admin_web_server.py` (`/api/auth/gmail/start`, `/api/auth/gmail/poll`), `static/admin_page.js` (dòng ~1073–1137), `static/index.html` (`#gmail-login`) | `src/devicelogin.js`, `src/app.js` (`/api/agent/device-login*`, `/api/me/device-login/approve`), `public/app/app.js` (`renderDevice`) |
| B | **Kết nối VPS bằng Gmail** (máy Windows → VPS): đi qua đúng luồng A trên VPS, nên VPS cũng cần `SCHEDULE_API_KEY` | `admin_web_server.py` (`/api/remote-login/*`), `admin_page.js` (dòng ~368–430), `docs/vps-dieu-khien.md` | như A |
| C | **Cấu hình bot từ xa**: web giữ model, bộ lọc, giới hạn, quyền, SYSTEM.md, MEMORY.md…; PyloS hỏi mỗi phút và **đè** lên `settings.env` | `system/remote_config.py`, `command_line.py::_start_server_sync`, `admin_web_server.py` (import `REMOTE_KEYS`, `read_cached`), `admin_page.js` (nhãn `pill web` dòng ~983) | `src/system.js` (`CONFIG_SCHEMA`, `getConfig`, `saveConfig`, `configForBot`), `/api/agent/config`, `/api/admin/system`, tab "Cấu hình bot" |
| D | **Nhịp tim** mỗi phút (phiên bản, token hôm nay, lỗi gần nhất) | `remote_config.py::RemoteSync`, `command_line.py::_bot_status` | `/api/agent/heartbeat`, `system.js::heartbeat/botStatus` |
| E | **Gửi session** bộ lọc ↔ agent ↔ tool lên web | `system/session_upload.py`, `core/message_handler.py` (`_trace`, `_trace_reply`, `self.sessions`), `config.py` (`session_upload`) | `/api/agent/sessions`, `system.js` (session), tab "Session", `/api/admin/sessions*` |
| F | **Giao diện chung**: `theme.css` của PyloS là bản sao của web (ghi ở dòng 1), cùng tên "iforgotmywayhome", cùng biểu tượng đền, hoa văn meander | `static/theme.css`, `theme.js`, `index.html`, `admin_page.css`, `fonts/` | `public/theme.css` |

Phần **được giữ lại** (theo quyết định ở mục 2): PyloS gọi web để **giao / sửa / huỷ lịch** và **liên kết Zalo bằng mã 6 số**
(`core/message_handler.py` dòng ~222, `agent/tools/assign_events.py`, `agent/tools/schedule_web.py`, `system/server_client.py`).

### 1.2 Web có hai tên miền và hai kiểu tài khoản

- `src/app.js` dòng 44–61: `APP_HOST` tách "tên miền app" (thành viên, cookie `qltg_member`) và "tên miền quản trị"
  (tài khoản `username/mật khẩu` trong `store.data.auth.admin`, cookie `qltg_session`, hoặc `APP_PASSWORD`).
- Lịch, Công việc, Đề xuất, Nguồn, Pomodoro, mục tiêu… chỉ có **một bộ dữ liệu của chủ web** (`src/db.js`, khoá Redis
  `quanlythoigian:db`). Thành viên không có dữ liệu riêng nào ngoài hàng lệnh `cmds:<id>`.
- Web app thành viên (`views/app.html`, `public/app/app.js`) chỉ có: đăng nhập, liên kết Zalo, kết nối Google Lịch,
  lịch sử lệnh trên máy, xoá tài khoản.

### 1.3 Vì sao đồng bộ Google Lịch "mỗi giờ phải bấm lại, một lúc lại out"

Nguyên nhân (đã đọc code):

1. **Web app thành viên dùng Google Identity Services ở trình duyệt** (`public/app/app.js::requestToken`,
   `initTokenClient`). Cách này chỉ cho **access token sống ~1 giờ**, không có refresh token. Hết giờ là
   `applyPending()` nhận 401 → `forgetToken()` → hiện "Quyền ghi Google Lịch đã hết hạn" và nút **Cập nhật Google Lịch**.
   Người dùng thấy như bị "out".
2. **Chỉ ghi khi app đang mở**: `poll()` chạy bằng `setInterval` trong tab. Đóng tab là không ghi.
3. **Hai bước rời nhau**: đăng nhập Gmail (server, `purpose=member`, chỉ `openid email profile`) rồi lại bấm
   "Kết nối Google Lịch" (trình duyệt, scope `calendar.events`).
4. **Cron trên Vercel Hobby chỉ chạy 1 lần/ngày** (`vercel.json`: `"schedule": "0 0 * * *"`), nên đồng bộ 2 chiều của
   chủ web (`src/google.js::syncGoogle`) chỉ chạy khi có người mở web hoặc bấm "Đồng bộ".
5. Nếu OAuth consent screen của Google Cloud đang ở trạng thái **Testing**, mọi **refresh token hết hạn sau 7 ngày**
   (quy định của Google với app Testing có scope nhạy cảm). Phải kiểm tra trên Google Cloud (bước W0.3).

---

## 2. Quyết định đã chốt (hỏi lại người yêu cầu ngày 01/11/2026)

| Câu hỏi | Chốt |
|---|---|
| "Quản lý bot", "quản lý máy ảo" trên iforgotmywayhome là gì? | **Chỉ là của web**. *Quản lý bot* = bot lịch của web: nhật ký giao lịch, cài đặt bot lịch (tên bot, link chat, email được tạo tài khoản), bot Zalo nhắc việc của web, khoá agent. *Quản lý máy ảo* = hạ tầng của web: khoá API (Gemini, token Zalo, Google OAuth), lưu trữ Upstash, cron, tên miền. **PyloS và VPS chỉ quản lý ở trang riêng của PyloS** (giao diện vàng–đen). |
| Role **User** có gì? | **Chỉ chức năng sử dụng bình thường**: Tổng quan, Lịch, Công việc, Đề xuất, Nguồn, Tài khoản. Không thấy mục quản trị nào. |
| Giữ kết nối nào giữa PyloS và web? | **Chỉ API bot lịch** bằng một khoá `SCHEDULE_API_KEY`: giao / sửa / huỷ / xem lịch đã giao, liên kết Zalo bằng mã 6 số. **Bỏ**: cấu hình bot từ web, nhịp tim, gửi session, đăng nhập Gmail qua web, kết nối VPS qua web. |

Quyết định phụ do người lập kế hoạch đặt (có lý do, ai muốn đổi thì sửa ở đây trước khi làm):

- Tool `schedule_web.py` (bot thêm lịch / việc / xem lịch qua Zalo) **được giữ** vì là chức năng của bot lịch và dùng chung
  khoá agent. Sau khi web có dữ liệu riêng từng người (W2), các API này **ghi vào dữ liệu của chính người nhắn**
  (tìm thành viên theo `zaloUid`), không còn ghi vào dữ liệu chủ web.
- **Technician có đủ quyền "quản lý bot" và "quản lý máy ảo" như Owner** (đúng yêu cầu). Khác Owner duy nhất ở mục Tài khoản
  người dùng: chỉ xem, **mọi thao tác sửa tài khoản người khác (đổi quyền, gỡ Zalo, xoá) chỉ Owner làm được**.
- Bỏ hẳn tài khoản quản trị `username/mật khẩu` và `APP_PASSWORD`. Mọi người đăng nhập bằng Gmail. Đường cứu hộ khi mất
  quyền Owner: biến môi trường `OWNER_EMAILS` (xem W1).
- Link `.ics` (`/calendar.ics`) chỉ giữ cho Owner (giữ hành vi cũ), hiện trong mục Tài khoản của Owner.
- Bot Zalo nhắc việc của web (nhắc trước giờ, tóm tắt sáng) vẫn **chỉ nhắc cho Owner** như cũ (nó thuộc phần Cài đặt,
  người dùng thường không có). Không làm trong đợt này.

---

## 3. PyloS

Ba giai đoạn, mỗi giai đoạn một PR riêng vào `main` của PyloS. Làm **trước** web (lý do ở mục 5).

### P1. Tách PyloS khỏi web: chỉ còn API bot lịch

**Mục tiêu:** PyloS không gọi web cho bất kỳ việc gì ngoài `/zalo-link`, `/assign*` và các API lịch của `schedule_web.py`.

**Bước làm**

1. `src/bot/command_line.py`
   - Xoá `_start_server_sync()` và `_bot_status()`; xoá chỗ gọi `_start_server_sync(...)` trong hàm chạy bot
     (tìm `_start_server_sync(` để thấy). Không còn task `remote-config` và `sessions`.
2. Xoá file `src/bot/system/remote_config.py` và `src/bot/system/session_upload.py`.
3. `src/bot/core/message_handler.py`
   - Xoá thuộc tính `self.sessions`, hàm `_trace`, `_trace_reply` và mọi chỗ gọi `self._trace(...)` /
     `self._trace_reply(...)` (dùng `grep -n "_trace" src/bot/core/message_handler.py`).
   - Giữ `apply_settings()` (trang quản lý vẫn có thể dùng); sửa docstring: bỏ "thông số chủ hệ thống đổi trên web".
   - Sửa câu trả lời sau khi liên kết Zalo (dòng ~232): bỏ "(nhớ mở app để lịch được cập nhật)" vì sau W3 lịch tự ghi.
     Câu mới: `"✅ Đã liên kết Zalo này với tài khoản {who}. Từ giờ lịch được giao cho bạn trong nhóm sẽ tự vào Google Lịch của bạn."`
4. `src/bot/config.py`: xoá trường `session_upload` và dòng đọc `SESSION_UPLOAD`.
5. `src/bot/ui/admin/settings_file.py`
   - Xoá `FieldSpec("SESSION_UPLOAD", ...)`.
   - Đổi nhóm `"Web iforgotmywayhome"` thành `"Bot lịch (giao lịch qua web)"`; sửa mô tả `SCHEDULE_API_URL`:
     `"Địa chỉ web bot lịch, ví dụ https://iforgotmywayhome.vercel.app. Chỉ dùng để giao lịch và liên kết Zalo."`
   - `SECRETS["SCHEDULE_API_KEY"]` = `"Khoá agent của web bot lịch (chỉ để giao lịch)"`.
6. `src/bot/ui/admin/admin_web_server.py`
   - Bỏ `from bot.system.remote_config import REMOTE_KEYS, read_cached` và mọi chỗ dùng (tìm `read_cached`, `REMOTE_KEYS`,
     `"remote"`): API trả danh sách cài đặt không còn trường `remote`.
   - Xoá dòng `"SESSION_UPLOAD": ...` (dòng ~544).
   - **Tạm thời** để nguyên `/api/auth/gmail/*` (P2 thay bằng Google riêng). Nếu P1 và P2 gộp một PR thì làm luôn P2.
7. `src/bot/ui/admin/static/admin_page.js`: xoá nhãn `pill web` / biến `fromWeb` (dòng ~983–987).
8. `src/bot/userdata_paths.py`: xoá `REMOTE_CONFIG_FILE`. Thêm một lần dọn: khi bot khởi động, nếu còn
   `userdata/system/remote_config.json` thì **xoá** (để không ai tưởng còn dùng). Ghi log INFO một dòng.
9. `src/bot/system/server_client.py`: sửa docstring đầu file: chỉ dùng cho `/zalo-link`, `/assign`, `/assign/{id}`,
   `/events`, `/tasks`, `/agenda`, `/message`. Đổi `DEFAULT_URL` thành `https://iforgotmywayhome.vercel.app/api/agent`.
10. `src/bot/templates/env.example`: bỏ `SESSION_UPLOAD`; `SCHEDULE_API_URL=https://iforgotmywayhome.vercel.app`; sửa chú thích.
11. Tài liệu: `README.md` (mục "Nối với web…", cây thư mục dòng 32 và 60–61, bảng file dòng 474–475, dòng 448 nói "Trang quản
    trị web → Hệ thống → nhóm Quyền"), `docs/lenh-zalo.md`, `docs/PLAN.md` (mục 389): bỏ mọi chỗ nói cấu hình / nhịp tim /
    session / đăng nhập Gmail qua web. `ASSIGN_ALLOWED` từ nay **chỉ đặt ở trang Cài đặt của PyloS**.
12. Kiểm thử:
    - Xoá `tests/test_remote_config.py`.
    - `tests/conftest.py` (web giả dòng ~128): bỏ route `/config`, `/heartbeat`, `/sessions`, `/device-login*`.
    - `tests/test_admin.py`, `tests/test_schedule_tool.py`, `tests/test_assign_events.py`: sửa chỗ còn dùng các phần đã xoá.
    - **Test mới** `tests/test_no_web_coupling.py`:
      - Chạy bot giả với `SCHEDULE_API_KEY` đặt, web giả ghi lại mọi yêu cầu; gửi 1 tin thường + 1 tin giao lịch;
        assert chỉ có đường dẫn trong tập `{"/zalo-link", "/assign", "/assign/<id>", "/events", "/tasks", "/agenda", "/message"}`.
      - `grep` tĩnh: không file nào trong `src/` còn chứa `"/heartbeat"`, `"/sessions"`, `"/config"` gửi tới `server_client`,
        `"/device-login"`.

**Kiểm tra bằng tay**

1. Máy Windows: `.venv\Scripts\python.exe -m bot gateway restart`, xem `-m bot gateway logs -n 50`: không còn dòng
   "Kết nối web …: nhận cấu hình, nhịp tim mỗi phút".
2. Trong 5 phút, log không có yêu cầu nào tới `/api/agent/heartbeat` (trên Vercel → Logs, lọc `heartbeat`: không có yêu cầu mới).
3. Trong nhóm Zalo thử: "bot giao @A họp 9h mai" → vẫn giao được (web log bot lịch có dòng mới).
4. Nhắn riêng 6 số cho bot → vẫn liên kết được.
5. Đổi `GEMINI_MODEL` ở trang Cài đặt của PyloS → có hiệu lực, không bị web đè lại sau 1 phút.

**Lỗi có thể gặp**

| Hiện tượng | Nguyên nhân | Xử lý |
|---|---|---|
| Bot đổi model / quyền khác trước khi cập nhật | Trước đây giá trị từ web đè `settings.env`; giờ dùng lại giá trị trong `settings.env` | **Trước khi cập nhật**, mở web → Hệ thống → Cấu hình bot, chép mọi giá trị đang đặt (nhất là `GEMINI_MODEL`, `FILTER_MODEL`, `ASSIGN_ALLOWED`, `ALLOWED_CHAT_IDS`, `SYSTEM_MD`, `MEMORY_MD`) vào `settings.env` / file workspace của PyloS (máy Windows **và** VPS). File `userdata/system/remote_config.json` hiện có chính là bản đó, đọc để chép. |
| `ImportError: remote_config` khi chạy | Còn chỗ import sót | `grep -rn "remote_config\|session_upload" src tests` phải rỗng |
| Exe cũ (ZaloBot.exe) vẫn gửi nhịp tim | Chưa build lại exe | `scripts\build-exe.ps1` sau khi merge |

### P2. Đăng nhập Google riêng của PyloS

**Mục tiêu:** trang quản lý PyloS (máy Windows và VPS) đăng nhập bằng Google **qua OAuth client của chính PyloS**, không gọi
web. Ai được vào: danh sách `ADMIN_EMAILS` trong `settings.env`. Mã truy cập `ADMIN_TOKEN` vẫn giữ làm đường dự phòng.

**Chuẩn bị trên Google Cloud (chủ hệ thống làm một lần, ~10 phút)**

1. https://console.cloud.google.com → tạo **project mới** tên `PyloS Admin` (tách khỏi project của web để hai bên độc lập).
2. Google Auth Platform → **Branding**: App name `PyloS`, email hỗ trợ. **Audience**: External. Không cần thêm scope nào
   (chỉ dùng `openid email`, là scope không nhạy cảm, không cần Google xác minh).
   Nếu để trạng thái *Testing* thì thêm các Gmail quản trị vào *Test users*; hoặc bấm **Publish app** (không cần xác minh
   vì không có scope nhạy cảm).
3. **Clients → Create client → Web application**. *Authorized redirect URIs*:
   - `http://127.0.0.1:8081/api/auth/google/callback`
   - `http://localhost:8081/api/auth/google/callback`
   - `https://unousgrowth.com/api/auth/google/callback` (VPS; đúng giá trị `ADMIN_PUBLIC_URL`)
   - Nếu đổi cổng trang quản lý (khác 8081) thì thêm đúng cổng đó.
4. Chép **Client ID** và **Client secret**.

**Cấu hình mới trong `settings.env`** (máy Windows và VPS đều đặt):

```
ADMIN_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
ADMIN_GOOGLE_CLIENT_SECRET=GOCSPX-xxxx        # khoá bí mật: chỉ đặt mới, không hiện lại
ADMIN_EMAILS=chu.bot@gmail.com, ky.thuat@gmail.com
```

**Bước làm**

1. `src/bot/config.py`: thêm `admin_google_client_id: str`, `admin_google_client_secret: str`,
   `admin_emails: tuple[str, ...]` (tách bằng dấu phẩy / khoảng trắng, chữ thường).
2. `src/bot/ui/admin/settings_file.py`:
   - `FieldSpec("ADMIN_GOOGLE_CLIENT_ID", "Google Client ID của trang quản lý", group="Đăng nhập")`
   - `FieldSpec("ADMIN_EMAILS", "Gmail được vào trang quản lý", "Cách nhau dấu phẩy.", group="Đăng nhập")`
   - `SECRETS["ADMIN_GOOGLE_CLIENT_SECRET"] = "Google Client secret của trang quản lý"`
   - Kiểm tra định dạng giống web: Client ID phải khớp `^[\w-]+\.apps\.googleusercontent\.com$`.
3. File mới `src/bot/ui/admin/google_login.py` (không phụ thuộc FastAPI để test dễ):
   - `class PendingLogins`: dict trong bộ nhớ `code -> {state, verifier, status, email, device, expires}`; mã 32 ký tự hex
     (`secrets.token_hex(16)`), hết hạn 10 phút, tối đa 50 mã, khoá `threading.Lock`.
   - `auth_url(client_id, redirect_uri, state, challenge)`: `https://accounts.google.com/o/oauth2/v2/auth` với
     `response_type=code`, `scope=openid email`, `prompt=select_account`, `code_challenge`, `code_challenge_method=S256`.
   - `async exchange(code, verifier, redirect_uri, client_id, secret)`: POST `https://oauth2.googleapis.com/token` bằng `httpx`.
   - `decode_id_token(id_token, client_id)`: kiểm tra `aud == client_id`, `iss in {accounts.google.com, https://accounts.google.com}`,
     `exp` chưa qua, `email_verified` true (token nhận trực tiếp qua HTTPS từ Google nên không cần kiểm chữ ký; giống
     `quanlythoigian/src/google.js::decodeIdToken`).
   - `email_allowed(email, admin_emails)`: so khớp chữ thường, chính xác từng email.
4. `src/bot/ui/admin/admin_web_server.py` (thay khối `# ---------- đăng nhập bằng Gmail`):
   - `base_url()` = `ADMIN_PUBLIC_URL` nếu đặt, ngược lại `http://127.0.0.1:{port}`. `redirect_uri = base + "/api/auth/google/callback"`.
   - `GET /api/auth/options` → `{"google": bool(client_id and secret and admin_emails)}`.
   - `POST /api/auth/google/start` → tạo mã, trả `{"code", "url": base + "/api/auth/google/begin?code=<mã>", "expiresIn": 600}`.
   - `GET /api/auth/google/begin?code=` → 302 sang Google (`state = mã + "." + nonce`).
   - `GET /api/auth/google/callback?code=&state=` → đổi mã, kiểm email, đặt trạng thái `approved` / `denied`; trả **trang HTML
     tĩnh nhỏ** (không script, CSP như `SECURITY_HEADERS`): "Đã đăng nhập, quay lại trang quản lý" hoặc
     "Gmail … không có quyền vào trang này".
   - `POST /api/auth/google/poll {code, device?}` → giống `gmail_poll` cũ: `pending` / `expired` / `denied` / `ok` (+ `token`
     phiên 12 giờ từ `AdminSessions`, hoặc khoá thiết bị `AdminDevices.issue()` nếu có `device`). Mã đã `ok` chỉ đọc được 1 lần.
   - Xoá `/api/auth/gmail/start`, `/api/auth/gmail/poll`.
   - `/api/remote-login/start` và `/api/remote-login/poll`: đổi đường dẫn gọi VPS thành `auth/google/start`, `auth/google/poll`;
     sửa thông báo lỗi: "VPS cần đặt ADMIN_GOOGLE_CLIENT_ID, ADMIN_GOOGLE_CLIENT_SECRET và ADMIN_EMAILS".
   - Middleware `guard`: `/api/auth/*` vẫn không cần mã truy cập (đã có sẵn). Kiểm lại `begin` và `callback` là GET nên không bị
     chặn Origin.
5. `src/bot/ui/admin/static/admin_page.js` + `index.html`: đổi `gmail*` thành `google*`, gọi `/api/auth/google/start|poll`;
   chữ trên nút: "Đăng nhập bằng Google"; bỏ mọi chữ "web iforgotmywayhome"; tin nhắn: "Đã mở trang Google ở tab mới…".
6. Tài liệu: `README.md` mục "Giao diện quản lý (web)", `docs/vps-dieu-khien.md` mục "Kết nối từ máy Windows" và dòng
   "Điều kiện: VPS phải đặt SCHEDULE_API_KEY…" → thay bằng 3 biến mới.
7. Kiểm thử: viết lại `tests/test_gmail_connect.py` thành `tests/test_google_login.py`, dùng `httpx.MockTransport` giả Google:
   - start → begin trả 302 tới `accounts.google.com` có `code_challenge` và `state` chứa mã.
   - callback với email trong `ADMIN_EMAILS` → poll trả `ok` + token, poll lần 2 trả `expired`.
   - email ngoài danh sách → `denied`, không có token.
   - `state` sai / mã hết hạn (giả đồng hồ) / `id_token` sai `aud` / `email_verified=false` → bị từ chối.
   - `device` có giá trị → trả khoá thiết bị `dev_…`, lưu băm trong `admin_devices.json`.
   - Không yêu cầu nào đi tới `server_client` (web) trong suốt luồng.
   - Sửa `tests/test_admin.py` phần "đăng nhập bằng Gmail (web iforgotmywayhome làm chứng)" (dòng ~358).

**Kiểm tra bằng tay**

1. Máy Windows: điền 3 biến, `python -m bot admin start --open` → Đăng xuất → **Đăng nhập bằng Google** → tab Google mở,
   chọn Gmail trong danh sách → tab báo "Đã đăng nhập" → trang quản lý tự vào trong ≤ 4 giây.
2. Thử Gmail không có trong `ADMIN_EMAILS` → trang báo không có quyền, trang quản lý vẫn ở màn hình đăng nhập.
3. Xoá `SCHEDULE_API_KEY` khỏi `settings.env` → đăng nhập Google **vẫn chạy** (chứng minh đã tách khỏi web).
4. VPS: đặt 3 biến trên VPS, `systemctl restart pylos-admin`. Trên máy Windows → trang Máy chủ → **Kết nối VPS bằng Google** →
   đăng nhập ở `https://unousgrowth.com/...` → máy Windows nhận khoá thiết bị, công tắc **Máy này | VPS** hiện ra.
5. Mã truy cập `ADMIN_TOKEN` vẫn đăng nhập được.

**Lỗi có thể gặp**

| Hiện tượng | Nguyên nhân | Xử lý |
|---|---|---|
| Google báo `redirect_uri_mismatch` | URI trong Google Cloud khác URI PyloS gửi (khác cổng, `localhost` vs `127.0.0.1`, thiếu `https`, dư dấu `/`) | Trang lỗi của Google có hiện URI đã gửi: chép đúng chuỗi đó vào *Authorized redirect URIs*. Chờ ~5 phút cho Google cập nhật |
| Callback trên VPS trả "Host không hợp lệ" | nginx chuyển `Host: unousgrowth.com` nhưng `guard` chỉ nhận `127.0.0.1:8081`/`localhost:8081` | Kiểm tra cấu hình nginx hiện tại: phải có `proxy_set_header Host 127.0.0.1:8081;` (luồng cũ chạy được thì chắc đã có). Nếu không, thêm host của `ADMIN_PUBLIC_URL` vào `allowed_hosts` khi biến này được đặt |
| Bấm đăng nhập không có gì xảy ra | Trình duyệt chặn tab mới | Trang đã hiện link để bấm tay (giữ hành vi cũ) |
| `invalid_client` | Dán nhầm secret / client của project web | Dùng đúng client của project `PyloS Admin` |
| Đăng nhập xong nhưng poll mãi `pending` | Trang quản lý khởi động lại giữa chừng (mã chỉ nằm trong bộ nhớ) | Bấm đăng nhập lại. Ghi chú trong README |
| "Access blocked: app has not completed verification" | Gmail chưa có trong *Test users* khi app ở Testing | Thêm Gmail vào Test users hoặc Publish app |

### P3. Giao diện PyloS: vàng sáng + đen khối

**Mục tiêu:** trang quản lý PyloS nhìn khác hẳn web bot lịch. Tên hiển thị: **PyloS**. Màu chủ đạo vàng sáng và đen, khối
vuông, viền dày, bóng đổ khối.

**Bảng màu (đặt trong `src/bot/ui/admin/static/theme.css`, viết lại toàn bộ, bỏ dòng "Bản sao từ repo quanlythoigian")**

| Biến | Nền tối (mặc định) | Nền sáng |
|---|---|---|
| `--bg` | `#0A0A0A` | `#FFF8D6` |
| `--surface` (khối) | `#141414` | `#FFFFFF` |
| `--surface-2` | `#1F1F1F` | `#FFF1A8` |
| `--border` | `#2E2E2E` | `#0A0A0A` |
| `--text` | `#F5F5F0` | `#0A0A0A` |
| `--muted` | `#A3A3A3` | `#4A4A4A` |
| `--primary` (vàng) | `#FFD60A` | `#FFD60A` |
| `--primary-text` (chữ trên nền vàng) | `#0A0A0A` | `#0A0A0A` |
| `--primary-ink` (chữ màu vàng trên nền) | `#FFD60A` | `#7A5C00` |
| `--danger` | `#FF5C5C` | `#B3261E` |
| `--ok` | `#7CE38B` | `#1E7B34` |
| `--shadow` | `4px 4px 0 #FFD60A` | `4px 4px 0 #0A0A0A` |

Quy tắc hình khối: `border-radius: 0` (nút, thẻ, ô nhập), viền `2px solid var(--border)`, thẻ có `box-shadow: var(--shadow)`,
thanh trên cùng nền `--primary` chữ `--primary-text`, nút chính nền vàng chữ đen, nút phụ nền đen chữ vàng viền vàng.
Tương phản: vàng `#FFD60A` trên đen ≈ 14:1, đen trên vàng ≈ 14:1 (đạt WCAG AA). **Không dùng chữ vàng trên nền sáng**
(dùng `--primary-ink`).

**Bước làm**

1. `theme.css`: viết lại theo bảng trên; giữ các `@font-face` của **Be Vietnam Pro** (có dấu tiếng Việt), **bỏ** Cinzel,
   Cormorant Garamond, hoa văn meander. Xoá các file font không dùng nữa trong `static/fonts/` (giữ `OFL.txt`).
2. `theme.js`: giữ cơ chế sáng/tối, đổi khoá `localStorage` thành `pylos-theme` (không dùng chung khoá với web), đổi comment.
3. `index.html`: `<title>PyloS · Quản lý bot Zalo</title>`, `theme-color` `#0A0A0A`; thay biểu tượng đền bằng chữ **PyloS**
   in đậm trong khối vàng; bỏ `<div class="meander">`; đổi chữ "iforgotmywayhome" → "PyloS".
4. `admin_page.css`: thay mọi màu cứng và biến cũ (`--lake`, `--terra`, `--lavender`, `--gold`, `--moss` và các bản `-ink`,
   `-mark`) bằng biến mới: `grep -n "lake\|terra\|lavender\|gold\|moss\|meander\|temple" static/*.css static/*.js` phải rỗng
   sau khi sửa.
5. `admin_page.js` dòng ~179: `document.title = \`${label} · PyloS\``.
6. `tests/test_admin.py` dòng 78: đổi `"iforgotmywayhome"` → `"PyloS"`; dòng 83: danh sách font theo font còn giữ.
7. Ứng dụng desktop (`ui/desktop/`, biểu tượng khay `icon_images.py`): đổi màu biểu tượng sang vàng/đen nếu đang dùng màu cũ.
8. Build lại exe: `scripts\build-exe.ps1`.

**Kiểm tra bằng tay:** mở mọi trang (Tổng quan, Nhóm, Hội thoại, Chỉ dẫn, Chat thử, Log, Tin lỗi, Cài đặt, Máy chủ) ở cả
nền tối và nền sáng; dùng DevTools → Lighthouse → Accessibility, phần *Contrast* không có lỗi. Kiểm tra màn hình đăng nhập,
toast, hộp xác nhận, bảng log, ô nhập bị khoá.

**Lỗi có thể gặp:** trình duyệt còn CSS cũ → trang quản lý đã gửi `Cache-Control: no-store`, nhưng cửa sổ desktop
(pywebview) có thể giữ cache: thoát hẳn ứng dụng ở khay rồi mở lại. CSP `style-src 'self'` chặn `style="..."` nội tuyến:
không thêm style nội tuyến, dùng class.

---

## 4. Web (quanlythoigian)

Thứ tự bắt buộc: **W0 → W1 → W2 → W3 → W4 → W5**. Mỗi bước một PR. Sau mỗi PR web vẫn dùng được.

### W0. Chuẩn bị (bắt buộc trước khi sửa code)

1. **Sao lưu dữ liệu Upstash** (Vercel → Storage → Upstash → *Data Browser* không xuất được hết; dùng script):
   tạo `scripts/backup.mjs` đọc mọi khoá theo `SCAN 0 MATCH qltg:* COUNT 1000` + khoá `quanlythoigian:db`, ghi ra
   `backup-YYYYMMDD.json` (giá trị + `TTL`). Chạy ở máy: `UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/backup.mjs`.
   **Không commit file sao lưu.** Thêm `backup-*.json` vào `.gitignore`.
2. **Tách dữ liệu Preview khỏi Production**: Vercel → Settings → Environment Variables → thêm `KV_PREFIX=qltg-preview:` và
   `STORAGE_KEY=quanlythoigian-preview:db` **chỉ cho môi trường Preview** (bản deploy từ nhánh). Nếu không, bản Preview chạy
   bước di trú (W2) **trên dữ liệu thật**.
3. **Google Cloud của web** (project hiện có):
   - Google Auth Platform → **Audience**: nếu *Publishing status* là **Testing** → bấm **Publish app** (chuyển *In production*).
     Đây là điều kiện để refresh token **không hết hạn sau 7 ngày**. Chưa gửi xác minh thì vẫn giới hạn 100 người và có
     màn hình "ứng dụng chưa được xác minh" (bấm Nâng cao → Tiếp tục).
   - **Data access**: có `openid`, `email`, `profile`, `.../auth/calendar.events`.
   - **Clients**: *Authorized redirect URIs* có `https://iforgotmywayhome.vercel.app/api/google/callback`
     (giữ cái của `quanlythoigian-azure` tới hết W5). Thêm URI của Preview nếu muốn thử Google thật trên Preview
     (vd `https://quanlythoigian-git-claude-beautiful-ramanujan-wq6u6u-<team>.vercel.app/api/google/callback`).
4. Tạo khoá mã hoá token: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` → biến
   `TOKEN_ENC_KEY` (Production và Preview **khác nhau**). **Mất khoá này = mọi người phải kết nối lại Google Lịch.**
5. Biến `OWNER_EMAILS=<gmail của chủ hệ thống>` (Production và Preview).
6. cron-job.org: tạo job gọi `https://iforgotmywayhome.vercel.app/api/cron?key=<CRON_SECRET>` **mỗi 5 phút** (Vercel Hobby
   chỉ cho cron 1 lần/ngày). Đặt `CRON_SECRET` trên Vercel nếu chưa có.

### W1. Một kiểu đăng nhập (Gmail) + phân quyền Owner / Technician / User + gộp về một tên miền

**Mô hình quyền** (đặt ở file mới `src/roles.js`, mọi kiểm tra quyền đều gọi file này):

```js
export const ROLES = ['owner', 'technician', 'user'];
export const PERMS = {
  owner:      ['use', 'bot:read', 'bot:write', 'infra:read', 'infra:write', 'accounts:read', 'accounts:write'],
  technician: ['use', 'bot:read', 'bot:write', 'infra:read', 'infra:write', 'accounts:read'],
  user:       ['use'],
};
export const can = (member, perm) => Boolean(member && PERMS[member.role || 'user']?.includes(perm));
```

| Chức năng | Quyền cần | Owner | Technician | User |
|---|---|:-:|:-:|:-:|
| Tổng quan, Lịch, Công việc, Đề xuất, Nguồn, Tài khoản của mình | `use` | ✔ | ✔ | ✔ |
| Quản lý bot: xem nhật ký bot lịch, trạng thái bot nhắc việc | `bot:read` | ✔ | ✔ | ✘ |
| Quản lý bot: sửa cài đặt bot lịch, bot Zalo nhắc việc, tạo/thu hồi khoá agent | `bot:write` | ✔ | ✔ | ✘ |
| Quản lý máy ảo: xem trạng thái hạ tầng | `infra:read` | ✔ | ✔ | ✘ |
| Quản lý máy ảo: khoá API, chạy cron tay, webhook Zalo | `infra:write` | ✔ | ✔ | ✘ |
| Tài khoản người dùng: xem danh sách | `accounts:read` | ✔ | ✔ | ✘ |
| Tài khoản người dùng: đổi quyền, gỡ Zalo, xoá tài khoản người khác | `accounts:write` | ✔ | ✘ | ✘ |

**Bước làm**

1. `src/members.js`
   - Hồ sơ thêm `role` (mặc định `'user'`), `roleChangedAt`, `roleChangedBy` (email người đổi).
   - `publicMember()` trả thêm `role` và `perms` (mảng quyền) để giao diện biết hiện gì.
   - `signInMember()`: nếu email nằm trong `OWNER_EMAILS` (so chữ thường) thì đặt `role = 'owner'` (cả tài khoản mới lẫn cũ).
     Đây là **đường cứu hộ**: mất hết Owner thì đặt biến này rồi đăng nhập lại.
   - Hàm mới `setRole(actor, targetId, role)`:
     - chỉ `can(actor, 'accounts:write')`, `role` thuộc `ROLES`;
     - **không cho hạ Owner cuối cùng** (đếm Owner bằng `listMembers()`; nếu target là owner duy nhất và role mới khác owner → 409
       "Phải còn ít nhất một Owner");
     - ghi log vào khoá `audit` (danh sách, giữ 500 dòng, 180 ngày): `{at, actor, target, from, to}`.
   - `listMembers()` trả thêm `role`, `google: {connected, status}` (từ W3).
2. `src/app.js`
   - Bỏ cookie `qltg_session`, `/api/setup`, `/api/login`, `/api/logout` (quản trị), `/api/auth/status`, `/api/account/password`,
     `purpose` `login|setup|link` trong `/api/google/start|callback`. Trong `src/auth.js` chỉ giữ phần `calendarKey` (đổi sang dùng
     khoá `member-secret` của `members.js`) rồi xoá phần còn lại; xoá `test/auth.test.js` phần mật khẩu.
   - Middleware mới thay khối `app.use('/api', ...)` dòng 576–586:
     ```js
     const need = (perm) => wrap(async (req, res, next) => {
       const me = await currentMember(req);              // 401 { signIn: true } nếu chưa đăng nhập
       if (!can(me, perm)) throw fail(403, 'Tài khoản của bạn không có quyền này');
       req.me = me; next();
     });
     ```
     Gắn **từng route** với quyền ở bảng trên, ví dụ `app.put('/api/settings/keys', need('infra:write'), …)`,
     `app.get('/api/admin/calbot-log', need('bot:read'), …)`, `app.delete('/api/admin/members/:id', need('accounts:write'), …)`.
     Quyền **đọc từ Upstash mỗi yêu cầu** (không ghi vào cookie), nên đổi quyền có hiệu lực ngay.
   - API mới `PUT /api/admin/members/:id/role {role}` (`accounts:write`), `GET /api/admin/audit` (`accounts:read`).
   - Owner/Technician tự sửa hồ sơ mình qua `/api/me…` như mọi người.
3. **Gộp tên miền**: bỏ khái niệm "tên miền quản trị".
   - Đổi `APP_HOST` thành `PRIMARY_HOST=iforgotmywayhome.vercel.app` (giữ đọc `APP_HOST` làm tên cũ cho tương thích).
   - Middleware dòng 44–61 thay bằng: yêu cầu **trang** (không phải `/api/*`) tới host khác `PRIMARY_HOST` → `308` sang
     `https://PRIMARY_HOST` + cùng đường dẫn và query. `/api/agent/*`, `/api/zalo/webhook`, `/api/cron`, `/calendar.ics` chạy ở
     **mọi host** (PyloS, webhook Zalo, cron-job.org đang trỏ vào `quanlythoigian-azure`). Mọi `/api/*` khác ở host phụ → 404
     (vì cookie chỉ nằm ở host chính).
   - `/` luôn trả `views/app.html` (giao diện gộp, W4). Trong lúc chưa xong W4: Owner/Technician thấy nút "Quản trị" mở
     `views/admin.html` ở `/admin` (đăng nhập bằng cookie thành viên).
   - `/app`, `/app/` → 302 về `/`.
   - Manifest: `start_url` `/`, `scope` `/`.
4. **Di trú một lần** (`src/migrate.js`, gọi từ `Store.open()` lần đầu, đánh dấu `kv` khoá `migrated:w1`): nếu
   `store.data.auth.admin.google.email` có giá trị và thành viên với email đó đã tồn tại → đặt `role='owner'`. Nếu chưa tồn tại,
   `OWNER_EMAILS` lo phần đó khi họ đăng nhập lần đầu. Sau đó **không xoá** `store.data.auth` (để rollback được); W5 mới xoá.
5. `/api/agent/device-login*` và `/api/me/device-login/approve`: **giữ tới W5** (PyloS cũ có thể còn gọi), nhưng `isAdmin`
   giờ tính bằng `role === 'owner'` của thành viên đã duyệt.
6. Kiểm thử:
   - Viết lại `test/hosts.test.js` → `test/primary-host.test.js`: trang ở host phụ chuyển 308; `/api/agent/*` chạy ở cả hai; `/api/me`
     ở host phụ 404.
   - `test/roles.test.js` (mới), dùng `LocalRedis` như `test/members.test.js`:
     - Mỗi route quản trị gọi bằng 3 cookie (owner / technician / user) → so với bảng quyền (viết bảng `[method, path, perm]`
       rồi lặp, để thêm route mới mà quên gắn quyền thì test bắt được: **mọi route trong `app.router.stack` (Express 5) bắt đầu bằng `/api/`
       mà không phải `/api/me`, `/api/agent`, `/api/google`, `/api/zalo/webhook`, `/api/cron` phải có trong bảng**).
     - Technician `PUT /api/admin/members/:id/role` → 403. User `GET /api/admin/members` → 403.
     - Hạ Owner cuối cùng → 409. Có 2 Owner thì hạ được 1.
     - Email trong `OWNER_EMAILS` đăng nhập → thành Owner.
     - Đổi quyền xong, yêu cầu kế tiếp của người đó có quyền mới (không cần đăng nhập lại).

**Kiểm tra bằng tay**

1. Đăng nhập bằng Gmail Owner → thấy mục Quản trị. Mở cửa sổ ẩn danh, đăng nhập Gmail khác → chỉ thấy phần sử dụng.
2. Owner đổi người thứ hai thành Technician → người đó tải lại trang thấy Quản trị nhưng ở Tài khoản người dùng không có nút sửa.
   Dùng DevTools gọi `fetch('/api/admin/members/<id>/role', {method:'PUT', …})` → 403.
3. Mở `https://quanlythoigian-azure.vercel.app/` → chuyển sang `https://iforgotmywayhome.vercel.app/`.
4. PyloS vẫn giao lịch được (gọi `/api/agent/assign` ở `quanlythoigian-azure`).

**Lỗi có thể gặp**

| Hiện tượng | Nguyên nhân | Xử lý |
|---|---|---|
| Không ai là Owner sau deploy | Chưa đặt `OWNER_EMAILS` và tài khoản quản trị cũ chưa liên kết Gmail | Đặt `OWNER_EMAILS`, Redeploy, đăng nhập lại |
| Vòng chuyển hướng vô tận | `PRIMARY_HOST` viết sai (có `https://`, dấu `/`, cổng) hoặc trùng host phụ | Hàm chuẩn hoá giống `APP_HOST` cũ (dòng 46); test bắt trường hợp này |
| Webhook Zalo của web ngừng nhận | `/api/zalo/webhook` bị chuyển 308 (Zalo không theo chuyển hướng POST) | Đảm bảo đường này nằm trong danh sách chạy ở mọi host; test có |
| Thấy mục Quản trị nhưng bấm vào báo 403 | Giao diện đọc `perms` cũ trong bộ nhớ | Giao diện gọi lại `/api/me` khi nhận 403 và vẽ lại menu |

### W2. Dữ liệu riêng cho từng người (nền cho Lịch / Công việc / Đề xuất / Nguồn trên web người dùng)

**Thiết kế**

- Tách `src/db.js` thành hai lớp:
  - `SystemStore` (giữ khoá cũ `quanlythoigian:db`): `settings` (khoá API, khoá agent), `meta` chung (Zalo nhắc việc).
  - `UserStore` (khoá kv `udata:<memberId>`): `events`, `tasks`, `goals`, `suggestions`, `sources`, `pomodoros`, `google`
    (đồng bộ 2 chiều), `meta.reminded`. Giữ nguyên các phương thức `addSuggestions`, `approveSuggestion`, `rejectSuggestion`,
    `replaceSourceEvents`, `Store.key` (chuyển vào `UserStore`).
  - `UserStore.open(id)` trả về đối tượng có `.data` và `.save()` y như `Store` hiện tại ⇒ `syncSources(openStore)` và
    `syncGoogle(openStore)` **không phải sửa chữ ký**: truyền `() => UserStore.open(id)`.
- Mọi route của phần sử dụng (`/api/state`, `/api/events*`, `/api/tasks*`, `/api/goals/*`, `/api/pomodoros`, `/api/extract`,
  `/api/suggestions*`, `/api/sources*`) đổi sang `/api/me/...` (ví dụ `/api/me/state`, `/api/me/events/:id`) và dùng
  `UserStore.open(req.me.id)`. Quyền: `use`.
- `/api/agent/events`, `/api/agent/tasks*`, `/api/agent/agenda`, `/api/agent/message` (tool `schedule_web.py` của PyloS):
  bắt buộc thêm `zaloUid` (người nhắn). Web tìm thành viên theo `idx:zalo`; chưa liên kết → 404 kèm `appUrl` để bot gửi link.
  PyloS sửa `schedule_web.py` gửi `zaloUid = ctx.user_id` (sửa cùng lúc, xem mục 5).
- Giới hạn để không vỡ gói miễn phí (đặt trong `src/limits.js`): tối đa 5 nguồn/người, 2.000 sự kiện/người, 1.000 việc/người,
  `POST /api/me/extract` tối đa 20 lần/ngày/người (đếm bằng `kv.count`), nguồn kiểu `web` (đọc bằng Gemini) tối đa 2/người.
  Vượt → 429 với câu tiếng Việt rõ ràng.
- Cron (`src/cron.js`): đồng bộ nguồn theo **từng người có nguồn** (`idx:has-sources` – tập id), mỗi lần cron tối đa 20 người,
  lưu con trỏ `cron:cursor` để lần sau làm tiếp (Vercel giới hạn 60 giây/hàm). Nhắc việc qua Zalo và tóm tắt sáng chỉ cho Owner
  (dữ liệu `UserStore` của Owner đầu tiên).

**Di trú** (`src/migrate.js`, khoá đánh dấu `migrated:w2`, có khoá chống chạy đôi `kv.set('migrating', 1, {nx, ex: 120})`)

1. Tìm Owner (W1). Không có Owner → **không di trú**, ghi `lastError` "Chưa có Owner", để nguyên dữ liệu cũ.
2. Chép `events, tasks, goals, suggestions, sources, pomodoros, google, meta.reminded` từ `quanlythoigian:db` sang
   `udata:<ownerId>`.
3. **Không xoá** dữ liệu ở `quanlythoigian:db` (rollback được). W5 mới dọn.
4. Ghi `migrated:w2 = {at, ownerId, counts}`; trang Quản trị → Hạ tầng hiện dòng "Đã chuyển dữ liệu cũ sang tài khoản <email>".

**Kiểm thử**

- `test/userstore.test.js` (mới): hai người tạo sự kiện / việc / nguồn → mỗi người chỉ thấy của mình; `GET /api/me/state` của A
  không chứa id của B; sửa / xoá id của người khác → 404 (không phải 403, để không lộ id có tồn tại).
- `test/migrate.test.js` (mới): dữ liệu cũ có 3 sự kiện, 2 việc, 1 nguồn, `google.refreshToken` → sau di trú Owner có đủ; chạy lại
  lần 2 không nhân đôi; không có Owner thì không làm gì.
- Sửa `test/app.test.js`, `test/auth.test.js` (phần agent): dùng `UserStore`, thêm `zaloUid`.
- Giới hạn: tạo nguồn thứ 6 → 429.

**Lỗi có thể gặp**

| Hiện tượng | Nguyên nhân | Xử lý |
|---|---|---|
| Owner vào thấy lịch trống | Di trú chưa chạy (không có Owner lúc deploy) | Đặt `OWNER_EMAILS`, đăng nhập Owner, gọi `POST /api/admin/migrate` (`infra:write`) để chạy lại |
| Dữ liệu nhân đôi | Hai lambda di trú cùng lúc | Khoá `migrating` + `migrated:w2` (test có) |
| Cron quá 60 giây | Nhiều người có nguồn web (Gemini chậm) | Giảm lô xuống 10 người, nguồn `web` mỗi người đồng bộ ≥ 60 phút/lần |
| Hết lệnh Upstash miễn phí | Mỗi lần mở trang đọc cả `udata:<id>` | `/api/me/state` chỉ đọc 1 khoá; giao diện không tự tải lại nhanh hơn 60 giây; theo dõi Upstash → *Usage* trong 3 ngày đầu |

### W3. Google Lịch tự động: đăng nhập là xin quyền, cho phép là chạy mãi

**Mục tiêu (đúng yêu cầu):** người dùng chỉ **đăng nhập Google một lần**; trong cùng màn hình Google hỏi quyền Google Lịch;
cho phép là web tự đồng bộ, không phải bấm lại mỗi giờ, không cần mở app, không bị "out".

**Thiết kế**

- Bỏ hẳn Google Identity Services trong trình duyệt (`<script src="https://accounts.google.com/gsi/client">`, `requestToken`,
  `applyPending`, `sessionStorage` token). **Máy chủ** giữ **refresh token** (mã hoá) và tự ghi lịch.
- `src/google.js::authUrl` cho `purpose=member`:
  `scope = openid email profile https://www.googleapis.com/auth/calendar.events`,
  `access_type=offline`, `include_granted_scopes=true`, `prompt=select_account`.
- Callback (`/api/google/callback`, `purpose=member`):
  1. Đổi mã (`exchangeCode`) → nhận `refresh_token` (có thể rỗng), `scope` (chuỗi các quyền **thực sự** được cấp).
  2. Nếu `scope` chứa `calendar.events` và có `refresh_token` → lưu, `google.status='connected'`, chạy đồng bộ lần đầu ở nền
     (`waitUntil`), về app với `?google=calendar-on`.
  3. Có quyền lịch nhưng **không có** `refresh_token` và máy chủ **chưa có** token nào của người này (Google chỉ trả refresh token
     ở lần đồng ý đầu) → chuyển ngay sang Google lần nữa với `prompt=consent&login_hint=<email>` (người dùng chỉ bấm "Tiếp tục").
     Đánh dấu cookie `qltg_oauth_retry` để không lặp quá 1 lần.
  4. Người dùng **bỏ tick** Google Lịch ở màn hình đồng ý chi tiết của Google → vẫn đăng nhập được; `google.status='no-scope'`;
     app hiện thẻ "Cho phép Google Lịch để lịch tự đồng bộ" với nút → `/api/google/start?purpose=calendar-member`
     (`scope=calendar.events`, `include_granted_scopes=true`, `prompt=consent`, `login_hint`).
- Lưu token: file mới `src/gtoken.js`
  - `encrypt/decrypt` AES-256-GCM bằng `TOKEN_ENC_KEY` (base64, 32 byte); lưu `{v:1, iv, tag, data}` ở kv `gtoken:<memberId>`.
  - `accessTokenFor(memberId)`: cache trong bộ nhớ + kv `gat:<memberId>` (mã hoá, `ex = expires_in - 120`), hết thì đổi bằng
    refresh token.
  - Gặp `invalid_grant` (người dùng gỡ quyền ở myaccount.google.com, đổi mật khẩu, token quá 6 tháng không dùng) → xoá token,
    `google.status='reconnect'`, ghi `google.lastError`. Đây là **trường hợp duy nhất** người dùng phải bấm lại (thẻ "Kết nối lại
    Google Lịch", một cú bấm).
  - Không bao giờ trả token xuống trình duyệt; `/api/me` chỉ trả `google: {status, email, lastSync, lastError}`.
- Ghi lịch được giao (thay `public/app/sync.js` chạy trong trình duyệt):
  - Chuyển `public/app/sync.js` → `src/calsync.js` (code giữ nguyên, đã không phụ thuộc giao diện). **Giữ nguyên**
    `googleEventId = qltgm<id>` để lịch đã được trình duyệt ghi trước đây **không bị tạo trùng**.
  - `src/calbot.js::deliver()`: sau `pushCommands`, với mỗi người nhận có `google.status==='connected'` gọi
    `drainMember(id)` trong `waitUntil` (không làm chậm trả lời cho PyloS). Đặt thời gian chờ 8 giây/người.
  - `drainMember(id)`: đọc `gapplied:<id>` (seq đã ghi), lấy `commandsAfter(id, gapplied)`, gọi `applyAll` với access token máy chủ;
    ghi `gapplied`, ghi lịch sử từng lệnh vào `ghist:<id>` (danh sách, giữ 200, 90 ngày) và gọi `recordFetched` như cũ (log bot lịch
    vẫn có "app của ai đã lấy lệnh" → đổi chữ thành "đã ghi vào Google Lịch lúc …"). Khoá `kv.set('drain:<id>', 1, {nx, ex: 60})`
    để hai lần chạy cùng lúc không áp chồng.
  - Lỗi `later` (mạng, 429, 5xx) → để lại, đưa id vào tập `gpending`. Cron 5 phút gọi `drainMember` cho các id trong `gpending`
    (tối đa 30 người/lần).
  - **Lần đầu sau khi lên W3**: `gapplied` chưa có → áp lại mọi lệnh còn trong hàng (≤ 30 ngày). An toàn vì cùng ID cố định
    (`create` gặp 409 thì `PUT`, `delete` gặp 404/410 coi là xong).
- Lịch trên web (cho trang Lịch của W4): mỗi người có `UserStore.google` giống chủ web cũ, dùng `pullGoogle` / `pushGoogle`
  (`src/google.js`) với `refreshToken` lấy từ `gtoken.js` thay vì lưu thẳng trong `store.data.google.refreshToken`.
  - Kéo lịch Google về khi người dùng mở trang Lịch (`olderThanMs = 10 phút`) và trong cron cho người hoạt động trong 7 ngày
    (`olderThanMs = 30 phút`, tối đa 20 người/lần).
  - Sự kiện tạo trên web tự đẩy lên Google (`kickGoogle` theo người).
  - Lịch được giao (`qltgm…`, có `extendedProperties.private.ifmwhId`) khi kéo về thì hiện nhãn "Được giao".
    `fromGoogle()` hiện bỏ qua sự kiện có `qltgId` (do web đẩy) — giữ; thêm nhận diện `ifmwhId` để gắn nhãn.
- Owner cũ: `store.data.google.refreshToken` (đồng bộ 2 chiều của chủ web) được W2 chép sang `udata:<ownerId>.google`; W3 chuyển
  vào `gtoken:<ownerId>` (mã hoá) rồi xoá bản rõ.
- Điều khoản: sửa `public/terms.html`, `public/privacy.html` (máy chủ **giữ** quyền Google Lịch đã mã hoá, ghi thay người dùng,
  đọc lịch chính để hiện trên web; gỡ bằng nút "Ngắt Google Lịch" hoặc xoá tài khoản; refresh token bị thu hồi khi xoá tài khoản).
  Đổi `TERMS_VERSION` trong `src/members.js` và số phiên bản trong 2 trang (có test bắt hai chỗ khớp). Mọi người sẽ được hỏi
  đồng ý lại (đã có màn hình `renderTerms`).
- Ngắt kết nối: `DELETE /api/me/google` → `revoke(refreshToken)`, xoá `gtoken`, `gat`, `google.status='off'`. Xoá tài khoản
  (`deleteMember`) cũng làm việc này.
- CSP trong `views/app.html`: bỏ `https://accounts.google.com/gsi/*` khỏi `script-src`, `style-src`, `connect-src`, `frame-src`
  (trình duyệt không còn gọi Google).

**Kiểm thử tự động**

- `test/gtoken.test.js`: mã hoá → giải mã đúng; sai khoá → lỗi rõ ràng (không lộ token); thiếu `TOKEN_ENC_KEY` → web vẫn chạy nhưng
  `google.status='unavailable'` và Hạ tầng báo đỏ.
- `test/google-member.test.js` (fetch giả Google, giống `test/google.test.js`):
  - Callback có đủ scope + refresh token → `connected`, đồng bộ lần đầu được gọi.
  - Có scope nhưng không có refresh token, chưa có token cũ → 302 sang Google với `prompt=consent`; lần 2 vẫn không có → không lặp,
    báo lỗi dễ hiểu.
  - Không có scope lịch → đăng nhập được, `no-scope`.
  - `invalid_grant` khi đổi access token → `reconnect`, token bị xoá.
- `test/drain.test.js`:
  - Giao lịch cho A (đã kết nối) → Google giả nhận `POST …/events` id `qltgm<id>`; sửa → `PUT`; huỷ → `DELETE`.
  - Google trả 503 → id A vào `gpending`; cron chạy lại → ghi xong, `gpending` rỗng.
  - Hai `drainMember(A)` chạy cùng lúc → mỗi lệnh chỉ gọi Google 1 lần.
  - Lệnh cũ đã được trình duyệt ghi (Google trả 409 khi POST) → `PUT`, không lỗi, không trùng.
- Viết lại `test/sync.test.js` theo đường dẫn mới `src/calsync.js`.
- Viết lại `test/e2e/app.e2e.mjs`: bỏ phần giả GIS; giả máy chủ token Google bằng biến `GOOGLE_TOKEN_URL`/`GOOGLE_AUTH_URL`
  (thêm 2 biến này vào `src/google.js`, chỉ dùng trong test).

**Kiểm tra bằng tay (Google thật, trên Production sau khi deploy, hoặc Preview đã thêm redirect URI)**

1. Tài khoản Gmail mới tinh: mở web → tick điều khoản → Đăng nhập Google → màn hình Google có dòng "Xem, chỉnh sửa… sự kiện trên
   tất cả lịch của bạn" → Cho phép → về web, mục Tài khoản ghi **Google Lịch: Đã kết nối**.
2. Liên kết Zalo (mã 6 số). Trong nhóm Zalo nhờ bot giao lịch cho mình → **không mở web**, mở Google Lịch trên điện thoại:
   lịch xuất hiện trong ≤ 1 phút.
3. **Đợi hơn 1 giờ** (hoặc để qua đêm), giao lịch khác → vẫn tự vào Google Lịch, không có nút "Cập nhật Google Lịch" nào.
4. Sửa giờ lịch đó qua bot → Google Lịch đổi giờ. Huỷ → biến mất.
5. Đăng nhập lại, lần này **bỏ tick** quyền lịch ở màn hình Google → web vẫn vào được, có thẻ xin quyền; bấm → cho phép → Đã kết nối.
6. Vào https://myaccount.google.com/permissions gỡ quyền của app → giao lịch → web hiện "Kết nối lại Google Lịch" (không phải
   đăng xuất). Bấm một lần là xong.
7. Đóng tất cả tab 1 ngày, giao lịch → vẫn vào Google Lịch (nhờ máy chủ + cron 5 phút).
8. Sau 8 ngày kiểm tra lại bước 3 (bắt lỗi app còn ở trạng thái *Testing*).

**Lỗi có thể gặp**

| Hiện tượng | Nguyên nhân | Xử lý |
|---|---|---|
| Sau 7 ngày mọi người bị "Kết nối lại" | OAuth consent screen còn **Testing** | Publish app (W0.3). Không có cách sửa trong code |
| Google không trả `refresh_token` | Người dùng đã từng đồng ý trước đây | Luồng `prompt=consent` ở bước 3 của callback; nếu vẫn không có: gỡ quyền ở myaccount.google.com/permissions rồi đăng nhập lại |
| `Error 403: access_denied` khi đăng nhập | Gmail không nằm trong 100 test user (app Testing) hoặc vượt 100 người dùng của app chưa xác minh | Publish app; quá 100 người thì gửi Google xác minh scope `calendar.events` (mất vài tuần, cần video demo + chính sách quyền riêng tư) |
| Lịch bị tạo **trùng** | Đổi hàm `googleEventId` | Giữ `qltgm<id>` cho lịch được giao và `qltg<id>` cho lịch tự tạo; test `drain.test.js` bắt |
| Lịch được giao không lên dù đã kết nối | `waitUntil` bị cắt khi hàm trả lời xong quá lâu, hoặc cron-job.org chưa chạy | Kiểm tra Vercel Logs tìm `[drain]`; kiểm tra cron-job.org có chạy mỗi 5 phút (Hạ tầng hiện "cron chạy lần cuối") |
| `TOKEN_ENC_KEY` bị đổi / mất | Mọi token không giải mã được | Coi như `reconnect` cho tất cả; **ghi rõ trong README: không đổi khoá này** |
| `Rate Limit Exceeded` / `quotaExceeded` từ Calendar API | Nhiều người kéo lịch cùng lúc | Kéo lịch chỉ khi mở trang Lịch (10 phút/lần) + cron theo lô; lỗi loại `later` tự thử lại |
| Người dùng than "web xem được hết lịch của tôi" | Scope `calendar.events` cho đọc mọi sự kiện | Ghi rõ trong Chính sách quyền riêng tư; web chỉ lưu sự kiện 7 ngày trước – 90 ngày sau, không lưu ghi chú quá 1.000 ký tự (giữ `PAST_DAYS`/`FUTURE_DAYS`) |

### W4. Giao diện web gộp: phần sử dụng đầy đủ + mục Tài khoản riêng + Quản trị theo quyền

**Mục tiêu:** một trang duy nhất `views/app.html` cho mọi người. Không thêm phần "Hệ thống" và "Cài đặt" cho User.

**Menu (sidebar trên máy tính, thanh dưới trên điện thoại)**

| Nhóm | Mục | Ai thấy | Nội dung lấy từ đâu |
|---|---|---|---|
| Sử dụng | Tổng quan | mọi người | `public/admin/admin.js::renderDashboard` (lịch hôm nay, việc ưu tiên, nhập nhanh bằng AI, Pomodoro, 3 mục tiêu) |
| | Lịch | mọi người | `renderCalendar`, `renderDayPanel`, `openEventModal` (tháng / tuần; sự kiện Google, sự kiện tự tạo, lịch được giao có nhãn) |
| | Công việc | mọi người | `renderTasks`, `openTaskModal` (ma trận Eisenhower) |
| | Đề xuất | mọi người | `renderInbox` (dán văn bản cho AI, duyệt / bỏ / duyệt tất cả) |
| | Nguồn | mọi người | `renderSources` (ICS, trang web) |
| **Tài khoản** | Tài khoản | mọi người | mới: hồ sơ Gmail; **Google Lịch** (trạng thái, kết nối / kết nối lại / ngắt, lần đồng bộ cuối); **Zalo** (lấy mã 6 số, gỡ liên kết — chuyển từ `public/app/app.js::zaloStep`); **Lịch được giao** (lịch sử từ `ghist`, thay `historyCard`); điều khoản; Đăng xuất; Xoá tài khoản. Owner có thêm link `.ics` |
| Quản trị | Quản lý bot | Owner, Technician | từ `public/admin/system.js`: tab **Nhật ký bot lịch** (`sysCalbot`); tab **Cài đặt bot lịch** (tên bot, link chat, email/tên miền được tạo tài khoản — phần cài đặt của `sysMembers`); thẻ **Bot Zalo nhắc việc** (`zalo-box`); thẻ **Kết nối AI agent** (`renderAgent`) |
| | Quản lý máy ảo | Owner, Technician | từ `renderSettings`: **Trạng thái** (lưu trữ, Gemini, Zalo, Google, cron lần cuối, di trú), **Khoá API** (`keys-form`), Google OAuth URIs để chép, nút chạy cron |
| | Tài khoản người dùng | Owner, Technician | danh sách từ `sysMembers` + cột **Quyền**, **Google Lịch**, **Zalo**, lần cuối hoạt động; Owner có ô chọn quyền, gỡ Zalo, xoá; Technician chỉ xem (không có nút); **Nhật ký phân quyền** (`/api/admin/audit`) |

**Bước làm**

1. Chuyển code giao diện thành module ES (giữ "không có script nội tuyến", CSP `script-src 'self'`):
   - `public/app/app.js` → khung: khởi động, đăng nhập, điều khoản, menu theo `me.perms`, định tuyến bằng `location.hash`
     (`#/lich`, `#/cong-viec`, `#/de-xuat`, `#/nguon`, `#/tai-khoan`, `#/quan-tri/bot`, `#/quan-tri/may-ao`, `#/quan-tri/tai-khoan`).
   - `public/app/views/` mới: `dashboard.js`, `calendar.js`, `tasks.js`, `inbox.js`, `sources.js`, `account.js`,
     `admin-bot.js`, `admin-infra.js`, `admin-accounts.js`. Mỗi file `export function render(root, ctx)`.
   - Lấy hàm tiện ích chung (`h`, `icon`, `api`, `toast`, định dạng ngày) ra `public/app/ui.js`.
   - Chép logic từ `public/admin/admin.js` / `system.js`, **đổi đường dẫn API** sang `/api/me/...` (W2) và `/api/admin/...`.
   - Module quản trị chỉ `import()` khi `me.perms` có quyền (User không tải về code quản trị — chỉ để gọn, bảo mật vẫn ở máy chủ).
2. Gộp CSS: `public/admin/style.css` + `public/app/app.css` → `public/app/app.css` (giữ `public/theme.css` của web, **giao diện
   web giữ phong cách hiện tại**; chỉ PyloS đổi sang vàng–đen).
3. Hộp thoại sửa sự kiện / việc (`openModal`) dùng `<dialog>` như cũ.
4. Xoá `views/admin.html`, `public/admin/` sau khi mọi chức năng đã chuyển (kiểm theo bảng menu ở trên, đánh dấu từng dòng).
5. Service worker `public/sw.js`: đổi `CACHE = 'ifmwh-app-v3'`, cập nhật `SHELL` (bỏ `/app/sync.js`, thêm `ui.js`, các
   `views/*.js`). **Bắt buộc**, nếu không người dùng cũ chạy JS cũ với API mới.
6. `vercel.json`: bỏ rewrite `/app`, `/app/manifest.webmanifest`; thêm `/admin` nếu còn dùng tạm; giữ `"/"`.
7. Trạng thái rỗng và lỗi: mọi màn hình có chữ khi chưa có dữ liệu (vd "Chưa có lịch. Bấm + để thêm hoặc kết nối Google Lịch").
8. Điện thoại: kiểm tra 360 px chiều ngang; lịch tháng chuyển sang danh sách theo ngày khi < 600 px.

**Kiểm thử tự động**

- `test/e2e/app.e2e.mjs` (Playwright, Google giả): 3 tài khoản (owner, technician, user):
  - User: menu có đúng 6 mục (Tổng quan, Lịch, Công việc, Đề xuất, Nguồn, Tài khoản); vào thẳng `#/quan-tri/bot` → báo không có
    quyền, không gọi được API.
  - Technician: có 3 mục Quản trị; trang Tài khoản người dùng không có nút sửa.
  - Owner: đổi quyền user → technician; tải lại phiên của user đó thấy menu mới.
  - Tạo sự kiện / việc / đề xuất / nguồn ICS (máy chủ ICS giả) → hiện đúng; người khác không thấy.
  - Chụp ảnh từng màn hình (`SHOTS_DIR`) để người duyệt xem.
- `npm test` vẫn xanh.

**Kiểm tra bằng tay:** đi qua bảng menu ở trên bằng 3 tài khoản, trên máy tính và điện thoại, nền sáng và tối.

**Lỗi có thể gặp**

| Hiện tượng | Nguyên nhân | Xử lý |
|---|---|---|
| Trang trắng sau deploy ở điện thoại đã cài app | Service worker cũ giữ `app.js` cũ | Đổi `CACHE` (bước 5); hướng dẫn: kéo để tải lại / mở lại app |
| CSP chặn module | Đường dẫn `import()` ngoài `'self'` hoặc dùng `eval` | Chỉ import file cùng tên miền |
| Lịch tháng chậm khi nhiều sự kiện | Vẽ lại toàn bộ DOM | Chỉ lọc sự kiện trong khoảng tháng đang xem |
| Thiếu một chức năng cũ của trang quản trị | Chép sót khi xoá `admin.html` | Bảng menu ở trên là danh sách kiểm; không xoá `public/admin/` khi chưa đánh dấu đủ |

### W5. Dọn dẹp sau khi PyloS mới đã chạy ổn ≥ 7 ngày

1. Xoá ở web: `/api/agent/config`, `/api/agent/heartbeat`, `/api/agent/sessions`, `/api/agent/device-login*`,
   `/api/me/device-login/approve`, `src/devicelogin.js`, phần cấu hình bot / nhịp tim / session trong `src/system.js` (file còn
   lại gì thì giữ, không còn gì thì xoá), `/api/admin/system`, `/api/admin/sessions*`, test `test/devicelogin.test.js`,
   `test/system.test.js`, mô tả các API này trong `/api/agent/openapi.json`. Trả `410 Gone` kèm câu "PyloS đã tách khỏi web,
   hãy cập nhật PyloS" thay vì 404 trong 30 ngày đầu (dễ chẩn đoán nếu còn bản PyloS cũ ở đâu đó).
2. Xoá khoá Upstash không dùng: `bot-status`, `system-config`, `session-chats`, `session:*`, `devlogin:*`
   (script `scripts/cleanup-w5.mjs`, in danh sách trước, hỏi `--yes` mới xoá).
3. Xoá dữ liệu cũ đã chép trong `quanlythoigian:db` (`events`, `tasks`, …, `auth`) — **chỉ sau khi** Owner xác nhận dữ liệu trong
   tài khoản mình đầy đủ.
4. Bỏ redirect URI cũ của `quanlythoigian-azure` ở Google Cloud. **Giữ** tên miền `quanlythoigian-azure` trên Vercel (PyloS,
   webhook Zalo, cron-job.org có thể còn trỏ vào), hoặc đổi tất cả sang `iforgotmywayhome` rồi mới gỡ.
5. Cập nhật `README.md` của web: bỏ mục "Tên miền: app người dùng và trang quản trị", mục tài khoản quản trị mật khẩu,
   "App phải đang mở", "Quyền Google Lịch hết hạn sau 1 giờ", mục "Session"/"Cấu hình bot"; thêm mục **Phân quyền**,
   **Google Lịch tự đồng bộ**, biến `PRIMARY_HOST`, `OWNER_EMAILS`, `TOKEN_ENC_KEY`, cron-job.org 5 phút.

---

## 5. Thứ tự đưa lên production

Lý do thứ tự: PyloS cũ gọi các API mà web sắp bỏ, nên **PyloS cập nhật trước**, web bỏ API **sau cùng** (W5).

| # | Việc | Ai | Kiểm tra xong mới sang bước sau |
|---|---|---|---|
| 1 | W0 (sao lưu, Preview tách dữ liệu, Publish app Google, `TOKEN_ENC_KEY`, `OWNER_EMAILS`, cron-job.org) | chủ hệ thống | Có file sao lưu; Google Auth Platform ghi *In production* |
| 2 | Chép cấu hình đang đặt trên web (Hệ thống → Cấu hình bot) vào `settings.env` của PyloS ở **máy Windows và VPS** | chủ hệ thống | So từng dòng |
| 3 | Merge **P1 + P2** của PyloS; cập nhật VPS (`Máy chủ → Cập nhật code` hoặc `git pull` + `systemctl restart pylos-admin pylos-bot`); build lại exe | dev | Mục kiểm tra bằng tay của P1, P2 |
| 4 | Merge **P3** PyloS | dev | Mục kiểm tra của P3 |
| 5 | Merge **W1** web | dev | Mục kiểm tra W1; PyloS vẫn giao lịch được |
| 6 | Merge **W2** web **cùng lúc** với sửa `schedule_web.py` của PyloS (gửi `zaloUid`) | dev | Owner thấy đủ dữ liệu cũ; bot "thêm lịch họp 3h chiều mai" vào đúng tài khoản người nhắn |
| 7 | Merge **W3** web | dev | Mục kiểm tra W3 bước 1–7; bước 8 sau 8 ngày |
| 8 | Merge **W4** web | dev | e2e + bảng menu |
| 9 | Đợi ≥ 7 ngày, Vercel Logs không còn yêu cầu `/api/agent/heartbeat` → merge **W5** | dev | `410` không xuất hiện trong log 3 ngày |

**Rollback**

- PyloS: `git checkout <commit trước>` trên VPS, `systemctl restart pylos-admin pylos-bot`; máy Windows chạy exe cũ. Cấu hình từ
  web vẫn còn trên web tới W5 nên bản cũ chạy lại được.
- Web: Vercel → Deployments → bản trước → **Promote to Production** (tức thì). Dữ liệu cũ không bị xoá trước W5 nên bản cũ đọc lại
  được. Riêng sau W3: bản cũ không biết `gtoken:*`, người dùng quay về kiểu bấm "Cập nhật Google Lịch" như trước (không mất lịch).

---

## 6. Kiểm thử toàn hệ thống (sau bước 8 của mục 5)

Chuẩn bị 3 Gmail: **O** (Owner, trong `OWNER_EMAILS`), **T** (sẽ thành Technician), **U** (User). 1 nhóm Zalo thử có bot và 3 người.

| # | Thao tác | Kết quả đúng |
|---|---|---|
| 1 | O, T, U lần lượt đăng nhập web bằng Google, cho phép Google Lịch | Cả ba: Tài khoản → Google Lịch **Đã kết nối** |
| 2 | O vào Quản trị → Tài khoản người dùng, đổi T thành Technician | Nhật ký phân quyền có dòng; T tải lại thấy Quản trị |
| 3 | T thử đổi quyền U (DevTools) | 403 |
| 4 | U mở `#/quan-tri/may-ao` | Báo không có quyền |
| 5 | Ba người lấy mã 6 số, nhắn riêng cho bot | Bot trả "✅ Đã liên kết…" (không còn chữ "nhớ mở app") |
| 6 | O nhắn trong nhóm: "bot giao @T @U họp 9h mai" | Lịch vào Google Lịch của T và U trong ≤ 1 phút, **không ai mở web** |
| 7 | "dời cuộc họp lúc nãy sang 10h", rồi "huỷ cuộc họp lúc nãy" | Google Lịch đổi giờ, rồi xoá |
| 8 | Mở web của U → Lịch | Thấy sự kiện Google Lịch của U (kể cả lịch được giao, có nhãn "Được giao") |
| 9 | U tạo việc, đề xuất (dán văn bản), nguồn ICS | Chỉ U thấy; O không thấy trong phần sử dụng của O |
| 10 | Quản trị → Quản lý bot → Nhật ký bot lịch | Có dòng giao / sửa / huỷ, cột "đã ghi vào Google Lịch lúc …" |
| 11 | PyloS: đăng nhập trang quản lý bằng Google (Gmail trong `ADMIN_EMAILS`) với `SCHEDULE_API_KEY` **bỏ trống** | Vào được |
| 12 | PyloS: Kết nối VPS bằng Google | Có công tắc Máy này / VPS |
| 13 | Vercel Logs 1 giờ | Không có `/api/agent/heartbeat`, `/config`, `/sessions`, `/device-login` |
| 14 | Hôm sau (≥ 24 giờ) giao lịch tiếp | Vẫn tự vào Google Lịch, không cần bấm gì |
| 15 | Trang quản lý PyloS | Màu vàng / đen, chữ **PyloS**, không còn chữ iforgotmywayhome |

---

## 7. Bảng lỗi chung có thể gặp (ngoài các bảng ở từng giai đoạn)

| Hiện tượng | Nguyên nhân hay gặp | Cách tìm / sửa |
|---|---|---|
| PyloS báo "Sai hoặc thiếu khoá API" khi giao lịch | `SCHEDULE_API_KEY` bị thu hồi khi Owner bấm "Tạo khoá mới" ở Quản lý bot | Tạo khoá mới, dán vào `settings.env` của PyloS (máy Windows **và** VPS), khởi động lại bot |
| PyloS giao lịch lỗi 404 sau khi đổi `SCHEDULE_API_URL` sang `iforgotmywayhome` | Gõ thiếu `https://` hoặc dư `/api/agent/` | `server_client.base_url` tự thêm `/api/agent`; chỉ cần `https://iforgotmywayhome.vercel.app` |
| Vercel báo `FUNCTION_INVOCATION_TIMEOUT` ở `/api/cron` | Lô quá lớn | Giảm số người mỗi lô (W2, W3) |
| Upstash báo vượt giới hạn | Cron 5 phút × nhiều người + mở trang | Xem Upstash → Usage; tăng chu kỳ cron lên 10 phút; giảm kéo lịch Google |
| Biến môi trường mới không có hiệu lực | Vercel cần Redeploy sau khi đổi biến | Deployments → ⋯ → Redeploy |
| Người dùng cũ báo "mất lịch sử lịch đã nhận" | Lịch sử cũ nằm trong `localStorage` của trình duyệt, lịch sử mới lấy từ máy chủ (`ghist`) | Bình thường; lịch trong Google Lịch không mất. Ghi trong thông báo cập nhật |
| Thành viên cũ bị hỏi đồng ý điều khoản lại | `TERMS_VERSION` đổi ở W3 | Bình thường, đúng thiết kế |
| Owner cũ đăng nhập bằng mật khẩu không được | Đã bỏ đăng nhập mật khẩu (W1) | Đăng nhập Google bằng Gmail trong `OWNER_EMAILS` |
| Test PyloS `test_desktop.py` lỗi `ModuleNotFoundError: PIL` | Chưa cài nhóm `desktop` | `pip install -e ".[dev,desktop]"` |

---

## 8. Danh sách kiểm cuối (đánh dấu khi xong)

- [ ] W0: sao lưu, Preview tách `KV_PREFIX`/`STORAGE_KEY`, Google app *In production*, `TOKEN_ENC_KEY`, `OWNER_EMAILS`, cron-job.org 5 phút
- [ ] Cấu hình từ web đã chép vào `settings.env` (Windows + VPS)
- [ ] P1 PyloS tách khỏi web + test `test_no_web_coupling.py`
- [ ] P2 PyloS đăng nhập Google riêng (Windows + VPS) + `test_google_login.py`
- [ ] P3 PyloS giao diện vàng–đen + build lại exe
- [ ] W1 web: Gmail duy nhất, phân quyền, một tên miền + `roles.test.js`, `primary-host.test.js`
- [ ] W2 web: dữ liệu riêng từng người + di trú + `schedule_web.py` gửi `zaloUid`
- [ ] W3 web: Google Lịch phía máy chủ + điều khoản mới + `gtoken`/`drain`/`google-member` tests
- [ ] W4 web: giao diện gộp, mục Tài khoản, Quản trị theo quyền + e2e 3 vai trò + đổi cache service worker
- [ ] Mục 6 kiểm thử toàn hệ thống: 15/15 dòng đúng
- [ ] W5 (sau ≥ 7 ngày): bỏ API cũ, dọn Upstash, cập nhật README hai repo
