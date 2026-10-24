// Giao diện web (JS thuần, không cần build).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let S = null; // trạng thái lấy từ server
let view = 'dashboard';
const cal = { mode: 'month', cursor: new Date(), sel: null };

// Tạo phần tử DOM an toàn (dùng textContent, không chèn HTML thô).
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
const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};

class ApiError extends Error {}
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) { showLogin(data.usernameRequired); throw new ApiError('Cần đăng nhập'); }
  if (res.status === 503 && data.setup) { showScreen(data.needsStorage ? 'setup-storage' : 'setup-admin'); throw new ApiError(data.error); }
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
const guard = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) { if (!(e instanceof ApiError)) toast('⚠️ ' + e.message, 5000); }
};

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

const originClass = (e) => (e.origin === 'ics' ? 'ics' : e.origin === 'manual' || !e.origin ? 'manual' : 'ai');
const originLabel = (o) => (o === 'ics' ? 'Lịch đồng bộ' : o === 'paste' ? 'AI (dán văn bản)' : o === 'zalo' ? 'Zalo' : o?.startsWith('web:') ? `Trang web: ${o.slice(4)}` : 'Tự thêm');
const eventsOn = (k) => S.events.filter((e) => dkey(e.start) === k)
  .sort((a, b) => (b.allDay - a.allDay) || a.start.localeCompare(b.start));
const dueOn = (k) => S.tasks.filter((t) => !t.done && t.deadline && dkey(t.deadline) === k);
const timeRange = (e) => (e.allDay ? 'Cả ngày' : e.end ? `${fTime(e.start)} – ${fTime(e.end)}` : fTime(e.start));

// ---------- Màn hình & điều hướng ----------
const SCREENS = ['login', 'setup-admin', 'setup-storage', 'app'];
function showScreen(name) {
  for (const s of SCREENS) $(`#${s}`).hidden = s !== name;
  const first = $(`#${name} input`);
  if (first) setTimeout(() => first.focus(), 50);
}
function showLogin(usernameRequired = true) {
  const u = $('#login-form').username;
  u.hidden = !usernameRequired; u.required = usernameRequired;
  showScreen('login');
}

const VIEWS = {
  dashboard: { title: 'Tổng quan', action: 'Thêm lịch' },
  calendar: { title: 'Lịch', action: 'Thêm lịch' },
  tasks: { title: 'Công việc', action: 'Thêm việc' },
  inbox: { title: 'Đề xuất', action: 'Dán nội dung' },
  sources: { title: 'Nguồn tự động', action: 'Thêm nguồn' },
  settings: { title: 'Cài đặt', action: null },
};
function setView(name) {
  view = VIEWS[name] ? name : 'dashboard';
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $$('.view').forEach((s) => s.classList.toggle('on', s.dataset.view === view));
  $('#view-title').textContent = VIEWS[view].title;
  const act = $('#top-action');
  act.hidden = !VIEWS[view].action;
  act.querySelector('span').textContent = VIEWS[view].action || '';
  try { localStorage.setItem('view', view); } catch {}
  window.scrollTo(0, 0);
}
$$('#nav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.goto)));
$('#top-action').addEventListener('click', () => {
  if (view === 'dashboard' || view === 'calendar') openEventModal(null, cal.sel || dkey(new Date()));
  else if (view === 'tasks') $('#task-form').title.focus();
  else if (view === 'inbox') $('#extract-form').text.focus();
  else if (view === 'sources') $('#source-form').url.focus();
});

async function load() {
  S = await api('GET', '/api/state');
  showScreen('app');
  render();
}
function render() {
  $('#today-label').textContent = new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const n = S.suggestions.length;
  $('#inbox-count').hidden = !n; $('#inbox-count').textContent = n;
  const banner = $('#banner');
  banner.hidden = S.config.storage !== 'tmp';
  banner.textContent = '⚠️ Chưa kết nối cơ sở dữ liệu Upstash Redis: dữ liệu có thể mất khi Vercel khởi động lại. Xem hướng dẫn ở mục Cài đặt.';
  renderDashboard(); renderCalendar(); renderTasks(); renderSources(); renderSettings(); renderPomoStats();
  // Không vẽ lại hàng chờ khi người dùng đang sửa một ô của đề xuất.
  const a = document.activeElement;
  if (!($('#suggestions').contains(a) && a.matches('input, select'))) renderInbox();
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
      e.origin === 'ics' ? h('span', { class: 'tag' }, 'ICS') : ''));
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
    await api('PUT', `/api/goals/${today}`, { goals });
    S.goals[today] = goals;
  }), 600);
}));

