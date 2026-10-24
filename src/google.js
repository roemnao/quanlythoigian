// Google: đăng nhập / liên kết bằng tài khoản Google (OpenID Connect) và đồng bộ 2 chiều với Google Lịch.
// Cần một OAuth Client (Web application) tạo trong Google Cloud Console — xem README.
import { cfg } from './config.js';
import { dayKey, TZ, zonedMidnight } from './time.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CAL = 'https://www.googleapis.com/calendar/v3';
const DAY = 24 * 3600 * 1000;
const PAST_DAYS = 7;
const FUTURE_DAYS = 90;

const LOGIN_SCOPES = ['openid', 'email', 'profile'];
const CALENDAR_SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

export function googleConfigured() {
  return Boolean(cfg('GOOGLE_CLIENT_ID') && cfg('GOOGLE_CLIENT_SECRET'));
}

export function authUrl({ redirectUri, state, purpose, loginHint }) {
  const calendar = purpose === 'calendar';
  const params = new URLSearchParams({
    client_id: cfg('GOOGLE_CLIENT_ID'),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: (calendar ? CALENDAR_SCOPES : LOGIN_SCOPES).join(' '),
    state,
    // Lịch cần refresh token (offline) để đồng bộ khi bạn không mở web.
    ...(calendar ? { access_type: 'offline', prompt: 'consent' } : { prompt: 'select_account' }),
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg('GOOGLE_CLIENT_ID'), client_secret: cfg('GOOGLE_CLIENT_SECRET'), ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google: ${data.error_description || data.error || res.status}`);
  return data;
}

// id_token nhận trực tiếp từ Google qua HTTPS (bước đổi mã) nên chỉ cần kiểm tra người nhận, nơi cấp, hạn dùng.
export function decodeIdToken(idToken) {
  const part = String(idToken || '').split('.')[1];
  if (!part) throw new Error('Google không trả về id_token');
  const c = JSON.parse(Buffer.from(part, 'base64url').toString());
  if (c.aud !== cfg('GOOGLE_CLIENT_ID')) throw new Error('id_token không dành cho ứng dụng này');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(c.iss)) throw new Error('id_token không phải do Google cấp');
  if (!c.exp || c.exp * 1000 < Date.now()) throw new Error('id_token đã hết hạn');
  if (!c.email_verified) throw new Error('Email Google chưa được xác minh');
  return { sub: c.sub, email: c.email, name: c.name || null };
}

export async function exchangeCode(code, redirectUri) {
  const data = await tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  return { refreshToken: data.refresh_token || null, accessToken: data.access_token, claims: decodeIdToken(data.id_token) };
}

export async function revoke(token) {
  try { await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }); } catch { /* bỏ qua */ }
}

// Access token sống ~1 giờ; giữ trong bộ nhớ để không phải xin lại mỗi lần gọi.
const tokenCache = new Map();
async function accessToken(refreshToken) {
  const hit = tokenCache.get(refreshToken);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const data = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  tokenCache.set(refreshToken, { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

async function gapi(refreshToken, method, path, body) {
  const token = await accessToken(refreshToken);
  const res = await fetch(`${CAL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body && JSON.stringify(body),
  });
  if (res.status === 204) return null;
  if (method === 'DELETE' && (res.status === 404 || res.status === 410)) return null; // đã xoá sẵn
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Google Lịch: ${data.error?.message || res.status}`), { status: res.status });
  return data;
}

export async function listCalendars(refreshToken) {
  const data = await gapi(refreshToken, 'GET', '/users/me/calendarList?minAccessRole=reader');
  return (data.items || []).map((c) => ({
    id: c.id, name: c.summaryOverride || c.summary || c.id, primary: Boolean(c.primary), color: c.backgroundColor || null,
  }));
}

// Sự kiện Google → sự kiện của web. Bỏ qua sự kiện do chính web đẩy lên (tránh nhân đôi).
export function fromGoogle(g, calendarName) {
  if (!g || g.status === 'cancelled' || g.extendedProperties?.private?.qltgId) return null;
  const allDay = Boolean(g.start?.date);
  const start = allDay ? zonedMidnight(g.start.date) : g.start?.dateTime;
  if (!start) return null;
  return {
    uid: g.id,
    title: g.summary || '(Không tên)',
    start: new Date(start).toISOString(),
    end: allDay || !g.end?.dateTime ? null : new Date(g.end.dateTime).toISOString(),
    allDay,
    note: [g.location, g.description].filter(Boolean).join('\n').slice(0, 1000),
    link: g.htmlLink || null,
    calendar: calendarName || null,
  };
}

// Sự kiện của web → nội dung gửi lên Google Lịch.
export function toGoogle(e) {
  const body = { summary: e.title, description: e.note || '', extendedProperties: { private: { qltgId: e.id } } };
  if (e.allDay) {
    body.start = { date: dayKey(e.start) };
    body.end = { date: dayKey(new Date(new Date(e.start).getTime() + 1.5 * DAY)) };
  } else {
    const end = e.end || new Date(new Date(e.start).getTime() + 3600e3).toISOString();
    body.start = { dateTime: new Date(e.start).toISOString(), timeZone: TZ };
    body.end = { dateTime: new Date(end).toISOString(), timeZone: TZ };
  }
  return body;
}

async function fetchEvents(refreshToken, calendars, now = new Date()) {
  const timeMin = new Date(now.getTime() - PAST_DAYS * DAY).toISOString();
  const timeMax = new Date(now.getTime() + FUTURE_DAYS * DAY).toISOString();
  const out = [];
  for (const cal of calendars) {
    let pageToken;
    do {
      const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '2500' });
      if (pageToken) q.set('pageToken', pageToken);
      const data = await gapi(refreshToken, 'GET', `/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
      for (const g of data.items || []) {
        const e = fromGoogle(g, cal.name);
        if (e) out.push(e);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
  return out;
}

export const isGoogleReady = (store) => Boolean(store.data.google?.refreshToken && googleConfigured());
const localEvent = (e) => e.origin !== 'ics' && e.origin !== 'google';

// Kéo lịch từ Google về (chỉ đọc trên web). olderThanMs: bỏ qua nếu vừa đồng bộ gần đây.
export async function pullGoogle(openStore, { olderThanMs = 0 } = {}) {
  const snap = await openStore();
  if (!isGoogleReady(snap)) return null;
  const g = snap.data.google;
  if (olderThanMs && g.lastSync && Date.now() - new Date(g.lastSync).getTime() < olderThanMs) return null;
  let events = null;
  let error = null;
  try {
    const calendars = g.calendars?.length ? g.calendars : [{ id: 'primary', name: 'Lịch chính' }];
    events = await fetchEvents(g.refreshToken, calendars);
  } catch (err) {
    error = err.message;
  }
  const store = await openStore();
  if (!store.data.google) return null; // vừa ngắt kết nối
  store.data.google.lastSync = new Date().toISOString();
  store.data.google.lastError = error;
  if (events) store.replaceSourceEvents('google', events, 'google');
  await store.save();
  return error ? { ok: false, error } : { ok: true, events: events.length };
}

// ID cố định cho sự kiện trên Google (chữ a-v và số) → đẩy 2 lần cũng không tạo trùng.
export const googleEventId = (e) => `qltg${e.id}`;

// Đẩy lịch tạo trên web (tự thêm, AI, Zalo) lên lịch chính của Google; xoá bên Google khi xoá trên web.
// Chạy lần lượt (không chồng nhau) trong cùng một máy chủ.
let pushing = Promise.resolve();
export function pushGoogle(openStore) {
  const run = pushing.then(() => pushOnce(openStore));
  pushing = run.catch(() => {});
  return run;
}

async function pushOnce(openStore) {
  const snap = await openStore();
  if (!isGoogleReady(snap) || !snap.data.google.push) return null;
  const { refreshToken, pendingDeletes = [] } = snap.data.google;
  const since = Date.now() - DAY;
  const created = {}; const updated = {}; const lost = []; const deleted = []; const errors = [];

  for (const e of snap.data.events.filter(localEvent)) {
    if (e.googleId && !e.googleDirty) continue;
    if (!e.googleId && new Date(e.end || e.start).getTime() < since) continue; // không đẩy lịch cũ
    try {
      if (e.googleId) {
        await gapi(refreshToken, 'PATCH', `/calendars/primary/events/${encodeURIComponent(e.googleId)}`, toGoogle(e));
        updated[e.id] = e.googleDirty;
      } else {
        created[e.id] = (await gapi(refreshToken, 'POST', '/calendars/primary/events', { id: googleEventId(e), ...toGoogle(e) })).id;
      }
    } catch (err) {
      if (err.status === 409 && !e.googleId) created[e.id] = googleEventId(e); // đã có sẵn trên Google
      else if (err.status === 404 || err.status === 410) lost.push(e.id); // bị xoá bên Google → tạo lại lần sau
      else errors.push(err.message);
    }
  }
  for (const gid of pendingDeletes) {
    try { await gapi(refreshToken, 'DELETE', `/calendars/primary/events/${encodeURIComponent(gid)}`); deleted.push(gid); } catch (err) { errors.push(err.message); }
  }

  const store = await openStore();
  if (!store.data.google) return null;
  for (const e of store.data.events) {
    if (created[e.id]) e.googleId = created[e.id];
    // Chỉ xoá dấu "cần cập nhật" nếu không bị sửa thêm trong lúc đang đẩy.
    if (e.id in updated && e.googleDirty === updated[e.id]) delete e.googleDirty;
    if (lost.includes(e.id)) { delete e.googleId; delete e.googleDirty; }
  }
  store.data.google.pendingDeletes = (store.data.google.pendingDeletes || []).filter((gid) => !deleted.includes(gid));
  if (errors.length) store.data.google.lastError = errors[0];
  await store.save();
  return { created: Object.keys(created).length, updated: Object.keys(updated).length, deleted: deleted.length, errors };
}

export async function syncGoogle(openStore, opts = {}) {
  const pushed = await pushGoogle(openStore);
  const pulled = await pullGoogle(openStore, opts);
  return { pushed, pulled };
}
