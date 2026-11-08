// Ứng dụng Express: API + giao diện. Dùng chung cho chạy trên máy (server.js) và Vercel (api/index.js).
// Một web duy nhất cho mọi người: đăng nhập bằng Gmail, phân quyền Owner / Technician / User (src/roles.js).
import './env.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { waitUntil } from '@vercel/functions';
import { Store, newId } from './db.js';
import { DEFAULT_MODEL, checkGemini, extractItems, geminiConfigured } from './gemini.js';
import { cfg, cfgSource, mask } from './config.js';
import { authUrl, CALENDAR_EVENTS_SCOPE, exchangeCode, googleConfigured, pushGoogle } from './google.js';
import { syncSources } from './sources.js';
import { runCron } from './cron.js';
import { storageKind } from './storage.js';
import {
  dayAgenda, deleteWebhook, getMe, handleText, handleUpdate, ownerChatId, sendMessage, setWebhook, webhookSecret, zaloConfigured, zaloReceiver,
} from './zalo.js';
import { dayKey, TZ, zonedMidnight } from './time.js';
import { kv } from './kv.js';
import {
  acceptTerms, createZaloCode, deleteMember, getMember, linkZalo, listMembers, memberCookieValue, memberSettings,
  membersByZalo, publicMember, readAudit, revokeSessions, saveMemberSettings, setGoogleStatus, setRole, signInMember, TERMS_VERSION, touchSeen, unlinkZalo,
  verifyMemberCookie,
} from './members.js';
import { assign, cancel as cancelAssignment, status as assignmentStatus, update as updateAssignment } from './calbot.js';
import { logToCsv, readLog } from './calbot-log.js';
import { can, ROLES } from './roles.js';
import { openOwnerStore, openUser, UserStore } from './userstore.js';
import { LIMITS, isPrivateHost } from './limits.js';
import { connectMember, disconnectMember, drainMember, readHistory, syncMemberGoogle } from './gsync.js';
import { hasRefreshToken, encKeyConfigured } from './gtoken.js';
import { migrateLegacy, migrationInfo } from './migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const isVercel = Boolean(process.env.VERCEL);
export const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
// Header bảo mật: chặn nhúng trang vào iframe (clickjacking), chặn đoán kiểu file, chỉ chạy script của chính web.
export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; "
    + "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
