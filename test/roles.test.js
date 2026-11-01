import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, OWNER } from './helpers.js';

const t = await boot();
const { call, signIn, kv } = t;
const { PERMS, can } = await import('../src/roles.js');
test.after(() => t.close());

let owner; let tech; let user; let techId; let userId; let ownerId;
const idOf = async (cookie) => (await call('GET', '/api/me', null, { cookie })).data.id;

test('bảng quyền: Owner đủ, Technician không sửa tài khoản, User chỉ dùng', () => {
  assert.deepEqual(PERMS.owner, ['use', 'bot:read', 'bot:write', 'accounts:read', 'accounts:write']);
  assert.ok(can({ role: 'technician' }, 'bot:write') && !can({ role: 'technician' }, 'accounts:write'));
  assert.ok(can({ role: 'technician' }, 'accounts:read'));
  assert.ok(can({ role: 'user' }, 'use') && !can({ role: 'user' }, 'bot:read') && !can({ role: 'user' }, 'accounts:read'));
  assert.ok(!can({ role: 'lạ' }, 'bot:read') && can({ role: 'lạ' }, 'use'), 'quyền lạ coi như User');
  assert.ok(!PERMS.owner.some((p) => p.startsWith('infra')), 'web không có mục máy ảo');
});

test('thiết lập: Owner từ OWNER_EMAILS, hai người còn lại là User', async () => {
  owner = (await signIn(OWNER)).cookie;
  ownerId = await idOf(owner);
  tech = (await signIn({ sub: 'g-t', email: 'tech@gmail.com', name: 'Kỹ thuật' })).cookie;
  user = (await signIn({ sub: 'g-u', email: 'user@gmail.com', name: 'Người dùng' })).cookie;
  techId = await idOf(tech); userId = await idOf(user);
  assert.equal((await call('GET', '/api/me', null, { cookie: tech })).data.role, 'user');
});

// Mọi route quản trị: [method, path, quyền cần, body]. Thêm route mới mà quên khai báo thì test cuối bắt được.
const ROUTES = () => [
  ['GET', '/api/admin/members', 'accounts:read'],
  ['GET', '/api/admin/audit', 'accounts:read'],
  ['PUT', `/api/admin/members/${userId}/role`, 'accounts:write', { role: 'user' }],
  ['DELETE', `/api/admin/members/${'0'.repeat(12)}/zalo`, 'accounts:write'],
  ['DELETE', `/api/admin/members/${'0'.repeat(12)}`, 'accounts:write'],
  ['GET', '/api/admin/bot-settings', 'bot:read'],
  ['PUT', '/api/admin/bot-settings', 'bot:write', { botName: 'x' }],
  ['GET', '/api/admin/calbot-log', 'bot:read'],
  ['GET', '/api/admin/calbot-log/csv', 'bot:read'],
  ['GET', '/api/admin/bot', 'bot:read'],
  ['PUT', '/api/admin/keys', 'bot:write', {}],
  ['POST', '/api/admin/agent-token', 'bot:write'],
  ['DELETE', '/api/admin/agent-token', 'bot:write'],
  ['PUT', '/api/admin/zalo/receiver', 'bot:write', { receiver: 'web' }],
  ['GET', '/api/admin/zalo/me', 'bot:write'],
  ['POST', '/api/admin/zalo/webhook-setup', 'bot:write', {}],
  ['POST', '/api/admin/zalo/pair', 'bot:write'],
  ['POST', '/api/admin/zalo/unpair', 'bot:write'],
  ['POST', '/api/admin/zalo/test', 'bot:write'],
  ['POST', '/api/admin/cron-run', 'bot:write'],
  ['POST', '/api/admin/migrate', 'bot:write', {}],
];

