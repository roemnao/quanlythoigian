// Dữ liệu của ứng dụng (1 người dùng) + các thao tác chống trùng, duyệt đề xuất.
// Các phương thức chỉ thay đổi dữ liệu trong bộ nhớ; người gọi tự `await store.save()`.
import crypto from 'node:crypto';
import { loadRaw, saveRaw } from './storage.js';

const EMPTY = () => ({
  events: [],      // { id, title, start, end, allDay, note, sourceId, origin }
  tasks: [],       // { id, title, quadrant, deadline, done, note, createdAt, doneAt, origin }
  goals: {},       // { 'YYYY-MM-DD': ['...', '...', '...'] }
  suggestions: [], // { id, kind, title, start, end, deadline, quadrant, note, origin, createdAt }
  sources: [],     // { id, type: 'ics'|'web', name, url, lastSync, lastError, lastHash }
  pomodoros: [],   // { at, minutes, taskId }
  auth: null,      // { admin: { username, salt, hash }, secret } — tài khoản quản trị (mật khẩu đã băm)
  meta: { reminded: {}, lastSummaryDate: null, zaloChatId: null, zaloName: null, pairCode: null },
});

export function newId() {
  return crypto.randomBytes(6).toString('hex');
}

export class Store {
  // persist=false: chỉ dùng trong bộ nhớ (cho kiểm thử).
  constructor(raw = null, { persist = true } = {}) {
    const base = EMPTY();
    this.data = raw ? { ...base, ...raw, meta: { ...base.meta, ...raw.meta } } : base;
    this.persist = persist;
  }

  static async open() {
    return new Store(await loadRaw());
  }

  async save() {
    if (this.persist) await saveRaw(this.data);
  }

  // Khoá chống trùng: cùng loại + tiêu đề + thời điểm => coi là một.
  static key(item) {
    const title = (item.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const when = item.start || item.deadline || '';
    const minute = when ? new Date(when).toISOString().slice(0, 16) : '';
    return `${item.kind || (item.start ? 'event' : 'task')}|${title}|${minute}`;
  }

  existingKeys() {
    const keys = new Set();
    for (const e of this.data.events) keys.add(Store.key({ ...e, kind: 'event' }));
    for (const t of this.data.tasks) keys.add(Store.key({ ...t, kind: 'task' }));
    for (const s of this.data.suggestions) keys.add(Store.key(s));
    return keys;
  }

  // Thêm các đề xuất mới vào hàng chờ, bỏ qua mục trùng. Trả về các mục thực sự được thêm.
  addSuggestions(items, origin) {
    const keys = this.existingKeys();
    const added = [];
    for (const it of items) {
      if (!it.title) continue;
      const s = {
        id: newId(),
        kind: it.kind === 'event' && it.start ? 'event' : 'task',
        title: String(it.title).trim(),
        start: it.start || null,
        end: it.end || null,
        deadline: it.deadline || null,
        quadrant: [1, 2, 3, 4].includes(Number(it.quadrant)) ? Number(it.quadrant) : 2,
        note: it.note || '',
        origin,
        createdAt: new Date().toISOString(),
      };
      const k = Store.key(s);
      if (keys.has(k)) continue;
      keys.add(k);
      this.data.suggestions.push(s);
      added.push(s);
    }
    return added;
  }

  approveSuggestion(id, overrides = {}) {
    const i = this.data.suggestions.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const s = { ...this.data.suggestions[i], ...overrides };
    this.data.suggestions.splice(i, 1);
    let created;
    if (s.kind === 'event' && s.start) {
      created = { id: newId(), title: s.title, start: s.start, end: s.end, allDay: false, note: s.note, origin: s.origin };
      this.data.events.push(created);
      return { kind: 'event', item: created };
    }
    created = {
      id: newId(), title: s.title, quadrant: s.quadrant, deadline: s.deadline, done: false,
      note: s.note, createdAt: new Date().toISOString(), origin: s.origin,
    };
    this.data.tasks.push(created);
    return { kind: 'task', item: created };
  }

  rejectSuggestion(id) {
    const before = this.data.suggestions.length;
    this.data.suggestions = this.data.suggestions.filter((s) => s.id !== id);
    return this.data.suggestions.length !== before;
  }

  // Thay toàn bộ sự kiện của một nguồn lịch (ICS) bằng danh sách mới.
  replaceSourceEvents(sourceId, events) {
    this.data.events = this.data.events.filter((e) => e.sourceId !== sourceId);
    for (const { uid, ...e } of events) {
      // ID cố định theo nguồn + UID + giờ bắt đầu để đồng bộ lại không tạo mục "mới".
      const id = crypto.createHash('sha1').update(`${sourceId}|${uid || e.title}|${e.start}`).digest('hex').slice(0, 12);
      this.data.events.push({ id, ...e, sourceId, origin: 'ics' });
    }
  }
}
