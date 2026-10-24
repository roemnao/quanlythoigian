// Bot lịch: agent (PyloS) báo "giao / sửa / huỷ lịch cho @A, @B"; bot lịch ghi lệnh vào hàng của từng người
// đã liên kết Zalo và ghi log. Web app của người đó tự lấy lệnh về và ghi vào Google Lịch của họ.
import { kv } from './kv.js';
import { newId } from './db.js';
import { dayKey, TZ } from './time.js';
import { getMember, membersByZalo, pushCommands } from './members.js';
import { fetchedFor, LOG_KEEP_DAYS, writeLog } from './calbot-log.js';

const DAY = 24 * 3600;
const MAX_ASSIGNEES = 50;
const K = { assignment: (id) => `assignment:${id}` };
const fail = (status, message) => Object.assign(new Error(message), { status });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// Nội dung lịch từ yêu cầu của agent, ghép lên bản cũ khi sửa. Lịch cả ngày lưu ngày (YYYY-MM-DD, ngày cuối tính cả).
function eventFrom(body, base = null) {
  const e = { title: '', start: null, end: null, allDay: false, note: '', ...base };
  if ('title' in body) e.title = String(body.title || '').trim().slice(0, 200);
  if ('note' in body) e.note = String(body.note || '').slice(0, 2000);
  if ('allDay' in body) e.allDay = Boolean(body.allDay);
  if ('start' in body) e.start = body.start || null;
  if ('end' in body) e.end = body.end || null;
  if (!e.title) throw fail(400, 'Cần "title"');
  const when = (v) => {
    if (v == null) return null;
    if (e.allDay) {
      if (isDate(v)) return v;
      const t = Date.parse(v);
      return Number.isNaN(t) ? undefined : dayKey(new Date(t));
    }
    const t = Date.parse(v);
    return Number.isNaN(t) || isDate(v) ? undefined : new Date(t).toISOString();
  };
  const start = when(e.start);
  const end = when(e.end);
  if (!start) throw fail(400, `Cần "start" ${e.allDay ? 'dạng YYYY-MM-DD' : 'có giờ, ISO 8601 (vd 2026-10-30T09:00:00+07:00)'}`);
  if (end === undefined) throw fail(400, '"end" không hợp lệ');
  if (end && end < start) throw fail(400, '"end" phải sau "start"');
  return { title: e.title, start, end: end && end !== start ? end : null, allDay: e.allDay, note: e.note };
}

function sourceFrom(s) {
  const pick = (v) => (v == null ? null : String(v).slice(0, 200));
  return {
    chatId: pick(s?.chatId), chatName: pick(s?.chatName), senderId: pick(s?.senderId),
    senderName: pick(s?.senderName), messageId: pick(s?.messageId),
  };
}

// [{zaloUid, name}] → bỏ trùng, kèm ID thành viên đang liên kết (null nếu chưa).
async function resolve(list) {
  const seen = new Set();
  const clean = [];
  for (const a of Array.isArray(list) ? list : []) {
    const uid = String(a?.zaloUid ?? '').trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    clean.push({ zaloUid: uid, name: String(a?.name || '').trim().slice(0, 80) || null });
  }
  if (clean.length > MAX_ASSIGNEES) throw fail(400, `Tối đa ${MAX_ASSIGNEES} người nhận mỗi lịch`);
  const ids = await membersByZalo(clean.map((a) => a.zaloUid));
  return clean.map((a, i) => ({ ...a, userId: ids[i] || null }));
}

// Lệnh gửi cho app: đủ để tạo / sửa sự kiện mà không cần hỏi lại máy chủ.
function command(op, eventId, rec, logId) {
  const ev = { id: eventId, ...rec.event, timeZone: TZ, from: { chat: rec.source.chatName, sender: rec.source.senderName } };
  return { op, event: op === 'delete' ? { id: eventId, title: rec.event.title } : ev, at: new Date().toISOString(), logId };
}

// Gửi lệnh rồi ghi log. pairs: [[assignee, op]]. Người có tài khoản vừa bị xoá được tính là chưa liên kết.
async function deliver(eventId, rec, pairs, op, unlinked) {
  const logId = newId();
  const results = await pushCommands(pairs.map(([a, o]) => [a.userId, command(o, eventId, rec, logId)]));
  const ok = pairs.filter((_, i) => results[i] >= 0);
  const gone = pairs.filter((_, i) => results[i] < 0).map(([a]) => a);
  const users = await Promise.all(ok.map(([a]) => getMember(a.userId)));
  const entry = {
    id: logId, at: new Date().toISOString(), op, eventId, ...rec.event, source: rec.source,
    recipients: ok.map(([a, o], i) => ({ userId: a.userId, email: users[i]?.email || null, zaloUid: a.zaloUid, name: a.name, op: o })),
    unlinked: [...unlinked, ...gone].map(({ zaloUid, name }) => ({ zaloUid, name })),
  };
  await writeLog(entry);
  const goneIds = new Set(gone.map((a) => a.userId));
  rec.assignees = rec.assignees.map((a) => (goneIds.has(a.userId) ? { ...a, userId: null } : a));
  return { logId, entry };
}

