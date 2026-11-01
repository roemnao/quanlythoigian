import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, OWNER } from './helpers.js';

const t = await boot();
const { call, signIn, kv, google } = t;
test.after(() => t.close());

let a; let b; let aId; let bId; let token; let owner;
const state = async (cookie) => (await call('GET', '/api/me/state', null, { cookie })).data;

test('thiết lập hai người dùng và khoá agent', async () => {
  owner = (await signIn(OWNER)).cookie;
  token = (await call('POST', '/api/admin/agent-token', null, { cookie: owner })).data.token;
  a = (await signIn({ sub: 'g-a', email: 'a@gmail.com', name: 'A' }, { code: 'noscope' })).cookie;
  b = (await signIn({ sub: 'g-b', email: 'b@gmail.com', name: 'B' }, { code: 'noscope' })).cookie;
  aId = (await call('GET', '/api/me', null, { cookie: a })).data.id;
  bId = (await call('GET', '/api/me', null, { cookie: b })).data.id;
  assert.equal((await call('GET', '/api/me/state')).status, 401);
});

test('mỗi người một dữ liệu: lịch, việc, đề xuất, mục tiêu, Pomodoro không lẫn sang người khác', async () => {
  const ev = (await call('POST', '/api/me/events', { title: 'Việc của A', start: '2026-11-05T02:00:00Z' }, { cookie: a })).data;
  const task = (await call('POST', '/api/me/tasks', { title: 'Việc riêng A', quadrant: 1 }, { cookie: a })).data;
  await call('PUT', '/api/me/goals/2026-11-05', { goals: ['mục tiêu A'] }, { cookie: a });
  await call('POST', '/api/me/pomodoros', { minutes: 25 }, { cookie: a });
  const sa = await state(a); const sb = await state(b);
  assert.deepEqual(sa.events.map((e) => e.title), ['Việc của A']);
  assert.equal(sa.pomodoros.length, 1);
  assert.deepEqual([sb.events, sb.tasks, sb.pomodoros, sb.suggestions, sb.sources], [[], [], [], [], []]);
  assert.deepEqual(sb.goals, {});
  // B không sửa / xoá được id của A: 404 (không lộ id có tồn tại).
  assert.equal((await call('PATCH', `/api/me/events/${ev.id}`, { title: 'hack' }, { cookie: b })).status, 404);
  assert.equal((await call('PATCH', `/api/me/tasks/${task.id}`, { title: 'hack' }, { cookie: b })).status, 404);
  await call('DELETE', `/api/me/events/${ev.id}`, null, { cookie: b });
  await call('DELETE', `/api/me/tasks/${task.id}`, null, { cookie: b });
  assert.equal((await state(a)).events.length, 1, 'xoá nhầm id của người khác không có tác dụng');
  assert.equal((await state(a)).tasks.length, 1);
  // Sự kiện và việc sửa được của chính mình.
  assert.equal((await call('PATCH', `/api/me/tasks/${task.id}`, { done: true }, { cookie: a })).data.done, true);
});

test('khoá API và dữ liệu hệ thống không nằm trong dữ liệu người dùng', async () => {
  const raw = JSON.stringify(await kv.get(`udata:${aId}`));
  assert.ok(!raw.includes('agentTokenHash') && !raw.includes('geminiApiKey'));
  assert.equal(Object.keys(await state(a)).includes('settings'), false);
});

test('nguồn tự động: giới hạn số lượng, chặn địa chỉ nội bộ', async () => {
  for (const url of ['http://localhost/x.ics', 'http://127.0.0.1/x.ics', 'http://169.254.169.254/latest', 'https://192.168.1.5/a.ics', 'http://10.0.0.2/a', 'http://[::1]/a', 'ftp://example.com/a.ics']) {
    assert.equal((await call('POST', '/api/me/sources', { type: 'ics', url }, { cookie: a })).status, 400, url);
  }
  // Giả lập nguồn đã tồn tại để kiểm giới hạn mà không cần tải thật.
  const { UserStore } = await import('../src/userstore.js');
  const s = await UserStore.open(bId);
  for (let i = 0; i < 5; i++) s.data.sources.push({ id: `s${i}`, type: 'ics', name: `n${i}`, url: `https://example.com/${i}.ics` });
  await s.save();
  const r = await call('POST', '/api/me/sources', { type: 'ics', url: 'https://example.com/6.ics' }, { cookie: b });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /Tối đa 5 nguồn/);
  const s2 = await UserStore.open(aId);
  s2.data.sources.push({ id: 'w1', type: 'web', name: 'w', url: 'https://example.com/w1' }, { id: 'w2', type: 'web', name: 'w', url: 'https://example.com/w2' });
  await s2.save();
  assert.equal((await call('POST', '/api/me/sources', { type: 'web', url: 'https://example.com/w3' }, { cookie: a })).status, 429);
  assert.ok(!JSON.stringify(await state(a)).includes('lastHash'));
});

