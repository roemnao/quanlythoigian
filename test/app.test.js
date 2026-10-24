import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { normalize, extractItems } from '../src/gemini.js';
import { parseIcsEvents, htmlToText } from '../src/sources.js';
import { handleText } from '../src/zalo.js';
import { dueReminders } from '../src/cron.js';

test('đề xuất trùng bị bỏ qua, duyệt chuyển thành lịch/việc', () => {
  const s = new Store(null, { persist: false });
  const a = s.addSuggestions([
    { kind: 'event', title: 'Họp nhóm', start: '2026-10-30T07:00:00.000Z' },
    { kind: 'event', title: ' họp  NHÓM ', start: '2026-10-30T07:00:00.000Z' },
    { kind: 'task', title: 'Nộp báo cáo', deadline: '2026-10-31T10:00:00.000Z', quadrant: 1 },
  ], 'test');
  assert.equal(a.length, 2);
  s.approveSuggestion(a[0].id);
  s.approveSuggestion(a[1].id);
  assert.equal(s.data.events.length, 1);
  assert.equal(s.data.tasks[0].quadrant, 1);
  assert.equal(s.addSuggestions([{ kind: 'event', title: 'Họp nhóm', start: '2026-10-30T07:00:00Z' }], 't').length, 0);
});

test('normalize: sự kiện thiếu giờ thành việc, ngày sai bị bỏ', () => {
  const r = normalize({ items: [{ kind: 'event', title: 'A', start: 'không rõ' }, { kind: 'task', title: '' }] });
  assert.deepEqual(r.map((x) => x.kind), ['task']);
  assert.equal(r[0].start, null);
});

test('extractItems gọi Gemini và đọc JSON trả về', async () => {
  process.env.GEMINI_API_KEY = 'k';
  let called;
  const fetchImpl = async (url, opts) => {
    called = { url, opts };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [
      { kind: 'event', title: 'Khám răng', start: '2026-10-28T09:00:00+07:00', quadrant: 2 }] }) }] } }] }) };
  };
  const items = await extractItems('Thứ 4 9h khám răng', { fetchImpl });
  assert.match(called.url, /:generateContent$/);
  assert.equal(called.opts.headers['x-goog-api-key'], 'k');
  assert.equal(items[0].start, '2026-10-28T02:00:00.000Z');
  delete process.env.GEMINI_API_KEY;
});

test('parseIcsEvents đọc sự kiện đơn và lặp lại', () => {
  const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:1
DTSTART:20261026T020000Z
DTEND:20261026T030000Z
SUMMARY:Toán
RRULE:FREQ=WEEKLY;COUNT=3
END:VEVENT
BEGIN:VEVENT
UID:2
DTSTART:20261027T080000Z
DTEND:20261027T090000Z
SUMMARY:Gặp khách
LOCATION:Quận 1
END:VEVENT
END:VCALENDAR`;
  const ev = parseIcsEvents(ics, new Date('2026-10-24T00:00:00Z'));
  assert.equal(ev.filter((e) => e.title === 'Toán').length, 3);
  assert.equal(ev.find((e) => e.title === 'Gặp khách').note, 'Quận 1');
  assert.equal(ev[1].start, '2026-10-27T08:00:00.000Z');
  // Đồng bộ lại cho cùng ID → không bị nhắc lại hay nhân đôi.
  const s = new Store(null, { persist: false });
  s.replaceSourceEvents('src1', ev);
  const ids = s.data.events.map((e) => e.id);
  s.replaceSourceEvents('src1', parseIcsEvents(ics, new Date('2026-10-24T00:00:00Z')));
  assert.deepEqual(s.data.events.map((e) => e.id), ids);
  assert.equal(new Set(ids).size, 4);
});

test('htmlToText bỏ thẻ và script', () => {
  assert.equal(htmlToText('<p>Họp&nbsp;lúc 9h</p><script>x()</script><b>T5</b>'), 'Họp lúc 9h\n T5');
});

test('bot Zalo: ghép nối bằng mã, người lạ bị chặn', async () => {
  const s = new Store(null, { persist: false });
  assert.match(await handleText(s, 'abc', '/homnay'), /bot riêng/);
  s.data.meta.pairCode = '123456';
  s.data.meta.pairExpires = new Date(Date.now() + 60000).toISOString();
  assert.match(await handleText(s, 'abc', '/ketnoi 000000'), /không đúng/);
  assert.match(await handleText(s, 'abc', '/ketnoi 123456'), /Đã kết nối/);
  assert.equal(s.data.meta.zaloChatId, 'abc');
  assert.equal(s.data.meta.pairCode, null);
  assert.match(await handleText(s, 'xyz', '/viec'), /bot riêng/);
  s.data.meta.pairCode = '222222';
  s.data.meta.pairExpires = new Date(Date.now() - 1000).toISOString();
  assert.match(await handleText(s, 'xyz', '/ketnoi 222222'), /hết hạn/);
});

test('bot Zalo: lệnh /id, /cho, /duyet', async () => {
  const s = new Store(null, { persist: false });
  s.data.meta.zaloChatId = 'abc';
  assert.match(await handleText(s, 'abc', '/id'), /abc/);
  s.addSuggestions([{ kind: 'task', title: 'Gọi điện' }], 'zalo');
  assert.match(await handleText(s, 'abc', '/cho'), /1\. ✅ Gọi điện/);
  assert.match(await handleText(s, 'abc', '/duyet all'), /Đã duyệt 1/);
  assert.equal(s.data.tasks.length, 1);
  assert.match(await handleText(s, 'abc', '/linh tinh'), /Không hiểu lệnh/);
});

test('nhắc việc chỉ gửi một lần trong khoảng trước sự kiện', () => {
  const s = new Store(null, { persist: false });
  const now = new Date('2026-10-24T08:00:00Z');
  s.data.events.push({ id: 'e1', title: 'Họp', start: '2026-10-24T08:10:00Z' },
    { id: 'e2', title: 'Xa', start: '2026-10-24T10:00:00Z' });
  assert.deepEqual(dueReminders(s, now, 15).map((e) => e.id), ['e1']);
  assert.equal(dueReminders(s, now, 15).length, 0);
});
