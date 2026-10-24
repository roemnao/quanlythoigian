// Trang "Hệ thống" của quản trị: thành viên, nhật ký bot lịch, cấu hình bot Zalo (PyloS), session bộ lọc ↔ agent.
// Nạp trước app.js và dùng lại các hàm của nó (h, api, guard, toast, icon, copyBox, fDT) khi được gọi.
let sysTab = 'members';
const sysLog = { from: '', to: '', member: '' };
const sysSession = { chat: '', day: '' };

document.querySelectorAll('#sys-tabs button').forEach((b) => b.addEventListener('click', () => {
  sysTab = b.dataset.tab;
  try { localStorage.setItem('sysTab', sysTab); } catch {}
  renderSystem();
}));
try { const t = localStorage.getItem('sysTab'); if (t) sysTab = t; } catch {}

function renderSystem() {
  if (!SYS_TABS[sysTab]) sysTab = 'members';
  document.querySelectorAll('#sys-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === sysTab));
  const body = $('#sys-body');
  body.replaceChildren(h('p', { class: 'muted small' }, 'Đang tải…'));
  guard(async () => {
    try { await SYS_TABS[sysTab](body); } catch (e) { body.replaceChildren(h('p', { class: 'err small' }, e.message)); throw e; }
  })();
}

const dayInput = (value) => h('input', { type: 'date', value });
// "Hôm nay" theo múi giờ của máy chủ (S.today), không theo đồng hồ của trình duyệt: log và session được xếp theo ngày đó.
const shiftDay = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const OP_LABEL = { create: 'Thêm', update: 'Sửa', delete: 'Xoá' };
const opBadge = (op) => h('span', { class: `badge ${op}` }, OP_LABEL[op] || op);
const whenText = (e) => (e.allDay ? `${e.start}${e.end ? ` → ${e.end}` : ''} (cả ngày)` : `${fDT(e.start)}${e.end ? ` → ${fDT(e.end)}` : ''}`);

// ---------- Thành viên ----------
async function sysMembers(body) {
  const { members, settings, termsVersion, appUrl } = await api('GET', '/api/admin/members');
  const botName = h('input', { value: settings.botName, placeholder: 'Tên acc Zalo của bot, vd roemnao' });
  const botUrl = h('input', { value: settings.botChatUrl, placeholder: 'https://zalo.me/09xxxxxxxx' });
  const allowed = h('textarea', { rows: 2, placeholder: 'Để trống: ai có Gmail cũng tạo được tài khoản. Ví dụ: an@gmail.com, @congty.vn' });
  allowed.value = settings.allowedEmails;
  const settingsCard = h('form', { class: 'card form', onsubmit: guard(async (ev) => {
    ev.preventDefault();
    await api('PUT', '/api/admin/members/settings', { botName: botName.value, botChatUrl: botUrl.value, allowedEmails: allowed.value });
    toast('Đã lưu');
  }) },
  h('div', { class: 'card-head' }, h('h2', {}, icon('arch'), 'Web app cho thành viên')),
  h('p', { class: 'small' }, 'Gửi link này cho mọi người. Họ đăng nhập bằng Gmail, đồng ý điều khoản, gửi mã 6 số cho bot Zalo để liên kết, rồi kết nối Google Lịch. Từ đó lịch được giao trong nhóm Zalo sẽ tự vào Google Lịch của họ.'),
  copyBox(appUrl),
  h('p', { class: 'small muted' }, `Điều khoản đang dùng: bản ${termsVersion}. `, h('a', { href: '/terms.html', target: '_blank' }, 'Điều khoản'), ' · ',
    h('a', { href: '/privacy.html', target: '_blank' }, 'Chính sách quyền riêng tư')),
  h('div', { class: 'two' }, h('label', {}, 'Tên bot trên Zalo', botName), h('label', {}, 'Link mở chat với bot (nút trong app)', botUrl)),
  h('label', {}, 'Email / tên miền được tạo tài khoản', allowed),
  h('div', { class: 'row' }, h('button', { class: 'btn primary' }, 'Lưu')));

  const rows = members.map((m) => h('li', { class: 'member' },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, (m.name || m.email)[0].toUpperCase()),
    h('div', { class: 'grow' },
      h('b', {}, m.name), ' ', h('span', { class: 'muted small' }, m.email),
      h('span', { class: 'meta' },
        m.zalo ? h('span', { class: 'badge moss' }, `Zalo: ${m.zalo.name || m.zalo.uid}`) : h('span', { class: 'badge terra' }, 'Chưa liên kết Zalo'), ' ',
        m.needsTerms ? h('span', { class: 'badge gold' }, `Chưa đồng ý điều khoản mới (đang ở bản ${m.termsVersion})`) : '', ' ',
        `Tham gia ${fDT(m.createdAt)} · ${m.lastSeenAt ? `app hỏi lệnh lần cuối ${fDT(m.lastSeenAt)}` : 'chưa mở app'} · ${m.commands} lệnh đã nhận`)),
    m.zalo && h('button', { class: 'btn sm ghost', title: 'Gỡ liên kết Zalo', onclick: guard(async () => {
      if (!confirm(`Gỡ liên kết Zalo của ${m.name}? Họ sẽ không nhận lịch được giao cho tới khi liên kết lại.`)) return;
      await api('DELETE', `/api/admin/members/${m.id}/zalo`); toast('Đã gỡ liên kết'); renderSystem();
    }) }, 'Gỡ Zalo'),
    h('button', { class: 'btn sm ghost danger', title: 'Xoá tài khoản', onclick: guard(async () => {
      if (!confirm(`Xoá tài khoản ${m.email} cùng toàn bộ lệnh đang chờ? Không hoàn tác được.`)) return;
      await api('DELETE', `/api/admin/members/${m.id}`); toast('Đã xoá'); renderSystem();
    }) }, icon('trash'))));
  body.replaceChildren(settingsCard, h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, icon('users'), `Thành viên (${members.length})`)),
    h('ul', { class: 'list' }, rows.length ? rows : empty('Chưa có ai. Gửi link web app ở trên cho mọi người.'))));
}

