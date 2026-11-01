// Áp lệnh lịch (thêm / sửa / xoá) vào Google Lịch của người dùng, ngay trong trình duyệt.
// Không phụ thuộc giao diện: nhận token và hàm fetch từ ngoài, nên chạy được cả trong kiểm thử Node.
const CAL = 'https://www.googleapis.com/calendar/v3/calendars';

// ID cố định trên Google cho mỗi lịch được giao (chữ a–v và số), nên áp lại một lệnh không tạo trùng.
export const googleEventId = (eventId) => `qltgm${String(eventId).toLowerCase()}`;

const nextDay = (key) => new Date(Date.parse(`${key}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

// Nội dung sự kiện gửi lên Google từ lệnh của bot lịch.
export function toGoogleEvent(ev, { appUrl } = {}) {
  const from = [ev.from?.sender && `Giao bởi ${ev.from.sender}`, ev.from?.chat && `trong nhóm ${ev.from.chat}`].filter(Boolean).join(' ');
  const body = {
    summary: ev.title,
    description: [ev.note, `${from ? `${from} · ` : ''}iforgotmywayhome`].filter(Boolean).join('\n\n'),
    status: 'confirmed',
    extendedProperties: { private: { ifmwhId: ev.id } },
    reminders: { useDefault: true },
  };
  if (appUrl && /^https?:\/\//.test(appUrl)) body.source = { title: 'iforgotmywayhome', url: appUrl };
  if (ev.allDay) {
    body.start = { date: ev.start };
    body.end = { date: nextDay(ev.end || ev.start) }; // Google tính ngày kết thúc không bao gồm
  } else {
    const end = ev.end || new Date(Date.parse(ev.start) + 3600e3).toISOString();
    body.start = { dateTime: ev.start, timeZone: ev.timeZone };
    body.end = { dateTime: end, timeZone: ev.timeZone };
  }
  return body;
}

// Loại lỗi: auth = cần xin lại quyền (token hết hạn / thiếu quyền), later = thử lại sau (mạng, quá tải),
// skip = lệnh này không áp được (bỏ qua, ghi lỗi vào lịch sử).
export function classify(status, reason = '') {
  if (status === 401) return 'auth';
  if (status === 403) return /rate|quota|limit/i.test(reason) ? 'later' : 'auth';
  if (status === 429 || status >= 500 || status === 0) return 'later';
  return 'skip';
}

const success = (status) => status >= 200 && status < 300;

async function call(fetchImpl, token, method, url, body) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return { status: 0, error: err.message || 'Mất mạng' };
  }
  if (res.status === 204) return { status: 204 };
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, error: data?.error?.message, reason: data?.error?.errors?.[0]?.reason || '' };
}

// Áp một lệnh. Trả về { ok, link? } hoặc { ok: false, kind, status, error }.
export async function applyCommand(cmd, { token, fetch: fetchImpl = globalThis.fetch, calendarId = 'primary', appUrl } = {}) {
  const gid = googleEventId(cmd.event.id);
  const base = `${CAL}/${encodeURIComponent(calendarId)}/events`;
  const one = `${base}/${encodeURIComponent(gid)}`;
  const done = (r) => ({ ok: true, link: r.data?.htmlLink || null, status: r.status });
  const failed = (r) => ({ ok: false, kind: classify(r.status, r.reason), status: r.status, error: r.error || `Google Lịch trả lỗi ${r.status}` });

  if (cmd.op === 'delete') {
    const r = await call(fetchImpl, token, 'DELETE', one);
    // Đã xoá sẵn (người dùng tự xoá, hoặc lệnh xoá chạy lần hai) cũng coi là xong.
    return success(r.status) || r.status === 404 || r.status === 410 ? { ok: true, status: r.status } : failed(r);
  }
  const body = toGoogleEvent(cmd.event, { appUrl });
  if (cmd.op === 'create') {
    let r = await call(fetchImpl, token, 'POST', base, { id: gid, ...body });
    if (r.status === 409) r = await call(fetchImpl, token, 'PUT', one, body); // đã có (áp lại lần hai)
    return success(r.status) ? done(r) : failed(r);
  }
  if (cmd.op === 'update') {
    let r = await call(fetchImpl, token, 'PUT', one, body);
    if (r.status === 404) r = await call(fetchImpl, token, 'POST', base, { id: gid, ...body }); // chưa từng có trên lịch này
    return success(r.status) ? done(r) : failed(r);
  }
  return { ok: false, kind: 'skip', status: 0, error: `Lệnh không rõ: ${cmd.op}` };
}

// Áp lần lượt theo số thứ tự. Dừng ở lỗi cần xin quyền / thử lại sau (để giữ đúng thứ tự thêm → sửa → xoá).
// onResult(cmd, result) được gọi sau mỗi lệnh (kể cả lệnh bị bỏ qua).
export async function applyAll(commands, opts = {}) {
  const sorted = [...commands].sort((a, b) => a.seq - b.seq);
  let through = null;
  for (const cmd of sorted) {
    const result = await applyCommand(cmd, opts);
    if (!result.ok && result.kind !== 'skip') return { through, stopped: result };
    through = cmd.seq;
    await opts.onResult?.(cmd, result);
  }
  return { through, stopped: null };
}
