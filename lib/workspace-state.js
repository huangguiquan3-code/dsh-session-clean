/**
 * 工作区注册表（$DSH_HOME/storages/workspace.json）的读写。
 *
 * 为什么需要它：DSH 的「归档」不是文件操作，而是往 global.archivedSessionIds
 * 里塞一个 id。侧边栏渲染时用这份集合过滤行 —— 所以「把文件搬回原处」并不能让
 * 会话重新出现，必须同时把它从归档集合里摘掉。
 *
 * 两条路径：
 *   - 进程内：优先调官方 workspaceRegistry.unarchiveSession()（会写穿到磁盘、
 *     并给客户端发增量），本文件只在拿不到 registry 时兜底；
 *   - CLI / 兜底：直接改文件。**必须在 DSH 客户端退出后**用，否则宿主内存里的
 *     注册表会在下一次写入时覆盖本文件的改动。
 *
 * 结构（unit version 2）：
 *   { unit, global: { archivedSessionIds, pinnedSessionIds, workspaceIds, ... },
 *     tables: { workspaces: { <workspaceId>: { path, title, sessionIds[] } } } }
 */

import fs from 'node:fs';
import path from 'node:path';

export function workspaceStateFile(dshHome) {
  return path.join(dshHome, 'storages', 'workspace.json');
}

/** 原子写 JSON：先写 .tmp 再 rename，写完保留一个 .bak 便于肉眼回滚。 */
export function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, `${file}.bak`);
      } catch {
        /* 备份失败不影响主流程 */
      }
    }
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/** 原样读出注册表；文件不存在或坏掉返回 null（调用方自行降级）。 */
export function readWorkspaceStateRaw(dshHome) {
  try {
    const j = JSON.parse(fs.readFileSync(workspaceStateFile(dshHome), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** 归档集合（拿不到就是空集）。 */
export function workspaceArchivedSet(dshHome) {
  const j = readWorkspaceStateRaw(dshHome);
  const ids = (j && j.global && Array.isArray(j.global.archivedSessionIds))
    ? j.global.archivedSessionIds
    : [];
  return new Set(ids.map(String));
}

export function isArchivedOnDisk(dshHome, sessionId) {
  return workspaceArchivedSet(dshHome).has(String(sessionId));
}

/**
 * 会话属于哪个工作区（按 workspaces 表的 sessionIds 反查）。
 * @returns {{ workspaceId: string, title: string, path: string } | null}
 */
export function workspaceOf(dshHome, sessionId) {
  const j = readWorkspaceStateRaw(dshHome);
  const tables = (j && j.tables && j.tables.workspaces) || {};
  const id = String(sessionId);
  for (const workspaceId of Object.keys(tables)) {
    const ws = tables[workspaceId];
    if (!ws || !Array.isArray(ws.sessionIds)) continue;
    if (ws.sessionIds.some((sid) => String(sid) === id)) {
      return {
        workspaceId,
        title: typeof ws.title === 'string' ? ws.title : '',
        path: typeof ws.path === 'string' ? ws.path : '',
      };
    }
  }
  return null;
}

/**
 * 直接改磁盘上的归档集合。
 *
 * @param {string} dshHome
 * @param {string} sessionId
 * @param {boolean} archived true=加入归档集合，false=从集合里摘掉
 * @returns {{ ok: boolean, changed?: boolean, error?: string }}
 */
export function setArchivedOnDisk(dshHome, sessionId, archived) {
  const j = readWorkspaceStateRaw(dshHome);
  if (!j) return { ok: false, error: 'workspace.json unreadable' };

  const id = String(sessionId);
  if (!j.global || typeof j.global !== 'object') j.global = {};
  const current = Array.isArray(j.global.archivedSessionIds) ? j.global.archivedSessionIds.map(String) : [];
  const has = current.includes(id);

  let next;
  if (archived) {
    if (has) return { ok: true, changed: false };
    next = [...current, id];
  } else {
    if (!has) return { ok: true, changed: false };
    next = current.filter((x) => x !== id);
  }

  j.global.archivedSessionIds = next;
  // 归档与置顶互斥：加归档时顺手清掉置顶，跟官方 archiveSession 行为一致。
  if (archived && Array.isArray(j.global.pinnedSessionIds)) {
    j.global.pinnedSessionIds = j.global.pinnedSessionIds.filter((x) => String(x) !== id);
  }

  const w = atomicWriteJson(workspaceStateFile(dshHome), j);
  return w.ok ? { ok: true, changed: true } : { ok: false, error: w.error };
}
