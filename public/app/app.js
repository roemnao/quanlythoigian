// Web app của thành viên: đăng nhập Gmail → liên kết Zalo (mã 6 số) → cho phép ghi Google Lịch,
// rồi tự lấy lệnh lịch được giao (thêm / sửa / xoá) và ghi vào Google Lịch ngay trong trình duyệt.
// Một chiều: app chỉ đọc lệnh của chính mình, không gửi lịch hay dữ liệu Google Lịch lên máy chủ.
import { applyAll } from './sync.js';

const POLL_MS = 60_000;
// "/" khi web app có tên miền riêng, "/app/" khi dùng chung tên miền với trang quản trị.
const APP_BASE = location.pathname.startsWith('/app') ? '/app/' : '/';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const HISTORY_MAX = 200;

const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
function icon(name, cls = 'i') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  if (name === 'google') svg.setAttribute('viewBox', '0 0 48 48');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
const fTime = (d) => new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const fDT = (d) => new Date(d).toLocaleString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fDay = (key) => new Date(`${key}T00:00:00`).toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' });
const whenText = (ev) => (ev.allDay ? `${fDay(ev.start)}${ev.end && ev.end !== ev.start ? ` – ${fDay(ev.end)}` : ''} · cả ngày` : fDT(ev.start));
const OP = { create: 'Thêm', update: 'Sửa', delete: 'Xoá' };

// ---------- Trạng thái ----------
const st = {
  me: null, termsVersion: null, googleReady: true,
  pending: [], applied: 0, fetched: 0, history: [], missed: false,
  token: null, lastCheck: null, notice: null, busy: false, code: null,
};

// Lưu trên máy (theo từng tài khoản): tiến độ, lệnh chờ ghi, lịch sử. Token Google chỉ ở bộ nhớ phiên của tab.
const local = {
  key: (k) => `ifmwh:${st.me.id}:${k}`,
  get(k, def) { try { const v = localStorage.getItem(this.key(k)); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(this.key(k), JSON.stringify(v)); } catch { /* chế độ riêng tư: chỉ giữ trong lần mở này */ } },
  clear() { try { for (const k of Object.keys(localStorage)) if (k.startsWith(`ifmwh:${st.me.id}:`)) localStorage.removeItem(k); } catch {} },
};
function loadLocal() {
  st.applied = local.get('applied', 0);
  st.pending = local.get('pending', []).filter((c) => c.seq > st.applied);
  st.fetched = Math.max(st.applied, ...st.pending.map((c) => c.seq));
  st.history = local.get('history', []);
  st.missed = local.get('missed', false);
  try {
    const t = JSON.parse(sessionStorage.getItem(local.key('token')) || 'null');
    if (t && t.exp > Date.now() + 60_000) st.token = t;
  } catch {}
}
function saveLocal() {
  local.set('applied', st.applied);
  local.set('pending', st.pending);
  local.set('history', st.history.slice(0, HISTORY_MAX));
  local.set('missed', st.missed);
}
const tokenValid = () => Boolean(st.token && st.token.exp > Date.now() + 60_000);

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Không kết nối được máy chủ, kiểm tra mạng rồi thử lại');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.signIn) {
    st.me = null;
    st.termsVersion = data.termsVersion;
    renderSignIn();
    throw Object.assign(new Error(data.error), { handled: true });
  }
  if (res.status === 403 && data.needsTerms) {
    st.termsVersion = data.termsVersion;
    renderTerms();
    throw Object.assign(new Error(data.error), { handled: true });
  }
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}
const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { if (!e.handled) toast(`⚠️ ${e.message}`, 6000); }
};