// ---------- Nhật ký bot lịch ----------
async function sysCalbot(body) {
  if (!sysLog.to) { sysLog.to = S.today; sysLog.from = shiftDay(S.today, -6); }
  const from = dayInput(sysLog.from); const to = dayInput(sysLog.to);
  const member = h('input', { value: sysLog.member, placeholder: 'Lọc theo email hoặc ID Zalo', class: 'grow' });
  const q = () => new URLSearchParams(Object.entries({ from: sysLog.from, to: sysLog.to, member: sysLog.member }).filter(([, v]) => v));
  const filters = h('form', { class: 'card row filters', onsubmit: (ev) => {
    ev.preventDefault();
    Object.assign(sysLog, { from: from.value, to: to.value, member: member.value.trim() });
    renderSystem();
  } }, h('label', { class: 'small' }, 'Từ ', from), h('label', { class: 'small' }, 'đến ', to), member,
  h('button', { class: 'btn primary sm' }, 'Xem'),
  h('a', { class: 'btn sm', href: `/api/admin/calbot-log/csv?${q()}` }, icon('download'), 'Tải CSV'));

  const { entries } = await api('GET', `/api/admin/calbot-log?${q()}`);
  const items = entries.map((e) => h('li', { class: 'log' },
    h('div', { class: 'log-head' }, opBadge(e.op), h('b', {}, e.title), h('span', { class: 'muted small' }, whenText(e))),
    h('div', { class: 'small muted' }, `${fDT(e.at)} · `, e.source?.chatName || e.source?.chatId || 'không rõ nhóm',
      e.source?.senderName ? ` · người giao: ${e.source.senderName}` : '', ` · mã lịch ${e.eventId}`),
    h('div', { class: 'row recipients' },
      ...e.recipients.map((r) => h('span', { class: `badge ${r.fetchedAt ? 'moss' : 'gold'}`, title: r.email || '' },
        `${r.name || r.email || r.zaloUid}${r.op && r.op !== e.op ? ` (${OP_LABEL[r.op] || r.op})` : ''}: ${r.fetchedAt ? `app đã lấy ${fTime(r.fetchedAt)}` : 'app chưa lấy'}`)),
      ...e.unlinked.map((r) => h('span', { class: 'badge terra' }, `${r.name || r.zaloUid}: chưa liên kết`)),
      !e.recipients.length && !e.unlinked.length ? h('span', { class: 'muted small' }, 'không có người nhận') : '')));
  body.replaceChildren(filters, h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, icon('scroll'), `Nhật ký bot lịch (${entries.length})`),
      h('span', { class: 'small muted' }, 'Giữ 90 ngày')),
    h('ul', { class: 'list' }, items.length ? items : empty('Không có lệnh nào trong khoảng này.'))));
}

