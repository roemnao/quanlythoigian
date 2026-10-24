// Zalo Bot: nhận tin nhắn (webhook hoặc polling), trả lời lệnh, gửi nhắc việc.
// Tài liệu: https://bot.zapps.me/docs — API dạng https://bot-api.zapps.me/bot<TOKEN>/<method>
import { extractItems, geminiConfigured } from './gemini.js';
import { dayKey, fmtDateTime, fmtTime } from './time.js';

const MAX_LEN = 1900; // Zalo giới hạn độ dài tin nhắn, chia nhỏ cho an toàn.

export function zaloConfigured() {
  return Boolean(process.env.ZALO_BOT_TOKEN);
}

async function call(method, body, fetchImpl = fetch) {
  const base = (process.env.ZALO_API_BASE || 'https://bot-api.zapps.me').replace(/\/$/, '');
  const res = await fetchImpl(`${base}/bot${process.env.ZALO_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Zalo ${method} lỗi: ${data.description || data.message || res.status}`);
  }
  return data.result;
}

export async function sendMessage(chatId, text, fetchImpl) {
  if (!zaloConfigured() || !chatId) return;
  for (let i = 0; i < text.length; i += MAX_LEN) {
    await call('sendMessage', { chat_id: chatId, text: text.slice(i, i + MAX_LEN) }, fetchImpl);
  }
}

export const getMe = () => call('getMe');
export const setWebhook = (url) => call('setWebhook', { url, secret_token: process.env.ZALO_WEBHOOK_SECRET });
export const deleteWebhook = () => call('deleteWebhook');

const HELP = `🤖 Bot quản lý thời gian
• Gửi bất kỳ nội dung nào (email, tin nhắn, thông báo...) → mình trích lịch và đưa vào hàng chờ.
/homnay – lịch và việc hôm nay
/mai – lịch ngày mai
/viec – việc chưa xong quan trọng
/cho – các đề xuất đang chờ duyệt
/duyet <số|all> – duyệt đề xuất (vd: /duyet 1 hoặc /duyet all)
/bo <số> – bỏ đề xuất
/id – xem ID cuộc trò chuyện (điền vào ZALO_CHAT_ID)`;

