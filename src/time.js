// Tiện ích ngày giờ theo múi giờ cấu hình (mặc định Asia/Ho_Chi_Minh).
export const TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

// 'YYYY-MM-DD' của một thời điểm theo múi giờ TZ.
export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(date));
}

export function hourOf(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(date)) % 24;
}

export function fmtTime(date) {
  return new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(date));
}

export function fmtDateTime(date) {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(date));
}

// Mô tả "bây giờ" cho AI để hiểu các cụm như "mai", "thứ 5 tuần sau".
export function nowContext(date = new Date()) {
  const full = new Intl.DateTimeFormat('vi-VN', {
    timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
  return `${full} (múi giờ ${TZ})`;
}
