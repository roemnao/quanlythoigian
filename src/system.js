// Quản lý hệ thống: thông số của bot Zalo (PyloS) do chủ web chỉnh ở trang quản trị, nhịp tim của bot,
// và session giữa bộ lọc và agent mà bot gửi lên để xem lại. Khoá bí mật (Gemini, Zalo) không bao giờ lên đây:
// chúng chỉ nằm ở userdata/config trên máy chạy bot, và PyloS cũng từ chối áp chúng nếu có ai gửi xuống.
import { batch, kv } from './kv.js';
import { dayKey } from './time.js';

const DAY = 24 * 3600;
const K = {
  config: 'system-config',
  status: 'bot-status',
  chats: 'session-chats',
  session: (chatId, day) => `session:${chatId}:${day}`,
};
const fail = (status, message) => Object.assign(new Error(message), { status });

// type: string | text | csv | int | bool | choice. live=false: bot cần khởi động lại mới dùng giá trị mới.
export const CONFIG_SCHEMA = [
  { group: 'Model AI', key: 'GEMINI_MODEL', type: 'string', label: 'Model của agent (trả lời, gọi tool)', placeholder: 'gemini-3.1-flash-lite', live: true },
  { group: 'Model AI', key: 'FILTER_MODEL', type: 'string', label: 'Model của bộ lọc (để trống = dùng model của agent)', placeholder: 'gemini-3.1-flash-lite', live: true },
  { group: 'Model AI', key: 'MAX_OUTPUT_TOKENS', type: 'int', min: 1, max: 65536, label: 'Số token tối đa mỗi câu trả lời', placeholder: '1024', live: true },
  { group: 'Model AI', key: 'MAX_TOOL_ROUNDS', type: 'int', min: 0, max: 20, label: 'Số vòng gọi tool tối đa mỗi tin', placeholder: '4', live: true },
  { group: 'Model AI', key: 'LLM_TIMEOUT_SECONDS', type: 'int', min: 5, max: 600, label: 'Chờ model tối đa (giây)', placeholder: '60', live: true },
  { group: 'Model AI', key: 'HISTORY_TURNS', type: 'int', min: 1, max: 200, label: 'Số lượt hội thoại nhớ trong session', placeholder: '20', live: true },

  { group: 'Bộ lọc tin nhóm', key: 'FILTER_AI', type: 'bool', label: 'Dùng AI để lọc tin nhóm (tắt = chỉ theo quy tắc)', placeholder: 'true', live: true },
  { group: 'Bộ lọc tin nhóm', key: 'FILTER_CONTEXT_LINES', type: 'int', min: 0, max: 50, label: 'Số tin trước đó gửi kèm cho bộ lọc', placeholder: '6', live: true },
  { group: 'Bộ lọc tin nhóm', key: 'BOT_NAMES', type: 'csv', label: 'Tên gọi bot (nhắc tên là bot trả lời, cách nhau dấu phẩy)', placeholder: 'bot', live: true },
  { group: 'Bộ lọc tin nhóm', key: 'BOT_TRIGGERS', type: 'csv', label: 'Lệnh gọi bot (vd /bot)', placeholder: '/bot', live: true },
  { group: 'Bộ lọc tin nhóm', key: 'MEMORYDATA_KEEP', type: 'int', min: 100, max: 1000000, label: 'Số tin giữ trong memorydata mỗi hội thoại', placeholder: '5000', live: true },

  { group: 'Giới hạn', key: 'USER_RATE_PER_MIN', type: 'int', min: 0, max: 1000, label: 'Mỗi người tối đa (tin/phút, 0 = không giới hạn)', placeholder: '6', live: false },
  { group: 'Giới hạn', key: 'CHAT_RATE_PER_MIN', type: 'int', min: 0, max: 1000, label: 'Mỗi nhóm tối đa (tin/phút, 0 = không giới hạn)', placeholder: '20', live: false },
  { group: 'Giới hạn', key: 'DAILY_TOKEN_BUDGET', type: 'int', min: 0, max: 1e9, label: 'Ngân sách token mỗi ngày (0 = không giới hạn)', placeholder: '200000', live: true },

  { group: 'Quyền', key: 'ALLOW_ALL_CHATS', type: 'bool', label: 'Trả lời mọi nhóm / người (tắt = chỉ danh sách cho phép)', placeholder: 'false', live: true },
  { group: 'Quyền', key: 'ALLOWED_CHAT_IDS', type: 'csv', label: 'ID nhóm / người được phép (cách nhau dấu phẩy)', placeholder: '', live: true },
  { group: 'Quyền', key: 'ASSIGN_ALLOWED', type: 'choice', options: ['owner', 'all'], label: 'Ai được giao lịch cho người khác (owner = chỉ chủ bot)', placeholder: 'owner', live: true },

  { group: 'Session', key: 'SESSION_UPLOAD', type: 'bool', label: 'Gửi session bộ lọc ↔ agent lên đây để xem lại', placeholder: 'true', live: true },
  { group: 'Session', key: 'SESSION_RETENTION_DAYS', type: 'int', min: 1, max: 90, label: 'Giữ session bao nhiêu ngày', placeholder: '14', live: true, serverOnly: true },

  { group: 'Tính cách & ghi nhớ', key: 'SYSTEM_MD', type: 'text', label: 'SYSTEM.md: tính cách, cách trả lời (để trống = giữ file trên máy bot)', placeholder: '', live: true, file: 'SYSTEM.md' },
  { group: 'Tính cách & ghi nhớ', key: 'MEMORY_MD', type: 'text', label: 'MEMORY.md: điều bot luôn cần nhớ (để trống = giữ file trên máy bot)', placeholder: '', live: true, file: 'MEMORY.md' },
];
const BY_KEY = Object.fromEntries(CONFIG_SCHEMA.map((f) => [f.key, f]));