// ---------- Google Lịch (Google Identity Services, token chỉ ở trình duyệt) ----------
// Phải gọi trong lúc người dùng bấm nút, nếu không trình duyệt chặn cửa sổ của Google.
function requestToken() {
  return new Promise((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) return reject(new Error('Chưa tải được thư viện của Google, kiểm tra mạng rồi thử lại'));
    if (!st.me.googleClientId) return reject(new Error('Chủ hệ thống chưa cấu hình Google, hãy báo cho họ'));
    const client = oauth2.initTokenClient({
      client_id: st.me.googleClientId,
      scope: SCOPE,
      hint: st.me.email,
      prompt: local.get('granted', false) ? '' : 'consent',
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || 'Google từ chối cấp quyền'));
        if (!oauth2.hasGrantedAllScopes(resp, SCOPE)) return reject(new Error('Bạn chưa tick quyền "Xem và sửa sự kiện trong Google Lịch"'));
        st.token = { value: resp.access_token, exp: Date.now() + Number(resp.expires_in || 3600) * 1000 };
        try { sessionStorage.setItem(local.key('token'), JSON.stringify(st.token)); } catch {}
        local.set('granted', true);
        resolve();
      },
      error_callback: (err) => reject(new Error(err?.type === 'popup_closed' ? 'Bạn đã đóng cửa sổ của Google'
        : 'Không mở được cửa sổ của Google. Nếu trình duyệt chặn cửa sổ bật lên, hãy cho phép rồi bấm lại.')),
    });
    client.requestAccessToken();
  });
}
function forgetToken() {
  st.token = null;
  try { sessionStorage.removeItem(local.key('token')); } catch {}
}

// ---------- Lấy lệnh và ghi vào Google Lịch ----------
function addHistory(cmd, result) {
  st.history.unshift({
    seq: cmd.seq, op: cmd.op, title: cmd.event.title, start: cmd.event.start, end: cmd.event.end, allDay: cmd.event.allDay,
    from: cmd.event.from || null, at: new Date().toISOString(), ok: result.ok, error: result.ok ? null : result.error, link: result.link || null,
  });
  st.history.length = Math.min(st.history.length, HISTORY_MAX);
}

async function applyPending() {
  if (!st.pending.length || !tokenValid()) return;
  const r = await applyAll(st.pending, {
    token: st.token.value,
    appUrl: `${location.origin}${APP_BASE}`,
    onResult: (cmd, result) => {
      addHistory(cmd, result);
      st.pending = st.pending.filter((c) => c.seq !== cmd.seq);
      st.applied = Math.max(st.applied, cmd.seq);
      saveLocal();
    },
  });
  if (r.stopped?.kind === 'auth') {
    forgetToken();
    st.notice = 'Quyền ghi Google Lịch đã hết hạn. Bấm "Cập nhật Google Lịch" để ghi tiếp.';
  } else if (r.stopped) {
    st.notice = `Chưa ghi được vào Google Lịch: ${r.stopped.error}. App sẽ thử lại.`;
  } else st.notice = null;
}

async function poll() {
  if (!st.me || st.busy) return;
  st.busy = true;
  try {
    const data = await api('GET', `/api/me/commands?after=${st.fetched}`);
    st.lastCheck = Date.now();
    if (data.missed) st.missed = true;
    const known = new Set(st.pending.map((c) => c.seq));
    for (const c of data.commands) if (c.seq > st.applied && !known.has(c.seq)) st.pending.push(c);
    st.fetched = Math.max(st.fetched, data.latest);
    saveLocal();
    await applyPending();
  } catch (e) {
    if (!e.handled) st.notice = e.message;
  } finally {
    st.busy = false;
    if (st.me) renderHome();
  }
}

let pollTimer = null;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  poll();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && st.me) poll(); });

