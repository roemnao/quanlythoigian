import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, errorOf, OWNER } from './helpers.js';

const t = await boot();
const { call, signIn, kv, members, google } = t;
const { settleDrains } = await import('../src/gsync.js');
const { TERMS_VERSION, commandsAfter } = members;
test.after(() => t.close());

let owner; let token; let alice; let bob; let aliceId; let bobId;
const me = async (cookie) => (await call('GET', '/api/me', null, { cookie })).data;
const cmds = async (id, seq = 0) => commandsAfter(id, seq);

test('đăng nhập Gmail: bắt buộc đồng ý điều khoản; OWNER_EMAILS thành Owner', async () => {
  const noTerms = await signIn({ sub: 'g-a', email: 'alice@gmail.com', name: 'Alice' }, { terms: null });
  assert.match(errorOf(noTerms.location), /Điều khoản/);
  assert.equal(noTerms.cookie, undefined);
  assert.equal((await signIn({ sub: 'g-a', email: 'alice@gmail.com', name: 'Alice' }, { terms: '2000-01-01' })).cookie, undefined);

  owner = (await signIn(OWNER)).cookie;
  assert.equal((await me(owner)).role, 'owner');
  token = (await call('POST', '/api/admin/agent-token', null, { cookie: owner })).data.token;
  assert.match(token, /^qltg_/);

  const a = await signIn({ sub: 'g-a', email: 'alice@gmail.com', name: 'Alice', picture: 'https://lh3.googleusercontent.com/a' });
  assert.equal(a.location, '/?google=member-new&calendar=on');
  alice = a.cookie;
  const info = await me(alice);
  assert.equal(info.email, 'alice@gmail.com');
  assert.equal(info.role, 'user');
  assert.deepEqual(info.perms, ['use']);
  assert.equal(info.needsTerms, false);
  assert.equal(info.zalo, null);
  assert.equal(info.google.status, 'connected');
  assert.ok(!JSON.stringify(info).includes('rt-'), 'không lộ token Google');
  aliceId = info.id;

  const again = await signIn({ sub: 'g-a', email: 'alice@gmail.com', name: 'Alice' }, { terms: null });
  assert.equal(again.location.startsWith('/?google=member'), true);
  assert.equal((await me(again.cookie)).id, aliceId);

  bob = (await signIn({ sub: 'g-b', email: 'bob@gmail.com', name: 'Bob' })).cookie;
  bobId = (await me(bob)).id;

  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', null, { cookie: `qltg_member=${aliceId}.gia` })).status, 401);
  // User thường không vào được quản trị.
  assert.equal((await call('GET', '/api/admin/members', null, { cookie: alice })).status, 403);
  assert.equal((await call('GET', '/api/admin/calbot-log', null, { cookie: alice })).status, 403);
});

test('mã liên kết Zalo: đúng người, dùng một lần, hết hạn, giới hạn số lần', async () => {
  assert.equal((await call('POST', '/api/agent/zalo-link', { code: '123456', zaloUid: 'z-a' })).status, 401);
  assert.equal((await call('POST', '/api/agent/zalo-link', { code: '123456', zaloUid: 'z-a' }, { token: 'qltg_sai' })).status, 401);

  const { code, expiresInMinutes } = (await call('POST', '/api/me/zalo-code', null, { cookie: alice })).data;
  assert.match(code, /^\d{6}$/);
  assert.equal(expiresInMinutes, 10);
  assert.equal((await call('POST', '/api/agent/zalo-link', { code: code === '000000' ? '111111' : '000000', zaloUid: 'z-a' }, { token })).status, 404);
  const ok = await call('POST', '/api/agent/zalo-link', { code, zaloUid: 'z-a', zaloName: 'Alice Zalo' }, { token });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.member.email, 'al…@gmail.com');
  assert.equal((await call('POST', '/api/agent/zalo-link', { code, zaloUid: 'z-x' }, { token })).status, 404, 'mã chỉ dùng một lần');
  assert.equal((await me(alice)).zalo.name, 'Alice Zalo');

  const b1 = (await call('POST', '/api/me/zalo-code', null, { cookie: bob })).data.code;
  await kv.expire(`zcode:${b1}`, 1);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await call('POST', '/api/agent/zalo-link', { code: b1, zaloUid: 'z-b' }, { token })).status, 404);
  const b2 = (await call('POST', '/api/me/zalo-code', null, { cookie: bob })).data.code;
  const b3 = (await call('POST', '/api/me/zalo-code', null, { cookie: bob })).data.code;
  if (b2 !== b3) assert.equal((await call('POST', '/api/agent/zalo-link', { code: b2, zaloUid: 'z-b' }, { token })).status, 404);
  assert.equal((await call('POST', '/api/agent/zalo-link', { code: b3, zaloUid: 'z-b', zaloName: 'Bob' }, { token })).status, 200);
  await call('POST', '/api/me/zalo-code', null, { cookie: bob });
  await call('POST', '/api/me/zalo-code', null, { cookie: bob });
  assert.equal((await call('POST', '/api/me/zalo-code', null, { cookie: bob })).status, 429);
});

