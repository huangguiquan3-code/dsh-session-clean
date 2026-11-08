/**
 * dsh-session-clean —— 会话删除（回收站 + 可还原）与会话导出
 *
 * 约束（用户明确要求）：
 *   - 不改官方任何文件，尤其不改官方 client.js；
 *   - 客户端不能崩：所有入口 try/catch，失败只记日志不 throw；
 *   - 删除 = 移进回收站，可还原；只有 purge 才真删。
 *
 * 两种运行模式：
 *   进程内（本文件 index.js）：有 workspaceRegistry 时先调官方 archiveSession
 *     拿到 session-active 保护，再做文件移动；同时挂 HTTP 路由给侧边栏面板用。
 *   外部 CLI（bin/session-clean.js）：只做文件操作，强制要求客户端已退出。
 *
 * HTTP 路由（全部同源，客户端面板直接 fetch）：
 *   GET  /session-clean/sessions?q=&limit=&includeArchived=   列表
 *   POST /session-clean/delete            {sessionId}          删一个
 *   POST /session-clean/delete-many       {ids[]}              批量删
 *   POST /session-clean/export            {ids[],format}       导出到磁盘
 *   POST /session-clean/export-zip        {ids[],format}       导出成 ZIP 下载
 *   GET  /session-clean/trash                                  回收站
 *   POST /session-clean/restore           {batchId}            还原（含取消归档！）
 *   POST /session-clean/purge             {batchId}
 *   POST /session-clean/purge-all         {}
 *   GET  /session-clean/stash                                  隔离区台账
 *   POST /session-clean/stash             {sessionId,title,stopActivity}   抽进隔离区
 *   POST /session-clean/unstash           {sessionId}          放回原工作区
 *   POST /session-clean/archive           {sessionId,stopActivity}       只归档，不记台账
 *   POST /session-clean/unarchive         {sessionId}          只取消归档
 *   POST /session-clean/prompt-diag       {}                   只读诊断
 *
 * 「归档」是 DSH 侧边栏的可见性开关（workspace.json 的 archivedSessionIds），
 * 不是文件操作 —— 所以还原会话时必须把它一起摘掉，否则文件回来了、行还是不显示。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scanSessions, findSession, isComplete, querySessions, selectSessions } from './store.js';
import { moveToTrash, listTrash, restoreBatch, purgeBatch, purgeAll, trashRoot } from './trash.js';
import { exportToDisk, exportZip, exportsRoot } from './export.js';
import { runDiagnostics } from './prompt-diagnostics.js';
import { isArchivedOnDisk, setArchivedOnDisk, workspaceOf, workspaceArchivedSet } from './workspace-state.js';
import { listStash, addStash, removeStash, stashIds, clearStash, stashFile } from './stash.js';

export const name = 'session-clean';

/** 软依赖：拿不到就退化成纯文件模式，不让宿主因为缺服务起不来。 */
export const inject = [];

export function resolveDshHome(explicit) {
  if (explicit) return explicit;
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

function log(ctx, level, msg) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger[level] === 'function') ctx.logger[level](`[session-clean] ${msg}`);
  } catch {
    /* 日志失败也必须继续 */
  }
}

/** 拿官方工作区注册表（拿不到返回 undefined，不抛）。 */
export function getWorkspaceRegistry(ctx) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return undefined;
    return ctx.get('workspaceRegistry');
  } catch {
    return undefined;
  }
}

/**
 * 归档一个会话（从侧边栏隐藏）。
 *
 * 优先走官方 registry：它会拦下带活动任务的会话、写穿磁盘、并给客户端发增量。
 * 拿不到 registry 时退化到直接改 workspace.json（CLI / 兜底路径）。
 *
 * @returns {{ ok: boolean, via: 'registry'|'disk'|'none', already?: boolean,
 *             error?: string, detail?: string, activity?: unknown }}
 */
export async function archiveSessionNow(ctx, dshHome, sessionId, options = {}) {
  const id = String(sessionId);
  const registry = getWorkspaceRegistry(ctx);

  if (registry && typeof registry.archiveSession === 'function') {
    try {
      await registry.archiveSession(id, { stopActivity: options.stopActivity === true });
      return { ok: true, via: 'registry' };
    } catch (err) {
      const detail = errorText(err);
      const name = err && err.name ? String(err.name) : '';
      if (name === 'WorkspaceActiveSessionError' || /session-active/i.test(detail) || /is active/i.test(detail)) {
        return {
          ok: false,
          via: 'registry',
          error: 'session-active',
          detail,
          activity: err && err.activity !== undefined ? err.activity : undefined,
        };
      }
      log(ctx, 'warn', `archive via registry failed: ${detail}`);
    }
  }

  if (isArchivedOnDisk(dshHome, id)) return { ok: true, via: 'disk', already: true };
  const r = setArchivedOnDisk(dshHome, id, true);
  if (!r.ok) return { ok: false, via: 'none', error: 'archive-failed', detail: r.error };
  return { ok: true, via: 'disk' };
}

