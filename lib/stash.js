/**
 * 隔离区台账：记录「哪些会话是被本插件抽出来的」。
 *
 * 归档集合（workspace.json 的 archivedSessionIds）不记来源 —— 用户自己在侧边栏
 * 归档的会话也在里面。要区分「用户自己归档的」和「我们抽出来隔离的」，就得有
 * 一份自己的小台账：
 *
 *   $DSH_HOME/session-clean/stash.json
 *   { "version": 1, "items": [ { sessionId, title, workspace, workspaceId, stashedAt } ] }
 *
 * 台账只影响展示：丢了它，会话依然在归档集合里，用官方「取消归档」也能救回来。
 * 所以读写失败一律降级，不阻断归档 / 取消归档本身。
 */

import fs from 'node:fs';
import path from 'node:path';

export const STASH_DIRNAME = 'session-clean';

export function stashFile(dshHome) {
  return path.join(dshHome, STASH_DIRNAME, 'stash.json');
}

function emptyState() {
  return { version: 1, items: [] };
}

function readState(dshHome) {
  try {
    const j = JSON.parse(fs.readFileSync(stashFile(dshHome), 'utf8'));
    if (!j || typeof j !== 'object') return emptyState();
    const items = Array.isArray(j.items) ? j.items.filter((x) => x && x.sessionId) : [];
    return { version: 1, items: items.map(normalize) };
  } catch {
    return emptyState();
  }
}

function normalize(item) {
  return {
    sessionId: String(item.sessionId),
    title: typeof item.title === 'string' ? item.title : '',
    workspace: typeof item.workspace === 'string' ? item.workspace : '',
    workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : '',
    stashedAt: typeof item.stashedAt === 'string' && item.stashedAt ? item.stashedAt : new Date(0).toISOString(),
  };
}

function writeState(dshHome, state) {
  const file = stashFile(dshHome);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, items: state.items }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/** 全部台账条目，最近抽出的在前。 */
export function listStash(dshHome) {
  const state = readState(dshHome);
  return [...state.items].sort((a, b) => String(b.stashedAt).localeCompare(String(a.stashedAt)));
}

export function hasStash(dshHome, sessionId) {
  const id = String(sessionId);
  return readState(dshHome).items.some((x) => x.sessionId === id);
}

export function stashIds(dshHome) {
  return readState(dshHome).items.map((x) => x.sessionId);
}

/**
 * 记一条（同 id 覆盖，刷新标题与时间）。
 * @returns {{ ok: boolean, item?: object, error?: string }}
 */
export function addStash(dshHome, item) {
  const state = readState(dshHome);
  const next = normalize({
    ...item,
    stashedAt: new Date().toISOString(),
  });
  const rest = state.items.filter((x) => x.sessionId !== next.sessionId);
  const w = writeState(dshHome, { items: [next, ...rest] });
  return w.ok ? { ok: true, item: next } : { ok: false, error: w.error };
}

/** 摘一条；本来就不在返回 false，不算失败。 */
export function removeStash(dshHome, sessionId) {
  const state = readState(dshHome);
  const id = String(sessionId);
  const rest = state.items.filter((x) => x.sessionId !== id);
  if (rest.length === state.items.length) return { ok: true, removed: false };
  const w = writeState(dshHome, { items: rest });
  return w.ok ? { ok: true, removed: true } : { ok: false, removed: false, error: w.error };
}

/** 清空台账（不碰归档集合，也不碰会话文件）。 */
export function clearStash(dshHome) {
  return writeState(dshHome, { items: [] });
}
