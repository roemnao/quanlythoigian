// Đăng nhập thiết bị: trang quản lý bot (chạy trên máy chủ bot, không có Google riêng) nhờ web làm chứng Gmail.
// Bot xin một mã dùng một lần; người dùng mở link ở web app, đăng nhập Gmail và bấm Cho phép; bot hỏi lại web
// xem mã đã được duyệt bởi Gmail nào và có phải Gmail của tài khoản quản trị web không.
import crypto from 'node:crypto';
import { kv } from './kv.js';

const TTL = 10 * 60;
const TRIES_PER_10_MIN = 30;
const key = (code) => `devlogin:${code}`;
const fail = (status, message) => Object.assign(new Error(message), { status });
const validCode = (code) => /^[0-9a-f]{32}$/.test(String(code || ''));

export const DEVICE_LOGIN_TTL_SECONDS = TTL;

export async function startDeviceLogin() {
  const code = crypto.randomBytes(16).toString('hex');
  await kv.set(key(code), { status: 'pending', createdAt: Date.now() }, { ex: TTL });
  return { code, expiresIn: TTL };
}

// Thành viên (đã đăng nhập Gmail ở web app) duyệt mã. `ip` dùng để giới hạn đoán mã.
export async function approveDeviceLogin(code, member, ip = '') {
  if (!validCode(code)) throw fail(400, 'Mã không hợp lệ');
  if ((await kv.count(`devlogin-tries:${ip || 'x'}`, 600)) > TRIES_PER_10_MIN) throw fail(429, 'Thử quá nhiều lần, đợi vài phút');
  const entry = await kv.get(key(code));
  if (!entry) throw fail(404, 'Mã đã hết hạn hoặc không đúng. Quay lại trang quản lý bot và bấm đăng nhập lại.');
  if (entry.status !== 'pending') throw fail(409, 'Mã này đã được dùng');
  await kv.set(key(code), { ...entry, status: 'approved', email: member.email, sub: member.sub, memberId: member.id, approvedAt: Date.now() },
    { ex: TTL });
  return { email: member.email };
}

// Trang quản lý bot hỏi kết quả. Mã đã duyệt chỉ đọc được một lần. `adminSub` = Google sub của tài khoản quản trị web.
export async function pollDeviceLogin(code, adminSub) {
  if (!validCode(code)) throw fail(400, 'Mã không hợp lệ');
  const entry = await kv.get(key(code));
  if (!entry) return { status: 'expired' };
  if (entry.status !== 'approved') return { status: 'pending' };
  await kv.del(key(code));
  return { status: 'approved', email: entry.email, isAdmin: Boolean(adminSub) && entry.sub === adminSub };
}
