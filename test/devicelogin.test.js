import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Đăng nhập thiết bị: trang quản lý bot nhờ web làm chứng Gmail của chủ web.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qltg-d-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
delete process.env.APP_PASSWORD;
process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'secret-xyz';

const { default: app } = await import('../src/app.js');
const { Store } = await import('../src/db.js');
const { TERMS_VERSION } = await import('../src/members.js');
const { kv } = await import('../src/kv.js');

const realFetch = globalThis.fetch;
let googleUser = null;
const idToken = (claims) => `x.${Buffer.from(JSON.stringify({
  iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, exp: Date.now() / 1000 + 600, email_verified: true, ...claims,
})).toString('base64url')}.sig`;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url) === 'https://oauth2.googleapis.com/token') {
    return new Response(JSON.stringify({ access_token: 'at', id_token: idToken(googleUser) }), { headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};

const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function call(method, url, body, { cookie, token } = {}) {
  const res = await realFetch(base + url, {
    method, redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body && !['GET', 'HEAD'].includes(method) ? JSON.stringify(body) : undefined,
  });
  const cookies = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, location: res.headers.get('location'), cookies, data };
}

async function memberSignIn(user) {
  googleUser = user;
  const start = await call('GET', `/api/google/start?purpose=member&terms=${TERMS_VERSION}`);
  const to = new URL(start.location);
  const cb = await call('GET', `/api/google/callback?code=c&state=${to.searchParams.get('state')}`, null, { cookie: start.cookies.join('; ') });
  return cb.cookies.find((c) => c.startsWith('qltg_member='));
}

let token; let owner; let other;

test('chuẩn bị: tài khoản quản trị liên kết Gmail, hai thành viên', async () => {
  const setup = await call('POST', '/api/setup', { username: 'chuweb', password: 'matkhau' });
  token = (await call('POST', '/api/settings/agent-token', null, { cookie: setup.cookies[0] })).data.token;
  // Liên kết Gmail vào tài khoản quản trị (như bước "Liên kết Google" ở trang quản trị).
  const store = await Store.open();
  store.data.auth.admin.google = { sub: 'g-chu', email: 'chu@gmail.com' };
  await store.save();
  owner = await memberSignIn({ sub: 'g-chu', email: 'chu@gmail.com', name: 'Chủ web' });
  other = await memberSignIn({ sub: 'g-khac', email: 'khac@gmail.com', name: 'Người khác' });
  assert.ok(owner && other);
});

test('bot xin mã, thành viên duyệt, bot nhận kết quả đúng một lần', async () => {
  assert.equal((await call('POST', '/api/agent/device-login')).status, 401, 'cần khoá agent');
  const started = await call('POST', '/api/agent/device-login', null, { token });
  assert.equal(started.status, 200);
  const { code, url, expiresIn } = started.data;
  assert.match(code, /^[0-9a-f]{32}$/);
  assert.equal(expiresIn, 600);
  assert.equal(url, `${base}/app/?device=${code}`);

  assert.equal((await call('GET', `/api/agent/device-login/${code}`, null, { token })).data.status, 'pending');
  assert.equal((await call('GET', `/api/agent/device-login/${code}`)).status, 401);

  assert.equal((await call('POST', '/api/me/device-login/approve', { code })).status, 401, 'cần đăng nhập Gmail');
  const approved = await call('POST', '/api/me/device-login/approve', { code }, { cookie: owner });
  assert.deepEqual([approved.status, approved.data.email], [200, 'chu@gmail.com']);
  assert.equal((await call('POST', '/api/me/device-login/approve', { code }, { cookie: owner })).status, 409, 'đã dùng');

  const done = await call('GET', `/api/agent/device-login/${code}`, null, { token });
  assert.deepEqual(done.data, { status: 'approved', email: 'chu@gmail.com', isAdmin: true });
  assert.equal((await call('GET', `/api/agent/device-login/${code}`, null, { token })).data.status, 'expired', 'chỉ đọc một lần');
});

test('Gmail không phải của chủ web: duyệt được nhưng isAdmin = false', async () => {
  const { code } = (await call('POST', '/api/agent/device-login', null, { token })).data;
  await call('POST', '/api/me/device-login/approve', { code }, { cookie: other });
  assert.deepEqual((await call('GET', `/api/agent/device-login/${code}`, null, { token })).data,
    { status: 'approved', email: 'khac@gmail.com', isAdmin: false });
});

test('mã sai, mã hết hạn, mã lạ', async () => {
  assert.equal((await call('POST', '/api/me/device-login/approve', { code: 'abc' }, { cookie: owner })).status, 400);
  assert.equal((await call('POST', '/api/me/device-login/approve', { code: 'a'.repeat(32) }, { cookie: owner })).status, 404);
  assert.equal((await call('GET', '/api/agent/device-login/xyz', null, { token })).status, 400);
  assert.equal((await call('GET', `/api/agent/device-login/${'b'.repeat(32)}`, null, { token })).data.status, 'expired');
  const { code } = (await call('POST', '/api/agent/device-login', null, { token })).data;
  await kv.del(`devlogin:${code}`); // giả lập hết hạn
  assert.equal((await call('GET', `/api/agent/device-login/${code}`, null, { token })).data.status, 'expired');
});

test('tài khoản quản trị chưa liên kết Gmail thì không ai là admin', async () => {
  const store = await Store.open();
  delete store.data.auth.admin.google;
  await store.save();
  const { code } = (await call('POST', '/api/agent/device-login', null, { token })).data;
  await call('POST', '/api/me/device-login/approve', { code }, { cookie: owner });
  assert.equal((await call('GET', `/api/agent/device-login/${code}`, null, { token })).data.isAdmin, false);
});