let eventId; let chi; let chiId;

test('giao lịch: ghi vào Google Lịch của người đã liên kết, báo người chưa liên kết', async () => {
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
  assert.equal(r.data.appUrl, 'http://localhost:' + new URL(t.base).port + '/');

  const a = await cmds(aliceId);
  assert.equal(a.commands.length, 1);
  const [cmd] = a.commands;
  assert.equal(cmd.op, 'create');
  assert.deepEqual({ ...cmd.event, timeZone: undefined }, {
    id: eventId, title: 'Họp nhóm', start: '2026-10-30T02:00:00.000Z', end: '2026-10-30T03:00:00.000Z', allDay: false,
    note: 'Phòng 301', timeZone: undefined, from: { chat: 'Nhóm dự án', sender: 'Sếp' },
  });
  await settleDrains();
  // Máy chủ đã ghi vào Google Lịch của Alice, không cần mở web.
  const gid = `qltgm${eventId}`;
  assert.ok(google.cal('alice@gmail.com').has(gid), 'có trong Google Lịch của Alice');
  assert.ok(google.cal('bob@gmail.com').has(gid));
  assert.equal(google.cal('alice@gmail.com').get(gid).summary, 'Họp nhóm');
  assert.equal((await call('GET', '/api/me/history', null, { cookie: alice })).data.history[0].title, 'Họp nhóm');

  assert.equal((await call('POST', '/api/agent/assign', { title: 'X', start: 'mai', assignees: [{ zaloUid: 'z-a' }] }, { token })).status, 400);
  assert.equal((await call('POST', '/api/agent/assign', { title: 'X', start: '2026-10-30T09:00:00Z', assignees: [] }, { token })).status, 400);
  const allDay = await call('POST', '/api/agent/assign', { title: 'Nghỉ lễ', allDay: true, start: '2026-11-02', assignees: [{ zaloUid: 'z-b' }] }, { token });
  const bobCmds = (await cmds(bobId)).commands;
  assert.deepEqual(bobCmds.map((c) => c.event.title), ['Họp nhóm', 'Nghỉ lễ']);
  assert.equal(bobCmds[1].event.start, '2026-11-02');
  assert.equal(allDay.data.eventId, bobCmds[1].event.id);
  await settleDrains();
});