/**
 * 取消归档（让会话重新出现在侧边栏）。
 *
 * 这是「还原后列表里没有它」的根因修复点：只把文件搬回来是不够的，
 * 归档集合里还留着这个 id，侧边栏照样过滤掉这一行。
 *
 * @returns {{ ok: boolean, via: 'registry'|'disk'|'none', already?: boolean, error?: string, detail?: string }}
 */
export async function unarchiveSessionNow(ctx, dshHome, sessionId) {
  const id = String(sessionId);
  const registry = getWorkspaceRegistry(ctx);

  if (registry && typeof registry.unarchiveSession === 'function') {
    try {
      await registry.unarchiveSession(id);
      return { ok: true, via: 'registry' };
    } catch (err) {
      log(ctx, 'warn', `unarchive via registry failed: ${errorText(err)}`);
    }
  }

  if (!isArchivedOnDisk(dshHome, id)) return { ok: true, via: 'disk', already: true };
  const r = setArchivedOnDisk(dshHome, id, false);
  if (!r.ok) return { ok: false, via: 'none', error: 'unarchive-failed', detail: r.error };
  return { ok: true, via: 'disk' };
}

/**
 * 删除一个会话：先归档（有 API 时），再移进回收站。
 */
export async function deleteSession(ctx, sessionId, options = {}) {
  const dshHome = resolveDshHome(options.dshHome);
  const rec = findSession(dshHome, sessionId);
  if (!rec) return { ok: false, error: 'session not found' };

  if (!isComplete(rec)) {
    return {
      ok: false,
      error: 'incomplete',
      detail: '正文与投影缓存只找到一处，为避免孤儿条目已中止',
      hasSessionDir: Boolean(rec.sessionDir),
      hasCache: Boolean(rec.cacheFile),
    };
  }

  // 1) 先归档：它会拦下带活动任务的会话，并立刻从列表里摘掉。
  const a = await archiveSessionNow(ctx, dshHome, sessionId, {
    stopActivity: options.stopActivity !== false,
  });
  if (!a.ok) {
    if (a.error === 'session-active') return { ok: false, error: 'session-active', detail: a.detail };
    log(ctx, 'warn', `archive failed (continuing with file move): ${a.detail || a.error}`);
  }
  const archived = Boolean(a.ok);

  // 2) 移进回收站
  const r = moveToTrash(dshHome, {
    sessionId,
    title: rec.title,
    workspace: rec.workspace,
    entries: [
      { source: rec.sessionDir, kind: 'session' },
      { source: rec.cacheFile, kind: 'cache' },
    ],
  });

  if (!r.ok) return { ok: false, error: 'move-failed', detail: r.error, archived };

  // 3) 台账里也别再留着它 —— 文件已经不在磁盘上了。
  try { removeStash(dshHome, sessionId); } catch { /* 台账失败不影响删除 */ }

  return { ok: true, batchId: r.batchId, bytes: r.bytes, archived, title: rec.title };
}

/**
 * 批量删除。逐项独立：一个失败不影响其他，最后汇总。
 */
export async function deleteMany(ctx, ids, options = {}) {
  const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
  const results = [];
  for (const id of list) {
    try {
      results.push({ id, ...(await deleteSession(ctx, id, options)) });
    } catch (err) {
      results.push({ id, ok: false, error: String(err && err.message ? err.message : err) });
    }
  }
  const deleted = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    requested: list.length,
    deleted: deleted.length,
    bytes: deleted.reduce((sum, r) => sum + (r.bytes || 0), 0),
    failed,
    results,
  };
}

/**
 * 「被归档但文件还在」的会话：它们的行被侧边栏过滤掉了。
 *
 * 这是历史遗留状态的修复入口 —— 旧版本还原只搬文件、不摘归档集合，
 * 所以这些会话现在既不在列表里，也不在回收站里（批次目录还原后就删了）。
 *
 * 只做**预览**：不自动改任何东西。用户确认后才调 repairArchivedSessions()。
 *
 * @returns {{ items: Array<{sessionId,title,workspace,workspaceTitle,inTrash,onDisk}>, total: number }}
 */
export function listArchivedButVisible(dshHome) {
  const archived = workspaceArchivedSet(dshHome);
  const trashIds = new Set(listTrash(dshHome).map((b) => String(b.sessionId || '')).filter(Boolean));
  const { complete } = scanSessions(dshHome);
  const items = [];
  for (const rec of complete) {
    const id = String(rec.sessionId);
    if (!archived.has(id)) continue;
    items.push({
      sessionId: id,
      title: rec.title || '',
      workspace: rec.workspace || '',
      workspaceTitle: rec.workspaceTitle || '',
      inTrash: trashIds.has(id),
      onDisk: true,
    });
  }
  items.sort((a, b) => String(a.title || a.sessionId).localeCompare(String(b.title || b.sessionId)));
  return { items, total: items.length };
}

/**
 * 把指定的会话从归档集合里摘掉（= 让侧边栏重新显示它们）。
 * @param {string[]|null} ids null/空 = 全部「被归档但文件还在」的会话
 */
