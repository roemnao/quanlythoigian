// Giới hạn cho từng người dùng để không vỡ gói miễn phí (Upstash, Gemini) và không bị lạm dụng.
export const LIMITS = { sources: 5, webSources: 2, events: 2000, tasks: 1000, extractPerDay: 20 };

// Chặn nguồn trỏ vào địa chỉ nội bộ (máy chủ không được tải hộ người dùng các địa chỉ riêng tư).
export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return false;
}
