// Khung kiểm thử dùng chung: khởi động web với kho dữ liệu trong bộ nhớ, Google giả, và các hàm gọi API / đăng nhập.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const realFetch = globalThis.fetch;
const idToken = (claims) => `x.${Buffer.from(JSON.stringify({
  iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, exp: Date.now() / 1000 + 600, email_verified: true, ...claims,
})).toString('base64url')}.sig`;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

// Google giả: token (kịch bản chọn theo `code`), thu hồi, Google Lịch (có trạng thái, theo từng access token).
export function makeGoogle() {
  const g = {
    user: null, tokens: {}, calls: [], calendars: new Map(), failNext: 0, revoked: [], refreshFails: false, serverEvents: [],
    cal: (who = 'a') => { if (!g.calendars.has(who)) g.calendars.set(who, new Map()); return g.calendars.get(who); },
  };
  g.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(opts.body));
      if (body.get('grant_type') === 'refresh_token') {
        if (g.refreshFails) return json({ error: 'invalid_grant' }, 400);
        const who = g.tokens[body.get('refresh_token')] || 'a';
        return json({ access_token: `at-${who}`, expires_in: 3600 });
      }
      const code = body.get('code');
      const who = g.user.email;
      // Kịch bản: c = đủ quyền + refresh token; norefresh = đủ quyền, không refresh token; noscope = chỉ đăng nhập
      const scope = code === 'noscope' ? 'openid email profile' : `openid email profile ${CAL_SCOPE}`;
      const refresh = code === 'c' || code === 'consent' ? `rt-${who}` : undefined;
      if (refresh) g.tokens[refresh] = who;
      return json({ access_token: `at-${who}`, refresh_token: refresh, scope, id_token: idToken(g.user) });
    }
    if (u.startsWith('https://oauth2.googleapis.com/revoke')) { g.revoked.push(u); return json({}); }
    if (u.startsWith('https://www.googleapis.com/calendar/v3/calendars/')) {
      const who = String(opts.headers?.Authorization || '').replace('Bearer at-', '') || 'a';
      g.calls.push({ method: opts.method || 'GET', url: u, who });
      if (g.failNext > 0) { g.failNext--; return json({ error: { message: 'backend', errors: [{ reason: 'backendError' }] } }, 503); }
      const events = g.cal(who);
      const m = u.match(/\/events(?:\/([^?]+))?/);
      const id = m?.[1] && decodeURIComponent(m[1]);
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      if (method === 'GET') return json({ items: g.serverEvents });
      if (method === 'POST') {
        if (body.id && events.has(body.id)) return json({ error: { message: 'exists' } }, 409);
        const eid = body.id || `gid-${events.size + 1}`;
        events.set(eid, body);
        return json({ id: eid, htmlLink: `https://calendar.google.com/${eid}` });
      }
      if (method === 'PUT' || method === 'PATCH') {
        if (!events.has(id)) return json({ error: { message: 'nf' } }, 404);
        events.set(id, body);
        return json({ id, htmlLink: `https://calendar.google.com/${id}` });
      }
      if (method === 'DELETE') {
        if (!events.has(id)) return json({ error: { message: 'gone' } }, 410);
        events.delete(id);
        return new Response(null, { status: 204 });
      }
    }
    return realFetch(url, opts);
  };
  return g;
}

export async function boot(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qltg-t-'));
  Object.assign(process.env, {
    DATA_FILE: path.join(dir, 'db.json'), GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret-xyz',
    OWNER_EMAILS: 'owner@gmail.com', ...env,
  });
  for (const k of ['APP_PASSWORD', 'PRIMARY_HOST', 'APP_HOST', 'CRON_SECRET', 'VERCEL']) if (!(k in env)) delete process.env[k];
  const google = makeGoogle();
  globalThis.fetch = google.fetch;
  const { default: app } = await import('../src/app.js');
  const members = await import('../src/members.js');
  const { kv } = await import('../src/kv.js');
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;

  async function call(method, url, body, { cookie, token, host } = {}) {
    const res = await realFetch(base + url, {
      method, redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        ...(host ? { 'X-Forwarded-Host': host } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body && !['GET', 'HEAD'].includes(method) ? JSON.stringify(body) : undefined,
    });
    const cookies = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* HTML / CSV */ }
    return { status: res.status, location: res.headers.get('location'), cookies, data, headers: res.headers };
  }

  // Đăng nhập Gmail như trình duyệt: /start → Google → /callback (theo các lần chuyển hướng nội bộ). code: c | norefresh | noscope.
  async function signIn(user, { terms = members.TERMS_VERSION, code = 'c', cookie = '', host } = {}) {
    google.user = user;
    let jar = cookie ? [cookie] : [];
    let start = await call('GET', `/api/google/start?purpose=member${terms ? `&terms=${terms}` : ''}`, null, { cookie: jar.join('; '), host });
    let memberCookie; let newFlag;
    for (let hop = 0; hop < 3; hop++) {
      assert.equal(start.status, 302);
      const to = new URL(start.location, 'http://localhost');
      assert.equal(to.host, 'accounts.google.com');
      const oauthCookie = start.cookies.find((c) => c.startsWith('qltg_oauth='));
      const termsCookie = start.cookies.find((c) => c.startsWith('qltg_terms='));
      newFlag = start.cookies.find((c) => c.startsWith('qltg_new=')) || newFlag;
      const purpose = to.searchParams.get('state').split('.')[0];
      const cb = await call('GET', `/api/google/callback?code=${purpose === 'member-consent' ? 'consent' : code}&state=${to.searchParams.get('state')}`, null,
        { cookie: [oauthCookie, termsCookie, newFlag, ...jar].filter(Boolean).join('; '), host });
      memberCookie = cb.cookies.find((c) => c.startsWith('qltg_member=')) || memberCookie;
      if (memberCookie) jar = [memberCookie];
      newFlag = cb.cookies.find((c) => c.startsWith('qltg_new=')) || newFlag;
      if (cb.location?.startsWith('/api/google/start')) { start = await call('GET', cb.location, null, { cookie: jar.join('; '), host }); continue; }
      return { location: cb.location, cookie: memberCookie, to };
    }
    throw new Error('Chuyển hướng Google quá nhiều lần');
  }

  return { app, call, signIn, google, kv, members, server, base, close: () => { server.close(); globalThis.fetch = realFetch; } };
}

export const errorOf = (location) => new URL(location, 'http://x').searchParams.get('google_error') || '';
export const OWNER = { sub: 'g-owner', email: 'owner@gmail.com', name: 'Chủ web' };
