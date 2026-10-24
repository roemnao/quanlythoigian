import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyAll, applyCommand, classify, googleEventId, toGoogleEvent } from '../public/app/sync.js';
import { TERMS_VERSION } from '../src/members.js';

const ev = { id: 'a1b2c3d4e5f6', title: 'Họp nhóm', start: '2026-10-30T02:00:00.000Z', end: null, allDay: false, note: 'Phòng 301',
  timeZone: 'Asia/Ho_Chi_Minh', from: { chat: 'Nhóm dự án', sender: 'Sếp' } };

// Google Lịch giả: ghi lại các lời gọi, trả mã theo kịch bản.
function fakeGoogle(script = {}) {
  const calls = [];
  const events = new Map();
  const fetch = async (url, opts) => {
    const method = opts.method;
    const id = decodeURIComponent(url.split('/events/')[1] || '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, id: id || body?.id, body, auth: opts.headers.Authorization });
    const forced = script[`${method} ${id || body?.id}`]?.shift?.();
    const reply = (status, data = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status });
    if (forced) return reply(forced.status, forced.data);
    if (method === 'POST') {
      if (events.has(body.id)) return reply(409, { error: { message: 'duplicate' } });
      events.set(body.id, body);
      return reply(200, { ...body, htmlLink: `https://calendar.google.com/e/${body.id}` });
    }
    if (method === 'PUT') {
      if (!events.has(id)) return reply(404, { error: { message: 'Not Found' } });
      events.set(id, { ...body, id });
      return reply(200, { ...body, id, htmlLink: `https://calendar.google.com/e/${id}` });
    }
    if (method === 'DELETE') {
      if (!events.delete(id)) return reply(410, { error: { message: 'Gone' } });
      return reply(204);
    }
    return reply(400);
  };
  return { fetch, calls, events };
}

test('ID cố định hợp lệ với Google (base32hex) và nội dung sự kiện', () => {
  const gid = googleEventId(ev.id);
  assert.match(gid, /^[a-v0-9]{5,1024}$/);
  assert.equal(gid, 'qltgma1b2c3d4e5f6');
  const body = toGoogleEvent(ev, { appUrl: 'https://web.example/app/' });
  assert.deepEqual(body.start, { dateTime: '2026-10-30T02:00:00.000Z', timeZone: 'Asia/Ho_Chi_Minh' });
  assert.equal(body.end.dateTime, '2026-10-30T03:00:00.000Z', 'không có giờ kết thúc thì mặc định 1 tiếng');
  assert.match(body.description, /Phòng 301\n\nGiao bởi Sếp trong nhóm Nhóm dự án · iforgotmywayhome/);
  assert.equal(body.extendedProperties.private.ifmwhId, ev.id);
  assert.equal(body.source.url, 'https://web.example/app/');
  // Cả ngày: ngày kết thúc của Google không tính, nên +1 ngày.
  const allDay = toGoogleEvent({ ...ev, allDay: true, start: '2026-11-02', end: '2026-11-03' });
  assert.deepEqual([allDay.start, allDay.end], [{ date: '2026-11-02' }, { date: '2026-11-04' }]);
  assert.deepEqual(toGoogleEvent({ ...ev, allDay: true, start: '2026-12-31', end: null }).end, { date: '2027-01-01' });
});

test('thêm / sửa / xoá; áp lại không tạo trùng; 409 → cập nhật, 404 khi sửa → tạo, 404/410 khi xoá → coi như xong', async () => {
  const g = fakeGoogle();
  const opts = { token: 'tok', fetch: g.fetch };
  const gid = googleEventId(ev.id);
  let r = await applyCommand({ seq: 1, op: 'create', event: ev }, opts);
  assert.equal(r.ok, true);
  assert.match(r.link, /calendar\.google\.com/);
  r = await applyCommand({ seq: 1, op: 'create', event: ev }, opts);
  assert.equal(r.ok, true);
  assert.deepEqual(g.calls.map((c) => c.method), ['POST', 'POST', 'PUT']);
  assert.equal(g.events.size, 1);
  assert.equal(g.calls[0].auth, 'Bearer tok');

  r = await applyCommand({ seq: 2, op: 'update', event: { ...ev, title: 'Họp nhóm (dời)' } }, opts);
  assert.equal(r.ok, true);
  assert.equal(g.events.get(gid).summary, 'Họp nhóm (dời)');
  // Sửa lịch chưa có trên Google (vd người dùng mới vào) → tạo mới.
  r = await applyCommand({ seq: 3, op: 'update', event: { ...ev, id: 'ffffffffffff' } }, opts);
  assert.equal(r.ok, true);
  assert.ok(g.events.has('qltgmffffffffffff'));

  assert.equal((await applyCommand({ seq: 4, op: 'delete', event: { id: ev.id } }, opts)).ok, true);
  assert.equal((await applyCommand({ seq: 4, op: 'delete', event: { id: ev.id } }, opts)).ok, true, 'xoá lần hai (410) vẫn xong');
  assert.ok(!g.events.has(gid));
});

test('phân loại lỗi và dừng đúng chỗ để giữ thứ tự', async () => {
  assert.equal(classify(401), 'auth');
  assert.equal(classify(403, 'insufficientPermissions'), 'auth');
  assert.equal(classify(403, 'rateLimitExceeded'), 'later');
  assert.equal(classify(503), 'later');
  assert.equal(classify(0), 'later');
  assert.equal(classify(400), 'skip');

  const cmds = [
    { seq: 7, op: 'create', event: { ...ev, id: '000000000007' } },
    { seq: 5, op: 'create', event: { ...ev, id: '000000000005' } },
    { seq: 6, op: 'create', event: { ...ev, id: '000000000006', title: '' } },
  ];
  // Lệnh 6 bị Google từ chối (400) → bỏ qua; lệnh 7 gặp token hết hạn → dừng, chưa tính là xong.
  const g = fakeGoogle({ 'POST qltgm000000000006': [{ status: 400, data: { error: { message: 'Missing summary' } } }],
    'POST qltgm000000000007': [{ status: 401, data: { error: { message: 'Invalid Credentials' } } }] });
  const seen = [];
  const r = await applyAll(cmds, { token: 't', fetch: g.fetch, onResult: (c, res) => seen.push([c.seq, res.ok]) });
  assert.equal(r.through, 6);
  assert.equal(r.stopped.kind, 'auth');
  assert.deepEqual(seen, [[5, true], [6, false]]);

  // Mất mạng → thử lại sau.
  const offline = await applyCommand(cmds[0], { token: 't', fetch: async () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual([offline.ok, offline.kind], [false, 'later']);
});

test('điều khoản và chính sách ghi đúng phiên bản đang yêu cầu đồng ý', () => {
  for (const page of ['terms.html', 'privacy.html']) {
    const html = fs.readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(html, new RegExp(`data-terms-version>${TERMS_VERSION}<`), page);
  }
});