$('#quick-ai').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = ev.target; const msg = $('#quick-ai-msg');
  if (!f.text.value.trim()) return;
  f.querySelector('button').disabled = true; msg.textContent = 'Đang phân tích…'; msg.className = 'muted small';
  try {
    const r = await api('POST', '/api/extract', { text: f.text.value });
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
        onclick: () => { cal.sel = k; renderCalendar(); },
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
      if (e) await api('PATCH', `/api/events/${e.id}`, body); else await api('POST', '/api/events', body);
      cal.sel = dkey(body.start); toast(e ? 'Đã lưu' : 'Đã thêm lịch');
    },
    onDelete: e && (() => api('DELETE', `/api/events/${e.id}`)),
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
    onSave: () => api('PATCH', `/api/tasks/${t.id}`, {
      title: title.value.trim(), quadrant: Number(quad.value), deadline: fromLocalInput(deadline.value), note: note.value, done: done.checked,
    }),
    onDelete: () => api('DELETE', `/api/tasks/${t.id}`),
  });
}

// ---------- Công việc ----------
function taskItem(t, compact = false) {
  const overdue = t.deadline && !t.done && new Date(t.deadline) < new Date();
  return h('li', { class: t.done ? 'done' : '' },
    h('input', { type: 'checkbox', checked: t.done, 'aria-label': 'Xong', onchange: guard(async (e) => {
      await api('PATCH', `/api/tasks/${t.id}`, { done: e.target.checked });
      if (e.target.checked) toast('Tốt lắm! ✅');
      await load();
    }) }),
    h('div', { class: 'grow' },
      h('span', { class: 'title', onclick: () => openTaskModal(t) }, t.title),
      (t.deadline || t.note) && h('span', { class: 'meta' },
        t.deadline && h('span', { class: overdue ? 'overdue' : '' }, `${overdue ? 'Quá hạn' : 'Hạn'} ${fDT(t.deadline)}`),
        t.deadline && t.note && ' · ', t.note && t.note.slice(0, 80))),
    !compact && !t.done && h('select', { class: 'sm', 'aria-label': 'Chuyển ô', onchange: guard(async (e) => {
      await api('PATCH', `/api/tasks/${t.id}`, { quadrant: Number(e.target.value) }); await load();
    }) }, [1, 2, 3, 4].map((q) => h('option', { value: q, selected: q === t.quadrant }, `Ô ${q}`))),
    compact && h('span', { class: 'tag' }, `Ô ${t.quadrant}`),
    !compact && h('button', { class: 'btn icon ghost', 'aria-label': 'Xoá', onclick: guard(async () => {
      if (!confirm(`Xoá "${t.title}"?`)) return;
      await api('DELETE', `/api/tasks/${t.id}`); await load();
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
  await api('POST', '/api/tasks', { title: f.get('title').trim(), quadrant: Number(f.get('quadrant')), deadline: fromLocalInput(f.get('deadline')) });
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
          await api('POST', `/api/suggestions/${s.id}/approve`, body);
          toast('Đã duyệt'); await load();
        }) }, 'Duyệt'),
        h('button', { class: 'btn sm ghost', onclick: guard(async () => { await api('POST', `/api/suggestions/${s.id}/reject`); await load(); }) }, 'Bỏ')));
  }) : [empty('Không có đề xuất nào. Dán nội dung ở trên, nhắn cho bot Zalo, hoặc thêm nguồn trang web.')]));
}
$('#extract-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const btn = $('#extract-btn'); const msg = $('#extract-msg');
  btn.disabled = true; msg.textContent = 'Đang phân tích…'; msg.className = 'small muted';
  try {
    const r = await api('POST', '/api/extract', { text: ev.target.text.value });
    msg.textContent = r.found ? `Tìm thấy ${r.found} mục, thêm ${r.added.length} mục mới.` : 'Không tìm thấy lịch hay việc nào.';
    msg.className = 'small ok';
    if (r.added.length) ev.target.reset();
    await load();
  } catch (e) {
    msg.textContent = e.message; msg.className = 'small err';
  } finally { btn.disabled = false; }
}));
$('#approve-all').onclick = guard(async () => {
  const r = await api('POST', '/api/suggestions/approve-all'); toast(`Đã duyệt ${r.approved} mục`); await load();
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
        const r = await api('POST', `/api/sources/${s.id}/sync`);
        toast(r.ok ? (r.events != null ? `Đã cập nhật ${r.events} sự kiện` : r.unchanged ? 'Không có gì mới' : `${r.added} đề xuất mới`) : r.error);
        await load();
      }) }, icon('refresh')),
      h('button', { class: 'btn icon ghost', 'aria-label': 'Xoá', onclick: guard(async () => {
        if (!confirm(`Xoá nguồn "${s.name}" (và các sự kiện của nó)?`)) return;
        await api('DELETE', `/api/sources/${s.id}`); await load();
      }) }, icon('trash')));
  }) : [empty('Chưa có nguồn nào')]));
}
$('#source-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const btn = ev.target.querySelector('button.primary'); btn.disabled = true;
  try {
    const r = await api('POST', '/api/sources', { type: sourceType, name: f.get('name'), url: f.get('url') });
    toast(r.result?.ok ? 'Đã thêm và đồng bộ nguồn' : `Đã thêm, nhưng đồng bộ lỗi: ${r.result?.error}`, 5000);
    ev.target.reset(); await load();
  } finally { btn.disabled = false; }
}));
$('#sync-all').onclick = guard(async () => { await api('POST', '/api/sources/sync'); toast('Đã đồng bộ'); await load(); });