// ---------- Màn hình: đăng nhập ----------
function renderSignIn() {
  clearInterval(pollTimer);
  document.body.dataset.screen = 'signin';
  const agree = h('input', { type: 'checkbox', id: 'agree' });
  const go = h('a', { class: 'btn primary block google', href: '#', 'aria-disabled': 'true' }, icon('google', 'gicon'), 'Đăng nhập bằng Google');
  const err = h('p', { class: 'err small', hidden: true });
  const sync = () => {
    go.setAttribute('aria-disabled', String(!agree.checked));
    go.href = agree.checked ? `/api/google/start?purpose=member&terms=${encodeURIComponent(st.termsVersion || '')}` : '#';
  };
  agree.addEventListener('change', sync);
  go.addEventListener('click', (e) => {
    if (agree.checked) return;
    e.preventDefault();
    err.textContent = 'Hãy đọc và đánh dấu đồng ý Điều khoản dịch vụ trước.';
    err.hidden = false;
  });
  sync();
  $('#view').replaceChildren(h('section', { class: 'card hero' },
    h('h1', {}, 'Lịch được giao trong nhóm Zalo, tự vào Google Lịch của bạn'),
    h('ol', { class: 'pillars' },
      h('li', {}, icon('mail'), h('b', {}, 'Đăng nhập bằng Gmail'), h('span', {}, 'Tài khoản chính của bạn')),
      h('li', {}, icon('chat'), h('b', {}, 'Liên kết Zalo'), h('span', {}, 'Gửi mã 6 số cho bot')),
      h('li', {}, icon('calendar'), h('b', {}, 'Cho phép Google Lịch'), h('span', {}, 'Ghi ngay trong trình duyệt'))),
    st.googleReady ? '' : h('p', { class: 'note small' }, 'Chủ hệ thống chưa cấu hình đăng nhập Google, bạn chưa tạo tài khoản được.'),
    h('label', { class: 'consent', for: 'agree' }, agree, h('span', {}, 'Tôi đã đọc và đồng ý ',
      h('a', { href: '/terms.html', target: '_blank' }, 'Điều khoản dịch vụ'), ' và ',
      h('a', { href: '/privacy.html', target: '_blank' }, 'Chính sách quyền riêng tư'), '.')),
    go, err,
    h('p', { class: 'small muted' }, 'Chỉ dùng email và tên của bạn. App không xem được dữ liệu của người khác và không gửi lịch của bạn lên máy chủ.')));
}

// Điều khoản có bản mới: đồng ý lại mới nhận tiếp lịch.
function renderTerms() {
  clearInterval(pollTimer);
  document.body.dataset.screen = 'terms';
  const agree = h('input', { type: 'checkbox', id: 'agree' });
  $('#view').replaceChildren(h('section', { class: 'card hero' },
    h('h1', {}, 'Điều khoản đã được cập nhật'),
    h('p', {}, `Bản mới: ${st.termsVersion}. Hãy đọc lại, đồng ý để tiếp tục nhận lịch được giao.`),
    h('label', { class: 'consent', for: 'agree' }, agree, h('span', {}, 'Tôi đã đọc và đồng ý ',
      h('a', { href: '/terms.html', target: '_blank' }, 'Điều khoản dịch vụ'), ' và ',
      h('a', { href: '/privacy.html', target: '_blank' }, 'Chính sách quyền riêng tư'), '.')),
    h('button', { class: 'btn primary block', type: 'button', onclick: guard(async () => {
      if (!agree.checked) throw new Error('Hãy đánh dấu đồng ý trước');
      await api('POST', '/api/me/terms', { version: st.termsVersion });
      await boot();
    }) }, 'Đồng ý và tiếp tục'),
    h('button', { class: 'btn ghost block', type: 'button', onclick: () => signOut() }, 'Đăng xuất')));
}

// ---------- Màn hình chính ----------
function step(n, done, title, ...body) {
  return h('li', { class: `step ${done ? 'done' : ''}` },
    h('span', { class: 'step-num', 'aria-hidden': 'true' }, done ? icon('check') : String(n)),
    h('div', { class: 'grow' }, h('b', { class: 'step-title' }, title), ...body));
}