app.use((req, res, next) => {
  res.set(SECURITY_HEADERS);
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ----- Một tên miền chính (PRIMARY_HOST, cũ là APP_HOST) -----
// Mọi trang chuyển (308) về tên miền chính. Bot Zalo (PyloS), webhook Zalo, cron, link .ics chạy được ở mọi tên miền
// (PyloS và cron-job.org có thể còn trỏ vào tên miền cũ); các API còn lại chỉ có ở tên miền chính vì cookie nằm ở đó.
const PRIMARY_HOST = String(process.env.PRIMARY_HOST || process.env.APP_HOST || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
const onPrimary = (req) => !PRIMARY_HOST || req.hostname.toLowerCase() === PRIMARY_HOST;
const isSharedApi = (p) => p.startsWith('/api/agent/') || p === '/api/zalo/webhook' || p === '/api/cron';
app.use((req, res, next) => {
  if (onPrimary(req) || isSharedApi(req.path)) return next();
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Không có API này ở tên miền này' });
  return res.redirect(308, `https://${PRIMARY_HOST}${req.originalUrl}`);
});

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  if (err.status >= 500 || !err.status) console.warn('[api]', req.method, req.path, err.message);
  res.status(err.status || 500).json({ error: err.message, ...err.extra });
});
const fail = (status, message, extra) => Object.assign(new Error(message), { status, extra });
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
// Kiểm kiểu và độ dài dữ liệu người dùng gửi lên: chuỗi quá dài, ngày sai, kiểu lạ đều bị từ chối (tránh phình kho và làm hỏng đồng bộ Google).
const MAX = { title: 200, note: 2000, goal: 200 };
function cleanText(v, field, max) {
  if (typeof v !== 'string') throw fail(400, `"${field}" phải là chữ`);
  if (v.length > max) throw fail(400, `"${field}" dài quá ${max} ký tự`);
  return v;
}
function cleanDate(v, field, { nullable = false } = {}) {
  if (v == null || v === '') { if (nullable) return null; throw fail(400, `Thiếu "${field}"`); }
  const t = typeof v === 'string' || typeof v === 'number' ? new Date(v) : null;
  if (!t || Number.isNaN(t.getTime()) || t.getUTCFullYear() < 1970 || t.getUTCFullYear() > 2200) throw fail(400, `"${field}" không phải ngày giờ hợp lệ`);
  return t.toISOString();
}
const cleanBool = (v, field) => { if (typeof v !== 'boolean') throw fail(400, `"${field}" phải là true/false`); return v; };
const cleanQuadrant = (v) => { const n = Number(v); if (![1, 2, 3, 4].includes(n)) throw fail(400, '"quadrant" phải là 1, 2, 3 hoặc 4'); return n; };
export function cleanEvent(input) {
  const out = {};
  if ('title' in input) out.title = cleanText(input.title, 'title', MAX.title).trim();
  if ('note' in input) out.note = cleanText(input.note ?? '', 'note', MAX.note);
  if ('start' in input) out.start = cleanDate(input.start, 'start');
  if ('end' in input) out.end = cleanDate(input.end, 'end', { nullable: true });
  if ('allDay' in input) out.allDay = cleanBool(input.allDay, 'allDay');
  return out;
}
export function cleanTask(input) {
  const out = {};
  if ('title' in input) out.title = cleanText(input.title, 'title', MAX.title).trim();
  if ('note' in input) out.note = cleanText(input.note ?? '', 'note', MAX.note);
  if ('deadline' in input) out.deadline = cleanDate(input.deadline, 'deadline', { nullable: true });
  if ('quadrant' in input) out.quadrant = cleanQuadrant(input.quadrant);
  if ('done' in input) out.done = cleanBool(input.done, 'done');
  return out;
}
const findOr404 = (list, id) => list.find((x) => x.id === id) || (() => { throw fail(404, 'Không tìm thấy'); })();
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
// Link web app gửi cho mọi người.
const appUrl = (req) => (PRIMARY_HOST ? `https://${PRIMARY_HOST}/` : `${baseUrl(req)}/`);

// Mở dữ liệu hệ thống (khoá API, khoá agent), thay đổi, lưu lại.
async function mutate(fn) {
  const store = await Store.open();
  const result = await fn(store);
  await store.save();
  return result;
}
// Mở dữ liệu riêng của một người, thay đổi, lưu lại.
async function mutateUser(id, fn) {
  const store = await UserStore.open(id);
  const result = await fn(store);
  await store.save();
  return result;
}
const kickGoogle = (id) => waitUntil(pushGoogle(openUser(id)).catch((err) => console.warn('[google]', err.message)));

// ----- Webhook Zalo: xác thực bằng header bí mật riêng -----
app.post('/api/zalo/webhook', wrap(async (req, res) => {
  await Store.open(); // nạp token Zalo nhập trên web (nếu có)
  const secret = webhookSecret();
  if (!secret || !safeEqual(req.get('X-Bot-Api-Secret-Token') || '', secret)) return res.sendStatus(403);
  const job = handleUpdate(req.body).catch((err) => console.warn('[zalo] webhook:', err.message));
  waitUntil(job);
  res.json({ ok: true });
}));

// ----- API cho bot Zalo PyloS: giao lịch, liên kết Zalo — xác thực bằng khoá riêng, không cần đăng nhập -----
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// Mã băm của khoá nằm ở kho khoá–giá trị và được nhớ 30 giây.
let agentHashCache = { hash: undefined, at: 0 };
async function agentTokenHash() {
  if (agentHashCache.hash !== undefined && Date.now() - agentHashCache.at < 30_000) return agentHashCache.hash;
  let hash = (await kv.get('agent-token'))?.hash || null;
  if (!hash) {
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
  await Store.open(); // nạp khoá Gemini nhập trên web
}
// Lịch / việc riêng là của từng người: bot gửi kèm ID Zalo của người nhắn, web tìm tài khoản đã liên kết.
async function agentMember(req) {
  await agentAuth(req);
  const uid = String(req.body?.zaloUid ?? req.query?.zaloUid ?? '').trim();
  if (!uid) throw fail(400, 'Thiếu "zaloUid" (ID Zalo của người nhắn)');
  const [id] = await membersByZalo([uid]);
  const user = id && await getMember(id);
  if (!user) throw fail(404, 'Người này chưa liên kết Zalo với tài khoản trên web', { unlinked: true, appUrl: appUrl(req) });
  return user;
}
function dateFromQuery(q) {
  if (q === 'tomorrow' || q === 'mai') return new Date(Date.now() + 24 * 3600 * 1000);
  if (/^\d{4}-\d{2}-\d{2}$/.test(q || '')) return new Date(new Date(zonedMidnight(q)).getTime() + 12 * 3600 * 1000);
  return new Date();
}

app.post('/api/agent/message', wrap(async (req, res) => {
  const user = await agentMember(req);
  const text = String(req.body?.text || '').trim();
  if (!text) throw fail(400, 'Thiếu "text"');
  const items = !text.startsWith('/') && geminiConfigured() ? await extractItems(text) : undefined;
  const store = await UserStore.open(user.id);
  const reply = await handleText(store, String(req.body?.chatId || '') || null, text, { name: req.body?.name || user.name, items, trusted: true });
  await store.save();
  if (/^\/duyet/i.test(text)) kickGoogle(user.id);
  res.json({ reply });
}));
app.get('/api/agent/agenda', wrap(async (req, res) => {
  const user = await agentMember(req);
  const store = await UserStore.open(user.id);
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
  const user = await agentMember(req);
  const store = await UserStore.open(user.id);
  res.json(store.data.tasks.filter((t) => !t.done).sort((a, b) => a.quadrant - b.quadrant)
    .map(({ id, title, deadline, quadrant, note }) => ({ id, title, deadline, quadrant, note })));
}));
app.post('/api/agent/events', wrap(async (req, res) => {
  const user = await agentMember(req);
  if (!req.body?.title || !req.body?.start) throw fail(400, 'Cần "title" và "start" (ISO 8601, vd 2026-10-30T14:00:00+07:00)');
  const e = { id: newId(), allDay: false, note: '', origin: 'agent', ...cleanEvent(pick(req.body, ['title', 'start', 'end', 'allDay', 'note'])) };
  await mutateUser(user.id, (s) => {
    if (s.data.events.length >= LIMITS.events) throw fail(429, `Tối đa ${LIMITS.events} lịch mỗi người`);
    s.data.events.push(e);
  });
  kickGoogle(user.id);
  res.json(e);
}));
app.post('/api/agent/tasks', wrap(async (req, res) => {
  const user = await agentMember(req);
  const t = { id: newId(), quadrant: 2, deadline: null, done: false, note: '', origin: 'agent', createdAt: new Date().toISOString(),
    ...cleanTask(pick(req.body || {}, ['title', 'quadrant', 'deadline', 'note'])) };
  if (!t.title) throw fail(400, 'Cần "title"');
  await mutateUser(user.id, (s) => {
    if (s.data.tasks.length >= LIMITS.tasks) throw fail(429, `Tối đa ${LIMITS.tasks} việc mỗi người`);
    s.data.tasks.push(t);
  });
  res.json(t);
}));
app.patch('/api/agent/tasks/:id', wrap(async (req, res) => {
  const user = await agentMember(req);
  res.json(await mutateUser(user.id, (s) => {
    const t = findOr404(s.data.tasks, req.params.id);
    const patch = cleanTask(pick(req.body || {}, ['title', 'quadrant', 'deadline', 'done', 'note']));
    Object.assign(t, patch);
    if ('done' in patch) t.doneAt = patch.done ? new Date().toISOString() : null;
    return t;
  }));
}));

// ----- Bot lịch: giao lịch cho người được tag, liên kết Zalo -----
const maskEmail = (e) => String(e || '').replace(/^(.{2})[^@]*(@.*)$/, '$1…$2');
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
// PyloS đã tách khỏi web: các API cấu hình, nhịp tim, session, đăng nhập thiết bị không còn. 410 để bản PyloS cũ biết mà cập nhật.
const GONE = 'PyloS đã tách khỏi web bot lịch nên API này đã bỏ. Hãy cập nhật PyloS lên bản mới.';
app.all(['/api/agent/config', '/api/agent/heartbeat', '/api/agent/sessions', '/api/agent/device-login', '/api/agent/device-login/:code'],
  (req, res) => res.status(410).json({ error: GONE }));

// Mô tả API (OpenAPI) để nạp vào agent làm "công cụ".
app.get('/api/agent/openapi.json', (req, res) => {
  const body = (props, required) => ({ required: true, content: { 'application/json': { schema: { type: 'object', properties: props, required } } } });
  const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  const zaloUid = { type: 'string', description: 'ID Zalo của người nhắn (đã liên kết với tài khoản trên web)' };
  const assignFields = {
    title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 có giờ; lịch cả ngày: YYYY-MM-DD' },
    end: { type: 'string' }, allDay: { type: 'boolean' }, note: { type: 'string' },
  };
  const assignees = { type: 'array', items: { type: 'object', properties: { zaloUid: { type: 'string' }, name: { type: 'string' } }, required: ['zaloUid'] } };
  const sourceSchema = { type: 'object', properties: { chatId: { type: 'string' }, chatName: { type: 'string' }, senderId: { type: 'string' }, senderName: { type: 'string' }, messageId: { type: 'string' } } };
  res.json({
    openapi: '3.0.3',
    info: { title: 'Bot lịch iforgotmywayhome', version: '2.0.0', description: 'Giao lịch cho người được tag và lịch/việc riêng của từng người (theo zaloUid). Múi giờ ' + TZ },
    servers: [{ url: `${baseUrl(req)}` }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
    paths: {
      '/api/agent/message': { post: { operationId: 'handleScheduleMessage', summary: 'Gửi tin nhắn/lệnh của người dùng; trả về câu trả lời',
        requestBody: body({ text: { type: 'string' }, zaloUid, chatId: { type: 'string' } }, ['text', 'zaloUid']) } },
      '/api/agent/agenda': { get: { operationId: 'getAgenda', summary: 'Lịch và việc đến hạn của người nhắn trong một ngày',
        parameters: [{ name: 'zaloUid', in: 'query', required: true, schema: { type: 'string' } }, { name: 'date', in: 'query', schema: { type: 'string' }, description: 'today | tomorrow | YYYY-MM-DD' }] } },
      '/api/agent/tasks': {
        get: { operationId: 'listTasks', summary: 'Các việc chưa xong của người nhắn', parameters: [{ name: 'zaloUid', in: 'query', required: true, schema: { type: 'string' } }] },
        post: { operationId: 'createTask', summary: 'Tạo việc cần làm', requestBody: body({ zaloUid, title: { type: 'string' }, deadline: { type: 'string', format: 'date-time' }, quadrant: { type: 'integer', enum: [1, 2, 3, 4] }, note: { type: 'string' } }, ['zaloUid', 'title']) },
      },
      '/api/agent/tasks/{id}': { patch: { operationId: 'updateTask', summary: 'Sửa / đánh dấu xong việc', parameters: [idParam],
        requestBody: body({ zaloUid, done: { type: 'boolean' }, title: { type: 'string' }, deadline: { type: 'string' }, quadrant: { type: 'integer' } }, ['zaloUid']) } },
      '/api/agent/events': { post: { operationId: 'createEvent', summary: 'Tạo lịch hẹn riêng (tự lên Google Lịch nếu đã kết nối)',
        requestBody: body({ zaloUid, title: { type: 'string' }, start: { type: 'string', format: 'date-time' }, end: { type: 'string', format: 'date-time' }, allDay: { type: 'boolean' }, note: { type: 'string' } }, ['zaloUid', 'title', 'start']) } },
      '/api/agent/zalo-link': { post: { operationId: 'linkZalo', summary: 'Liên kết Zalo của người gửi với tài khoản Gmail bằng mã 6 số họ lấy trong app',
        requestBody: body({ code: { type: 'string' }, zaloUid: { type: 'string' }, zaloName: { type: 'string' } }, ['code', 'zaloUid']) } },
      '/api/agent/assign': { post: { operationId: 'assignEvent', summary: 'Giao lịch cho những người được tag: ghi vào Google Lịch của từng người đã liên kết',
        requestBody: body({ ...assignFields, assignees, source: sourceSchema }, ['title', 'start', 'assignees']) } },
      '/api/agent/assign/{id}': {
        get: { operationId: 'assignmentStatus', summary: 'Tình trạng lịch đã giao: ai đã liên kết, ai đã được ghi vào Google Lịch', parameters: [idParam] },
        patch: { operationId: 'updateAssignment', summary: 'Sửa lịch đã giao (giờ, tiêu đề, người nhận); người bị bỏ nhận lệnh xoá', parameters: [idParam],
          requestBody: body({ ...assignFields, assignees, add: assignees, remove: assignees }, []) },
        delete: { operationId: 'cancelAssignment', summary: 'Huỷ lịch đã giao: xoá khỏi Google Lịch của mọi người đã nhận', parameters: [idParam] },
      },
    },
  });
});

// ----- Cron: Vercel Cron gửi "Authorization: Bearer <CRON_SECRET>"; cron-job.org dùng ?key= -----
app.get('/api/cron', wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  // Trên Vercel bắt buộc có CRON_SECRET: thiếu thì từ chối, để người ngoài không gọi cron (tốn lượt Gemini, Upstash) được.
  if (!secret && isVercel) throw fail(503, 'Chưa đặt CRON_SECRET trên Vercel');
  if (secret) {
    const given = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '') || req.query.key || '';
    if (!safeEqual(given, secret)) throw fail(401, 'Sai CRON_SECRET');
  }
  await migrateLegacy().catch((err) => console.warn('[migrate]', err.message));
  const report = await runCron();
  await kv.set('cron:last', { at: new Date().toISOString(), report }, { ex: 7 * 24 * 3600 });
  res.json(report);
}));