function normalize(field, raw) {
  if (raw == null || raw === '') return null; // để trống = dùng giá trị trong settings.env của bot
  switch (field.type) {
    case 'int': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < field.min || n > field.max) throw fail(400, `${field.key} phải là số nguyên từ ${field.min} đến ${field.max}`);
      return n;
    }
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      if (/^(1|true|yes|on|có)$/i.test(String(raw))) return true;
      if (/^(0|false|no|off|không)$/i.test(String(raw))) return false;
      throw fail(400, `${field.key} phải là bật hoặc tắt`);
    case 'choice':
      if (!field.options.includes(String(raw))) throw fail(400, `${field.key} phải là một trong: ${field.options.join(', ')}`);
      return String(raw);
    case 'csv':
      return String(raw).split(',').map((s) => s.trim()).filter(Boolean).join(',') || null;
    case 'text':
      if (String(raw).length > 20000) throw fail(400, `${field.key} dài quá 20.000 ký tự`);
      return String(raw);
    default: {
      const s = String(raw).trim();
      if (s.length > 200 || /\s/.test(s)) throw fail(400, `${field.key} không hợp lệ (không chứa khoảng trắng, tối đa 200 ký tự)`);
      return s;
    }
  }
}

export async function getConfig() {
  return { version: 0, values: {}, updatedAt: null, ...(await kv.get(K.config)) };
}

// Chỉ nhận các khoá có trong CONFIG_SCHEMA (không có khoá bí mật nào). Gửi null / chuỗi rỗng để bỏ (bot dùng lại settings.env).
export async function saveConfig(values) {
  if (!values || typeof values !== 'object') throw fail(400, 'Thiếu "values"');
  const cur = await getConfig();
  const next = { ...cur.values };
  for (const [key, raw] of Object.entries(values)) {
    const field = BY_KEY[key];
    if (!field) throw fail(400, `Không chỉnh được ${key} từ đây`);
    const v = normalize(field, raw);
    if (v == null) delete next[key]; else next[key] = v;
  }
  const saved = { version: cur.version + 1, values: next, updatedAt: new Date().toISOString() };
  await kv.set(K.config, saved);
  return saved;
}

