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
import {
  authUrl, exchangeCode, googleConfigured, isGoogleReady, listCalendars, pullGoogle, pushGoogle, revoke, syncGoogle,
} from './google.js';
import { syncSources } from './sources.js';
import { runCron } from './cron.js';
import { storageKind } from './storage.js';
import {
  adminName, authMode, calendarKey, changePassword, checkLogin, createAdmin, sessionCookieValue, validateNew,
  verifyPassword, verifySession,
} from './auth.js';
import {
  dayAgenda, deleteWebhook, getMe, handleText, handleUpdate, ownerChatId, sendMessage, setWebhook, webhookSecret, zaloConfigured, zaloReceiver,
} from './zalo.js';
import { dayKey, TZ, zonedMidnight } from './time.js';
import { kv } from './kv.js';
import {
  acceptTerms, commandsAfter, createZaloCode, deleteMember, getMember, linkZalo, listMembers, memberCookieValue, memberSettings,
  publicMember, saveMemberSettings, signInMember, TERMS_VERSION, touchSeen, unlinkZalo, verifyMemberCookie,
} from './members.js';
import { assign, cancel as cancelAssignment, status as assignmentStatus, update as updateAssignment } from './calbot.js';
import { logToCsv, readLog, recordFetched } from './calbot-log.js';
import {
  addSessionEvents, botStatus, CONFIG_SCHEMA, configForBot, getConfig, heartbeat, readSession, saveConfig, sessionChats,
  sessionRetentionDays,
} from './system.js';

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
  res.status(err.status || 500).json({ error: err.message, ...err.extra });
});
const fail = (status, message, extra) => Object.assign(new Error(message), { status, extra });
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

// ----- API cho AI agent khác (vd agent đang giữ bot Zalo) — xác thực bằng khoá riêng, không cần đăng nhập -----
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// Mã băm của khoá nằm ở kho khoá–giá trị và được nhớ 30 giây: nhịp tim, session, giao lịch không phải đọc cả kho dữ liệu.
let agentHashCache = { hash: undefined, at: 0 };
async function agentTokenHash() {
  if (agentHashCache.hash !== undefined && Date.now() - agentHashCache.at < 30_000) return agentHashCache.hash;
  let hash = (await kv.get('agent-token'))?.hash || null;
  if (!hash) {
    // Khoá tạo từ bản trước chỉ nằm trong kho chính: chép sang.
    const settings = (await Store.open()).data.settings || {};
    hash = settings.agentTokenHash || null;
    if (hash) await kv.set('agent-token', { hash, at: settings.agentTokenAt || null });
  }
  agentHashCache = { hash, at: Date.now() };
  return hash;
}
async function agentAuth(req) {
  const hash = await agentTokenHash();
  const given = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '') || req.get('X-Api-Key') || '';
  if (!hash || !given || !safeEqual(sha256(given), hash)) throw fail(401, 'Sai hoặc thiếu khoá API (Authorization: Bearer <khoá>)');
}
async function agentStore(req) {
  await agentAuth(req);
  return Store.open();
}
function dateFromQuery(q) {
  if (q === 'tomorrow' || q === 'mai') return new Date(Date.now() + 24 * 3600 * 1000);
  if (/^\d{4}-\d{2}-\d{2}$/.test(q || '')) return new Date(new Date(zonedMidnight(q)).getTime() + 12 * 3600 * 1000);
  return new Date();
}