// ----- Đăng nhập Google: một lần cho cả tài khoản và quyền Google Lịch -----
const OAUTH_COOKIE = 'qltg_oauth';
const TERMS_COOKIE = 'qltg_terms';
const MEMBER_COOKIE = 'qltg_member';
const PURPOSES = ['member', 'member-consent', 'calendar-member'];
const redirectUri = (req) => `${baseUrl(req)}/api/google/callback`;
const backToApp = (res, params) => res.redirect(`/?${new URLSearchParams(params)}`);
function readCookie(req, name) {
  const m = (req.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

app.get('/api/google/start', wrap(async (req, res) => {
  const purpose = String(req.query.purpose || '');
  if (!PURPOSES.includes(purpose)) throw fail(400, 'Mục đích không hợp lệ');
  await Store.open();
  if (!googleConfigured()) return backToApp(res, { google_error: 'Chủ hệ thống chưa cấu hình đăng nhập Google' });
  let hint;
  if (purpose === 'calendar-member') {
    const u = await getMember(await verifyMemberCookie(readCookie(req, MEMBER_COOKIE)));
    if (!u) return backToApp(res, { google_error: 'Hãy đăng nhập trước' });
    hint = u.email;
  } else if (purpose === 'member-consent') {
    hint = String(req.query.hint || '').slice(0, 200) || undefined;
  }
  const short = { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60 * 1000, path: '/api/google' };
  // Thành viên mới tick "Tôi đồng ý" trước khi đăng nhập: nhớ phiên bản điều khoản đã đồng ý cho bước tạo tài khoản.
  if (purpose === 'member' && req.query.terms === TERMS_VERSION) res.cookie(TERMS_COOKIE, TERMS_VERSION, short);
  // Chống giả mạo (CSRF): mã ngẫu nhiên vừa nằm trong state vừa nằm trong cookie của trình duyệt này.
  const nonce = crypto.randomBytes(16).toString('hex');
  res.cookie(OAUTH_COOKIE, nonce, short);
  res.redirect(authUrl({ redirectUri: redirectUri(req), state: `${purpose}.${nonce}`, purpose, loginHint: hint }));
}));

app.get('/api/google/callback', wrap(async (req, res) => {
  const [purpose, nonce] = String(req.query.state || '').split('.');
  const expected = readCookie(req, OAUTH_COOKIE);
  const acceptedTerms = readCookie(req, TERMS_COOKIE);
  res.clearCookie(OAUTH_COOKIE, { path: '/api/google' });
  res.clearCookie(TERMS_COOKIE, { path: '/api/google' });
  if (req.query.error) return backToApp(res, { google_error: req.query.error === 'access_denied' ? 'Bạn đã huỷ đăng nhập Google' : String(req.query.error) });
  if (!PURPOSES.includes(purpose) || !nonce || !expected || !safeEqual(nonce, expected)) {
    return backToApp(res, { google_error: 'Phiên đăng nhập Google không hợp lệ, hãy thử lại' });
  }
  try {
    await Store.open(); // nạp Client ID/Secret
    const { claims, refreshToken, scopes } = await exchangeCode(String(req.query.code || ''), redirectUri(req));
    const r = await signInMember(claims, { acceptedTerms });
    if (r.needsTerms) return backToApp(res, { google_error: 'Hãy đọc và đánh dấu đồng ý Điều khoản dịch vụ trước khi tạo tài khoản' });
    const id = r.user.id;
    res.cookie(MEMBER_COOKIE, await memberCookieValue(id), {
      httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 180 * 24 * 3600 * 1000, path: '/',
    });
    if (r.user.role === 'owner') await migrateLegacy().catch((err) => console.warn('[migrate]', err.message));

    // Quyền Google Lịch: có refresh token thì máy chủ giữ và tự ghi lịch từ đây về sau.
    let calendar;
    if (scopes.includes(CALENDAR_EVENTS_SCOPE)) {
      if (refreshToken) {
        await connectMember(id, { email: claims.email, refreshToken });
        calendar = 'on';
      } else if (await hasRefreshToken(id)) {
        await connectMember(id, { email: claims.email, refreshToken: null }); // đã có token từ lần trước
        calendar = 'on';
      } else if (purpose !== 'member-consent') {
        // Google chỉ trả refresh token ở lần đồng ý đầu: hỏi lại một lần bằng màn hình đồng ý để lấy.
        if (r.created) res.cookie('qltg_new', '1', { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60 * 1000, path: '/api/google' });
        return res.redirect(`/api/google/start?${new URLSearchParams({ purpose: 'member-consent', hint: claims.email })}`);
      } else {
        await setGoogleStatus(id, { status: 'reconnect', lastError: 'Google không cấp quyền dùng lâu dài' });
        return backToApp(res, { google_error: 'Google không cấp quyền dùng lâu dài. Vào myaccount.google.com/permissions gỡ quyền của ứng dụng rồi đăng nhập lại.' });
      }
    } else if (!(await hasRefreshToken(id))) {
      await setGoogleStatus(id, { status: 'no-scope' });
      calendar = 'no-scope';
    }
    const wasNew = r.created || readCookie(req, 'qltg_new') === '1';
    res.clearCookie('qltg_new', { path: '/api/google' });
    return backToApp(res, { google: wasNew ? 'member-new' : 'member', ...(calendar ? { calendar } : {}) });
  } catch (err) {
    return backToApp(res, { google_error: err.message });
  }
}));

// ----- Tài khoản của chính người đăng nhập (/api/me…) -----
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
// Chặn theo quyền. Quyền đọc từ kho ở mỗi yêu cầu (không nằm trong cookie), nên đổi quyền có hiệu lực ngay.
const need = (perm) => wrap(async (req, res, next) => {
  const me = await currentMember(req);
  if (!can(me, perm)) throw fail(403, 'Tài khoản của bạn không có quyền này', { forbidden: true });
  if (perm === 'use' && publicMember(me).needsTerms) throw fail(403, 'Điều khoản đã thay đổi, hãy đọc và đồng ý lại', { needsTerms: true, termsVersion: TERMS_VERSION });
  req.me = me;
  next();
});

app.get('/api/me', wrap(async (req, res) => {
  await Store.open();
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
    googleReady: googleConfigured(),
  });
}));
app.post('/api/me/terms', wrap(async (req, res) => {
  res.json(publicMember(await acceptTerms(await memberId(req), req.body?.version)));
}));
app.post('/api/me/zalo-code', need('use'), wrap(async (req, res) => {
  const settings = await memberSettings();
  res.json({ ...(await createZaloCode(req.me.id)), botName: settings.botName || null, botChatUrl: settings.botChatUrl || null });
}));
app.get('/api/me/zalo', need('use'), wrap(async (req, res) => res.json({ zalo: publicMember(req.me).zalo })));
app.delete('/api/me/zalo', need('use'), wrap(async (req, res) => res.json(publicMember(await unlinkZalo(req.me.id)))));
// Lịch đã được ghi vào Google Lịch (máy chủ ghi giúp, lưu 90 ngày).
app.get('/api/me/history', need('use'), wrap(async (req, res) => {
  touchSeen(req.me.id).catch(() => {});
  res.json({ history: await readHistory(req.me.id) });
}));
// Đăng xuất: huỷ mọi phiên của tài khoản (cookie đã bị lấy cắp cũng hết dùng được).
app.post('/api/me/logout', wrap(async (req, res) => {
  const id = await verifyMemberCookie(readCookie(req, MEMBER_COOKIE));
  if (id) await revokeSessions(id);
  res.clearCookie(MEMBER_COOKIE, { path: '/' });
  res.json({ ok: true });
}));
app.delete('/api/me', wrap(async (req, res) => {
  const me = await currentMember(req);
  if (me.role === 'owner' && (await listMembers()).filter((m) => m.role === 'owner').length <= 1) {
    throw fail(409, 'Bạn là Owner duy nhất. Hãy chuyển quyền Owner cho người khác trước khi xoá tài khoản.');
  }
  await deleteMember(me.id);
  res.clearCookie(MEMBER_COOKIE, { path: '/' });
  res.json({ ok: true });
}));