function zaloStep() {
  const me = st.me;
  if (me.zalo) {
    return step(2, true, 'Zalo đã liên kết', h('p', { class: 'small muted' }, `Tài khoản Zalo: ${me.zalo.name || 'đã liên kết'}. Lịch giao cho bạn trong nhóm sẽ về đây.`),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: guard(async () => {
        if (!confirm('Gỡ liên kết Zalo? Bot sẽ không giao lịch cho bạn nữa cho tới khi liên kết lại.')) return;
        st.me = { ...st.me, ...(await api('DELETE', '/api/me/zalo')) };
        renderHome();
      }) }, 'Gỡ liên kết'));
  }
  if (st.code && st.code.until > Date.now()) {
    const left = Math.max(0, Math.round((st.code.until - Date.now()) / 60000));
    return step(2, false, 'Gửi mã này cho bot trên Zalo',
      h('div', { class: 'code-big', 'aria-label': `Mã ${st.code.code.split('').join(' ')}` }, st.code.code),
      h('p', { class: 'small' }, `Mở Zalo, nhắn riêng cho bot${st.code.botName ? ` ${st.code.botName}` : ''} đúng 6 số này. Mã dùng một lần, hết hạn sau ${left} phút.`),
      h('div', { class: 'row' },
        st.code.botChatUrl ? h('a', { class: 'btn primary', href: st.code.botChatUrl, target: '_blank', rel: 'noopener' }, icon('chat'), 'Mở Zalo chat với bot') : '',
        h('button', { class: 'btn', type: 'button', onclick: guard(copyCode) }, 'Chép mã')),
      h('p', { class: 'small muted' }, 'App tự nhận ra khi bot đã liên kết xong.'));
  }
  return step(2, false, 'Liên kết Zalo', h('p', { class: 'small muted' }, 'Để bot biết bạn là ai khi được nhắc trong nhóm Zalo.'),
    h('button', { class: 'btn primary', type: 'button', onclick: guard(getCode) }, 'Lấy mã liên kết'));
}

function calendarStep() {
  const ok = tokenValid();
  const granted = local.get('granted', false);
  return step(3, ok, ok ? 'Google Lịch đã kết nối' : 'Cho phép ghi vào Google Lịch',
    h('p', { class: 'small muted' }, ok
      ? 'Quyền này chỉ nằm trong trình duyệt và tự hết hạn sau khoảng 1 giờ; khi cần, app sẽ nhờ bạn bấm cho phép lại.'
      : granted ? 'Phiên cho phép đã hết. Bấm để cho phép lại (không cần tick lại).' : 'App chỉ thêm, sửa, xoá các lịch được giao cho bạn; không đọc lịch khác.'),
    ok ? '' : h('button', { class: 'btn primary', type: 'button', onclick: guard(connectCalendar) }, icon('google', 'gicon'), 'Kết nối Google Lịch'));
}

function syncCard() {
  const n = st.pending.length;
  let line;
  if (n && !tokenValid()) line = h('p', { class: 'warn' }, `Có ${n} lịch mới đang chờ ghi vào Google Lịch.`);
  else if (n) line = h('p', {}, `Đang ghi ${n} lịch…`);
  else line = h('p', { class: 'ok' }, 'Mọi lịch được giao đã nằm trong Google Lịch.');
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { class: 'frieze' }, 'Đồng bộ')),
    line,
    st.notice ? h('p', { class: 'small warn' }, st.notice) : '',
    st.missed ? h('p', { class: 'small muted' }, 'Một số lịch giao từ lâu (quá 30 ngày) đã hết hạn trước khi app kịp lấy.') : '',
    h('p', { class: 'small muted' }, st.lastCheck ? `Kiểm tra lần cuối lúc ${fTime(st.lastCheck)}. App tự kiểm tra mỗi phút khi đang mở.` : 'Đang kiểm tra…'),
    h('div', { class: 'row' },
      n && !tokenValid() ? h('button', { class: 'btn primary', type: 'button', onclick: guard(connectCalendar) }, 'Cập nhật Google Lịch') : '',
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await poll(); toast('Đã kiểm tra'); }) }, icon('refresh'), 'Kiểm tra ngay')));
}