// Chuyển nguyên tin nhắn người dùng sang đây; nhận lại câu trả lời để agent gửi lại cho người dùng.
// Hiểu các lệnh /homnay, /mai, /viec, /cho, /duyet, /bo, /ketnoi và nội dung tự do (AI trích lịch).
app.post('/api/agent/message', wrap(async (req, res) => {
  await agentStore(req);
  const text = String(req.body?.text || '').trim();
  if (!text) throw fail(400, 'Thiếu "text"');
  const chatId = req.body?.chatId ? String(req.body.chatId) : null;
  const items = !text.startsWith('/') && geminiConfigured() ? await extractItems(text) : undefined;
  const store = await Store.open();
  const reply = await handleText(store, chatId, text, { name: req.body?.name, items, trusted: true });
  await store.save();
  if (/^\/duyet/i.test(text)) kickGoogle();
  res.json({ reply });
}));
app.get('/api/agent/agenda', wrap(async (req, res) => {
  const store = await agentStore(req);
  const date = dateFromQuery(String(req.query.date || 'today'));
  const key = dayKey(date);
  res.json({
    date: key,
    text: dayAgenda(store, date),
    events: store.data.events.filter((e) => dayKey(e.start) === key).sort((a, b) => a.start.localeCompare(b.start))
      .map(({ title, start, end, allDay, note, origin }) => ({ title, start, end, allDay, note, origin })),
    dueTasks: store.data.tasks.filter((t) => !t.done && t.deadline && dayKey(t.deadline) <= key)
      .map(({ id, title, deadline, quadrant }) => ({ id, title, deadline, quadrant })),
    pendingSuggestions: store.data.suggestions.length,
  });
}));
app.get('/api/agent/tasks', wrap(async (req, res) => {
  const store = await agentStore(req);
  res.json(store.data.tasks.filter((t) => !t.done).sort((a, b) => a.quadrant - b.quadrant)
    .map(({ id, title, deadline, quadrant, note }) => ({ id, title, deadline, quadrant, note })));
}));
app.post('/api/agent/events', wrap(async (req, res) => {
  await agentStore(req);
  const e = { id: newId(), allDay: false, note: '', origin: 'agent', ...pick(req.body || {}, ['title', 'start', 'end', 'allDay', 'note']) };
  if (!e.title || !e.start || Number.isNaN(new Date(e.start).getTime())) throw fail(400, 'Cần "title" và "start" (ISO 8601, vd 2026-10-30T14:00:00+07:00)');
  e.start = new Date(e.start).toISOString();
  if (e.end) e.end = new Date(e.end).toISOString();
  await mutate((s) => s.data.events.push(e));
  kickGoogle();
  res.json(e);
}));
app.post('/api/agent/tasks', wrap(async (req, res) => {
  await agentStore(req);
  const t = { id: newId(), quadrant: 2, deadline: null, done: false, note: '', origin: 'agent', createdAt: new Date().toISOString(),
    ...pick(req.body || {}, ['title', 'quadrant', 'deadline', 'note']) };
  if (!t.title) throw fail(400, 'Cần "title"');
  if (t.deadline) t.deadline = new Date(t.deadline).toISOString();
  await mutate((s) => s.data.tasks.push(t));
  res.json(t);
}));
app.patch('/api/agent/tasks/:id', wrap(async (req, res) => {
  await agentStore(req);
  res.json(await mutate((s) => {
    const t = findOr404(s.data.tasks, req.params.id);
    Object.assign(t, pick(req.body || {}, ['title', 'quadrant', 'deadline', 'done', 'note']));
    if ('done' in (req.body || {})) t.doneAt = req.body.done ? new Date().toISOString() : null;
    return t;
  }));
}));
// ----- Bot lịch: agent giao lịch cho người được tag, liên kết Zalo, nhận cấu hình, gửi nhịp tim và session -----
const maskEmail = (e) => String(e || '').replace(/^(.{2})[^@]*(@.*)$/, '$1…$2');
const appUrl = (req) => `${baseUrl(req)}/app/`;

// Người dùng nhắn mã 6 số cho bot → agent chuyển sang đây cùng ID Zalo của người gửi.
app.post('/api/agent/zalo-link', wrap(async (req, res) => {
  await agentAuth(req);
  const u = await linkZalo(req.body || {});
  res.json({ ok: true, member: { name: u.name, email: maskEmail(u.email) }, appUrl: appUrl(req) });
}));
app.post('/api/agent/assign', wrap(async (req, res) => {
  await agentAuth(req);
  res.json({ ...(await assign(req.body)), appUrl: appUrl(req) });
}));
app.get('/api/agent/assign/:id', wrap(async (req, res) => {
  await agentAuth(req);
  res.json(await assignmentStatus(req.params.id));
}));
app.patch('/api/agent/assign/:id', wrap(async (req, res) => {
  await agentAuth(req);
  res.json({ ...(await updateAssignment(req.params.id, req.body || {})), appUrl: appUrl(req) });
}));
app.delete('/api/agent/assign/:id', wrap(async (req, res) => {
  await agentAuth(req);
  res.json(await cancelAssignment(req.params.id));
}));
// Thông số do chủ web chỉnh ở trang Hệ thống (không có khoá bí mật).
app.get('/api/agent/config', wrap(async (req, res) => {
  await agentAuth(req);
  res.json(configForBot(await getConfig()));
}));
// Mỗi phút: bot báo đang chạy; nhận lại cấu hình nếu đã đổi (so theo configVersion bot gửi lên).
app.post('/api/agent/heartbeat', wrap(async (req, res) => {
  await agentAuth(req);
  const { config } = await heartbeat(req.body || {});
  const same = Number(req.body?.configVersion) === config.version;
  res.json({ ok: true, version: config.version, config: same ? null : configForBot(config) });
}));
app.post('/api/agent/sessions', wrap(async (req, res) => {
  await agentAuth(req);
  const cfg = await getConfig();
  if (cfg.values.SESSION_UPLOAD === false) return res.json({ saved: 0, disabled: true });
  res.json(await addSessionEvents(req.body?.events, sessionRetentionDays(cfg)));
}));

