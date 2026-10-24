// Kho khoá–giá trị cho dữ liệu nhiều người dùng: thành viên, hàng lệnh, log bot lịch, cấu hình và session của bot.
// Mỗi thứ một khoá riêng (không gộp vào dữ liệu chính của chủ web) để nhiều người ghi cùng lúc không đè lên nhau,
// và để các lời gọi thường xuyên (app hỏi lệnh mới, nhịp tim của bot) chỉ đọc vài byte thay vì cả kho dữ liệu.
// Upstash Redis khi có biến REST; chạy trên máy thì một file JSON giả lập đúng những lệnh Redis được dùng ở đây.
import fs from 'node:fs';
import path from 'node:path';
import { redisConfig, redisPipeline } from './storage.js';

const PREFIX = process.env.KV_PREFIX || 'qltg:';

// Thêm một phần tử vào hàng có số thứ tự tăng dần, trong một bước (không bị xen giữa khi hai lệnh đến cùng lúc).
// KEYS: khoá đếm, khoá hàng. ARGV: JSON của phần tử (không có "seq"), số phần tử tối đa, số giây giữ hàng.
// Khoá đếm chưa có (người dùng đã bị xoá) thì không thêm, trả về -1.
const APPEND_SEQ = `if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local s = redis.call('INCR', KEYS[1])
redis.call('RPUSH', KEYS[2], '{"seq":' .. s .. ',' .. string.sub(ARGV[1], 2))
redis.call('LTRIM', KEYS[2], -tonumber(ARGV[2]), -1)
if tonumber(ARGV[3]) > 0 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return s`;

// ----- Giả lập Redis trong bộ nhớ, lưu xuống file (chỉ một tiến trình dùng) -----
const WRITES = new Set(['SET', 'DEL', 'INCR', 'EXPIRE', 'HSET', 'HSETNX', 'HDEL', 'LPUSH', 'RPUSH', 'LTRIM', 'RPOP', 'EVAL']);

export class LocalRedis {
  constructor(file = null) {
    this.file = file;
    this.data = null;
  }

  load() {
    if (this.data) return;
    this.data = this.file && fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
  }

