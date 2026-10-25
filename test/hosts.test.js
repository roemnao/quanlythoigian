import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hai tên miền: web app ở app.example, trang quản trị ở mọi tên miền khác (ở đây là localhost).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qltg-h-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
process.env.APP_HOST = 'https://App.Example/';
process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'secret-xyz';
delete process.env.APP_PASSWORD;

const { default: app } = await import('../src/app.js');
const members = await import('../src/members.js');

const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

// app.example: giả tên miền bằng X-Forwarded-Host (app bật trust proxy, giống Vercel).
async function call(method, url, { host, body, cookie, token } = {}) {
  const res = await fetch(base + url, {
    method, redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      ...(host ? { 'X-Forwarded-Host': host } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* HTML */ }
  return { status: res.status, location: res.headers.get('location'), cookies: res.headers.getSetCookie?.() || [], data, type: res.headers.get('content-type') };
}
const APP = 'app.example';

let admin; let token; let member;

test('mỗi tên miền một trang; /app/ chuyển đúng chỗ', async () => {
  const appPage = await call('GET', '/', { host: APP });
  assert.match(appPage.data, /\/app\/app\.js/);
  assert.doesNotMatch(appPage.data, /admin\.js/);
  const adminPage = await call('GET', '/');
  assert.match(adminPage.data, /\/admin\/admin\.js/);
  assert.doesNotMatch(adminPage.data, /\/app\/app\.js/);

  const onApp = await call('GET', '/app/?google=member', { host: APP });
  assert.deepEqual([onApp.status, onApp.location], [302, '/?google=member']);
  const fromAdmin = await call('GET', '/app/');
  assert.equal(fromAdmin.status, 302);
  assert.equal(fromAdmin.location, `http://app.example:${server.address().port}/`);

  const manifest = await call('GET', '/manifest.webmanifest', { host: APP });
  assert.equal(manifest.data.start_url, '/');
  assert.equal(manifest.data.scope, '/');
  assert.equal((await call('GET', '/manifest.webmanifest')).status, 404);
});

test('tên miền app không có API quản trị; tên miền quản trị không có API thành viên', async () => {
  // Tạo tài khoản quản trị ở tên miền quản trị.
  const setup = await call('POST', '/api/setup', { body: { username: 'chuweb', password: 'matkhau' } });
  assert.equal(setup.status, 200);
  admin = setup.cookies[0].split(';')[0];
  token = (await call('POST', '/api/settings/agent-token', { cookie: admin })).data.token;

  for (const url of ['/api/auth/status', '/api/state', '/api/admin/members', '/calendar.ics', '/api/google/sync']) {
    assert.equal((await call('GET', url, { host: APP, cookie: admin })).status, 404, url);
  }
  assert.equal((await call('POST', '/api/login', { host: APP, body: { username: 'chuweb', password: 'matkhau' } })).status, 404);
  assert.equal((await call('GET', '/api/me', { host: APP })).status, 401, 'API thành viên có ở tên miền app');
  assert.equal((await call('GET', '/api/me')).status, 404);
  assert.equal((await call('POST', '/api/me/device-login/approve', { body: { code: 'a'.repeat(32) } })).status, 404, 'duyệt đăng nhập bot chỉ ở tên miền app');
  assert.equal((await call('POST', '/api/me/device-login/approve', { host: APP, body: { code: 'a'.repeat(32) } })).status, 401);
  assert.equal((await call('POST', '/api/me/zalo-code')).status, 404);
  assert.equal((await call('GET', '/api/state', { cookie: admin })).status, 200);

  // Bot Zalo gọi được ở cả hai tên miền.
  for (const host of [APP, undefined]) {
    assert.equal((await call('GET', '/api/agent/config', { host, token })).status, 200);
  }
});

test('đăng nhập Google: thành viên ở tên miền app, quản trị ở tên miền quản trị', async () => {
  const fromAdmin = await call('GET', `/api/google/start?purpose=member&terms=${members.TERMS_VERSION}`);
  assert.equal(fromAdmin.status, 302);
  assert.equal(fromAdmin.location, `http://app.example:${server.address().port}/api/google/start?purpose=member&terms=${members.TERMS_VERSION}`);

  const onApp = await call('GET', `/api/google/start?purpose=member&terms=${members.TERMS_VERSION}`, { host: APP });
  assert.equal(onApp.status, 302);
  assert.equal(new URL(onApp.location).host, 'accounts.google.com');
  assert.equal(new URL(onApp.location).searchParams.get('redirect_uri'), `${base}/api/google/callback`);

  assert.equal((await call('GET', '/api/google/start?purpose=login', { host: APP })).status, 404);
  assert.equal((await call('GET', '/api/google/start?purpose=login')).status, 302);

  // Callback của thành viên lạc sang tên miền quản trị thì bị từ chối (cookie phiên đăng nhập nằm ở tên miền app).
  const nonce = onApp.cookies.find((c) => c.startsWith('qltg_oauth='))?.split(';')[0];
  const state = new URL(onApp.location).searchParams.get('state');
  const wrongHost = await call('GET', `/api/google/callback?code=x&state=${state}`, { cookie: nonce });
  assert.match(decodeURIComponent(wrongHost.location), /^\/app\/\?google_error=Phiên\+đăng\+nhập\+Google\+không\+hợp\+lệ/);
  assert.equal(wrongHost.cookies.some((c) => c.startsWith('qltg_member=')), false);
  // …rồi /app/ đưa người dùng về web app ở tên miền app, giữ nguyên thông báo lỗi.
  const forwarded = await call('GET', wrongHost.location);
  assert.equal(forwarded.location, `http://app.example:${server.address().port}${wrongHost.location.slice('/app'.length)}`);
});

test('link web app gửi cho mọi người là tên miền app', async () => {
  const { user } = await members.signInMember({ sub: 'g-1', email: 'an@gmail.com', name: 'An' }, { acceptedTerms: members.TERMS_VERSION });
  member = `qltg_member=${await members.memberCookieValue(user.id)}`;
  const { code } = (await call('POST', '/api/me/zalo-code', { host: APP, cookie: member })).data;
  await call('POST', '/api/agent/zalo-link', { body: { code, zaloUid: 'z-an' }, token });
  const assigned = await call('POST', '/api/agent/assign', {
    token, body: { title: 'Họp', start: '2026-10-30T09:00:00+07:00', assignees: [{ zaloUid: 'z-an' }, { zaloUid: 'z-chua' }] },
  });
  assert.equal(assigned.data.appUrl, `http://app.example:${server.address().port}/`);
  const list = (await call('GET', '/api/admin/members', { cookie: admin })).data;
  assert.equal(list.appUrl, `http://app.example:${server.address().port}/`);
  const state = (await call('GET', '/api/state', { cookie: admin })).data;
  assert.deepEqual(state.config.app, {
    separate: true, host: 'app.example', url: `http://app.example:${server.address().port}/`,
    origin: `http://app.example:${server.address().port}`, redirectUri: `http://app.example:${server.address().port}/api/google/callback`,
  });
  // Thành viên lấy lệnh ở tên miền app.
  assert.equal((await call('GET', '/api/me/commands?after=0', { host: APP, cookie: member })).data.commands.length, 1);
});