test('sửa lịch: người còn lại nhận lệnh sửa, người bị bỏ bị xoá khỏi Google Lịch, người mới nhận lệnh thêm', async () => {
  const gid = `qltgm${eventId}`;
  // Chi đăng nhập nhưng KHÔNG cho phép Google Lịch: lệnh nằm chờ.
  chi = (await signIn({ sub: 'g-c', email: 'chi@gmail.com', name: 'Chi' }, { code: 'noscope' })).cookie;
  chiId = (await me(chi)).id;
  assert.equal((await me(chi)).google.status, 'no-scope');
  const code = (await call('POST', '/api/me/zalo-code', null, { cookie: chi })).data.code;
  await call('POST', '/api/agent/zalo-link', { code, zaloUid: 'z-c' }, { token });

  const r = await call('PATCH', `/api/agent/assign/${eventId}`, { start: '2026-10-30T10:00:00+07:00', end: null, remove: [{ zaloUid: 'z-b' }] }, { token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.assigned.map((a) => `${a.zaloUid}:${a.op}`).sort(), ['z-a:update', 'z-b:delete', 'z-c:create']);
  await settleDrains();
  assert.equal(google.cal('alice@gmail.com').get(gid).start.dateTime, '2026-10-30T03:00:00.000Z');
  assert.ok(!google.cal('bob@gmail.com').has(gid), 'Bob bị bỏ nhận: đã xoá khỏi Google Lịch');
  assert.equal(google.cal('chi@gmail.com').size, 0, 'Chi chưa cho phép Google Lịch: chưa ghi');
  assert.deepEqual((await cmds(chiId)).commands.map((x) => [x.op, x.event.title]), [['create', 'Họp nhóm']]);

  const st = await call('GET', `/api/agent/assign/${eventId}`, null, { token });
  assert.equal(st.data.assignees.find((x) => x.zaloUid === 'z-c').fetchedAt, null);
  assert.ok(st.data.assignees.find((x) => x.zaloUid === 'z-a').fetchedAt, 'Alice đã được ghi vào Google Lịch');
});

test('huỷ lịch: xoá khỏi Google Lịch của mọi người đã nhận; sửa lịch đã huỷ báo 404', async () => {
  const gid = `qltgm${eventId}`;
  assert.ok(google.cal('alice@gmail.com').has(gid));
  assert.equal((await call('DELETE', `/api/agent/assign/${eventId}`, null, { token })).status, 200);
  await settleDrains();
  assert.ok(!google.cal('alice@gmail.com').has(gid));
  assert.equal((await call('PATCH', `/api/agent/assign/${eventId}`, { title: 'x' }, { token })).status, 404);
  assert.equal((await call('DELETE', `/api/agent/assign/${eventId}`, null, { token })).status, 404);
});

test('một chiều: không có API đọc người khác hay ghi ngược', async () => {
  for (const [method, url] of [['POST', '/api/me/commands'], ['GET', '/api/me/commands'], ['PATCH', '/api/me'], ['POST', '/api/me'],
    ['GET', '/api/me/search?q=a'], ['GET', '/api/me/members'], ['PUT', '/api/me/calendar']]) {
    const r = await call(method, url, { op: 'create', event: { title: 'ngược' } }, { cookie: alice });
    assert.ok([404, 405].includes(r.status), `${method} ${url} → ${r.status}`);
  }
  assert.equal((await call('GET', '/api/me/history', null, { token })).status, 401);
});

test('log bot lịch: đủ thông tin, có giờ ghi vào Google Lịch, xuất CSV; chỉ Owner/Technician xem được', async () => {
  assert.equal((await call('GET', '/api/admin/calbot-log')).status, 401);
  const { entries } = (await call('GET', '/api/admin/calbot-log', null, { cookie: owner })).data;
  const create = entries.find((e) => e.op === 'create' && e.title === 'Họp nhóm');
  assert.equal(create.source.chatName, 'Nhóm dự án');
  assert.deepEqual(create.recipients.map((r) => r.email), ['alice@gmail.com', 'bob@gmail.com']);
  assert.ok(create.recipients.every((r) => r.fetchedAt), 'đã ghi vào Google Lịch');
  assert.deepEqual(create.unlinked, [{ zaloUid: 'z-c', name: 'Chi' }]);
  const onlyChi = (await call('GET', '/api/admin/calbot-log?member=chi@gmail.com', null, { cookie: owner })).data.entries;
  assert.ok(onlyChi.length >= 1 && onlyChi.every((e) => e.recipients.some((r) => r.email === 'chi@gmail.com')));
  const csv = await call('GET', '/api/admin/calbot-log/csv', null, { cookie: owner });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /thoi_gian,lenh,ma_lich/);
});

