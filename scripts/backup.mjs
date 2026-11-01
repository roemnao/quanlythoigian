// Sao lưu toàn bộ dữ liệu Upstash (mọi khoá của web) ra file JSON. Chạy TRƯỚC khi cập nhật bản lớn:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/backup.mjs
// File sao lưu chứa dữ liệu cá nhân và khoá: không commit, không gửi cho ai (backup-*.json đã nằm trong .gitignore).
import fs from 'node:fs';

const url = process.env.UPSTASH_REDIS_REST_URL; const token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) { console.error('Thiếu UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN'); process.exit(1); }
const prefix = process.env.KV_PREFIX || 'qltg:';
const dbKey = process.env.STORAGE_KEY || 'quanlythoigian:db';
const run = async (cmd) => {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
};
const keys = new Set([dbKey]);
let cursor = '0';
do {
  const [next, batch] = await run(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '1000']);
  cursor = next; batch.forEach((k) => keys.add(k));
} while (cursor !== '0');
const out = {};
for (const key of keys) {
  const type = await run(['TYPE', key]);
  const ttl = await run(['TTL', key]);
  const value = type === 'string' ? await run(['GET', key]) : type === 'hash' ? await run(['HGETALL', key]) : type === 'list' ? await run(['LRANGE', key, '0', '-1']) : null;
  out[key] = { type, ttl, value };
}
const file = `backup-${new Date().toISOString().slice(0, 10)}.json`;
fs.writeFileSync(file, JSON.stringify(out));
console.log(`Đã lưu ${keys.size} khoá vào ${file}`);
