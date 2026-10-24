// Nạp biến môi trường từ file .env (nếu có) trước khi các module khác đọc cấu hình.
import fs from 'node:fs';

const file = process.env.ENV_FILE || '.env';
if (fs.existsSync(file)) process.loadEnvFile(file);
