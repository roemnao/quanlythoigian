import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qltg-m-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
delete process.env.APP_PASSWORD;
process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'secret-xyz';

const { default: app } = await import('../src/app.js');
const { kv } = await import('../src/kv.js');
const { TERMS_VERSION } = await import('../src/members.js');

// Google giả: trả id_token của người đang "đăng nhập".
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
  return { status: res.status, location: res.headers.get('location'), cookies, data, headers: res.headers };
}

// Đăng nhập Gmail từ web app: /start (có hoặc không tick đồng ý điều khoản) → Google → /callback.
async function memberSignIn(user, { terms = TERMS_VERSION } = {}) {
  googleUser = user;
  const start = await call('GET', `/api/google/start?purpose=member${terms ? `&terms=${terms}` : ''}`);
  assert.equal(start.status, 302);
  const to = new URL(start.location);
  assert.equal(to.searchParams.get('scope'), 'openid email profile');
  const cb = await call('GET', `/api/google/callback?code=c&state=${to.searchParams.get('state')}`, null, { cookie: start.cookies.join('; ') });
  return { location: cb.location, cookie: cb.cookies.find((c) => c.startsWith('qltg_member=')) };
}

let admin; let token; let alice; let bob;

test('tạo tài khoản bằng Gmail: bắt buộc đồng ý điều khoản', async () => {
  const r = await call('POST', '/api/setup', { username: 'chuweb', password: 'matkhau' });
  admin = r.cookies[0];
  token = (await call('POST', '/api/settings/agent-token', null, { cookie: admin })).data.token;

  const noTerms = await memberSignIn({ sub: 'g-a', email: 'alice@gmail.com', name: 'Alice' }, { terms: null });
  assert.match(noTerms.location, /^\/app\/\?google_error=/);
  assert.equal(noTerms.cookie, undefined);
  const oldTerms = await memberSignIn({ sub: 'g-a', email: 'alice@gmail.com', name: 'Alice' }, { terms: '2000-01-01' });
  assert.equal(oldTerms.cookie, undefined);

  const a = await memberSignIn({ sub: 'g-a', email: 'alice@gmail.com', name: 'Alice', picture: 'https://lh3.googleusercontent.com/a' });
  assert.equal(a.location, '/app/?google=member-new');
  alice = a.cookie;
  const me = await call('GET', '/api/me', null, { cookie: alice });
  assert.equal(me.status, 200);
  assert.equal(me.data.email, 'alice@gmail.com');
  assert.equal(me.data.needsTerms, false);
  assert.equal(me.data.zalo, null);
  assert.equal(me.data.googleClientId, process.env.GOOGLE_CLIENT_ID);

  // Đăng nhập lại không cần tick lần nữa, vẫn là tài khoản cũ.
  const again = await memberSignIn({ sub: 'g-a', email: 'alice@gmail.com', name: 'Alice' }, { terms: null });
  assert.equal(again.location, '/app/?google=member');
  assert.equal((await call('GET', '/api/me', null, { cookie: again.cookie })).data.id, me.data.id);

  bob = (await memberSignIn({ sub: 'g-b', email: 'bob@gmail.com', name: 'Bob' })).cookie;
  assert.ok(bob);

  // Chưa đăng nhập / cookie giả.
  const anon = await call('GET', '/api/me');
  assert.equal(anon.status, 401);
  assert.equal(anon.data.signIn, true);
  assert.equal((await call('GET', '/api/me', null, { cookie: `qltg_member=${me.data.id}.gia` })).status, 401);
  // Phiên thành viên không mở được trang quản trị.
  assert.equal((await call('GET', '/api/state', null, { cookie: alice })).status, 401);
  assert.equal((await call('GET', '/api/admin/members', null, { cookie: alice })).status, 401);
});

