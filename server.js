import './src/env.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Store, newId } from './src/db.js';
import { extractItems, geminiConfigured } from './src/gemini.js';
import { syncAll, syncSource } from './src/sources.js';
import { getMe, handleUpdate, sendMessage, setWebhook, startPolling, zaloConfigured } from './src/zalo.js';
import { startScheduler } from './src/scheduler.js';
import { dayKey, TZ } from './src/time.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const store = new Store(process.env.DATA_FILE || path.join(root, 'data', 'db.json'));
const app = express();
app.use(express.json({ limit: '1mb' }));

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Webhook Zalo nằm trước lớp mật khẩu: Zalo xác thực bằng header bí mật riêng.
app.post('/api/zalo/webhook', async (req, res) => {
  const secret = process.env.ZALO_WEBHOOK_SECRET;
  if (!secret || !safeEqual(req.get('X-Bot-Api-Secret-Token') || '', secret)) return res.sendStatus(403);
  res.json({ ok: true });
  handleUpdate(store, req.body).catch((err) => console.warn('[zalo] webhook:', err.message));
});

// Mật khẩu đơn giản (HTTP Basic) cho toàn bộ web khi đặt APP_PASSWORD.
app.use((req, res, next) => {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return next();
  const [, b64] = (req.get('Authorization') || '').split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  if (safeEqual(pass, pw)) return next();
  res.set('WWW-Authenticate', 'Basic realm="quanlythoigian", charset="UTF-8"').sendStatus(401);
});

app.use(express.static(path.join(root, 'public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  res.status(err.status || 500).json({ error: err.message });
});
const fail = (status, message) => Object.assign(new Error(message), { status });
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
const findOr404 = (list, id) => list.find((x) => x.id === id) || (() => { throw fail(404, 'Không tìm thấy'); })();

app.get('/api/state', (req, res) => {
  const d = store.data;
  res.json({
    today: dayKey(), tz: TZ,
    events: d.events, tasks: d.tasks, goals: d.goals, suggestions: d.suggestions, sources: d.sources,
    pomodoros: d.pomodoros.filter((p) => Date.now() - new Date(p.at) < 30 * 24 * 3600 * 1000),
    config: {
      gemini: geminiConfigured(), zalo: zaloConfigured(), zaloChatId: Boolean(process.env.ZALO_CHAT_ID),
      zaloMode: process.env.ZALO_MODE || 'polling',
    },
  });
});

// ----- Sự kiện -----
const EVENT_FIELDS = ['title', 'start', 'end', 'allDay', 'note'];
app.post('/api/events', wrap((req, res) => {
  const e = { id: newId(), allDay: false, note: '', origin: 'manual', ...pick(req.body, EVENT_FIELDS) };
  if (!e.title || !e.start) throw fail(400, 'Cần tiêu đề và thời gian bắt đầu');
  store.data.events.push(e); store.save(); res.json(e);
}));
app.patch('/api/events/:id', wrap((req, res) => {
  const e = findOr404(store.data.events, req.params.id);
  Object.assign(e, pick(req.body, EVENT_FIELDS)); store.save(); res.json(e);
}));
app.delete('/api/events/:id', wrap((req, res) => {
  store.data.events = store.data.events.filter((e) => e.id !== req.params.id); store.save(); res.json({ ok: true });
}));

// ----- Việc cần làm -----
const TASK_FIELDS = ['title', 'quadrant', 'deadline', 'done', 'note'];
app.post('/api/tasks', wrap((req, res) => {
  const t = { id: newId(), quadrant: 2, deadline: null, done: false, note: '', origin: 'manual',
    createdAt: new Date().toISOString(), ...pick(req.body, TASK_FIELDS) };
  if (!t.title) throw fail(400, 'Cần tên công việc');
  store.data.tasks.push(t); store.save(); res.json(t);
}));
app.patch('/api/tasks/:id', wrap((req, res) => {
  const t = findOr404(store.data.tasks, req.params.id);
  Object.assign(t, pick(req.body, TASK_FIELDS));
  if ('done' in req.body) t.doneAt = req.body.done ? new Date().toISOString() : null;
  store.save(); res.json(t);
}));
app.delete('/api/tasks/:id', wrap((req, res) => {
  store.data.tasks = store.data.tasks.filter((t) => t.id !== req.params.id); store.save(); res.json({ ok: true });
}));

// ----- Mục tiêu trong ngày -----
app.put('/api/goals/:date', wrap((req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) throw fail(400, 'Ngày không hợp lệ');
  store.data.goals[req.params.date] = (req.body.goals || []).slice(0, 3).map((g) => String(g || ''));
  store.save(); res.json({ ok: true });
}));