test('quản trị tài khoản người dùng và xoá tài khoản', async () => {
  const list = (await call('GET', '/api/admin/members', null, { cookie: owner })).data;
  assert.deepEqual(list.members.map((m) => m.email).sort(), ['alice@gmail.com', 'bob@gmail.com', 'chi@gmail.com', 'owner@gmail.com']);
  assert.equal(list.canWrite, true);
  const al = list.members.find((m) => m.email === 'alice@gmail.com');
  assert.equal(al.zalo.uid, 'z-a');
  assert.equal(al.google.status, 'connected');

  await call('PUT', '/api/admin/bot-settings', { allowedEmails: '@congty.vn, khach@gmail.com', botChatUrl: 'https://zalo.me/0900000000', botName: 'roemnao' }, { cookie: owner });
  assert.match(errorOf((await signIn({ sub: 'g-x', email: 'la@gmail.com' })).location), /chưa được chủ hệ thống/);
  assert.ok((await signIn({ sub: 'g-k', email: 'khach@gmail.com' })).cookie);
  assert.ok((await signIn(OWNER)).cookie, 'email trong OWNER_EMAILS luôn được vào');
  assert.equal((await call('PUT', '/api/admin/bot-settings', { botChatUrl: 'http://evil.example' }, { cookie: owner })).status, 400);
  assert.equal((await me(alice)).bot.chatUrl, 'https://zalo.me/0900000000');

  // Bob tự xoá tài khoản: hết phiên, bị thu hồi quyền Google, giao lịch cho Zalo của Bob thì báo chưa liên kết.
  const before = google.revoked.length;
  assert.equal((await call('DELETE', '/api/me', null, { cookie: bob })).status, 200);
  assert.ok(google.revoked.length > before, 'đã thu hồi quyền Google Lịch của Bob');
  assert.equal(await kv.get(`gtoken:${bobId}`), null);
  assert.equal(await kv.get(`udata:${bobId}`), null);
  assert.equal((await call('GET', '/api/me', null, { cookie: bob })).status, 401);
  const r = await call('POST', '/api/agent/assign', { title: 'Sau khi xoá', start: '2026-11-01T09:00:00Z', assignees: [{ zaloUid: 'z-b' }] }, { token });
  assert.deepEqual(r.data.unlinked.map((x) => x.zaloUid), ['z-b']);

  await call('DELETE', `/api/admin/members/${aliceId}/zalo`, null, { cookie: owner });
  assert.equal((await me(alice)).zalo, null);
  await call('DELETE', `/api/admin/members/${chiId}`, null, { cookie: owner });
  assert.ok(!(await call('GET', '/api/admin/members', null, { cookie: owner })).data.members.some((m) => m.email === 'chi@gmail.com'));
});

test('điều khoản đổi phiên bản: phải đồng ý lại mới dùng và mới được ghi lịch', async () => {
  const code = (await call('POST', '/api/me/zalo-code', null, { cookie: alice })).data.code;
  await call('POST', '/api/agent/zalo-link', { code, zaloUid: 'z-a' }, { token });
  const u = await kv.get(`user:${aliceId}`);
  await kv.set(`user:${aliceId}`, { ...u, termsVersion: '2000-01-01' });
  const calls = google.cal('alice@gmail.com').size;
  await call('POST', '/api/agent/assign', { title: 'Mới', start: '2026-11-03T09:00:00Z', assignees: [{ zaloUid: 'z-a' }] }, { token });
  await settleDrains();
  assert.equal(google.cal('alice@gmail.com').size, calls, 'chưa đồng ý điều khoản mới: chưa ghi');
  const r = await call('GET', '/api/me/state', null, { cookie: alice });
  assert.equal(r.status, 403);
  assert.equal(r.data.needsTerms, true);
  assert.equal((await me(alice)).needsTerms, true);
  assert.equal((await call('POST', '/api/me/terms', { version: '2000-01-01' }, { cookie: alice })).status, 400);
  assert.equal((await call('POST', '/api/me/terms', { version: TERMS_VERSION }, { cookie: alice })).status, 200);
  const { drainMember } = await import('../src/gsync.js');
  await drainMember(aliceId);
  assert.equal(google.cal('alice@gmail.com').size, calls + 1, 'đồng ý xong thì lịch chờ được ghi');
});