test('mã liên kết Zalo: đúng người, dùng một lần, hết hạn, giới hạn số lần', async () => {
  assert.equal((await call('POST', '/api/agent/zalo-link', { code: '123456', zaloUid: 'z-a' })).status, 401);
  assert.equal((await call('POST', '/api/agent/zalo-link', { code: '123456', zaloUid: 'z-a' }, { token: 'qltg_sai' })).status, 401);

  const { code, expiresInMinutes } = (await call('POST', '/api/me/zalo-code', null, { cookie: alice })).data;
  assert.match(code, /^\d{6}$/);
  assert.equal(expiresInMinutes, 10);
  const wrong = await call('POST', '/api/agent/zalo-link', { code: code === '000000' ? '111111' : '000000', zaloUid: 'z-a' }, { token });
  assert.equal(wrong.status, 404);
  const ok = await call('POST', '/api/agent/zalo-link', { code, zaloUid: 'z-a', zaloName: 'Alice Zalo' }, { token });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.member.name, 'Alice');
  assert.equal(ok.data.member.email, 'al…@gmail.com');
  assert.equal((await call('POST', '/api/agent/zalo-link', { code, zaloUid: 'z-x' }, { token })).status, 404, 'mã chỉ dùng một lần');
  assert.equal((await call('GET', '/api/me', null, { cookie: alice })).data.zalo.name, 'Alice Zalo');

  // Mã hết hạn.
  const b1 = (await call('POST', '/api/me/zalo-code', null, { cookie: bob })).data.code;
  await kv.expire(`zcode:${b1}`, 1);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await call('POST', '/api/agent/zalo-link', { code: b1, zaloUid: 'z-b' }, { token })).status, 404);
  // Lấy mã mới thì mã cũ hết hiệu lực.
  const b2 = (await call('POST', '/api/me/zalo-code', null, { cookie: bob })).data.code;
  const b3 = (await call('POST', '/api/me/zalo-code', null, { cookie: bob })).data.code;
  if (b2 !== b3) assert.equal((await call('POST', '/api/agent/zalo-link', { code: b2, zaloUid: 'z-b' }, { token })).status, 404);
  assert.equal((await call('POST', '/api/agent/zalo-link', { code: b3, zaloUid: 'z-b', zaloName: 'Bob' }, { token })).status, 200);
  // Tối đa 5 mã mỗi giờ (Bob đã lấy 3).
  await call('POST', '/api/me/zalo-code', null, { cookie: bob });
  await call('POST', '/api/me/zalo-code', null, { cookie: bob });
  assert.equal((await call('POST', '/api/me/zalo-code', null, { cookie: bob })).status, 429);
});

let eventId;
const after = async (cookie, seq = 0) => (await call('GET', `/api/me/commands?after=${seq}`, null, { cookie })).data;

