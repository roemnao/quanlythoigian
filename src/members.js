// Thành viên: người nhận lịch được giao qua Zalo. Tài khoản chính là Gmail; Zalo chỉ là liên kết phụ,
// chứng minh bằng mã 6 số gửi cho bot. Mỗi người có một hàng lệnh lịch một chiều (thêm / sửa / xoá)
// mà web app của chính họ lấy về rồi ghi vào Google Lịch ngay trong trình duyệt.
import crypto from 'node:crypto';
import { batch, kv } from './kv.js';
import { newId } from './db.js';

// Đổi số này khi sửa Điều khoản / Chính sách: mọi người phải đồng ý lại trước khi nhận lệnh mới.
export const TERMS_VERSION = '2026-10-24';

const DAY = 24 * 3600;
export const COMMAND_KEEP_DAYS = 30;
const COMMAND_MAX = 500;
const CODE_TTL = 10 * 60;
const CODES_PER_HOUR = 5;
const LINK_TRIES = 10; // mỗi tài khoản Zalo được gửi sai mã tối đa 10 lần / 10 phút

const K = {
  user: (id) => `user:${id}`,
  seq: (id) => `seq:${id}`,
  cmds: (id) => `cmds:${id}`,
  bySub: 'idx:sub',
  byZalo: 'idx:zalo',
  code: (c) => `zcode:${c}`,
  codeOf: (id) => `zcode-of:${id}`,
  codeRate: (id) => `zrate:${id}`,
  linkTries: (uid) => `ztry:${uid}`,
  seen: 'seen',
  secret: 'member-secret',
  settings: 'member-settings',
};

const fail = (status, message) => Object.assign(new Error(message), { status });
const nowIso = () => new Date().toISOString();
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ----- Phiên đăng nhập của thành viên (cookie qltg_member) -----
// Khoá ký riêng, nằm trong kho khoá–giá trị và được nhớ trong bộ nhớ: kiểm tra phiên không tốn lượt đọc.
let secretCache = null;
async function secret() {
  if (!secretCache) {
    const [, value] = await batch().set(K.secret, crypto.randomBytes(32).toString('hex'), { nx: true }).get(K.secret).exec();
    secretCache = value;
  }
  return secretCache;
}
const sign = (key, id) => crypto.createHmac('sha256', key).update(`member-v1|${id}`).digest('base64url');

export async function memberCookieValue(id) {
  return `${id}.${sign(await secret(), id)}`;
}

export async function verifyMemberCookie(value) {
  const [id, sig] = String(value || '').split('.');
  if (!/^[0-9a-f]{12}$/.test(id || '') || !sig) return null;
  return safeEqual(sig, sign(await secret(), id)) ? id : null;
}

// ----- Cài đặt cho thành viên (chủ web chỉnh ở trang quản trị) -----
export const DEFAULT_MEMBER_SETTINGS = { allowedEmails: '', botChatUrl: '', botName: '' };

export async function memberSettings() {
  return { ...DEFAULT_MEMBER_SETTINGS, ...(await kv.get(K.settings)) };
}

export async function saveMemberSettings(input) {
  const cur = await memberSettings();
  const next = { ...cur };
  if ('allowedEmails' in input) next.allowedEmails = String(input.allowedEmails || '').trim().slice(0, 2000);
  if ('botName' in input) next.botName = String(input.botName || '').trim().slice(0, 80);
  if ('botChatUrl' in input) {
    const url = String(input.botChatUrl || '').trim();
    if (url && !/^https:\/\/(zalo\.me|chat\.zalo\.me|[\w.-]+\.zalo\.me)\//i.test(url)) {
      throw fail(400, 'Link chat với bot phải có dạng https://zalo.me/<số điện thoại hoặc ID>');
    }
    next.botChatUrl = url;
  }
  await kv.set(K.settings, next);
  return next;
}