function historyCard() {
  const items = st.history.map((x) => h('li', { class: 'hist' },
    h('span', { class: `badge ${x.ok ? x.op : 'terra'}` }, x.ok ? OP[x.op] || x.op : 'Lỗi'),
    h('div', { class: 'grow' },
      h('b', {}, x.title || '(không tên)'),
      h('span', { class: 'meta' }, x.op === 'delete' ? 'đã xoá khỏi lịch' : whenText(x),
        x.from?.sender ? ` · ${x.from.sender}` : '', x.from?.chat ? ` · ${x.from.chat}` : ''),
      x.ok ? '' : h('span', { class: 'meta err' }, x.error)),
    x.link ? h('a', { class: 'btn icon', href: x.link, target: '_blank', rel: 'noopener', 'aria-label': 'Mở trong Google Lịch', title: 'Mở trong Google Lịch' }, icon('external')) : '',
    h('time', { class: 'small muted', datetime: x.at }, fTime(x.at))));
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { class: 'frieze' }, 'Lịch đã nhận trên máy này')),
    items.length ? h('ul', { class: 'list' }, items)
      : h('p', { class: 'muted small empty' }, 'Chưa có. Khi ai đó giao lịch cho bạn trong nhóm Zalo, lịch sẽ hiện ở đây và trong Google Lịch.'),
    h('p', { class: 'small muted' }, 'Danh sách này chỉ lưu trên trình duyệt này.'));
}

function accountCard() {
  return h('section', { class: 'card account' },
    h('div', { class: 'card-head' }, h('h2', { class: 'frieze' }, 'Tài khoản')),
    h('p', { class: 'small' }, h('b', {}, st.me.name), ' · ', st.me.email),
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => signOut() }, 'Đăng xuất'),
      h('button', { class: 'btn sm ghost danger', type: 'button', onclick: guard(deleteAccount) }, 'Xoá tài khoản')));
}

function renderHome() {
  if (!st.me) return;
  document.body.dataset.screen = 'home';
  const me = st.me;
  const allDone = me.zalo && local.get('granted', false);
  const steps = h('section', { class: `card setup ${allDone ? 'compact' : ''}` },
    h('div', { class: 'card-head' }, h('h2', { class: 'frieze' }, allDone ? 'Kết nối' : 'Ba bước để bắt đầu')),
    h('ol', { class: 'steps' },
      step(1, true, 'Gmail', h('p', { class: 'small muted' }, me.email)),
      zaloStep(),
      calendarStep()));
  $('#view').replaceChildren(steps, syncCard(), historyCard(), accountCard());
}

// ---------- Hành động ----------
let codeTimer = null;
async function getCode() {
  const data = await api('POST', '/api/me/zalo-code');
  st.code = { ...data, until: Date.now() + data.expiresInMinutes * 60_000 };
  renderHome();
  clearInterval(codeTimer);
  codeTimer = setInterval(guard(async () => {
    if (!st.code || Date.now() > st.code.until) { clearInterval(codeTimer); st.code = null; renderHome(); return; }
    if (document.hidden) return;
    const { zalo } = await api('GET', '/api/me/zalo');
    if (zalo) {
      clearInterval(codeTimer);
      st.code = null;
      st.me = { ...st.me, zalo };
      toast('Đã liên kết Zalo 🎉');
      renderHome();
    }
  }), 5000);
}
async function copyCode() {
  try { await navigator.clipboard.writeText(st.code.code); toast('Đã chép mã'); } catch { toast(`Mã: ${st.code.code}`); }
}
async function connectCalendar() {
  await requestToken();
  st.notice = null;
  renderHome();
  await poll();
  toast(st.pending.length ? 'Đã kết nối, đang ghi lịch…' : 'Đã kết nối Google Lịch');
}
async function signOut() {
  try { await fetch('/api/me/logout', { method: 'POST' }); } catch {}
  if (st.me) forgetToken();
  st.me = null;
  renderSignIn();
}
async function deleteAccount() {
  if (!confirm('Xoá tài khoản? Liên kết Zalo và các lịch đang chờ sẽ bị xoá. Lịch đã ghi trong Google Lịch vẫn giữ nguyên.')) return;
  if (!confirm('Chắc chắn xoá? Không hoàn tác được.')) return;
  await api('DELETE', '/api/me');
  forgetToken();
  local.clear();
  st.me = null;
  renderSignIn();
  toast('Đã xoá tài khoản');
}