// Mô tả API (OpenAPI) để nạp vào agent làm "công cụ".
app.get('/api/agent/openapi.json', (req, res) => {
  const bearer = [{ bearer: [] }];
  const body = (props, required) => ({ required: true, content: { 'application/json': { schema: { type: 'object', properties: props, required } } } });
  const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  const assignFields = {
    title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 có giờ; lịch cả ngày: YYYY-MM-DD' },
    end: { type: 'string' }, allDay: { type: 'boolean' }, note: { type: 'string' },
  };
  const assignees = { type: 'array', items: { type: 'object', properties: { zaloUid: { type: 'string' }, name: { type: 'string' } }, required: ['zaloUid'] } };
  const sourceSchema = { type: 'object', properties: { chatId: { type: 'string' }, chatName: { type: 'string' }, senderId: { type: 'string' }, senderName: { type: 'string' }, messageId: { type: 'string' } } };
  res.json({
    openapi: '3.0.3',
    info: { title: 'Quản lý thời gian', version: '1.0.0', description: 'Lịch, việc cần làm, đề xuất từ AI của người dùng. Thời gian dạng ISO 8601, múi giờ ' + TZ },
    servers: [{ url: `${baseUrl(req)}` }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: bearer,
    paths: {
      '/api/agent/message': { post: { operationId: 'handleScheduleMessage', summary: 'Gửi tin nhắn/lệnh của người dùng (vd "/homnay", "mai 9h họp", "/duyet all"); trả về câu trả lời để gửi lại người dùng',
        requestBody: body({ text: { type: 'string' }, chatId: { type: 'string', description: 'ID Zalo người gửi (cần cho /ketnoi)' } }, ['text']) } },
      '/api/agent/agenda': { get: { operationId: 'getAgenda', summary: 'Lịch và việc đến hạn của một ngày',
        parameters: [{ name: 'date', in: 'query', schema: { type: 'string' }, description: 'today | tomorrow | YYYY-MM-DD' }] } },
      '/api/agent/tasks': {
        get: { operationId: 'listTasks', summary: 'Các việc chưa xong' },
        post: { operationId: 'createTask', summary: 'Tạo việc cần làm', requestBody: body({ title: { type: 'string' }, deadline: { type: 'string', format: 'date-time' }, quadrant: { type: 'integer', enum: [1, 2, 3, 4] }, note: { type: 'string' } }, ['title']) },
      },
      '/api/agent/tasks/{id}': { patch: { operationId: 'updateTask', summary: 'Sửa / đánh dấu xong việc',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: body({ done: { type: 'boolean' }, title: { type: 'string' }, deadline: { type: 'string' }, quadrant: { type: 'integer' } }, []) } },
      '/api/agent/events': { post: { operationId: 'createEvent', summary: 'Tạo lịch hẹn (tự lên Google Lịch nếu đã kết nối)',
        requestBody: body({ title: { type: 'string' }, start: { type: 'string', format: 'date-time' }, end: { type: 'string', format: 'date-time' }, allDay: { type: 'boolean' }, note: { type: 'string' } }, ['title', 'start']) } },
      '/api/agent/zalo-link': { post: { operationId: 'linkZalo', summary: 'Liên kết Zalo của người gửi với tài khoản Gmail bằng mã 6 số họ lấy trong app',
        requestBody: body({ code: { type: 'string' }, zaloUid: { type: 'string' }, zaloName: { type: 'string' } }, ['code', 'zaloUid']) } },
      '/api/agent/assign': { post: { operationId: 'assignEvent', summary: 'Giao lịch cho những người được tag: tạo lệnh "thêm" cho app của từng người đã liên kết',
        requestBody: body({ ...assignFields, assignees: assignees, source: sourceSchema }, ['title', 'start', 'assignees']) } },
      '/api/agent/assign/{id}': {
        get: { operationId: 'assignmentStatus', summary: 'Tình trạng lịch đã giao: ai đã liên kết, app của ai đã lấy lệnh', parameters: [idParam] },
        patch: { operationId: 'updateAssignment', summary: 'Sửa lịch đã giao (giờ, tiêu đề, người nhận); người bị bỏ nhận lệnh xoá', parameters: [idParam],
          requestBody: body({ ...assignFields, assignees, add: assignees, remove: assignees }, []) },
        delete: { operationId: 'cancelAssignment', summary: 'Huỷ lịch đã giao: lệnh xoá cho mọi người đã nhận', parameters: [idParam] },
      },
      '/api/agent/config': { get: { operationId: 'getBotConfig', summary: 'Thông số bot do chủ web chỉnh (model, bộ lọc, giới hạn…), không có khoá bí mật' } },
      '/api/agent/heartbeat': { post: { operationId: 'heartbeat', summary: 'Báo bot đang chạy; trả về cấu hình mới nếu configVersion đã cũ',
        requestBody: body({ version: { type: 'string' }, configVersion: { type: 'integer' }, tokensToday: { type: 'integer' }, lastError: { type: 'string' } }, []) } },
      '/api/agent/sessions': { post: { operationId: 'uploadSessions', summary: 'Gửi các bước tin → bộ lọc → agent → tool để xem lại trên trang Hệ thống',
        requestBody: body({ events: { type: 'array', items: { type: 'object' } } }, ['events']) } },
    },
  });
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
    googleLogin: googleConfigured() && mode === 'db' && Boolean(store.data.auth.admin.google),
    googleSetup: googleConfigured() && mode === 'none' && !(isVercel && storageKind() === 'tmp'),
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

// ----- Đăng nhập / liên kết / Google Lịch qua tài khoản Google -----
const OAUTH_COOKIE = 'qltg_oauth';
const TERMS_COOKIE = 'qltg_terms';
const MEMBER_COOKIE = 'qltg_member';
const PURPOSES = ['login', 'setup', 'link', 'calendar', 'member'];
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
const redirectUri = (req) => `${baseUrl(req)}/api/google/callback`;
const backTo = (res, params) => res.redirect(`/?${new URLSearchParams(params)}`);
// Thành viên đăng nhập từ web app thì quay về /app/.
const backToApp = (res, params) => res.redirect(`/app/?${new URLSearchParams(params)}`);

// Tên đăng nhập gợi ý từ email: phần trước @, chỉ giữ ký tự hợp lệ.
function usernameFromEmail(email) {
  const u = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 32);
  return u.length >= 3 ? u : `${u}.user`.slice(0, 32);
}

app.get('/api/google/start', wrap(async (req, res) => {
  const purpose = String(req.query.purpose || '');
  if (!PURPOSES.includes(purpose)) throw fail(400, 'Mục đích không hợp lệ');
  const store = await Store.open();
  const back = purpose === 'member' ? backToApp : backTo;
  if (!googleConfigured()) return back(res, { google_error: purpose === 'member' ? 'Chủ hệ thống chưa cấu hình đăng nhập Google' : 'Chưa nhập Google Client ID/Secret ở Cài đặt → Khoá API' });
  if ((purpose === 'link' || purpose === 'calendar') && !verifySession(store, readCookie(req, COOKIE))) {
    return backTo(res, { google_error: 'Hãy đăng nhập trước' });
  }
  const short = { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60 * 1000, path: '/api/google' };
  // Thành viên mới tick "Tôi đồng ý" trước khi đăng nhập: nhớ phiên bản điều khoản đã đồng ý cho bước tạo tài khoản.
  if (purpose === 'member' && req.query.terms === TERMS_VERSION) res.cookie(TERMS_COOKIE, TERMS_VERSION, short);
  // Chống giả mạo (CSRF): mã ngẫu nhiên vừa nằm trong state vừa nằm trong cookie của trình duyệt này.
  const nonce = crypto.randomBytes(16).toString('hex');
  res.cookie(OAUTH_COOKIE, nonce, short);
  const loginHint = purpose === 'calendar' ? store.data.auth?.admin?.google?.email : undefined;
  res.redirect(authUrl({ redirectUri: redirectUri(req), state: `${purpose}.${nonce}`, purpose, loginHint }));
}));

app.get('/api/google/callback', wrap(async (req, res) => {
  const [purpose, nonce] = String(req.query.state || '').split('.');
  const expected = readCookie(req, OAUTH_COOKIE);
  const acceptedTerms = readCookie(req, TERMS_COOKIE);
  res.clearCookie(OAUTH_COOKIE, { path: '/api/google' });
  res.clearCookie(TERMS_COOKIE, { path: '/api/google' });
  const back = purpose === 'member' ? backToApp : backTo;
  if (req.query.error) return back(res, { google_error: req.query.error === 'access_denied' ? 'Bạn đã huỷ đăng nhập Google' : String(req.query.error) });
  if (!PURPOSES.includes(purpose) || !nonce || !expected || !safeEqual(nonce, expected)) {
    return back(res, { google_error: 'Phiên đăng nhập Google không hợp lệ, hãy thử lại' });
  }
  try {
    await Store.open(); // nạp Client ID/Secret
    const { claims, refreshToken } = await exchangeCode(String(req.query.code || ''), redirectUri(req));
    if (purpose === 'member') {
      const r = await signInMember(claims, { acceptedTerms });
      if (r.needsTerms) return backToApp(res, { google_error: 'Hãy đọc và đánh dấu đồng ý Điều khoản dịch vụ trước khi tạo tài khoản' });
      res.cookie(MEMBER_COOKIE, await memberCookieValue(r.user.id), {
        httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 180 * 24 * 3600 * 1000, path: '/',
      });
      return backToApp(res, { google: r.created ? 'member-new' : 'member' });
    }
    const store = await Store.open();
    const admin = store.data.auth?.admin;
    const loggedIn = verifySession(store, readCookie(req, COOKIE));

    if (purpose === 'login') {
      if (authMode(store) !== 'db' || admin.google?.sub !== claims.sub) {
        return backTo(res, { google_error: `Tài khoản Google ${claims.email} chưa được liên kết với web này` });
      }
      setSession(req, res, store, admin.username);
      return backTo(res, { google: 'login' });
    }
    if (purpose === 'setup') {
      const st = setupState(store);
      if (!st.needsAdmin || st.needsStorage) return backTo(res, { google_error: 'Đã có tài khoản quản trị, hãy đăng nhập' });
      const user = await createAdmin(store, usernameFromEmail(claims.email), crypto.randomBytes(24).toString('hex'));
      Object.assign(store.data.auth.admin, { noPassword: true, google: { sub: claims.sub, email: claims.email } });
      await store.save();
      setSession(req, res, store, user);
      return backTo(res, { google: 'setup' });
    }
    if (!loggedIn) return backTo(res, { google_error: 'Hãy đăng nhập trước' });
    if (purpose === 'link') {
      if (authMode(store) !== 'db') return backTo(res, { google_error: 'Chỉ liên kết được với tài khoản tạo trên web' });
      admin.google = { sub: claims.sub, email: claims.email };
      await store.save();
      return backTo(res, { google: 'linked' });
    }
    // purpose === 'calendar'
    if (!refreshToken) return backTo(res, { google_error: 'Google không cấp quyền dùng lâu dài. Vào myaccount.google.com/permissions gỡ quyền của ứng dụng rồi kết nối lại.' });
    if (store.data.google?.refreshToken) await revoke(store.data.google.refreshToken);
    let calendars = [{ id: 'primary', name: 'Lịch chính' }];
    try {
      const all = await listCalendars(refreshToken);
      const primary = all.find((c) => c.primary);
      if (primary) calendars = [{ id: primary.id, name: primary.name }];
    } catch { /* dùng lịch chính mặc định */ }
    store.data.google = { refreshToken, email: claims.email, calendars, push: true, connectedAt: new Date().toISOString(), pendingDeletes: [] };
    await store.save();
    await syncGoogle(Store.open);
    return backTo(res, { google: 'calendar' });
  } catch (err) {
    return back(res, { google_error: err.message });
  }
}));

// ----- Thành viên (web app /app) -----
// Chỉ dữ liệu của chính người đăng nhập: không liệt kê, không tìm kiếm, và không có API nào để gửi lịch ngược lên.
const signInNeeded = () => fail(401, 'Cần đăng nhập bằng Gmail', { signIn: true, termsVersion: TERMS_VERSION });
async function memberId(req) {
  const id = await verifyMemberCookie(readCookie(req, MEMBER_COOKIE));
  if (!id) throw signInNeeded();
  return id;
}
async function currentMember(req) {
  const u = await getMember(await memberId(req));
  if (!u) throw signInNeeded();
  return u;
}

app.get('/api/me', wrap(async (req, res) => {
  await Store.open(); // nạp Google Client ID nhập trên web
  let u;
  try {
    u = await currentMember(req);
  } catch (err) {
    err.extra = { ...err.extra, googleReady: googleConfigured() };
    throw err;
  }
  const settings = await memberSettings();
  res.json({
    ...publicMember(u), termsCurrent: TERMS_VERSION,
    bot: { name: settings.botName || null, chatUrl: settings.botChatUrl || null },
    googleClientId: cfg('GOOGLE_CLIENT_ID') || null,
  });
}));
app.post('/api/me/terms', wrap(async (req, res) => {
  res.json(publicMember(await acceptTerms(await memberId(req), req.body?.version)));
}));
app.post('/api/me/zalo-code', wrap(async (req, res) => {
  const u = await currentMember(req);
  const settings = await memberSettings();
  res.json({ ...(await createZaloCode(u.id)), botName: settings.botName || null, botChatUrl: settings.botChatUrl || null });
}));
// Nhẹ: app hỏi mỗi vài giây trong lúc chờ người dùng gửi mã cho bot.
app.get('/api/me/zalo', wrap(async (req, res) => {
  res.json({ zalo: publicMember(await currentMember(req)).zalo });
}));
app.delete('/api/me/zalo', wrap(async (req, res) => {
  res.json(publicMember(await unlinkZalo(await memberId(req))));
}));
// App hỏi lệnh mới (thêm / sửa / xoá lịch). Không có gì mới thì chỉ tốn một lượt đọc.
app.get('/api/me/commands', wrap(async (req, res) => {
  const id = await memberId(req);
  const r = await commandsAfter(id, req.query.after);
  if (!r) throw signInNeeded();
  touchSeen(id).catch(() => {});
  if (r.commands.length) {
    const u = await getMember(id);
    if (!u) throw signInNeeded();
    if (publicMember(u).needsTerms) throw fail(403, 'Điều khoản đã thay đổi, hãy đọc và đồng ý lại để nhận lịch mới', { needsTerms: true, termsVersion: TERMS_VERSION });
    await recordFetched(id, r.commands.map((c) => c.logId));
  }
  res.json(r);
}));
app.post('/api/me/logout', (req, res) => {
  res.clearCookie(MEMBER_COOKIE, { path: '/' });
  res.json({ ok: true });
});
app.delete('/api/me', wrap(async (req, res) => {
  await deleteMember(await memberId(req));
  res.clearCookie(MEMBER_COOKIE, { path: '/' });
  res.json({ ok: true });
}));
app.use('/api/me', (req, res) => res.status(404).json({ error: 'Không có API này' }));

app.use('/api', wrap(async (req, res, next) => {
  const store = await Store.open();
  const st = setupState(store);
  if (st.needsAdmin) {
    // Trên máy cá nhân cho dùng luôn; trên mạng công khai (Vercel) bắt buộc tạo tài khoản trước.
    if (!isVercel) return next();
    return res.status(503).json({ error: 'Cần tạo tài khoản quản trị', setup: true, ...st });
  }
  if (verifySession(store, readCookie(req, COOKIE))) return next();
  res.status(401).json({ error: 'Cần đăng nhập', login: true, usernameRequired: st.usernameRequired, googleLogin: st.googleLogin });
}));

// Đổi mật khẩu (tài khoản tạo trên web).
app.post('/api/account/password', wrap(async (req, res) => {
  const { current, next: newPassword } = req.body || {};
  const store = await Store.open();
  if (authMode(store) !== 'db') throw fail(400, 'Mật khẩu đang đặt bằng APP_PASSWORD trong cấu hình máy chủ');
  // Tài khoản tạo bằng Google chưa có mật khẩu: đặt lần đầu không cần mật khẩu cũ.
  if (!store.data.auth.admin.noPassword && !(await verifyPassword(current, store.data.auth.admin))) {
    await slowDown(); throw fail(401, 'Mật khẩu hiện tại không đúng');
  }
  const problem = validateNew(store.data.auth.admin.username, newPassword);
  if (problem) throw fail(400, problem);
  await changePassword(store, newPassword);
  delete store.data.auth.admin.noPassword;
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
      zaloReceiver: zaloReceiver(store),
      agent: { enabled: Boolean(d.settings?.agentTokenHash), createdAt: d.settings?.agentTokenAt || null, base: `${base}/api/agent` },
      zaloOwner: ownerChatId(store) ? { name: d.meta.zaloName || null, fromEnv: Boolean(process.env.ZALO_CHAT_ID) } : null,
      storage: storageKind(),
      vercel: isVercel,
      auth: { mode: authMode(store), username: adminName(store) },
      calendarUrl: `${base}/calendar.ics${calendarKey(store) ? `?key=${calendarKey(store)}` : ''}`,
      cronUrl: `${base}/api/cron${process.env.CRON_SECRET ? '?key=<CRON_SECRET>' : ''}`,
      google: {
        configured: googleConfigured(),
        clientId: { source: cfgSource('GOOGLE_CLIENT_ID'), masked: mask(cfg('GOOGLE_CLIENT_ID')) },
        clientSecret: { source: cfgSource('GOOGLE_CLIENT_SECRET'), masked: mask(cfg('GOOGLE_CLIENT_SECRET')) },
        redirectUri: `${base}/api/google/callback`,
        linked: d.auth?.admin?.google?.email || null,
        noPassword: Boolean(d.auth?.admin?.noPassword),
        calendar: d.google ? {
          email: d.google.email, calendars: d.google.calendars, push: d.google.push,
          lastSync: d.google.lastSync, lastError: d.google.lastError,
        } : null,
      },
    },
  });
}));

