/**
 * HTTP 路由的端到端测试：不启动 DSH，用一个假 webServer 接住注册，然后直接
 * 用假的 req/res 打过去，验证「客户端真的会拿到的返回」。
 *
 * 覆盖这次新增/改动的路由：
 *   GET  /session-clean/stash      台账 + 归档状态
 *   POST /session-clean/stash      抽进隔离区（含 session-active 409）
 *   POST /session-clean/unstash    放回
 *   POST /session-clean/restore    还原 + 取消归档 + needRefresh
 *   GET  /session-clean/sessions   archived / stashed 标记
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SID = 'session-http-1111';
const WS_DIR = '--C-Users-test-project--';
const WS_ID = 'ws-http';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sc-http-'));
  const sessionDir = path.join(home, 'sessions', WS_DIR, SID);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'session.v4.jsonl.zstd'),
    `${JSON.stringify({ type: 'session', id: SID, cwd: 'C:\\Users\\test\\project', createdAt: 1000 })}\n`,
    'utf8',
  );
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `${SID}.json`), JSON.stringify({ record: { rows: { title: { val: 'HTTP 测试会话' } } } }), 'utf8');
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [WS_ID], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { [WS_ID]: { path: 'C:\\Users\\test\\project', title: 'project', sessionIds: [SID] } } },
  }, null, 2), 'utf8');
  return home;
}

function fakeReq(method, url, body) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method,
    url,
    on(event, cb) {
      (listeners[event] || (listeners[event] = [])).push(cb);
      return req;
    },
  };
  setImmediate(() => {
    const text = body === undefined ? '' : JSON.stringify(body);
    for (const cb of listeners.data) cb(Buffer.from(text, 'utf8'));
    for (const cb of listeners.end) cb();
  });
  return req;
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status;
      Object.assign(res.headers, headers || {});
      return res;
    },
    end(payload) {
      res.body = payload === undefined || payload === null ? '' : String(payload);
      if (res.onEnd) res.onEnd();
    },
  };
  return res;
}

async function call(handler, method, url, body) {
  const req = fakeReq(method, url, body);
  const res = fakeRes();
  const done = new Promise((resolve) => { res.onEnd = resolve; });
  await handler(req, res);
  // 二进制响应（ZIP）不会走 json()，这里只在 JSON 断言里用
  await Promise.race([done, new Promise((r) => setTimeout(r, 50))]);
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { json = null; }
  return { status: res.status, body: res.body, json, headers: res.headers };
}

const home = makeHome();
process.env.DSH_HOME = home;

const { apply } = await import('../lib/index.js');

const routes = new Map();
const webCtx = {
  webServer: {
    register({ path: routePath, handler }) {
      routes.set(routePath, handler);
      return () => routes.delete(routePath);
    },
  },
  // 宿主在 webCtx.effect 里挂路由（卸载时自动注销），假 ctx 也要提供。
  effect: (fn) => {
    const d = fn();
    return () => { if (typeof d === 'function') d(); };
  },
};
const ctx = {
  logger: { info() {}, warn() {} },
  get: () => undefined,
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  inject: (deps, cb) => {
    if (Array.isArray(deps) && deps.includes('webServer')) cb(webCtx);
  },
};

apply(ctx);
assert.ok(routes.size >= 10, `只挂上 ${routes.size} 条路由`);

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

const hit = (p, method = 'GET', body) => call(routes.get(p), method, p, body);

await check('GET /stash：空台账 + 文件路径', async () => {
  const r = await hit('/session-clean/stash');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items, []);
  assert.ok(String(r.json.file).endsWith('stash.json'));
});

await check('GET /sessions：带 archived / stashed 标记', async () => {
  const r = await hit('/session-clean/sessions');
  assert.equal(r.status, 200);
  const row = r.json.items.find((x) => x.sessionId === SID);
  assert.ok(row, '列表里没有测试会话');
  assert.equal(row.archived, false);
  assert.equal(row.stashed, false);
  assert.equal(row.complete, true);
});

await check('POST /stash：归档 + 记账 + 表单可见状态变了', async () => {
  const r = await hit('/session-clean/stash', 'POST', { sessionId: SID, title: 'HTTP 测试会话' });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.ok, true);

  const list = await hit('/session-clean/stash');
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].sessionId, SID);
  assert.equal(list.json.items[0].archived, true);
  assert.equal(list.json.items[0].onDisk, true);
  assert.equal(list.json.items[0].workspaceTitle, 'project');

  const sessions = await hit('/session-clean/sessions');
  const row = sessions.json.items.find((x) => x.sessionId === SID);
  assert.equal(row.archived, true);
  assert.equal(row.stashed, true);
});

await check('POST /unstash：取消归档 + 清台账 + needRefresh', async () => {
  const r = await hit('/session-clean/unstash', 'POST', { sessionId: SID });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.removed, true);
  assert.equal(r.json.needRefresh, true);

  const list = await hit('/session-clean/stash');
  assert.equal(list.json.items.length, 0);

  const sessions = await hit('/session-clean/sessions');
  const row = sessions.json.items.find((x) => x.sessionId === SID);
  assert.equal(row.archived, false);
});

await check('POST /restore：文件回来 + 取消归档（那个 bug 的端到端回归）', async () => {
  const del = await hit('/session-clean/delete', 'POST', { sessionId: SID });
  assert.equal(del.status, 200, del.body);
  const sessionsAfterDelete = await hit('/session-clean/sessions');
  assert.equal(sessionsAfterDelete.json.items.some((x) => x.sessionId === SID), false);

  const trash = await hit('/session-clean/trash');
  const batch = trash.json.items.find((b) => b.sessionId === SID);
  assert.ok(batch, '回收站里没有刚删的批次');

  const r = await hit('/session-clean/restore', 'POST', { batchId: batch.batchId });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.needRefresh, true);
  assert.deepEqual(r.json.sessionIds, [SID]);
  assert.equal(r.json.unarchived.length, 1);

  const sessions = await hit('/session-clean/sessions');
  const row = sessions.json.items.find((x) => x.sessionId === SID);
  assert.ok(row, '还原后列表里还是没有它');
  assert.equal(row.archived, false, '还原后仍是归档状态 → 侧边栏不会显示');
  assert.equal(row.complete, true);
});

await check('GET /archived-hidden + POST /repair-archived：旧版本遗留的「看不见的行」', async () => {
  const a = await hit('/session-clean/archive', 'POST', { sessionId: SID });
  assert.equal(a.status, 200, a.body);

  const hidden = await hit('/session-clean/archived-hidden');
  assert.equal(hidden.status, 200);
  assert.ok(hidden.json.items.some((x) => x.sessionId === SID), '预览里没有这条');

  const rep = await hit('/session-clean/repair-archived', 'POST', { ids: [SID] });
  assert.equal(rep.status, 200, rep.body);
  assert.ok(rep.json.unarchived.includes(SID));
  assert.equal(rep.json.needRefresh, true);

  const after = await hit('/session-clean/archived-hidden');
  assert.equal(after.json.items.some((x) => x.sessionId === SID), false, '放回后还在预览里');
  const sessions = await hit('/session-clean/sessions');
  assert.equal(sessions.json.items.find((x) => x.sessionId === SID).archived, false);
});

await check('POST /stash：registry 报 session-active → 409 且带上冲突细节', async () => {
  const err = new Error('cannot archive session: the session is active (turn)');
  err.name = 'WorkspaceActiveSessionError';
  err.activity = [{ kind: 'turn', items: [{ id: 'turn-1' }] }];
  const activeCtx = {
    logger: { info() {}, warn() {} },
    get: (name) => (name === 'workspaceRegistry' ? { archiveSession: async () => { throw err; } } : undefined),
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    inject: (deps, cb) => { if (Array.isArray(deps) && deps.includes('webServer')) cb(webCtx); },
  };
  routes.clear();
  apply(activeCtx);

  const r = await hit('/session-clean/stash', 'POST', { sessionId: SID, title: '跑着的会话' });
  assert.equal(r.status, 409, r.body);
  assert.equal(r.json.error, 'session-active');
  assert.ok(Array.isArray(r.json.activity));
  assert.equal((await hit('/session-clean/stash')).json.items.length, 0, '失败时不该记账');
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(' -', f.name, f.detail);
  process.exit(1);
}
// 插件里现在有看门狗 setInterval，测试的假 ctx 不会触发清理，这里显式退出
process.exit(0);
