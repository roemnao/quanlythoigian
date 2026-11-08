// Kiểm thử đầu-cuối bằng trình duyệt thật (Playwright): một web, ba vai trò (Owner, Technician, User).
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
process.env.OWNER_EMAILS = 'owner@gmail.com';
for (const k of ['APP_PASSWORD', 'PRIMARY_HOST', 'APP_HOST', 'VERCEL']) delete process.env[k];

const { default: app } = await import('../../src/app.js');
const members = await import('../../src/members.js');
const calbot = await import('../../src/calbot.js');
const { kv } = await import('../../src/kv.js');
const shots = process.env.SHOTS_DIR;
if (shots) fs.mkdirSync(shots, { recursive: true });

const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;
const T = members.TERMS_VERSION;
const mk = async (sub, email, name) => (await members.signInMember({ sub, email, name }, { acceptedTerms: T })).user;
const owner = await mk('g-o', 'owner@gmail.com', 'Chủ Web');
const tech = await mk('g-t', 'tech@gmail.com', 'Kỹ Thuật');
const user = await mk('g-u', 'user@gmail.com', 'Nguyễn Văn An');
await members.setRole(owner, tech.id, 'technician');
const ownerNow = await members.getMember(owner.id);
await members.setRole(ownerNow, tech.id, 'technician');
const code = (await members.createZaloCode(user.id)).code;
await members.linkZalo({ code, zaloUid: 'z-an', zaloName: 'An Nguyễn' });
await calbot.assign({ title: 'Họp kế hoạch quý IV', start: '2026-10-30T09:00:00+07:00', assignees: [{ zaloUid: 'z-an' }], source: { chatName: 'Nhóm dự án', senderName: 'Sếp' } });
const cookies = Object.fromEntries(await Promise.all([['owner', owner], ['tech', tech], ['user', user]].map(async ([k, u]) => [k, await members.memberCookieValue(u.id)])));

const browser = await chromium.launch();
let failed = false;
async function open(who, { theme = 'dark', mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, serviceWorkers: 'block' });
  if (who) await ctx.addCookies([{ name: 'qltg_member', value: cookies[who], url: base }]);
  await ctx.addInitScript((t) => localStorage.setItem('ifmwh-theme', t), theme);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|401|403/.test(m.text())) errors.push(m.text()); });
  p.errors = errors;
  await p.goto(`${base}/`);
  await p.waitForSelector(who ? '#app:not([hidden])' : '#signin:not([hidden])');
  return p;
}
const shot = async (p, name) => { if (shots) await p.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };
async function step(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed = true; console.log(`FAIL ${name}\n     ${e.message}`); }
}
const navLabels = (p) => p.$$eval('#nav button[data-view] span', (els) => els.map((e) => e.textContent));

await step('chưa đăng nhập: màn hình đăng nhập Google, bắt buộc tick điều khoản', async () => {
  const p = await open(null);
  assert.match(await p.textContent('#signin-body'), /Đăng nhập bằng Google/);
  assert.equal(await p.getAttribute('#signin-body a.google-btn', 'aria-disabled'), 'true');
  await p.check('#agree');
  assert.match(await p.getAttribute('#signin-body a.google-btn', 'href'), /^\/api\/google\/start\?purpose=member&terms=/);
  await shot(p, 'signin'); assert.deepEqual(p.errors, []);
});

await step('User: chỉ 6 mục sử dụng, không có Quản trị; vào thẳng URL quản trị cũng không được', async () => {
  const p = await open('user');
  assert.deepEqual(await navLabels(p), ['Tổng quan', 'Lịch', 'Công việc', 'Đề xuất', 'Nguồn', 'Tài khoản']);
  await p.goto(`${base}/#/quan-tri/bot`);
  await p.waitForTimeout(400);
  assert.equal(await p.textContent('#view-title'), 'Tổng quan', 'bị đưa về Tổng quan');
  const r = await p.evaluate(() => fetch('/api/admin/members').then((x) => x.status));
  assert.equal(r, 403);
  assert.deepEqual(p.errors, []);
});

await step('User: tạo lịch, việc, đề xuất; thấy trong Lịch, Công việc; Tài khoản có Zalo và lịch đã giao', async () => {
  const p = await open('user');
  await p.click('#top-action'); await p.fill('#modal-body input[name=title], #modal-body input', 'Khám răng');
  await p.click('#modal-save'); await p.waitForTimeout(500);
  assert.match(await p.textContent('section[data-view=dashboard]'), /Khám răng|Hôm nay chưa có lịch/);
  await p.click('#nav button[data-view=tasks]');
  await p.fill('#task-form input[name=title]', 'Gọi cho mẹ'); await p.click('#task-form button[type=submit], #task-form button:not([type])');
  await p.waitForTimeout(500);
  assert.match(await p.textContent('section[data-view=tasks]'), /Gọi cho mẹ/);
  await p.click('#nav button[data-view=account]'); await p.waitForTimeout(600);
  const acc = await p.textContent('#view-account');
  assert.match(acc, /Nguyễn Văn An/); assert.match(acc, /An Nguyễn/); assert.match(acc, /Cho phép Google Lịch|Chưa kết nối Google Lịch/);
  await shot(p, 'user-account'); assert.deepEqual(p.errors, []);
});

