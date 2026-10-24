// Ứng dụng Express: API + giao diện. Dùng chung cho chạy trên máy (server.js) và Vercel (api/index.js).
import './env.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { waitUntil } from '@vercel/functions';
import { Store, newId } from './db.js';
import { DEFAULT_MODEL, checkGemini, extractItems, geminiConfigured } from './gemini.js';
import { cfg, cfgSource, mask } from './config.js';
import { syncSources } from './sources.js';
import { runCron } from './cron.js';
import { storageKind } from './storage.js';
import {
  adminName, authMode, calendarKey, changePassword, checkLogin, createAdmin, sessionCookieValue, validateNew,
  verifyPassword, verifySession,
} from './auth.js';
import {
  getMe, handleUpdate, ownerChatId, sendMessage, setWebhook, webhookSecret, zaloConfigured,
} from './zalo.js';
import { dayKey, TZ } from './time.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const isVercel = Boolean(process.env.VERCEL);
export const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  res.status(err.status || 500).json({ error: err.message });
});
const fail = (status, message) => Object.assign(new Error(message), { status });
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
const findOr404 = (list, id) => list.find((x) => x.id === id) || (() => { throw fail(404, 'Không tìm thấy'); })();

// Mở dữ liệu mới nhất, thay đổi, lưu lại.
async function mutate(fn) {
  const store = await Store.open();
  const result = await fn(store);
  await store.save();
  return result;
}

// ----- Các đường dẫn không cần đăng nhập -----

// Webhook Zalo: xác thực bằng header bí mật riêng.
app.post('/api/zalo/webhook', wrap(async (req, res) => {
  await Store.open(); // nạp token Zalo nhập trên web (nếu có)
  const secret = webhookSecret();
  if (!secret || !safeEqual(req.get('X-Bot-Api-Secret-Token') || '', secret)) return res.sendStatus(403);
  // Trả lời Zalo ngay, xử lý tiếp ở nền (Vercel giữ hàm chạy nhờ waitUntil).
  const job = handleUpdate(req.body).catch((err) => console.warn('[zalo] webhook:', err.message));
  waitUntil(job);
  res.json({ ok: true });
}));

// Cron: Vercel Cron gửi "Authorization: Bearer <CRON_SECRET>"; cron-job.org có thể dùng ?key=
app.get('/api/cron', wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '') || req.query.key || '';
    if (!safeEqual(given, secret)) throw fail(401, 'Sai CRON_SECRET');
  }
  res.json(await runCron());
}));

