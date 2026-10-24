// Tài khoản quản trị: tạo ngay trên web lần đầu (lưu mật khẩu đã băm bằng scrypt),
// hoặc dùng APP_PASSWORD (+ ADMIN_USERNAME) trong biến môi trường.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const normalizeUser = (u) => String(u || '').trim().toLowerCase();

export async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = await scrypt(String(password), salt, 64);
  return { salt, hash: key.toString('hex') };
}

export async function verifyPassword(password, { salt, hash }) {
  const key = await scrypt(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Cách đăng nhập hiện tại: 'env' (APP_PASSWORD), 'db' (tài khoản tạo trên web) hoặc 'none' (chưa có).
export function authMode(store) {
  if (process.env.APP_PASSWORD) return 'env';
  return store.data.auth?.admin ? 'db' : 'none';
}

function secret(store) {
  return authMode(store) === 'env' ? process.env.APP_PASSWORD : store.data.auth?.secret || '';
}

export function adminName(store) {
  const mode = authMode(store);
  if (mode === 'env') return normalizeUser(process.env.ADMIN_USERNAME) || null;
  if (mode === 'db') return store.data.auth.admin.username;
  return null;
}

// Chữ ký phiên gắn với mật khẩu hiện tại: đổi mật khẩu thì các phiên cũ hết hiệu lực.
function sign(store, username) {
  const pwPart = authMode(store) === 'db' ? store.data.auth.admin.hash : '';
  return crypto.createHmac('sha256', secret(store)).update(`session-v1|${username}|${pwPart}`).digest('hex');
}

export function sessionCookieValue(store, username) {
  return `${Buffer.from(username).toString('base64url')}.${sign(store, username)}`;
}

export function verifySession(store, value) {
  if (authMode(store) === 'none' || !value) return false;
  const [u64, sig] = String(value).split('.');
  if (!u64 || !sig) return false;
  const username = Buffer.from(u64, 'base64url').toString();
  const expected = adminName(store);
  if (expected && username !== expected) return false;
  return safeEqual(sig, sign(store, username));
}

export function calendarKey(store) {
  if (authMode(store) === 'none') return null;
  return crypto.createHmac('sha256', secret(store)).update('calendar-v1').digest('hex').slice(0, 32);
}

// Kiểm tra tên + mật khẩu. Trả về tên đăng nhập nếu đúng, ngược lại null.
export async function checkLogin(store, username, password) {
  const user = normalizeUser(username);
  const mode = authMode(store);
  if (mode === 'env') {
    const want = normalizeUser(process.env.ADMIN_USERNAME);
    if (want && user !== want) return null;
    return safeEqual(String(password || ''), process.env.APP_PASSWORD) ? want || user || 'admin' : null;
  }
  if (mode === 'db') {
    const admin = store.data.auth.admin;
    if (user !== admin.username) return null;
    return (await verifyPassword(password, admin)) ? admin.username : null;
  }
  return null;
}

export function validateNew(username, password) {
  const user = normalizeUser(username);
  if (!/^[a-z0-9._-]{3,32}$/.test(user)) return 'Tên đăng nhập 3–32 ký tự: chữ không dấu, số, dấu . _ -';
  if (String(password || '').length < 4) return 'Mật khẩu cần ít nhất 4 ký tự';
  return null;
}

export async function createAdmin(store, username, password) {
  const { salt, hash } = await hashPassword(password);
  store.data.auth = {
    admin: { username: normalizeUser(username), salt, hash, createdAt: new Date().toISOString() },
    secret: crypto.randomBytes(32).toString('hex'),
  };
  return store.data.auth.admin.username;
}

export async function changePassword(store, password) {
  const { salt, hash } = await hashPassword(password);
  Object.assign(store.data.auth.admin, { salt, hash, changedAt: new Date().toISOString() });
}
