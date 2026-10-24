import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qltg-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
delete process.env.APP_PASSWORD;
const { default: app } = await import('../src/app.js');

const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], data: await res.json().catch(() => null) };
}

test('tạo tài khoản quản trị, đăng nhập, đổi mật khẩu', async () => {
  let r = await call('GET', '/api/auth/status');
  assert.equal(r.data.needsAdmin, true);

  assert.equal((await call('POST', '/api/setup', { username: 'Ro Em', password: 'test' })).status, 400);
  r = await call('POST', '/api/setup', { username: 'Roemnao', password: 'test' });
  assert.equal(r.status, 200);
  assert.equal(r.data.username, 'roemnao');
  const first = r.cookie;
  assert.ok(first);

  // Không tạo được tài khoản thứ hai, không xem được dữ liệu khi chưa đăng nhập.
  assert.equal((await call('POST', '/api/setup', { username: 'hacker', password: 'abcd' })).status, 409);
  assert.equal((await call('GET', '/api/state')).status, 401);
  assert.equal((await call('GET', '/api/state', null, first)).status, 200);

  assert.equal((await call('POST', '/api/login', { username: 'roemnao', password: 'sai' })).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'khac', password: 'test' })).status, 401);
  r = await call('POST', '/api/login', { username: 'ROEMNAO', password: 'test' });
  assert.equal(r.status, 200);

  // Mật khẩu chỉ lưu dạng băm.
  const raw = fs.readFileSync(process.env.DATA_FILE, 'utf8');
  assert.ok(!raw.includes('"test"'));

  assert.equal((await call('POST', '/api/account/password', { current: 'sai', next: 'moi12345' }, first)).status, 401);
  r = await call('POST', '/api/account/password', { current: 'test', next: 'moi12345' }, first);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/state', null, first)).status, 401, 'phiên cũ hết hiệu lực');
  assert.equal((await call('GET', '/api/state', null, r.cookie)).status, 200);
  assert.equal((await call('POST', '/api/login', { username: 'roemnao', password: 'moi12345' })).status, 200);

  // Link lịch cần khoá.
  const state = (await call('GET', '/api/state', null, r.cookie)).data;
  assert.equal(state.config.auth.username, 'roemnao');
  assert.equal((await fetch(`${base}/calendar.ics`)).status, 401);
  assert.equal((await fetch(state.config.calendarUrl.replace(/^https?:\/\/[^/]+/, base))).status, 200);
});
