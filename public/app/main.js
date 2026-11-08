// Web iforgotmywayhome: một giao diện cho mọi người (JS thuần, không cần build).
// Menu hiện theo quyền (me.perms): User chỉ có phần sử dụng; Owner / Technician có thêm Quản trị. Máy chủ kiểm quyền lại ở mọi API.
import { $, $$, h, icon, googleIcon, api, toast, guard, onApiEvents, ROLE_LABEL, can } from './ui.js';

let S = null; // dữ liệu riêng của người đang đăng nhập (lịch, việc, đề xuất, nguồn…)
let ME = null; // hồ sơ + quyền
let view = 'dashboard';
const cal = { mode: 'month', cursor: new Date(), sel: null };

// ---------- Ngày giờ (theo giờ của trình duyệt) ----------
const pad = (n) => String(n).padStart(2, '0');
const dkey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fTime = (d) => new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const fDT = (d) => new Date(d).toLocaleString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fDay = (d) => new Date(d).toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'numeric' });
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${dkey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const empty = (text) => h('li', { class: 'empty' }, text);
const WD = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const startOfWeek = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

const originClass = (e) => (e.origin === 'ics' || e.origin === 'google' ? e.origin : e.origin === 'manual' || !e.origin ? 'manual' : 'ai');
const originLabel = (o) => (o === 'ics' ? 'Lịch đồng bộ' : o === 'google' ? 'Google Lịch' : o === 'paste' ? 'AI (dán văn bản)' : o === 'zalo' ? 'Zalo' : o?.startsWith('web:') ? `Trang web: ${o.slice(4)}` : 'Tự thêm');
const eventsOn = (k) => S.events.filter((e) => dkey(e.start) === k)
  .sort((a, b) => (b.allDay - a.allDay) || a.start.localeCompare(b.start));
const dueOn = (k) => S.tasks.filter((t) => !t.done && t.deadline && dkey(t.deadline) === k);
const timeRange = (e) => (e.allDay ? 'Cả ngày' : e.end ? `${fTime(e.start)} – ${fTime(e.end)}` : fTime(e.start));


// ---------- Màn hình & điều hướng ----------
const SCREENS = ['signin', 'terms', 'app'];
function showScreen(name) {
  for (const s of SCREENS) $(`#${s}`).hidden = s !== name;
}

// Mỗi mục: tiêu đề, nút hành động trên thanh trên, quyền cần có, đường dẫn (hash) và nơi vẽ.
const VIEWS = {
  dashboard: { title: 'Tổng quan', action: 'Thêm lịch', icon: 'home', hash: 'tong-quan' },
  calendar: { title: 'Lịch', action: 'Thêm lịch', icon: 'calendar', hash: 'lich' },
  tasks: { title: 'Công việc', action: 'Thêm việc', icon: 'check', hash: 'cong-viec' },
  inbox: { title: 'Đề xuất', action: 'Dán nội dung', icon: 'inbox', hash: 'de-xuat' },
  sources: { title: 'Nguồn', action: 'Thêm nguồn', icon: 'link', hash: 'nguon' },
  account: { title: 'Tài khoản', action: null, icon: 'users', hash: 'tai-khoan' },
  'admin-bot': { title: 'Quản lý bot lịch', action: null, icon: 'column', hash: 'quan-tri/bot', perm: 'bot:read', group: 'Quản trị' },
  'admin-accounts': { title: 'Tài khoản người dùng', action: null, icon: 'settings', hash: 'quan-tri/tai-khoan', perm: 'accounts:read', group: 'Quản trị' },
};
const allowed = (name) => VIEWS[name] && (!VIEWS[name].perm || can(ME, VIEWS[name].perm));
const fromHash = () => Object.keys(VIEWS).find((k) => `#/${VIEWS[k].hash}` === location.hash) || 'dashboard';

// Điện thoại: 4 mục chính ở đáy + nút "Thêm" mở ngăn chứa các mục còn lại. Máy tính bảng / máy tính: CSS hiện tất cả như cũ.
const PRIMARY_VIEWS = ['dashboard', 'calendar', 'tasks', 'inbox'];
function buildNav() {
  const nav = $('#nav');
  const items = [];
  const more = h('div', { class: 'nav-more', id: 'nav-more' });
  let group = null;
  for (const [name, v] of Object.entries(VIEWS)) {
    if (!allowed(name)) continue;
    const dest = PRIMARY_VIEWS.includes(name) ? { push: (x) => items.push(x) } : { push: (x) => more.append(x) };
    if (v.group && v.group !== group) { group = v.group; dest.push(h('div', { class: 'nav-group' }, v.group)); }
    const b = h('button', { 'data-view': name, type: 'button', title: v.title }, icon(v.icon), h('span', {}, v.title));
    if (name === 'inbox') b.append(h('b', { class: 'count', id: 'inbox-count', hidden: true }));
    b.addEventListener('click', () => { closeMore(); location.hash = `#/${v.hash}`; });
    dest.push(b);
  }
  const moreBtn = h('button', { type: 'button', class: 'more-btn', id: 'more-btn', 'aria-expanded': 'false', 'aria-controls': 'nav-more' }, icon('settings'), h('span', {}, 'Thêm'));
  moreBtn.addEventListener('click', () => {
    const open = !more.classList.contains('open');
    more.classList.toggle('open', open); moreBtn.setAttribute('aria-expanded', String(open));
  });
  nav.replaceChildren(...items, moreBtn, more);
}
function closeMore() {
  $('#nav-more')?.classList.remove('open');
  $('#more-btn')?.setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', (e) => { if (!e.target.closest('#nav')) closeMore(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMore(); });

function setView(name) {
  view = allowed(name) ? name : 'dashboard';
  $$('#nav button[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $('#more-btn')?.classList.toggle('on', !PRIMARY_VIEWS.includes(view));
  closeMore();
  $$('.view').forEach((s) => s.classList.toggle('on', s.dataset.view === view));
  $('#view-title').textContent = VIEWS[view].title;
  const act = $('#top-action');
  act.hidden = !VIEWS[view].action;
  act.querySelector('span').textContent = VIEWS[view].action || '';
  window.scrollTo(0, 0);
  if (!S) return;
  if (view === 'account') renderAccountView();
  else if (view === 'admin-bot') renderAdminBotView();
  else if (view === 'admin-accounts') renderAdminAccountsView();
}
window.addEventListener('hashchange', () => { if (ME && !$('#app').hidden) setView(fromHash()); });
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/${VIEWS[b.dataset.goto].hash}`; }));
$('#top-action').addEventListener('click', () => {
  if (view === 'dashboard' || view === 'calendar') openEventModal(null, cal.sel || dkey(new Date()));
  else if (view === 'tasks') $('#task-form').title.focus();
  else if (view === 'inbox') $('#extract-form').text.focus();
  else if (view === 'sources') $('#source-form').url.focus();
});

async function load() {
  S = await api('GET', '/api/me/state');
  render();
}
function render() {
  $('#today-label').textContent = new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const n = S.suggestions.length;
  const c = $('#inbox-count'); if (c) { c.hidden = !n; c.textContent = n; }
  renderGoogleBanner();
  renderDashboard(); renderCalendar(); renderTasks(); renderSources(); renderPomoStats();
  // Không vẽ lại hàng chờ khi người dùng đang sửa một ô của đề xuất.
  const a = document.activeElement;
  if (!($('#suggestions').contains(a) && a.matches('input, select'))) renderInbox();
}

// Nhắc kết nối Google Lịch khi chưa kết nối hoặc cần kết nối lại (không chặn việc dùng web).
function renderGoogleBanner() {
  const banner = $('#banner');
  const st = ME.google.status;
  const msg = { 'no-scope': 'Chưa cho phép Google Lịch nên lịch được giao trong nhóm Zalo chưa tự vào Google Lịch của bạn.',
    reconnect: 'Quyền Google Lịch đã bị gỡ hoặc hết hiệu lực. Kết nối lại để lịch được giao tiếp tục tự vào Google Lịch.' }[st];
  banner.hidden = !msg;
  banner.replaceChildren();
  if (msg) {
    banner.append(msg, ' ', h('a', { class: 'btn sm primary google-btn', href: '/api/google/start?purpose=calendar-member' }, googleIcon(), st === 'reconnect' ? 'Kết nối lại Google Lịch' : 'Cho phép Google Lịch'));
  }
}

// ---------- Đăng nhập, điều khoản ----------
const TERMS_LINKS = () => [h('a', { href: '/terms.html', target: '_blank' }, 'Điều khoản dịch vụ'), ' và ', h('a', { href: '/privacy.html', target: '_blank' }, 'Chính sách quyền riêng tư')];
let termsVersion = null;
let googleReady = true;

function renderSignIn() {
  ME = null; S = null;
  showScreen('signin');
  const agree = h('input', { type: 'checkbox', id: 'agree' });
  const go = h('a', { class: 'btn primary block google-btn', href: '#', 'aria-disabled': 'true' }, googleIcon(), 'Đăng nhập bằng Google');
  const err = h('p', { class: 'err small', hidden: true });
  const sync = () => {
    go.setAttribute('aria-disabled', String(!agree.checked));
    go.href = agree.checked ? `/api/google/start?purpose=member&terms=${encodeURIComponent(termsVersion || '')}` : '#';
  };
  agree.addEventListener('change', sync);
  go.addEventListener('click', (e) => {
    if (agree.checked) return;
    e.preventDefault();
    err.textContent = 'Hãy đọc và đánh dấu đồng ý Điều khoản dịch vụ trước.'; err.hidden = false;
  });
  sync();
  $('#signin-body').replaceChildren(
    h('h1', {}, 'Lịch của bạn, tự vào Google Lịch'),
    h('ol', { class: 'pillars' },
      h('li', {}, icon('users'), h('b', {}, 'Đăng nhập Google'), h('span', {}, 'Cũng là cho phép Google Lịch')),
      h('li', {}, icon('chat'), h('b', {}, 'Liên kết Zalo'), h('span', {}, 'Gửi mã 6 số cho bot')),
      h('li', {}, icon('calendar'), h('b', {}, 'Xong'), h('span', {}, 'Lịch được giao tự vào, không cần mở web'))),
    googleReady ? '' : h('p', { class: 'note small' }, 'Chủ hệ thống chưa cấu hình đăng nhập Google, bạn chưa tạo tài khoản được.'),
    h('label', { class: 'consent', for: 'agree' }, agree, h('span', {}, 'Tôi đã đọc và đồng ý ', ...TERMS_LINKS(), '.')),
    go, err,
    h('p', { class: 'small muted' }, 'Google sẽ hỏi bạn quyền xem và sửa sự kiện Google Lịch. Web chỉ dùng quyền này để ghi lịch được giao cho bạn và hiện lịch của bạn trên web. Bạn ngắt được bất cứ lúc nào ở mục Tài khoản.'));
}

function renderTerms() {
  showScreen('terms');
  const agree = h('input', { type: 'checkbox', id: 'agree2' });
  $('#terms-body').replaceChildren(
    h('h1', {}, 'Điều khoản đã được cập nhật'),
    h('p', {}, `Bản mới: ${termsVersion}. Hãy đọc lại và đồng ý để tiếp tục dùng và nhận lịch được giao.`),
    h('label', { class: 'consent', for: 'agree2' }, agree, h('span', {}, 'Tôi đã đọc và đồng ý ', ...TERMS_LINKS(), '.')),
    h('button', { class: 'btn primary block', type: 'button', onclick: guard(async () => {
      if (!agree.checked) throw new Error('Hãy đánh dấu đồng ý trước');
      await api('POST', '/api/me/terms', { version: termsVersion });
      await boot();
    }) }, 'Đồng ý và tiếp tục'),
    h('button', { class: 'btn ghost block', type: 'button', onclick: () => signOut() }, 'Đăng xuất'));
}

async function signOut() {
  try { await fetch('/api/me/logout', { method: 'POST' }); } catch {}
  renderSignIn();
}
onApiEvents({
  signIn: (d) => { termsVersion = d.termsVersion; renderSignIn(); },
  terms: (d) => { termsVersion = d.termsVersion; renderTerms(); },
  forbidden: () => { toast('Tài khoản của bạn không có quyền này', 5000); api('GET', '/api/me').then((m) => { ME = m; buildNav(); setView('dashboard'); location.hash = '#/tong-quan'; }).catch(() => {}); },
});

// Các phần của mục Tài khoản và Quản trị nằm ở module riêng, chỉ tải khi mở.
async function renderAccountView() {
  const m = await import('./account.js');
  await m.renderAccount($('#view-account'), { me: ME, refresh: refreshMe, signOut, S });
}
async function renderAdminBotView() {
  const m = await import('./admin-bot.js');
  await m.renderAdminBot($('#view-admin-bot'), { me: ME, today: S?.today });
}
async function renderAdminAccountsView() {
  const m = await import('./admin-accounts.js');
  await m.renderAdminAccounts($('#view-admin-accounts'), { me: ME });
}
async function refreshMe() {
  ME = await api('GET', '/api/me');
  renderGoogleBanner();
  return ME;
}

// ---------- Tổng quan ----------
function renderDashboard() {
  const today = dkey(new Date());
  const evs = eventsOn(today);
  const now = Date.now();
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
  const due = S.tasks.filter((t) => !t.done && t.deadline && new Date(t.deadline) <= endOfDay);
  const pomoToday = S.pomodoros.filter((p) => dkey(p.at) === today).length;
  $('#st-events').textContent = evs.length;
  $('#st-due').textContent = due.length;
  $('#st-inbox').textContent = S.suggestions.length;
  $('#st-pomo').textContent = pomoToday;

  const items = [];
  let nowPlaced = false;
  for (const e of evs) {
    if (!nowPlaced && !e.allDay && new Date(e.start) > now) { items.push(h('li', { class: 'now-line', title: 'Bây giờ' })); nowPlaced = true; }
    const past = !e.allDay && new Date(e.end || e.start) < now;
    items.push(h('li', { class: past ? 'past' : '' },
      h('span', { class: 't' }, e.allDay ? 'Cả ngày' : fTime(e.start)),
      h('span', { class: `bar ${originClass(e)}` }),
      h('span', { class: 'what', onclick: () => openEventModal(e) }, e.title,
        (e.end || e.note) && h('small', {}, [e.end && !e.allDay ? `đến ${fTime(e.end)}` : '', e.note].filter(Boolean).join(' · '))),
      e.origin === 'ics' ? h('span', { class: 'tag' }, 'ICS') : '',
      e.assigned ? h('span', { class: 'tag' }, 'Được giao') : ''));
  }
  $('#today-timeline').replaceChildren(...(items.length ? items : [empty('Hôm nay chưa có lịch. Bấm "Thêm lịch" hoặc nhập nhanh bằng AI.')]));

  const prio = S.tasks.filter((t) => !t.done && (t.quadrant === 1 || (t.deadline && new Date(t.deadline) <= endOfDay)))
    .sort((a, b) => (a.deadline || '9').localeCompare(b.deadline || '9')).slice(0, 8);
  $('#today-tasks').replaceChildren(...(prio.length ? prio.map((t) => taskItem(t, true)) : [empty('Không có việc gấp 🎉')]));

  const goals = S.goals[today] || [];
  $$('.goal').forEach((inp) => { if (document.activeElement !== inp) inp.value = goals[inp.dataset.i] || ''; });

  const sel = $('#pomo-task'); const cur = sel.value;
  sel.replaceChildren(h('option', { value: '' }, 'Đang làm việc gì? (tuỳ chọn)'),
    ...S.tasks.filter((t) => !t.done).map((t) => h('option', { value: t.id }, t.title)));
  sel.value = cur;
}

let goalTimer;
$$('.goal').forEach((inp) => inp.addEventListener('input', () => {
  clearTimeout(goalTimer);
  goalTimer = setTimeout(guard(async () => {
    const goals = $$('.goal').map((g) => g.value);
    const today = dkey(new Date());
    await api('PUT', `/api/me/goals/${today}`, { goals });
    S.goals[today] = goals;
  }), 600);
}));

$('#quick-ai').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = ev.target; const msg = $('#quick-ai-msg');
  if (!f.text.value.trim()) return;
  f.querySelector('button').disabled = true; msg.textContent = 'Đang phân tích…'; msg.className = 'muted small';
  try {
    const r = await api('POST', '/api/me/extract', { text: f.text.value });
    msg.textContent = r.added.length ? `Đã thêm ${r.added.length} đề xuất. Mở mục Đề xuất để duyệt.` : r.found ? 'Các mục này đã có rồi.' : 'Không tìm thấy lịch hay việc nào.';
    msg.className = 'ok small';
    if (r.added.length) f.reset();
    await load();
  } catch (e) { msg.textContent = e.message; msg.className = 'err small'; } finally { f.querySelector('button').disabled = false; }
}));

// ---------- Lịch ----------
function chip(e) {
  return h('div', { class: `chip ${originClass(e)}`, title: `${timeRange(e)} · ${e.title}`, onclick: (ev) => { ev.stopPropagation(); openEventModal(e); } },
    !e.allDay && h('b', {}, fTime(e.start)), e.title);
}
function dueChip(t) {
  return h('div', { class: 'chip due', title: `Hạn: ${t.title}`, onclick: (ev) => { ev.stopPropagation(); openTaskModal(t); } }, '⏰ ', t.title);
}
// Điện thoại / máy tính bảng dọc: danh sách ngày nằm dưới lịch, cuộn tới để người dùng thấy ngay.
function showDayPanel() {
  if (matchMedia('(max-width: 1100px)').matches) $('.day-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function renderCalendar() {
  const today = dkey(new Date());
  if (!cal.sel) cal.sel = today;
  $$('#cal-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === cal.mode));
  const grid = $('#cal-grid');
  if (cal.mode === 'month') {
    const first = new Date(cal.cursor.getFullYear(), cal.cursor.getMonth(), 1);
    const start = startOfWeek(first);
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const weeks = Math.ceil(((first.getDay() + 6) % 7 + daysInMonth) / 7);
    $('#cal-title').textContent = `Tháng ${first.getMonth() + 1}, ${first.getFullYear()}`;
    const cells = [];
    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(start, i); const k = dkey(d);
      const items = [...eventsOn(k).map(chip), ...dueOn(k).map(dueChip)];
      cells.push(h('div', {
        class: ['cell', d.getMonth() !== first.getMonth() && 'out', k === today && 'today', k === cal.sel && 'sel'].filter(Boolean).join(' '),
        onclick: () => { cal.sel = k; renderCalendar(); showDayPanel(); },
        ondblclick: () => openEventModal(null, k),
      }, h('span', { class: 'num' }, d.getDate()), items.slice(0, 3), items.length > 3 && h('span', { class: 'more' }, `+${items.length - 3} nữa`)));
    }
    grid.replaceChildren(h('div', { class: 'month' }, WD.map((w) => h('div', { class: 'dow' }, w)), cells));
  } else {
    const start = startOfWeek(cal.cursor);
    const end = addDays(start, 6);
    $('#cal-title').textContent = `${start.getDate()}/${start.getMonth() + 1} – ${end.getDate()}/${end.getMonth() + 1}/${end.getFullYear()}`;
    grid.replaceChildren(h('div', { class: 'week' }, [...Array(7)].map((_, i) => {
      const d = addDays(start, i); const k = dkey(d);
      return h('div', { class: ['wday', k === today && 'today', k === cal.sel && 'sel'].filter(Boolean).join(' '), onclick: () => { cal.sel = k; renderCalendar(); } },
        h('div', { class: 'wday-head' }, h('small', {}, WD[i]), h('b', {}, d.getDate())),
        h('div', { class: 'wday-body' }, eventsOn(k).map(chip), dueOn(k).map(dueChip)));
    })));
  }
  renderDayPanel();
}
function renderDayPanel() {
  const k = cal.sel;
  $('#day-title').textContent = fDay(fromKey(k));
  // Gộp lịch và hạn chót việc, sắp theo giờ (lịch cả ngày lên đầu).
  const rows = [
    ...eventsOn(k).map((e) => [e.allDay ? '' : e.start, h('li', {},
      h('span', { class: 't' }, e.allDay ? 'Cả ngày' : fTime(e.start)), h('span', { class: `bar ${originClass(e)}` }),
      h('span', { class: 'what', onclick: () => openEventModal(e) }, e.title, h('small', {}, [timeRange(e), e.note].filter(Boolean).join(' · '))), '')]),
    ...dueOn(k).map((t) => [t.deadline, h('li', {},
      h('span', { class: 't' }, fTime(t.deadline)), h('span', { class: 'bar due' }),
      h('span', { class: 'what', onclick: () => openTaskModal(t) }, `Hạn: ${t.title}`), '')]),
  ].sort((a, b) => a[0].localeCompare(b[0])).map((r) => r[1]);
  $('#day-list').replaceChildren(...(rows.length ? rows : [empty('Ngày trống. Bấm "Thêm" để tạo lịch.')]));
}
function moveCal(step) {
  const c = new Date(cal.cursor);
  if (cal.mode === 'month') { c.setDate(1); c.setMonth(c.getMonth() + step); } else c.setDate(c.getDate() + 7 * step);
  cal.cursor = c; renderCalendar();
}
$('#cal-prev').onclick = () => moveCal(-1);
$('#cal-next').onclick = () => moveCal(1);
$('#cal-today').onclick = () => { cal.cursor = new Date(); cal.sel = dkey(new Date()); renderCalendar(); };
$$('#cal-mode button').forEach((b) => b.addEventListener('click', () => {
  cal.mode = b.dataset.mode; cal.cursor = fromKey(cal.sel || dkey(new Date())); renderCalendar();
  try { localStorage.setItem('calMode', cal.mode); } catch {}
}));
$('#day-add').onclick = () => openEventModal(null, cal.sel);

// ---------- Hộp thoại sửa ----------
const modal = $('#modal');
let modalSave = null;
let modalDelete = null;
function openModal({ title, body, onSave, onDelete, readonly = false }) {
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(...body);
  modalSave = onSave; modalDelete = onDelete;
  $('#modal-delete').hidden = !onDelete;
  $('#modal-save').hidden = readonly;
  $('#modal-cancel').textContent = readonly ? 'Đóng' : 'Huỷ';
  modal.showModal();
  setTimeout(() => $('#modal-body input:not([type=checkbox])')?.focus(), 30);
}
const closeModal = () => modal.close();
$('#modal-close').onclick = closeModal;
$('#modal-cancel').onclick = closeModal;
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
$('#modal-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  if (!modalSave) return;
  $('#modal-save').disabled = true;
  try { await modalSave(); closeModal(); await load(); } finally { $('#modal-save').disabled = false; }
}));
$('#modal-delete').onclick = guard(async () => {
  if (!modalDelete || !confirm('Xoá mục này?')) return;
  await modalDelete(); closeModal(); await load();
});
const field = (label, input) => h('label', {}, label, input);

function openEventModal(e, dayKey) {
  if (e && e.origin === 'google') {
    openModal({
      title: e.title, readonly: true,
      body: [h('div', { class: 'readonly' }, fDay(e.start), ' · ', timeRange(e)),
        e.note && h('div', { class: 'readonly' }, e.note),
        h('p', { class: 'small muted' }, `Từ Google Lịch${e.calendar ? ` "${e.calendar}"` : ''}. Muốn sửa, hãy sửa trên Google Lịch. `,
          e.link && h('a', { href: e.link, target: '_blank', rel: 'noopener' }, 'Mở trong Google Lịch'))],
    });
    return;
  }
  if (e && e.origin === 'ics') {
    const src = S.sources.find((s) => s.id === e.sourceId);
    openModal({
      title: e.title, readonly: true,
      body: [h('div', { class: 'readonly' }, fDay(e.start), ' · ', timeRange(e)),
        e.note && h('div', { class: 'readonly' }, e.note),
        h('p', { class: 'small muted' }, `Đồng bộ từ "${src?.name || 'nguồn ICS'}". Muốn sửa, hãy sửa ở lịch gốc.`)],
    });
    return;
  }
  const base = dayKey ? fromKey(dayKey) : new Date();
  const defStart = new Date(base); defStart.setHours(9, 0, 0, 0);
  const title = h('input', { name: 'title', required: true, placeholder: 'Tên lịch hẹn', value: e?.title || '' });
  const allDay = h('input', { type: 'checkbox', checked: Boolean(e?.allDay) });
  const type = e?.allDay ? 'date' : 'datetime-local';
  const start = h('input', { type, required: true });
  const end = h('input', { type });
  const note = h('textarea', { rows: 3, placeholder: 'Địa điểm, link, ghi chú…' }); note.value = e?.note || '';
  const setType = () => {
    const sv = start.value; const ev = end.value;
    start.type = end.type = allDay.checked ? 'date' : 'datetime-local';
    start.value = allDay.checked ? sv.slice(0, 10) : sv.length === 10 ? `${sv}T09:00` : sv;
    end.value = allDay.checked ? ev.slice(0, 10) : ev.length === 10 ? `${ev}T10:00` : ev;
  };
  start.value = toLocalInput(e?.start || defStart.toISOString());
  end.value = e?.end ? toLocalInput(e.end) : e ? '' : toLocalInput(new Date(defStart.getTime() + 3600e3).toISOString());
  if (e?.allDay) { start.value = toLocalInput(e.start).slice(0, 10); end.value = ''; }
  allDay.addEventListener('change', setType);
  // Đổi giờ bắt đầu thì dời giờ kết thúc theo, giữ nguyên độ dài.
  let prevStart = start.value;
  start.addEventListener('change', () => {
    if (!allDay.checked && end.value && prevStart) {
      const dur = new Date(end.value) - new Date(prevStart);
      if (dur > 0) end.value = toLocalInput(new Date(new Date(start.value).getTime() + dur).toISOString());
    }
    prevStart = start.value;
  });
  const toIso = (v) => (!v ? null : v.length === 10 ? fromKey(v).toISOString() : fromLocalInput(v));
  openModal({
    title: e ? 'Sửa lịch' : 'Thêm lịch',
    body: [field('Tiêu đề', title), h('label', { class: 'inline' }, allDay, 'Cả ngày'),
      h('div', { class: 'two' }, field('Bắt đầu', start), field('Kết thúc', end)), field('Ghi chú', note),
      e && h('p', { class: 'small muted' }, `Nguồn: ${originLabel(e.origin)}`)],
    onSave: async () => {
      const body = { title: title.value.trim(), allDay: allDay.checked, start: toIso(start.value), end: allDay.checked ? null : toIso(end.value), note: note.value };
      if (body.end && body.end < body.start) throw new Error('Giờ kết thúc phải sau giờ bắt đầu');
      if (e) await api('PATCH', `/api/me/events/${e.id}`, body); else await api('POST', '/api/me/events', body);
      cal.sel = dkey(body.start); toast(e ? 'Đã lưu' : 'Đã thêm lịch');
    },
    onDelete: e && (() => api('DELETE', `/api/me/events/${e.id}`)),
  });
}

function openTaskModal(t) {
  const title = h('input', { required: true, value: t.title });
  const quad = h('select', {}, [[1, 'Gấp & quan trọng'], [2, 'Quan trọng'], [3, 'Gấp'], [4, 'Để sau']]
    .map(([q, l]) => h('option', { value: q, selected: q === t.quadrant }, l)));
  const deadline = h('input', { type: 'datetime-local', value: toLocalInput(t.deadline) });
  const note = h('textarea', { rows: 3 }); note.value = t.note || '';
  const done = h('input', { type: 'checkbox', checked: t.done });
  openModal({
    title: 'Sửa công việc',
    body: [field('Tên việc', title), h('div', { class: 'two' }, field('Mức ưu tiên', quad), field('Hạn chót', deadline)),
      field('Ghi chú', note), h('label', { class: 'inline' }, done, 'Đã xong')],
    onSave: () => api('PATCH', `/api/me/tasks/${t.id}`, {
      title: title.value.trim(), quadrant: Number(quad.value), deadline: fromLocalInput(deadline.value), note: note.value, done: done.checked,
    }),
    onDelete: () => api('DELETE', `/api/me/tasks/${t.id}`),
  });
}

// ---------- Công việc ----------
function taskItem(t, compact = false) {
  const overdue = t.deadline && !t.done && new Date(t.deadline) < new Date();
  return h('li', { class: t.done ? 'done' : '' },
    h('input', { type: 'checkbox', checked: t.done, 'aria-label': 'Xong', onchange: guard(async (e) => {
      await api('PATCH', `/api/me/tasks/${t.id}`, { done: e.target.checked });
      if (e.target.checked) toast('Tốt lắm! ✅');
      await load();
    }) }),
    h('div', { class: 'grow' },
      h('span', { class: 'title', onclick: () => openTaskModal(t) }, t.title),
      (t.deadline || t.note) && h('span', { class: 'meta' },
        t.deadline && h('span', { class: overdue ? 'overdue' : '' }, `${overdue ? 'Quá hạn' : 'Hạn'} ${fDT(t.deadline)}`),
        t.deadline && t.note && ' · ', t.note && t.note.slice(0, 80))),
    !compact && !t.done && h('select', { class: 'sm', 'aria-label': 'Chuyển ô', onchange: guard(async (e) => {
      await api('PATCH', `/api/me/tasks/${t.id}`, { quadrant: Number(e.target.value) }); await load();
    }) }, [1, 2, 3, 4].map((q) => h('option', { value: q, selected: q === t.quadrant }, `Ô ${q}`))),
    compact && h('span', { class: 'tag' }, `Ô ${t.quadrant}`),
    !compact && h('button', { class: 'btn icon ghost', 'aria-label': 'Xoá', onclick: guard(async () => {
      if (!confirm(`Xoá "${t.title}"?`)) return;
      await api('DELETE', `/api/me/tasks/${t.id}`); await load();
    }) }, icon('trash')));
}
function renderTasks() {
  const open = S.tasks.filter((t) => !t.done).sort((a, b) => (a.deadline || '9').localeCompare(b.deadline || '9'));
  $$('.matrix ul').forEach((ul) => {
    const items = open.filter((t) => t.quadrant === Number(ul.dataset.q));
    ul.replaceChildren(...(items.length ? items.map((t) => taskItem(t)) : [empty('Trống')]));
  });
  const done = S.tasks.filter((t) => t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
  $('#done-count').textContent = done.length;
  $('#done-list').replaceChildren(...(done.length ? done.slice(0, 50).map((t) => taskItem(t)) : [empty('Chưa có')]));
}
$('#task-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  await api('POST', '/api/me/tasks', { title: f.get('title').trim(), quadrant: Number(f.get('quadrant')), deadline: fromLocalInput(f.get('deadline')) });
  ev.target.reset(); ev.target.quadrant.value = '2'; toast('Đã thêm việc'); await load();
}));

// ---------- Đề xuất ----------
function renderInbox() {
  const n = S.suggestions.length;
  $('#approve-all').disabled = !n;
  $('#suggestions').replaceChildren(...(n ? S.suggestions.map((s) => {
    const title = h('input', { value: s.title, class: 't', 'aria-label': 'Tiêu đề' });
    const kind = h('select', { 'aria-label': 'Loại' }, h('option', { value: 'event', selected: s.kind === 'event' }, '📅 Lịch'),
      h('option', { value: 'task', selected: s.kind === 'task' }, '✅ Việc'));
    const when = h('input', { type: 'datetime-local', 'aria-label': 'Thời gian', value: toLocalInput(s.kind === 'event' ? s.start : s.deadline) });
    const quad = h('select', { 'aria-label': 'Ưu tiên' }, [1, 2, 3, 4].map((q) => h('option', { value: q, selected: q === s.quadrant }, `Ô ${q}`)));
    return h('li', {},
      h('div', { class: 'sugg-fields' }, kind, title, when, quad,
        h('div', { class: 'sugg-meta' }, `Nguồn: ${originLabel(s.origin)}`, s.end ? ` · đến ${fTime(s.end)}` : '', s.note ? ` · ${s.note}` : '')),
      h('div', { class: 'sugg-actions' },
        h('button', { class: 'btn sm primary', onclick: guard(async () => {
          const k = kind.value; const iso = fromLocalInput(when.value);
          if (k === 'event' && !iso) throw new Error('Lịch cần có thời gian');
          const body = { kind: k, title: title.value.trim(), quadrant: Number(quad.value) };
          if (k === 'event') {
            body.start = iso;
            // Dời giờ bắt đầu thì dời luôn giờ kết thúc.
            if (s.end && s.start && iso !== s.start) body.end = new Date(new Date(iso).getTime() + (new Date(s.end) - new Date(s.start))).toISOString();
          } else body.deadline = iso;
          await api('POST', `/api/me/suggestions/${s.id}/approve`, body);
          toast('Đã duyệt'); await load();
        }) }, 'Duyệt'),
        h('button', { class: 'btn sm ghost', onclick: guard(async () => { await api('POST', `/api/me/suggestions/${s.id}/reject`); await load(); }) }, 'Bỏ')));
  }) : [empty('Không có đề xuất nào. Dán nội dung ở trên, nhắn cho bot Zalo, hoặc thêm nguồn trang web.')]));
}
$('#extract-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const btn = $('#extract-btn'); const msg = $('#extract-msg');
  btn.disabled = true; msg.textContent = 'Đang phân tích…'; msg.className = 'small muted';
  try {
    const r = await api('POST', '/api/me/extract', { text: ev.target.text.value });
    msg.textContent = r.found ? `Tìm thấy ${r.found} mục, thêm ${r.added.length} mục mới.` : 'Không tìm thấy lịch hay việc nào.';
    msg.className = 'small ok';
    if (r.added.length) ev.target.reset();
    await load();
  } catch (e) {
    msg.textContent = e.message; msg.className = 'small err';
  } finally { btn.disabled = false; }
}));
$('#approve-all').onclick = guard(async () => {
  const r = await api('POST', '/api/me/suggestions/approve-all'); toast(`Đã duyệt ${r.approved} mục`); await load();
});

// ---------- Nguồn ----------
let sourceType = 'ics';
const SOURCE_HINT = {
  ics: 'Sự kiện được đưa thẳng vào lịch và tự cập nhật. Google Calendar: Cài đặt lịch → "Địa chỉ bí mật ở định dạng iCal".',
  web: 'AI đọc trang (thông báo, lịch sự kiện…) mỗi khi nội dung thay đổi, rồi đưa vào mục Đề xuất để bạn duyệt.',
};
function setSourceType(t) {
  sourceType = t;
  $$('#source-type button').forEach((b) => b.classList.toggle('on', b.dataset.type === t));
  $('#source-hint').textContent = SOURCE_HINT[t];
}
$$('#source-type button').forEach((b) => b.addEventListener('click', () => setSourceType(b.dataset.type)));
setSourceType('ics');

function renderSources() {
  $('#sources').replaceChildren(...(S.sources.length ? S.sources.map((s) => {
    const count = S.events.filter((e) => e.sourceId === s.id).length;
    return h('li', {},
      h('span', { class: 'tag' }, s.type === 'ics' ? 'ICS' : 'WEB'),
      h('div', { class: 'grow' }, h('b', {}, s.name),
        h('span', { class: 'meta' }, s.url),
        h('span', { class: 'meta ' + (s.lastError ? 'err' : '') },
          s.lastError ? `Lỗi: ${s.lastError}` : s.lastSync ? `Cập nhật ${fDT(s.lastSync)}${s.type === 'ics' ? ` · ${count} sự kiện` : ''}` : 'Chưa đồng bộ')),
      h('button', { class: 'btn icon ghost', 'aria-label': 'Đồng bộ', onclick: guard(async (ev) => {
        ev.currentTarget.disabled = true;
        const r = await api('POST', `/api/me/sources/${s.id}/sync`);
        toast(r.ok ? (r.events != null ? `Đã cập nhật ${r.events} sự kiện` : r.unchanged ? 'Không có gì mới' : `${r.added} đề xuất mới`) : r.error);
        await load();
      }) }, icon('refresh')),
      h('button', { class: 'btn icon ghost', 'aria-label': 'Xoá', onclick: guard(async () => {
        if (!confirm(`Xoá nguồn "${s.name}" (và các sự kiện của nó)?`)) return;
        await api('DELETE', `/api/me/sources/${s.id}`); await load();
      }) }, icon('trash')));
  }) : [empty('Chưa có nguồn nào')]));
}
$('#source-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const btn = ev.target.querySelector('button.primary'); btn.disabled = true;
  try {
    const r = await api('POST', '/api/me/sources', { type: sourceType, name: f.get('name'), url: f.get('url') });
    toast(r.result?.ok ? 'Đã thêm và đồng bộ nguồn' : `Đã thêm, nhưng đồng bộ lỗi: ${r.result?.error}`, 5000);
    ev.target.reset(); await load();
  } finally { btn.disabled = false; }
}));
$('#sync-all').onclick = guard(async () => { await api('POST', '/api/me/sources/sync'); toast('Đã đồng bộ'); await load(); });

// ---------- Pomodoro ----------
const RING = 2 * Math.PI * 52;
const pomo = { running: false, mode: 'work', endAt: 0, left: 25 * 60, timer: null };
const pomoLen = () => Number($(pomo.mode === 'work' ? '#pomo-work' : '#pomo-break').value || 1) * 60;
function pomoDraw() {
  const s = Math.max(0, Math.round(pomo.left));
  const txt = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  $('#pomo-time').textContent = txt;
  $('#pomo-mode').textContent = pomo.mode === 'work' ? 'Tập trung' : 'Nghỉ ngơi';
  $('.pomo').classList.toggle('break', pomo.mode !== 'work');
  $('#pomo-start').textContent = pomo.running ? 'Tạm dừng' : 'Bắt đầu';
  const ring = $('#pomo-ring');
  ring.style.strokeDasharray = RING;
  ring.style.strokeDashoffset = RING * (1 - Math.max(0, pomo.left) / pomoLen());
  document.title = pomo.running ? `${txt} · ${pomo.mode === 'work' ? 'Tập trung' : 'Nghỉ'}` : 'iforgotmywayhome';
}
function beep() {
  try {
    const ctx = new AudioContext();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.2, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
    });
  } catch {}
}
async function pomoFinish() {
  beep();
  const wasWork = pomo.mode === 'work';
  if (wasWork) {
    try { await api('POST', '/api/me/pomodoros', { minutes: Number($('#pomo-work').value), taskId: $('#pomo-task').value || null }); await load(); } catch {}
  }
  pomo.mode = wasWork ? 'break' : 'work';
  pomo.left = pomoLen(); pomo.endAt = Date.now() + pomo.left * 1000;
  const msg = wasWork ? 'Hết phiên tập trung! Nghỉ chút nhé ☕' : 'Hết giờ nghỉ, quay lại làm việc 💪';
  toast(msg, 6000);
  if ('Notification' in window && Notification.permission === 'granted') new Notification(msg);
}
function pomoTick() {
  pomo.left = (pomo.endAt - Date.now()) / 1000;
  if (pomo.left <= 0) pomoFinish();
  pomoDraw();
}
$('#pomo-start').onclick = () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  pomo.running = !pomo.running;
  if (pomo.running) { pomo.endAt = Date.now() + pomo.left * 1000; pomo.timer = setInterval(pomoTick, 500); } else clearInterval(pomo.timer);
  pomoDraw();
};
$('#pomo-reset').onclick = () => { clearInterval(pomo.timer); pomo.running = false; pomo.mode = 'work'; pomo.left = pomoLen(); pomoDraw(); };
['#pomo-work', '#pomo-break'].forEach((sel) => $(sel).addEventListener('change', () => { if (!pomo.running) { pomo.left = pomoLen(); pomoDraw(); } }));

function renderPomoStats() {
  const counts = {};
  for (const p of S.pomodoros) counts[dkey(p.at)] = (counts[dkey(p.at)] || 0) + 1;
  const days = [...Array(7)].map((_, i) => addDays(new Date(), i - 6));
  const vals = days.map((d) => counts[dkey(d)] || 0);
  const max = Math.max(1, ...vals);
  $('#pomo-chart').replaceChildren(...days.map((d, i) => h('div', { class: i === 6 ? 'today' : '', title: `${vals[i]} phiên` },
    h('span', { style: `height:${(vals[i] / max) * 100}%` }), WD[(d.getDay() + 6) % 7])));
}


// ---------- Khởi động ----------
async function boot() {
  const res = await fetch('/api/me').catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res || (res.status !== 200 && res.status !== 401)) {
    showScreen('signin');
    $('#signin-body').replaceChildren(h('p', { class: 'err' }, data.error || 'Không kết nối được máy chủ.'),
      h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Thử lại'));
    return;
  }
  if (res.status === 401) { termsVersion = data.termsVersion; googleReady = data.googleReady !== false; renderSignIn(); return; }
  ME = data;
  termsVersion = data.termsCurrent;
  if (data.needsTerms) { renderTerms(); return; }
  showScreen('app');
  buildNav();
  $('#side-user').textContent = `${data.name} · ${ROLE_LABEL[data.role] || data.role}`;
  setView(fromHash());
  await guard(load)();
  setView(fromHash());
}

// Quay về từ trang đăng nhập Google: báo kết quả rồi xoá tham số khỏi địa chỉ.
const qs = new URLSearchParams(location.search);
if (qs.has('google') || qs.has('google_error')) {
  const err = qs.get('google_error');
  const done = { 'member-new': 'Đã tạo tài khoản 🎉', member: 'Đã đăng nhập' };
  const calendar = { on: ' Google Lịch đã kết nối: lịch được giao sẽ tự vào Google Lịch.', 'no-scope': ' Bạn chưa cho phép Google Lịch, có thể bật ở mục Tài khoản.' }[qs.get('calendar')] || '';
  history.replaceState(null, '', location.pathname + location.hash);
  setTimeout(() => toast(err ? `⚠️ ${err}` : `${done[qs.get('google')] || 'Xong'}.${calendar}`, 8000), 400);
}
try { const m = localStorage.getItem('calMode'); if (m === 'week' || m === 'month') cal.mode = m; } catch {}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
pomoDraw();
boot();
setInterval(() => { if (!document.hidden && ME && S && !modal.open && !$('#app').hidden && view !== 'account' && !view.startsWith('admin')) guard(load)(); }, 60000);