// Đăng ký lịch từ ứng dụng lịch (Google Calendar, iPhone...) bằng khoá trong URL.
app.get('/calendar.ics', wrap(async (req, res) => {
  const store = await Store.open();
  const key = calendarKey(store);
  if (key && !safeEqual(req.query.key || '', key)) throw fail(401, 'Sai khoá lịch');
  const esc = (s) => String(s || '').replace(/([\\;,])/g, '\\$1').replace(/\r?\n/g, '\\n');
  const fmt = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//quanlythoigian//VI', 'X-WR-CALNAME:Quản lý thời gian'];
  for (const e of store.data.events.filter((x) => x.origin !== 'ics')) {
    lines.push('BEGIN:VEVENT', `UID:${e.id}@quanlythoigian`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(e.start)}`,
      `DTEND:${fmt(e.end || new Date(new Date(e.start).getTime() + 3600e3))}`, `SUMMARY:${esc(e.title)}`);
    if (e.note) lines.push(`DESCRIPTION:${esc(e.note)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.type('text/calendar').send(lines.join('\r\n'));
}));

// ----- Đăng nhập -----
const COOKIE = 'qltg_session';
function readCookie(req, name) {
  const m = (req.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}
function setSession(req, res, store, username) {
  res.cookie(COOKIE, sessionCookieValue(store, username), {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 24 * 3600 * 1000, path: '/',
  });
}
const slowDown = () => new Promise((r) => setTimeout(r, 800)); // làm chậm việc đoán mật khẩu

// Cho giao diện biết cần hiện màn hình nào: đăng nhập, tạo tài khoản, hay cần kết nối lưu trữ.
function setupState(store) {
  const mode = authMode(store);
  return {
    mode,
    // Trên Vercel phải có Upstash Redis trước, nếu không tài khoản sẽ mất khi máy chủ khởi động lại.
    needsStorage: mode === 'none' && isVercel && storageKind() === 'tmp',
    needsAdmin: mode === 'none',
    usernameRequired: mode === 'db' || (mode === 'env' && Boolean(process.env.ADMIN_USERNAME)),
  };
}
app.get('/api/auth/status', wrap(async (req, res) => {
  const store = await Store.open();
  res.json({ ...setupState(store), loggedIn: verifySession(store, readCookie(req, COOKIE)) });
}));

// Tạo tài khoản quản trị lần đầu (chỉ khi chưa có tài khoản nào).
app.post('/api/setup', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const problem = validateNew(username, password);
  if (problem) throw fail(400, problem);
  const store = await Store.open();
  const st = setupState(store);
  if (!st.needsAdmin) throw fail(409, 'Đã có tài khoản quản trị. Hãy đăng nhập.');
  if (st.needsStorage) throw fail(409, 'Cần kết nối Upstash Redis trước khi tạo tài khoản');
  const user = await createAdmin(store, username, password);
  await store.save();
  setSession(req, res, store, user);
  res.json({ ok: true, username: user });
}));

app.post('/api/login', wrap(async (req, res) => {
  const store = await Store.open();
  if (authMode(store) === 'none') throw fail(409, 'Chưa có tài khoản quản trị');
  const user = await checkLogin(store, req.body?.username, req.body?.password);
  if (!user) {
    await slowDown();
    throw fail(401, setupState(store).usernameRequired ? 'Sai tên đăng nhập hoặc mật khẩu' : 'Sai mật khẩu');
  }
  setSession(req, res, store, user);
  res.json({ ok: true, username: user });
}));
app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.use('/api', wrap(async (req, res, next) => {
  const store = await Store.open();
  const st = setupState(store);
  if (st.needsAdmin) {
    // Trên máy cá nhân cho dùng luôn; trên mạng công khai (Vercel) bắt buộc tạo tài khoản trước.
    if (!isVercel) return next();
    return res.status(503).json({ error: 'Cần tạo tài khoản quản trị', setup: true, ...st });
  }
  if (verifySession(store, readCookie(req, COOKIE))) return next();
  res.status(401).json({ error: 'Cần đăng nhập', login: true, usernameRequired: st.usernameRequired });
}));

// Đổi mật khẩu (tài khoản tạo trên web).
app.post('/api/account/password', wrap(async (req, res) => {
  const { current, next: newPassword } = req.body || {};
  const store = await Store.open();
  if (authMode(store) !== 'db') throw fail(400, 'Mật khẩu đang đặt bằng APP_PASSWORD trong cấu hình máy chủ');
  if (!(await verifyPassword(current, store.data.auth.admin))) { await slowDown(); throw fail(401, 'Mật khẩu hiện tại không đúng'); }
  const problem = validateNew(store.data.auth.admin.username, newPassword);
  if (problem) throw fail(400, problem);
  await changePassword(store, newPassword);
  await store.save();
  setSession(req, res, store, store.data.auth.admin.username); // phiên cũ ở máy khác hết hiệu lực
  res.json({ ok: true });
}));

// ----- Trạng thái tổng -----
app.get('/api/state', wrap(async (req, res) => {
  const store = await Store.open();
  const d = store.data;
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    today: dayKey(), tz: TZ,
    events: d.events, tasks: d.tasks, goals: d.goals, suggestions: d.suggestions, sources: d.sources,
    pomodoros: d.pomodoros.filter((p) => Date.now() - new Date(p.at) < 30 * 24 * 3600 * 1000),
    config: {
      gemini: geminiConfigured(),
      geminiModel: cfg('GEMINI_MODEL') || DEFAULT_MODEL,
      keys: Object.fromEntries(['GEMINI_API_KEY', 'ZALO_BOT_TOKEN', 'GEMINI_MODEL'].map((k) => [k, {
        source: cfgSource(k), masked: k === 'GEMINI_MODEL' ? cfg(k) : mask(cfg(k)),
      }])),
      zalo: zaloConfigured(),
      zaloMode: isVercel ? 'webhook' : process.env.ZALO_MODE || 'polling',
      zaloOwner: ownerChatId(store) ? { name: d.meta.zaloName || null, fromEnv: Boolean(process.env.ZALO_CHAT_ID) } : null,
      storage: storageKind(),
      vercel: isVercel,
      auth: { mode: authMode(store), username: adminName(store) },
      calendarUrl: `${base}/calendar.ics${calendarKey(store) ? `?key=${calendarKey(store)}` : ''}`,
      cronUrl: `${base}/api/cron${process.env.CRON_SECRET ? '?key=<CRON_SECRET>' : ''}`,
    },
  });
}));

