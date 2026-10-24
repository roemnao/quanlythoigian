// Lưu dữ liệu đơn giản bằng một file JSON (đủ cho 1 người dùng).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = () => ({
  events: [],      // { id, title, start, end, allDay, note, sourceId, origin }
  tasks: [],       // { id, title, quadrant, deadline, done, note, createdAt, doneAt, origin }
  goals: {},       // { 'YYYY-MM-DD': ['...', '...', '...'] }
  suggestions: [], // { id, kind, title, start, end, deadline, quadrant, note, origin, createdAt }
  sources: [],     // { id, type: 'ics'|'web', name, url, lastSync, lastError, lastHash }
  pomodoros: [],   // { at, minutes, taskId }
  meta: { reminded: {}, lastSummaryDate: null, zaloOffset: null },
});

export function newId() {
  return crypto.randomBytes(6).toString('hex');
}

export class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    if (file && fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...EMPTY(), ...raw, meta: { ...EMPTY().meta, ...raw.meta } };
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
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
    if (added.length) this.save();
    return added;
  }

  approveSuggestion(id, overrides = {}) {
    const i = this.data.suggestions.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const s = { ...this.data.suggestions[i], ...overrides };
    this.data.suggestions.splice(i, 1);
    let created;
    if (s.kind === 'event') {
      created = { id: newId(), title: s.title, start: s.start, end: s.end, allDay: false, note: s.note, origin: s.origin };
      this.data.events.push(created);
    } else {
      created = {
        id: newId(), title: s.title, quadrant: s.quadrant, deadline: s.deadline, done: false,
        note: s.note, createdAt: new Date().toISOString(), origin: s.origin,
      };
      this.data.tasks.push(created);
    }
    this.save();
    return { kind: s.kind, item: created };
  }

  rejectSuggestion(id) {
    const before = this.data.suggestions.length;
    this.data.suggestions = this.data.suggestions.filter((s) => s.id !== id);
    if (this.data.suggestions.length !== before) this.save();
    return this.data.suggestions.length !== before;
  }

  // Thay toàn bộ sự kiện của một nguồn lịch (ICS) bằng danh sách mới.
  replaceSourceEvents(sourceId, events) {
    this.data.events = this.data.events.filter((e) => e.sourceId !== sourceId);
    for (const e of events) this.data.events.push({ id: newId(), ...e, sourceId, origin: 'ics' });
    this.save();
  }
}