// ---------- Cấu hình bot ----------
async function sysConfig(body) {
  const { schema, config, bot } = await api('GET', '/api/admin/system');
  const inputs = {};
  const groups = [...new Set(schema.map((f) => f.group))];
  const fieldFor = (f) => {
    const v = config.values[f.key];
    let input;
    if (f.type === 'bool' || f.type === 'choice') {
      const opts = f.type === 'bool' ? [['', `Theo máy bot (mặc định ${f.placeholder === 'true' ? 'bật' : 'tắt'})`], ['true', 'Bật'], ['false', 'Tắt']]
        : [['', `Theo máy bot (mặc định ${f.placeholder})`], ...f.options.map((o) => [o, o])];
      input = h('select', {}, opts.map(([val, label]) => h('option', { value: val, selected: String(v ?? '') === val }, label)));
    } else if (f.type === 'text') {
      input = h('textarea', { rows: 6, placeholder: f.placeholder || 'Để trống = giữ nguyên file trên máy bot' });
      input.value = v ?? '';
    } else {
      input = h('input', { value: v ?? '', placeholder: f.placeholder ? `mặc định: ${f.placeholder}` : 'để trống = theo máy bot',
        inputmode: f.type === 'int' ? 'numeric' : null, spellcheck: 'false' });
    }
    inputs[f.key] = input;
    return h('label', { class: f.type === 'text' ? 'wide' : '' }, h('span', {}, f.label, ' ', h('code', {}, f.key),
      f.live ? '' : h('span', { class: 'badge gold' }, 'cần khởi động lại bot')), input);
  };
  const form = h('form', { class: 'card form', onsubmit: guard(async (ev) => {
    ev.preventDefault();
    const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value === '' ? null : el.value]));
    const saved = await api('PUT', '/api/admin/system', { values });
    toast(`Đã lưu cấu hình (bản ${saved.version}). Bot áp dụng trong vòng 1 phút.`, 5000);
    renderSystem();
  }) },
  h('div', { class: 'card-head' }, h('h2', {}, icon('compass'), 'Thông số bot Zalo'), h('span', { class: 'small muted' }, `Bản ${config.version}${config.updatedAt ? ` · sửa ${fDT(config.updatedAt)}` : ''}`)),
  h('p', { class: 'small muted' }, 'Giá trị ở đây đè lên settings.env trên máy chạy bot (để trống = dùng giá trị trên máy). Người dùng web app không thấy và không đổi được các thông số này. Khoá bí mật (Gemini, Zalo, phiên đăng nhập) không bao giờ nằm ở đây: chúng chỉ ở userdata/config trên máy bot.'),
  ...groups.map((g) => h('fieldset', { class: 'cfg-group' }, h('legend', { class: 'frieze' }, g), h('div', { class: 'cfg-grid' }, schema.filter((f) => f.group === g).map(fieldFor)))),
  h('div', { class: 'row' }, h('button', { class: 'btn primary' }, 'Lưu cấu hình')));

  const ago = bot.at ? Math.round((Date.now() - Date.parse(bot.at)) / 60000) : null;
  const statusCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, icon('flame'), 'Trạng thái bot'),
      h('span', { class: `badge ${bot.online ? 'moss' : 'terra'}` }, bot.online ? 'Đang chạy' : bot.seen ? 'Mất kết nối' : 'Chưa kết nối')),
    bot.seen
      ? h('ul', { class: 'list kv' },
        h('li', {}, h('span', {}, 'Nhịp tim gần nhất'), h('b', {}, `${fDT(bot.at)} (${ago < 1 ? 'vừa xong' : `${ago} phút trước`})`)),
        bot.version && h('li', {}, h('span', {}, 'Phiên bản'), h('b', {}, bot.version)),
        bot.mode && h('li', {}, h('span', {}, 'Chế độ Zalo'), h('b', {}, bot.mode)),
        bot.model && h('li', {}, h('span', {}, 'Model đang dùng'), h('b', {}, `${bot.model}${bot.filterModel ? ` · lọc: ${bot.filterModel}` : ''}`)),
        bot.tokensToday != null && h('li', {}, h('span', {}, 'Token hôm nay'), h('b', {}, `${Number(bot.tokensToday).toLocaleString('vi-VN')}${bot.tokenBudget ? ` / ${Number(bot.tokenBudget).toLocaleString('vi-VN')}` : ''}`)),
        bot.messagesToday != null && h('li', {}, h('span', {}, 'Tin hôm nay'), h('b', {}, `${bot.messagesToday} tin · ${bot.repliesToday ?? 0} lần trả lời`)),
        h('li', {}, h('span', {}, 'Cấu hình đã áp'), h('b', {}, bot.configVersion === config.version ? `bản ${config.version} (mới nhất)` : `bản ${bot.configVersion ?? '?'} · đang chờ bản ${config.version}`)),
        bot.lastError && h('li', {}, h('span', {}, 'Lỗi gần nhất'), h('b', { class: 'err' }, `${bot.lastError}${bot.lastErrorAt ? ` (${fDT(bot.lastErrorAt)})` : ''}`)))
      : h('p', { class: 'small muted' }, 'Bot chưa gửi nhịp tim. Trên máy chạy PyloS, điền SCHEDULE_API_KEY (khoá tạo ở Cài đặt → Kết nối AI agent) và địa chỉ web này vào settings.env, rồi khởi động lại bot.'));
  body.replaceChildren(statusCard, form);
}