test('giao lịch: lệnh thêm cho người đã liên kết, báo người chưa liên kết', async () => {
  const r = await call('POST', '/api/agent/assign', {
    title: 'Họp nhóm', start: '2026-10-30T09:00:00+07:00', end: '2026-10-30T10:00:00+07:00', note: 'Phòng 301',
    assignees: [{ zaloUid: 'z-a', name: 'Alice' }, { zaloUid: 'z-b', name: 'Bob' }, { zaloUid: 'z-c', name: 'Chi' }, { zaloUid: 'z-a' }],
    source: { chatId: 'g1', chatName: 'Nhóm dự án', senderId: 'z-boss', senderName: 'Sếp', messageId: 'm1' },
  }, { token });
  assert.equal(r.status, 200);
  eventId = r.data.eventId;
  assert.match(eventId, /^[0-9a-f]{12}$/);
  assert.deepEqual(r.data.assigned.map((a) => a.zaloUid), ['z-a', 'z-b']);
  assert.deepEqual(r.data.unlinked, [{ zaloUid: 'z-c', name: 'Chi' }]);
  assert.match(r.data.appUrl, /\/app\/$/);

  const a = await after(alice);
  assert.equal(a.commands.length, 1);
  const [cmd] = a.commands;
  assert.equal(cmd.op, 'create');
  assert.equal(cmd.seq, a.latest);
  assert.deepEqual({ ...cmd.event, timeZone: undefined }, {
    id: eventId, title: 'Họp nhóm', start: '2026-10-30T02:00:00.000Z', end: '2026-10-30T03:00:00.000Z', allDay: false,
    note: 'Phòng 301', timeZone: undefined, from: { chat: 'Nhóm dự án', sender: 'Sếp' },
  });
  // Hỏi lại từ seq mới nhất: không có gì.
  assert.deepEqual((await after(alice, a.latest)).commands, []);

  // Lỗi đầu vào.
  assert.equal((await call('POST', '/api/agent/assign', { title: 'X', start: 'mai', assignees: [{ zaloUid: 'z-a' }] }, { token })).status, 400);
  assert.equal((await call('POST', '/api/agent/assign', { title: 'X', start: '2026-10-30T09:00:00Z', assignees: [] }, { token })).status, 400);
  // Lịch cả ngày lưu theo ngày.
  const allDay = await call('POST', '/api/agent/assign', { title: 'Nghỉ lễ', allDay: true, start: '2026-11-02', assignees: [{ zaloUid: 'z-b' }] }, { token });
  const bobCmds = (await after(bob)).commands;
  assert.deepEqual(bobCmds.map((c) => c.event.title), ['Họp nhóm', 'Nghỉ lễ']);
  assert.equal(bobCmds[1].event.start, '2026-11-02');
  assert.equal(allDay.data.eventId, bobCmds[1].event.id);
});

