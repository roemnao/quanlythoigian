// Các việc chạy định kỳ: đồng bộ nguồn, nhắc sự kiện sắp tới, tóm tắt buổi sáng qua Zalo.
import { syncAll } from './sources.js';
import { dayAgenda, sendMessage, zaloConfigured } from './zalo.js';
import { dayKey, fmtTime, hourOf } from './time.js';

const MIN = 60 * 1000;

// Trả về các sự kiện cần nhắc ngay bây giờ (và đánh dấu đã nhắc).
export function dueReminders(store, now = new Date(), beforeMinutes = 15) {
  const reminded = store.data.meta.reminded;
  const due = [];
  for (const e of store.data.events) {
    if (e.allDay) continue;
    const start = new Date(e.start).getTime();
    const key = `${e.id}@${e.start}`;
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
  if (due.length) store.save();
  return due;
}

export function startScheduler(store, log = console) {
  const syncEvery = Math.max(5, Number(process.env.SYNC_INTERVAL_MINUTES) || 30) * MIN;
  const before = Number(process.env.REMIND_BEFORE_MINUTES) || 15;
  const summaryHour = process.env.DAILY_SUMMARY_HOUR === '' ? null : Number(process.env.DAILY_SUMMARY_HOUR ?? 7);

  const runSync = async () => {
    if (!store.data.sources.length) return;
    const res = await syncAll(store);
    const failed = Object.values(res).filter((r) => !r.ok);
    if (failed.length) log.warn('[sync] lỗi:', failed.map((f) => f.error).join('; '));
  };

  const tick = async () => {
    const chatId = process.env.ZALO_CHAT_ID;
    if (!zaloConfigured() || !chatId) return;
    const now = new Date();
    try {
      for (const e of dueReminders(store, now, before)) {
        await sendMessage(chatId, `⏰ Sắp tới (${fmtTime(e.start)}): ${e.title}${e.note ? `\n${e.note.slice(0, 300)}` : ''}`);
      }
      const today = dayKey(now);
      if (summaryHour !== null && hourOf(now) >= summaryHour && store.data.meta.lastSummaryDate !== today) {
        store.data.meta.lastSummaryDate = today;
        store.save();
        const pending = store.data.suggestions.length;
        await sendMessage(chatId, `☀️ Chào buổi sáng! Hôm nay ${today}:\n${dayAgenda(store, now)}${
          pending ? `\n\n📥 Có ${pending} đề xuất chờ duyệt (gõ /cho).` : ''}`);
      }
    } catch (err) {
      log.warn('[zalo] gửi nhắc lỗi:', err.message);
    }
  };

  setTimeout(runSync, 5000);
  const t1 = setInterval(runSync, syncEvery);
  const t2 = setInterval(tick, MIN);
  return () => { clearInterval(t1); clearInterval(t2); };
}
