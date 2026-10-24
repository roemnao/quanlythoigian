// Gọi Gemini API (Google AI Studio) để trích lịch trình / việc cần làm từ văn bản tự do.
import { nowContext, TZ } from './time.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['event', 'task'] },
          title: { type: 'STRING' },
          start: { type: 'STRING', nullable: true },
          end: { type: 'STRING', nullable: true },
          deadline: { type: 'STRING', nullable: true },
          quadrant: { type: 'INTEGER' },
          note: { type: 'STRING', nullable: true },
        },
        required: ['kind', 'title'],
      },
    },
  },
  required: ['items'],
};

function instruction() {
  return `Bạn là trợ lý quản lý thời gian. Bây giờ là ${nowContext()}.
Đọc nội dung người dùng đưa và trích ra MỌI lịch hẹn / sự kiện / việc cần làm có trong đó.
- kind="event": có thời điểm diễn ra cụ thể (họp, học, khám bệnh...). Bắt buộc có "start"; "end" nếu biết (không biết thì để null).
- kind="task": việc cần làm, có thể có "deadline" (hạn chót).
- Thời gian ghi dạng ISO 8601 có múi giờ, ví dụ 2026-10-30T14:00:00+07:00. Hiểu "mai", "thứ 5 tuần sau"... theo thời điểm hiện tại, múi giờ ${TZ}.
- Nếu chỉ biết ngày mà không biết giờ của sự kiện, dùng 08:00.
- quadrant theo ma trận Eisenhower: 1=khẩn cấp & quan trọng, 2=quan trọng không khẩn cấp, 3=khẩn cấp không quan trọng, 4=không khẩn cấp không quan trọng.
- title ngắn gọn bằng tiếng Việt; note ghi chi tiết hữu ích (địa điểm, link, người liên quan).
- Không bịa thông tin. Không có gì thì trả về items rỗng.`;
}

export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export async function extractItems(text, { fetchImpl = fetch } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Chưa cấu hình GEMINI_API_KEY trong file .env');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instruction() }] },
      contents: [{ role: 'user', parts: [{ text: String(text).slice(0, 30000) }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.1 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) throw new Error('Gemini báo vượt giới hạn gói miễn phí (429). Thử lại sau ít phút.');
    throw new Error(`Gemini lỗi ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const out = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return normalize(parseJson(out));
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return { items: [] };
    try { return JSON.parse(m[0]); } catch { return { items: [] }; }
  }
}

function validDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function normalize(obj) {
  const items = Array.isArray(obj?.items) ? obj.items : [];
  return items
    .map((it) => ({
      kind: it.kind === 'event' ? 'event' : 'task',
      title: String(it.title || '').trim(),
      start: validDate(it.start),
      end: validDate(it.end),
      deadline: validDate(it.deadline),
      quadrant: [1, 2, 3, 4].includes(Number(it.quadrant)) ? Number(it.quadrant) : 2,
      note: it.note ? String(it.note) : '',
    }))
    .filter((it) => it.title)
    .map((it) => (it.kind === 'event' && !it.start ? { ...it, kind: 'task' } : it));
}
