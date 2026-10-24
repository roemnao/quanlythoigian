// Service worker của web app: giao diện mở được cả khi mạng chập chờn. Không bao giờ lưu dữ liệu /api.
// Đăng ký với scope "/" (web app ở tên miền riêng) hoặc "/app/" (dùng chung tên miền với trang quản trị).
const CACHE = 'ifmwh-app-v2';
const BASE = new URL(self.registration.scope).pathname;
const SHELL = [BASE, `${BASE}manifest.webmanifest`, '/app/app.js', '/app/sync.js', '/app/app.css', '/theme.css', '/theme.js', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Trang: lấy bản mới nhất, mất mạng thì dùng bản đã lưu.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match(BASE)));
    return;
  }
  // CSS, JS, font, ảnh: dùng bản đã lưu cho nhanh, đồng thời tải bản mới cho lần sau.
  e.respondWith(caches.match(e.request).then((hit) => {
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => hit);
    return hit || fresh;
  }));
});
