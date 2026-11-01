import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, OWNER } from './helpers.js';

const t = await boot({ TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64') });
const { call, signIn, kv, google } = t;
const { migrateLegacy, migrationInfo } = await import('../src/migrate.js');
const { saveRaw } = await import('../src/storage.js');
const { UserStore } = await import('../src/userstore.js');
test.after(() => t.close());

// Dữ liệu cũ của chủ web (trước khi tách theo từng người).
const legacy = () => ({
  events: [{ id: 'e1', title: 'Họp cũ', start: '2026-11-10T02:00:00Z', origin: 'manual' }, { id: 'e2', title: 'ICS', start: '2026-11-11T02:00:00Z', origin: 'ics', sourceId: 's1' }],
  tasks: [{ id: 't1', title: 'Việc cũ', quadrant: 1, done: false }],
  goals: { '2026-11-10': ['mục tiêu'] }, suggestions: [{ id: 'p1', kind: 'task', title: 'Chờ duyệt' }],
  sources: [{ id: 's1', type: 'ics', name: 'TKB', url: 'https://example.com/a.ics' }], pomodoros: [{ at: new Date().toISOString(), minutes: 25 }],
  settings: { geminiApiKey: 'gk' }, google: { refreshToken: 'rt-cu', email: 'owner@gmail.com', calendars: [{ id: 'primary', name: 'Lịch chính' }], push: true, pendingDeletes: [] },
  auth: { admin: { username: 'chu', google: { sub: 'g-owner', email: 'owner@gmail.com' } }, secret: 'x' },
  meta: { reminded: {}, zaloChatId: 'zc-1', zaloName: 'Chủ' },
});

test('chưa có Owner: không di trú, dữ liệu cũ nguyên vẹn', async () => {
  await saveRaw(legacy());
  assert.deepEqual(await migrateLegacy(), { skipped: 'no-owner' });
  assert.equal(await migrationInfo(), null);
});

test('Owner đăng nhập lần đầu: dữ liệu cũ chuyển sang tài khoản của Owner, token Google được mã hoá', async () => {
  const owner = (await signIn(OWNER, { code: 'noscope' })).cookie; // callback của Owner tự gọi di trú
  const info = await migrationInfo();
  assert.ok(info, 'đã di trú');
  assert.equal(info.counts.events, 2);
  const id = (await call('GET', '/api/me', null, { cookie: owner })).data.id;
  const s = (await call('GET', '/api/me/state', null, { cookie: owner })).data;
  assert.deepEqual(s.events.map((e) => e.title).sort(), ['Họp cũ', 'ICS']);
  assert.equal(s.tasks[0].title, 'Việc cũ');
  assert.equal(s.suggestions.length, 1);
  assert.equal(s.sources[0].name, 'TKB');
  assert.deepEqual(s.goals['2026-11-10'], ['mục tiêu']);
  const box = await kv.get(`gtoken:${id}`);
  assert.equal(box.v, 1);
  assert.ok(!JSON.stringify(await kv.get(`udata:${id}`)).includes('rt-cu'));
  assert.equal((await UserStore.open(id)).data.google.refreshToken, 'rt-cu', 'đọc ra đúng khi mở dữ liệu');
  assert.equal((await call('GET', '/api/me', null, { cookie: owner })).data.google.status, 'connected');
  assert.equal((await UserStore.open(id)).data.meta.zaloChatId, 'zc-1', 'ghép nối Zalo nhắc việc đi theo Owner');
});

test('chạy lại không nhân đôi; dữ liệu cũ không bị xoá (để quay lại được)', async () => {
  assert.deepEqual(await migrateLegacy(), { skipped: 'done' });
  const again = await migrateLegacy({ force: true });
  assert.equal(again.migrated, true);
  const owner = (await signIn(OWNER, { code: 'noscope', terms: null })).cookie;
  assert.equal((await call('GET', '/api/me/state', null, { cookie: owner })).data.events.length, 2, 'không nhân đôi vì dữ liệu mới đã có');
  const { loadRaw } = await import('../src/storage.js');
  assert.equal((await loadRaw()).events.length, 2, 'bản cũ còn nguyên tới bước dọn dẹp');
});

test('cron chạy cả di trú và báo cáo theo từng người', async () => {
  const r = await call('GET', '/api/cron');
  assert.equal(r.status, 200);
  assert.ok('members' in r.data);
  const status = (await call('GET', '/api/admin/bot', null, { cookie: (await signIn(OWNER, { code: 'noscope', terms: null })).cookie })).data.config;
  assert.ok(status.cronLast && status.migration.ownerId);
});
