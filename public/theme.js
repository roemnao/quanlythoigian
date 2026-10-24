// Sáng / tối cho mọi trang iforgotmywayhome. Mặc định tối, nhớ lựa chọn trong trình duyệt.
// Nạp trong <head> (không defer) để trang hiện đúng màu ngay từ đầu, không bị nháy.
// Nút chuyển: bất kỳ phần tử nào có thuộc tính data-theme-toggle.
(function () {
  var KEY = 'ifmwh-theme';
  var COLORS = { dark: '#1d1f24', light: '#f1eee8' };
  var root = document.documentElement;

  function saved() {
    try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COLORS[theme]);
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', String(theme === 'light'));
      buttons[i].setAttribute('title', theme === 'light' ? 'Chuyển sang nền tối' : 'Chuyển sang nền sáng');
      var label = buttons[i].querySelector('[data-theme-label]');
      if (label) label.textContent = theme === 'light' ? 'Nền sáng' : 'Nền tối';
    }
  }

  apply(saved());
  document.addEventListener('DOMContentLoaded', function () { apply(saved()); });
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch (err) { /* chế độ riêng tư: chỉ đổi cho lần này */ }
    apply(next);
  });
}());