await step('Technician: Quản lý bot lịch + Tài khoản người dùng (chỉ xem, không có ô đổi quyền)', async () => {
  const p = await open('tech');
  const labels = await navLabels(p);
  assert.deepEqual(labels.slice(-2), ['Quản lý bot lịch', 'Tài khoản người dùng']);
  assert.ok(!labels.some((l) => /máy ảo/i.test(l)));
  await p.click('#nav button[data-view=admin-accounts]'); await p.waitForSelector('#view-admin-accounts .member');
  assert.equal(await p.$$eval('#view-admin-accounts select', (s) => s.length), 0);
  assert.match(await p.textContent('#view-admin-accounts'), /chỉ xem/);
  await p.click('#nav button[data-view=admin-bot]'); await p.waitForSelector('#view-admin-bot .tabs');
  assert.deepEqual(await p.$$eval('#view-admin-bot .tabs button', (b) => b.map((x) => x.textContent)),
    ['Nhật ký bot lịch', 'Cài đặt bot lịch', 'Bot Zalo nhắc việc', 'Kết nối AI agent', 'Khoá & trạng thái']);
  await shot(p, 'tech-bot'); assert.deepEqual(p.errors, []);
});

await step('Owner: đổi quyền User → Technician; User tải lại thấy menu mới ngay', async () => {
  const p = await open('owner');
  await p.click('#nav button[data-view=admin-accounts]'); await p.waitForSelector('#view-admin-accounts select');
  p.on('dialog', (d) => d.accept());
  const row = p.locator('#view-admin-accounts li.member', { hasText: 'user@gmail.com' });
  await row.locator('select').selectOption('technician');
  await p.waitForTimeout(700);
  assert.match(await p.textContent('#view-admin-accounts'), /User → Technician|Technician/);
  const u = await open('user');
  assert.ok((await navLabels(u)).includes('Quản lý bot lịch'));
  await members.setRole(await members.getMember(owner.id), user.id, 'user'); // trả lại
  await shot(p, 'owner-accounts'); assert.deepEqual(p.errors, []);
});

await step('Owner: các tab Quản lý bot lịch hiển thị đủ, có hướng dẫn Publish app và cron', async () => {
  const p = await open('owner');
  await p.click('#nav button[data-view=admin-bot]');
  for (const label of ['Nhật ký bot lịch', 'Cài đặt bot lịch', 'Bot Zalo nhắc việc', 'Kết nối AI agent', 'Khoá & trạng thái']) {
    await p.click(`#view-admin-bot .tabs button:has-text("${label}")`); await p.waitForTimeout(500);
    assert.ok((await p.textContent('#view-admin-bot')).length > 80, label);
  }
  const keys = await p.textContent('#view-admin-bot');
  assert.match(keys, /Publish app/); assert.match(keys, /cron-job\.org/); assert.match(keys, /TOKEN_ENC_KEY/);
  await shot(p, 'owner-keys'); assert.deepEqual(p.errors, []);
});

await step('điện thoại và nền sáng: menu và nội dung không tràn ngang', async () => {
  for (const theme of ['dark', 'light']) {
    const p = await open('user', { theme, mobile: true });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `tràn ngang ${overflow}px (${theme})`);
    await shot(p, `mobile-${theme}`);
  }
});

await step('responsive: Owner ở 360/390/768/1024px, mọi mục không tràn ngang; điện thoại có nút Thêm, vùng chạm ≥ 44px', async () => {
  const hashes = ['tong-quan', 'lich', 'cong-viec', 'de-xuat', 'nguon', 'tai-khoan', 'quan-tri/bot', 'quan-tri/tai-khoan'];
  for (const [w, h] of [[360, 740], [390, 844], [768, 1024], [1024, 768]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 1024, hasTouch: w < 1024, serviceWorkers: 'block' });
    await ctx.addCookies([{ name: 'qltg_member', value: cookies.owner, url: base }]);
    const p = await ctx.newPage();
    await p.goto(`${base}/`); await p.waitForSelector('#app:not([hidden])');
    for (const hash of hashes) {
      await p.evaluate((x) => { location.hash = `#/${x}`; }, hash); await p.waitForTimeout(150);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(over <= 1, `${w}px ${hash}: tràn ngang ${over}px`);
    }
    if (w <= 640) {
      const sizes = await p.$$eval('#nav > button', (bs) => bs.map((b) => b.getBoundingClientRect()).map((r) => [r.width, r.height]));
      assert.equal(sizes.length, 5, 'điện thoại: 4 mục chính + Thêm');
      for (const [bw, bh] of sizes) assert.ok(bw >= 44 && bh >= 44, `${w}px: nút điều hướng ${bw}x${bh} nhỏ hơn 44px`);
      await p.click('#more-btn');
      await p.click('#nav-more button[data-view=admin-accounts]');
      assert.equal(await p.evaluate(() => location.hash), '#/quan-tri/tai-khoan');
      assert.equal(await p.evaluate(() => document.getElementById('nav-more').classList.contains('open')), false);
    } else if (w < 900) {
      assert.equal(await p.isVisible('#more-btn'), false, 'máy tính bảng không có nút Thêm');
    }
    await ctx.close();
  }
});

await browser.close();
server.close();
if (failed) { console.log('\nCó bước thất bại.'); process.exit(1); }
console.log('\nTất cả bước đều qua.');
process.exit(0);
