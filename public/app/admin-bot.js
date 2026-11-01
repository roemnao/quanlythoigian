// Mục "Quản lý bot lịch" (Owner, Technician). Web không có phần máy ảo: ở đây chỉ là bot lịch của web.
// Tab: Nhật ký · Cài đặt bot lịch · Bot Zalo nhắc việc · Kết nối AI agent · Khoá & trạng thái.
import { h, icon, api, toast, guard, fTime, fDT, empty, copyBox, statusRow } from './ui.js';

const TABS = [['log', 'Nhật ký bot lịch', 'scroll'], ['settings', 'Cài đặt bot lịch', 'settings'], ['zalo', 'Bot Zalo nhắc việc', 'chat'],
  ['agent', 'Kết nối AI agent', 'link'], ['keys', 'Khoá & trạng thái', 'column']];
const tabState = { tab: 'log', log: { from: '', to: '', member: '' } };
const OP_LABEL = { create: 'Thêm', update: 'Sửa', delete: 'Xoá', link: 'Liên kết' };
const opBadge = (op) => h('span', { class: `badge ${op}` }, OP_LABEL[op] || op);
const dayInput = (value) => h('input', { type: 'date', value });
const shiftDay = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const whenText = (e) => (e.allDay ? `${e.start}${e.end ? ` → ${e.end}` : ''} (cả ngày)` : `${fDT(e.start)}${e.end ? ` → ${fDT(e.end)}` : ''}`);
let ctxRef = null;
let agentToken = null; // chỉ có ngay sau khi tạo (máy chủ không lưu bản gốc)
let pairCode = null;

export async function renderAdminBot(root, ctx) {
  ctxRef = ctx;
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, label, ic]) => h('button', {
    type: 'button', class: tabState.tab === k ? 'on' : '', role: 'tab', onclick: () => { tabState.tab = k; renderAdminBot(root, ctx); },
  }, icon(ic), label)));
  const body = h('div', {}, h('p', { class: 'muted small' }, 'Đang tải…'));
  root.replaceChildren(tabs, body);
  await guard(async () => {
    try { await TAB_FN[tabState.tab](body, () => renderAdminBot(root, ctx)); } catch (e) { body.replaceChildren(h('p', { class: 'err small' }, e.message)); throw e; }
  })();
}

// ---------- Nhật ký bot lịch ----------
async function tabLog(body, again) {
  const L = tabState.log;
  if (!L.to) { const today = ctxRef.today || new Date().toISOString().slice(0, 10); L.to = today; L.from = shiftDay(today, -6); }
  const from = dayInput(L.from); const to = dayInput(L.to);
  const member = h('input', { value: L.member, placeholder: 'Lọc theo email hoặc ID Zalo', class: 'grow' });
  const q = () => new URLSearchParams(Object.entries(L).filter(([, v]) => v));
  const filters = h('form', { class: 'card row filters', onsubmit: (ev) => {
    ev.preventDefault();
    Object.assign(L, { from: from.value, to: to.value, member: member.value.trim() });
    again();
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
        `${r.name || r.email || r.zaloUid}${r.op && r.op !== e.op ? ` (${OP_LABEL[r.op] || r.op})` : ''}: ${r.fetchedAt ? `đã ghi vào Google Lịch ${fTime(r.fetchedAt)}` : 'chưa ghi vào Google Lịch'}`)),
      ...e.unlinked.map((r) => h('span', { class: 'badge terra' }, `${r.name || r.zaloUid}: chưa liên kết`)),
      !e.recipients.length && !e.unlinked.length ? h('span', { class: 'muted small' }, 'không có người nhận') : '')));
  body.replaceChildren(filters, h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, icon('scroll'), `Nhật ký bot lịch (${entries.length})`), h('span', { class: 'small muted' }, 'Giữ 90 ngày')),
    h('ul', { class: 'list' }, items.length ? items : empty('Không có lệnh nào trong khoảng này.'))));
}

