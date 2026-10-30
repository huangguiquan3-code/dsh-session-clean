/**
 * dsh-session-clean —— 会话删除（回收站 + 可还原）
 *
 * 约束（用户明确要求）：
 *   - 不改官方任何文件，尤其不改官方 client.js；
 *   - 客户端不能崩：所有入口 try/catch，失败只记日志不 throw；
 *   - 删除 = 移进回收站，可还原；只有 purge 才真删。
 *
 * 两种运行模式：
 *   进程内（本文件 index.js）：有 workspaceRegistry 时先调官方 archiveSession
 *     拿到 session-active 保护，再做文件移动。
 *   外部 CLI（bin/session-clean.js）：只做文件操作，强制要求客户端已退出。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanSessions, findSession, isComplete } from './store.js';
import { moveToTrash, listTrash, restoreBatch, purgeBatch, purgeAll, trashRoot } from './trash.js';

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

  // 1) 有官方 API 就先归档：它会拦下带活动任务的会话，并立刻从列表里摘掉。
  let archived = false;
  try {
    const registry = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
    if (registry && typeof registry.archiveSession === 'function') {
      await registry.archiveSession(sessionId, { stopActivity: options.stopActivity !== false });
      archived = true;
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // session-active：有任务在跑，拒绝删除。
    if (/session-active|active/i.test(msg)) {
      return { ok: false, error: 'session-active', detail: msg };
    }
    log(ctx, 'warn', `archive failed (continuing with file move): ${msg}`);
  }

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
  return { ok: true, batchId: r.batchId, bytes: r.bytes, archived, title: rec.title };
}

/** 批量删除归档的会话（archive 集合由宿主提供；外部模式靠 --archived-list 传入）。 */
export async function deleteMany(ctx, ids, options = {}) {
  const results = [];
  for (const id of ids) {
    try {
      results.push({ id, ...(await deleteSession(ctx, id, options)) });
    } catch (err) {
      results.push({ id, ok: false, error: String(err && err.message ? err.message : err) });
    }
  }
  return {
    ok: results.every((r) => r.ok),
    deleted: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok),
    results,
  };
}

/** 进程内插件入口：挂 HTTP 路由，供设置页的回收站面板调用。 */
export function apply(ctx) {
  try {
    const dshHome = resolveDshHome();
    log(ctx, 'info', `loaded (home=${dshHome})`);

    // 路由只在宿主提供了 web server 服务时挂载；没有就安静退场。
    try {
      const server = ctx && typeof ctx.get === 'function'
        ? (ctx.get('webServer') || ctx.get('hostWebServer') || ctx.get('server'))
        : undefined;
      const route = server && typeof server.route === 'function' ? server.route.bind(server)
        : server && typeof server.get === 'function' ? null
          : null;

      if (route) {
        route('GET', '/session-clean/trash', async (req, res) => {
          json(res, 200, { items: listTrash(dshHome) });
        });
        route('POST', '/session-clean/restore', async (req, res) => {
          const body = await readBody(req);
          const r = restoreBatch(dshHome, String(body.batchId || ''));
          json(res, r.ok ? 200 : 409, r);
        });
        route('POST', '/session-clean/purge', async (req, res) => {
          const body = await readBody(req);
          const r = purgeBatch(dshHome, String(body.batchId || ''));
          json(res, r.ok ? 200 : 404, r);
        });
        route('POST', '/session-clean/purge-all', async (req, res) => {
          json(res, 200, purgeAll(dshHome));
        });
        log(ctx, 'info', 'routes mounted under /session-clean/*');
      } else {
        log(ctx, 'info', 'no web server service; routes not mounted (CLI still works)');
      }
    } catch (err) {
      // 路由挂载失败不影响插件加载，CLI 仍可用。
      log(ctx, 'warn', `route mount failed: ${err && err.message ? err.message : err}`);
    }
  } catch (err) {
    // 加载失败绝不让宿主崩。
    try { console.error('[session-clean] load failed:', err); } catch { /* ignore */ }
  }
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
      req.on('data', (c) => { if (raw.length < 1e6) raw += c; });
      req.on('end', () => {
        try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
      });
      req.on('error', () => resolve({}));
    } catch {
      resolve({});
    }
  });
}

export { scanSessions, findSession, listTrash, restoreBatch, purgeBatch, purgeAll, trashRoot };
