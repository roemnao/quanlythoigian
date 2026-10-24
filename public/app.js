// Giao diện web (JS thuần, không cần build).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let S = null; // trạng thái lấy từ server
let weekOffset = 0;

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

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast('⚠️ ' + e.message, 5000); } };

const dkey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const fTime = (d) => new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const fDT = (d) => new Date(d).toLocaleString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const empty = (text) => h('li', { class: 'empty' }, text);

async function load() {
  S = await api('GET', '/api/state');
  render();
}

function render() {
  renderToday(); renderWeek(); renderTasks(); renderSources(); renderPomoStats();
  // Không vẽ lại hàng chờ khi người dùng đang sửa một đề xuất.
  if (!$('#suggestions').contains(document.activeElement)) renderInbox();
}

// ---------- Tabs ----------
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  try { localStorage.setItem('tab', b.dataset.tab); } catch {}
}));
try { const t = localStorage.getItem('tab'); if (t) $(`#tabs button[data-tab="${t}"]`)?.click(); } catch {}

// ---------- Hôm nay ----------
function renderToday() {
  const today = dkey(new Date());
  const goals = S.goals[today] || [];
  $$('.goal').forEach((inp) => { if (document.activeElement !== inp) inp.value = goals[inp.dataset.i] || ''; });

  const evs = S.events.filter((e) => dkey(e.start) === today).sort((a, b) => a.start.localeCompare(b.start));
  $('#today-events').replaceChildren(...(evs.length ? evs.map((e) => h('li', {},
    h('b', {}, e.allDay ? 'Cả ngày' : fTime(e.start)), h('span', { class: 'grow' }, e.title),
    e.origin === 'ics' && h('span', { class: 'tag' }, 'ICS'))) : [empty('Không có lịch hôm nay')]));

  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
  const due = S.tasks.filter((t) => !t.done && t.deadline && new Date(t.deadline) <= endOfDay)
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
  $('#today-due').replaceChildren(...(due.length ? due.map(taskItem) : [empty('Không có việc đến hạn 🎉')]));

  const sel = $('#pomo-task'); const cur = sel.value;
  sel.replaceChildren(h('option', { value: '' }, '(không chọn)'),
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
  }), 500);
}));

// ---------- Lịch tuần ----------
function weekStart() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + weekOffset * 7); // thứ Hai
  return d;
}
function renderWeek() {
  const start = weekStart();
  const days = [...Array(7)].map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  $('#week-title').textContent = `${days[0].toLocaleDateString('vi-VN')} – ${days[6].toLocaleDateString('vi-VN')}`;
  const today = dkey(new Date());
  $('#week').replaceChildren(...days.map((d) => {
    const k = dkey(d);
    const evs = S.events.filter((e) => dkey(e.start) === k).sort((a, b) => a.start.localeCompare(b.start));
    const tasks = S.tasks.filter((t) => !t.done && t.deadline && dkey(t.deadline) === k);
    return h('div', { class: 'day' + (k === today ? ' today' : '') },
      h('h3', {}, d.toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' })),
      evs.map((e) => h('div', { class: 'ev' + (e.origin === 'ics' ? ' ics' : ''), title: e.note || '' },
        h('b', {}, e.allDay ? '' : fTime(e.start) + ' '), e.title,
        e.origin !== 'ics' && h('button', { class: 'link', title: 'Xoá', onclick: guard(async () => {
          if (!confirm(`Xoá "${e.title}"?`)) return;
          await api('DELETE', `/api/events/${e.id}`); await load();
        }) }, '×'))),
      tasks.map((t) => h('div', { class: 'ev q1' }, '⏰ ', t.title)));
  }));
}
$('#week-prev').onclick = () => { weekOffset--; renderWeek(); };
$('#week-next').onclick = () => { weekOffset++; renderWeek(); };

$('#event-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  await api('POST', '/api/events', {
    title: f.get('title'), start: fromLocalInput(f.get('start')), end: fromLocalInput(f.get('end')), note: f.get('note'),
  });
  ev.target.reset(); toast('Đã thêm lịch'); await load();
}));

