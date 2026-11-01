// Kiểm thử bảo mật: các đường tấn công đã thử trên bản chạy thật (kiểm tra 01/11/2026) và phải luôn bị chặn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, OWNER } from './helpers.js';
import { isPrivateHost } from '../src/limits.js';
import { fetchSource } from '../src/sources.js';
import { logToCsv } from '../src/calbot-log.js';

const t = await boot();
const { call, signIn, members } = t;
test.after(() => t.close());

let owner; let tech; let user; let techId; let userId;
test('thiết lập Owner, Technician, User', async () => {
  owner = (await signIn(OWNER)).cookie;
  tech = (await signIn({ sub: 'g-t', email: 't@gmail.com', name: 'T' }, { code: 'noscope' })).cookie;
  user = (await signIn({ sub: 'g-u', email: 'u@gmail.com', name: 'U' }, { code: 'noscope' })).cookie;
  techId = (await call('GET', '/api/me', null, { cookie: tech })).data.id;
  userId = (await call('GET', '/api/me', null, { cookie: user })).data.id;
  assert.equal((await call('PUT', `/api/admin/members/${techId}/role`, { role: 'technician' }, { cookie: owner })).status, 200);
});

test('header bảo mật: chống nhúng iframe, đoán kiểu file, script lạ; không lộ Express', async () => {
  const r = await call('GET', '/');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('dữ liệu sai kiểu / ngày hỏng / quá dài bị từ chối', async () => {
  const bad = [
    ['POST', '/api/me/events', { title: 'x', start: 'không phải ngày' }],
    ['POST', '/api/me/events', { title: { a: 1 }, start: '2026-11-02T09:00:00Z' }],
    ['POST', '/api/me/events', { title: 'x'.repeat(201), start: '2026-11-02T09:00:00Z' }],
    ['POST', '/api/me/events', { title: 'x', start: '2026-11-02T09:00:00Z', allDay: 'yes' }],
    ['POST', '/api/me/tasks', { title: 'x', quadrant: 9 }],
    ['POST', '/api/me/tasks', { title: 'x', deadline: 'mai' }],
    ['POST', '/api/me/tasks', { title: ['x'] }],
  ];
  for (const [m, p, body] of bad) assert.equal((await call(m, p, body, { cookie: user })).status, 400, JSON.stringify(body));
  const ok = await call('POST', '/api/me/events', { title: 'Họp', start: '2026-11-02T09:00:00+07:00', end: '', note: null }, { cookie: user });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.start, '2026-11-02T02:00:00.000Z');
  const id = ok.data.id;
  assert.equal((await call('PATCH', `/api/me/events/${id}`, { start: 'hỏng' }, { cookie: user })).status, 400);
  const big = await call('POST', '/api/me/events', { title: 'x', start: '2026-11-02T09:00:00Z', note: 'a'.repeat(300_000) }, { cookie: user });
  assert.equal(big.status, 413);
  assert.deepEqual(big.data, { error: 'Dữ liệu gửi lên quá lớn' });
});

test('đăng xuất huỷ phiên: cookie cũ (kể cả bị lấy cắp) không dùng lại được', async () => {
  const s = (await signIn({ sub: 'g-x', email: 'x@gmail.com', name: 'X' }, { code: 'noscope' })).cookie;
  assert.equal((await call('GET', '/api/me', null, { cookie: s })).status, 200);
  await call('POST', '/api/me/logout', null, { cookie: s });
  assert.equal((await call('GET', '/api/me', null, { cookie: s })).status, 401);
  const again = (await signIn({ sub: 'g-x', email: 'x@gmail.com', name: 'X' }, { code: 'noscope' })).cookie;
  assert.equal((await call('GET', '/api/me', null, { cookie: again })).status, 200, 'đăng nhập lại được');
  assert.equal(await members.verifyMemberCookie(`${userId}.1.giả`), null);
});

test('Technician không đổi được Google Client, không tự lên Owner; User không vào được quản trị', async () => {
  assert.equal((await call('PUT', '/api/admin/keys', { googleClientSecret: 'GOCSPX-evil' }, { cookie: tech })).status, 403);
  assert.equal((await call('PUT', '/api/admin/keys', { googleClientId: 'x.apps.googleusercontent.com' }, { cookie: tech })).status, 403);
  assert.equal((await call('PUT', `/api/admin/members/${techId}/role`, { role: 'owner' }, { cookie: tech })).status, 403);
  assert.equal((await call('PUT', `/api/admin/members/${userId}/role`, { role: 'owner' }, { cookie: user })).status, 403);
  assert.equal((await call('GET', '/api/admin/bot', null, { cookie: user })).status, 403);
});

test('Owner duy nhất không tự xoá được tài khoản', async () => {
  const r = await call('DELETE', '/api/me', null, { cookie: owner });
  assert.equal(r.status, 409);
  assert.equal((await call('GET', '/api/me', null, { cookie: owner })).status, 200);
});

test('chặn địa chỉ nội bộ (SSRF), kể cả dạng IPv6 ánh xạ, CGNAT', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '172.20.0.1', '100.64.0.1',
    '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'fd00::1', 'fe80::1', '0.0.0.0', 'metadata.google.internal']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ['calendar.google.com', '8.8.8.8', '2001:4860:4860::8888']) assert.equal(isPrivateHost(h), false, h);
});

test('nguồn lịch: tên miền trỏ về địa chỉ nội bộ và chuyển hướng vào nội bộ đều bị chặn', async () => {
  const lookup = async (host) => [{ address: host === 'evil.example' ? '127.0.0.1' : '93.184.216.34', family: 4 }];
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.startsWith('https://redir.example')) return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } });
    return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR');
  };
  const a = await fetchSource({ type: 'ics', url: 'https://evil.example/cal.ics' }, { fetchImpl, lookup });
  assert.equal(a.ok, false);
  assert.match(a.error, /nội bộ/);
  const b = await fetchSource({ type: 'ics', url: 'https://redir.example/cal.ics' }, { fetchImpl, lookup });
  assert.equal(b.ok, false);
  assert.ok(!seen.some((u) => u.includes('169.254')), 'không gọi tới địa chỉ metadata');
  const c = await fetchSource({ type: 'ics', url: 'https://ok.example/cal.ics' }, { fetchImpl, lookup });
  assert.equal(c.ok, true);
  const huge = await fetchSource({ type: 'ics', url: 'https://ok.example/big.ics' },
    { fetchImpl: async () => new Response('x'.repeat(6 * 1024 * 1024)), lookup });
  assert.match(huge.error, /5 MB/);
  assert.equal((await call('POST', '/api/me/sources', { type: 'ics', url: 'https://user:pw@calendar.google.com/x.ics' }, { cookie: user })).status, 400);
});

test('CSV nhật ký: chữ bắt đầu bằng = + - @ không thành công thức Excel', () => {
  const csv = logToCsv([{ at: '2026-11-01T00:00:00Z', op: 'create', eventId: 'e1', title: '=HYPERLINK("http://evil","bấm")', start: '2026-11-01',
    source: { chatName: '@nhóm', senderName: '-1+1' }, recipients: [{ name: '+cmd', zaloUid: 'z', email: 'a@b.c' }], unlinked: [] }]);
  const line = csv.split('\n')[1];
  assert.match(line, /"'=HYPERLINK/);
  assert.match(line, /'@nhóm/);
  assert.match(line, /'-1\+1/);
  assert.match(line, /'\+cmd/);
});
