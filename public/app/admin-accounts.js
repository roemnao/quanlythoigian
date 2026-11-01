// Mục "Tài khoản người dùng" (Owner, Technician). Technician chỉ xem; chỉ Owner đổi quyền, gỡ Zalo, xoá.
import { h, icon, api, toast, guard, fDT, empty, ROLE_LABEL } from './ui.js';

const GLABEL = { connected: ['moss', 'Google Lịch: đã kết nối'], reconnect: ['gold', 'Google Lịch: cần kết nối lại'], 'no-scope': ['terra', 'Google Lịch: chưa cho phép'], off: ['muted', 'Google Lịch: chưa kết nối'] };

export async function renderAdminAccounts(root, ctx) {
  const { members, canWrite, termsVersion, me } = await api('GET', '/api/admin/members');
  const again = () => renderAdminAccounts(root, ctx);
  const rows = members.map((m) => {
    const [gTone, gText] = GLABEL[m.google?.status] || GLABEL.off;
    const role = canWrite && m.id !== me
      ? h('select', { class: 'sm', 'aria-label': `Quyền của ${m.email}`, onchange: guard(async (ev) => {
        const next = ev.target.value;
        if (!confirm(`Đổi quyền của ${m.email} thành ${ROLE_LABEL[next]}?`)) { ev.target.value = m.role; return; }
        try { await api('PUT', `/api/admin/members/${m.id}/role`, { role: next }); toast('Đã đổi quyền'); } finally { again(); }
      }) }, ['owner', 'technician', 'user'].map((r) => h('option', { value: r, selected: r === m.role }, ROLE_LABEL[r])))
      : h('span', { class: `badge ${m.role === 'owner' ? 'gold' : m.role === 'technician' ? 'lake' : 'muted'}` }, ROLE_LABEL[m.role] || m.role);
    return h('li', { class: 'member' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, (m.name || m.email)[0].toUpperCase()),
      h('div', { class: 'grow' },
        h('b', {}, m.name), ' ', h('span', { class: 'muted small' }, m.email), m.id === me ? h('span', { class: 'badge muted' }, 'bạn') : '',
        h('span', { class: 'meta' },
          m.zalo ? h('span', { class: 'badge moss' }, `Zalo: ${m.zalo.name || m.zalo.uid}`) : h('span', { class: 'badge terra' }, 'Chưa liên kết Zalo'), ' ',
          h('span', { class: `badge ${gTone}` }, gText), ' ',
          m.needsTerms ? h('span', { class: 'badge gold' }, `Chưa đồng ý điều khoản mới (bản ${m.termsVersion})`) : '', ' ',
          `Tham gia ${fDT(m.createdAt)} · ${m.lastSeenAt ? `hoạt động ${fDT(m.lastSeenAt)}` : 'chưa mở web'} · ${m.commands} lịch được giao`,
          m.google?.lastError ? h('span', { class: 'err' }, ` · lỗi Google: ${m.google.lastError}`) : '')),
      role,
      canWrite && m.zalo && h('button', { class: 'btn sm ghost', title: 'Gỡ liên kết Zalo', onclick: guard(async () => {
        if (!confirm(`Gỡ liên kết Zalo của ${m.name}? Họ sẽ không nhận lịch được giao cho tới khi liên kết lại.`)) return;
        await api('DELETE', `/api/admin/members/${m.id}/zalo`); toast('Đã gỡ liên kết'); again();
      }) }, 'Gỡ Zalo'),
      canWrite && m.id !== me && h('button', { class: 'btn sm ghost danger', title: 'Xoá tài khoản', onclick: guard(async () => {
        if (!confirm(`Xoá tài khoản ${m.email} cùng toàn bộ lịch, việc, đề xuất và quyền Google Lịch? Không hoàn tác được.`)) return;
        await api('DELETE', `/api/admin/members/${m.id}`); toast('Đã xoá'); again();
      }) }, icon('trash')));
  });
  const { audit } = await api('GET', '/api/admin/audit');
  const log = audit.map((a) => h('li', {}, h('div', { class: 'grow' }, h('b', {}, a.target), ` ${ROLE_LABEL[a.from] || a.from} → ${ROLE_LABEL[a.to] || a.to}`,
    h('span', { class: 'meta' }, `${fDT(a.at)} · bởi ${a.actor}`))));
  root.replaceChildren(
    canWrite ? '' : h('div', { class: 'banner' }, 'Bạn là Technician: chỉ xem danh sách. Đổi quyền, gỡ Zalo và xoá tài khoản chỉ Owner làm được.'),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, icon('users'), `Tài khoản (${members.length})`), h('span', { class: 'small muted' }, `Điều khoản đang dùng: bản ${termsVersion}`)),
      h('ul', { class: 'list' }, rows.length ? rows : empty('Chưa có ai. Gửi link web cho mọi người.'))),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Nhật ký phân quyền'), h('span', { class: 'small muted' }, 'Giữ 180 ngày')),
      h('ul', { class: 'list' }, log.length ? log : empty('Chưa có thay đổi quyền nào.'))));
}
