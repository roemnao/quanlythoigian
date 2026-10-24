import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalRedis, batch, kv, useMemoryKv } from '../src/kv.js';

test('giả lập Redis: chuỗi, hết hạn, đếm, hash, hàng', async () => {
  useMemoryKv();
  assert.equal(await kv.set('a', { x: 1 }), true);
  assert.deepEqual(await kv.get('a'), { x: 1 });
  assert.equal(await kv.set('a', 2, { nx: true }), false);
  assert.equal(await kv.set('t', 'v', { ex: 1 }), true);
  assert.equal(await kv.get('t'), 'v');
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await kv.get('t'), null);

  assert.equal(await kv.count('rate', 60), 1);
  assert.equal(await kv.count('rate', 60), 2);
  assert.equal(await kv.incr('n'), 1);

  await kv.hset('h', 'f1', 'một');
  assert.equal(await kv.hsetnx('h', 'f1', 'hai'), false);
  assert.equal(await kv.hsetnx('h', 'f2', 2), true);
  assert.deepEqual(await kv.hgetall('h'), { f1: 'một', f2: 2 });
  await kv.hdel('h', 'f1', 'f2');
  assert.deepEqual(await kv.hgetall('h'), {});

  await kv.rpush('l', 1, 2, 3);
  await kv.lpush('l', 0);
  assert.deepEqual(await kv.lrange('l', 0, -1), [0, 1, 2, 3]);
  assert.deepEqual(await kv.lrange('l', -2, -1), [2, 3]);
  await kv.ltrim('l', 1, -1);
  assert.equal(await kv.lindex('l', -1), 3);
  assert.equal(await kv.rpop('l'), 3);
  assert.equal(await kv.llen('l'), 2);

  // Một lần gọi, nhiều kết quả.
  const [a, h, missing] = await batch().get('a').hgetall('h').get('khong-co').exec();
  assert.deepEqual([a, h, missing], [{ x: 1 }, {}, null]);
});

test('appendSeq: số thứ tự tăng dần, giữ tối đa N phần tử, không thêm khi chưa có khoá đếm', async () => {
  useMemoryKv();
  assert.equal(await kv.appendSeq('seq:u', 'cmds:u', { op: 'create' }), -1);
  await kv.set('seq:u', 0);
  for (let i = 0; i < 5; i++) await kv.appendSeq('seq:u', 'cmds:u', { op: 'create', i }, { maxLen: 3 });
  const list = await kv.lrange('cmds:u', 0, -1);
  assert.deepEqual(list.map((c) => c.seq), [3, 4, 5]);
  assert.deepEqual(list[0], { seq: 3, op: 'create', i: 2 });
  assert.equal(await kv.get('seq:u'), 5);
});

test('lưu xuống file và đọc lại', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qltg-kv-')), 'kv.json');
  const a = new LocalRedis(file);
  await a.run([['SET', 'x', '"1"'], ['HSET', 'h', 'f', '"v"'], ['SET', 'old', '"z"', 'EX', '1']]);
  const b = new LocalRedis(file);
  assert.deepEqual(await b.run([['GET', 'x'], ['HGET', 'h', 'f']]), ['"1"', '"v"']);
});
