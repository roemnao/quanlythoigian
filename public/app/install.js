// Cài web thành ứng dụng (PWA). Android / máy tính: dùng sự kiện beforeinstallprompt. iPhone / iPad: chỉ hướng dẫn, vì Safari không có sự kiện này.
// localStorage bọc try/catch: chế độ riêng tư có thể chặn.
import { $, $$, toast } from './ui.js';

const DISMISS_KEY = 'ifmwh-install-dismissed';
const VISITS_KEY = 'ifmwh-visits';
const DISMISS_MS = 14 * 24 * 3600 * 1000;
let deferred = null;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* bỏ qua */ } },
};

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ua = navigator.userAgent || '';
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isIOSSafari = isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);

const dismissedRecently = () => Date.now() - Number(store.get(DISMISS_KEY) || 0) < DISMISS_MS;
const visits = () => Number(store.get(VISITS_KEY) || 0);
store.set(VISITS_KEY, String(visits() + 1));

function shareIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7');
  svg.append(p);
  return svg;
}

// Cập nhật hiển thị: nút trong thanh bên theo khả năng cài, thanh nhắc theo số lần mở và lựa chọn của người dùng.
function render() {
  const standalone = isStandalone();
  const canPrompt = Boolean(deferred) && !standalone;
  $$('[data-install]').forEach((b) => { b.hidden = !canPrompt; });
  const bar = $('#install-bar');
  if (!bar) return;
  const text = $('#install-text');
  const act = $('#install-bar [data-install]');
  let show = false;
  if (!standalone && !dismissedRecently() && visits() >= 2) {
    if (canPrompt) { text.replaceChildren('Cài iforgotmywayhome thành ứng dụng trên thiết bị của bạn.'); act.hidden = false; show = true; }
    else if (isIOSSafari) {
      text.replaceChildren('Cài ứng dụng: bấm nút Chia sẻ ', shareIcon(), ' rồi chọn "Thêm vào Màn hình chính".');
      act.hidden = true; show = true;
    } else if (isIOS) {
      text.replaceChildren('Muốn cài ứng dụng? Hãy mở trang này bằng Safari, rồi bấm Chia sẻ → "Thêm vào Màn hình chính".');
      act.hidden = true; show = true;
    }
  }
  bar.hidden = !show;
}

async function install() {
  if (!deferred) return;
  const ev = deferred;
  deferred = null; // mỗi sự kiện chỉ dùng được một lần
  ev.prompt();
  const { outcome } = await ev.userChoice.catch(() => ({ outcome: 'dismissed' }));
  if (outcome !== 'accepted') store.set(DISMISS_KEY, String(Date.now()));
  render();
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; render(); });
window.addEventListener('appinstalled', () => { deferred = null; render(); toast('Đã cài ứng dụng'); });
matchMedia('(display-mode: standalone)').addEventListener?.('change', render);

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-install]')) install();
  else if (e.target.closest('#install-close')) { store.set(DISMISS_KEY, String(Date.now())); render(); }
});

// Vẽ lần đầu khi trang đã sẵn sàng (thanh nhắc nằm trong #app).
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
