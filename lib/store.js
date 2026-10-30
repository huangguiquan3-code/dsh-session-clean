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
  for (const rec of byId.values()) {
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
