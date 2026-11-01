import test from 'node:test';
import assert from 'node:assert/strict';
process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'secret-xyz';
const { fromGoogle, toGoogle, authUrl, CALENDAR_EVENTS_SCOPE } = await import('../src/google.js');

test('chuyển đổi sự kiện Google ⇄ web', () => {
  const allDay = fromGoogle({ id: 'a', summary: 'Nghỉ lễ', start: { date: '2026-10-28' }, end: { date: '2026-10-29' } });
  assert.equal(allDay.start, '2026-10-27T17:00:00.000Z'); // 00:00 giờ Việt Nam
  assert.equal(allDay.allDay, true);
  assert.equal(fromGoogle({ id: 'b', status: 'cancelled', start: { dateTime: '2026-10-28T09:00:00+07:00' } }), null);
  assert.equal(fromGoogle({ id: 'c', start: { dateTime: 'x' }, extendedProperties: { private: { qltgId: 'e1' } } }), null);
  assert.equal(fromGoogle({ id: 'd', summary: 'Được giao', start: { dateTime: '2026-10-28T09:00:00+07:00' }, extendedProperties: { private: { ifmwhId: 'x' } } }).assigned, true);
  const body = toGoogle({ id: 'e1', title: 'Họp', start: '2026-10-28T02:00:00.000Z', end: null, note: 'P301' });
  assert.equal(body.end.dateTime, '2026-10-28T03:00:00.000Z');
  assert.equal(body.extendedProperties.private.qltgId, 'e1');
  assert.deepEqual(toGoogle({ id: 'e2', title: 'Sinh nhật', start: '2026-10-27T17:00:00.000Z', allDay: true }).start, { date: '2026-10-28' });
});

test('đăng nhập thành viên xin luôn quyền Google Lịch, offline, trong một màn hình', () => {
  const q = (purpose, extra = {}) => new URL(authUrl({ redirectUri: 'https://x/cb', state: `${purpose}.n`, purpose, ...extra })).searchParams;
  const m = q('member');
  assert.equal(m.get('scope'), `openid email profile ${CALENDAR_EVENTS_SCOPE}`);
  assert.equal(m.get('access_type'), 'offline');
  assert.equal(m.get('include_granted_scopes'), 'true');
  assert.equal(m.get('prompt'), 'select_account');
  const consent = q('member-consent', { loginHint: 'a@gmail.com' });
  assert.equal(consent.get('prompt'), 'consent');
  assert.equal(consent.get('login_hint'), 'a@gmail.com');
  const add = q('calendar-member');
  assert.equal(add.get('scope'), `openid email ${CALENDAR_EVENTS_SCOPE}`);
  assert.equal(add.get('prompt'), 'consent');
});
