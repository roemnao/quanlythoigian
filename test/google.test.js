import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qltg-g-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
delete process.env.APP_PASSWORD;
process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'secret-xyz';

const { fromGoogle, toGoogle } = await import('../src/google.js');
const { default: app } = await import('../src/app.js');

// Giả lập Google: chặn các lời gọi tới máy chủ Google, còn lại đi bình thường.
const realFetch = globalThis.fetch;
const google = { user: { sub: 'g-1', email: 'roemnao@gmail.com' }, events: [], inserted: [], patched: [], deleted: [] };
const idToken = (claims) => `x.${Buffer.from(JSON.stringify({
  iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, exp: Date.now() / 1000 + 600, email_verified: true, ...claims,
})).toString('base64url')}.sig`;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u === 'https://oauth2.googleapis.com/token') {
    const body = new URLSearchParams(String(opts.body));
    if (body.get('grant_type') === 'refresh_token') return json({ access_token: 'at-2', expires_in: 3600 });
    return json({ access_token: 'at-1', refresh_token: body.get('code') === 'cal' ? 'rt-1' : undefined, id_token: idToken(google.user) });
  }
  if (u.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
  if (u.includes('/users/me/calendarList')) return json({ items: [{ id: 'roemnao@gmail.com', summary: 'Roemnao', primary: true }] });
  if (u.includes('/calendars/') && u.includes('/events')) {
    const method = opts.method || 'GET';
    if (method === 'GET') return json({ items: google.events });
    if (method === 'POST') { const b = JSON.parse(opts.body); google.inserted.push(b); return json({ id: `gid-${google.inserted.length}` }); }
    if (method === 'PATCH') { google.patched.push(u); return json({}); }
    if (method === 'DELETE') { google.deleted.push(u); return new Response(null, { status: 204 }); }
  }
  return realFetch(url, opts);
};

const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function call(method, url, body, cookie) {
  const res = await realFetch(base + url, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body && JSON.stringify(body),
  });
  const cookies = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
  return { status: res.status, location: res.headers.get('location'), cookies, data: await res.json().catch(() => null) };
}
const errorOf = (location) => new URL(location, 'http://x').searchParams.get('google_error') || '';
// Chạy hết vòng đăng nhập Google: /start → (Google) → /callback với mã giả.
async function oauth(purpose, code, session) {
  const start = await call('GET', `/api/google/start?purpose=${purpose}`, null, session);
  assert.equal(start.status, 302);
  const to = new URL(start.location);
  assert.equal(to.host, 'accounts.google.com');
  const oauthCookie = start.cookies.find((c) => c.startsWith('qltg_oauth='));
  const cookie = [session, oauthCookie].filter(Boolean).join('; ');
  const cb = await call('GET', `/api/google/callback?code=${code}&state=${to.searchParams.get('state')}`, null, cookie);
  return { to, cb, session: cb.cookies.find((c) => c.startsWith('qltg_session=')) || session };
}

test('chuyển đổi sự kiện Google ⇄ web', () => {
  const allDay = fromGoogle({ id: 'a', summary: 'Nghỉ lễ', start: { date: '2026-10-28' }, end: { date: '2026-10-29' } });
  assert.equal(allDay.start, '2026-10-27T17:00:00.000Z'); // 00:00 giờ Việt Nam
  assert.equal(allDay.allDay, true);
  assert.equal(fromGoogle({ id: 'b', status: 'cancelled', start: { dateTime: '2026-10-28T09:00:00+07:00' } }), null);
  assert.equal(fromGoogle({ id: 'c', start: { dateTime: 'x' }, extendedProperties: { private: { qltgId: 'e1' } } }), null);
  const body = toGoogle({ id: 'e1', title: 'Họp', start: '2026-10-28T02:00:00.000Z', end: null, note: 'P301' });
  assert.equal(body.end.dateTime, '2026-10-28T03:00:00.000Z');
  assert.equal(body.extendedProperties.private.qltgId, 'e1');
  assert.deepEqual(toGoogle({ id: 'e2', title: 'Sinh nhật', start: '2026-10-27T17:00:00.000Z', allDay: true }).start, { date: '2026-10-28' });
});