// ---------- Việc (Eisenhower) ----------
function taskItem(t) {
  const overdue = t.deadline && !t.done && new Date(t.deadline) < new Date();
  return h('li', { class: t.done ? 'done' : '' },
    h('input', { type: 'checkbox', checked: t.done, onchange: guard(async (e) => {
      await api('PATCH', `/api/tasks/${t.id}`, { done: e.target.checked }); await load();
    }) }),
    h('span', { class: 'grow', title: t.note || '' }, t.title,
      t.deadline && h('span', { class: 'small ' + (overdue ? 'overdue' : 'muted') }, ` · hạn ${fDT(t.deadline)}`)),
    !t.done && h('select', { class: 'small', title: 'Chuyển ô', onchange: guard(async (e) => {
      await api('PATCH', `/api/tasks/${t.id}`, { quadrant: Number(e.target.value) }); await load();
    }) }, [1, 2, 3, 4].map((q) => h('option', { value: q, selected: q === t.quadrant }, `Ô${q}`))),
    h('button', { class: 'link', title: 'Xoá', onclick: guard(async () => {
      if (!confirm(`Xoá "${t.title}"?`)) return;
      await api('DELETE', `/api/tasks/${t.id}`); await load();
    }) }, '×'));
}
function renderTasks() {
  const open = S.tasks.filter((t) => !t.done)
    .sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
  $$('.matrix ul').forEach((ul) => {
    const items = open.filter((t) => t.quadrant === Number(ul.dataset.q));
    ul.replaceChildren(...(items.length ? items.map(taskItem) : [empty('Trống')]));
  });
  const done = S.tasks.filter((t) => t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
  $('#done-count').textContent = done.length;
  $('#done-list').replaceChildren(...done.slice(0, 50).map(taskItem));
}
$('#task-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  await api('POST', '/api/tasks', { title: f.get('title'), quadrant: Number(f.get('quadrant')), deadline: fromLocalInput(f.get('deadline')) });
  ev.target.reset(); ev.target.quadrant.value = '2'; await load();
}));

// ---------- Hàng chờ đề xuất ----------
function renderInbox() {
  const n = S.suggestions.length;
  $('#inbox-count').hidden = !n; $('#inbox-count').textContent = n;
  $('#approve-all').disabled = !n;
  $('#suggestions').replaceChildren(...(n ? S.suggestions.map((s) => {
    const title = h('input', { value: s.title, class: 'grow' });
    const kind = h('select', {}, h('option', { value: 'event', selected: s.kind === 'event' }, '📅 Lịch'),
      h('option', { value: 'task', selected: s.kind === 'task' }, '✅ Việc'));
    const when = h('input', { type: 'datetime-local', value: toLocalInput(s.kind === 'event' ? s.start : s.deadline) });
    const quad = h('select', {}, [1, 2, 3, 4].map((q) => h('option', { value: q, selected: q === s.quadrant }, `Ô${q}`)));
    return h('li', {},
      h('div', { class: 'grow' },
        h('div', { class: 'sugg-edit' }, kind, title, when, quad),
        h('div', { class: 'small muted' }, `Nguồn: ${s.origin}`, s.note ? ` · ${s.note}` : '')),
      h('button', { class: 'primary', onclick: guard(async () => {
        const k = kind.value; const iso = fromLocalInput(when.value);
        if (k === 'event' && !iso) throw new Error('Lịch cần có thời gian');
        const startChanged = k === 'event' && iso !== s.start;
        await api('POST', `/api/suggestions/${s.id}/approve`, {
          kind: k, title: title.value, quadrant: Number(quad.value),
          ...(k === 'event' ? { start: iso, ...(startChanged && s.end && s.start
            ? { end: new Date(new Date(iso).getTime() + (new Date(s.end) - new Date(s.start))).toISOString() } : {}) }
            : { deadline: iso }),
        });
        toast('Đã duyệt'); await load();
      }) }, 'Duyệt'),
      h('button', { onclick: guard(async () => { await api('POST', `/api/suggestions/${s.id}/reject`); await load(); }) }, 'Bỏ'));
  }) : [empty('Không có đề xuất nào. Dán nội dung ở trên, nhắn cho bot Zalo, hoặc thêm nguồn trang web.')]));
}
$('#extract-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const btn = $('#extract-btn'); const msg = $('#extract-msg');
  btn.disabled = true; msg.textContent = 'Đang phân tích…'; msg.className = 'small muted';
  try {
    const r = await api('POST', '/api/extract', { text: ev.target.text.value });
    msg.textContent = r.found ? `Tìm thấy ${r.found} mục, thêm ${r.added.length} mục mới vào hàng chờ.` : 'Không tìm thấy lịch hay việc nào.';
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

// ---------- Nguồn & trạng thái ----------
function renderSources() {
  $('#sources').replaceChildren(...(S.sources.length ? S.sources.map((s) => h('li', {},
    h('span', { class: 'tag' }, s.type.toUpperCase()),
    h('span', { class: 'grow' }, h('b', {}, s.name), h('br'), h('span', { class: 'small muted' }, s.url), h('br'),
      h('span', { class: 'small ' + (s.lastError ? 'err' : 'muted') },
        s.lastError ? `Lỗi: ${s.lastError}` : s.lastSync ? `Đồng bộ lúc ${fDT(s.lastSync)}` : 'Chưa đồng bộ')),
    h('button', { onclick: guard(async () => {
      const r = await api('POST', `/api/sources/${s.id}/sync`);
      toast(r.ok ? (r.events != null ? `${r.events} sự kiện` : r.unchanged ? 'Không có gì mới' : `${r.added} đề xuất mới`) : r.error);
      await load();
    }) }, '↻'),
    h('button', { class: 'link', onclick: guard(async () => {
      if (!confirm(`Xoá nguồn "${s.name}" (và các sự kiện của nó)?`)) return;
      await api('DELETE', `/api/sources/${s.id}`); await load();
    }) }, '×'))) : [empty('Chưa có nguồn nào')]));

  const c = S.config;
  const line = (ok, text) => h('li', {}, h('span', { class: ok ? 'ok' : 'err' }, ok ? '✔' : '✘'), h('span', { class: 'grow' }, text));
  $('#status').replaceChildren(
    line(c.gemini, c.gemini ? 'Gemini đã sẵn sàng' : 'Chưa có GEMINI_API_KEY (cần cho phân tích văn bản & nguồn web)'),
    line(c.zalo, c.zalo ? `Zalo Bot đã có token (chế độ ${c.zaloMode})` : 'Chưa có ZALO_BOT_TOKEN'),
    line(c.zaloChatId, c.zaloChatId ? 'Đã có ZALO_CHAT_ID – bot sẽ gửi nhắc việc' : 'Chưa có ZALO_CHAT_ID (nhắn /id cho bot để lấy)'));
  $('#zalo-test').disabled = !(c.zalo && c.zaloChatId);
}
$('#source-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const r = await api('POST', '/api/sources', { type: f.get('type'), name: f.get('name'), url: f.get('url') });
  toast(r.result.ok ? 'Đã thêm và đồng bộ nguồn' : `Đã thêm, nhưng đồng bộ lỗi: ${r.result.error}`, 5000);
  ev.target.reset(); await load();
}));
$('#sync-all').onclick = guard(async () => { await api('POST', '/api/sources/sync'); toast('Đã đồng bộ'); await load(); });
$('#zalo-test').onclick = guard(async () => { await api('POST', '/api/zalo/test'); toast('Đã gửi tin thử qua Zalo'); });

