// Ứng dụng Express: API + giao diện. Dùng chung cho chạy trên máy (server.js) và Vercel (api/index.js).
import './env.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { waitUntil } from '@vercel/functions';
import { Store, newId } from './db.js';
import { DEFAULT_MODEL, extractItems, geminiConfigured } from './gemini.js';
import { syncSources } from './sources.js';
import { runCron } from './cron.js';
import { storageKind } from './storage.js';
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
const hmac = (purpose) => crypto.createHmac('sha256', process.env.APP_PASSWORD || '').update(purpose).digest('hex');
const sessionToken = () => hmac('session-v1');
const calendarKey = () => hmac('calendar-v1').slice(0, 32);

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
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
app.post('/api/zalo/webhook', (req, res) => {
  const secret = webhookSecret();
  if (!secret || !safeEqual(req.get('X-Bot-Api-Secret-Token') || '', secret)) return res.sendStatus(403);
  // Trả lời Zalo ngay, xử lý tiếp ở nền (Vercel giữ hàm chạy nhờ waitUntil).
  const job = handleUpdate(req.body).catch((err) => console.warn('[zalo] webhook:', err.message));
  waitUntil(job);
  res.json({ ok: true });
});

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
  if (process.env.APP_PASSWORD && !safeEqual(req.query.key || '', calendarKey())) throw fail(401, 'Sai khoá lịch');
  const store = await Store.open();
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
app.post('/api/login', wrap(async (req, res) => {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return res.json({ ok: true });
  if (!safeEqual(String(req.body.password || ''), pw)) {
    await new Promise((r) => setTimeout(r, 800)); // làm chậm đoán mật khẩu
    throw fail(401, 'Sai mật khẩu');
  }
  res.cookie(COOKIE, sessionToken(), {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 24 * 3600 * 1000, path: '/',
  });
  res.json({ ok: true });
}));
app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  const pw = process.env.APP_PASSWORD;
  if (!pw) {
    // Trên mạng công khai (Vercel) bắt buộc có mật khẩu, nếu không ai cũng xem được lịch của bạn.
    if (isVercel) return res.status(503).json({ error: 'Chưa đặt APP_PASSWORD trong Vercel → Settings → Environment Variables', setup: true });
    return next();
  }
  if (safeEqual(readCookie(req, COOKIE), sessionToken())) return next();
  res.status(401).json({ error: 'Cần đăng nhập', login: true });
});

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
      geminiModel: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      zalo: zaloConfigured(),
      zaloMode: isVercel ? 'webhook' : process.env.ZALO_MODE || 'polling',
      zaloOwner: ownerChatId(store) ? { name: d.meta.zaloName || null, fromEnv: Boolean(process.env.ZALO_CHAT_ID) } : null,
      storage: storageKind(),
      vercel: isVercel,
      auth: Boolean(process.env.APP_PASSWORD),
      calendarUrl: `${base}/calendar.ics${process.env.APP_PASSWORD ? `?key=${calendarKey()}` : ''}`,
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
