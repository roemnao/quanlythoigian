// Việc chạy định kỳ: đồng bộ nguồn, nhắc sự kiện sắp tới, tóm tắt buổi sáng qua Zalo.
// Trên Vercel được gọi qua /api/cron (Vercel Cron hoặc cron-job.org); trên máy thì chạy bằng setInterval.
import { Store } from './db.js';
import { syncSources } from './sources.js';
import { dayAgenda, ownerChatId, sendMessage, zaloConfigured } from './zalo.js';
import { dayKey, fmtTime, hourOf } from './time.js';

const MIN = 60 * 1000;

// Trả về các sự kiện cần nhắc ngay bây giờ (và đánh dấu đã nhắc).
export function dueReminders(store, now = new Date(), beforeMinutes = 15) {
  const reminded = store.data.meta.reminded;
  const due = [];
  for (const e of store.data.events) {
    if (e.allDay) continue;
    const start = new Date(e.start).getTime();
    const key = `${e.title}@${e.start}`;
    if (reminded[key]) continue;
    if (start > now.getTime() && start - now.getTime() <= beforeMinutes * MIN) {
      reminded[key] = now.toISOString();
      due.push(e);
    }
  }
  // Dọn các mốc nhắc cũ hơn 2 ngày.
  for (const [k, at] of Object.entries(reminded)) {
    if (now - new Date(at) > 2 * 24 * 60 * MIN) delete reminded[k];
  }
  return due;
}

function settings() {
  const summary = process.env.DAILY_SUMMARY_HOUR;
  return {
    syncEvery: Math.max(5, Number(process.env.SYNC_INTERVAL_MINUTES) || 30) * MIN,
    before: Number(process.env.REMIND_BEFORE_MINUTES) || 15,
    summaryHour: summary === '' ? null : Number(summary ?? 7),
  };
}

export async function runCron({ now = new Date(), forceSync = false } = {}) {
  const { syncEvery, before, summaryHour } = settings();
  const report = { synced: 0, reminders: 0, summary: false };

  const results = await syncSources(Store.open, { olderThanMs: forceSync ? 0 : syncEvery - MIN });
  report.synced = Object.keys(results).length;
  report.syncErrors = Object.values(results).filter((r) => !r.ok).map((r) => r.error);

  const store = await Store.open();
  const chatId = ownerChatId(store);
  if (!zaloConfigured() || !chatId) return report;

  const due = dueReminders(store, now, before);
  const today = dayKey(now);
  const sendSummary = summaryHour !== null && hourOf(now) >= summaryHour && store.data.meta.lastSummaryDate !== today;
  if (sendSummary) store.data.meta.lastSummaryDate = today;
  // Lưu dấu "đã nhắc" trước khi gửi để hai lần cron chồng nhau không gửi trùng.
  await store.save();

  for (const e of due) {
    await sendMessage(chatId, `⏰ Sắp tới (${fmtTime(e.start)}): ${e.title}${e.note ? `\n${e.note.slice(0, 300)}` : ''}`);
    report.reminders++;
  }
  if (sendSummary) {
    const pending = store.data.suggestions.length;
    await sendMessage(chatId, `☀️ Chào buổi sáng! Hôm nay ${today}:\n${dayAgenda(store, now)}${
      pending ? `\n\n📥 Có ${pending} đề xuất chờ duyệt (gõ /cho).` : ''}`);
    report.summary = true;
  }
  return report;
}

// Chạy trên máy cá nhân: mỗi phút một lần.
export function startLocalCron(log = console) {
  const tick = () => runCron().then((r) => {
    if (r.syncErrors?.length) log.warn('[cron] lỗi đồng bộ:', r.syncErrors.join('; '));
  }).catch((err) => log.warn('[cron]', err.message));
  setTimeout(tick, 5000);
  const t = setInterval(tick, MIN);
  return () => clearInterval(t);
}
