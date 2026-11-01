// Google Lịch phía máy chủ: ghi lịch được giao (thêm / sửa / xoá) vào Google Lịch của từng người ngay khi bot giao,
// không cần người dùng mở web. Lỗi tạm thời (mạng, Google quá tải) được đánh dấu để cron chạy lại.
import { waitUntil } from '@vercel/functions';
import { kv } from './kv.js';
import { applyAll } from './calsync.js';
import { accessTokenFor, forgetAccessToken, revokeAndDelete, saveRefreshToken } from './gtoken.js';
import { commandsAfter, getMember, publicMember, setGoogleStatus } from './members.js';
import { recordFetched } from './calbot-log.js';
import { syncGoogle } from './google.js';
import { syncSources } from './sources.js';
import { openUser, UserStore } from './userstore.js';

const DAY = 24 * 3600;
const HISTORY_MAX = 200;
const K = { applied: (id) => `gapplied:${id}`, hist: (id) => `ghist:${id}`, lock: (id) => `drain:${id}`, pending: 'gpending' };

export function appBaseUrl() {
  const host = String(process.env.PRIMARY_HOST || process.env.APP_HOST || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  return host ? `https://${host}/` : null;
}

async function remember(id, entries) {
  if (!entries.length) return;
  await kv.rpush(K.hist(id), ...entries);
  await kv.ltrim(K.hist(id), -HISTORY_MAX, -1);
  await kv.expire(K.hist(id), 90 * DAY);
}

export async function readHistory(id) {
  return (await kv.lrange(K.hist(id), 0, -1)).reverse();
}

// Ghi các lệnh chưa áp của một người vào Google Lịch của họ. An toàn khi chạy lặp (ID sự kiện cố định).
export async function drainMember(id, { fetchImpl = globalThis.fetch } = {}) {
  if (!(await kv.set(K.lock(id), 1, { ex: 60, nx: true }))) return { skipped: 'busy' };
  try {
    const user = await getMember(id);
    if (!user || user.gstatus !== 'connected') return { skipped: 'not-connected' };
    if (publicMember(user).needsTerms) return { skipped: 'terms' };
    const applied = Number(await kv.get(K.applied(id))) || 0;
    const r = await commandsAfter(id, applied);
    if (!r || !r.commands.length) { await kv.hdel(K.pending, id); return { applied: 0 }; }

    const entries = [];
    const run = async (token) => applyAll(r.commands, {
      token, fetch: fetchImpl, appUrl: appBaseUrl(),
      onResult: async (cmd, result) => {
        await kv.set(K.applied(id), cmd.seq);
        r.commands = r.commands.filter((c) => c.seq !== cmd.seq);
        entries.push({
          seq: cmd.seq, op: cmd.op, title: cmd.event.title, start: cmd.event.start, end: cmd.event.end, allDay: cmd.event.allDay,
          from: cmd.event.from || null, at: new Date().toISOString(), ok: result.ok, error: result.ok ? null : result.error, link: result.link || null,
        });
        if (cmd.logId) await recordFetched(id, [cmd.logId]);
      },
    });

    let token;
    try {
      token = await accessTokenFor(id);
    } catch (err) {
      if (err.reconnect) await setGoogleStatus(id, { status: 'reconnect', lastError: err.message });
      else await kv.hset(K.pending, id, Date.now());
      return { error: err.message };
    }
    let out = await run(token);
    if (out.stopped?.kind === 'auth') { // access token hỏng sớm: đổi token mới thử lại một lần
      forgetAccessToken(id);
      try { out = await run(await accessTokenFor(id)); } catch (err) { out = { stopped: { kind: err.reconnect ? 'auth' : 'later', error: err.message } }; }
    }
    await remember(id, entries);
    if (out.stopped?.kind === 'auth') {
      await setGoogleStatus(id, { status: 'reconnect', lastError: out.stopped.error });
      return { error: out.stopped.error };
    }
    if (out.stopped) { await kv.hset(K.pending, id, Date.now()); await setGoogleStatus(id, { lastError: out.stopped.error }); return { error: out.stopped.error, applied: entries.length }; }
    await kv.hdel(K.pending, id);
    await setGoogleStatus(id, { lastError: null, lastSync: new Date().toISOString() });
    return { applied: entries.length };
  } finally {
    await kv.del(K.lock(id));
  }
}

// Gọi ngầm sau khi giao lịch: không làm chậm câu trả lời cho PyloS (Vercel giữ hàm chạy nhờ waitUntil).
const inflight = new Set();
export function kickDrain(id) {
  const p = drainMember(id).catch((err) => console.warn('[drain]', err.message)).finally(() => inflight.delete(p));
  inflight.add(p);
  waitUntil(p);
  return p;
}
export const settleDrains = () => Promise.all([...inflight]);

// Kéo lịch Google về / đẩy lịch tạo trên web lên; cập nhật nhãn trạng thái trên hồ sơ.
export async function syncMemberGoogle(id, opts = {}) {
  const open = openUser(id);
  const result = await syncGoogle(open, opts);
  const g = (await open()).data.google;
  if (g) await setGoogleStatus(id, { status: g.status, lastSync: g.lastSync || null, lastError: g.lastError || null });
  return result;
}

// Người dùng vừa cho phép Google Lịch: lưu token (mã hoá), bật đồng bộ, chạy lần đầu ở nền.
export async function connectMember(id, { email, refreshToken }) {
  await saveRefreshToken(id, refreshToken);
  const store = await UserStore.open(id);
  store.data.google = {
    ...(store.data.google || {}), status: 'connected', email, calendars: [{ id: 'primary', name: 'Lịch chính' }], push: true,
    connectedAt: new Date().toISOString(), pendingDeletes: store.data.google?.pendingDeletes || [], lastError: null,
  };
  await store.save();
  await setGoogleStatus(id, { status: 'connected', email, lastError: null });
  forgetAccessToken(id);
  const job = (async () => { await drainMember(id); await syncMemberGoogle(id); })().catch((err) => console.warn('[gsync]', err.message));
  inflight.add(job); job.finally(() => inflight.delete(job));
  waitUntil(job);
  return job;
}

// Ngắt: thu hồi quyền bên Google, xoá token, bỏ lịch kéo từ Google về (lịch người dùng tự tạo trên web giữ nguyên).
export async function disconnectMember(id) {
  await revokeAndDelete(id);
  const store = await UserStore.open(id);
  store.data.google = null;
  store.data.events = store.data.events.filter((e) => e.origin !== 'google');
  for (const e of store.data.events) { delete e.googleId; delete e.googleDirty; }
  await store.save();
  await kv.hdel(K.pending, id);
  await setGoogleStatus(id, { status: 'off', lastError: null, lastSync: null });
}

// Cron: chạy lại lệnh bị lỗi tạm thời, đồng bộ nguồn và Google của một lô người dùng (con trỏ xoay vòng, tối đa `limit` người/lần).
export async function cronMembers({ listMembers, forceSync = false, syncEveryMs = 30 * 60_000, limit = 20 } = {}) {
  const report = { drained: 0, google: 0, sources: 0 };
  const pending = Object.keys((await kv.hgetall(K.pending)) || {});
  for (const id of pending.slice(0, 30)) { await drainMember(id).catch(() => {}); report.drained++; }

  const all = (await listMembers()).filter((m) => m.google?.status === 'connected' || m.hasSources);
  if (!all.length) return report;
  const cursor = Number(await kv.get('cron:cursor')) || 0;
  const batchList = Array.from({ length: Math.min(limit, all.length) }, (_, i) => all[(cursor + i) % all.length]);
  await kv.set('cron:cursor', (cursor + batchList.length) % all.length);
  for (const m of batchList) {
    const opts = { olderThanMs: forceSync ? 0 : syncEveryMs - 60_000 };
    try {
      if (m.hasSources) { await syncSources(openUser(m.id), opts); report.sources++; }
      if (m.google?.status === 'connected') { await syncMemberGoogle(m.id, opts); report.google++; }
    } catch (err) { console.warn('[cron]', m.id, err.message); }
  }
  return report;
}
