// Mục "Tài khoản": hồ sơ, Google Lịch, liên kết Zalo, lịch đã được ghi vào Google Lịch, điều khoản, xoá tài khoản.
import { h, icon, googleIcon, api, toast, guard, fTime, fDT, copyBox, ROLE_LABEL } from './ui.js';

const OP = { create: 'Thêm', update: 'Sửa', delete: 'Xoá' };
const GSTATUS = {
  connected: ['ok', 'Đã kết nối: lịch được giao tự vào Google Lịch của bạn, không cần mở web.'],
  reconnect: ['warn', 'Quyền Google Lịch đã bị gỡ hoặc hết hiệu lực. Bấm "Kết nối lại" (một lần) để tiếp tục.'],
  'no-scope': ['warn', 'Bạn chưa cho phép Google Lịch khi đăng nhập. Bấm "Cho phép Google Lịch" để lịch được giao tự vào lịch của bạn.'],
  off: ['muted', 'Chưa kết nối Google Lịch.'],
};
let timer = null;

export async function renderAccount(root, ctx) {
  clearInterval(timer);
  let me = await ctx.refresh();
  const rerender = () => renderAccount(root, ctx);

  // ----- Hồ sơ -----
  const profile = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Hồ sơ')),
    h('p', {}, h('b', {}, me.name), ' · ', me.email, ' ', h('span', { class: `badge ${me.role === 'owner' ? 'gold' : me.role === 'technician' ? 'lake' : 'muted'}` }, ROLE_LABEL[me.role] || me.role)),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => ctx.signOut() }, icon('logout'), 'Đăng xuất')));

  // ----- Google Lịch -----
  const g = me.google;
  const [tone, text] = GSTATUS[g.status] || GSTATUS.off;
  const googleCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, googleIcon(), ' Google Lịch')),
    h('p', { class: tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'muted' }, text),
    g.email && g.status === 'connected' ? h('p', { class: 'small muted' }, `Tài khoản Google: ${g.email}`) : '',
    g.status === 'connected' ? h('p', { class: 'small muted' }, g.lastSync ? `Đồng bộ lần cuối ${fDT(g.lastSync)}.` : 'Chưa đồng bộ lần nào.') : '',
    g.lastError ? h('p', { class: 'small err' }, `Lỗi gần nhất: ${g.lastError}`) : '',
    h('div', { class: 'row' },
      g.status === 'connected'
        ? [h('button', { class: 'btn sm', type: 'button', onclick: guard(async (ev) => {
          ev.currentTarget.disabled = true;
          try { const r = await api('POST', '/api/me/google/sync'); toast(r.sync?.pulled?.ok === false ? `⚠️ ${r.sync.pulled.error}` : 'Đã đồng bộ'); } finally { await rerender(); }
        }) }, icon('refresh'), 'Đồng bộ ngay'),
        h('button', { class: 'btn sm ghost danger', type: 'button', onclick: guard(async () => {
          if (!confirm('Ngắt Google Lịch? Lịch được giao sẽ không tự vào Google Lịch nữa. Lịch đã có trong Google Lịch vẫn giữ nguyên.')) return;
          await api('DELETE', '/api/me/google'); toast('Đã ngắt Google Lịch'); await rerender();
        }) }, 'Ngắt kết nối')]
        : h('a', { class: 'btn primary google-btn', href: '/api/google/start?purpose=calendar-member' }, googleIcon(), g.status === 'reconnect' ? 'Kết nối lại Google Lịch' : 'Cho phép Google Lịch')),
    h('p', { class: 'small muted' }, 'Quyền Google cấp là "xem và sửa sự kiện". Web chỉ ghi các lịch được giao cho bạn và hiện lịch của bạn trên trang Lịch. Quyền được giữ mã hoá trên máy chủ và bạn thu hồi được ở ',
      h('a', { href: 'https://myaccount.google.com/permissions', target: '_blank', rel: 'noopener' }, 'myaccount.google.com/permissions'), '.'));

  // ----- Zalo -----
  const zaloBody = h('div', {});
  const zaloCard = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, icon('chat'), ' Zalo')), zaloBody);
  const drawZalo = (code) => {
    if (me.zalo) {
      zaloBody.replaceChildren(h('p', { class: 'ok' }, `Đã liên kết${me.zalo.name ? `: ${me.zalo.name}` : ''}.`),
        h('p', { class: 'small muted' }, 'Lịch được giao cho bạn trong nhóm Zalo sẽ tự vào Google Lịch.'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: guard(async () => {
          if (!confirm('Gỡ liên kết Zalo? Bot sẽ không giao lịch cho bạn nữa cho tới khi liên kết lại.')) return;
          await api('DELETE', '/api/me/zalo'); await rerender();
        }) }, 'Gỡ liên kết'));
    } else if (code) {
      const left = Math.max(0, Math.round((code.until - Date.now()) / 60000));
      zaloBody.replaceChildren(
        h('p', {}, `Mở Zalo, nhắn riêng cho bot${code.botName ? ` ${code.botName}` : ''} đúng 6 số này. Mã dùng một lần, hết hạn sau ${left} phút.`),
        h('div', { class: 'code-big', 'aria-label': `Mã ${code.code.split('').join(' ')}` }, code.code),
        h('div', { class: 'row' },
          code.botChatUrl ? h('a', { class: 'btn primary', href: code.botChatUrl, target: '_blank', rel: 'noopener' }, icon('chat'), 'Mở Zalo chat với bot') : '',
          h('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(code.code); toast('Đã chép mã'); } catch { toast(`Mã: ${code.code}`); } } }, 'Chép mã')),
        h('p', { class: 'small muted' }, 'Trang tự nhận ra khi bot đã liên kết xong.'));
      clearInterval(timer);
      timer = setInterval(guard(async () => {
        if (!root.isConnected || !root.closest('.view.on') || document.hidden) return;
        if (Date.now() > code.until) { clearInterval(timer); drawZalo(null); return; }
        const { zalo } = await api('GET', '/api/me/zalo');
        if (zalo) { clearInterval(timer); toast('Đã liên kết Zalo 🎉'); await rerender(); }
      }), 5000);
    } else {
      zaloBody.replaceChildren(h('p', { class: 'muted small' }, 'Để bot biết bạn là ai khi được nhắc (@tag) trong nhóm Zalo.'),
        h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => {
          const d = await api('POST', '/api/me/zalo-code');
          drawZalo({ ...d, until: Date.now() + d.expiresInMinutes * 60_000 });
        }) }, 'Lấy mã liên kết'));
    }
  };
  drawZalo(null);

  // ----- Lịch đã ghi vào Google Lịch -----
  const { history } = await api('GET', '/api/me/history');
  const items = history.map((x) => h('li', { class: 'hist' },
    h('span', { class: `badge ${x.ok ? x.op : 'terra'}` }, x.ok ? OP[x.op] || x.op : 'Lỗi'),
    h('div', { class: 'grow' }, h('b', {}, x.title || '(không tên)'),
      h('span', { class: 'meta' }, x.op === 'delete' ? 'đã xoá khỏi lịch' : x.allDay ? `${x.start} · cả ngày` : fDT(x.start), x.from?.sender ? ` · ${x.from.sender}` : '', x.from?.chat ? ` · ${x.from.chat}` : ''),
      x.ok ? '' : h('span', { class: 'meta err' }, x.error)),
    x.link ? h('a', { class: 'btn icon', href: x.link, target: '_blank', rel: 'noopener', 'aria-label': 'Mở trong Google Lịch', title: 'Mở trong Google Lịch' }, icon('link')) : '',
    h('time', { class: 'small muted', datetime: x.at }, fTime(x.at))));
  const historyCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Lịch được giao đã ghi vào Google Lịch')),
    items.length ? h('ul', { class: 'list' }, items) : h('p', { class: 'muted small' }, 'Chưa có. Khi ai đó giao lịch cho bạn trong nhóm Zalo, lịch sẽ hiện ở đây và trong Google Lịch. Giữ 90 ngày.'));

  const extra = [];
  if (me.calendarUrl) {
    extra.push(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, icon('calendar'), ' Đưa lịch lên điện thoại')),
      h('p', { class: 'small muted' }, 'Thêm link này vào Google Calendar (Thêm lịch → Từ URL) hoặc iPhone (Cài đặt → Lịch → Tài khoản → Thêm lịch đã đăng ký). Là lịch của riêng Owner chính; ai có link đều xem được nên đừng chia sẻ.'),
      copyBox(me.calendarUrl)));
  }

  const danger = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Điều khoản và dữ liệu')),
    h('p', { class: 'small' }, h('a', { href: '/terms.html', target: '_blank' }, 'Điều khoản dịch vụ'), ' · ', h('a', { href: '/privacy.html', target: '_blank' }, 'Chính sách quyền riêng tư'),
      ` · bạn đã đồng ý bản ${me.termsVersion}`),
    h('button', { class: 'btn sm ghost danger', type: 'button', onclick: guard(async () => {
      if (!confirm('Xoá tài khoản? Liên kết Zalo, lịch, việc, đề xuất, nguồn và quyền Google Lịch sẽ bị xoá. Lịch đã có trong Google Lịch vẫn giữ nguyên.')) return;
      if (!confirm('Chắc chắn xoá? Không hoàn tác được.')) return;
      await api('DELETE', '/api/me'); toast('Đã xoá tài khoản'); await ctx.signOut();
    }) }, icon('trash'), 'Xoá tài khoản'));

  root.replaceChildren(profile, googleCard, zaloCard, historyCard, ...extra, danger);
}