// ----- Sự kiện -----
const EVENT_FIELDS = ['title', 'start', 'end', 'allDay', 'note'];
app.post('/api/events', wrap(async (req, res) => {
  const e = { id: newId(), allDay: false, note: '', origin: 'manual', ...pick(req.body, EVENT_FIELDS) };
  if (!e.title || !e.start) throw fail(400, 'Cần tiêu đề và thời gian bắt đầu');
  await mutate((s) => s.data.events.push(e));
  res.json(e);
}));
app.patch('/api/events/:id', wrap(async (req, res) => {
  res.json(await mutate((s) => {
    const e = findOr404(s.data.events, req.params.id);
    if (e.origin === 'ics') throw fail(400, 'Sự kiện từ nguồn ICS chỉ sửa được ở lịch gốc');
    return Object.assign(e, pick(req.body, EVENT_FIELDS));
  }));
}));
app.delete('/api/events/:id', wrap(async (req, res) => {
  await mutate((s) => { s.data.events = s.data.events.filter((e) => e.id !== req.params.id); });
  res.json({ ok: true });
}));

// ----- Việc cần làm -----
const TASK_FIELDS = ['title', 'quadrant', 'deadline', 'done', 'note'];
app.post('/api/tasks', wrap(async (req, res) => {
  const t = { id: newId(), quadrant: 2, deadline: null, done: false, note: '', origin: 'manual',
    createdAt: new Date().toISOString(), ...pick(req.body, TASK_FIELDS) };
  if (!t.title) throw fail(400, 'Cần tên công việc');
  await mutate((s) => s.data.tasks.push(t));
  res.json(t);
}));
app.patch('/api/tasks/:id', wrap(async (req, res) => {
  res.json(await mutate((s) => {
    const t = findOr404(s.data.tasks, req.params.id);
    Object.assign(t, pick(req.body, TASK_FIELDS));
    if ('done' in req.body) t.doneAt = req.body.done ? new Date().toISOString() : null;
    return t;
  }));
}));
app.delete('/api/tasks/:id', wrap(async (req, res) => {
  await mutate((s) => { s.data.tasks = s.data.tasks.filter((t) => t.id !== req.params.id); });
  res.json({ ok: true });
}));

// ----- Mục tiêu trong ngày -----
app.put('/api/goals/:date', wrap(async (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) throw fail(400, 'Ngày không hợp lệ');
  await mutate((s) => { s.data.goals[req.params.date] = (req.body.goals || []).slice(0, 3).map((g) => String(g || '')); });
  res.json({ ok: true });
}));

// ----- Pomodoro -----
app.post('/api/pomodoros', wrap(async (req, res) => {
  const p = { at: new Date().toISOString(), minutes: Number(req.body.minutes) || 25, taskId: req.body.taskId || null };
  await mutate((s) => s.data.pomodoros.push(p));
  res.json(p);
}));

// ----- AI trích lịch & hàng chờ đề xuất -----
app.post('/api/extract', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw fail(400, 'Chưa có nội dung');
  const items = await extractItems(text);
  const added = await mutate((s) => s.addSuggestions(items, 'paste'));
  res.json({ found: items.length, added });
}));
app.post('/api/suggestions/approve-all', wrap(async (req, res) => {
  const approved = await mutate((s) => {
    const ids = s.data.suggestions.map((x) => x.id);
    ids.forEach((id) => s.approveSuggestion(id));
    return ids.length;
  });
  res.json({ approved });
}));
app.post('/api/suggestions/:id/approve', wrap(async (req, res) => {
  const fields = pick(req.body || {}, ['title', 'start', 'end', 'deadline', 'quadrant', 'kind', 'note']);
  const r = await mutate((s) => s.approveSuggestion(req.params.id, fields));
  if (!r) throw fail(404, 'Không tìm thấy đề xuất');
  res.json(r);
}));
app.post('/api/suggestions/:id/reject', wrap(async (req, res) => {
  if (!(await mutate((s) => s.rejectSuggestion(req.params.id)))) throw fail(404, 'Không tìm thấy đề xuất');
  res.json({ ok: true });
}));