// ---------- Duyệt đăng nhập của trang quản lý bot ----------
// Link ?device=<mã> do trang quản lý bot mở. Mã giữ qua bước đăng nhập Google bằng sessionStorage.
const DEVICE_KEY = 'ifmwh-device';
const deviceStore = {
  get() { try { return sessionStorage.getItem(DEVICE_KEY); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem(DEVICE_KEY, v) : sessionStorage.removeItem(DEVICE_KEY); } catch { /* bỏ qua */ } },
};

function renderDevice(code) {
  clearInterval(pollTimer);
  document.body.dataset.screen = 'device';
  const done = (title, text) => {
    deviceStore.set(null);
    $('#view').replaceChildren(h('section', { class: 'card hero' }, h('h1', {}, title), h('p', {}, text),
      h('button', { class: 'btn primary block', type: 'button', onclick: () => boot() }, 'Về app')));
  };
  $('#view').replaceChildren(h('section', { class: 'card hero' },
    h('h1', {}, 'Đăng nhập trang quản lý bot?'),
    h('p', {}, `Trang quản lý bot trên máy chủ của bạn xin đăng nhập bằng ${st.me.email}. Chỉ bấm Cho phép nếu chính bạn vừa mở nó.`),
    h('p', { class: 'small muted' }, 'Chỉ tài khoản Gmail của chủ hệ thống mới vào được. Cho phép không chia sẻ lịch hay dữ liệu nào của bạn.'),
    h('button', { class: 'btn primary block', type: 'button', onclick: guard(async () => {
      try {
        await api('POST', '/api/me/device-login/approve', { code });
      } catch (e) {
        done('Chưa duyệt được', e.message);
        return;
      }
      done('Đã duyệt', 'Quay lại trang quản lý bot, nó sẽ tự đăng nhập trong vài giây.');
    }) }, 'Cho phép'),
    h('button', { class: 'btn ghost block', type: 'button', onclick: () => done('Đã từ chối', 'Không có gì được cấp quyền.') }, 'Từ chối')));
}

// ---------- Khởi động ----------
async function boot() {
  const res = await fetch('/api/me').catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res || (res.status !== 200 && res.status !== 401)) {
    $('#view').replaceChildren(h('section', { class: 'card' }, h('p', { class: 'err' }, data.error || 'Không kết nối được máy chủ.'),
      h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Thử lại')));
    return;
  }
  if (res.status === 401) {
    st.termsVersion = data.termsVersion;
    st.googleReady = data.googleReady !== false;
    renderSignIn();
    return;
  }
  st.me = data;
  st.termsVersion = data.termsCurrent;
  if (data.needsTerms) { renderTerms(); return; }
  loadLocal();
  const device = deviceStore.get();
  if (device) { renderDevice(device); return; }
  renderHome();
  startPolling();
}

const qs = new URLSearchParams(location.search);
if (/^[0-9a-f]{32}$/.test(qs.get('device') || '')) {
  deviceStore.set(qs.get('device'));
  history.replaceState(null, '', location.pathname);
}
if (qs.has('google') || qs.has('google_error')) {
  const err = qs.get('google_error');
  history.replaceState(null, '', location.pathname);
  setTimeout(() => toast(err ? `⚠️ ${err}` : qs.get('google') === 'member-new' ? 'Đã tạo tài khoản. Tiếp theo: liên kết Zalo.' : 'Đã đăng nhập', 6000), 300);
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: APP_BASE }).catch(() => {});
boot();
