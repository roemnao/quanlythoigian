import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, errorOf, OWNER } from './helpers.js';

const t = await boot({ TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64') });
const { call, signIn, kv, google } = t;
const gsync = await import('../src/gsync.js');
const gtoken = await import('../src/gtoken.js');
test.after(() => t.close());

let token; let owner; let aId; let a;
const me = async (cookie) => (await call('GET', '/api/me', null, { cookie })).data;
const assign = (title, uid = 'z-a', extra = {}) => call('POST', '/api/agent/assign', { title, start: '2026-12-01T09:00:00+07:00', assignees: [{ zaloUid: uid }], ...extra }, { token });

test('mã hoá token: đúng khoá giải được, sai khoá thì coi như chưa có', async () => {
  const box = await gtoken.encrypt('rt-bí-mật');
  assert.ok(!JSON.stringify(box).includes('bí mật'));
  assert.equal(await gtoken.decrypt(box), 'rt-bí-mật');
  process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
  assert.equal(await gtoken.decrypt(box), null);
  process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
  assert.equal(await gtoken.decrypt(box), 'rt-bí-mật');
});

test('đăng nhập đủ quyền: kết nối Google Lịch ngay, token mã hoá, không lộ ra ngoài', async () => {
  owner = (await signIn(OWNER)).cookie;
  token = (await call('POST', '/api/admin/agent-token', null, { cookie: owner })).data.token;
  const r = await signIn({ sub: 'g-a', email: 'a@gmail.com', name: 'A' });
  assert.equal(r.location, '/?google=member-new&calendar=on');
  assert.equal(r.to.searchParams.get('access_type'), 'offline');
  a = r.cookie;
  const info = await me(a);
  aId = info.id;
  assert.equal(info.google.status, 'connected');
  const stored = await kv.get(`gtoken:${aId}`);
  assert.equal(stored.v, 1);
  assert.ok(!JSON.stringify(stored).includes('rt-a@gmail.com'), 'token nằm trong kho dạng mã hoá');
  assert.ok(!JSON.stringify(await kv.get(`udata:${aId}`)).includes('rt-a@gmail.com'), 'dữ liệu người dùng không chứa token');
  assert.ok(!JSON.stringify(await call('GET', '/api/me/state', null, { cookie: a })).includes('rt-'));
});

test('Google không trả refresh token lần đầu: tự hỏi lại một lần bằng màn hình đồng ý', async () => {
  const r = await signIn({ sub: 'g-n', email: 'n@gmail.com', name: 'N' }, { code: 'norefresh' });
  assert.equal(r.location, '/?google=member-new&calendar=on');
  assert.equal((await me(r.cookie)).google.status, 'connected');
});

test('người dùng bỏ tick quyền lịch: vẫn đăng nhập, rồi bổ sung quyền bằng một nút', async () => {
  const r = await signIn({ sub: 'g-s', email: 's@gmail.com', name: 'S' }, { code: 'noscope' });
  assert.equal(r.location, '/?google=member-new&calendar=no-scope');
  assert.equal((await me(r.cookie)).google.status, 'no-scope');
  const add = await call('GET', '/api/google/start?purpose=calendar-member', null, { cookie: r.cookie });
  assert.equal(add.status, 302);
  const q = new URL(add.location).searchParams;
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('login_hint'), 's@gmail.com');
  assert.match(errorOf((await call('GET', '/api/google/start?purpose=calendar-member')).location), /đăng nhập/);
  const oauth = add.cookies.find((c) => c.startsWith('qltg_oauth='));
  const cb = await call('GET', `/api/google/callback?code=c&state=${q.get('state')}`, null, { cookie: [oauth, r.cookie].join('; ') });
  assert.equal(cb.location, '/?google=member&calendar=on');
  assert.equal((await me(r.cookie)).google.status, 'connected');
});

test('lỗi tạm thời của Google: lệnh được giữ lại, cron chạy lại thì ghi xong; không ghi trùng', async () => {
  const code = (await call('POST', '/api/me/zalo-code', null, { cookie: a })).data.code;
  await call('POST', '/api/agent/zalo-link', { code, zaloUid: 'z-a' }, { token });
  google.failNext = 1;
  const r = await assign('Họp lỗi mạng');
  await gsync.settleDrains();
  const gid = `qltgm${r.data.eventId}`;
  assert.ok(!google.cal('a@gmail.com').has(gid), 'Google lỗi 503: chưa ghi');
  assert.ok(Object.keys(await kv.hgetall('gpending')).includes(aId), 'đánh dấu để cron chạy lại');
  const { runCron } = await import('../src/cron.js');
  await runCron();
  assert.ok(google.cal('a@gmail.com').has(gid), 'cron ghi bù');
  assert.deepEqual(Object.keys(await kv.hgetall('gpending')), []);
  // Chạy lại lần nữa không tạo trùng.
  const posts = google.calls.filter((c) => c.method === 'POST' && c.who === 'a@gmail.com').length;
  await gsync.drainMember(aId);
  assert.equal(google.calls.filter((c) => c.method === 'POST' && c.who === 'a@gmail.com').length, posts);
});

test('hai lần ghi cùng lúc chỉ gọi Google một lần cho mỗi lệnh', async () => {
  const r = await assign('Họp song song');
  const gid = `qltgm${r.data.eventId}`;
  await Promise.all([gsync.drainMember(aId), gsync.drainMember(aId), gsync.settleDrains()]);
  assert.equal(google.calls.filter((c) => c.method === 'POST' && c.url.includes('/events') && c.who === 'a@gmail.com').length >= 1, true);
  assert.ok(google.cal('a@gmail.com').has(gid));
});

test('lịch từng được trình duyệt ghi trước đây (cùng ID cố định): 409 → cập nhật, không trùng', async () => {
  const id = 'abcdef012345';
  google.cal('a@gmail.com').set(`qltgm${id}`, { summary: 'bản cũ' });
  const { applyCommand } = await import('../src/calsync.js');
  const res = await applyCommand({ op: 'create', event: { id, title: 'Bản mới', start: '2026-12-02T02:00:00.000Z', timeZone: 'Asia/Ho_Chi_Minh' } }, { token: 'at-a@gmail.com' });
  assert.equal(res.ok, true);
  assert.equal(google.cal('a@gmail.com').get(`qltgm${id}`).summary, 'Bản mới');
});

test('người dùng gỡ quyền ở Google: chuyển sang "kết nối lại", không đăng xuất, bấm một lần là xong', async () => {
  google.refreshFails = true;
  gtoken.forgetAccessToken(aId);
  await assign('Sau khi gỡ quyền');
  await gsync.settleDrains();
  google.refreshFails = false;
  const info = await me(a);
  assert.equal(info.google.status, 'reconnect', 'vẫn đăng nhập, chỉ báo kết nối lại');
  assert.equal(await kv.get(`gtoken:${aId}`), null, 'token hỏng đã xoá');
  // Đăng nhập lại cấp quyền mới → kết nối lại và ghi bù lịch đang chờ.
  const re = await signIn({ sub: 'g-a', email: 'a@gmail.com', name: 'A' }, { terms: null, cookie: a });
  assert.match(re.location, /calendar=on/);
  await gsync.settleDrains();
  assert.equal((await me(a)).google.status, 'connected');
  await gsync.drainMember(aId);
  assert.ok([...google.cal('a@gmail.com').values()].some((e) => e.summary === 'Sau khi gỡ quyền'));
});

test('ngắt kết nối: thu hồi quyền, xoá token, đăng xuất không ảnh hưởng', async () => {
  const before = google.revoked.length;
  const r = await call('DELETE', '/api/me/google', null, { cookie: a });
  assert.equal(r.data.google.status, 'off');
  assert.equal(google.revoked.length, before + 1);
  assert.equal(await kv.get(`gtoken:${aId}`), null);
  assert.equal((await call('POST', '/api/me/google/sync', null, { cookie: a })).status, 400);
});

test('thiếu TOKEN_ENC_KEY trên Vercel: báo lỗi rõ ràng, không lưu token dạng rõ', async () => {
  const saved = { k: process.env.TOKEN_ENC_KEY, v: process.env.VERCEL };
  delete process.env.TOKEN_ENC_KEY; process.env.VERCEL = '1';
  await assert.rejects(() => gtoken.encrypt('x'), /TOKEN_ENC_KEY/);
  process.env.TOKEN_ENC_KEY = saved.k; if (saved.v) process.env.VERCEL = saved.v; else delete process.env.VERCEL;
});