export async function repairArchivedSessions(ctx, dshHome, ids) {
  const candidates = listArchivedButVisible(dshHome).items;
  const wanted = Array.isArray(ids) && ids.length
    ? new Set(ids.map(String))
    : new Set(candidates.map((c) => c.sessionId));
  const targets = candidates.filter((c) => wanted.has(c.sessionId));

  const unarchived = [];
  const failed = [];
  for (const item of targets) {
    const u = await unarchiveSessionNow(ctx, dshHome, item.sessionId);
    if (u.ok) {
      unarchived.push(item.sessionId);
      try { removeStash(dshHome, item.sessionId); } catch { /* ignore */ }
    } else {
      failed.push({ sessionId: item.sessionId, error: u.error, detail: u.detail });
    }
  }
  return { ok: failed.length === 0, requested: targets.length, unarchived, failed, needRefresh: true };
}

/**
 * 还原一个批次：搬回文件 → 取消归档 → 记账清理。
 *
 * 这是「还原了但侧边栏看不到」的修复点：restoreBatch 只动文件，归档集合里
 * 还留着这个 id，侧边栏照样把它过滤掉。所以这里必须再取消归档一次。
 *
 * @returns {{ ok: boolean, unarchived: Array, unarchiveFailed: Array, sessionIds: string[], needRefresh: boolean }}
 */
export async function restoreBatchWithUnarchive(ctx, dshHome, batchId) {
  const id = String(batchId || '');
  // restoreBatch 成功后会把批次目录删掉，先取出会话 id。
  const before = listTrash(dshHome).find((b) => b.batchId === id);
  const sessionIds = before && before.sessionId ? [String(before.sessionId)] : [];
  const r = restoreBatch(dshHome, id);

  const unarchived = [];
  const unarchiveFailed = [];
  for (const sid of sessionIds) {
    const u = await unarchiveSessionNow(ctx, dshHome, sid);
    if (u.ok) unarchived.push({ sessionId: sid, via: u.via, already: Boolean(u.already) });
    else unarchiveFailed.push({ sessionId: sid, error: u.error, detail: u.detail });
    try { removeStash(dshHome, sid); } catch { /* 台账失败不影响还原 */ }
  }

  return {
    ...r,
    ok: Boolean(r.ok) && unarchiveFailed.length === 0,
    sessionIds,
    unarchived,
    unarchiveFailed,
    needRefresh: true,
  };
}