  save() {
    if (!this.file) return;
    const now = Date.now();
    for (const [key, e] of Object.entries(this.data)) if (e.exp && e.exp <= now) delete this.data[key];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  entry(key, type) {
    const e = this.data[key];
    if (e && e.exp && e.exp <= Date.now()) { delete this.data[key]; return null; }
    if (e && type && e.t !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    return e || null;
  }

  create(key, t, v) {
    this.data[key] = { t, v };
    return this.data[key];
  }

  range(list, start, stop) {
    const n = list.length;
    let a = Number(start); let b = Number(stop);
    if (a < 0) a = Math.max(0, n + a);
    if (b < 0) b = n + b;
    return a > b ? [] : list.slice(a, b + 1);
  }

  exec([name, ...args]) {
    const cmd = String(name).toUpperCase();
    const [key] = args;
    switch (cmd) {
      case 'GET': return this.entry(key, 's')?.v ?? null;
      case 'MGET': return args.map((k) => this.entry(k, 's')?.v ?? null);
      case 'EXISTS': return args.filter((k) => this.entry(k)).length;
      case 'SET': {
        const opts = args.slice(2).map(String);
        const up = opts.map((o) => o.toUpperCase());
        if (up.includes('NX') && this.entry(key)) return null;
        const e = this.create(key, 's', String(args[1]));
        const ex = up.indexOf('EX');
        if (ex >= 0) e.exp = Date.now() + Number(opts[ex + 1]) * 1000;
        return 'OK';
      }
      case 'DEL': return args.filter((k) => this.entry(k) && delete this.data[k]).length;
      case 'INCR': {
        const e = this.entry(key, 's') || this.create(key, 's', '0');
        e.v = String(Number(e.v) + 1);
        return Number(e.v);
      }
      case 'EXPIRE': {
        const e = this.entry(key);
        if (!e) return 0;
        e.exp = Date.now() + Number(args[1]) * 1000;
        return 1;
      }
      case 'TTL': {
        const e = this.entry(key);
        if (!e) return -2;
        return e.exp ? Math.ceil((e.exp - Date.now()) / 1000) : -1;
      }
      case 'HGET': return this.entry(key, 'h')?.v[args[1]] ?? null;
      case 'HSET': {
        const e = this.entry(key, 'h') || this.create(key, 'h', {});
        let added = 0;
        for (let i = 1; i < args.length; i += 2) {
          if (!(args[i] in e.v)) added++;
          e.v[args[i]] = String(args[i + 1]);
        }
        return added;
      }
      case 'HSETNX': {
        const e = this.entry(key, 'h') || this.create(key, 'h', {});
        if (args[1] in e.v) return 0;
        e.v[args[1]] = String(args[2]);
        return 1;
      }
      case 'HDEL': {
        const e = this.entry(key, 'h');
        if (!e) return 0;
        const n = args.slice(1).filter((f) => f in e.v && delete e.v[f]).length;
        if (!Object.keys(e.v).length) delete this.data[key];
        return n;
      }
      case 'HGETALL': return Object.entries(this.entry(key, 'h')?.v || {}).flat();
      case 'HLEN': return Object.keys(this.entry(key, 'h')?.v || {}).length;
      case 'LPUSH':
      case 'RPUSH': {
        const e = this.entry(key, 'l') || this.create(key, 'l', []);
        for (const v of args.slice(1)) {
          if (cmd === 'LPUSH') e.v.unshift(String(v)); else e.v.push(String(v));
        }
        return e.v.length;
      }
      case 'LRANGE': return this.range(this.entry(key, 'l')?.v || [], args[1], args[2]);
      case 'LTRIM': {
        const e = this.entry(key, 'l');
        if (e) {
          e.v = this.range(e.v, args[1], args[2]);
          if (!e.v.length) delete this.data[key];
        }
        return 'OK';
      }
      case 'LLEN': return this.entry(key, 'l')?.v.length || 0;
      case 'LINDEX': {
        const list = this.entry(key, 'l')?.v || [];
        const i = Number(args[1]);
        return list[i < 0 ? list.length + i : i] ?? null;
      }
      case 'RPOP': {
        const e = this.entry(key, 'l');
        if (!e) return null;
        const v = e.v.pop();
        if (!e.v.length) delete this.data[key];
        return v;
      }
      case 'EVAL': {
        if (args[0] !== APPEND_SEQ) throw new Error('Script không được hỗ trợ khi chạy trên máy');
        const [seqKey, listKey, json, max, ex] = args.slice(2);
        if (!this.entry(seqKey)) return -1;
        const seq = this.exec(['INCR', seqKey]);
        this.exec(['RPUSH', listKey, `{"seq":${seq},${String(json).slice(1)}`]);
        this.exec(['LTRIM', listKey, -Number(max), -1]);
        if (Number(ex) > 0) this.exec(['EXPIRE', listKey, ex]);
        return seq;
      }
      default: throw new Error(`Lệnh ${cmd} chưa được giả lập`);
    }
  }

  async run(commands) {
    this.load();
    const results = commands.map((c) => this.exec(c));
    if (commands.some((c) => WRITES.has(String(c[0]).toUpperCase()))) this.save();
    return results;
  }
}

function kvFile() {
  if (process.env.KV_FILE) return process.env.KV_FILE;
  if (process.env.DATA_FILE) return process.env.DATA_FILE.replace(/(\.json)?$/, '.kv.json');
  return process.env.VERCEL ? '/tmp/quanlythoigian-kv.json' : path.join(process.cwd(), 'data', 'kv.json');
}

let local = null;
function backend() {
  if (redisConfig()) return { run: redisPipeline };
  local ||= new LocalRedis(kvFile());
  return local;
}

// Kiểm thử: dùng bộ nhớ (không ghi file) hoặc quay lại tự chọn.
export function useMemoryKv() {
  local = new LocalRedis(null);
}

const k = (key) => PREFIX + key;
const enc = (v) => JSON.stringify(v);
const dec = (s) => {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return s; }
};
const decHash = (flat) => {
  const out = {};
  for (let i = 0; i < (flat?.length || 0); i += 2) out[flat[i]] = dec(flat[i + 1]);
  return out;
};

// Gom nhiều thao tác vào một lần gọi: kv.batch().get('a').hgetall('b').exec() → [giá trị a, object b].
// Giá trị luôn lưu dạng JSON, đọc ra là giá trị JS.
export function batch() {
  const cmds = [];
  const steps = []; // [số lệnh, hàm đổi kết quả]
  const add = (list, fn) => { cmds.push(...list); steps.push([list.length, fn]); return b; };
  const b = {
    get: (key) => add([['GET', k(key)]], ([r]) => dec(r)),
    mget: (keys) => (keys.length ? add([['MGET', ...keys.map(k)]], ([r]) => r.map(dec)) : add([], () => [])),
    set: (key, value, { ex, nx } = {}) => add([['SET', k(key), enc(value), ...(ex ? ['EX', String(ex)] : []), ...(nx ? ['NX'] : [])]],
      ([r]) => r === 'OK'),
    del: (...keys) => add([['DEL', ...keys.map(k)]], ([r]) => r),
    exists: (key) => add([['EXISTS', k(key)]], ([r]) => r > 0),
    incr: (key) => add([['INCR', k(key)]], ([r]) => Number(r)),
    // Đếm trong một khoảng thời gian (giới hạn số lần): khoá tự hết hạn sau `seconds` kể từ lần đầu.
    count: (key, seconds) => add([['SET', k(key), '0', 'EX', String(seconds), 'NX'], ['INCR', k(key)]], ([, r]) => Number(r)),
    expire: (key, seconds) => add([['EXPIRE', k(key), String(seconds)]], ([r]) => r),
    hget: (key, field) => add([['HGET', k(key), field]], ([r]) => dec(r)),
    hset: (key, field, value) => add([['HSET', k(key), field, enc(value)]], ([r]) => r),
    hsetnx: (key, field, value) => add([['HSETNX', k(key), field, enc(value)]], ([r]) => r === 1),
    hdel: (key, ...fields) => add([['HDEL', k(key), ...fields]], ([r]) => r),
    hgetall: (key) => add([['HGETALL', k(key)]], ([r]) => decHash(r)),
    lpush: (key, ...values) => add([['LPUSH', k(key), ...values.map(enc)]], ([r]) => r),
    rpush: (key, ...values) => add([['RPUSH', k(key), ...values.map(enc)]], ([r]) => r),
    lrange: (key, start, stop) => add([['LRANGE', k(key), String(start), String(stop)]], ([r]) => (r || []).map(dec)),
    ltrim: (key, start, stop) => add([['LTRIM', k(key), String(start), String(stop)]], ([r]) => r),
    llen: (key) => add([['LLEN', k(key)]], ([r]) => r),
    lindex: (key, i) => add([['LINDEX', k(key), String(i)]], ([r]) => dec(r)),
    rpop: (key) => add([['RPOP', k(key)]], ([r]) => dec(r)),
    // Thêm `item` vào cuối hàng `listKey` với số thứ tự lấy từ `seqKey` (trả về số đó, -1 nếu seqKey chưa có).
    appendSeq: (seqKey, listKey, item, { maxLen = 1000, ex = 0 } = {}) => add(
      [['EVAL', APPEND_SEQ, '2', k(seqKey), k(listKey), enc(item), String(maxLen), String(ex)]], ([r]) => Number(r)),
    async exec() {
      if (!cmds.length) return steps.map(([, fn]) => fn([]));
      const results = await backend().run(cmds);
      let i = 0;
      return steps.map(([n, fn]) => { const part = results.slice(i, i + n); i += n; return fn(part); });
    },
  };
  return b;
}

// Thao tác đơn lẻ: await kv.get('a'), await kv.hset('b', 'f', 1)...
export const kv = new Proxy({}, {
  get: (_, name) => (name === 'then' ? undefined : (...args) => batch()[name](...args).exec().then((r) => r[0])),
});