// ----- Sự kiện -----
const EVENT_FIELDS = ['title', 'start', 'end', 'allDay', 'note'];
const READ_ONLY = { ics: 'Sự kiện từ nguồn ICS chỉ sửa được ở lịch gốc', google: 'Sự kiện từ Google Lịch hãy sửa trên Google Lịch' };
// Sau khi lịch thay đổi: đẩy lên Google Lịch ở nền (nếu đã kết nối).
const kickGoogle = () => waitUntil(pushGoogle(Store.open).catch((err) => console.warn('[google]', err.message)));
app.post('/api/events', wrap(async (req, res) => {
  const e = { id: newId(), allDay: false, note: '', origin: 'manual', ...pick(req.body, EVENT_FIELDS) };
  if (!e.title || !e.start) throw fail(400, 'Cần tiêu đề và thời gian bắt đầu');
  await mutate((s) => s.data.events.push(e));
  kickGoogle();
  res.json(e);
}));
app.patch('/api/events/:id', wrap(async (req, res) => {
  res.json(await mutate((s) => {
    const e = findOr404(s.data.events, req.params.id);
    if (READ_ONLY[e.origin]) throw fail(400, READ_ONLY[e.origin]);
    Object.assign(e, pick(req.body, EVENT_FIELDS));
    if (e.googleId) e.googleDirty = Date.now();
    return e;
  }));
  kickGoogle();
}));
app.delete('/api/events/:id', wrap(async (req, res) => {
  await mutate((s) => {
    const e = s.data.events.find((x) => x.id === req.params.id);
    if (e?.origin === 'google') throw fail(400, READ_ONLY.google);
    if (e?.googleId && s.data.google) (s.data.google.pendingDeletes ||= []).push(e.googleId);
    s.data.events = s.data.events.filter((x) => x.id !== req.params.id);
  });
  kickGoogle();
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
  kickGoogle();
  res.json({ approved });
}));
app.post('/api/suggestions/:id/approve', wrap(async (req, res) => {
  const fields = pick(req.body || {}, ['title', 'start', 'end', 'deadline', 'quadrant', 'kind', 'note']);
  const r = await mutate((s) => s.approveSuggestion(req.params.id, fields));
  if (!r) throw fail(404, 'Không tìm thấy đề xuất');
  if (r.kind === 'event') kickGoogle();
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
  const fields = {
    geminiApiKey: 'GEMINI_API_KEY', zaloBotToken: 'ZALO_BOT_TOKEN', geminiModel: 'GEMINI_MODEL',
    googleClientId: 'GOOGLE_CLIENT_ID', googleClientSecret: 'GOOGLE_CLIENT_SECRET',
  };
  const store = await Store.open();
  const settings = { ...store.data.settings };
  const changed = [];
  for (const [field, name] of Object.entries(fields)) {
    if (!(field in body)) continue;
    const value = String(body[field] ?? '').trim();
    if (/\s/.test(value)) throw fail(400, `${name} không được chứa khoảng trắng`);
    if (field === 'googleClientId' && value && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(value)) {
      throw fail(400, 'Google Client ID phải có dạng 1234…-abc….apps.googleusercontent.com (chép từ cột Client ID, không phải secret)');
    }
    if (field === 'googleClientSecret' && value && !/^GOCSPX-/.test(value) && value.includes('.apps.googleusercontent.com')) {
      throw fail(400, 'Ô Client Secret đang chứa Client ID. Secret có dạng GOCSPX-…');
    }
    if (value) settings[field] = value; else delete settings[field];
    changed.push(field);
  }
  store.data.settings = settings;
  await store.save();
  await Store.open(); // áp dụng giá trị mới

  // Kiểm tra ngay để báo cho người dùng key có dùng được không.
  const result = { saved: changed };
  if (changed.includes('geminiApiKey') || changed.includes('geminiModel')) result.gemini = await checkGemini();
  if (changed.includes('googleClientId') || changed.includes('googleClientSecret')) result.googleConfigured = googleConfigured();
  if (changed.includes('zaloBotToken') && zaloConfigured()) {
    try {
      const me = await getMe();
      result.zalo = { ok: true, name: me?.display_name || me?.account_name || me?.name || null };
      // Token mới → đăng ký lại webhook (chuỗi bí mật sinh từ token) khi chạy trên https.
      const base = `${req.protocol}://${req.get('host')}`;
      if (zaloReceiver(store) === 'web' && (isVercel || (process.env.ZALO_MODE === 'webhook' && base.startsWith('https://')))) {
        try { await setWebhook(`${base}/api/zalo/webhook`); result.zalo.webhook = true; } catch (err) { result.zalo.webhookError = err.message; }
      }
    } catch (err) {
      result.zalo = { ok: false, error: err.message };
    }
  }
  res.json(result);
}));