test('sửa lịch: người còn lại nhận lệnh sửa, người bị bỏ nhận lệnh xoá, người mới nhận lệnh thêm', async () => {
  const seqA = (await after(alice)).latest;
  const seqB = (await after(bob)).latest;
  // Chi liên kết sau khi lịch đã giao.
  const chi = (await memberSignIn({ sub: 'g-c', email: 'chi@gmail.com', name: 'Chi' })).cookie;
  const code = (await call('POST', '/api/me/zalo-code', null, { cookie: chi })).data.code;
  await call('POST', '/api/agent/zalo-link', { code, zaloUid: 'z-c' }, { token });

  const r = await call('PATCH', `/api/agent/assign/${eventId}`, { start: '2026-10-30T10:00:00+07:00', end: null, remove: [{ zaloUid: 'z-b' }] }, { token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.assigned.map((a) => `${a.zaloUid}:${a.op}`).sort(), ['z-a:update', 'z-b:delete', 'z-c:create']);
  const a = (await after(alice, seqA)).commands;
  assert.deepEqual(a.map((c) => c.op), ['update']);
  assert.equal(a[0].event.start, '2026-10-30T03:00:00.000Z');
  assert.equal(a[0].event.end, null);
  assert.deepEqual((await after(bob, seqB)).commands.map((c) => [c.op, c.event.id]), [['delete', eventId]]);
  const c = (await after(chi)).commands;
  assert.deepEqual(c.map((x) => [x.op, x.event.title]), [['create', 'Họp nhóm']]);

  // Thêm lại Bob.
  const r2 = await call('PATCH', `/api/agent/assign/${eventId}`, { add: [{ zaloUid: 'z-b', name: 'Bob' }] }, { token });
  assert.deepEqual(r2.data.assigned.map((x) => `${x.zaloUid}:${x.op}`), ['z-b:create']);

  const st = await call('GET', `/api/agent/assign/${eventId}`, null, { token });
  assert.deepEqual(st.data.assignees.map((x) => [x.zaloUid, x.linked]), [['z-a', true], ['z-c', true], ['z-b', true]]);
  assert.equal(st.data.assignees.find((x) => x.zaloUid === 'z-c').fetchedAt, null);
  await after(chi);
  assert.equal((await call('GET', `/api/agent/assign/${eventId}`, null, { token })).data.assignees.find((x) => x.zaloUid === 'z-b').fetchedAt, null);
});

test('huỷ lịch: lệnh xoá cho mọi người đã nhận; sửa lịch đã huỷ báo 404', async () => {
  const before = { a: (await after(alice)).latest, b: (await after(bob)).latest };
  const r = await call('DELETE', `/api/agent/assign/${eventId}`, null, { token });
  assert.equal(r.status, 200);
  assert.deepEqual((await after(alice, before.a)).commands.map((c) => c.op), ['delete']);
  assert.deepEqual((await after(bob, before.b)).commands.map((c) => c.op), ['delete']);
  assert.equal((await call('PATCH', `/api/agent/assign/${eventId}`, { title: 'x' }, { token })).status, 404);
  assert.equal((await call('DELETE', `/api/agent/assign/${eventId}`, null, { token })).status, 404);
});

test('một chiều: không đọc được của người khác, không có API ghi ngược', async () => {
  const aliceCmds = (await after(alice)).commands;
  const bobCmds = (await after(bob)).commands;
  assert.ok(aliceCmds.length && bobCmds.length);
  // Hàng lệnh của mỗi người là riêng: tham số lạ không đổi được người.
  const tryOther = await call('GET', `/api/me/commands?after=0&user=${(await call('GET', '/api/me', null, { cookie: bob })).data.id}`, null, { cookie: alice });
  assert.deepEqual(tryOther.data.commands.map((c) => c.seq), aliceCmds.map((c) => c.seq));
  for (const [method, url] of [['POST', '/api/me/commands'], ['PUT', '/api/me/commands'], ['PATCH', '/api/me'], ['POST', '/api/me'],
    ['POST', '/api/me/events'], ['GET', '/api/me/search?q=a'], ['GET', '/api/me/members'], ['PUT', '/api/me/calendar']]) {
    const r = await call(method, url, { op: 'create', event: { title: 'ngược' } }, { cookie: alice });
    assert.ok([404, 405].includes(r.status), `${method} ${url} → ${r.status}`);
  }
  // Agent không đọc được hàng lệnh qua API của app.
  assert.equal((await call('GET', '/api/me/commands', null, { token })).status, 401);
});

test('log bot lịch: đủ thông tin, có giờ app lấy lệnh, xuất CSV; chỉ quản trị xem được', async () => {
  assert.equal((await call('GET', '/api/admin/calbot-log')).status, 401);
  const { entries } = (await call('GET', '/api/admin/calbot-log', null, { cookie: admin })).data;
  const create = entries.find((e) => e.op === 'create' && e.title === 'Họp nhóm');
  assert.equal(create.source.chatName, 'Nhóm dự án');
  assert.equal(create.source.senderName, 'Sếp');
  assert.deepEqual(create.recipients.map((r) => r.email), ['alice@gmail.com', 'bob@gmail.com']);
  assert.ok(create.recipients.every((r) => r.fetchedAt), 'đã ghi lúc app lấy lệnh');
  assert.deepEqual(create.unlinked, [{ zaloUid: 'z-c', name: 'Chi' }]);
  assert.deepEqual(entries.map((e) => e.op).slice(0, 4), ['delete', 'update', 'update', 'create']);

  const onlyChi = (await call('GET', '/api/admin/calbot-log?member=chi@gmail.com', null, { cookie: admin })).data.entries;
  assert.ok(onlyChi.length >= 2 && onlyChi.every((e) => e.recipients.some((r) => r.email === 'chi@gmail.com')));

  const csv = await call('GET', '/api/admin/calbot-log/csv', null, { cookie: admin });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /thoi_gian,lenh,ma_lich/);
  assert.match(csv.data, /Họp nhóm.*Chi,z-c,,chưa liên kết/);
});

