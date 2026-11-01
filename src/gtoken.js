// Kho refresh token Google của từng thành viên, mã hoá AES-256-GCM. Máy chủ giữ token để tự ghi lịch,
// không bao giờ trả token xuống trình duyệt. Khoá mã hoá: TOKEN_ENC_KEY (base64, 32 byte). Mất khoá = mọi người phải kết nối lại.
import crypto from 'node:crypto';
import { kv } from './kv.js';
import { cfg } from './config.js';

const K = { token: (id) => `gtoken:${id}`, access: (id) => `gat:${id}`, secret: 'member-secret' };
const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const REVOKE_URL = () => process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';

export function encKeyConfigured() {
  return Boolean(process.env.TOKEN_ENC_KEY);
}

// Có TOKEN_ENC_KEY: dùng nó. Không có: chỉ cho phép khi chạy thử trên máy (khoá suy từ bí mật phiên lưu trong kho).
async function key() {
  if (process.env.TOKEN_ENC_KEY) {
    const k = Buffer.from(process.env.TOKEN_ENC_KEY, 'base64');
    if (k.length !== 32) throw Object.assign(new Error('TOKEN_ENC_KEY phải là 32 byte mã hoá base64'), { status: 500 });
    return k;
  }
  if (process.env.VERCEL) throw Object.assign(new Error('Chưa đặt TOKEN_ENC_KEY nên không lưu được quyền Google Lịch'), { status: 503, code: 'no-key' });
  const secret = await kv.get(K.secret);
  return crypto.createHash('sha256').update(`gtoken-dev|${secret || 'x'}`).digest();
}

export async function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', await key(), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export async function decrypt(box) {
  if (!box || box.v !== 1) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', await key(), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
  } catch (err) {
    if (err.code === 'no-key') throw err;
    return null; // sai khoá hoặc dữ liệu hỏng: coi như chưa có token
  }
}

export async function saveRefreshToken(memberId, refreshToken) {
  await kv.set(K.token(memberId), await encrypt(refreshToken));
  await kv.del(K.access(memberId));
}
export const getRefreshToken = async (memberId) => decrypt(await kv.get(K.token(memberId)));
export const hasRefreshToken = async (memberId) => Boolean(await kv.get(K.token(memberId)));

export async function deleteTokens(memberId) {
  await kv.del(K.token(memberId), K.access(memberId));
}

// Thu hồi bên Google (bỏ qua lỗi) rồi xoá khỏi kho.
export async function revokeAndDelete(memberId) {
  const token = await getRefreshToken(memberId).catch(() => null);
  if (token) {
    try { await fetch(`${REVOKE_URL()}?token=${encodeURIComponent(token)}`, { method: 'POST' }); } catch { /* bỏ qua */ }
  }
  await deleteTokens(memberId);
}

const memory = new Map();
// Access token ngắn hạn (~1 giờ) cho máy chủ gọi Google Lịch. `invalid_grant` = người dùng đã gỡ quyền → xoá token.
export async function accessTokenFor(memberId) {
  const hit = memory.get(memberId);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const refresh = await getRefreshToken(memberId);
  if (!refresh) throw Object.assign(new Error('Chưa kết nối Google Lịch'), { status: 400, reconnect: true });
  const res = await fetch(TOKEN_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg('GOOGLE_CLIENT_ID'), client_secret: cfg('GOOGLE_CLIENT_SECRET'), refresh_token: refresh, grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'invalid_grant') {
      memory.delete(memberId);
      await deleteTokens(memberId);
      throw Object.assign(new Error('Quyền Google Lịch đã bị gỡ, cần kết nối lại'), { status: 401, reconnect: true });
    }
    throw Object.assign(new Error(`Google: ${data.error_description || data.error || res.status}`), { status: res.status >= 500 || res.status === 429 ? 503 : 400 });
  }
  memory.set(memberId, { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}
export const forgetAccessToken = (memberId) => memory.delete(memberId);