// ----- Nguồn tự động -----
app.post('/api/sources', wrap(async (req, res) => {
  const { type, name, url } = req.body;
  if (!['ics', 'web'].includes(type)) throw fail(400, 'Loại nguồn phải là ics hoặc web');
  let u;
  try { u = new URL(String(url).trim().replace(/^webcal:/i, 'https:')); } catch { throw fail(400, 'URL không hợp lệ'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw fail(400, 'Chỉ hỗ trợ http/https');
  const src = { id: newId(), type, name: name || u.hostname, url: u.href, lastSync: null, lastError: null, lastHash: null };
  await mutate((s) => s.data.sources.push(src));
  const results = await syncSources(Store.open, { ids: [src.id] });
  res.json({ source: src, result: results[src.id] });
}));
app.delete('/api/sources/:id', wrap(async (req, res) => {
  await mutate((s) => {
    s.data.sources = s.data.sources.filter((x) => x.id !== req.params.id);
    s.data.events = s.data.events.filter((e) => e.sourceId !== req.params.id);
  });
  res.json({ ok: true });
}));
app.post('/api/sources/sync', wrap(async (req, res) => res.json(await syncSources(Store.open))));
app.post('/api/sources/:id/sync', wrap(async (req, res) => {
  const results = await syncSources(Store.open, { ids: [req.params.id] });
  if (!results[req.params.id]) throw fail(404, 'Không tìm thấy nguồn');
  res.json(results[req.params.id]);
}));

// ----- Khoá API nhập trên web -----
// Gửi chuỗi rỗng để xoá (quay về dùng biến môi trường nếu có); bỏ qua trường không gửi.
app.put('/api/settings/keys', wrap(async (req, res) => {
  const body = req.body || {};
  const fields = { geminiApiKey: 'GEMINI_API_KEY', zaloBotToken: 'ZALO_BOT_TOKEN', geminiModel: 'GEMINI_MODEL' };
  const store = await Store.open();
  const settings = { ...store.data.settings };
  const changed = [];
  for (const [field, name] of Object.entries(fields)) {
    if (!(field in body)) continue;
    const value = String(body[field] ?? '').trim();
    if (/\s/.test(value)) throw fail(400, `${name} không được chứa khoảng trắng`);
    if (value) settings[field] = value; else delete settings[field];
    changed.push(field);
  }
  store.data.settings = settings;
  await store.save();
  await Store.open(); // áp dụng giá trị mới

  // Kiểm tra ngay để báo cho người dùng key có dùng được không.
  const result = { saved: changed };
  if (changed.includes('geminiApiKey') || changed.includes('geminiModel')) result.gemini = await checkGemini();
  if (changed.includes('zaloBotToken') && zaloConfigured()) {
    try {
      const me = await getMe();
      result.zalo = { ok: true, name: me?.display_name || me?.account_name || me?.name || null };
      // Token mới → đăng ký lại webhook (chuỗi bí mật sinh từ token) khi chạy trên https.
      const base = `${req.protocol}://${req.get('host')}`;
      if (isVercel || (process.env.ZALO_MODE === 'webhook' && base.startsWith('https://'))) {
        try { await setWebhook(`${base}/api/zalo/webhook`); result.zalo.webhook = true; } catch (err) { result.zalo.webhookError = err.message; }
      }
    } catch (err) {
      result.zalo = { ok: false, error: err.message };
    }
  }
  res.json(result);
}));

// ----- Zalo -----
const needZalo = () => { if (!zaloConfigured()) throw fail(400, 'Chưa cấu hình ZALO_BOT_TOKEN'); };
app.get('/api/zalo/me', wrap(async (req, res) => { needZalo(); res.json(await getMe()); }));
app.post('/api/zalo/webhook-setup', wrap(async (req, res) => {
  needZalo();
  const base = String(req.body.baseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  if (!base.startsWith('https://')) throw fail(400, 'Webhook cần địa chỉ https công khai (ví dụ trang Vercel của bạn)');
  const url = `${base}/api/zalo/webhook`;
  res.json({ url, result: await setWebhook(url) });
}));
// Tạo mã ghép nối: gửi "/ketnoi <mã>" cho bot để bot biết bạn là chủ.
app.post('/api/zalo/pair', wrap(async (req, res) => {
  needZalo();
  const code = String(crypto.randomInt(100000, 1000000));
  await mutate((s) => {
    s.data.meta.pairCode = code;
    s.data.meta.pairExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  });
  res.json({ code, expiresInMinutes: 15 });
}));
app.post('/api/zalo/unpair', wrap(async (req, res) => {
  await mutate((s) => { s.data.meta.zaloChatId = null; s.data.meta.zaloName = null; });
  res.json({ ok: true });
}));
app.post('/api/zalo/test', wrap(async (req, res) => {
  needZalo();
  const chatId = ownerChatId(await Store.open());
  if (!chatId) throw fail(400, 'Chưa kết nối Zalo: lấy mã ghép nối rồi gửi /ketnoi <mã> cho bot');
  await sendMessage(chatId, '✅ Kết nối thành công! Bot sẽ nhắc việc cho bạn ở đây.');
  res.json({ ok: true });
}));
app.post('/api/cron/run', wrap(async (req, res) => res.json(await runCron({ forceSync: true }))));

app.use('/api', (req, res) => res.status(404).json({ error: 'Không có API này' }));

// Giao diện tĩnh (trên Vercel thư mục public/ được phục vụ trực tiếp, đây là dự phòng).
app.use(express.static(path.join(root, 'public')));

export default app;