// Danh sách email / tên miền được tạo tài khoản ("a@gmail.com, @congty.vn"). Để trống: ai cũng tạo được.
export function emailAllowed(email, rule) {
  const items = String(rule || '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!items.length) return true;
  const e = String(email || '').toLowerCase();
  return items.some((it) => (it.startsWith('@') ? e.endsWith(it) : e === it));
}

// ----- Hồ sơ -----
// Thông tin trả cho chính người đó (không có ID Zalo, không có gì của người khác).
export function publicMember(u) {
  return {
    id: u.id, email: u.email, name: u.name, picture: u.picture || null,
    zalo: u.zalo ? { name: u.zalo.name || null, linkedAt: u.zalo.linkedAt } : null,
    termsVersion: u.termsVersion, needsTerms: u.termsVersion !== TERMS_VERSION, createdAt: u.createdAt,
  };
}

export const getMember = (id) => kv.get(K.user(id));

// Đăng nhập bằng Google. Lần đầu phải đồng ý điều khoản (acceptedTerms = phiên bản đã đồng ý) mới tạo tài khoản.
export async function signInMember({ sub, email, name, picture }, { acceptedTerms } = {}) {
  if (!sub || !email) throw fail(400, 'Google không trả về email');
  const id = await kv.hget(K.bySub, sub);
  const existing = id && await kv.get(K.user(id));
  const now = nowIso();
  if (existing) {
    const u = { ...existing, email, name: name || existing.name, picture: picture || existing.picture || null };
    if (acceptedTerms === TERMS_VERSION && u.termsVersion !== TERMS_VERSION) Object.assign(u, { termsVersion: TERMS_VERSION, termsAcceptedAt: now });
    await kv.set(K.user(u.id), u);
    return { user: u, created: false };
  }
  if (acceptedTerms !== TERMS_VERSION) return { needsTerms: true };
  const settings = await memberSettings();
  if (!emailAllowed(email, settings.allowedEmails)) throw fail(403, `Tài khoản ${email} chưa được chủ hệ thống cho phép tham gia`);
  const user = {
    id: newId(), sub, email, name: name || email.split('@')[0], picture: picture || null, zalo: null,
    termsVersion: TERMS_VERSION, termsAcceptedAt: now, createdAt: now,
  };
  await batch().set(K.user(user.id), user).set(K.seq(user.id), 0).exec();
  // Hai lần đăng nhập cùng lúc: chỉ một tài khoản được ghi vào chỉ mục, cái còn lại bị bỏ.
  if (!(await kv.hsetnx(K.bySub, sub, user.id))) {
    await kv.del(K.user(user.id), K.seq(user.id));
    return signInMember({ sub, email, name, picture }, { acceptedTerms });
  }
  return { user, created: true };
}

export async function acceptTerms(id, version) {
  if (version !== TERMS_VERSION) throw fail(400, 'Điều khoản đã có bản mới, hãy tải lại trang và đọc lại');
  const u = await kv.get(K.user(id));
  if (!u) throw fail(401, 'Tài khoản không còn tồn tại');
  Object.assign(u, { termsVersion: TERMS_VERSION, termsAcceptedAt: nowIso() });
  await kv.set(K.user(id), u);
  return u;
}

// Xoá tài khoản cùng toàn bộ hàng lệnh. Log bot lịch giữ nguyên tới hết hạn (90 ngày), như điều khoản đã nêu.
export async function deleteMember(id) {
  const u = await kv.get(K.user(id));
  if (!u) return false;
  const [subOwner, zaloOwner] = await batch().hget(K.bySub, u.sub).hget(K.byZalo, u.zalo?.uid || '-').exec();
  const b = batch().del(K.user(id), K.seq(id), K.cmds(id), K.codeOf(id)).hdel(K.seen, id);
  if (subOwner === id) b.hdel(K.bySub, u.sub);
  if (u.zalo && zaloOwner === id) b.hdel(K.byZalo, u.zalo.uid);
  await b.exec();
  return true;
}

export async function listMembers() {
  const [index, seen] = await batch().hgetall(K.bySub).hgetall(K.seen).exec();
  const ids = Object.values(index);
  if (!ids.length) return [];
  const [users, seqs] = await batch().mget(ids.map(K.user)).mget(ids.map(K.seq)).exec();
  return users.map((u, i) => u && {
    id: u.id, email: u.email, name: u.name, picture: u.picture || null,
    zalo: u.zalo ? { uid: u.zalo.uid, name: u.zalo.name || null, linkedAt: u.zalo.linkedAt } : null,
    termsVersion: u.termsVersion, needsTerms: u.termsVersion !== TERMS_VERSION,
    createdAt: u.createdAt, lastSeenAt: seen[u.id] || null, commands: Number(seqs[i]) || 0,
  }).filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Ghi lại lần cuối app của người đó hỏi lệnh (tối đa 10 phút một lần cho mỗi máy chủ, đỡ tốn lượt ghi).
const seenAt = new Map();
export async function touchSeen(id) {
  const last = seenAt.get(id) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  seenAt.set(id, Date.now());
  await kv.hset(K.seen, id, nowIso());
}

// ----- Liên kết Zalo bằng mã 6 số -----
export async function createZaloCode(id) {
  if ((await kv.count(K.codeRate(id), 3600)) > CODES_PER_HOUR) {
    throw fail(429, `Mỗi giờ chỉ lấy được ${CODES_PER_HOUR} mã. Hãy dùng mã vừa lấy hoặc đợi một lát.`);
  }
  const old = await kv.get(K.codeOf(id));
  for (let i = 0; i < 10; i++) {
    const code = String(crypto.randomInt(100000, 1000000));
    if (!(await kv.set(K.code(code), id, { ex: CODE_TTL, nx: true }))) continue; // trùng mã của người khác
    const b = batch().set(K.codeOf(id), code, { ex: CODE_TTL });
    if (old && (await kv.get(K.code(old))) === id) b.del(K.code(old)); // mã cũ hết hiệu lực
    await b.exec();
    return { code, expiresAt: new Date(Date.now() + CODE_TTL * 1000).toISOString(), expiresInMinutes: CODE_TTL / 60 };
  }
  throw fail(503, 'Không tạo được mã, thử lại sau');
}

// Agent (PyloS) gọi khi có người nhắn mã cho bot. zaloUid là ID người gửi mà bot nhìn thấy trong nhóm.
export async function linkZalo({ code, zaloUid, zaloName }) {
  const c = String(code ?? '').trim();
  const uid = String(zaloUid ?? '').trim();
  if (!/^\d{6}$/.test(c) || !uid) throw fail(400, 'Cần "code" (6 chữ số) và "zaloUid"');
  if ((await kv.count(K.linkTries(uid), 600)) > LINK_TRIES) throw fail(429, 'Gửi sai mã quá nhiều lần. Đợi 10 phút rồi lấy mã mới trong app.');
  const id = await kv.get(K.code(c));
  const user = id && await kv.get(K.user(id));
  if (!user) throw fail(404, 'Mã không đúng hoặc đã hết hạn. Mở app, lấy mã mới rồi gửi lại.');

  const prevOwner = await kv.hget(K.byZalo, uid);
  const b = batch();
  // Zalo này đang gắn với Gmail khác: người giữ Zalo vừa chứng minh bằng mã nên chuyển sang tài khoản mới.
  if (prevOwner && prevOwner !== id) {
    const other = await kv.get(K.user(prevOwner));
    if (other?.zalo?.uid === uid) b.set(K.user(prevOwner), { ...other, zalo: null });
  }
  if (user.zalo?.uid && user.zalo.uid !== uid && (await kv.hget(K.byZalo, user.zalo.uid)) === id) b.hdel(K.byZalo, user.zalo.uid);
  user.zalo = { uid, name: String(zaloName || '').trim().slice(0, 80) || null, linkedAt: nowIso() };
  await b.set(K.user(id), user).hset(K.byZalo, uid, id).del(K.code(c), K.codeOf(id), K.linkTries(uid)).exec();
  return user;
}

export async function unlinkZalo(id) {
  const u = await kv.get(K.user(id));
  if (!u) throw fail(401, 'Tài khoản không còn tồn tại');
  if (!u.zalo) return u;
  const owner = await kv.hget(K.byZalo, u.zalo.uid);
  const b = batch();
  if (owner === id) b.hdel(K.byZalo, u.zalo.uid);
  u.zalo = null;
  await b.set(K.user(id), u).exec();
  return u;
}

// ID thành viên đang liên kết với từng tài khoản Zalo (null nếu chưa liên kết).
export async function membersByZalo(uids) {
  if (!uids.length) return [];
  const b = batch();
  for (const uid of uids) b.hget(K.byZalo, uid);
  return b.exec();
}

// ----- Hàng lệnh một chiều -----
// Thêm lệnh cho nhiều người trong một lần gọi. Trả về số thứ tự của từng người (-1: tài khoản vừa bị xoá).
export async function pushCommands(pairs) {
  if (!pairs.length) return [];
  const b = batch();
  for (const [userId, command] of pairs) {
    b.appendSeq(K.seq(userId), K.cmds(userId), command, { maxLen: COMMAND_MAX, ex: COMMAND_KEEP_DAYS * DAY });
  }
  return b.exec();
}

// Các lệnh có số thứ tự lớn hơn `after`. Hỏi khi chưa có gì mới chỉ tốn một lượt đọc.
// null: tài khoản không còn. missed: có lệnh đã quá hạn giữ hoặc bị cắt bớt trước khi app kịp lấy.
export async function commandsAfter(id, after = 0) {
  const latest = await kv.get(K.seq(id));
  if (latest == null) return null;
  const from = Math.max(0, Number(after) || 0);
  if (latest <= from) return { latest, commands: [], missed: false };
  const cutoff = Date.now() - COMMAND_KEEP_DAYS * DAY * 1000;
  const commands = (await kv.lrange(K.cmds(id), 0, -1)).filter((c) => c.seq > from && Date.parse(c.at) >= cutoff);
  return { latest, commands, missed: (commands[0]?.seq ?? latest + 1) > from + 1 };
}
