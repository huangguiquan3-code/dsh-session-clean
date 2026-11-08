/**
 * 归档 / 隔离 / 还原的回归测试（只碰临时目录）。
 *
 * 盯死这次要修的那个 bug：
 *   还原 = 文件搬回来 **且** 从 workspace.json 的 archivedSessionIds 里摘掉。
 *   少摘一个，侧边栏就还是不显示 —— 因为侧边栏是按归档集合过滤行的。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deleteSession,
  archiveSessionNow,
  unarchiveSessionNow,
  restoreBatchWithUnarchive,
  listTrash,
} from '../lib/index.js';
import { isArchivedOnDisk, setArchivedOnDisk, workspaceOf, readWorkspaceStateRaw } from '../lib/workspace-state.js';
import { addStash, listStash, removeStash, hasStash, stashIds } from '../lib/stash.js';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
    console.log(`FAIL  ${name}  — ${err && err.message ? err.message : err}`);
  }
}

// ---------------- 临时 DSH_HOME ----------------
const SID = 'session-1111-2222-3333';
const WS_DIR = '--C-Users-test-project--';
const WS_ID = 'ws-1';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sc-'));
  const sessionDir = path.join(home, 'sessions', WS_DIR, SID);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.v4.jsonl.zstd'),
    `${JSON.stringify({ type: 'session', id: SID, cwd: 'C:\\Users\\test\\project', createdAt: 1000 })}\n`,
    'utf8',
  );
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, `${SID}.json`),
    JSON.stringify({ record: { rows: { title: { val: '测试会话标题' } } } }),
    'utf8',
  );
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        workspaceIds: [WS_ID],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
      tables: {
        workspaces: {
          [WS_ID]: {
            path: 'C:\\Users\\test\\project',
            title: 'project',
            sessionIds: [SID],
          },
        },
      },
    }, null, 2),
    'utf8',
  );
  return home;
}

async function run() {
  // ---------------- 1. workspace.json ----------------
  await check('归档集合：加入 / 摘掉都是幂等的', () => {
    const home = makeHome();
    assert.equal(isArchivedOnDisk(home, SID), false);

    assert.equal(setArchivedOnDisk(home, SID, true).ok, true);
    assert.equal(isArchivedOnDisk(home, SID), true);
    // 再写一次不算变更
    assert.deepEqual(setArchivedOnDisk(home, SID, true), { ok: true, changed: false });

    const raw = readWorkspaceStateRaw(home);
    assert.ok(raw.global.archivedSessionIds.includes(SID));
    // 工作区成员位置不能被归档动过
    assert.deepEqual(raw.tables.workspaces[WS_ID].sessionIds, [SID]);
    // 其他 global 字段保留
    assert.equal(raw.global.initialized, true);
    assert.deepEqual(raw.global.workspaceIds, [WS_ID]);

    assert.equal(setArchivedOnDisk(home, SID, false).ok, true);
    assert.equal(isArchivedOnDisk(home, SID), false);
    assert.deepEqual(setArchivedOnDisk(home, SID, false), { ok: true, changed: false });
  });

  await check('workspaceOf 能按 sessionIds 反查工作区', () => {
    const home = makeHome();
    const ws = workspaceOf(home, SID);
    assert.ok(ws, '未找到归属工作区');
    assert.equal(ws.workspaceId, WS_ID);
    assert.equal(ws.title, 'project');
    assert.equal(workspaceOf(home, 'session-unknown'), null);
  });

  // ---------------- 2. 隔离区台账 ----------------
  await check('台账：写入 / 覆盖 / 列出 / 摘除 / 判存在', () => {
    const home = makeHome();
    assert.equal(listStash(home).length, 0);

    assert.equal(addStash(home, { sessionId: SID, title: '第一版', workspace: 'C:\\p' }).ok, true);
    assert.equal(hasStash(home, SID), true);
    assert.deepEqual(stashIds(home), [SID]);

    // 同 id 覆盖，不产生两条
    assert.equal(addStash(home, { sessionId: SID, title: '第二版', workspace: 'C:\\p' }).ok, true);
    const items = listStash(home);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, '第二版');
    assert.ok(items[0].stashedAt);

    assert.equal(removeStash(home, SID).removed, true);
    assert.equal(hasStash(home, SID), false);
    assert.equal(removeStash(home, SID).removed, false, '重复摘除应返回 removed:false 而不是失败');
  });

  // ---------------- 3. 删除 / 隔离（无 registry → 走磁盘） ----------------
  await check('deleteSession（无 registry）：进回收站 + 落归档 + 清台账', async () => {
    const home = makeHome();
    addStash(home, { sessionId: SID, title: '临时隔离' });

    const ctx = { get: () => undefined };
    const r = await deleteSession(ctx, SID, { dshHome: home });

    assert.equal(r.ok, true, `删除失败：${r.error}`);
    assert.ok(r.batchId);
    assert.equal(fs.existsSync(path.join(home, 'sessions', WS_DIR, SID)), false, '正文目录还在');
    assert.equal(fs.existsSync(path.join(home, 'storages', 'session_projcache', 'sessions', `${SID}.json`)), false, '缓存还在');
    assert.equal(isArchivedOnDisk(home, SID), true, '删除后应仍在归档集合里（防幽灵行）');
    assert.equal(hasStash(home, SID), false, '删除后台账应清掉');
    assert.equal(listTrash(home).length, 1);
  });

  await check('deleteSession：正文与缓存缺一 → 拒绝（incomplete）', async () => {
    const home = makeHome();
    fs.rmSync(path.join(home, 'storages', 'session_projcache', 'sessions', `${SID}.json`));
    const r = await deleteSession({ get: () => undefined }, SID, { dshHome: home });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'incomplete');
  });

  // ---------------- 4. 还原（核心 bug 回归） ----------------
  await check('restoreBatchWithUnarchive：文件回来 + 归档摘掉（侧边栏可见的两个条件）', async () => {
    const home = makeHome();
    const ctx = { get: () => undefined };
    const del = await deleteSession(ctx, SID, { dshHome: home });
    assert.equal(del.ok, true);
    assert.equal(isArchivedOnDisk(home, SID), true, '前置条件：删除后是归档状态');

    const r = await restoreBatchWithUnarchive(ctx, home, del.batchId);

    assert.equal(r.ok, true, `还原失败：${JSON.stringify(r.unarchiveFailed)}`);
    assert.deepEqual(r.sessionIds, [SID]);
    assert.equal(r.unarchived.length, 1);
    assert.equal(r.needRefresh, true);

    // 条件一：文件都在
    assert.equal(fs.existsSync(path.join(home, 'sessions', WS_DIR, SID)), true, '正文没回来');
    assert.equal(fs.existsSync(path.join(home, 'storages', 'session_projcache', 'sessions', `${SID}.json`)), true, '缓存没回来');
    // 条件二：归档集合里没有它（这就是原来漏掉的那一步）
    assert.equal(isArchivedOnDisk(home, SID), false, '还原后仍在归档集合 → 侧边栏不会显示');
    // 工作区成员位置原样
    assert.deepEqual(readWorkspaceStateRaw(home).tables.workspaces[WS_ID].sessionIds, [SID]);
    assert.equal(listTrash(home).length, 0, '批次目录应清掉');
  });

  await check('restoreBatchWithUnarchive：id 不在归档集合里也不报错（幂等）', async () => {
    const home = makeHome();
    const ctx = { get: () => undefined };
    const del = await deleteSession(ctx, SID, { dshHome: home });
    // 模拟「有人先手动取消归档了」
    setArchivedOnDisk(home, SID, false);
    const r = await restoreBatchWithUnarchive(ctx, home, del.batchId);
    assert.equal(r.ok, true);
    assert.equal(r.unarchived[0].already, true);
  });

  // ---------------- 5. 有 registry 时优先走官方 API ----------------
  await check('archive / unarchive 优先走官方 registry', async () => {
    const home = makeHome();
    const calls = [];
    const ctx = {
      get: (name) => (name === 'workspaceRegistry' ? {
        archiveSession: async (id, options) => { calls.push(['archive', id, options]); },
        unarchiveSession: async (id) => { calls.push(['unarchive', id]); },
      } : undefined),
    };
    const a = await archiveSessionNow(ctx, home, SID);
    assert.equal(a.ok, true);
    assert.equal(a.via, 'registry');
    // registry 成功时不写磁盘
    assert.equal(isArchivedOnDisk(home, SID), false);

    const u = await unarchiveSessionNow(ctx, home, SID);
    assert.equal(u.via, 'registry');
    assert.deepEqual(calls.map((c) => c[0]), ['archive', 'unarchive']);
    assert.equal(calls[0][2].stopActivity, false, '默认不停止任务');
  });

  await check('archiveSessionNow：session-active 原样上抛，不落盘', async () => {
    const home = makeHome();
    const err = new Error('cannot archive session: the session is active (turn)');
    err.name = 'WorkspaceActiveSessionError';
    err.activity = [{ kind: 'turn', items: [{ id: 't1' }] }];
    const ctx = { get: () => ({ archiveSession: async () => { throw err; } }) };

    const r = await archiveSessionNow(ctx, home, SID);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'session-active');
    assert.ok(Array.isArray(r.activity));
    assert.equal(isArchivedOnDisk(home, SID), false);
  });

  await check('隔离（stash）后再放回：归档集合跟着来回变', async () => {
    const home = makeHome();
    const ctx = { get: () => undefined };
    const a = await archiveSessionNow(ctx, home, SID);
    assert.equal(a.ok, true);
    addStash(home, { sessionId: SID, title: '隔离中' });
    assert.equal(isArchivedOnDisk(home, SID), true);
    assert.equal(hasStash(home, SID), true);

    const u = await unarchiveSessionNow(ctx, home, SID);
    removeStash(home, SID);
    assert.equal(u.ok, true);
    assert.equal(isArchivedOnDisk(home, SID), false);
    assert.equal(hasStash(home, SID), false);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log(' -', f.name, f.detail);
    process.exit(1);
  }
}

await run();
