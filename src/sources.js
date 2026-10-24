// Đồng bộ các nguồn: lịch ICS (Google Calendar, Outlook, TKB...) và trang web (đọc bằng Gemini).
import crypto from 'node:crypto';
import ical from 'node-ical';
import { extractItems, geminiConfigured } from './gemini.js';

const DAY = 24 * 60 * 60 * 1000;
// Chỉ lấy sự kiện trong khoảng này để lịch không phình to.
const PAST_DAYS = 7;
const FUTURE_DAYS = 90;

async function fetchText(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'quanlythoigian/0.1' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Tải ${url} lỗi HTTP ${res.status}`);
  return res.text();
}

// Trả về danh sách sự kiện { title, start, end, allDay, note } trong khoảng thời gian quan tâm.
export function parseIcsEvents(text, now = new Date()) {
  const data = ical.sync.parseICS(text);
  const from = new Date(now.getTime() - PAST_DAYS * DAY);
  const to = new Date(now.getTime() + FUTURE_DAYS * DAY);
  const out = [];
  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT' || !ev.start) continue;
    const start = new Date(ev.start);
    const end = ev.end ? new Date(ev.end) : new Date(start.getTime() + 60 * 60 * 1000);
    const duration = end - start;
    const allDay = ev.datetype === 'date';
    const base = {
      uid: ev.uid,
      title: String(ev.summary?.val ?? ev.summary ?? '(Không tên)'),
      allDay,
      note: [ev.location, ev.description].filter(Boolean).map(String).join('\n').slice(0, 1000),
    };
    const exdates = new Set(Object.values(ev.exdate || {}).map((d) => new Date(d).toISOString()));
    if (ev.rrule) {
      for (const occ of ev.rrule.between(from, to, true)) {
        if (exdates.has(occ.toISOString())) continue;
        // Lần lặp đã bị sửa riêng (RECURRENCE-ID) thì dùng bản sửa.
        const override = ev.recurrences && Object.values(ev.recurrences).find(
          (r) => r.recurrenceid && new Date(r.recurrenceid).getTime() === occ.getTime(),
        );
        if (override) {
          if (override.status === 'CANCELLED') continue;
          out.push({ ...base, title: String(override.summary || base.title),
            start: new Date(override.start).toISOString(), end: new Date(override.end || override.start).toISOString() });
        } else {
          out.push({ ...base, start: occ.toISOString(), end: new Date(occ.getTime() + duration).toISOString() });
        }
      }
    } else if (end >= from && start <= to && ev.status !== 'CANCELLED') {
      out.push({ ...base, start: start.toISOString(), end: end.toISOString() });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

// Bỏ thẻ HTML, giữ phần chữ để gửi cho AI.
export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// Bước 1 (chậm, không đụng dữ liệu): tải nguồn, đọc ICS hoặc nhờ Gemini đọc trang web.
export async function fetchSource(source, { fetchImpl = fetch } = {}) {
  try {
    const text = await fetchText(source.url, fetchImpl);
    if (source.type === 'ics') return { ok: true, events: parseIcsEvents(text) };
    const content = htmlToText(text);
    const hash = crypto.createHash('sha1').update(content).digest('hex');
    if (hash === source.lastHash) return { ok: true, unchanged: true };
    if (!geminiConfigured()) throw new Error('Nguồn trang web cần GEMINI_API_KEY để đọc nội dung');
    const items = await extractItems(`Nội dung trang ${source.url}:\n\n${content}`);
    return { ok: true, hash, items };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Bước 2 (nhanh): ghi kết quả vào store. Trả về tóm tắt cho giao diện.
export function applySource(store, sourceId, fetched) {
  const source = store.data.sources.find((s) => s.id === sourceId);
  if (!source) return { ok: false, error: 'Nguồn đã bị xoá' };
  source.lastSync = new Date().toISOString();
  source.lastError = fetched.ok ? null : fetched.error;
  if (!fetched.ok) return fetched;
  if (fetched.events) {
    store.replaceSourceEvents(source.id, fetched.events);
    return { ok: true, events: fetched.events.length };
  }
  if (fetched.unchanged) return { ok: true, unchanged: true, added: 0 };
  source.lastHash = fetched.hash;
  const added = store.addSuggestions(fetched.items, `web:${source.name || source.url}`);
  return { ok: true, added: added.length };
}

// Đồng bộ từng nguồn: tải xong mới mở dữ liệu mới nhất để ghi, tránh đè thay đổi khác.
// olderThanMs: chỉ đồng bộ nguồn đã lâu chưa cập nhật (dùng cho cron). ids: chỉ các nguồn này.
export async function syncSources(openStore, { olderThanMs = 0, ids = null, ...opts } = {}) {
  const snapshot = await openStore();
  const now = Date.now();
  const results = {};
  for (const s of snapshot.data.sources) {
    if (ids && !ids.includes(s.id)) continue;
    if (olderThanMs && s.lastSync && now - new Date(s.lastSync).getTime() < olderThanMs) continue;
    const fetched = await fetchSource(s, opts);
    const store = await openStore();
    results[s.id] = applySource(store, s.id, fetched);
    await store.save();
  }
  return results;
}