async function save(eventId, rec) {
  await kv.set(K.assignment(eventId), rec, { ex: (LOG_KEEP_DAYS + 1) * DAY });
}

const summary = (eventId, rec, entry) => ({
  eventId,
  event: rec.event,
  assigned: entry.recipients.map(({ zaloUid, name, op }) => ({ zaloUid, name, op })),
  unlinked: entry.unlinked,
});

export async function assign(body) {
  const event = eventFrom(body || {});
  const assignees = await resolve(body?.assignees);
  if (!assignees.length) throw fail(400, 'Cần ít nhất một người nhận trong "assignees": [{zaloUid, name}]');
  const eventId = newId();
  const now = new Date().toISOString();
  const rec = { event, source: sourceFrom(body.source), assignees, createdAt: now, updatedAt: now, cancelledAt: null, log: [] };
  const linked = assignees.filter((a) => a.userId);
  const { logId, entry } = await deliver(eventId, rec, linked.map((a) => [a, 'create']), 'create', assignees.filter((a) => !a.userId));
  rec.log.push(logId);
  await save(eventId, rec);
  return summary(eventId, rec, entry);
}

// Sửa nội dung và/hoặc người nhận. assignees: thay cả danh sách; add / remove: thêm, bớt vài người.
// Người đã nhận lịch → lệnh sửa; người mới (hoặc mới liên kết Zalo) → lệnh thêm; người bị bỏ → lệnh xoá.
export async function update(eventId, body = {}) {
  const rec = await kv.get(K.assignment(eventId));
  if (!rec || rec.cancelledAt) throw fail(404, 'Không tìm thấy lịch đã giao (hoặc đã huỷ)');
  const changed = ['title', 'start', 'end', 'allDay', 'note'].some((f) => f in body);
  rec.event = eventFrom(body, rec.event);

  let wanted = rec.assignees.map(({ zaloUid, name }) => ({ zaloUid, name }));
  if (Array.isArray(body.assignees)) wanted = body.assignees;
  if (Array.isArray(body.add)) wanted = [...wanted, ...body.add];
  if (Array.isArray(body.remove)) {
    const drop = new Set(body.remove.map((a) => String(a?.zaloUid ?? a ?? '').trim()));
    wanted = wanted.filter((a) => !drop.has(String(a.zaloUid)));
  }
  const resolved = await resolve(wanted);
  const before = new Map(rec.assignees.map((a) => [a.zaloUid, a]));
  const pairs = [];
  const next = resolved.map((a) => {
    const old = before.get(a.zaloUid);
    // Lịch đã nằm ở tài khoản nào thì cập nhật đúng tài khoản đó.
    if (old?.userId) {
      if (changed) pairs.push([old, 'update']);
      return { ...a, userId: old.userId };
    }
    if (a.userId) pairs.push([a, 'create']);
    return a;
  });
  const keep = new Set(next.map((a) => a.zaloUid));
  for (const old of rec.assignees) if (old.userId && !keep.has(old.zaloUid)) pairs.push([old, 'delete']);
  if (!next.length) throw fail(400, 'Lịch phải còn ít nhất một người nhận. Muốn bỏ hẳn, hãy huỷ lịch.');

  rec.assignees = next;
  rec.updatedAt = new Date().toISOString();
  const { logId, entry } = await deliver(eventId, rec, pairs, 'update', next.filter((a) => !a.userId));
  rec.log.push(logId);
  await save(eventId, rec);
  return summary(eventId, rec, entry);
}

export async function cancel(eventId) {
  const rec = await kv.get(K.assignment(eventId));
  if (!rec || rec.cancelledAt) throw fail(404, 'Không tìm thấy lịch đã giao (hoặc đã huỷ)');
  const pairs = rec.assignees.filter((a) => a.userId).map((a) => [a, 'delete']);
  const { logId, entry } = await deliver(eventId, rec, pairs, 'delete', []);
  rec.cancelledAt = new Date().toISOString();
  rec.log.push(logId);
  await save(eventId, rec);
  return summary(eventId, rec, entry);
}

// Tình trạng một lịch đã giao: ai đã liên kết, app của ai đã lấy lệnh mới nhất.
export async function status(eventId) {
  const rec = await kv.get(K.assignment(eventId));
  if (!rec) throw fail(404, 'Không tìm thấy lịch đã giao');
  const fetched = await fetchedFor(rec.log.at(-1));
  return {
    eventId, event: rec.event, source: rec.source, createdAt: rec.createdAt, updatedAt: rec.updatedAt, cancelledAt: rec.cancelledAt,
    assignees: rec.assignees.map((a) => ({ zaloUid: a.zaloUid, name: a.name, linked: Boolean(a.userId), fetchedAt: (a.userId && fetched[a.userId]) || null })),
  };
}
