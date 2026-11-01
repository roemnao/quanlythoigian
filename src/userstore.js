// Dữ liệu riêng của từng người dùng: lịch, việc, đề xuất, nguồn, Pomodoro, Google Lịch. Mỗi người một khoá `udata:<id>`
// nên không ai đọc hay ghi nhầm dữ liệu của người khác. Cùng giao diện với Store (data + save) để sources.js / google.js dùng chung.
import { kv } from './kv.js';
import { Store } from './db.js';
import { getRefreshToken } from './gtoken.js';

export const udataKey = (id) => `udata:${id}`;

export class UserStore extends Store {
  constructor(raw, id) {
    super(raw, { persist: true });
    this.id = id;
    this.data.settings = {}; // khoá API nằm ở kho hệ thống, không ở dữ liệu người dùng
    this.data.auth = null;
  }

  static async open(id) {
    const raw = await kv.get(udataKey(id));
    const s = new UserStore(raw, id);
    const g = s.data.google;
    if (g && g.status === 'connected') {
      const token = await getRefreshToken(id).catch(() => null);
      if (token) g.refreshToken = token; else g.status = 'reconnect'; // khoá mã hoá đổi hoặc token đã bị xoá
    }
    return s;
  }

  async save() {
    const data = { ...this.data };
    delete data.settings;
    delete data.auth;
    if (data.google) {
      data.google = { ...data.google };
      delete data.google.refreshToken; // token chỉ nằm ở gtoken (đã mã hoá)
    }
    await kv.set(udataKey(this.id), data);
  }
}

export const openUser = (id) => () => UserStore.open(id);

// Owner "chính": nhận nhắc việc / lệnh Zalo của chính bot lịch (meta Zalo, đề xuất từ tin nhắn Zalo nằm ở dữ liệu của người này).
export async function primaryOwnerId() {
  const id = await kv.get('primary-owner');
  if (id && (await kv.get(`user:${id}`))?.role === 'owner') return id;
  const { listMembers } = await import('./members.js');
  const owner = (await listMembers()).find((m) => m.role === 'owner');
  if (owner) await kv.set('primary-owner', owner.id);
  return owner?.id || null;
}

// Mở dữ liệu của Owner chính; chưa có Owner thì trả về kho tạm trong bộ nhớ (không lưu).
export async function openOwnerStore() {
  const id = await primaryOwnerId();
  if (!id) return new Store(null, { persist: false });
  return UserStore.open(id);
}
