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

export async function syncSource(store, source, { fetchImpl = fetch } = {}) {
  try {
    const text = await fetchText(source.url, fetchImpl);
    let result;
    if (source.type === 'ics') {
      const events = parseIcsEvents(text);
      store.replaceSourceEvents(source.id, events);
      result = { events: events.length };
    } else {
      const content = htmlToText(text);
      const hash = crypto.createHash('sha1').update(content).digest('hex');
      if (hash === source.lastHash) {
        result = { unchanged: true, added: 0 };
      } else {
        if (!geminiConfigured()) throw new Error('Nguồn trang web cần GEMINI_API_KEY để đọc nội dung');
        const items = await extractItems(`Nội dung trang ${source.url}:\n\n${content}`);
        const added = store.addSuggestions(items, `web:${source.name || source.url}`);
        source.lastHash = hash;
        result = { added: added.length };
      }
    }
    source.lastSync = new Date().toISOString();
    source.lastError = null;
    store.save();
    return { ok: true, ...result };
  } catch (err) {
    source.lastSync = new Date().toISOString();
    source.lastError = err.message;
    store.save();
    return { ok: false, error: err.message };
  }
}

export async function syncAll(store, opts) {
  const results = {};
  for (const s of store.data.sources) results[s.id] = await syncSource(store, s, opts);
  return results;
}