// ---------- Cài đặt ----------
let pairCode = null;
function statusRow(ok, title, detail) {
  return h('li', {}, h('span', { class: `dot ${ok ? 'on' : 'off'}` }), h('div', { class: 'grow' }, h('b', {}, title), detail && h('span', { class: 'meta' }, detail)));
}
function copyBox(value) {
  const inp = h('input', { readonly: true, value });
  return h('div', { class: 'copy' }, inp, h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Sao chép', onclick: () => copy(inp) }, icon('copy')));
}
async function copy(inp) {
  try { await navigator.clipboard.writeText(inp.value); } catch { inp.select(); document.execCommand('copy'); }
  toast('Đã sao chép');
}
$$('[data-copy]').forEach((b) => b.addEventListener('click', () => copy($(b.dataset.copy))));

function renderSettings() {
  const c = S.config;
  const storageText = { redis: ['Upstash Redis', 'Dữ liệu lưu online, an toàn.'], file: ['File trên máy', 'data/db.json'],
    tmp: ['Tạm thời (/tmp)', 'Cần thêm Upstash Redis: Vercel → Storage → Upstash → Connect.'] }[c.storage];
  $('#status').replaceChildren(
    statusRow(c.gemini, 'AI Gemini', c.gemini ? `Model ${c.geminiModel}` : 'Thiếu GEMINI_API_KEY'),
    statusRow(c.storage !== 'tmp', `Lưu trữ: ${storageText[0]}`, storageText[1]),
    statusRow(c.zalo, 'Zalo Bot', c.zalo ? `Chế độ ${c.zaloMode === 'webhook' ? 'webhook' : 'polling (trên máy)'}` : 'Thiếu ZALO_BOT_TOKEN'),
    statusRow(Boolean(c.zaloOwner), 'Nhận nhắc việc qua Zalo', c.zaloOwner ? `Đã kết nối${c.zaloOwner.name ? ` với ${c.zaloOwner.name}` : ''}` : 'Chưa ghép nối'),
    statusRow(c.auth.mode !== 'none', 'Bảo vệ bằng mật khẩu', c.auth.mode === 'none' ? 'Chưa có tài khoản' : c.auth.username ? `Tài khoản ${c.auth.username}` : 'Đặt bằng APP_PASSWORD'));

  $('#side-status').replaceChildren(
    h('span', {}, h('i', { class: `dot ${c.gemini ? 'on' : 'off'}` }), 'Gemini'),
    h('span', {}, h('i', { class: `dot ${c.zaloOwner ? 'on' : 'off'}` }), 'Zalo'),
    h('span', {}, h('i', { class: `dot ${c.storage !== 'tmp' ? 'on' : 'off'}` }), 'Lưu trữ'));

  const z = $('#zalo-box');
  if (!c.zalo) {
    z.replaceChildren(h('p', { class: 'muted small' }, 'Chưa có ZALO_BOT_TOKEN. Thêm biến này vào cấu hình (Vercel → Settings → Environment Variables) rồi deploy lại.'));
  } else {
    const steps = [];
    if (c.zaloMode === 'webhook') {
      steps.push(h('li', {}, h('b', {}, 'Kết nối webhook'), ' (làm 1 lần sau khi deploy) ',
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: guard(async (ev) => {
          ev.currentTarget.disabled = true;
          try { const r = await api('POST', '/api/zalo/webhook-setup', { baseUrl: location.origin }); toast(`Đã đăng ký webhook: ${r.url}`, 5000); } finally { ev.currentTarget.disabled = false; }
        }) }, 'Kết nối webhook'))));
    }
    if (c.zaloOwner) {
      steps.push(h('li', {}, h('b', {}, 'Đã ghép nối'), c.zaloOwner.name ? ` với ${c.zaloOwner.name}` : '',
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: guard(async () => { await api('POST', '/api/zalo/test'); toast('Đã gửi tin thử. Kiểm tra Zalo nhé!'); }) }, 'Gửi tin thử'),
          !c.zaloOwner.fromEnv && h('button', { class: 'btn sm ghost danger', onclick: guard(async () => {
            if (!confirm('Ngắt kết nối Zalo?')) return;
            await api('POST', '/api/zalo/unpair'); await load();
          }) }, 'Ngắt kết nối'))));
    } else {
      steps.push(h('li', {}, h('b', {}, 'Ghép nối tài khoản Zalo của bạn'),
        pairCode
          ? h('div', {}, h('div', { class: 'code-big' }, pairCode),
            h('p', { class: 'small' }, 'Mở Zalo, nhắn cho bot: ', h('code', {}, `/ketnoi ${pairCode}`), ' (mã hết hạn sau 15 phút)'),
            h('button', { class: 'btn sm', onclick: guard(async () => { await load(); if (S.config.zaloOwner) { pairCode = null; toast('Đã kết nối Zalo!'); render(); } else toast('Chưa thấy kết nối, thử lại sau vài giây'); }) }, 'Tôi đã gửi, kiểm tra lại'))
          : h('div', { class: 'row' }, h('button', { class: 'btn sm primary', onclick: guard(async () => {
            pairCode = (await api('POST', '/api/zalo/pair')).code; renderSettings();
          }) }, 'Lấy mã ghép nối'))));
    }
    z.replaceChildren(h('ol', { class: 'steps' }, steps),
      h('p', { class: 'small muted' }, 'Sau khi ghép nối: gửi nội dung bất kỳ cho bot để tạo lịch; lệnh /homnay, /mai, /viec, /cho, /duyet all.'));
  }

  const cron = $('#cron-box');
  cron.replaceChildren(
    c.vercel
      ? h('div', {},
        h('p', { class: 'small' }, 'Gói miễn phí của Vercel chỉ chạy tự động 1 lần/ngày (7h sáng: đồng bộ nguồn + tóm tắt ngày qua Zalo).'),
        h('p', { class: 'small' }, 'Để được nhắc trước mỗi lịch hẹn, tạo tác vụ miễn phí tại ', h('a', { href: 'https://cron-job.org', target: '_blank', rel: 'noopener' }, 'cron-job.org'), ' gọi địa chỉ này mỗi 5 phút:'),
        copyBox(c.cronUrl.startsWith('http') ? c.cronUrl : location.origin + c.cronUrl))
      : h('p', { class: 'small' }, 'Đang chạy trên máy: tự kiểm tra mỗi phút để đồng bộ nguồn và nhắc việc.'),
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn sm', onclick: guard(async () => {
      const r = await api('POST', '/api/cron/run');
      toast(`Đã chạy: đồng bộ ${r.synced} nguồn, gửi ${r.reminders} nhắc việc${r.summary ? ', đã gửi tóm tắt' : ''}`, 5000);
      await load();
    }) }, icon('refresh'), 'Chạy ngay')));

  $('#cal-url').value = c.calendarUrl;
  $('#account-card').hidden = c.auth.mode === 'none';
  $('#account-name').textContent = c.auth.username || 'quản trị';
  $('#password-form').hidden = c.auth.mode !== 'db';
}
$('#logout').onclick = guard(async () => { await api('POST', '/api/logout'); showLogin(Boolean(S?.config.auth.username)); });
$('#password-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  await api('POST', '/api/account/password', { current: f.current.value, next: f.next.value });
  f.reset(); toast('Đã đổi mật khẩu');
}));