// ----- Khoá cho AI agent & ai nhận tin Zalo (cần đăng nhập) -----
// Khoá chỉ hiện đúng 1 lần lúc tạo; máy chủ chỉ lưu mã băm.
app.post('/api/settings/agent-token', wrap(async (req, res) => {
  const token = `qltg_${crypto.randomBytes(24).toString('hex')}`;
  const at = new Date().toISOString();
  await mutate((s) => {
    s.data.settings = { ...s.data.settings, agentTokenHash: sha256(token), agentTokenAt: at };
  });
  await kv.set('agent-token', { hash: sha256(token), at });
  agentHashCache = { hash: undefined, at: 0 };
  res.json({ token });
}));
app.delete('/api/settings/agent-token', wrap(async (req, res) => {
  await mutate((s) => { delete s.data.settings.agentTokenHash; delete s.data.settings.agentTokenAt; });
  await kv.del('agent-token');
  agentHashCache = { hash: undefined, at: 0 };
  res.json({ ok: true });
}));
app.put('/api/settings/zalo-receiver', wrap(async (req, res) => {
  const receiver = req.body?.receiver === 'agent' ? 'agent' : 'web';
  const chatId = req.body?.chatId != null ? String(req.body.chatId).trim() : null;
  if (chatId && /\s/.test(chatId)) throw fail(400, 'ID Zalo không được chứa khoảng trắng');
  await mutate((s) => {
    s.data.settings = { ...s.data.settings, zaloReceiver: receiver };
    if (chatId) { s.data.meta.zaloChatId = chatId; s.data.meta.zaloName = s.data.meta.zaloName || null; }
  });
  // Chuyển về web nhận tin: đăng ký lại webhook. Chuyển sang agent: KHÔNG đụng webhook (agent đang giữ).
  const result = { receiver };
  if (receiver === 'web' && zaloConfigured() && baseUrl(req).startsWith('https://')) {
    try { await setWebhook(`${baseUrl(req)}/api/zalo/webhook`); result.webhook = true; } catch (err) { result.webhookError = err.message; }
  }
  res.json(result);
}));

