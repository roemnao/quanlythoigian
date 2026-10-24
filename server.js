// Chạy trên máy cá nhân: `npm start`. (Trên Vercel dùng api/index.js.)
import app from './src/app.js';
import { startLocalCron } from './src/cron.js';
import { geminiConfigured } from './src/gemini.js';
import { startPolling, zaloConfigured } from './src/zalo.js';
import { storageKind } from './src/storage.js';

const port = Number(process.env.PORT) || 3000;
const mode = process.env.ZALO_MODE || 'polling';
app.listen(port, () => {
  console.log(`Quản lý thời gian chạy tại http://localhost:${port}`);
  console.log(`Lưu dữ liệu: ${storageKind()} | Gemini: ${geminiConfigured() ? 'đã cấu hình' : 'CHƯA cấu hình'} | Zalo: ${zaloConfigured() ? mode : 'CHƯA cấu hình'}`);
  startLocalCron();
  if (zaloConfigured() && mode === 'polling') startPolling();
});