test('AI trích lịch: giới hạn mỗi ngày và cần Gemini', async () => {
  assert.equal((await call('POST', '/api/me/extract', { text: '' }, { cookie: a })).status, 400);
  const r = await call('POST', '/api/me/extract', { text: 'mai họp 9h' }, { cookie: a });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Gemini/);
});

test('API của bot Zalo cho lịch / việc riêng: theo ID Zalo của người nhắn', async () => {
  assert.equal((await call('POST', '/api/agent/events', { title: 'x', start: '2026-11-05T02:00:00Z' }, { token })).status, 400, 'thiếu zaloUid');
  const unlinked = await call('POST', '/api/agent/events', { zaloUid: 'z-lạ', title: 'x', start: '2026-11-05T02:00:00Z' }, { token });
  assert.equal(unlinked.status, 404);
  assert.equal(unlinked.data.unlinked, true);
  assert.match(unlinked.data.appUrl, /^http/);

  const code = (await call('POST', '/api/me/zalo-code', null, { cookie: b })).data.code;
  await call('POST', '/api/agent/zalo-link', { code, zaloUid: 'z-b' }, { token });
  const ev = await call('POST', '/api/agent/events', { zaloUid: 'z-b', title: 'Lịch qua Zalo', start: '2026-11-05T02:00:00Z' }, { token });
  assert.equal(ev.status, 200);
  assert.deepEqual((await state(b)).events.map((e) => e.title), ['Lịch qua Zalo']);
  assert.ok(!(await state(a)).events.some((e) => e.title === 'Lịch qua Zalo'));
  const task = await call('POST', '/api/agent/tasks', { zaloUid: 'z-b', title: 'Gọi mẹ', quadrant: 1 }, { token });
  assert.equal((await call('GET', '/api/agent/tasks?zaloUid=z-b', null, { token })).data[0].title, 'Gọi mẹ');
  assert.deepEqual((await call('GET', '/api/agent/tasks?zaloUid=z-lạ', null, { token })).status, 404);
  assert.equal((await call('PATCH', `/api/agent/tasks/${task.data.id}`, { zaloUid: 'z-b', done: true }, { token })).data.done, true);
  assert.equal((await call('GET', '/api/agent/agenda?zaloUid=z-b&date=2026-11-05', null, { token })).data.events[0].title, 'Lịch qua Zalo');
  assert.equal((await call('GET', '/api/agent/agenda?date=today', null, { token })).status, 400);
});

test('các API đã bỏ trả 410 để bản PyloS cũ biết cập nhật', async () => {
  for (const [m, p] of [['GET', '/api/agent/config'], ['POST', '/api/agent/heartbeat'], ['POST', '/api/agent/sessions'], ['POST', '/api/agent/device-login'], ['GET', `/api/agent/device-login/${'a'.repeat(32)}`]]) {
    const r = await call(m, p, {}, { token });
    assert.equal(r.status, 410, p);
    assert.match(r.data.error, /PyloS đã tách/);
  }
});

test('đăng nhập mật khẩu quản trị cũ không còn', async () => {
  for (const [m, p] of [['POST', '/api/login'], ['POST', '/api/setup'], ['GET', '/api/auth/status'], ['POST', '/api/account/password'], ['GET', '/api/state']]) {
    assert.equal((await call(m, p, { username: 'x', password: 'y' })).status, 404, p);
  }
});

test('link .ics chỉ có khoá đúng mới đọc được', async () => {
  const { calendarUrl } = (await call('GET', '/api/me', null, { cookie: owner })).data;
  assert.ok(calendarUrl);
  assert.equal((await call('GET', '/api/me', null, { cookie: a })).data.calendarUrl, undefined);
  assert.equal((await call('GET', '/calendar.ics?key=sai')).status, 401);
  const ok = await call('GET', new URL(calendarUrl).pathname + new URL(calendarUrl).search);
  assert.equal(ok.status, 200);
  assert.match(ok.data, /BEGIN:VCALENDAR/);
});
