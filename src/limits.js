// Giới hạn cho từng người dùng để không vỡ gói miễn phí (Upstash, Gemini) và không bị lạm dụng.
export const LIMITS = { sources: 5, webSources: 2, events: 2000, tasks: 1000, extractPerDay: 20 };

// Chặn nguồn trỏ vào địa chỉ nội bộ (máy chủ không được tải hộ người dùng các địa chỉ riêng tư).
export function isPrivateHost(hostname) {
  let h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv6 ánh xạ IPv4 (::ffff:127.0.0.1 hoặc ::ffff:7f00:1): xét phần IPv4 bên trong.
  const mapped = h.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    if (mapped[1]) h = mapped[1];
    else { const x = parseInt(mapped[2], 16); const y = parseInt(mapped[3], 16); h = `${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`; }
  }
  if (h === '::' || h === '::1' || /^(fc|fd|fe[89ab])/.test(h) || h.startsWith('64:ff9b:')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  return false;
}