// ---------- Cài đặt bot lịch ----------
async function tabSettings(body) {
  const { settings, appUrl, canWrite } = await api('GET', '/api/admin/bot-settings');
  const botName = h('input', { value: settings.botName, placeholder: 'Tên acc Zalo của bot, vd roemnao', disabled: !canWrite });
  const botUrl = h('input', { value: settings.botChatUrl, placeholder: 'https://zalo.me/09xxxxxxxx', disabled: !canWrite });
  const allowed = h('textarea', { rows: 2, disabled: !canWrite, placeholder: 'Để trống: ai có Gmail cũng tạo được tài khoản. Ví dụ: an@gmail.com, @congty.vn' });
  allowed.value = settings.allowedEmails;
  body.replaceChildren(h('form', { class: 'card form', onsubmit: guard(async (ev) => {
    ev.preventDefault();
    await api('PUT', '/api/admin/bot-settings', { botName: botName.value, botChatUrl: botUrl.value, allowedEmails: allowed.value });
    toast('Đã lưu');
  }) },
  h('div', { class: 'card-head' }, h('h2', {}, icon('arch'), 'Web cho mọi người')),
  h('p', { class: 'small' }, 'Gửi link này cho mọi người. Họ đăng nhập Google (đồng thời cho phép Google Lịch), gửi mã 6 số cho bot Zalo để liên kết. Từ đó lịch được giao trong nhóm Zalo tự vào Google Lịch của họ.'),
  copyBox(appUrl),
  h('div', { class: 'two' }, h('label', {}, 'Tên bot trên Zalo', botName), h('label', {}, 'Link mở chat với bot (nút trong mục Tài khoản)', botUrl)),
  h('label', {}, 'Email / tên miền được tạo tài khoản', allowed),
  canWrite ? h('div', { class: 'row' }, h('button', { class: 'btn primary' }, 'Lưu')) : h('p', { class: 'small muted' }, 'Bạn chỉ có quyền xem.')));
}

