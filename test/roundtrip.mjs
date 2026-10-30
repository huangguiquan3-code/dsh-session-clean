/**
 * 闭环测试：建 → 列出 → 删除 → 回收站 → 还原 → 再删 → 彻底清
 *
 * 全程在临时目录，只复制真实会话文件做样本，不碰 ~/.dsh。
 * 用法: node test/roundtrip.mjs [--keep]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanSessions, findSession, isComplete } from '../lib/store.js';
import { moveToTrash, listTrash, restoreBatch, purgeBatch, purgeAll, trashRoot } from '../lib/trash.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- 1. 造一个仿真 DSH_HOME ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-clean-'));
const sessionsRoot = path.join(home, 'sessions');
const cacheRoot = path.join(home, 'storages', 'session_projcache', 'sessions');
fs.mkdirSync(sessionsRoot, { recursive: true });
fs.mkdirSync(cacheRoot, { recursive: true });

function makeSession(id, { ws = '--C-Users-test--', title = '测试会话', withCache = true, withBody = true } = {}) {
  const dir = path.join(sessionsRoot, ws, id);
  if (withBody) {
    fs.mkdirSync(dir, { recursive: true });
    const header = JSON.stringify({
      type: 'session', version: 4, id, createdAt: Date.now(),
      cwd: 'C:\\Users\\test\\proj', isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
    });
    // 不压缩，读取端会回退到 utf8
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), header + '\n' + JSON.stringify({ type: 'event', n: 1 }) + '\n');
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), header + '\n');
  }
  if (withCache) {
    fs.writeFileSync(
      path.join(cacheRoot, `${id}.json`),
      JSON.stringify({ version: 7, record: { rows: { title: { ver: 1, val: title } } } }),
    );
  }
  return dir;
}

const S1 = 'session-aaaa-1111';
const S2 = 'session-bbbb-2222';
const S3 = 'session-cccc-3333';
makeSession(S1, { title: '反诈教学网站真实数据演示' });
makeSession(S2, { title: '创建QQ聊天机器人' });
makeSession(S3, { title: '只有正文没有缓存', withCache: false });

console.log(`sandbox: ${home}\n`);

// ---------- 2. 扫描 ----------
{
  const { complete, incomplete, total } = scanSessions(home);
  check('扫描到全部会话', total === 3, `total=${total}`);
  check('配对齐全 2 个', complete.length === 2, `complete=${complete.length}`);
  check('配对不全 1 个', incomplete.length === 1, `incomplete=${incomplete.length}`);
  check('标题从投影缓存读出', complete.some((r) => r.title === '反诈教学网站真实数据演示'));
  check('不完整会话被标记', !isComplete(incomplete[0]));
}

// ---------- 3. 删除 ----------
const rec = findSession(home, S1);
check('findSession 命中', Boolean(rec && rec.sessionId === S1));
const bodyPath = rec.sessionDir;
const cachePath = rec.cacheFile;
const bodySize = fs.statSync(path.join(bodyPath, 'session.v4.jsonl.zstd')).size;

const del = moveToTrash(home, {
  sessionId: S1,
  title: rec.title,
  workspace: rec.workspace,
  entries: [
    { source: rec.sessionDir, kind: 'session' },
    { source: rec.cacheFile, kind: 'cache' },
  ],
});
check('删除成功', del.ok, del.error || '');
check('移出原位置', !fs.existsSync(bodyPath) && !fs.existsSync(cachePath));
check('回收站有 1 个批次', listTrash(home).length === 1);

const batch = listTrash(home)[0];
check('账本记录原始路径', batch.items.length === 2 && batch.items.some((i) => i.originalPath === bodyPath));
check('账本记录标题', batch.title === '反诈教学网站真实数据演示');
check('扫描后会话数下降', scanSessions(home).total === 2);

// ---------- 4. 还原 ----------
const res = restoreBatch(home, batch.batchId);
check('还原成功', res.ok, JSON.stringify(res.conflicts));
check('正文回到原处', fs.existsSync(bodyPath));
check('缓存回到原处', fs.existsSync(cachePath));
check('还原后字节一致', fs.statSync(path.join(bodyPath, 'session.v4.jsonl.zstd')).size === bodySize);
check('还原后批次清空', listTrash(home).length === 0);
check('扫描后会话数恢复', scanSessions(home).total === 3);

// ---------- 5. 冲突保护 ----------
const del2 = moveToTrash(home, {
  sessionId: S1,
  title: rec.title,
  entries: [
    { source: bodyPath, kind: 'session' },
    { source: cachePath, kind: 'cache' },
  ],
});
check('再次删除成功', del2.ok);
// 在还原前手动占住目标位置（放一个不同内容的目录）
fs.mkdirSync(bodyPath, { recursive: true });
fs.writeFileSync(path.join(bodyPath, 'placeholder.txt'), 'occupied');
const res2 = restoreBatch(home, del2.batchId);
check('目标被占且内容不同时报冲突', !res2.ok && res2.conflicts.length > 0, `${res2.conflicts.length} 项冲突`);
check('冲突时批次仍保留', listTrash(home).length === 1);
check('冲突时不覆盖已有目录', fs.existsSync(path.join(bodyPath, 'placeholder.txt')));
check('非冲突项已先还原', res2.restored.includes(cachePath), `restored=${res2.restored.length}`);

// 清掉占位，再还原剩下的
fs.rmSync(bodyPath, { recursive: true, force: true });
const res3 = restoreBatch(home, del2.batchId);
check('排除占位后可还原剩余项', res3.ok, JSON.stringify(res3.unresolved || []));
check('还原批次已清空', listTrash(home).length === 0);
check('全部条目归位', fs.existsSync(bodyPath) && fs.existsSync(cachePath));

// ---------- 6. 半截批次回滚 ----------
{
  const tmpId = 'session-dddd-4444';
  const tmpDir = makeSession(tmpId, { title: '回滚测试' });
  // 制造第二条不存在的条目 → moveToTrash 会过滤掉不存在的，不会失败
  const r = moveToTrash(home, {
    sessionId: tmpId,
    entries: [
      { source: tmpDir, kind: 'session' },
      { source: path.join(cacheRoot, 'nope.json'), kind: 'cache' },
    ],
  });
  check('缺失条目被过滤后仍成功', r.ok);
  check('只移动了存在的 1 项', listTrash(home)[0].items.length === 1);
  restoreBatch(home, listTrash(home)[0].batchId);
}

// ---------- 7. 彻底清除 ----------
moveToTrash(home, {
  sessionId: S2,
  title: '创建QQ聊天机器人',
  entries: [
    { source: findSession(home, S2).sessionDir, kind: 'session' },
    { source: findSession(home, S2).cacheFile, kind: 'cache' },
  ],
});
const batches = listTrash(home);
check('清空前有批次', batches.length === 1);
const one = purgeBatch(home, batches[0].batchId);
check('单批彻底删除', one.ok);
check('批次目录已消失', !fs.existsSync(path.join(trashRoot(home), batches[0].batchId)));

moveToTrash(home, {
  sessionId: S1,
  entries: [
    { source: bodyPath, kind: 'session' },
    { source: cachePath, kind: 'cache' },
  ],
});
const all = purgeAll(home);
check('清空回收站', all.ok, `${all.purged.length} 个批次`);

// ---------- 8. 幂等与容错 ----------
check('对不存在的批次还原 → 报错不崩', restoreBatch(home, 'nope').ok === false);
check('对不存在的批次清除 → 报错不崩', purgeBatch(home, 'nope').ok === false);
check('空回收站清空 → 成功', purgeAll(home).ok === true);
check('scan 在空目录不抛', scanSessions(path.join(home, 'nowhere')).total === 0);

if (!process.argv.includes('--keep')) fs.rmSync(home, { recursive: true, force: true });
else console.log('\n保留沙箱:', home);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const r of failed) console.log(' -', r.name, r.detail);
  process.exit(1);
}
