// Nơi lưu dữ liệu: Upstash Redis (khi chạy trên Vercel) hoặc file JSON (khi chạy trên máy).
import fs from 'node:fs';
import path from 'node:path';

const KEY = process.env.STORAGE_KEY || 'quanlythoigian:db';

function redisConfig() {
  // Tích hợp Upstash trên Vercel có thể đặt tên biến theo 2 kiểu.
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

export function storageKind() {
  if (redisConfig()) return 'redis';
  return process.env.VERCEL ? 'tmp' : 'file';
}

function filePath() {
  if (process.env.DATA_FILE) return process.env.DATA_FILE;
  // Trên Vercel chỉ ghi được vào /tmp (mất khi hàm khởi động lại) → cần Redis để lưu lâu dài.
  return process.env.VERCEL ? '/tmp/quanlythoigian-db.json' : path.join(process.cwd(), 'data', 'db.json');
}

async function redis(command) {
  const { url, token } = redisConfig();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Redis lỗi: ${data.error || res.status}`);
  return data.result;
}

export async function loadRaw() {
  if (redisConfig()) {
    const v = await redis(['GET', KEY]);
    return v ? JSON.parse(v) : null;
  }
  const file = filePath();
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

export async function saveRaw(data) {
  const json = JSON.stringify(data);
  if (redisConfig()) {
    await redis(['SET', KEY, json]);
    return;
  }
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', json);
  fs.renameSync(file + '.tmp', file);
}