// ---------- Đăng nhập & tạo tài khoản ----------
async function postForm(url, body, errEl, btn) {
  errEl.hidden = true; btn.disabled = true;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra');
    return data;
  } catch (e) {
    errEl.textContent = e.message; errEl.hidden = false; return null;
  } finally { btn.disabled = false; }
}
$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const ok = await postForm('/api/login', { username: f.username.value, password: f.password.value }, $('#login-error'), f.querySelector('button'));
  if (ok) { f.reset(); await guard(load)(); }
});
$('#setup-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target; const err = $('#setup-error');
  if (f.password.value !== f.confirm.value) { err.textContent = 'Hai mật khẩu không khớp'; err.hidden = false; return; }
  const ok = await postForm('/api/setup', { username: f.username.value, password: f.password.value }, err, f.querySelector('button'));
  if (ok) { f.reset(); toast(`Đã tạo tài khoản ${ok.username}`); await guard(load)(); }
});
$('#setup-retry').onclick = () => location.reload();

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
  document.title = pomo.running ? `${txt} · ${pomo.mode === 'work' ? 'Tập trung' : 'Nghỉ'}` : 'Quản lý thời gian';
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
    try { await api('POST', '/api/pomodoros', { minutes: Number($('#pomo-work').value), taskId: $('#pomo-task').value || null }); await load(); } catch {}
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
try {
  const v = localStorage.getItem('view'); if (v) view = v;
  const m = localStorage.getItem('calMode'); if (m === 'week' || m === 'month') cal.mode = m;
} catch {}
setView(view);
pomoDraw();
guard(load)();
setInterval(() => { if (!document.hidden && !modal.open && !$('#app').hidden) guard(load)(); }, 60000);