// ---------- Session ----------
const KIND_LABEL = { message: 'Tin', filter: 'Bộ lọc', agent: 'Agent', tool: 'Tool', reply: 'Trả lời', calbot: 'Bot lịch', error: 'Lỗi' };
function sessionRow(e) {
  const t = h('span', { class: 't' }, fTime(e.at));
  const kind = h('span', { class: `badge ${e.kind === 'filter' ? (e.decision === 'skip' ? 'skip' : 'reply') : e.kind === 'error' ? 'terra' : e.kind}` },
    KIND_LABEL[e.kind] || e.kind);
  let main;
  if (e.kind === 'message') main = h('div', {}, h('b', {}, e.senderName || e.senderId || '?'), ': ', e.text || '');
  else if (e.kind === 'filter') {
    main = h('div', {}, h('b', {}, e.decision === 'skip' ? 'Bỏ qua' : 'Cho qua'), ` · tầng ${e.tier === 'ai' ? 'AI' : 'quy tắc'}`,
      e.reason ? ` · ${e.reason}` : '', e.model ? h('span', { class: 'muted small' }, ` · ${e.model}${e.tokens ? `, ${e.tokens} token` : ''}`) : '');
  } else if (e.kind === 'agent') {
    main = h('div', {}, h('span', { class: 'muted small' }, `${e.model || ''}${e.tokensIn != null ? ` · ${e.tokensIn}+${e.tokensOut ?? 0} token` : ''}${e.ms != null ? ` · ${(e.ms / 1000).toFixed(1)} giây` : ''}`),
      e.reply ? h('div', {}, e.reply) : '',
      e.prompt ? h('details', { class: 'small' }, h('summary', {}, 'Nội dung gửi cho model'), h('pre', { class: 'code' }, e.prompt)) : '');
  } else if (e.kind === 'tool') {
    main = h('div', {}, h('code', {}, e.name || '?'), ' ', h('span', { class: 'muted small' }, JSON.stringify(e.args ?? {})),
      e.result != null ? h('details', { class: 'small' }, h('summary', {}, 'Kết quả'), h('pre', { class: 'code' }, typeof e.result === 'string' ? e.result : JSON.stringify(e.result, null, 2))) : '');
  } else if (e.kind === 'reply') main = h('div', {}, e.text || '');
  else if (e.kind === 'calbot') main = h('div', {}, opBadge(e.op || 'create'), ' ', e.title || '', e.summary ? h('span', { class: 'muted small' }, ` · ${e.summary}`) : '');
  else main = h('div', { class: 'err' }, e.message || e.text || JSON.stringify(e));
  return h('li', { class: `sess ${e.kind}` }, t, kind, main);
}

async function sysSessions(body) {
  const { chats } = await api('GET', '/api/admin/sessions/chats');
  if (!sysSession.day) sysSession.day = S.today;
  if (!sysSession.chat && chats.length) sysSession.chat = chats[0].chatId;
  const pick = h('select', { class: 'grow', 'aria-label': 'Nhóm / người' }, chats.length
    ? chats.map((c) => h('option', { value: c.chatId, selected: c.chatId === sysSession.chat }, `${c.name || c.chatId}${c.group ? ' (nhóm)' : ''} · ${fDT(c.lastAt)}`))
    : h('option', { value: '' }, 'Chưa có session nào'));
  const day = dayInput(sysSession.day);
  const filters = h('form', { class: 'card row filters', onsubmit: (ev) => {
    ev.preventDefault();
    Object.assign(sysSession, { chat: pick.value, day: day.value });
    renderSystem();
  } }, pick, day, h('button', { class: 'btn primary sm' }, 'Xem'));
  let list = [empty('Chọn nhóm / người và ngày để xem tin → bộ lọc → agent → tool → bot lịch.')];
  if (sysSession.chat) {
    const { events } = await api('GET', `/api/admin/sessions?${new URLSearchParams({ chat: sysSession.chat, day: sysSession.day })}`);
    list = events.length ? events.map(sessionRow) : [empty('Ngày này không có gì.')];
  }
  body.replaceChildren(filters, h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, icon('flame'), 'Session bộ lọc ↔ agent'),
      h('span', { class: 'small muted' }, 'Bật / tắt và số ngày giữ ở Cấu hình bot → Session')),
    h('ul', { class: 'list session' }, list)));
}

const SYS_TABS = { members: sysMembers, calbot: sysCalbot, config: sysConfig, sessions: sysSessions };