// ---------- Pomodoro ----------
const pomo = { running: false, mode: 'work', endAt: 0, left: 25 * 60, timer: null };
const pomoLen = () => Number($(pomo.mode === 'work' ? '#pomo-work' : '#pomo-break').value || 1) * 60;
function pomoDraw() {
  const s = Math.max(0, Math.round(pomo.left));
  const txt = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  $('#pomo-time').textContent = txt;
  $('#pomo-mode').textContent = pomo.mode === 'work' ? 'Tập trung' : 'Nghỉ ngơi ☕';
  $('#pomo-start').textContent = pomo.running ? 'Tạm dừng' : 'Bắt đầu';
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
  if (pomo.running) { pomo.endAt = Date.now() + pomo.left * 1000; pomo.timer = setInterval(pomoTick, 500); }
  else clearInterval(pomo.timer);
  pomoDraw();
};
$('#pomo-reset').onclick = () => { clearInterval(pomo.timer); pomo.running = false; pomo.mode = 'work'; pomo.left = pomoLen(); pomoDraw(); };
['#pomo-work', '#pomo-break'].forEach((sel) => $(sel).addEventListener('change', () => { if (!pomo.running) { pomo.left = pomoLen(); pomoDraw(); } }));

function renderPomoStats() {
  const counts = {};
  for (const p of S.pomodoros) counts[dkey(p.at)] = (counts[dkey(p.at)] || 0) + 1;
  const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 6 + i); return d; });
  const vals = days.map((d) => counts[dkey(d)] || 0);
  const max = Math.max(1, ...vals);
  $('#pomo-today').textContent = vals[6];
  $('#pomo-week').textContent = vals.reduce((a, b) => a + b, 0);
  $('#pomo-chart').replaceChildren(...days.map((d, i) => h('div', { title: `${vals[i]} phiên` },
    h('span', { style: `height:${(vals[i] / max) * 100}%` }), d.toLocaleDateString('vi-VN', { weekday: 'narrow' }))));
}

pomoDraw();
guard(load)();
setInterval(() => { if (!document.hidden) guard(load)(); }, 60000);
