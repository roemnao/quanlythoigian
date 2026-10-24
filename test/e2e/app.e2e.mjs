// Kiểm thử đầu-cuối web app bằng trình duyệt thật (Playwright), Google giả lập hoàn toàn:
// thư viện đăng nhập (GIS) trả token giả, Google Lịch giả ghi lại các lời gọi.
// Chạy ở chế độ hai tên miền: web app ở http://app.localhost:<cổng>, trang quản trị ở http://localhost:<cổng>
// (Chromium tự trỏ *.localhost về máy này).
// Chạy: npm run test:e2e   (cần Playwright + Chromium; SHOTS_DIR=thư-mục để lưu ảnh chụp sáng/tối, máy tính/điện thoại)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qltg-e2e-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'secret-xyz';
process.env.APP_HOST = 'app.localhost';
delete process.env.APP_PASSWORD;

const { default: app } = await import('../../src/app.js');
const members = await import('../../src/members.js');
const calbot = await import('../../src/calbot.js');
const shots = process.env.SHOTS_DIR;
if (shots) fs.mkdirSync(shots, { recursive: true });

const server = app.listen(0);
const adminBase = `http://localhost:${server.address().port}`;
const base = `http://app.localhost:${server.address().port}`;

// Thành viên đã đăng nhập, đã liên kết Zalo.
const { user } = await members.signInMember({ sub: 'g-1', email: 'an@gmail.com', name: 'Nguyễn Văn An' }, { acceptedTerms: members.TERMS_VERSION });
const { code } = await members.createZaloCode(user.id);
await members.linkZalo({ code, zaloUid: 'z-an', zaloName: 'An Nguyễn' });
const cookie = await members.memberCookieValue(user.id);
const source = { chatId: 'g', chatName: 'Nhóm dự án', senderName: 'Sếp' };
const a1 = await calbot.assign({ title: 'Họp kế hoạch quý IV', start: '2026-10-30T09:00:00+07:00', note: 'Phòng 301', assignees: [{ zaloUid: 'z-an' }], source });
await calbot.assign({ title: 'Nộp báo cáo', allDay: true, start: '2026-11-02', assignees: [{ zaloUid: 'z-an' }], source });

const GIS_STUB = `window.google = { accounts: { oauth2: {
  initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: 'fake-token', expires_in: 3600, scope: cfg.scope }), 20) }),
  hasGrantedAllScopes: () => true,
} } };`;

const calendar = new Map();
const calls = [];
async function fakeCalendar(route) {
  const req = route.request();
  const url = new URL(req.url());
  const id = decodeURIComponent(url.pathname.split('/events/')[1] || '');
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  calls.push({ method: req.method(), id: id || body?.id, auth: req.headers().authorization });
  const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data),
    headers: { 'access-control-allow-origin': '*' } });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  if (req.method() === 'POST') {
    if (calendar.has(body.id)) return json(409, { error: { message: 'duplicate' } });
    calendar.set(body.id, body);
    return json(200, { ...body, htmlLink: `https://calendar.google.com/event?eid=${body.id}` });
  }
  if (req.method() === 'PUT') {
    if (!calendar.has(id)) return json(404, { error: { message: 'Not Found' } });
    calendar.set(id, body);
    return json(200, { ...body, id, htmlLink: `https://calendar.google.com/event?eid=${id}` });
  }
  if (req.method() === 'DELETE') {
    if (!calendar.delete(id)) return json(410, { error: { message: 'Gone' } });
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  }
  return json(400, {});
}

const browser = await chromium.launch();
let failed = false;
async function page({ theme = 'dark', mobile = false, signedIn = true } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, serviceWorkers: 'block' });
  if (signedIn) await ctx.addCookies([{ name: 'qltg_member', value: cookie, url: base }]);
  await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ contentType: 'text/javascript', body: GIS_STUB }));
  await ctx.route('https://www.googleapis.com/calendar/v3/**', fakeCalendar);
  await ctx.addInitScript((t) => localStorage.setItem('ifmwh-theme', t), theme);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(m.text()); });
  return { p, ctx, errors };
}
async function snap(p, name) {
  if (shots) await p.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}

