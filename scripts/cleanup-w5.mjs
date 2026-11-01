// Dọn dữ liệu cũ sau khi PyloS đã tách khỏi web ≥ 7 ngày: cấu hình bot, nhịp tim, session, mã đăng nhập thiết bị.
// Mặc định chỉ IN danh sách. Thêm --yes để xoá thật. Không đụng dữ liệu người dùng hay khoá `quanlythoigian:db`.
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/cleanup-w5.mjs [--yes]
const url = process.env.UPSTASH_REDIS_REST_URL; const token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) { console.error('Thiếu UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN'); process.exit(1); }
const prefix = process.env.KV_PREFIX || 'qltg:';
const run = async (cmd) => {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
};
const patterns = ['system-config', 'bot-status', 'session-chats', 'session:*', 'devlogin:*', 'devlogin-tries:*'];
const found = new Set();
for (const p of patterns) {
  let cursor = '0';
  do {
    const [next, batch] = await run(['SCAN', cursor, 'MATCH', `${prefix}${p}`, 'COUNT', '1000']);
    cursor = next; batch.forEach((k) => found.add(k));
  } while (cursor !== '0');
}
console.log(`${found.size} khoá cũ:`); [...found].forEach((k) => console.log(' ', k));
if (process.argv.includes('--yes') && found.size) { await run(['DEL', ...found]); console.log('Đã xoá.'); }
else console.log('Chưa xoá gì. Thêm --yes để xoá.');
