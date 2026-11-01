// Di trú một lần: dữ liệu cũ của chủ web (lịch, việc, đề xuất, nguồn, Google Lịch…) nằm ở kho hệ thống
// `quanlythoigian:db` → chuyển sang dữ liệu riêng của Owner chính. Không xoá dữ liệu cũ (rollback được).
import { kv } from './kv.js';
import { Store } from './db.js';
import { loadRaw } from './storage.js';
import { UserStore, primaryOwnerId } from './userstore.js';
import { saveRefreshToken } from './gtoken.js';
import { getMember, setGoogleStatus } from './members.js';

const FLAG = 'migrated:w2';
const MOVE = ['events', 'tasks', 'goals', 'suggestions', 'sources', 'pomodoros'];
const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : !v || Object.keys(v).length === 0);

export const migrationInfo = () => kv.get(FLAG);

// Tài khoản quản trị cũ đã liên kết Gmail → thành viên có cùng Google sub trở thành Owner.
async function ownerFromLegacyAdmin(legacy) {
  const sub = legacy.auth?.admin?.google?.sub;
  if (!sub) return null;
  const id = await kv.hget('idx:sub', sub);
  const user = id && await getMember(id);
  if (!user) return null;
  if (user.role !== 'owner') await kv.set(`user:${id}`, { ...user, role: 'owner', roleChangedAt: new Date().toISOString(), roleChangedBy: 'migrate' });
  return id;
}

export async function migrateLegacy({ force = false } = {}) {
  if (!force && (await kv.get(FLAG))) return { skipped: 'done' };
  if (!(await kv.set('migrating', 1, { nx: true, ex: 120 }))) return { skipped: 'busy' };
  try {
    const legacy = new Store(await loadRaw()).data;
    const hasData = MOVE.some((k) => !isEmpty(legacy[k])) || Boolean(legacy.google) || Boolean(legacy.meta?.zaloChatId);
    const ownerId = (await primaryOwnerId()) || (await ownerFromLegacyAdmin(legacy));
    if (!ownerId) return { skipped: 'no-owner' };
    if (!hasData) { await kv.set(FLAG, { at: new Date().toISOString(), ownerId, counts: {} }); return { migrated: false }; }

    const store = await UserStore.open(ownerId);
    const counts = {};
    for (const k of MOVE) {
      if (!isEmpty(legacy[k]) && isEmpty(store.data[k])) { store.data[k] = legacy[k]; counts[k] = Array.isArray(legacy[k]) ? legacy[k].length : Object.keys(legacy[k]).length; }
    }
    // Ghép nối Zalo nhắc việc, mốc đã nhắc: chỉ lấy giá trị cũ ở chỗ Owner chưa có gì.
    for (const [k, v] of Object.entries(legacy.meta || {})) {
      const cur = store.data.meta[k];
      if (cur == null || (typeof cur === 'object' && !Object.keys(cur).length)) store.data.meta[k] = v;
    }
    if (legacy.google?.refreshToken && !store.data.google) {
      await saveRefreshToken(ownerId, legacy.google.refreshToken);
      store.data.google = { ...legacy.google, refreshToken: undefined, status: 'connected', push: legacy.google.push !== false };
      await setGoogleStatus(ownerId, { status: 'connected', email: legacy.google.email || null });
      counts.google = 1;
    }
    if (store.data.sources.length) await setGoogleStatus(ownerId, { hasSources: true });
    await store.save();
    const info = { at: new Date().toISOString(), ownerId, counts };
    await kv.set(FLAG, info);
    return { migrated: true, ...info };
  } finally {
    await kv.del('migrating');
  }
}