/** 进程内插件入口：挂 HTTP 路由，供侧边栏面板与设置页调用。 */
export function apply(ctx) {
  if (!ctx || typeof ctx !== 'object') return;

  try {
    const dshHome = resolveDshHome();
    log(ctx, 'info', `loaded (home=${dshHome})`);

    if (typeof ctx.inject !== 'function') {
      log(ctx, 'info', 'ctx.inject unavailable; routes not mounted (CLI still works)');
      return;
    }

    // ctx.inject(['webServer'], cb)：服务就绪后回调一次。
    ctx.inject(['webServer'], (webCtx) => {
      try {
        const server = webCtx.webServer;
        if (!server || typeof server.register !== 'function') {
          log(ctx, 'info', 'webServer.register unavailable; routes not mounted');
          return;
        }

        const stashSet = () => new Set(stashIds(dshHome).map(String));

        const slim = (r, stashed) => ({
          sessionId: r.sessionId,
          title: r.title || '',
          workspace: r.workspace || '',
          workspaceTitle: r.workspaceTitle || '',
          archived: Boolean(r.archived),
          stashed: (stashed || new Set()).has(String(r.sessionId)),
          mtime: r.mtime || r.createdAt || 0,
          createdAt: r.createdAt || 0,
          bytes: (r.bytes || 0) + (r.cacheBytes || 0),
          complete: Boolean(r.sessionDir && r.cacheFile),
        });

        // ---- 桌面浮条（外部置顶小窗）的协作状态 ----
        //
        // 宿主进程是 ELECTRON_RUN_AS_NODE 的子进程（拿不到 Electron API），
        // 所以「最小化后仍可用」只能靠一个外部小窗。这里给它三样东西：
        //   1. 桌面清单的镜像（客户端同步上来，小窗轮询读）；
        //   2. 一个动作队列（小窗点条目 → 客户端下一次轮询时执行）；
        //   3. desk.json（端口发现文件，小窗启动时读它）。
        const deskMirror = { items: [], updatedAt: 0 };
        const deskPending = [];
        let clientHello = null;
        // 主题：客户端算好 token 后上报，外部浮窗读同一个文件，两边不再各自硬编码
        const themeFile = path.join(dshHome, 'session-clean', 'theme.json');
        // ---- 浮窗看门狗：心跳超时自动重启 ----
        const deskDesiredFile = path.join(dshHome, 'session-clean', 'desk-desired.json');
        const deskHeartbeatFile = path.join(dshHome, 'session-clean', 'desk-heartbeat.txt');
        const deskWatch = { fails: 0, paused: false, lastRestart: 0, lastError: '' };
        let deskAutoStartAt = 0;
        let lastCurrentId = '';

        function readDeskHeartbeatAge() {
          try { return Date.now() - fs.statSync(deskHeartbeatFile).mtimeMs; } catch { return Number.POSITIVE_INFINITY; }
        }

        /** 主题懒加载：宿主重启后内存里没有，就从 theme.json 补回来（所有读主题的路由都走它）。 */
        function ensureThemeLoaded() {
          if (themeState) return themeState;
          try {
            const raw = fs.readFileSync(themeFile, 'utf8').replace(/^\uFEFF/, '');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') themeState = parsed;
          } catch { /* 首次没有文件 */ }
          return themeState;
        }
        /** 读「用户期望」状态。读不到就返回 ok:false —— 看门狗绝不靠猜测做决定。 */
        function readDeskDesired() {
          try {
            const raw = fs.readFileSync(deskDesiredFile, 'utf8').replace(/^\uFEFF/, '');
            if (!raw || !raw.trim()) return { ok: false, desired: '' };
            const parsed = JSON.parse(raw);
            const desired = String((parsed && parsed.desired) || '');
            if (!desired) return { ok: false, desired: '' };
            return { ok: true, desired };
          } catch {
            return { ok: false, desired: '' };
          }
        }

        const readBody = (req) => new Promise((resolve) => {
          let raw = '';
          try {
            req.on('data', (chunk) => { raw += chunk; if (raw.length > 8 * 1024 * 1024) raw = raw.slice(0, 8 * 1024 * 1024); });
            req.on('end', () => {
              try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
            });
            req.on('error', () => resolve({}));
          } catch {
            resolve({});
          }
        });

        let themeState = null;
        const deskInfoFile = path.join(dshHome, 'session-clean', 'desk.json');
        let deskInfoPort = 0;

        const webPort = (() => {
          try {
            if (Number(server.port) > 0) return Number(server.port);
            const addr = server.server && typeof server.server.address === 'function' ? server.server.address() : null;
            if (addr && Number(addr.port) > 0) return Number(addr.port);
          } catch { /* 忽略 */ }
          return 0;
        })();

        const writeDeskInfo = (force) => {
          if (!force && deskInfoPort === webPort && fs.existsSync(deskInfoFile)) return;
          deskInfoPort = webPort;
          try {
            fs.mkdirSync(path.dirname(deskInfoFile), { recursive: true });
            fs.writeFileSync(deskInfoFile, `${JSON.stringify({
              port: webPort,
              pid: process.pid,
              updatedAt: new Date().toISOString(),
            }, null, 2)}\n`, 'utf8');
          } catch (err) {
            log(ctx, 'warn', `desk.json write failed: ${errorText(err)}`);
          }
        };
        writeDeskInfo(true);

        // 每条路由都必须带 kind：'exact' 或 'prefix'。
        const routes = [
          // 会话列表：支持 q 检索、limit 截断、是否含归档
          ['/session-clean/sessions', async (req, res) => {
            try {
              const url = new URL(req.url || '/', 'http://localhost');
              const q = url.searchParams.get('q') || '';
              const limit = Number(url.searchParams.get('limit') || '0') || 0;
              const includeArchived = url.searchParams.get('includeArchived') !== '0';
              const { items, incomplete, total } = querySessions(dshHome, { q, limit, includeArchived });
              const stashed = stashSet();
              json(res, 200, {
                items: items.map((r) => slim(r, stashed)),
                incomplete: incomplete.map((r) => slim(r, stashed)),
                total,
                exportsDir: exportsRoot(dshHome),
              });
            } catch (err) {
              json(res, 500, { error: errorText(err) });
            }
          }],
          // 删除一个会话 → 移进回收站
          ['/session-clean/delete', async (req, res) => {
            const body = await readBody(req);
            const id = String(body.sessionId || '');
            if (!id) { json(res, 400, { ok: false, error: 'sessionId required' }); return; }
            try {
              const r = await deleteSession(ctx, id, { dshHome });
              json(res, r.ok ? 200 : 409, r);
            } catch (err) {
              json(res, 500, { ok: false, error: errorText(err) });
            }
          }],
          // 批量删除：ids 数组，逐个进回收站
          ['/session-clean/delete-many', async (req, res) => {
            const body = await readBody(req);
            const ids = Array.isArray(body.ids) ? body.ids : [];
            if (!ids.length) { json(res, 400, { ok: false, error: 'ids required' }); return; }
            try {
              const r = await deleteMany(ctx, ids, { dshHome, stopActivity: body.stopActivity !== false });
              json(res, r.ok ? 200 : 207, r);
            } catch (err) {
              json(res, 500, { ok: false, error: errorText(err) });
            }
          }],
          // 导出到磁盘：返回目录与文件清单，面板把路径显示给用户
          ['/session-clean/export', async (req, res) => {
            const body = await readBody(req);
            const ids = Array.isArray(body.ids) ? body.ids : [];
            if (!ids.length) { json(res, 400, { ok: false, error: 'ids required' }); return; }
            try {
              const { records, missing } = selectSessions(dshHome, ids);
              const r = exportToDisk(dshHome, records, { format: body.format, dir: body.dir });
              json(res, r.ok ? 200 : 409, { ...r, missing });
            } catch (err) {
              json(res, 500, { ok: false, error: errorText(err) });
            }
          }],
          // 导出成 ZIP：直接把二进制写回去，浏览器拿到就是下载
          ['/session-clean/export-zip', async (req, res) => {
            const body = await readBody(req);
            const ids = Array.isArray(body.ids) ? body.ids : [];
            if (!ids.length) { json(res, 400, { ok: false, error: 'ids required' }); return; }
            try {
              const { records, missing } = selectSessions(dshHome, ids);
              const r = exportZip(records, { format: body.format });
              if (!r.ok) { json(res, 409, { ok: false, error: r.error, skipped: r.skipped, missing }); return; }
              res.writeHead(200, {
                'content-type': 'application/zip',
                'content-length': String(r.buffer.length),
                'content-disposition': `attachment; filename="${r.filename}"`,
                'cache-control': 'no-store',
              });
              res.end(r.buffer);
            } catch (err) {
              json(res, 500, { ok: false, error: errorText(err) });
            }
          }],
          ['/session-clean/trash', async (req, res) => {
            json(res, 200, { items: listTrash(dshHome) });
          }],
          // 只读诊断：抓取系统提示词组装结构，不修改任何内容
          ['/session-clean/prompt-diag', async (req, res) => {
            try {
              const r = await runDiagnostics(ctx);
              if (!r.ok) {
                json(res, 503, { ok: false, error: r.error });
                return;
              }
              json(res, 200, { ok: true, analysis: r.analysis, markdown: r.markdown });
            } catch (err) {
              json(res, 500, { ok: false, error: errorText(err) });
            }
          }],
          /**
           * 还原一个批次。
           *
           * 三步：搬回文件 → 取消归档 → 让客户端重建列表基线。
           * 少了第二步，文件回来了但侧边栏还是看不到（这就是原来的 bug）。
           */
          ['/session-clean/restore', async (req, res) => {
            const body = await readBody(req);
            const r = await restoreBatchWithUnarchive(ctx, dshHome, String(body.batchId || ''));
            json(res, r.ok ? 200 : 409, r);
          }],
          ['/session-clean/purge', async (req, res) => {
            const body = await readBody(req);
            const batchId = String(body.batchId || '');
            const before = listTrash(dshHome).find((b) => b.batchId === batchId);
            const r = purgeBatch(dshHome, batchId);
            if (r.ok && before && before.sessionId) {
              try { removeStash(dshHome, before.sessionId); } catch { /* ignore */ }
            }
            json(res, r.ok ? 200 : 404, r);
          }],
          ['/session-clean/purge-all', async (req, res) => {
            const batches = listTrash(dshHome);
            const r = purgeAll(dshHome);
            for (const b of batches) {
              if (b.sessionId) {
                try { removeStash(dshHome, b.sessionId); } catch { /* ignore */ }
              }
            }
            json(res, 200, r);
          }],

          // ---------------------------------------------------------- 隔离区
          /**
           * 隔离区台账。
           *
           * GET  列出「本插件抽出来的」会话，附带磁盘标题与归档状态；
           * POST {sessionId,title,stopActivity} 抽一个进来（= 归档 + 记账）。
           *
           * 抽进来 = 官方归档：会话从侧边栏消失，但工作区成员位置、正文、缓存都不动，
           * 所以「放回」只是把归档集合里的 id 摘掉，位置原样回来。
           */
          ['/session-clean/stash', async (req, res) => {
            const method = String(req.method || 'GET').toUpperCase();
            if (method === 'GET') {
              try {
                const archived = workspaceArchivedSet(dshHome);
                const items = listStash(dshHome).map((it) => {
                  const rec = findSession(dshHome, it.sessionId);
                  const ws = workspaceOf(dshHome, it.sessionId);
                  return {
                    sessionId: it.sessionId,
                    title: it.title || (rec && rec.title) || '',
                    workspace: it.workspace || (rec && rec.workspace) || '',
                    workspaceTitle: (ws && ws.title) || '',
                    workspaceId: (ws && ws.workspaceId) || '',
                    stashedAt: it.stashedAt,
                    archived: archived.has(String(it.sessionId)),
                    onDisk: Boolean(rec && rec.sessionDir && rec.cacheFile),
                  };
                });
                json(res, 200, { items, file: stashFile(dshHome) });
              } catch (err) {
                json(res, 500, { ok: false, error: errorText(err) });
              }
              return;
            }
            const body = await readBody(req);
            const id = String(body.sessionId || '');
            if (!id) { json(res, 400, { ok: false, error: 'sessionId required' }); return; }
            try {
              const rec = findSession(dshHome, id);
              const a = await archiveSessionNow(ctx, dshHome, id, { stopActivity: body.stopActivity === true });
              if (!a.ok) {
                json(res, a.error === 'session-active' ? 409 : 500, {
                  ok: false,
                  error: a.error,
                  detail: a.detail,
                  activity: a.activity,
                });
                return;
              }
              const ws = workspaceOf(dshHome, id);
              const item = {
                sessionId: id,
                title: String(body.title || (rec && rec.title) || ''),
                workspace: String(body.workspace || (rec && rec.workspace) || ''),
                workspaceId: (ws && ws.workspaceId) || '',
              };
              const s = addStash(dshHome, item);
              json(res, 200, { ok: true, via: a.via, already: Boolean(a.already), item, stash: s.ok, stashFile: stashFile(dshHome) });
            } catch (err) {
              json(res, 500, { ok: false, error: errorText(err) });
            }
          }],
          // 放回：取消归档 + 从台账摘掉
          ['/session-clean/unstash', async (req, res) => {
            const body = await readBody(req);
            const id = String(body.sessionId || '');
            if (!id) { json(res, 400, { ok: false, error: 'sessionId required' }); return; }
            try {
              const u = await unarchiveSessionNow(ctx, dshHome, id);
              let removed = false;
              try { removed = Boolean(removeStash(dshHome, id).removed); } catch { /* ignore */ }
              json(res, u.ok ? 200 : 500, {
                ok: u.ok,
                via: u.via,
                already: Boolean(u.already),
                removed,
                error: u.ok ? undefined : u.error,
                detail: u.detail,
                needRefresh: true,
              });
            } catch (err) {
              json(res, 500, { ok: false, error: errorText(err) });
            }
          }],
          // 只归档 / 只取消归档（会话行菜单用，不记台账）
          ['/session-clean/archive', async (req, res) => {
            const body = await readBody(req);
            const id = String(body.sessionId || '');
            if (!id) { json(res, 400, { ok: false, error: 'sessionId required' }); return; }
            const a = await archiveSessionNow(ctx, dshHome, id, { stopActivity: body.stopActivity === true });
            json(res, a.ok ? 200 : (a.error === 'session-active' ? 409 : 500), {
              ok: a.ok, via: a.via, already: Boolean(a.already), error: a.error, detail: a.detail, activity: a.activity,
            });
          }],
          ['/session-clean/unarchive', async (req, res) => {
            const body = await readBody(req);
            const id = String(body.sessionId || '');
            if (!id) { json(res, 400, { ok: false, error: 'sessionId required' }); return; }
            const u = await unarchiveSessionNow(ctx, dshHome, id);
            json(res, u.ok ? 200 : 500, { ok: u.ok, via: u.via, already: Boolean(u.already), error: u.error, detail: u.detail, needRefresh: true });
          }],
          // 桌面浮窗的开关：status 只读；start/stop/restart/toggle 走 scripts/desk-ctl.ps1
          ['/session-clean/desk-window', async (req, res) => {
            const method = String(req.method || 'GET').toUpperCase();
            let action = 'status';
            if (method !== 'GET') {
              const body = await readBody(req);
              const a = String((body && body.action) || 'status');
              action = ['status', 'start', 'stop', 'restart', 'toggle'].includes(a) ? a : 'status';
            }
            const out = await runDeskCtl(action);
            if (action === 'status' && out && typeof out === 'object') {
              out.watchdog = { paused: deskWatch.paused, fails: deskWatch.fails, heartbeatAgeMs: readDeskHeartbeatAge(), desired: readDeskDesired().desired };
            }
            json(res, 200, out);
          }],
          // 主题 token 同步：客户端 POST，浮窗 GET（也读 $DSH_HOME/session-clean/theme.json）
          ['/session-clean/theme', async (req, res) => {
            const method = String(req.method || 'GET').toUpperCase();
            if (method === 'GET') {
              json(res, 200, { ok: true, theme: ensureThemeLoaded() });
              return;
            }
            const body = await readBody(req);
            const theme = body && body.theme && typeof body.theme === 'object' ? body.theme : null;
            if (!theme) { json(res, 400, { ok: false, error: 'theme required' }); return; }
            themeState = theme;
            try {
              fs.mkdirSync(path.dirname(themeFile), { recursive: true });
              fs.writeFileSync(themeFile, `${JSON.stringify(theme, null, 2)}\n`, 'utf8');
            } catch (err) {
              log(ctx, 'warn', `theme.json write failed: ${errorText(err)}`);
            }
            json(res, 200, { ok: true });
          }],

          // 客户端启动时报到：用来确认页面里跑的到底是哪一版 client.js
          ['/session-clean/client-hello', async (req, res) => {
            const body = await readBody(req);
            clientHello = {
              build: String(body.build || ''),
              at: Number(body.at) || 0,
              href: String(body.href || ''),
              ua: String(body.ua || ''),
              receivedAt: Date.now(),
            };
            json(res, 200, { ok: true, serverBuild: 'host-2026-11-07' });
          }],

          // 运行环境探针：确认宿主进程有没有 Electron API（决定桌面浮条能不能自己开窗口）
          ['/session-clean/probe', async (req, res) => {
            const info = {
              pid: process.pid,
              clientHello,
              processType: process.type || null,
              versions: {
                node: process.versions.node || null,
                electron: process.versions.electron || null,
                chrome: process.versions.chrome || null,
              },
              env: {
                DSH_WEB_URL: process.env.DSH_WEB_URL || null,
                DSH_HOME: process.env.DSH_HOME || null,
              },
              webServer: null,
              electronModule: null,
            };
            try {
              const s = webCtx.webServer;
              const addr = s && typeof s.address === 'function' ? s.address() : null;
              info.webServer = {
                keys: s ? Object.keys(s).slice(0, 24) : null,
                port: s && s.port !== undefined ? s.port : null,
                serverAddress: addr || null,
                innerPort: (s && s.server && typeof s.server.address === 'function') ? (s.server.address() || null) : null,
              };
            } catch (err) {
              info.webServer = { error: errorText(err) };
            }
            try {
              const { createRequire } = await import('node:module');
              const req2 = createRequire(import.meta.url);
              const e = req2('electron');
              if (e && typeof e === 'object') {
                info.electronModule = {
                  ok: true,
                  hasApp: typeof e.app === 'object' && e.app !== null,
                  hasBrowserWindow: typeof e.BrowserWindow === 'function',
                  windows: typeof e.BrowserWindow === 'function' ? e.BrowserWindow.getAllWindows().length : null,
                  screen: typeof e.screen === 'object' && e.screen !== null,
                };
              } else {
                info.electronModule = { ok: false, kind: typeof e, value: String(e).slice(0, 120) };
              }
            } catch (err) {
              info.electronModule = { ok: false, error: errorText(err) };
            }
            json(res, 200, info);
          }],

          // -------------------------------------------------- 桌面浮条协作
          // 客户端同步「桌面」清单 → 宿主镜像 → 外部小窗轮询读取
          ['/session-clean/desk-state', async (req, res) => {
            const method = String(req.method || 'GET').toUpperCase();
            if (method === 'GET') {
              writeDeskInfo(false);
              json(res, 200, {
                ok: true,
                items: deskMirror.items,
                updatedAt: deskMirror.updatedAt,
                port: webPort,
                theme: ensureThemeLoaded(),
              });
              return;
            }
            const body = await readBody(req);
            const list = Array.isArray(body.items) ? body.items : [];
            deskMirror.items = list
              .map((x) => {
                const id = String((x && x.sessionId) || '');
                const ws = id ? workspaceOf(dshHome, id) : null;
                // 标题三级兜底：客户端传来的 → 磁盘上的 → 空。空标题会让浮窗显示成 session-xxx
                const rec = id ? findSession(dshHome, id) : null;
                const title = String((x && x.title) || (rec && rec.title) || '');
                return {
                  sessionId: id,
                  title,
                  running: Boolean(x && x.running),
                  current: Boolean(x && x.current),
                  workspaceTitle: (ws && ws.title) || '',
                };
              })
              .filter((x) => x.sessionId)
              .slice(0, 12);
            deskMirror.updatedAt = Date.now();
            writeDeskInfo(false);
            // 桌面里有内容但浮窗不在（被关掉 / 崩了）→ 自动拉起：用户点「放到桌面」就是想要它出现
            if (deskMirror.items.length > 0) {
              const beatAge = readDeskHeartbeatAge();
              if (!(beatAge < 12000) && Date.now() - deskAutoStartAt > 8000) {
                deskAutoStartAt = Date.now();
                await runDeskCtl('start');
              }
            }
            json(res, 200, { ok: true, count: deskMirror.items.length, port: webPort });
          }],

          // 小窗点击 → 入队；客户端轮询取走后执行（打开 / 收回）
          /**
           * 动作队列：长轮询。
           * 请求最多挂 8 秒，一有动作立刻返回 —— 小窗点击到会话打开的延迟从 ~1.2s 降到 ~0.1s。
           */
          ['/session-clean/desk-pending', async (req, res) => {
            const deadline = Date.now() + 8000;
            while (!deskPending.length && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 120));
            }
            const actions = deskPending.splice(0, deskPending.length);
            json(res, 200, { ok: true, actions, theme: ensureThemeLoaded() });
          }],
          ['/session-clean/desk-open', async (req, res) => {
            const body = await readBody(req);
            const id = String(body.sessionId || '');
            if (!id) { json(res, 400, { ok: false, error: 'sessionId required' }); return; }
            deskPending.push({ action: 'open', sessionId: id, at: Date.now() });
            while (deskPending.length > 50) deskPending.shift();
            json(res, 200, { ok: true, queued: deskPending.length });
          }],
          ['/session-clean/desk-remove', async (req, res) => {
            const body = await readBody(req);
            const id = String(body.sessionId || '');
            if (!id) { json(res, 400, { ok: false, error: 'sessionId required' }); return; }
            deskPending.push({ action: 'remove', sessionId: id, at: Date.now() });
            while (deskPending.length > 50) deskPending.shift();
            json(res, 200, { ok: true, queued: deskPending.length });
          }],

          // 清空台账（不碰归档集合，也不碰会话文件）
          ['/session-clean/stash-clear', async (req, res) => {
            json(res, 200, { ...clearStash(dshHome), items: [] });
          }],

          // -------------------------------------------------- 历史遗留状态修复
          // 「被归档但文件还在」的会话：旧版本还原只搬文件不摘归档，留下的坑。
          ['/session-clean/archived-hidden', async (req, res) => {
            try {
              json(res, 200, listArchivedButVisible(dshHome));
            } catch (err) {
              json(res, 500, { ok: false, error: errorText(err) });
            }
          }],
          ['/session-clean/repair-archived', async (req, res) => {
            const body = await readBody(req);
            const ids = Array.isArray(body.ids) ? body.ids : null;
            try {
              const r = await repairArchivedSessions(ctx, dshHome, ids);
              json(res, r.ok ? 200 : 207, r);
            } catch (err) {
              json(res, 500, { ok: false, error: errorText(err) });
            }
          }],
        ];

        // 看门狗：期望运行但心跳超时 → 自动重启（连续失败 3 次熔断，避免无限拉起）
        webCtx.effect(() => {
          const timer = setInterval(async () => {
            try {
              if (deskWatch.paused) return;
              const want = readDeskDesired();
              if (!want.ok) return;              // 读不到就别动，避免把'已关闭'误判成'要运行'
              if (want.desired !== 'running') { deskWatch.fails = 0; return; }
              const age = readDeskHeartbeatAge();
              if (age < 12000) { deskWatch.fails = 0; return; }
              if (Date.now() - deskWatch.lastRestart < 30000) return;
              deskWatch.lastRestart = Date.now();
              log(ctx, 'info', `desk watchdog: heartbeat ${Math.round(age / 1000)}s stale, restarting`);
              const r = await runDeskCtl('restart');
              if (r && (r.running || r.window)) {
                deskWatch.fails = 0;
              } else {
                deskWatch.fails += 1;
                deskWatch.lastError = JSON.stringify(r).slice(0, 200);
                log(ctx, 'warn', `desk watchdog: restart failed (${deskWatch.fails}/3)`);
                if (deskWatch.fails >= 3) {
                  deskWatch.paused = true;
                  log(ctx, 'warn', 'desk watchdog paused after 3 failed restarts');
                }
              }
            } catch (err) {
              log(ctx, 'warn', `desk watchdog tick failed: ${errorText(err)}`);
            }
          }, 5000);
          return () => clearInterval(timer);
        }, 'dsh-session-clean: desk watchdog');
        // 包在 ctx.effect 里：插件卸载时自动注销。
        webCtx.effect(() => {
          const disposers = [];
          for (const [routePath, handler] of routes) {
            try {
              const guarded = async (req, res) => {
                if (!isSameOrigin(req)) {
                  log(ctx, 'warn', `blocked cross-origin ${req.method} ${routePath}`);
                  json(res, 403, { ok: false, error: 'cross-origin request blocked' });
                  return;
                }
                return handler(req, res);
              };
              disposers.push(server.register({ kind: 'exact', path: routePath, handler: guarded }));
            } catch (err) {
              log(ctx, 'warn', `route ${routePath} failed: ${errorText(err)}`);
            }
          }
          log(ctx, 'info', `routes mounted (${disposers.length}/${routes.length})`);
          return () => {
            for (const d of disposers) {
              try { if (typeof d === 'function') d(); } catch { /* ignore */ }
            }
          };
        }, 'dsh-session-clean: http routes');
      } catch (err) {
        log(ctx, 'warn', `route mount failed: ${errorText(err)}`);
      }
    });
  } catch (err) {
    // 加载失败绝不让宿主崩。
    try { console.error('[session-clean] load failed:', err); } catch { /* ignore */ }
  }
}