test('tạo tài khoản bằng Google, đăng nhập bằng Google, người lạ bị từ chối', async () => {
  const st = await call('GET', '/api/auth/status');
  assert.equal(st.data.googleSetup, true);

  const { to, cb, session } = await oauth('setup', 'login');
  assert.equal(to.searchParams.get('scope'), 'openid email profile');
  assert.equal(cb.location, '/?google=setup');
  const me = await call('GET', '/api/state', null, session);
  assert.equal(me.status, 200);
  assert.equal(me.data.config.auth.username, 'roemnao');
  assert.equal(me.data.config.google.linked, 'roemnao@gmail.com');

  // Đăng xuất rồi đăng nhập lại bằng Google.
  assert.equal((await call('GET', '/api/auth/status')).data.googleLogin, true);
  const again = await oauth('login', 'login');
  assert.equal(again.cb.location, '/?google=login');
  assert.equal((await call('GET', '/api/state', null, again.session)).status, 200);

  // Tài khoản Google khác không vào được.
  google.user = { sub: 'g-2', email: 'nguoila@gmail.com' };
  const stranger = await oauth('login', 'login');
  assert.match(errorOf(stranger.cb.location), /chưa được liên kết/);
  assert.ok(!stranger.cb.cookies.some((c) => c.startsWith('qltg_session=')));
  google.user = { sub: 'g-1', email: 'roemnao@gmail.com' };

  // State giả (không có cookie khớp) bị từ chối.
  const forged = await call('GET', '/api/google/callback?code=login&state=login.abc');
  assert.match(errorOf(forged.location), /không hợp lệ/);

  // Tài khoản tạo bằng Google đặt mật khẩu lần đầu không cần mật khẩu cũ.
  assert.equal((await call('POST', '/api/account/password', { next: 'matkhau1' }, session)).status, 200);
  assert.equal((await call('POST', '/api/login', { username: 'roemnao', password: 'matkhau1' })).status, 200);
});

test('kết nối Google Lịch: kéo lịch về, đẩy lịch tạo trên web lên', async () => {
  const login = await call('POST', '/api/login', { username: 'roemnao', password: 'matkhau1' });
  let session = login.cookies[0];
  // Không đăng nhập thì không kết nối lịch được.
  assert.match(errorOf((await call('GET', '/api/google/start?purpose=calendar')).location), /đăng nhập/);

  const in3days = new Date(Date.now() + 3 * 864e5);
  google.events = [{ id: 'g-ev-1', summary: 'Họp từ Google', start: { dateTime: in3days.toISOString() }, end: { dateTime: new Date(+in3days + 3600e3).toISOString() } }];
  const r = await oauth('calendar', 'cal', session);
  session = r.session;
  assert.equal(r.to.searchParams.get('access_type'), 'offline');
  assert.equal(r.cb.location, '/?google=calendar');

  let st = (await call('GET', '/api/state', null, session)).data;
  assert.equal(st.config.google.calendar.email, 'roemnao@gmail.com');
  assert.ok(!JSON.stringify(st).includes('rt-1'), 'không lộ refresh token');
  const fromG = st.events.find((e) => e.origin === 'google');
  assert.equal(fromG.title, 'Họp từ Google');
  assert.equal((await call('DELETE', `/api/events/${fromG.id}`, null, session)).status, 400);

  // Tạo lịch trên web → được đẩy lên Google; sửa → cập nhật; xoá → xoá bên Google.
  const created = await call('POST', '/api/events', { title: 'Khám răng', start: in3days.toISOString() }, session);
  await call('POST', '/api/google/sync', null, session);
  assert.equal(google.inserted.at(-1).summary, 'Khám răng');
  st = (await call('GET', '/api/state', null, session)).data;
  const mine = st.events.find((e) => e.id === created.data.id);
  assert.ok(mine.googleId);

  await call('PATCH', `/api/events/${mine.id}`, { title: 'Khám răng (dời)' }, session);
  await call('POST', '/api/google/sync', null, session);
  assert.ok(google.patched.some((u) => u.endsWith(encodeURIComponent(mine.googleId))));

  await call('DELETE', `/api/events/${mine.id}`, null, session);
  await call('POST', '/api/google/sync', null, session);
  assert.ok(google.deleted.some((u) => u.endsWith(encodeURIComponent(mine.googleId))));

  // Ngắt kết nối: xoá lịch kéo từ Google.
  await call('POST', '/api/google/disconnect', null, session);
  st = (await call('GET', '/api/state', null, session)).data;
  assert.equal(st.config.google.calendar, null);
  assert.ok(!st.events.some((e) => e.origin === 'google'));
});