// Google Lịch của chính mình
app.post('/api/me/google/sync', need('use'), wrap(async (req, res) => {
  if (req.me.gstatus !== 'connected') throw fail(400, 'Chưa kết nối Google Lịch');
  const drained = await drainMember(req.me.id);
  res.json({ drained, sync: await syncMemberGoogle(req.me.id), me: publicMember(await getMember(req.me.id)) });
}));
app.delete('/api/me/google', need('use'), wrap(async (req, res) => {
  await disconnectMember(req.me.id);
  res.json(publicMember(await getMember(req.me.id)));
}));

// ----- Dữ liệu riêng: lịch, việc, đề xuất, nguồn (chỉ của chính người đăng nhập) -----
app.get('/api/me/state', need('use'), wrap(async (req, res) => {
  const d = (await UserStore.open(req.me.id)).data;
  touchSeen(req.me.id).catch(() => {});
  res.json({
    today: dayKey(), tz: TZ,
    events: d.events, tasks: d.tasks, goals: d.goals, suggestions: d.suggestions,
    sources: d.sources.map(({ lastHash, ...s }) => s),
    pomodoros: d.pomodoros.filter((p) => Date.now() - new Date(p.at) < 30 * 24 * 3600 * 1000),
    config: { gemini: geminiConfigured(), limits: LIMITS },
  });
}));

