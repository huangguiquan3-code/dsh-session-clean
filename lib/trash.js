/**
 * 回收站：会话存档的移入 / 列出 / 还原 / 彻底清除。
 *
 * 设计原则：
 *   1. 只用 rename，不用 rm —— 到「彻底清空」为止不动一个字节的数据；
 *   2. 每次移入创建一个时间戳批次目录，manifest.json 记录原始路径，
 *      还原时按原路径反向 rename，不猜、不重建；
 *   3. 任何一步失败都整体回滚本次移动，不留下半残的批次；
 *   4. 账本写坏不影响还原 —— manifest 只在批次目录里，看目录就能还原。
 */

import fs from 'node:fs';
import path from 'node:path';

export const TRASH_DIRNAME = 'trash-sessions';

export function trashRoot(dshHome) {
  return path.join(dshHome, TRASH_DIRNAME);
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 原子写 JSON。 */
function writeJson(fp, obj) {
  ensureDir(path.dirname(fp));
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 文件或目录大小（字节）。目录递归。
 * 失败返回 0，绝不因为算不出大小而中断删除。
 */
export function sizeOf(target) {
  try {
    const st = fs.lstatSync(target);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let total = 0;
    for (const e of fs.readdirSync(target, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      total += sizeOf(path.join(target, e.name));
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * 把一个会话的若干条目移进回收站。
 *
 * @param {string} dshHome
 * @param {{ sessionId: string, title?: string, workspace?: string,
 *           entries: Array<{ source: string, kind: 'session'|'cache'|'other' }> }} item
 * @returns {{ ok: boolean, batchId?: string, moved?: string[], bytes?: number, error?: string }}
 */
export function moveToTrash(dshHome, item) {
  const entries = (item.entries || []).filter((e) => e && e.source && fs.existsSync(e.source));
  if (entries.length === 0) {
    return { ok: false, error: 'no source entries exist' };
  }

  const batchId = stamp() + '-' + String(item.sessionId).slice(0, 12);
  const batchDir = path.join(trashRoot(dshHome), batchId);
  ensureDir(batchDir);

  const moved = [];
  const manifest = {
    batchId,
    sessionId: item.sessionId,
    title: item.title || '',
    workspace: item.workspace || '',
    deletedAt: new Date().toISOString(),
    items: [],
  };

  try {
    let idx = 0;
    for (const e of entries) {
      idx += 1;
      const name = `${String(idx).padStart(2, '0')}-${e.kind || 'other'}-${path.basename(e.source)}`;
      const dest = path.join(batchDir, name);
      const bytes = sizeOf(e.source);
      // rename 是原子的。跨卷才需要回退到 copy+rm，这里明确要求同卷：
      // 回收站在 $DSH_HOME 下，会话也在 $DSH_HOME 下，正常情况下同卷。
      try {
        fs.renameSync(e.source, dest);
      } catch (err) {
        if (err && err.code === 'EXDEV') {
          copyThenRemove(e.source, dest);
        } else {
          throw err;
        }
      }
      manifest.items.push({ kind: e.kind || 'other', originalPath: e.source, storedAs: name, bytes });
      moved.push({ from: e.source, to: dest, bytes });
    }
    const totalBytes = manifest.items.reduce((s, x) => s + x.bytes, 0);
    manifest.bytes = totalBytes;
    writeJson(path.join(batchDir, 'manifest.json'), manifest);
    return { ok: true, batchId, moved: moved.map((m) => m.to), bytes: totalBytes };
  } catch (err) {
    // 回滚：把已经移走的放回去，删掉空批次目录。
    for (const m of moved.reverse()) {
      try {
        fs.renameSync(m.to, m.from);
      } catch { /* 回滚失败也要继续尝试其余项 */ }
    }
    try {
      fs.rmSync(batchDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function copyThenRemove(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  } else {
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

/** 列出回收站里全部批次，按时间倒序。 */
export function listTrash(dshHome) {
  const root = trashRoot(dshHome);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const m = readJson(path.join(dir, 'manifest.json'));
    out.push({
      batchId: name,
      dir,
      sessionId: (m && m.sessionId) || '',
      title: (m && m.title) || '',
      workspace: (m && m.workspace) || '',
      deletedAt: (m && m.deletedAt) || st.mtime.toISOString(),
      bytes: (m && m.bytes) || sizeOf(dir),
      items: (m && m.items) || [],
      broken: !m,
    });
  }
  out.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  return out;
}

/**
 * 还原一个批次：按 manifest 的 originalPath 反向 rename。
 *
 * 逐项独立处理，单项失败不影响其他项：
 *   - 批次里已无该项（上次已还原成功）→ 跳过，不计冲突；
 *   - 目标已存在且内容相同     → 视为已还原（幂等）；
 *   - 目标已存在但内容不同     → conflict，保留在批次里不覆盖。
 * 只有「批次里还有、且没被还原」的项才算失败。
 */
export function restoreBatch(dshHome, batchId, options = {}) {
  const dir = path.join(trashRoot(dshHome), batchId);
  if (!fs.existsSync(dir)) return { ok: false, error: 'batch not found' };
  const m = readJson(path.join(dir, 'manifest.json'));
  if (!m || !Array.isArray(m.items)) {
    return { ok: false, error: 'manifest missing or unreadable' };
  }

  const restored = [];
  const already = [];
  const conflicts = [];
  const blocked = [];

  for (const it of m.items) {
    const src = path.join(dir, it.storedAs);
    const hasSrc = fs.existsSync(src);
    const hasTarget = fs.existsSync(it.originalPath);

    // 上次已经还原过：源不在、目标在。
    if (!hasSrc && hasTarget) { already.push(it.originalPath); continue; }
    if (!hasSrc && !hasTarget) {
      blocked.push({ path: it.originalPath, reason: 'both sides missing' });
      continue;
    }

    if (hasTarget && !options.overwrite) {
      // 内容一致就当还原过了，避免「重复还原报冲突」这种假失败。
      if (sameContent(src, it.originalPath)) { already.push(it.originalPath); continue; }
      blocked.push({ path: it.originalPath, reason: 'target exists with different content' });
      continue;
    }

    try {
      ensureDir(path.dirname(it.originalPath));
      if (options.overwrite && hasTarget) {
        fs.rmSync(it.originalPath, { recursive: true, force: true });
      }
      try {
        fs.renameSync(src, it.originalPath);
      } catch (err) {
        if (err && err.code === 'EXDEV') copyThenRemove(src, it.originalPath);
        else throw err;
      }
      restored.push(it.originalPath);
    } catch (err) {
      blocked.push({ path: it.originalPath, reason: String(err && err.message ? err.message : err) });
    }
  }

  conflicts.push(...blocked.filter((b) => b.reason === 'target exists with different content'));
  const unresolved = blocked.filter((b) => b.reason !== 'target exists with different content');

  // 全部条目都归位（含「本来就在」的）→ 批次可删。
  if (blocked.length === 0) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    // 部分成功：重写 manifest，只保留还没归位的项，便于再次 restore。
    const remain = m.items.filter((it) => {
      const settled = restored.includes(it.originalPath) || already.includes(it.originalPath);
      return !settled;
    });
    if (remain.length !== m.items.length) {
      writeJson(path.join(dir, 'manifest.json'), { ...m, items: remain, partial: true });
      // 清掉已归位条目留下的空壳文件
      for (const it of m.items) {
        if (!remain.some((r) => r.storedAs === it.storedAs)) {
          try { fs.rmSync(path.join(dir, it.storedAs), { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
    }
  }

  return {
    ok: blocked.length === 0,
    restored,
    already,
    conflicts,
    unresolved,
    batchId,
  };
}

/** 两个路径的内容是否一致（文件比字节；目录比文件数与总长，足够判重）。 */
function sameContent(a, b) {
  try {
    const sa = fs.lstatSync(a);
    const sb = fs.lstatSync(b);
    if (sa.isFile() && sb.isFile()) {
      if (sa.size !== sb.size) return false;
      return fs.readFileSync(a).equals(fs.readFileSync(b));
    }
    if (sa.isDirectory() && sb.isDirectory()) {
      return sizeOf(a) === sizeOf(b);
    }
    return false;
  } catch {
    return false;
  }
}

/** 彻底清除一个批次（不可恢复）。这才是唯一真正 rm 的地方。 */
export function purgeBatch(dshHome, batchId) {
  const dir = path.join(trashRoot(dshHome), batchId);
  if (!fs.existsSync(dir)) return { ok: false, error: 'batch not found' };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, batchId };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

export function purgeAll(dshHome) {
  const list = listTrash(dshHome);
  const done = [];
  const failed = [];
  for (const b of list) {
    const r = purgeBatch(dshHome, b.batchId);
    if (r.ok) done.push(b.batchId);
    else failed.push({ batchId: b.batchId, error: r.error });
  }
  return { ok: failed.length === 0, purged: done, failed };
}