// ----- Pomodoro -----
app.post('/api/pomodoros', wrap((req, res) => {
  const p = { at: new Date().toISOString(), minutes: Number(req.body.minutes) || 25, taskId: req.body.taskId || null };
  store.data.pomodoros.push(p); store.save(); res.json(p);
}));

// ----- AI trích lịch & hàng chờ đề xuất -----
app.post('/api/extract', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw fail(400, 'Chưa có nội dung');
  const items = await extractItems(text);
  const added = store.addSuggestions(items, 'paste');
  res.json({ found: items.length, added });
}));
app.post('/api/suggestions/approve-all', wrap((req, res) => {
  const ids = store.data.suggestions.map((s) => s.id);
  ids.forEach((id) => store.approveSuggestion(id));
  res.json({ approved: ids.length });
}));
app.post('/api/suggestions/:id/approve', wrap((req, res) => {
  const r = store.approveSuggestion(req.params.id, pick(req.body || {}, ['title', 'start', 'end', 'deadline', 'quadrant', 'kind', 'note']));
  if (!r) throw fail(404, 'Không tìm thấy đề xuất');
  res.json(r);
}));
app.post('/api/suggestions/:id/reject', wrap((req, res) => {
  if (!store.rejectSuggestion(req.params.id)) throw fail(404, 'Không tìm thấy đề xuất');
  res.json({ ok: true });
}));

// ----- Nguồn tự động -----
app.post('/api/sources', wrap(async (req, res) => {
  const { type, name, url } = req.body;
  if (!['ics', 'web'].includes(type)) throw fail(400, 'Loại nguồn phải là ics hoặc web');
  let u;
  try { u = new URL(String(url).replace(/^webcal:/i, 'https:')); } catch { throw fail(400, 'URL không hợp lệ'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw fail(400, 'Chỉ hỗ trợ http/https');
  const s = { id: newId(), type, name: name || u.hostname, url: u.href, lastSync: null, lastError: null, lastHash: null };
  store.data.sources.push(s); store.save();
  const result = await syncSource(store, s);
  res.json({ source: s, result });
}));
app.delete('/api/sources/:id', wrap((req, res) => {
  store.data.sources = store.data.sources.filter((s) => s.id !== req.params.id);
  store.data.events = store.data.events.filter((e) => e.sourceId !== req.params.id);
  store.save(); res.json({ ok: true });
}));
app.post('/api/sources/sync', wrap(async (req, res) => res.json(await syncAll(store))));
app.post('/api/sources/:id/sync', wrap(async (req, res) => {
  res.json(await syncSource(store, findOr404(store.data.sources, req.params.id)));
}));

// ----- Zalo -----
app.get('/api/zalo/me', wrap(async (req, res) => {
  if (!zaloConfigured()) throw fail(400, 'Chưa cấu hình ZALO_BOT_TOKEN');
  res.json(await getMe());
}));
app.post('/api/zalo/webhook-setup', wrap(async (req, res) => {
  if (!zaloConfigured()) throw fail(400, 'Chưa cấu hình ZALO_BOT_TOKEN');
  if (!process.env.ZALO_WEBHOOK_SECRET) throw fail(400, 'Cần đặt ZALO_WEBHOOK_SECRET trước');
  const url = `${String(req.body.baseUrl || '').replace(/\/$/, '')}/api/zalo/webhook`;
  if (!url.startsWith('https://')) throw fail(400, 'Webhook cần URL https công khai');
  res.json({ url, result: await setWebhook(url) });
}));
app.post('/api/zalo/test', wrap(async (req, res) => {
  if (!zaloConfigured() || !process.env.ZALO_CHAT_ID) throw fail(400, 'Cần ZALO_BOT_TOKEN và ZALO_CHAT_ID');
  await sendMessage(process.env.ZALO_CHAT_ID, '✅ Kết nối thành công! Bot sẽ nhắc việc cho bạn ở đây.');
  res.json({ ok: true });
}));

// ----- Xuất lịch dạng ICS (đăng ký vào Google Calendar / điện thoại) -----
app.get('/calendar.ics', (req, res) => {
  const esc = (s) => String(s || '').replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n');
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
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Quản lý thời gian chạy tại http://localhost:${port}`);
  console.log(`Gemini: ${geminiConfigured() ? 'đã cấu hình' : 'CHƯA cấu hình'} | Zalo: ${zaloConfigured() ? process.env.ZALO_MODE || 'polling' : 'CHƯA cấu hình'}`);
  startScheduler(store);
  if (zaloConfigured() && (process.env.ZALO_MODE || 'polling') === 'polling') startPolling(store);
});