const EVENT_FIELDS = ['title', 'start', 'end', 'allDay', 'note'];
const READ_ONLY = { ics: 'Sự kiện từ nguồn ICS chỉ sửa được ở lịch gốc', google: 'Sự kiện từ Google Lịch hãy sửa trên Google Lịch' };
app.post('/api/me/events', need('use'), wrap(async (req, res) => {
  if (!req.body?.title || !req.body?.start) throw fail(400, 'Cần tiêu đề và thời gian bắt đầu');
  const e = { id: newId(), allDay: false, note: '', origin: 'manual', ...cleanEvent(pick(req.body, EVENT_FIELDS)) };
  await mutateUser(req.me.id, (s) => {
    if (s.data.events.length >= LIMITS.events) throw fail(429, `Tối đa ${LIMITS.events} lịch mỗi người`);
    s.data.events.push(e);
  });
  kickGoogle(req.me.id);
  res.json(e);
}));
app.patch('/api/me/events/:id', need('use'), wrap(async (req, res) => {
  const out = await mutateUser(req.me.id, (s) => {
    const e = findOr404(s.data.events, req.params.id);
    if (READ_ONLY[e.origin]) throw fail(400, READ_ONLY[e.origin]);
    const patch = cleanEvent(pick(req.body || {}, EVENT_FIELDS));
    if ('title' in patch && !patch.title) throw fail(400, 'Tiêu đề không được trống');
    Object.assign(e, patch);
    if (e.googleId) e.googleDirty = Date.now();
    return e;
  });
  kickGoogle(req.me.id);
  res.json(out);
}));
app.delete('/api/me/events/:id', need('use'), wrap(async (req, res) => {
  await mutateUser(req.me.id, (s) => {
    const e = s.data.events.find((x) => x.id === req.params.id);
    if (e?.origin === 'google') throw fail(400, READ_ONLY.google);
    if (e?.googleId && s.data.google) (s.data.google.pendingDeletes ||= []).push(e.googleId);
    s.data.events = s.data.events.filter((x) => x.id !== req.params.id);
  });
  kickGoogle(req.me.id);
  res.json({ ok: true });
}));

const TASK_FIELDS = ['title', 'quadrant', 'deadline', 'done', 'note'];
app.post('/api/me/tasks', need('use'), wrap(async (req, res) => {
  const t = { id: newId(), quadrant: 2, deadline: null, done: false, note: '', origin: 'manual', createdAt: new Date().toISOString(), ...cleanTask(pick(req.body || {}, TASK_FIELDS)) };
  if (!t.title) throw fail(400, 'Cần tên công việc');
  await mutateUser(req.me.id, (s) => {
    if (s.data.tasks.length >= LIMITS.tasks) throw fail(429, `Tối đa ${LIMITS.tasks} việc mỗi người`);
    s.data.tasks.push(t);
  });
  res.json(t);
}));
app.patch('/api/me/tasks/:id', need('use'), wrap(async (req, res) => {
  res.json(await mutateUser(req.me.id, (s) => {
    const t = findOr404(s.data.tasks, req.params.id);
    const patch = cleanTask(pick(req.body || {}, TASK_FIELDS));
    if ('title' in patch && !patch.title) throw fail(400, 'Tên công việc không được trống');
    Object.assign(t, patch);
    if ('done' in patch) t.doneAt = patch.done ? new Date().toISOString() : null;
    return t;
  }));
}));
app.delete('/api/me/tasks/:id', need('use'), wrap(async (req, res) => {
  await mutateUser(req.me.id, (s) => { s.data.tasks = s.data.tasks.filter((t) => t.id !== req.params.id); });
  res.json({ ok: true });
}));

app.put('/api/me/goals/:date', need('use'), wrap(async (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) throw fail(400, 'Ngày không hợp lệ');
  await mutateUser(req.me.id, (s) => { const goals = Array.isArray(req.body?.goals) ? req.body.goals : [];
    s.data.goals[req.params.date] = goals.slice(0, 3).map((g) => String(g ?? '').slice(0, MAX.goal)); });
  res.json({ ok: true });
}));
app.post('/api/me/pomodoros', need('use'), wrap(async (req, res) => {
  const minutes = Math.round(Number(req.body?.minutes));
  const p = { at: new Date().toISOString(), minutes: minutes >= 1 && minutes <= 240 ? minutes : 25,
    taskId: typeof req.body?.taskId === 'string' ? req.body.taskId.slice(0, 40) : null };
  await mutateUser(req.me.id, (s) => { s.data.pomodoros.push(p); s.data.pomodoros = s.data.pomodoros.slice(-2000); });
  res.json(p);
}));

