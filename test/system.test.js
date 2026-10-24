import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qltg-s-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
delete process.env.APP_PASSWORD;

const { default: app } = await import('../src/app.js');
const { dayKey } = await import('../src/time.js');

const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function call(method, url, body, { cookie, token } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body && !['GET', 'HEAD'].includes(method) ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], data: await res.json().catch(() => null) };
}

let admin; let token;

test('cấu hình bot: chỉ quản trị sửa được, kiểm tra kiểu, không nhận khoá bí mật', async () => {
  admin = (await call('POST', '/api/setup', { username: 'chuweb', password: 'matkhau' })).cookie;
  token = (await call('POST', '/api/settings/agent-token', null, { cookie: admin })).data.token;

  assert.equal((await call('PUT', '/api/admin/system', { values: { FILTER_MODEL: 'x' } })).status, 401);
  assert.equal((await call('PUT', '/api/admin/system', { values: { FILTER_MODEL: 'x' } }, { token })).status, 401, 'khoá agent không sửa được cấu hình');

  const sys = (await call('GET', '/api/admin/system', null, { cookie: admin })).data;
  assert.ok(sys.schema.some((f) => f.key === 'FILTER_MODEL'));
  assert.ok(!sys.schema.some((f) => /API_KEY|BOT_TOKEN|IMEI/.test(f.key)));
  assert.equal(sys.bot.seen, false);

  for (const bad of [{ GEMINI_API_KEY: 'k' }, { ZALO_BOT_TOKEN: 't' }, { HISTORY_TURNS: 0 }, { FILTER_AI: 'có lẽ' },
    { ASSIGN_ALLOWED: 'ai-cung-duoc' }, { GEMINI_MODEL: 'co khoang trang' }]) {
    assert.equal((await call('PUT', '/api/admin/system', { values: bad }, { cookie: admin })).status, 400, JSON.stringify(bad));
  }
  const saved = await call('PUT', '/api/admin/system', { values: {
    GEMINI_MODEL: 'gemini-3.1-pro', FILTER_MODEL: 'gemini-3.1-flash-lite', FILTER_AI: 'true', HISTORY_TURNS: '30',
    BOT_NAMES: ' roemnao , bot ', SYSTEM_MD: 'Bạn là trợ lý.', SESSION_RETENTION_DAYS: 7,
  } }, { cookie: admin });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.version, 1);
  assert.deepEqual(saved.data.values, {
    GEMINI_MODEL: 'gemini-3.1-pro', FILTER_MODEL: 'gemini-3.1-flash-lite', FILTER_AI: true, HISTORY_TURNS: 30,
    BOT_NAMES: 'roemnao,bot', SYSTEM_MD: 'Bạn là trợ lý.', SESSION_RETENTION_DAYS: 7,
  });
  // Để trống = bỏ, bot dùng lại settings.env.
  const cleared = await call('PUT', '/api/admin/system', { values: { GEMINI_MODEL: '' } }, { cookie: admin });
  assert.equal(cleared.data.values.GEMINI_MODEL, undefined);
  assert.equal(cleared.data.version, 2);
});

test('bot đọc cấu hình và gửi nhịp tim; chỉ nhận cấu hình khi có bản mới', async () => {
  assert.equal((await call('GET', '/api/agent/config')).status, 401);
  const cfg = (await call('GET', '/api/agent/config', null, { token })).data;
  assert.equal(cfg.version, 2);
  assert.equal(cfg.values.FILTER_MODEL, 'gemini-3.1-flash-lite');
  assert.deepEqual(cfg.files, { 'SYSTEM.md': 'Bạn là trợ lý.' });
  assert.equal(cfg.values.SESSION_RETENTION_DAYS, undefined, 'thông số chỉ dùng ở máy chủ không gửi xuống');

  let hb = (await call('POST', '/api/agent/heartbeat', { version: '1.2.0', configVersion: 0, tokensToday: 1234, mode: 'personal' }, { token })).data;
  assert.equal(hb.config.version, 2);
  hb = (await call('POST', '/api/agent/heartbeat', { version: '1.2.0', configVersion: 2, lastError: 'Gemini 429' }, { token })).data;
  assert.equal(hb.config, null);
  const bot = (await call('GET', '/api/admin/system', null, { cookie: admin })).data.bot;
  assert.equal(bot.online, true);
  assert.equal(bot.version, '1.2.0');
  assert.equal(bot.lastError, 'Gemini 429');
});

test('session bộ lọc ↔ agent: lưu theo nhóm và ngày, cắt nội dung quá dài, tắt được', async () => {
  const now = new Date().toISOString();
  const events = [
    { at: now, chatId: 'g1', chatName: 'Nhóm A', isGroup: true, kind: 'message', senderName: 'An', text: 'roemnao ơi mai họp mấy giờ?' },
    { at: now, chatId: 'g1', kind: 'filter', decision: 'reply', tier: 'rule', reason: 'nhắc tên bot' },
    { at: now, chatId: 'g1', kind: 'agent', model: 'gemini-3.1-flash-lite', prompt: 'x'.repeat(10000), reply: '9h nhé', tokensIn: 900, tokensOut: 12 },
    { at: now, chatId: 'g1', kind: 'tool', name: 'xem_lich', args: { ngay: 'mai' }, result: 'Họp 9h' },
    { at: now, chatId: 'g2', chatName: 'Nhóm B', kind: 'filter', decision: 'skip', tier: 'ai', reason: 'nói chuyện riêng' },
    { at: now, chatId: '', kind: 'message' },
    { at: now, chatId: 'g1', kind: 'la' },
  ];
  assert.equal((await call('POST', '/api/agent/sessions', { events })).status, 401);
  const r = await call('POST', '/api/agent/sessions', { events }, { token });
  assert.equal(r.data.saved, 5);

  // Lô sau chỉ có bước bộ lọc (không kèm tên nhóm): tên đã lưu vẫn giữ nguyên.
  await call('POST', '/api/agent/sessions', { events: [{ at: now, chatId: 'g1', kind: 'filter', decision: 'skip', tier: 'ai' }] }, { token });
  const chats = (await call('GET', '/api/admin/sessions/chats', null, { cookie: admin })).data.chats;
  assert.deepEqual(chats.map((c) => c.chatId).sort(), ['g1', 'g2']);
  assert.equal(chats.find((c) => c.chatId === 'g1').name, 'Nhóm A');
  assert.equal(chats.find((c) => c.chatId === 'g1').group, true);
  const s = (await call('GET', `/api/admin/sessions?chat=g1&day=${dayKey()}`, null, { cookie: admin })).data;
  assert.deepEqual(s.events.map((e) => e.kind), ['message', 'filter', 'agent', 'tool', 'filter']);
  assert.ok(s.events[2].prompt.length < 4100);
  assert.equal((await call('GET', '/api/admin/sessions?chat=g1', null, { token })).status, 401);

  await call('PUT', '/api/admin/system', { values: { SESSION_UPLOAD: false } }, { cookie: admin });
  const off = await call('POST', '/api/agent/sessions', { events }, { token });
  assert.deepEqual(off.data, { saved: 0, disabled: true });
});