try {
  // Chưa đăng nhập: màn hình đăng nhập, nút bị khoá cho tới khi tick đồng ý điều khoản.
  for (const [theme, mobile] of [['dark', false], ['light', false], ['dark', true], ['light', true]]) {
    const { p, ctx, errors } = await page({ theme, mobile, signedIn: false });
    await p.goto(`${base}/`);
    await p.getByText('Đăng nhập bằng Google').waitFor();
    assert.equal(await p.locator('html').getAttribute('data-theme'), theme);
    const btn = p.locator('a.google');
    assert.equal(await btn.getAttribute('aria-disabled'), 'true');
    await p.locator('#agree').check();
    assert.equal(await btn.getAttribute('aria-disabled'), 'false');
    assert.match(await btn.getAttribute('href'), new RegExp(`purpose=member&terms=${members.TERMS_VERSION}`));
    await snap(p, `app-signin-${theme}-${mobile ? 'mobile' : 'desktop'}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // Đã đăng nhập: kết nối Google Lịch → lệnh được ghi vào lịch.
  const { p, ctx, errors } = await page();
  await p.goto(`${base}/`);
  await p.getByText('Zalo đã liên kết').waitFor();
  await p.getByText('Có 2 lịch mới đang chờ').waitFor();
  await snap(p, 'app-home-pending-dark-desktop');
  await p.getByRole('button', { name: 'Kết nối Google Lịch' }).first().click();
  await p.getByText('Mọi lịch được giao đã nằm trong Google Lịch.').waitFor();
  const gid = `qltgm${a1.eventId}`;
  assert.ok(calendar.has(gid), 'lịch đã lên Google');
  assert.equal(calendar.get(gid).summary, 'Họp kế hoạch quý IV');
  assert.equal(calendar.get(gid).start.dateTime, '2026-10-30T02:00:00.000Z');
  assert.ok(calls.every((c) => c.auth === 'Bearer fake-token'));
  assert.equal(await p.locator('li.hist').count(), 2);

  // Sửa giờ rồi huỷ: app lấy lệnh mới khi bấm kiểm tra.
  await calbot.update(a1.eventId, { start: '2026-10-30T10:00:00+07:00' });
  await p.getByRole('button', { name: 'Kiểm tra ngay' }).click();
  await p.locator('li.hist').nth(2).waitFor();
  assert.equal(calendar.get(gid).start.dateTime, '2026-10-30T03:00:00.000Z');
  await calbot.cancel(a1.eventId);
  await p.getByRole('button', { name: 'Kiểm tra ngay' }).click();
  await p.locator('li.hist').nth(3).waitFor();
  assert.ok(!calendar.has(gid), 'lịch đã bị xoá khỏi Google');
  await snap(p, 'app-home-dark-desktop');

  // Tải lại trang: không áp lại lệnh cũ (tiến độ lưu trên máy).
  const before = calls.length;
  await p.reload();
  await p.getByText('Mọi lịch được giao đã nằm trong Google Lịch.').waitFor();
  assert.equal(calls.length, before);
  assert.deepEqual(errors, []);

  for (const [theme, mobile] of [['light', false], ['dark', true], ['light', true]]) {
    const v = await page({ theme, mobile });
    await v.p.goto(`${base}/`);
    await v.p.getByText('Zalo đã liên kết').waitFor();
    await snap(v.p, `app-home-${theme}-${mobile ? 'mobile' : 'desktop'}`);
    assert.deepEqual(v.errors, []);
    await v.ctx.close();
  }

  await ctx.close();

  // Tên miền quản trị: trang đăng nhập quản trị; link /app/ cũ đưa sang web app; phiên thành viên không dùng được ở đây.
  const adminView = await page({ signedIn: false });
  await adminView.p.goto(`${adminBase}/`);
  await adminView.p.locator('#nav button[data-view="system"]').waitFor({ state: 'attached' });
  assert.match(await adminView.p.title(), /Quản trị/);
  await snap(adminView.p, 'admin-host-login');
  await adminView.p.goto(`${adminBase}/app/`);
  assert.equal(new URL(adminView.p.url()).host, `app.localhost:${server.address().port}`);
  const me = await adminView.p.request.get(`${adminBase}/api/me`, { headers: { Cookie: `qltg_member=${cookie}` } });
  assert.equal(me.status(), 404);
  // Trang đang ở tên miền app (vừa được chuyển sang): API quản trị không có ở đây.
  assert.equal(await adminView.p.evaluate(() => fetch('/api/auth/status').then((r) => r.status)), 404);
  await adminView.ctx.close();
  console.log('e2e: ok');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