app.post('/api/me/extract', need('use'), wrap(async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 20000);
  if (!text) throw fail(400, 'Chưa có nội dung');
  if (!geminiConfigured()) throw fail(400, 'Chủ hệ thống chưa cấu hình Gemini');
  if ((await kv.count(`extract:${req.me.id}:${dayKey()}`, 24 * 3600)) > LIMITS.extractPerDay) throw fail(429, `Mỗi ngày chỉ dùng AI trích lịch được ${LIMITS.extractPerDay} lần`);
  const items = await extractItems(text);
  const added = await mutateUser(req.me.id, (s) => s.addSuggestions(items, 'paste'));
  res.json({ found: items.length, added });
}));
app.post('/api/me/suggestions/approve-all', need('use'), wrap(async (req, res) => {
  const approved = await mutateUser(req.me.id, (s) => {
    const ids = s.data.suggestions.map((x) => x.id);
    ids.forEach((id) => s.approveSuggestion(id));
    return ids.length;
  });
  kickGoogle(req.me.id);
  res.json({ approved });
}));
app.post('/api/me/suggestions/:id/approve', need('use'), wrap(async (req, res) => {
  const body = req.body || {};
  const fields = { ...cleanEvent(pick(body, ['title', 'start', 'end', 'note'])), ...cleanTask(pick(body, ['deadline', 'quadrant'])) };
  if ('kind' in body) { if (!['event', 'task'].includes(body.kind)) throw fail(400, '"kind" phải là event hoặc task'); fields.kind = body.kind; }
  const r = await mutateUser(req.me.id, (s) => s.approveSuggestion(req.params.id, fields));
  if (!r) throw fail(404, 'Không tìm thấy đề xuất');
  if (r.kind === 'event') kickGoogle(req.me.id);
  res.json(r);
}));
app.post('/api/me/suggestions/:id/reject', need('use'), wrap(async (req, res) => {
  if (!(await mutateUser(req.me.id, (s) => s.rejectSuggestion(req.params.id)))) throw fail(404, 'Không tìm thấy đề xuất');
  res.json({ ok: true });
}));