test('quản trị thành viên và xoá tài khoản', async () => {
  const list = (await call('GET', '/api/admin/members', null, { cookie: admin })).data;
  assert.deepEqual(list.members.map((m) => m.email), ['alice@gmail.com', 'bob@gmail.com', 'chi@gmail.com']);
  assert.equal(list.members[0].zalo.uid, 'z-a');
  assert.ok(list.members[0].lastSeenAt);

  // Chỉ cho phép một số email tạo tài khoản.
  await call('PUT', '/api/admin/members/settings', { allowedEmails: '@congty.vn, khach@gmail.com', botChatUrl: 'https://zalo.me/0900000000', botName: 'roemnao' }, { cookie: admin });
  assert.match((await memberSignIn({ sub: 'g-x', email: 'la@gmail.com' })).location, /google_error=/);
  assert.ok((await memberSignIn({ sub: 'g-k', email: 'khach@gmail.com' })).cookie);
  assert.equal((await call('PUT', '/api/admin/members/settings', { botChatUrl: 'http://evil.example' }, { cookie: admin })).status, 400);
  assert.equal((await call('GET', '/api/me', null, { cookie: alice })).data.bot.chatUrl, 'https://zalo.me/0900000000');

  // Bob tự xoá tài khoản: hết phiên, hết hàng lệnh, giao lịch cho Zalo của Bob thì báo chưa liên kết.
  assert.equal((await call('DELETE', '/api/me', null, { cookie: bob })).status, 200);
  assert.equal((await call('GET', '/api/me', null, { cookie: bob })).status, 401);
  assert.equal((await call('GET', '/api/me/commands?after=0', null, { cookie: bob })).status, 401);
  const r = await call('POST', '/api/agent/assign', { title: 'Sau khi xoá', start: '2026-11-01T09:00:00Z', assignees: [{ zaloUid: 'z-b' }] }, { token });
  assert.deepEqual(r.data.unlinked.map((x) => x.zaloUid), ['z-b']);

  // Quản trị gỡ Zalo của Alice rồi xoá Chi.
  const ids = Object.fromEntries((await call('GET', '/api/admin/members', null, { cookie: admin })).data.members.map((m) => [m.email, m.id]));
  await call('DELETE', `/api/admin/members/${ids['alice@gmail.com']}/zalo`, null, { cookie: admin });
  assert.equal((await call('GET', '/api/me', null, { cookie: alice })).data.zalo, null);
  await call('DELETE', `/api/admin/members/${ids['chi@gmail.com']}`, null, { cookie: admin });
  assert.ok(!(await call('GET', '/api/admin/members', null, { cookie: admin })).data.members.some((m) => m.email === 'chi@gmail.com'));
});

test('điều khoản đổi phiên bản: phải đồng ý lại mới nhận lệnh', async () => {
  const me = (await call('GET', '/api/me', null, { cookie: alice })).data;
  const code = (await call('POST', '/api/me/zalo-code', null, { cookie: alice })).data.code;
  await call('POST', '/api/agent/zalo-link', { code, zaloUid: 'z-a' }, { token });
  const latest = (await after(alice)).latest;
  const u = await kv.get(`user:${me.id}`);
  await kv.set(`user:${me.id}`, { ...u, termsVersion: '2000-01-01' });
  await call('POST', '/api/agent/assign', { title: 'Mới', start: '2026-11-03T09:00:00Z', assignees: [{ zaloUid: 'z-a' }] }, { token });
  const r = await call('GET', `/api/me/commands?after=${latest}`, null, { cookie: alice });
  assert.equal(r.status, 403);
  assert.equal(r.data.needsTerms, true);
  assert.equal((await call('GET', '/api/me', null, { cookie: alice })).data.needsTerms, true);
  assert.equal((await call('POST', '/api/me/terms', { version: '2000-01-01' }, { cookie: alice })).status, 400);
  assert.equal((await call('POST', '/api/me/terms', { version: TERMS_VERSION }, { cookie: alice })).status, 200);
  assert.deepEqual((await call('GET', `/api/me/commands?after=${latest}`, null, { cookie: alice })).data.commands.map((c) => c.event.title), ['Mới']);
});
