// Cấu hình khoá API: ưu tiên giá trị nhập trên web (lưu trong cơ sở dữ liệu), không có thì dùng biến môi trường.
// Store.open() gọi applySettings() nên mọi yêu cầu/cron/webhook đều dùng giá trị mới nhất.
export const KEY_FIELDS = {
  GEMINI_API_KEY: 'geminiApiKey',
  GEMINI_MODEL: 'geminiModel',
  ZALO_BOT_TOKEN: 'zaloBotToken',
};

let fromWeb = {};

export function applySettings(settings) {
  fromWeb = { ...(settings || {}) };
}

export function cfg(name) {
  const field = KEY_FIELDS[name];
  return (field && fromWeb[field]) || process.env[name] || '';
}

export function cfgSource(name) {
  const field = KEY_FIELDS[name];
  if (field && fromWeb[field]) return 'web';
  return process.env[name] ? 'env' : null;
}

// Chỉ hiện vài ký tự đầu/cuối để nhận ra key, không lộ toàn bộ.
export function mask(value) {
  if (!value) return '';
  return value.length <= 10 ? '••••' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