app.post('/api/me/sources', need('use'), wrap(async (req, res) => {
  const { type, name, url } = req.body || {};
  if (!['ics', 'web'].includes(type)) throw fail(400, 'Loại nguồn phải là ics hoặc web');
  let u;
  try { u = new URL(String(url).trim().replace(/^webcal:/i, 'https:')); } catch { throw fail(400, 'URL không hợp lệ'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw fail(400, 'Chỉ hỗ trợ http/https');
  if (u.username || u.password) throw fail(400, 'URL không được chứa tên đăng nhập/mật khẩu');
  if (u.href.length > 2000) throw fail(400, 'URL quá dài');
  if (isPrivateHost(u.hostname)) throw fail(400, 'Không dùng được địa chỉ nội bộ');
  const src = { id: newId(), type, name: (typeof name === 'string' && name.trim().slice(0, 80)) || u.hostname, url: u.href, lastSync: null, lastError: null, lastHash: null };
  await mutateUser(req.me.id, (s) => {
    if (s.data.sources.length >= LIMITS.sources) throw fail(429, `Tối đa ${LIMITS.sources} nguồn mỗi người`);
    if (type === 'web' && s.data.sources.filter((x) => x.type === 'web').length >= LIMITS.webSources) throw fail(429, `Tối đa ${LIMITS.webSources} nguồn trang web mỗi người (mỗi lần đồng bộ tốn một lượt Gemini)`);
    s.data.sources.push(src);
  });
  await setGoogleStatus(req.me.id, { hasSources: true });
  const results = await syncSources(openUser(req.me.id), { ids: [src.id] });
  res.json({ source: src, result: results[src.id] });
}));
app.delete('/api/me/sources/:id', need('use'), wrap(async (req, res) => {
  const left = await mutateUser(req.me.id, (s) => {
    s.data.sources = s.data.sources.filter((x) => x.id !== req.params.id);
    s.data.events = s.data.events.filter((e) => e.sourceId !== req.params.id);
    return s.data.sources.length;
  });
  if (!left) await setGoogleStatus(req.me.id, { hasSources: false });
  res.json({ ok: true });
}));
app.post('/api/me/sources/sync', need('use'), wrap(async (req, res) => res.json(await syncSources(openUser(req.me.id)))));
app.post('/api/me/sources/:id/sync', need('use'), wrap(async (req, res) => {
  const results = await syncSources(openUser(req.me.id), { ids: [req.params.id] });
  if (!results[req.params.id]) throw fail(404, 'Không tìm thấy nguồn');
  res.json(results[req.params.id]);
}));
app.use('/api/me', (req, res) => res.status(404).json({ error: 'Không có API này' }));

// ----- Quản trị (theo quyền). Web không có phần "máy ảo": mọi thứ ở đây là của bot lịch -----
// Quản lý bot lịch: bot:read / bot:write. Tài khoản người dùng: accounts:read (xem) / accounts:write (đổi quyền, gỡ Zalo, xoá).
app.get('/api/admin/members', need('accounts:read'), wrap(async (req, res) => {
  res.json({ members: await listMembers(), termsVersion: TERMS_VERSION, roles: ROLES, canWrite: can(req.me, 'accounts:write'), me: req.me.id });
}));
app.put('/api/admin/members/:id/role', need('accounts:write'), wrap(async (req, res) => {
  const u = await setRole(req.me, req.params.id, String(req.body?.role || ''));
  res.json({ ok: true, id: u.id, role: u.role });
}));
app.delete('/api/admin/members/:id', need('accounts:write'), wrap(async (req, res) => {
  if (req.params.id === req.me.id) throw fail(400, 'Muốn xoá tài khoản của mình, dùng mục Tài khoản');
  const target = await getMember(req.params.id);
  if (target?.role === 'owner' && (await listMembers()).filter((m) => m.role === 'owner').length <= 1) throw fail(409, 'Phải còn ít nhất một Owner');
  if (!(await deleteMember(req.params.id))) throw fail(404, 'Không tìm thấy thành viên');
  res.json({ ok: true });
}));
app.delete('/api/admin/members/:id/zalo', need('accounts:write'), wrap(async (req, res) => {
  await unlinkZalo(req.params.id);
  res.json({ ok: true });
}));
app.get('/api/admin/audit', need('accounts:read'), wrap(async (req, res) => res.json({ audit: await readAudit() })));

app.get('/api/admin/bot-settings', need('bot:read'), wrap(async (req, res) => {
  res.json({ settings: await memberSettings(), appUrl: appUrl(req), canWrite: can(req.me, 'bot:write') });
}));
app.put('/api/admin/bot-settings', need('bot:write'), wrap(async (req, res) => res.json(await saveMemberSettings(req.body || {}))));
app.get('/api/admin/calbot-log', need('bot:read'), wrap(async (req, res) => {
  const { from, to, member } = req.query;
  res.json({ entries: await readLog({ from, to, member }) });
}));
app.get('/api/admin/calbot-log/csv', need('bot:read'), wrap(async (req, res) => {
  const { from, to, member } = req.query;
  const csv = logToCsv(await readLog({ from, to, member }));
  res.set('Content-Disposition', `attachment; filename="calbot-log-${from || dayKey()}_${to || dayKey()}.csv"`);
  res.type('text/csv; charset=utf-8').send(csv);
}));

// Trạng thái và khoá của bot lịch (Gemini, Zalo nhắc việc, Google OAuth, lưu trữ, cron, khoá agent).
app.get('/api/admin/bot', need('bot:read'), wrap(async (req, res) => {
  const store = await Store.open();
  const owner = await openOwnerStore();
  const d = store.data;
  const base = baseUrl(req);
  res.json({
    config: {
      gemini: geminiConfigured(), geminiModel: cfg('GEMINI_MODEL') || DEFAULT_MODEL,
      keys: Object.fromEntries(['GEMINI_API_KEY', 'ZALO_BOT_TOKEN', 'GEMINI_MODEL'].map((k) => [k, { source: cfgSource(k), masked: k === 'GEMINI_MODEL' ? cfg(k) : mask(cfg(k)) }])),
      zalo: zaloConfigured(), zaloMode: isVercel ? 'webhook' : process.env.ZALO_MODE || 'polling', zaloReceiver: zaloReceiver(store),
      zaloOwner: ownerChatId(owner) ? { name: owner.data.meta.zaloName || null, fromEnv: Boolean(process.env.ZALO_CHAT_ID) } : null,
      agent: { enabled: Boolean(d.settings?.agentTokenHash), createdAt: d.settings?.agentTokenAt || null, base: `${base}/api/agent` },
      app: { url: appUrl(req), host: PRIMARY_HOST || null, origin: PRIMARY_HOST ? `https://${PRIMARY_HOST}` : base, redirectUri: `${PRIMARY_HOST ? `https://${PRIMARY_HOST}` : base}/api/google/callback` },
      storage: storageKind(), vercel: isVercel, tokenKey: encKeyConfigured() || !isVercel,
      cronUrl: `${base}/api/cron${process.env.CRON_SECRET ? '?key=<CRON_SECRET>' : ''}`, cronLast: await kv.get('cron:last'),
      migration: await migrationInfo(), ownerEmails: Boolean(process.env.OWNER_EMAILS),
      google: {
        configured: googleConfigured(),
        clientId: { source: cfgSource('GOOGLE_CLIENT_ID'), masked: mask(cfg('GOOGLE_CLIENT_ID')) },
        clientSecret: { source: cfgSource('GOOGLE_CLIENT_SECRET'), masked: mask(cfg('GOOGLE_CLIENT_SECRET')) },
      },
    },
    canWrite: can(req.me, 'bot:write'),
  });
}));

// Khoá API nhập trên web: gửi chuỗi rỗng để xoá (quay về biến môi trường nếu có); bỏ qua trường không gửi.
app.put('/api/admin/keys', need('bot:write'), wrap(async (req, res) => {
  const body = req.body || {};
  const fields = {
    geminiApiKey: 'GEMINI_API_KEY', zaloBotToken: 'ZALO_BOT_TOKEN', geminiModel: 'GEMINI_MODEL',
    googleClientId: 'GOOGLE_CLIENT_ID', googleClientSecret: 'GOOGLE_CLIENT_SECRET',
  };
  // Đổi ứng dụng đăng nhập Google là việc chỉ Owner được làm (ai giữ Client ID/Secret là người nhận quyền đăng nhập của mọi người).
  if (('googleClientId' in body || 'googleClientSecret' in body) && !can(req.me, 'accounts:write')) throw fail(403, 'Chỉ Owner mới đổi được Google Client ID/Secret');
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

  const result = { saved: changed };
  if (changed.includes('geminiApiKey') || changed.includes('geminiModel')) result.gemini = await checkGemini();
  if (changed.includes('googleClientId') || changed.includes('googleClientSecret')) result.googleConfigured = googleConfigured();
  if (changed.includes('zaloBotToken') && zaloConfigured()) {
    try {
      const me = await getMe();
      result.zalo = { ok: true, name: me?.display_name || me?.account_name || me?.name || null };
      if (zaloReceiver(store) === 'web' && (isVercel || (process.env.ZALO_MODE === 'webhook' && baseUrl(req).startsWith('https://')))) {
        try { await setWebhook(`${baseUrl(req)}/api/zalo/webhook`); result.zalo.webhook = true; } catch (err) { result.zalo.webhookError = err.message; }
      }
    } catch (err) {
      result.zalo = { ok: false, error: err.message };
    }
  }
  res.json(result);
}));

// Khoá cho PyloS: chỉ hiện đúng 1 lần lúc tạo; máy chủ chỉ lưu mã băm.
app.post('/api/admin/agent-token', need('bot:write'), wrap(async (req, res) => {
  const token = `qltg_${crypto.randomBytes(24).toString('hex')}`;
  const at = new Date().toISOString();
  await mutate((s) => { s.data.settings = { ...s.data.settings, agentTokenHash: sha256(token), agentTokenAt: at }; });
  await kv.set('agent-token', { hash: sha256(token), at });
  agentHashCache = { hash: undefined, at: 0 };
  res.json({ token });
}));
app.delete('/api/admin/agent-token', need('bot:write'), wrap(async (req, res) => {
  await mutate((s) => { delete s.data.settings.agentTokenHash; delete s.data.settings.agentTokenAt; });
  await kv.del('agent-token');
  agentHashCache = { hash: undefined, at: 0 };
  res.json({ ok: true });
}));
app.put('/api/admin/zalo/receiver', need('bot:write'), wrap(async (req, res) => {
  const receiver = req.body?.receiver === 'agent' ? 'agent' : 'web';
  const chatId = req.body?.chatId != null ? String(req.body.chatId).trim() : null;
  if (chatId && /\s/.test(chatId)) throw fail(400, 'ID Zalo không được chứa khoảng trắng');
  await mutate((s) => { s.data.settings = { ...s.data.settings, zaloReceiver: receiver }; });
  if (chatId) await mutateOwner((s) => { s.data.meta.zaloChatId = chatId; s.data.meta.zaloName = s.data.meta.zaloName || null; });
  const result = { receiver };
  if (receiver === 'web' && zaloConfigured() && baseUrl(req).startsWith('https://')) {
    try { await setWebhook(`${baseUrl(req)}/api/zalo/webhook`); result.webhook = true; } catch (err) { result.webhookError = err.message; }
  }
  res.json(result);
}));
async function mutateOwner(fn) {
  const store = await openOwnerStore();
  if (!store.id) throw fail(409, 'Chưa có Owner nào');
  const r = await fn(store);
  await store.save();
  return r;
}
const needZalo = () => { if (!zaloConfigured()) throw fail(400, 'Chưa cấu hình ZALO_BOT_TOKEN'); };
app.get('/api/admin/zalo/me', need('bot:write'), wrap(async (req, res) => { needZalo(); res.json(await getMe()); }));
app.post('/api/admin/zalo/webhook-setup', need('bot:write'), wrap(async (req, res) => {
  needZalo();
  // Địa chỉ webhook khác web này (Zalo sẽ gửi mọi tin nhắn về đó): chỉ Owner được đặt.
  if (req.body?.baseUrl && !can(req.me, 'accounts:write')) throw fail(403, 'Chỉ Owner mới đặt được địa chỉ webhook khác');
  const base = String(req.body?.baseUrl || baseUrl(req)).replace(/\/$/, '');
  if (!base.startsWith('https://')) throw fail(400, 'Webhook cần địa chỉ https công khai');
  const url = `${base}/api/zalo/webhook`;
  res.json({ url, result: await setWebhook(url) });
}));
// Mã ghép nối: gửi "/ketnoi <mã>" cho bot Zalo nhắc việc để bot biết ai nhận nhắc việc (dữ liệu của Owner chính).
app.post('/api/admin/zalo/pair', need('bot:write'), wrap(async (req, res) => {
  needZalo();
  const code = String(crypto.randomInt(100000, 1000000));
  await mutateOwner((s) => {
    s.data.meta.pairCode = code;
    s.data.meta.pairExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  });
  res.json({ code, expiresInMinutes: 15 });
}));
app.post('/api/admin/zalo/unpair', need('bot:write'), wrap(async (req, res) => {
  await mutateOwner((s) => { s.data.meta.zaloChatId = null; s.data.meta.zaloName = null; });
  res.json({ ok: true });
}));
app.post('/api/admin/zalo/test', need('bot:write'), wrap(async (req, res) => {
  needZalo();
  const chatId = ownerChatId(await openOwnerStore());
  if (!chatId) throw fail(400, 'Chưa kết nối Zalo: lấy mã ghép nối rồi gửi /ketnoi <mã> cho bot');
  await sendMessage(chatId, '✅ Kết nối thành công! Bot sẽ nhắc việc cho bạn ở đây.');
  res.json({ ok: true });
}));
app.post('/api/admin/cron-run', need('bot:write'), wrap(async (req, res) => {
  const report = await runCron({ forceSync: true });
  await kv.set('cron:last', { at: new Date().toISOString(), report }, { ex: 7 * 24 * 3600 });
  res.json(report);
}));
app.post('/api/admin/migrate', need('bot:write'), wrap(async (req, res) => res.json(await migrateLegacy({ force: req.body?.force === true }))));

app.use('/api', (req, res) => res.status(404).json({ error: 'Không có API này' }));

// ----- Trang: một giao diện cho mọi người (views/app.html) -----
const sendPage = (res, name) => res.set('Cache-Control', 'no-cache').sendFile(path.join(root, 'views', name));
app.get('/', (req, res) => sendPage(res, 'app.html'));
app.get(['/app', '/app/'], (req, res) => res.redirect(302, `/${req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''}`));
app.get(['/manifest.webmanifest', '/app/manifest.webmanifest'], (req, res) => {
  res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
    name: 'iforgotmywayhome',
    short_name: 'iforgotmywayhome',
    description: 'Lịch, việc cần làm, và lịch được giao trong nhóm Zalo tự vào Google Lịch của bạn',
    lang: 'vi',
    dir: 'ltr',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    categories: ['productivity', 'utilities'],
    background_color: '#1d1f24',
    theme_color: '#1d1f24',
    icons: [
      { src: '/app/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/app/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/app/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
    // Có ảnh chụp thì Chrome Android hiện hộp cài đặt lớn có ảnh (điện thoại: narrow, máy tính: wide).
    screenshots: [
      { src: '/app/screenshot-narrow.png', sizes: '540x960', type: 'image/png', form_factor: 'narrow', label: 'Tổng quan trên điện thoại' },
      { src: '/app/screenshot-wide.png', sizes: '1280x720', type: 'image/png', form_factor: 'wide', label: 'Lịch trên máy tính' },
    ],
    // Nhấn giữ icon để vào thẳng mục cần dùng.
    shortcuts: [
      { name: 'Lịch', short_name: 'Lịch', url: '/#/lich', icons: [{ src: '/app/icon-192.png', sizes: '192x192', type: 'image/png' }] },
      { name: 'Công việc', short_name: 'Công việc', url: '/#/cong-viec', icons: [{ src: '/app/icon-192.png', sizes: '192x192', type: 'image/png' }] },
      { name: 'Đề xuất', short_name: 'Đề xuất', url: '/#/de-xuat', icons: [{ src: '/app/icon-192.png', sizes: '192x192', type: 'image/png' }] },
    ],
  }));
});

// File tĩnh: CSS, JS, font, ảnh (trên Vercel thư mục public/ được phục vụ trực tiếp, đây là dự phòng khi chạy trên máy).
app.use(express.static(path.join(root, 'public')));

// Lỗi chưa bắt (JSON hỏng, gửi quá lớn…): trả JSON ngắn gọn, không lộ chi tiết bên trong máy chủ.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.warn('[app]', req.method, req.path, err.message);
  const message = status === 413 ? 'Dữ liệu gửi lên quá lớn' : status === 400 ? 'Dữ liệu gửi lên không hợp lệ' : 'Lỗi máy chủ';
  res.status(status).json({ error: message });
});

export default app;