// ---------- Bot Zalo nhắc việc ----------
async function tabZalo(body, again) {
  const { config: c } = await api('GET', '/api/admin/bot');
  const z = h('div', {});
  const receiverSeg = h('div', { class: 'seg' }, [['web', 'Web này'], ['agent', 'AI agent của tôi']].map(([k, label]) =>
    h('button', { type: 'button', class: c.zaloReceiver === k ? 'on' : '', onclick: guard(async () => {
      if (k === c.zaloReceiver) return;
      if (k === 'web' && !confirm('Web sẽ đăng ký nhận tin của bot. AI agent đang dùng chung bot sẽ KHÔNG nhận được tin nữa. Tiếp tục?')) return;
      const r = await api('PUT', '/api/admin/zalo/receiver', { receiver: k });
      toast(k === 'agent' ? 'Web chỉ gửi nhắc việc, AI agent giữ việc nhận tin' : r.webhook ? 'Web đã nhận lại tin nhắn của bot' : 'Đã chuyển', 5000);
      again();
    }) }, label)));
  if (!c.zalo) {
    z.replaceChildren(h('p', { class: 'muted small' }, 'Chưa có token bot Zalo. Dán token ở tab "Khoá & trạng thái" rồi bấm Lưu.'));
  } else {
    const steps = [];
    if (c.zaloReceiver === 'web' && c.zaloMode === 'webhook') {
      steps.push(h('li', {}, h('b', {}, 'Kết nối webhook'), ' (làm 1 lần sau khi deploy)', h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: guard(async (ev) => {
        ev.currentTarget.disabled = true;
        try { const r = await api('POST', '/api/admin/zalo/webhook-setup', { baseUrl: location.origin }); toast(`Đã đăng ký webhook: ${r.url}`, 5000); } finally { ev.currentTarget.disabled = false; }
      }) }, 'Kết nối webhook'))));
    }
    if (c.zaloOwner) {
      steps.push(h('li', {}, h('b', {}, 'Đã ghép nối'), c.zaloOwner.name ? ` với ${c.zaloOwner.name}` : '',
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: guard(async () => { await api('POST', '/api/admin/zalo/test'); toast('Đã gửi tin thử. Kiểm tra Zalo nhé!'); }) }, 'Gửi tin thử'),
          !c.zaloOwner.fromEnv && h('button', { class: 'btn sm ghost danger', onclick: guard(async () => {
            if (!confirm('Ngắt kết nối Zalo?')) return;
            await api('POST', '/api/admin/zalo/unpair'); again();
          }) }, 'Ngắt kết nối'))));
    } else if (c.zaloReceiver === 'agent') {
      const idInput = h('input', { placeholder: 'ID Zalo của bạn (agent biết ID này)', class: 'grow' });
      steps.push(h('li', {}, h('b', {}, 'Nhập ID Zalo của bạn để nhận nhắc việc'),
        h('div', { class: 'row' }, idInput, h('button', { class: 'btn sm primary', onclick: guard(async () => {
          if (!idInput.value.trim()) throw new Error('Chưa nhập ID');
          await api('PUT', '/api/admin/zalo/receiver', { receiver: 'agent', chatId: idInput.value.trim() }); toast('Đã lưu'); again();
        }) }, 'Lưu'))));
    } else {
      steps.push(h('li', {}, h('b', {}, 'Ghép nối tài khoản Zalo của bạn'),
        pairCode
          ? h('div', {}, h('div', { class: 'code-big' }, pairCode),
            h('p', { class: 'small' }, 'Mở Zalo, nhắn cho bot: ', h('code', {}, `/ketnoi ${pairCode}`), ' (mã hết hạn sau 15 phút)'),
            h('button', { class: 'btn sm', onclick: () => { pairCode = null; again(); } }, 'Tôi đã gửi, kiểm tra lại'))
          : h('div', { class: 'row' }, h('button', { class: 'btn sm primary', onclick: guard(async () => { pairCode = (await api('POST', '/api/admin/zalo/pair')).code; again(); }) }, 'Lấy mã ghép nối'))));
    }
    z.replaceChildren(h('p', { class: 'small' }, 'Ai nhận tin nhắn của bot?'), receiverSeg, h('ol', { class: 'steps' }, steps),
      h('p', { class: 'small muted' }, 'Bot nhắc việc này gửi nhắc trước giờ hẹn và tóm tắt buổi sáng cho Owner chính. Gửi nội dung bất kỳ cho bot để tạo đề xuất; lệnh /homnay, /mai, /viec, /cho, /duyet all.'));
  }
  body.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, icon('chat'), 'Bot Zalo nhắc việc')), z));
}

