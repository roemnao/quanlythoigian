// Phân quyền của web bot lịch: Owner, Technician, User. Mọi kiểm tra quyền đều đi qua đây.
// Web không có phần "máy ảo": quản lý bot lịch (bot:*) gồm cả khoá API, cron, webhook Zalo của chính bot lịch.
export const ROLES = ['owner', 'technician', 'user'];
export const PERMS = {
  owner: ['use', 'bot:read', 'bot:write', 'accounts:read', 'accounts:write'],
  technician: ['use', 'bot:read', 'bot:write', 'accounts:read'],
  user: ['use'],
};
export const ROLE_LABEL = { owner: 'Owner', technician: 'Technician', user: 'User' };

export const roleOf = (member) => (ROLES.includes(member?.role) ? member.role : 'user');
export const permsOf = (member) => [...PERMS[roleOf(member)]];
export const can = (member, perm) => Boolean(member) && PERMS[roleOf(member)].includes(perm);

// Email của chủ hệ thống đặt sẵn bằng biến môi trường OWNER_EMAILS (cách nhau dấu phẩy). Cũng là đường cứu hộ khi mất hết Owner.
export function ownerEmails() {
  return String(process.env.OWNER_EMAILS || '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}
export const isOwnerEmail = (email) => ownerEmails().includes(String(email || '').toLowerCase());
