// Tiện ích giao diện dùng chung (JS thuần, không cần build). Không chèn HTML thô: mọi chữ đi qua textContent.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};
export function googleIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'gicon'); svg.setAttribute('viewBox', '0 0 48 48');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-google'); svg.append(use);
  return svg;
}

export class ApiError extends Error {}
// Chưa đăng nhập / điều khoản mới: giao diện đăng ký hàm xử lý để vẽ lại màn hình tương ứng.
const hooks = { signIn: () => {}, terms: () => {}, forbidden: () => {} };
export const onApiEvents = (h2) => Object.assign(hooks, h2);

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error('Không kết nối được máy chủ, kiểm tra mạng rồi thử lại');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.signIn) { hooks.signIn(data); throw new ApiError(data.error); }
  if (res.status === 403 && data.needsTerms) { hooks.terms(data); throw new ApiError(data.error); }
  if (res.status === 403 && data.forbidden) { hooks.forbidden(data); throw new ApiError(data.error); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Lỗi ${res.status}`), { status: res.status, data });
  return data;
}

export function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
export const guard = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) { if (!(e instanceof ApiError)) toast(`⚠️ ${e.message}`, 6000); }
};

// ----- Ngày giờ (theo giờ của trình duyệt) -----
export const fTime = (d) => new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
export const fDT = (d) => new Date(d).toLocaleString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const empty = (text) => h('li', { class: 'empty' }, text);

export async function copy(inp) {
  try { await navigator.clipboard.writeText(inp.value); } catch { inp.select(); document.execCommand('copy'); }
  toast('Đã sao chép');
}
export function copyBox(value) {
  const inp = h('input', { readonly: true, value });
  return h('div', { class: 'copy' }, inp, h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Sao chép', onclick: () => copy(inp) }, icon('copy')));
}
export function statusRow(ok, title, detail) {
  return h('li', {}, h('span', { class: `dot ${ok ? 'on' : 'off'}` }), h('div', { class: 'grow' }, h('b', {}, title), detail && h('span', { class: 'meta' }, detail)));
}
export const ROLE_LABEL = { owner: 'Owner', technician: 'Technician', user: 'User' };
export const can = (me, perm) => Boolean(me?.perms?.includes(perm));