// ---------- Kết nối AI agent (khoá cho PyloS) ----------
async function tabAgent(body, again) {
  const { config: c } = await api('GET', '/api/admin/bot');
  const a = c.agent;
  const create = (label) => h('button', { class: 'btn sm primary', type: 'button', onclick: guard(async () => {
    if (a.enabled && !confirm('Tạo khoá mới? Khoá cũ sẽ ngừng hoạt động, cần cập nhật lại trong PyloS (cả máy Windows và VPS).')) return;
    agentToken = (await api('POST', '/api/admin/agent-token')).token; again();
  }) }, label);
  const example = `curl -X POST ${a.base}/assign \\\n  -H "Authorization: Bearer ${agentToken || '<KHOÁ>'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"title":"Họp","start":"2026-12-01T09:00:00+07:00","assignees":[{"zaloUid":"<ID Zalo>"}]}'`;
  body.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, icon('link'), 'Kết nối bot Zalo PyloS')),
    h('p', { class: 'small' }, 'PyloS (bot Zalo) chỉ dùng khoá này để giao / sửa / huỷ lịch và liên kết Zalo. PyloS không nhận cấu hình, không gửi nhịp tim hay session lên đây. Đặt vào ', h('code', {}, 'settings.env'), ' của PyloS: ', h('code', {}, 'SCHEDULE_API_URL'), ' và ', h('code', {}, 'SCHEDULE_API_KEY'), '.'),
    agentToken
      ? h('div', {}, h('p', { class: 'small ok' }, '✅ Khoá mới (chỉ hiện 1 lần, hãy chép ngay vào PyloS):'), copyBox(agentToken))
      : h('p', { class: 'small muted' }, a.enabled ? `Đã có khoá (tạo ${fDT(a.createdAt)}). Khoá không xem lại được; quên thì tạo khoá mới.` : 'Chưa có khoá.'),
    h('div', { class: 'row' }, create(a.enabled ? 'Tạo khoá mới' : 'Tạo khoá'),
      a.enabled && h('button', { class: 'btn sm ghost danger', type: 'button', onclick: guard(async () => {
        if (!confirm('Thu hồi khoá? PyloS sẽ không giao lịch được nữa.')) return;
        agentToken = null; await api('DELETE', '/api/admin/agent-token'); again();
      }) }, 'Thu hồi')),
    h('p', { class: 'small', style: 'margin-top:10px' }, 'Địa chỉ web (SCHEDULE_API_URL):'), copyBox(c.app.origin || location.origin),
    h('p', { class: 'small' }, 'Mô tả API (OpenAPI):'), copyBox(`${a.base}/openapi.json`),
    h('details', { class: 'small' }, h('summary', {}, 'Các API và ví dụ'),
      h('ul', { class: 'small' },
        h('li', {}, h('code', {}, 'POST /assign'), ', ', h('code', {}, 'PATCH|DELETE|GET /assign/:id'), ': giao, sửa, huỷ, xem tình trạng lịch đã giao'),
        h('li', {}, h('code', {}, 'POST /zalo-link'), ' {code, zaloUid, zaloName}: liên kết Zalo bằng mã 6 số'),
        h('li', {}, h('code', {}, 'POST /events'), ', ', h('code', {}, 'GET|POST /tasks'), ', ', h('code', {}, 'GET /agenda'), ', ', h('code', {}, 'POST /message'), ': lịch / việc riêng của người nhắn (kèm ', h('code', {}, 'zaloUid'), ')')),
      h('pre', { class: 'code' }, example))));
}
// ---------- Khoá & trạng thái ----------
async function tabKeys(body, again) {
  const { config: c, canWrite } = await api('GET', '/api/admin/bot');
  const storageText = { redis: ['Upstash Redis', 'Dữ liệu lưu online, an toàn.'], file: ['File trên máy', 'data/db.json'],
    tmp: ['Tạm thời (/tmp)', 'Cần thêm Upstash Redis: Vercel → Storage → Upstash → Connect.'] }[c.storage];
  const last = c.cronLast;
  const status = h('ul', { class: 'list' },
    statusRow(c.gemini, 'AI Gemini', c.gemini ? `Model ${c.geminiModel}` : 'Chưa có key: nhập ở phần Khoá API bên dưới'),
    statusRow(c.storage !== 'tmp', `Lưu trữ: ${storageText[0]}`, storageText[1]),
    statusRow(c.google.configured, 'Đăng nhập Google', c.google.configured ? 'Đã có Client ID và Secret' : 'Chưa cấu hình: người dùng chưa đăng nhập được'),
    statusRow(c.tokenKey, 'Khoá mã hoá quyền Google Lịch (TOKEN_ENC_KEY)', c.tokenKey ? 'Đã đặt' : 'CHƯA đặt: chưa lưu được quyền Google Lịch của người dùng'),
    statusRow(c.ownerEmails, 'Email Owner (OWNER_EMAILS)', c.ownerEmails ? 'Đã đặt (đường cứu hộ khi mất quyền Owner)' : 'Chưa đặt'),
    statusRow(c.zalo, 'Zalo Bot', c.zalo ? `Chế độ ${c.zaloMode === 'webhook' ? 'webhook' : 'polling (trên máy)'}` : 'Chưa có token'),
    statusRow(Boolean(c.zaloOwner), 'Nhận nhắc việc qua Zalo', c.zaloOwner ? `Đã kết nối${c.zaloOwner.name ? ` với ${c.zaloOwner.name}` : ''}` : 'Chưa ghép nối'),
    statusRow(Boolean(last), 'Cron (ghi lịch bù, đồng bộ nguồn và Google)', last ? `Chạy lần cuối ${fDT(last.at)}` : 'Chưa chạy: tạo job cron-job.org mỗi 5 phút (bên dưới)'),
    statusRow(Boolean(c.migration), 'Dữ liệu cũ của chủ web', c.migration ? `Đã chuyển sang tài khoản Owner lúc ${fDT(c.migration.at)}` : 'Chưa chuyển (cần có Owner đăng nhập)'));

  const keyNow = (k) => { const i = c.keys?.[k]; return i?.source ? `(đang dùng: ${i.masked}${i.source === 'env' ? ', từ Vercel' : ''})` : '(chưa có)'; };
  const gNow = (k) => (k.source ? `(đang dùng: ${k.masked}${k.source === 'env' ? ', từ Vercel' : ''})` : '(chưa có)');
  const field = (name, label, now, ph) => h('label', { class: 'field' }, label, ' ', h('span', { class: 'small muted' }, now), h('input', { name, placeholder: ph, autocomplete: 'off', spellcheck: 'false', disabled: !canWrite }));
  const msg = h('span', { class: 'small' });
  const form = h('form', { class: 'card', autocomplete: 'off', onsubmit: guard(async (ev) => {
    ev.preventDefault();
    const f = ev.target; const btn = f.querySelector('button.primary');
    const b = {};
    for (const name of ['geminiApiKey', 'zaloBotToken', 'geminiModel', 'googleClientId', 'googleClientSecret']) if (f[name].value.trim()) b[name] = f[name].value.trim();
    if (!Object.keys(b).length) { msg.textContent = 'Bạn chưa dán key nào.'; msg.className = 'small err'; return; }
    btn.disabled = true; msg.textContent = 'Đang lưu và kiểm tra…'; msg.className = 'small muted';
    try {
      const r = await api('PUT', '/api/admin/keys', b);
      const parts = [];
      if (r.gemini) parts.push(r.gemini.ok ? '✅ Gemini dùng được' : `❌ Gemini: ${r.gemini.error}`);
      if (r.zalo) {
        parts.push(r.zalo.ok ? `✅ Zalo bot${r.zalo.name ? ` "${r.zalo.name}"` : ''} dùng được` : `❌ Zalo: ${r.zalo.error}`);
        if (r.zalo.webhook) parts.push('✅ đã kết nối webhook');
        if (r.zalo.webhookError) parts.push(`⚠️ webhook: ${r.zalo.webhookError}`);
      }
      if (b.googleClientId || b.googleClientSecret) parts.push(r.googleConfigured ? '✅ đã lưu Google Client' : '⚠️ cần nhập đủ cả Client ID và Client Secret');
      msg.textContent = parts.join(' · ') || 'Đã lưu';
      msg.className = `small ${parts.some((p) => p.startsWith('❌')) ? 'err' : 'ok'}`;
      f.reset(); again();
    } catch (e) { msg.textContent = e.message; msg.className = 'small err'; } finally { btn.disabled = false; }
  }) },
  h('div', { class: 'card-head' }, h('h2', {}, icon('settings'), 'Khoá API')),
  h('p', { class: 'small muted' }, 'Dán key vào ô rồi bấm Lưu. Key lưu trong cơ sở dữ liệu của bạn, web chỉ hiện vài ký tự đầu/cuối. Để trống ô nào thì giữ nguyên.'),
  field('geminiApiKey', 'Key Gemini', keyNow('GEMINI_API_KEY'), 'Dán key từ aistudio.google.com/apikey'),
  field('zaloBotToken', 'Token bot Zalo (bot nhắc việc)', keyNow('ZALO_BOT_TOKEN'), 'Dán token từ Zalo Bot Manager'),
  h('details', { class: 'small', open: !c.google.configured },
    h('summary', {}, 'Google: đăng nhập & Google Lịch'),
    h('p', { class: 'small' }, 'Trong Google Cloud (Google Auth Platform → Clients → Web application), thêm đúng hai dòng sau rồi dán Client ID / Secret xuống dưới. Nhớ bấm ', h('b', {}, 'Publish app'), ' (Audience) để quyền không hết hạn sau 7 ngày.'),
    h('p', { class: 'small' }, h('b', {}, 'Authorized JavaScript origins:')), copyBox(c.app.origin),
    h('p', { class: 'small' }, h('b', {}, 'Authorized redirect URIs:')), copyBox(c.app.redirectUri),
    field('googleClientId', 'Google Client ID', gNow(c.google.clientId), '….apps.googleusercontent.com'),
    field('googleClientSecret', 'Google Client Secret', gNow(c.google.clientSecret), 'GOCSPX-…')),
  h('details', { class: 'small' }, h('summary', {}, 'Tuỳ chọn nâng cao'),
    field('geminiModel', 'Model Gemini', c.keys?.GEMINI_MODEL?.source ? `(đang dùng: ${c.geminiModel})` : `(mặc định: ${c.geminiModel})`, 'gemini-3.1-flash-lite')),
  canWrite ? h('div', { class: 'row' }, h('button', { class: 'btn primary' }, 'Lưu & kiểm tra'), msg) : h('p', { class: 'small muted' }, 'Bạn chỉ có quyền xem.'));

  const cron = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, icon('clock'), 'Cron')),
    c.vercel
      ? h('div', {}, h('p', { class: 'small' }, 'Gói miễn phí của Vercel chỉ chạy tự động 1 lần/ngày. Tạo job miễn phí ở ', h('a', { href: 'https://cron-job.org', target: '_blank', rel: 'noopener' }, 'cron-job.org'), ' gọi địa chỉ này mỗi 5 phút (thay <CRON_SECRET> bằng giá trị đã đặt trên Vercel). Cron chạy lại lịch lỗi tạm thời, đồng bộ nguồn và Google Lịch, gửi nhắc việc.'),
        copyBox(c.cronUrl.startsWith('http') ? c.cronUrl : location.origin + c.cronUrl))
      : h('p', { class: 'small' }, 'Đang chạy trên máy: tự kiểm tra mỗi phút.'),
    last ? h('p', { class: 'small muted' }, `Lần chạy cuối ${fDT(last.at)}: ${JSON.stringify(last.report)}`) : '',
    canWrite ? h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn sm', onclick: guard(async () => {
      const r = await api('POST', '/api/admin/cron-run');
      toast(`Đã chạy: ${r.synced} mục đồng bộ, ${r.reminders} nhắc việc${r.summary ? ', đã gửi tóm tắt' : ''}`, 5000); again();
    }) }, icon('refresh'), 'Chạy ngay'),
    !c.migration && h('button', { class: 'btn sm', onclick: guard(async () => {
      const r = await api('POST', '/api/admin/migrate', {});
      toast(r.skipped === 'no-owner' ? 'Chưa có Owner nào đăng nhập' : r.migrated ? 'Đã chuyển dữ liệu cũ' : 'Không có gì để chuyển', 5000); again();
    }) }, 'Chuyển dữ liệu cũ')) : '');

  body.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Trạng thái')), status), form, cron);
}

const TAB_FN = { log: tabLog, settings: tabSettings, zalo: tabZalo, agent: tabAgent, keys: tabKeys };