test('Owner đổi Technician: từng route quản trị đúng quyền (403 cho người không đủ quyền)', async () => {
  assert.equal((await call('PUT', `/api/admin/members/${techId}/role`, { role: 'technician' }, { cookie: owner })).status, 200);
  const cookies = { owner, tech, user };
  const who = { owner: 'owner', tech: 'technician', user: 'user' };
  for (const [method, path, perm, body] of ROUTES()) {
    if (path.includes('/role')) continue; // kiểm riêng bên dưới (không muốn đổi quyền thật)
    for (const [name, cookie] of Object.entries(cookies)) {
      if (path.includes('/agent-token') && method === 'DELETE') continue;
      const r = await call(method, path, body ?? null, { cookie });
      const allowed = can({ role: who[name] }, perm);
      if (allowed) assert.notEqual(r.status, 403, `${name} ${method} ${path} phải được phép → ${r.status}`);
      else assert.equal(r.status, 403, `${name} ${method} ${path} phải bị chặn → ${r.status}`);
    }
    assert.equal((await call(method, path, body ?? null)).status, 401, `chưa đăng nhập ${method} ${path}`);
  }
  // Khoá agent đã bị Owner/Technician tạo-xoá ở trên: tạo lại để các test khác (nếu có) không phụ thuộc.
  assert.equal((await call('PUT', `/api/admin/members/${userId}/role`, { role: 'owner' }, { cookie: tech })).status, 403, 'Technician không cấp quyền');
  assert.equal((await call('PUT', `/api/admin/members/${userId}/role`, { role: 'owner' }, { cookie: user })).status, 403);
});

test('mọi route /api quản trị đều có trong bảng quyền', () => {
  const declared = new Set(ROUTES().map(([m, p]) => `${m} ${p.replace(/\/[0-9a-f]{12}/g, '/:id')}`));
  const routes = [];
  const walk = (stack) => { for (const l of stack) { if (l.route) for (const path of [].concat(l.route.path)) for (const m of Object.keys(l.route.methods)) routes.push([m.toUpperCase(), String(path)]); else if (l.handle?.stack) walk(l.handle.stack); } };
  walk(t.app.router.stack);
  const open = (p) => /^\/api\/(me|agent|google|zalo\/webhook|cron)(\/|$)/.test(p) || !p.startsWith('/api/');
  const missing = routes.filter(([, p]) => !open(p)).map(([m, p]) => `${m} ${p}`).filter((k) => !declared.has(k.replace(/:id\b/g, ':id')));
  assert.deepEqual(missing, [], 'route quản trị chưa có trong bảng quyền');
});

test('đổi quyền có hiệu lực ngay, ghi nhật ký; không hạ Owner cuối cùng', async () => {
  const me = (await call('GET', '/api/me', null, { cookie: tech })).data;
  assert.equal(me.role, 'technician');
  assert.ok(me.perms.includes('bot:write') && !me.perms.includes('accounts:write'));
  // Technician thấy danh sách nhưng không có quyền sửa.
  const list = (await call('GET', '/api/admin/members', null, { cookie: tech })).data;
  assert.equal(list.canWrite, false);
  assert.equal((await call('DELETE', `/api/admin/members/${userId}`, null, { cookie: tech })).status, 403);

  assert.equal((await call('PUT', `/api/admin/members/${ownerId}/role`, { role: 'user' }, { cookie: owner })).status, 409);
  assert.equal((await call('DELETE', `/api/admin/members/${ownerId}`, null, { cookie: owner })).status, 400, 'không tự xoá mình ở đây');
  assert.equal((await call('PUT', `/api/admin/members/${userId}/role`, { role: 'chủ tịch' }, { cookie: owner })).status, 400);

  // Cấp Owner thứ hai rồi hạ Owner đầu được.
  assert.equal((await call('PUT', `/api/admin/members/${userId}/role`, { role: 'owner' }, { cookie: owner })).status, 200);
  assert.equal((await call('GET', '/api/admin/members', null, { cookie: user })).status, 200, 'có quyền ngay, không cần đăng nhập lại');
  assert.equal((await call('PUT', `/api/admin/members/${ownerId}/role`, { role: 'user' }, { cookie: user })).status, 200);
  assert.equal((await call('GET', '/api/admin/members', null, { cookie: owner })).status, 403, 'bị hạ quyền có hiệu lực ngay');
  assert.equal((await call('PUT', `/api/admin/members/${userId}/role`, { role: 'user' }, { cookie: user })).status, 409);

  const audit = (await call('GET', '/api/admin/audit', null, { cookie: user })).data.audit;
  assert.deepEqual(audit.slice(0, 2).map((a) => [a.target, a.from, a.to]), [['owner@gmail.com', 'owner', 'user'], ['user@gmail.com', 'user', 'owner']]);
  assert.equal(audit[0].actor, 'user@gmail.com');
});

test('OWNER_EMAILS là đường cứu hộ: đăng nhập lại là lấy lại quyền Owner', async () => {
  assert.equal((await call('GET', '/api/me', null, { cookie: owner })).data.role, 'user');
  const back = await signIn(OWNER);
  assert.equal((await call('GET', '/api/me', null, { cookie: back.cookie })).data.role, 'owner');
});
