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

test('nhập khoá API trên web: chỉ người đăng nhập, không trả lại toàn bộ key', async () => {
  process.env.ZALO_API_BASE = 'http://127.0.0.1:9'; // không gọi Zalo thật khi kiểm thử
  const login = await call('POST', '/api/login', { username: 'roemnao', password: 'moi12345' });
  const token = '1234567890:abcdefghijklmnopqrstuvwxyz';
  assert.equal((await call('PUT', '/api/settings/keys', { zaloBotToken: token })).status, 401);
  assert.equal((await call('PUT', '/api/settings/keys', { zaloBotToken: 'co khoang trang' }, login.cookie)).status, 400);
  const r = await call('PUT', '/api/settings/keys', { zaloBotToken: token }, login.cookie);
  assert.equal(r.status, 200);
  assert.equal(r.data.zalo.ok, false); // Zalo không với tới được → báo lỗi, vẫn lưu
  const st = await call('GET', '/api/state', null, login.cookie);
  assert.equal(st.data.config.zalo, true);
  assert.equal(st.data.config.keys.ZALO_BOT_TOKEN.source, 'web');
  assert.equal(st.data.config.keys.ZALO_BOT_TOKEN.masked, '1234…wxyz');
  assert.ok(!JSON.stringify(st.data).includes(token));
  // Gửi rỗng = xoá key nhập trên web.
  await call('PUT', '/api/settings/keys', { zaloBotToken: '' }, login.cookie);
  const st2 = await call('GET', '/api/state', null, login.cookie);
  assert.notEqual(st2.data.config.keys.ZALO_BOT_TOKEN.source, 'web');
});

test('API cho AI agent: khoá riêng, xử lý tin nhắn, xem lịch, tạo lịch/việc', async () => {
  const login = await call('POST', '/api/login', { username: 'roemnao', password: 'moi12345' });
  const agent = (method, url, body, token) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

  assert.equal((await agent('GET', '/api/agent/agenda', null, 'qltg_sai')).status, 401);
  const { token } = (await call('POST', '/api/settings/agent-token', null, login.cookie)).data;
  assert.match(token, /^qltg_[0-9a-f]{48}$/);
  assert.equal((await agent('GET', '/api/agent/agenda')).status, 401);

  const ev = await agent('POST', '/api/agent/events', { title: 'Họp từ agent', start: new Date().toISOString() }, token);
  assert.equal(ev.status, 200);
  const today = await agent('GET', '/api/agent/agenda?date=today', null, token);
  assert.ok(today.data.events.some((e) => e.title === 'Họp từ agent'));
  assert.match(today.data.text, /Họp từ agent/);

  const msg = await agent('POST', '/api/agent/message', { text: '/homnay' }, token);
  assert.match(msg.data.reply, /Họp từ agent/);
  const task = await agent('POST', '/api/agent/tasks', { title: 'Gọi khách' }, token);
  await agent('PATCH', `/api/agent/tasks/${task.data.id}`, { done: true }, token);
  assert.ok(!(await agent('GET', '/api/agent/tasks', null, token)).data.some((t) => t.title === 'Gọi khách'));

  // Ghép nối Zalo qua agent: agent chuyển "/ketnoi <mã>" kèm ID người gửi.
  const { code } = (await call('POST', '/api/zalo/pair', null, login.cookie)).data ?? {};
  if (code) {
    const pair = await agent('POST', '/api/agent/message', { text: `/ketnoi ${code}`, chatId: 'zalo-user-9' }, token);
    assert.match(pair.data.reply, /Đã kết nối/);
  }
  // Chế độ "agent nhận tin": lưu ID người nhận nhắc việc thủ công.
  const rc = await call('PUT', '/api/settings/zalo-receiver', { receiver: 'agent', chatId: 'zalo-user-10' }, login.cookie);
  assert.equal(rc.data.receiver, 'agent');
  assert.equal((await call('GET', '/api/state', null, login.cookie)).data.config.zaloReceiver, 'agent');

  const spec = await agent('GET', '/api/agent/openapi.json');
  assert.ok(spec.data.paths['/api/agent/message']);
  // Thu hồi khoá.
  await call('DELETE', '/api/settings/agent-token', null, login.cookie);
  assert.equal((await agent('GET', '/api/agent/agenda', null, token)).status, 401);
});