// ----- Google (cần đăng nhập) -----
app.post('/api/google/unlink', wrap(async (req, res) => {
  await mutate((s) => {
    const admin = s.data.auth?.admin;
    if (admin?.noPassword) throw fail(400, 'Tài khoản tạo bằng Google: hãy đặt mật khẩu trước khi huỷ liên kết');
    if (admin) delete admin.google;
  });
  res.json({ ok: true });
}));
app.get('/api/google/calendars', wrap(async (req, res) => {
  const store = await Store.open();
  if (!isGoogleReady(store)) throw fail(400, 'Chưa kết nối Google Lịch');
  const selected = new Set(store.data.google.calendars.map((c) => c.id));
  const all = await listCalendars(store.data.google.refreshToken);
  res.json(all.map((c) => ({ ...c, selected: selected.has(c.id) || (c.primary && selected.has('primary')) })));
}));
app.put('/api/google/calendar', wrap(async (req, res) => {
  const { calendars, push } = req.body || {};
  await mutate((s) => {
    if (!s.data.google) throw fail(400, 'Chưa kết nối Google Lịch');
    if (Array.isArray(calendars)) {
      s.data.google.calendars = calendars.slice(0, 20).map((c) => ({ id: String(c.id), name: String(c.name || c.id) }));
      s.data.google.lastSync = null; // đồng bộ lại ngay với danh sách mới
    }
    if (typeof push === 'boolean') s.data.google.push = push;
  });
  res.json(await syncGoogle(Store.open));
}));
app.post('/api/google/sync', wrap(async (req, res) => res.json(await syncGoogle(Store.open))));
app.post('/api/google/disconnect', wrap(async (req, res) => {
  const store = await Store.open();
  if (store.data.google?.refreshToken) await revoke(store.data.google.refreshToken);
  store.data.google = null;
  store.data.events = store.data.events.filter((e) => e.origin !== 'google');
  for (const e of store.data.events) { delete e.googleId; delete e.googleDirty; }
  await store.save();
  res.json({ ok: true });
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

// ----- Quản trị: thành viên, log bot lịch, hệ thống (bot Zalo), session -----
app.get('/api/admin/members', wrap(async (req, res) => {
  res.json({ members: await listMembers(), settings: await memberSettings(), termsVersion: TERMS_VERSION, appUrl: appUrl(req) });
}));
app.put('/api/admin/members/settings', wrap(async (req, res) => res.json(await saveMemberSettings(req.body || {}))));
app.delete('/api/admin/members/:id', wrap(async (req, res) => {
  if (!(await deleteMember(req.params.id))) throw fail(404, 'Không tìm thấy thành viên');
  res.json({ ok: true });
}));
app.delete('/api/admin/members/:id/zalo', wrap(async (req, res) => {
  await unlinkZalo(req.params.id);
  res.json({ ok: true });
}));
app.get('/api/admin/calbot-log', wrap(async (req, res) => {
  const { from, to, member } = req.query;
  res.json({ entries: await readLog({ from, to, member }) });
}));
app.get('/api/admin/calbot-log/csv', wrap(async (req, res) => {
  const { from, to, member } = req.query;
  const csv = logToCsv(await readLog({ from, to, member }));
  res.set('Content-Disposition', `attachment; filename="calbot-log-${from || dayKey()}_${to || dayKey()}.csv"`);
  res.type('text/csv; charset=utf-8').send(csv);
}));
app.get('/api/admin/system', wrap(async (req, res) => {
  res.json({ schema: CONFIG_SCHEMA, config: await getConfig(), bot: await botStatus() });
}));
app.put('/api/admin/system', wrap(async (req, res) => res.json(await saveConfig(req.body?.values))));
app.get('/api/admin/sessions/chats', wrap(async (req, res) => {
  res.json({ chats: await sessionChats(sessionRetentionDays(await getConfig())) });
}));
app.get('/api/admin/sessions', wrap(async (req, res) => res.json(await readSession(String(req.query.chat || ''), String(req.query.day || '')))));

app.use('/api', (req, res) => res.status(404).json({ error: 'Không có API này' }));

// Giao diện tĩnh (trên Vercel thư mục public/ được phục vụ trực tiếp, đây là dự phòng).
app.use(express.static(path.join(root, 'public')));

export default app;
