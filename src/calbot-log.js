// Log của bot lịch: mỗi lệnh thêm / sửa / xoá lịch mà agent giao, ai nhận, ai chưa liên kết,
// và lúc app của từng người lấy lệnh về (ghi khi app hỏi lệnh, app không phải gửi gì ngược lên).
// Mỗi ngày một hàng riêng, tự hết hạn sau 90 ngày.
import { batch } from './kv.js';
import { dayKey } from './time.js';

export const LOG_KEEP_DAYS = 90;
const DAY = 24 * 3600;
const K = {
  day: (d) => `calbot-log:${d}`,
  fetched: (logId) => `calbot-fetched:${logId}`,
};

export async function writeLog(entry) {
  const day = dayKey(entry.at);
  await batch().lpush(K.day(day), entry).expire(K.day(day), (LOG_KEEP_DAYS + 1) * DAY).exec();
}

// App của `userId` vừa lấy các lệnh này: giữ lại lần lấy đầu tiên.
export async function recordFetched(userId, logIds) {
  const ids = [...new Set(logIds.filter(Boolean))];
  if (!ids.length) return;
  const at = new Date().toISOString();
  const b = batch();
  for (const id of ids) b.hsetnx(K.fetched(id), userId, at).expire(K.fetched(id), (LOG_KEEP_DAYS + 1) * DAY);
  await b.exec();
}

// {userId: thời điểm app lấy lệnh} của một dòng log.
export async function fetchedFor(logId) {
  return logId ? (await batch().hgetall(K.fetched(logId)).exec())[0] : {};
}

// Các ngày từ `from` tới `to` (YYYY-MM-DD, tính cả hai đầu), mới nhất trước, tối đa 90 ngày.
export function daysBetween(from, to) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const end = re.test(to || '') ? to : dayKey();
  const start = re.test(from || '') ? from : end;
  const out = [];
  for (let t = Date.parse(`${end}T00:00:00Z`); t >= Date.parse(`${start}T00:00:00Z`) && out.length < LOG_KEEP_DAYS; t -= DAY * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// Đọc log trong khoảng ngày, lọc theo người nhận (ID thành viên, email hoặc ID Zalo) nếu có.
export async function readLog({ from, to, member } = {}) {
  const days = daysBetween(from, to);
  const b = batch();
  for (const d of days) b.lrange(K.day(d), 0, -1);
  let entries = (await b.exec()).flat();
  const q = String(member || '').trim().toLowerCase();
  if (q) {
    entries = entries.filter((e) => [...(e.recipients || []), ...(e.unlinked || [])]
      .some((r) => [r.userId, r.email, r.zaloUid].some((v) => v && String(v).toLowerCase() === q)));
  }
  entries = entries.slice(0, 1000);
  if (entries.length) {
    const fb = batch();
    for (const e of entries) fb.hgetall(K.fetched(e.id));
    const fetched = await fb.exec();
    entries.forEach((e, i) => {
      e.recipients = (e.recipients || []).map((r) => ({ ...r, fetchedAt: fetched[i][r.userId] || null }));
    });
  }
  return entries;
}

const OPS = { create: 'thêm', update: 'sửa', delete: 'xoá' };
const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Một dòng cho mỗi người nhận (kể cả người chưa liên kết), mở được bằng Excel / Google Sheets.
export function logToCsv(entries) {
  const head = ['thoi_gian', 'lenh', 'ma_lich', 'tieu_de', 'bat_dau', 'ket_thuc', 'ca_ngay', 'nhom', 'nguoi_giao', 'ma_tin',
    'nguoi_nhan', 'zalo_uid', 'email', 'trang_thai', 'app_lay_luc'];
  const rows = [head];
  for (const e of entries) {
    const base = [e.at, OPS[e.op] || e.op, e.eventId, e.title, e.start, e.end || '', e.allDay ? 'có' : '',
      e.source?.chatName || e.source?.chatId || '', e.source?.senderName || e.source?.senderId || '', e.source?.messageId || ''];
    for (const r of e.recipients || []) rows.push([...base, r.name, r.zaloUid, r.email, 'đã giao', r.fetchedAt || '']);
    for (const r of e.unlinked || []) rows.push([...base, r.name, r.zaloUid, '', 'chưa liên kết', '']);
    if (!e.recipients?.length && !e.unlinked?.length) rows.push([...base, '', '', '', '', '']);
  }
  // BOM để Excel đọc đúng tiếng Việt.
  return `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
