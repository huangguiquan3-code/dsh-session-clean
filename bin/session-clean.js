#!/usr/bin/env node
/**
 * dsh-session-clean CLI
 *
 * 只做文件操作，不调宿主 API。因此必须保证客户端已退出，
 * 否则会话正文可能正被写入锁占用（LEASE），rename 会 EBUSY。
 *
 * 用法：
 *   session-clean list                    列出全部会话（含是否可删）
 *   session-clean list --incomplete       只看配对不全的
 *   session-clean delete <sessionId>...   移进回收站
 *   session-clean trash                   列出回收站
 *   session-clean restore <batchId>       还原一个批次
 *   session-clean restore --all           还原全部
 *   session-clean purge <batchId>         彻底删除一个批次（不可恢复）
 *   session-clean purge --all             清空回收站
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanSessions, findSession, isComplete } from '../lib/store.js';
import {
  moveToTrash,
  listTrash,
  restoreBatch,
  purgeBatch,
  purgeAll,
  trashRoot,
} from '../lib/trash.js';

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) || 'list';
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const args = argv.filter((a) => !a.startsWith('-'));

function home() {
  const i = argv.indexOf('--home');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function hostRunning() {
  // 只做提示，不做强制拦截。
  try {
    const { execSync } = { execSync: null };
    void execSync;
  } catch { /* ignore */ }
  return null;
}

function cmdList() {
  const h = home();
  const { complete, incomplete, total } = scanSessions(h);
  console.log(`DSH_HOME  ${h}`);
  console.log(`会话总数  ${total}（可删 ${complete.length}，配对不全 ${incomplete.length}）\n`);

  if (!flags.has('--incomplete')) {
    console.log('可删除的会话：');
    let sum = 0;
    for (const r of complete) {
      sum += r.bytes + r.cacheBytes;
      console.log(`  ${r.sessionId}`);
      console.log(`    ${fmtTime(r.mtime)}  ${kb(r.bytes + r.cacheBytes).padStart(9)}  ${r.title || '(无标题)'}`);
    }
    console.log(`  合计 ${mb(sum)}`);
  }

  if (incomplete.length) {
    console.log('\n配对不全（不会被删除）：');
    for (const r of incomplete) {
      console.log(`  ${r.sessionId}  正文=${r.sessionDir ? '有' : '无'} 缓存=${r.cacheFile ? '有' : '无'}  ${r.title || ''}`);
    }
  }
}

function cmdDelete() {
  const h = home();
  const ids = args.slice(1);
  if (!ids.length) {
    console.error('用法: session-clean delete <sessionId>...');
    process.exit(1);
  }
  let failed = 0;
  for (const id of ids) {
    const rec = findSession(h, id);
    if (!rec) { console.log(`  ✗ ${id}  未找到`); failed++; continue; }
    if (!isComplete(rec)) { console.log(`  ✗ ${id}  正文与缓存只找到一处，已跳过`); failed++; continue; }
    const r = moveToTrash(h, {
      sessionId: id,
      title: rec.title,
      workspace: rec.workspace,
      entries: [
        { source: rec.sessionDir, kind: 'session' },
        { source: rec.cacheFile, kind: 'cache' },
      ],
    });
    if (r.ok) console.log(`  ✓ ${id}  → 回收站 ${r.batchId}  ${mb(r.bytes)}`);
    else { console.log(`  ✗ ${id}  ${r.error}`); failed++; }
  }
  if (failed) process.exit(1);
}

function cmdTrash() {
  const h = home();
  const list = listTrash(h);
  console.log(`回收站  ${trashRoot(h)}`);
  if (!list.length) { console.log('（空）'); return; }
  let sum = 0;
  for (const b of list) {
    sum += b.bytes;
    console.log(`  ${b.batchId}`);
    console.log(`    ${b.deletedAt}  ${mb(b.bytes).padStart(9)}  ${b.title || b.sessionId}`);
    if (b.broken) console.log('    ⚠ manifest 缺失，只能手工处理');
  }
  console.log(`  合计 ${mb(sum)}`);
}

function cmdRestore() {
  const h = home();
  if (flags.has('--all')) {
    const list = listTrash(h);
    if (!list.length) { console.log('回收站是空的'); return; }
    let bad = 0;
    for (const b of list) {
      const r = restoreBatch(h, b.batchId);
      if (r.ok) console.log(`  ✓ ${b.batchId}  已还原 ${r.restored.length} 项`);
      else {
        bad++;
        console.log(`  ⚠ ${b.batchId}  冲突 ${r.conflicts.length} 项`);
        for (const c of r.conflicts) console.log(`      ${c.path}  (${c.reason})`);
      }
    }
    if (bad) process.exit(1);
    return;
  }
  const id = args[1];
  if (!id) { console.error('用法: session-clean restore <batchId> | --all'); process.exit(1); }
  const r = restoreBatch(h, id);
  if (r.ok) {
    console.log(`  ✓ ${id}  已还原 ${r.restored.length} 项`);
    for (const p of r.restored) console.log(`      ${p}`);
  } else {
    console.log(`  ⚠ ${id}  ${r.error || '有冲突'}`);
    for (const c of r.conflicts || []) console.log(`      ${c.path}  (${c.reason})`);
    process.exit(1);
  }
}

function cmdPurge() {
  const h = home();
  if (flags.has('--all')) {
    const r = purgeAll(h);
    console.log(`  已清除 ${r.purged.length} 个批次`);
    for (const f of r.failed) console.log(`  ⚠ ${f.batchId}: ${f.error}`);
    if (!r.ok) process.exit(1);
    return;
  }
  const id = args[1];
  if (!id) { console.error('用法: session-clean purge <batchId> | --all'); process.exit(1); }
  const r = purgeBatch(h, id);
  if (r.ok) console.log(`  ✓ ${id}  已彻底删除`);
  else { console.log(`  ✗ ${id}  ${r.error}`); process.exit(1); }
}

const HELP = `dsh-session-clean

  list [--incomplete]        列出会话
  delete <sessionId>...      移进回收站（可还原）
  trash                      列出回收站
  restore <batchId> | --all  还原
  purge   <batchId> | --all  彻底删除（不可恢复）

  --home <path>              指定 DSH_HOME，默认 $DSH_HOME 或 ~/.dsh

注意：delete 前请先退出 DSH 客户端，否则会话正被写入锁占用会失败。
`;

function main() {
  const h = home();
  if (!fs.existsSync(h)) {
    console.error(`DSH_HOME 不存在: ${h}`);
    process.exit(1);
  }
  switch (cmd) {
    case 'list': return cmdList();
    case 'delete': return cmdDelete();
    case 'trash': return cmdTrash();
    case 'restore': return cmdRestore();
    case 'purge': return cmdPurge();
    case 'help':
    case '--help':
    case '-h': return void console.log(HELP);
    default:
      console.log(HELP);
      process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error('[session-clean]', err && err.message ? err.message : err);
  process.exit(1);
}