// Phần cấu hình gửi cho bot: thông số + nội dung file, không có thông số chỉ dùng ở máy chủ.
export function configForBot(cfg) {
  const values = {};
  const files = {};
  for (const [key, v] of Object.entries(cfg.values)) {
    const field = BY_KEY[key];
    if (!field || field.serverOnly) continue;
    if (field.file) files[field.file] = v; else values[key] = v;
  }
  return { version: cfg.version, updatedAt: cfg.updatedAt, values, files };
}

export const sessionRetentionDays = (cfg) => cfg.values.SESSION_RETENTION_DAYS || 14;

// ----- Nhịp tim -----
const STATUS_FIELDS = ['version', 'startedAt', 'mode', 'lastError', 'lastErrorAt', 'tokensToday', 'tokenBudget', 'model',
  'filterModel', 'configVersion', 'messagesToday', 'repliesToday', 'host', 'pending'];

export async function heartbeat(body) {
  const status = { at: new Date().toISOString() };
  for (const f of STATUS_FIELDS) {
    if (body?.[f] == null) continue;
    status[f] = typeof body[f] === 'number' ? body[f] : String(body[f]).slice(0, 500);
  }
  const [, cfg] = await batch().set(K.status, status, { ex: 7 * DAY }).get(K.config).exec();
  return { status, config: { version: 0, values: {}, updatedAt: null, ...cfg } };
}

export async function botStatus() {
  const s = await kv.get(K.status);
  if (!s) return { online: false, seen: false };
  return { ...s, seen: true, online: Date.now() - Date.parse(s.at) < 3 * 60 * 1000 };
}

// ----- Session giữa bộ lọc và agent -----
const KINDS = new Set(['message', 'filter', 'agent', 'tool', 'reply', 'calbot', 'error']);
const MAX_EVENTS = 200;
const MAX_STRING = 4000;

function clip(v, depth = 0) {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean' || v == null) return v;
  if (depth > 4) return '…';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clip(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, clip(x, depth + 1)]));
  return String(v);
}

export async function addSessionEvents(events, retentionDays) {
  if (!Array.isArray(events)) throw fail(400, 'Cần "events": [...]');
  const groups = new Map();
  const chats = new Map();
  for (const raw of events.slice(0, MAX_EVENTS)) {
    const chatId = String(raw?.chatId ?? '').trim().slice(0, 100);
    if (!chatId || !KINDS.has(raw?.kind)) continue;
    const at = Number.isNaN(Date.parse(raw.at)) ? new Date().toISOString() : new Date(raw.at).toISOString();
    const ev = clip({ ...raw, chatId, at });
    const key = K.session(chatId, dayKey(at));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
    chats.set(chatId, { name: raw.chatName ? String(raw.chatName).slice(0, 100) : chats.get(chatId)?.name || null, group: Boolean(raw.isGroup), lastAt: at });
  }
  if (!groups.size) return { saved: 0 };
  const b = batch();
  const ttl = (retentionDays + 1) * DAY;
  for (const [key, list] of groups) b.rpush(key, ...list).expire(key, ttl);
  for (const [chatId, info] of chats) b.hset(K.chats, chatId, info);
  await b.exec();
  return { saved: [...groups.values()].reduce((n, l) => n + l.length, 0) };
}

export async function sessionChats(retentionDays) {
  const all = await kv.hgetall(K.chats);
  const cutoff = Date.now() - retentionDays * DAY * 1000;
  const old = Object.keys(all).filter((id) => Date.parse(all[id]?.lastAt) < cutoff);
  if (old.length) await kv.hdel(K.chats, ...old);
  return Object.entries(all).filter(([id]) => !old.includes(id))
    .map(([id, info]) => ({ chatId: id, ...info })).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export async function readSession(chatId, day) {
  if (!chatId) throw fail(400, 'Cần chọn nhóm / người');
  const d = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : dayKey();
  return { chatId, day: d, events: await kv.lrange(K.session(chatId, d), 0, -1) };
}