function eventsOn(store, key) {
  return store.data.events
    .filter((e) => dayKey(e.start) === key)
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function dayAgenda(store, date = new Date()) {
  const key = dayKey(date);
  const lines = [];
  const events = eventsOn(store, key);
  lines.push(events.length ? '📅 Lịch:' : '📅 Không có lịch.');
  for (const e of events) lines.push(`• ${e.allDay ? 'Cả ngày' : fmtTime(e.start)} ${e.title}`);
  const due = store.data.tasks.filter((t) => !t.done && t.deadline && dayKey(t.deadline) <= key);
  if (due.length) {
    lines.push('⏰ Việc đến hạn:');
    for (const t of due) lines.push(`• ${t.title} (hạn ${fmtDateTime(t.deadline)})`);
  }
  const goals = (store.data.goals[key] || []).filter(Boolean);
  if (goals.length) {
    lines.push('🎯 Mục tiêu:');
    goals.forEach((g, i) => lines.push(`${i + 1}. ${g}`));
  }
  return lines.join('\n');
}

function describeSuggestion(s, i) {
  const when = s.kind === 'event' ? fmtDateTime(s.start) : s.deadline ? `hạn ${fmtDateTime(s.deadline)}` : 'không hạn';
  return `${i + 1}. ${s.kind === 'event' ? '📅' : '✅'} ${s.title} – ${when}`;
}

// Xử lý một tin nhắn, trả về câu trả lời (chuỗi).
export async function handleText(store, chatId, text) {
  const t = (text || '').trim();
  const [cmd, arg] = t.split(/\s+/, 2);
  const lower = (cmd || '').toLowerCase();
  if (!t || lower === '/start' || lower === '/trogiup' || lower === '/help') return HELP;
  if (lower === '/id') return `ID cuộc trò chuyện: ${chatId}\nĐiền vào ZALO_CHAT_ID trong .env để nhận nhắc việc.`;
  if (lower === '/homnay') return `Hôm nay (${dayKey()}):\n${dayAgenda(store)}`;
  if (lower === '/mai') {
    const d = new Date(Date.now() + 24 * 3600 * 1000);
    return `Ngày mai (${dayKey(d)}):\n${dayAgenda(store, d)}`;
  }
  if (lower === '/viec') {
    const open = store.data.tasks.filter((x) => !x.done).sort((a, b) => a.quadrant - b.quadrant).slice(0, 15);
    if (!open.length) return '🎉 Không còn việc nào chưa xong.';
    return open.map((x) => `• [Ô${x.quadrant}] ${x.title}${x.deadline ? ` (hạn ${fmtDateTime(x.deadline)})` : ''}`).join('\n');
  }
  const pending = store.data.suggestions;
  if (lower === '/cho') {
    if (!pending.length) return 'Không có đề xuất nào đang chờ.';
    return `Đang chờ duyệt:\n${pending.map(describeSuggestion).join('\n')}\nGõ /duyet <số> hoặc /duyet all`;
  }
  if (lower === '/duyet' || lower === '/bo') {
    const targets = arg === 'all' ? [...pending] : [pending[Number(arg) - 1]].filter(Boolean);
    if (!targets.length) return 'Không tìm thấy đề xuất. Gõ /cho để xem danh sách.';
    for (const s of targets) {
      if (lower === '/duyet') store.approveSuggestion(s.id); else store.rejectSuggestion(s.id);
    }
    return `${lower === '/duyet' ? '✅ Đã duyệt' : '🗑️ Đã bỏ'} ${targets.length} mục.`;
  }
  if (t.startsWith('/')) return `Không hiểu lệnh ${cmd}.\n\n${HELP}`;

  if (!geminiConfigured()) return 'Chưa cấu hình GEMINI_API_KEY nên mình chưa đọc được nội dung này.';
  const items = await extractItems(t);
  const added = store.addSuggestions(items, 'zalo');
  if (!items.length) return 'Mình không thấy lịch hẹn hay việc cần làm nào trong tin nhắn này.';
  if (!added.length) return 'Các mục này đã có trong lịch hoặc hàng chờ rồi.';
  const all = store.data.suggestions;
  const lines = added.map((s) => describeSuggestion(s, all.indexOf(s)));
  return `Mình tìm thấy ${added.length} mục, đã đưa vào hàng chờ:\n${lines.join('\n')}\nGõ /duyet all để duyệt hết, hoặc duyệt trên web.`;
}

// Một "update" từ Zalo (webhook gửi { ok, result } hoặc trực tiếp result).
export async function handleUpdate(store, update) {
  const u = update?.result ?? update;
  const msg = u?.message;
  const chatId = msg?.chat?.id;
  if (!chatId) return;
  if (u.event_name && u.event_name !== 'message.text.received') {
    await sendMessage(chatId, 'Hiện mình chỉ đọc được tin nhắn chữ. Bạn dán nội dung dạng chữ giúp mình nhé.');
    return;
  }
  let reply;
  try {
    reply = await handleText(store, chatId, msg.text);
  } catch (err) {
    reply = `⚠️ Lỗi: ${err.message}`;
  }
  await sendMessage(chatId, reply);
}

// Chế độ polling: liên tục hỏi Zalo tin nhắn mới (dùng khi không có URL https công khai).
export function startPolling(store, log = console) {
  let stopped = false;
  (async () => {
    try { await deleteWebhook(); } catch { /* chưa đặt webhook thì bỏ qua */ }
    while (!stopped) {
      try {
        const result = await call('getUpdates', { timeout: 30 });
        const updates = Array.isArray(result) ? result : result ? [result] : [];
        for (const up of updates) await handleUpdate(store, up);
      } catch (err) {
        // Hết thời gian chờ mà không có tin nhắn cũng có thể trả lỗi; đợi chút rồi thử lại.
        if (!/timeout|408/i.test(err.message)) log.warn('[zalo] polling:', err.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();
  return () => { stopped = true; };
}
