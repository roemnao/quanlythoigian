import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, OWNER } from './helpers.js';

// Tên miền chính iforgotmywayhome.example; localhost đóng vai tên miền cũ (quanlythoigian-azure).
const t = await boot({ PRIMARY_HOST: 'https://IForgot.Example/' });
const { call, signIn } = t;
test.after(() => t.close());
const PRIMARY = 'iforgot.example';

test('tên miền chính: trang và API đủ; trang ở tên miền cũ chuyển 308 về tên miền chính', async () => {
  const home = await call('GET', '/', null, { host: PRIMARY });
  assert.equal(home.status, 200);
  assert.match(home.data, /<title>iforgotmywayhome<\/title>/);
  assert.equal((await call('GET', '/api/me', null, { host: PRIMARY })).status, 401);

  const moved = await call('GET', '/?device=abc', null);
  assert.equal(moved.status, 308);
  assert.equal(moved.location, 'https://iforgot.example/?device=abc');
  assert.equal((await call('GET', '/app/', null)).status, 308);
  assert.equal((await call('GET', '/theme.css', null)).location, 'https://iforgot.example/theme.css');
});

test('tên miền cũ: chỉ còn API dùng chung (bot Zalo PyloS, webhook Zalo, cron, .ics), API khác 404', async () => {
  assert.equal((await call('GET', '/api/me')).status, 404, 'cookie nằm ở tên miền chính');
  assert.equal((await call('GET', '/api/admin/members')).status, 404);
  assert.equal((await call('GET', '/api/google/start?purpose=member')).status, 404);
  assert.equal((await call('POST', '/api/agent/assign', { title: 'x' })).status, 401, 'PyloS vẫn gọi được (cần khoá)');
  assert.equal((await call('POST', '/api/zalo/webhook', {})).status, 403, 'webhook không bị chuyển hướng');
  assert.equal((await call('GET', '/api/cron')).status, 200);
});

test('đăng nhập và link gửi cho mọi người nằm ở tên miền chính', async () => {
  const owner = (await signIn(OWNER, { host: PRIMARY })).cookie;
  const token = (await call('POST', '/api/admin/agent-token', null, { cookie: owner, host: PRIMARY })).data.token;
  const r = await call('POST', '/api/agent/assign', { title: 'Họp', start: '2026-12-01T09:00:00+07:00', assignees: [{ zaloUid: 'z-ai-do' }] }, { token });
  assert.equal(r.data.appUrl, 'https://iforgot.example/');
  const info = (await call('GET', '/api/admin/bot', null, { cookie: owner, host: PRIMARY })).data.config.app;
  assert.equal(info.redirectUri, 'https://iforgot.example/api/google/callback');
  assert.equal(info.origin, 'https://iforgot.example');
  const manifest = (await call('GET', '/manifest.webmanifest', null, { host: PRIMARY })).data;
  assert.equal(manifest.start_url, '/');
});