/**
 * 调用 scripts/desk-ctl.ps1（桌面浮窗的外部开关）。
 * 单独起一个 PowerShell 进程；失败/超时都退化成 {ok:false}，绝不抛到路由外。
 */
function runDeskCtl(action) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const scriptPath = fileURLToPath(new URL('../scripts/desk-ctl.ps1', import.meta.url));
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, action], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('error', () => finish({ ok: false, error: 'spawn-failed' }));
      child.on('close', () => {
        const text = out.trim();
        try { finish(JSON.parse(text)); } catch { finish({ ok: false, raw: text.slice(0, 400) }); }
      });
      setTimeout(() => finish({ ok: false, error: 'timeout' }), 15000);
    } catch (err) {
      finish({ ok: false, error: String((err && err.message) || err) });
    }
  });
}
/**
 * 本地 HTTP 无鉴权，必须挡住跨站写请求：
 * 恶意网页可以用 `content-type: text/plain` 发「简单请求」绕开 preflight，
 * 直接 POST /session-clean/purge-all 就能清空回收站。
 * 规则：GET/HEAD 放行；写操作要求同源（Origin 缺失视为非浏览器调用，放行）。
 */
function isSameOrigin(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return true;
  const headers = req.headers || {};
  const site = String(headers['sec-fetch-site'] || '');
  if (site === 'cross-site') return false;
  const origin = String(headers.origin || '');
  if (!origin) return true;
  try {
    const host = String(headers.host || '');
    if (!host) return false;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
function errorText(err) {
  return String(err && err.message ? err.message : err);
}

function json(res, status, payload) {
  try {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch { /* 响应失败不再抛 */ }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    try {
      req.on('data', (c) => { if (raw.length < 4e6) raw += c; });
      req.on('end', () => {
        try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
      });
      req.on('error', () => resolve({}));
    } catch {
      resolve({});
    }
  });
}

export {
  scanSessions,
  findSession,
  querySessions,
  selectSessions,
  listTrash,
  restoreBatch,
  purgeBatch,
  purgeAll,
  trashRoot,
  exportToDisk,
  exportZip,
  exportsRoot,
  listStash,
  addStash,
  removeStash,
  stashIds,
  clearStash,
  stashFile,
  isArchivedOnDisk,
  setArchivedOnDisk,
  workspaceOf,
};
