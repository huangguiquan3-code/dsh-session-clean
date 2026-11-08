/**
 * 存储层：定位一个会话在磁盘上的全部落点，并做配对校验。
 *
 * DSH 一个会话落在两处：
 *   1. <DSH_HOME>/sessions/<工作区目录>/<sessionId>/session.v4.jsonl.zstd   正文
 *   2. <DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json      投影缓存
 *
 * 只删对不上的会留下孤儿：删了正文，列表里还剩个空标题；删了缓存，正文还在。
 * 所以这里只认「两处都能找到」的会话，缺一处就报 incomplete，不猜。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const SESSIONS_DIRNAME = 'sessions';
export const PROJCACHE_REL = ['storages', 'session_projcache', 'sessions'];

export function sessionsRoot(dshHome) {
  return path.join(dshHome, SESSIONS_DIRNAME);
}
export function projcacheRoot(dshHome) {
  return path.join(dshHome, ...PROJCACHE_REL);
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 会话正文文件（可能带分片，取主文件即可判断存在性）。 */
function sessionFiles(sessionDir) {
  try {
    return fs.readdirSync(sessionDir)
      .filter((n) => n.startsWith('session.') && n.includes('.jsonl'))
      .map((n) => path.join(sessionDir, n));
  } catch {
    return [];
  }
}

function readHeader(fp) {
  try {
    const buf = fs.readFileSync(fp);
    let text;
    try {
      text = zlib.zstdDecompressSync ? zlib.zstdDecompressSync(buf).toString('utf8') : buf.toString('utf8');
    } catch {
      text = buf.toString('utf8');
    }
    const line = text.split('\n').find((l) => l.trim());
    if (!line) return null;
    const j = JSON.parse(line);
    return j && j.type === 'session' ? j : null;
  } catch {
    return null;
  }
}

function titleOf(projcacheFile) {
  try {
    const j = JSON.parse(fs.readFileSync(projcacheFile, 'utf8'));
    const t = j && j.record && j.record.rows && j.record.rows.title && j.record.rows.title.val;
    if (typeof t !== 'string') return '';
    return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  } catch {
    return '';
  }
}

function sizeOfSafe(target) {
  try {
    const st = fs.lstatSync(target);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let total = 0;
    for (const e of fs.readdirSync(target, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      total += sizeOfSafe(path.join(target, e.name));
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * 读工作区注册表：谁归档了、每个会话属于哪个工作区（用来给列表加标签）。
 * 读不到就当全空 —— 这个文件只影响展示，不影响删除。
 */
export function readWorkspaceState(dshHome) {
  const file = path.join(dshHome, 'storages', 'workspace.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const archived = new Set(((j.global && j.global.archivedSessionIds) || []).map(String));
    const byId = new Map();
    const tables = (j.tables && j.tables.workspaces) || {};
    for (const [workspaceId, ws] of Object.entries(tables)) {
      if (!ws) continue;
      for (const sid of ws.sessionIds || []) {
        byId.set(String(sid), {
          workspaceId,
          title: ws.title || '',
          path: ws.path || '',
        });
      }
    }
    return { archived, byId };
  } catch {
    return { archived: new Set(), byId: new Map() };
  }
}

/**
 * 扫描全部会话，返回配对结果。
 * @returns {{ complete: Array, incomplete: Array, total: number }}
 */
export function scanSessions(dshHome) {
  const sRoot = sessionsRoot(dshHome);
  const pRoot = projcacheRoot(dshHome);

  const byId = new Map();

  for (const wsDir of listDirs(sRoot)) {
    const wsPath = path.join(sRoot, wsDir);
    for (const sid of listDirs(wsPath)) {
      const sessionDir = path.join(wsPath, sid);
      const files = sessionFiles(sessionDir);
      if (files.length === 0) continue;
      const header = readHeader(files[0]);
      const st = fs.statSync(files[0]);
      byId.set(sid, {
        sessionId: sid,
        sessionDir,
        sessionFiles: files,
        workspace: (header && header.cwd) || '',
        createdAt: (header && header.createdAt) || 0,
        mtime: st.mtimeMs,
        bytes: sizeOfSafe(sessionDir),
      });
    }
  }

  for (const name of (() => {
    try { return fs.readdirSync(pRoot); } catch { return []; }
  })()) {
    if (!name.endsWith('.json')) continue;
    const sid = name.slice(0, -'.json'.length);
    const cacheFile = path.join(pRoot, name);
    const rec = byId.get(sid) || {
      sessionId: sid,
      sessionDir: null,
      sessionFiles: [],
      workspace: '',
      createdAt: 0,
      mtime: 0,
      bytes: 0,
    };
    rec.cacheFile = cacheFile;
    rec.cacheBytes = sizeOfSafe(cacheFile);
    rec.title = titleOf(cacheFile);
    byId.set(sid, rec);
  }

  const complete = [];
  const incomplete = [];
  const state = readWorkspaceState(dshHome);
  for (const rec of byId.values()) {
    const meta = state.byId.get(String(rec.sessionId));
    rec.archived = state.archived.has(String(rec.sessionId));
    rec.workspaceTitle = meta ? meta.title : '';
    rec.workspaceId = meta ? meta.workspaceId : '';
    rec.inWorkspace = Boolean(meta);
    if (rec.sessionDir && rec.cacheFile) complete.push(rec);
    else incomplete.push(rec);
  }

  const key = (r) => r.mtime || r.createdAt || 0;
  complete.sort((a, b) => key(b) - key(a));
  incomplete.sort((a, b) => key(b) - key(a));

  return { complete, incomplete, total: byId.size };
}

/** 按 id 找一条（含不完整的）。 */
export function findSession(dshHome, sessionId) {
  const { complete, incomplete } = scanSessions(dshHome);
  return complete.find((r) => r.sessionId === sessionId)
    || incomplete.find((r) => r.sessionId === sessionId)
    || null;
}

/** 这个会话是否两处齐全（齐全才能安全删除）。 */
export function isComplete(rec) {
  return Boolean(rec && rec.sessionDir && rec.cacheFile);
}

﻿/**
 * 带检索的会话列表（侧边栏面板用）。
 * @param {string} dshHome
 * @param {{ q?: string, limit?: number, includeArchived?: boolean }} [opts]
 */
export function querySessions(dshHome, opts = {}) {
  const { complete, incomplete } = scanSessions(dshHome);
  const needle = String(opts.q || '').trim().toLowerCase();
  const match = (r) => {
    if (!needle) return true;
    return [r.title, r.sessionId, r.workspace, r.workspaceTitle]
      .some((v) => String(v || '').toLowerCase().includes(needle));
  };

  let items = complete.filter(match);
  if (opts.includeArchived === false) items = items.filter((r) => !r.archived);
  const limit = Number(opts.limit) || 0;
  if (limit > 0) items = items.slice(0, limit);

  return { items, incomplete: incomplete.filter(match), total: complete.length, matched: items.length };
}

/**
 * 按 id 批量取记录（保持传入顺序），并回报找不到的 id。
 * @param {string} dshHome
 * @param {string[]} ids
 */
export function selectSessions(dshHome, ids) {
  const list = Array.isArray(ids) ? ids : [];
  const { complete, incomplete } = scanSessions(dshHome);
  const all = new Map();
  for (const r of [...complete, ...incomplete]) all.set(String(r.sessionId), r);
  const records = [];
  const missing = [];
  for (const id of list) {
    const rec = all.get(String(id));
    if (rec) records.push(rec);
    else missing.push(String(id));
  }
  return { records, missing };
}
