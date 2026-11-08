/**
 * 路径安全回归测试（全部在临时目录，不碰真实 $DSH_HOME）。
 *
 * 覆盖：batchId / sessionId 中的 "../" 是否能逃出回收站目录。
 * 这是本地 HTTP 接口的输入边界，必须有明确的拒绝行为。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moveToTrash, purgeBatch, restoreBatch, listTrash, trashRoot } from '../lib/trash.js';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : String(err) });
    console.log(`FAIL  ${name}\n    ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err}`);
  }
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sc-path-'));
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  return home;
}

/** 造一个「受害者目录」，里面有标记文件 */
function makeVictim(home) {
  const dir = path.join(home, 'victim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'must survive', 'utf8');
  return dir;
}

console.log('---- purgeBatch 拒绝穿越 ----');
check('purgeBatch("../victim") 不得删除回收站外的目录', () => {
  const home = makeHome();
  const victim = makeVictim(home);
  const r = purgeBatch(home, '../victim');
  assert.equal(r.ok, false, `不应成功，实际 ${JSON.stringify(r)}`);
  assert.ok(fs.existsSync(path.join(victim, 'keep.txt')), 'victim/keep.txt 被误删');
});

check('purgeBatch("..") 不得删除上级目录', () => {
  const home = makeHome();
  const r = purgeBatch(home, '..');
  assert.equal(r.ok, false, `不应成功，实际 ${JSON.stringify(r)}`);
  assert.ok(fs.existsSync(home), '上级目录被删');
});

check('purgeBatch(绝对路径) 不得生效', () => {
  const home = makeHome();
  const victim = makeVictim(home);
  const r = purgeBatch(home, victim);
  assert.equal(r.ok, false, `不应成功，实际 ${JSON.stringify(r)}`);
  assert.ok(fs.existsSync(path.join(victim, 'keep.txt')), 'absolute path 被接受');
});

console.log('\n---- batchId 里的 sessionId 不得逃逸 ----');
check('moveToTrash 的 sessionId 含 "../" 时，写入仍落在回收站内', () => {
  const home = makeHome();
  const src = path.join(home, 'sessions', 'ws', 'sess-1', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, 'x', 'utf8');

  const r = moveToTrash(home, {
    sessionId: '../../escape-attempt',
    title: 't',
    entries: [{ kind: 'session', source: src }],
  });
  assert.equal(r.ok, true, `写入失败：${JSON.stringify(r)}`);

  const root = path.resolve(trashRoot(home));
  const produced = fs.existsSync(root) ? fs.readdirSync(root) : [];
  for (const name of produced) {
    const full = path.resolve(root, name);
    assert.ok(full.startsWith(root + path.sep), `产物逃逸到 ${full}`);
  }
  // 回收站外不应多出目录
  assert.ok(!fs.existsSync(path.join(home, 'escape-attempt')), '在 DSH_HOME 下创建了逃逸目录');
});

console.log('\n---- restoreBatch 只认回收站内的批次 ----');
check('restoreBatch("../victim") 不得读取站外 manifest', () => {
  const home = makeHome();
  makeVictim(home);
  const r = restoreBatch(home, '../victim');
  assert.equal(r.ok, false, `不应成功，实际 ${JSON.stringify(r)}`);
});

check('合法批次仍可正常列出与彻底删除', () => {
  const home = makeHome();
  const src = path.join(home, 'sessions', 'ws', 'sess-2', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, 'y', 'utf8');
  const mv = moveToTrash(home, { sessionId: 'sess-2', title: 'ok', entries: [{ kind: 'session', source: src }] });
  assert.equal(mv.ok, true);
  const list = listTrash(home);
  assert.ok(list.length >= 1, '回收站为空');
  const target = list.find((b) => b.sessionId === 'sess-2');
  assert.ok(target, '找不到刚移入的批次');
  const pg = purgeBatch(home, target.batchId);
  assert.equal(pg.ok, true, `合法批次删除失败：${JSON.stringify(pg)}`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(' -', f.name, f.detail);
  process.exit(1);
}
process.exit(0);
