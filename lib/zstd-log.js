/**
 * 会话正文读取：DSH 的 `session.v4.jsonl.zstd` 不是单个 zstd 帧，而是
 * **多帧拼接**（header 一帧，之后每个 append 批次一帧）。
 *
 * Node 的 `zstdDecompressSync` / `createZstdDecompress` 只解第一帧就收工，
 * 直接用它读整份日志只会得到 header 一行 —— 这就是「会话明明有内容，
 * 扫出来却是空」的根因。所以这里必须先按 zstd 帧结构切边界，再逐帧解压。
 *
 * 帧扫描逻辑与 `@deepseek-ai/dsh-session-persistence-jsonl` 的
 * `scanZstdFrames` 同构（只解析帧头与 block header，不解 block 数据），
 * 因为那是唯一能可靠拿到帧边界的方式：magic 可能出现在压缩数据内部，
 * 不能靠搜索 `28 B5 2F FD` 切分。
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * zstd 解压在 Node 22.15 才进入 zlib。低版本不是「解不出来」，而是 API 根本不存在，
 * 直接调用会抛 TypeError，掩盖真正原因。这里统一给一个能看懂的错误。
 */
export function hasZstd() {
  return typeof zlib.zstdDecompressSync === 'function';
}

function requireZstd() {
  if (!hasZstd()) {
    throw new Error('zstd 解压需要 Node 22.15+（当前 ' + process.version + '）。DSH 桌面自带的是 Node 22+，一般不会走到这里。');
  }
}

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 little-endian

/**
 * 定位全部完整 zstd 帧。
 * @param {Buffer} buffer
 * @param {number} [maxFrames]
 * @returns {{ frames: Array<{start:number,end:number}>, tornStart?: number }}
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`corrupt zstd log: reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }

    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/**
 * 解出整个文件的明文（多帧逐个解，坏帧跳过不中断）。
 * @param {string} file
 * @returns {{ text: string, frames: number, tornStart?: number, failedFrames: number }}
 */
export function decodeSessionFile(file) {
  const buffer = fs.readFileSync(file);
  let scan;
  try {
    scan = scanZstdFrames(buffer);
  } catch {
    // 结构损坏到无法切帧：退化成「整块一次解」，至少能读到第一帧。
    try {
      return {
        text: (requireZstd(), zlib.zstdDecompressSync(buffer)).toString('utf8'),
        frames: 1,
        failedFrames: 0,
      };
    } catch {
      return { text: '', frames: 0, failedFrames: 0 };
    }
  }

  const parts = [];
  let failedFrames = 0;
  for (const frame of scan.frames) {
    try {
      requireZstd();
            parts.push(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'));
    } catch {
      failedFrames += 1;
    }
  }
  return { text: parts.join(''), frames: scan.frames.length, tornStart: scan.tornStart, failedFrames };
}

/**
 * 读取一个会话的全部事件。
 *
 * @param {{ sessionDir?: string|null, sessionFiles?: string[] }} rec
 * @returns {{ ok: boolean, header: object|null, events: object[], frames: number, failedFrames: number, error?: string }}
 */
export function readSessionEvents(rec) {
  const files = (rec && (rec.sessionFiles && rec.sessionFiles.length ? rec.sessionFiles : null))
    || (rec && rec.sessionDir ? [pickMainFile(rec.sessionDir)].filter(Boolean) : []);

  if (!files.length) return { ok: false, header: null, events: [], frames: 0, failedFrames: 0, error: 'no session file' };

  const main = files[0];
  const decoded = decodeSessionFile(main);
  const lines = decoded.text.split('\n').filter((l) => l.trim() !== '');

  let header = null;
  const events = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 半截行/坏行：跳过，不因为一行坏掉整场对话
    }
    if (!header && obj && obj.type === 'session') {
      header = obj;
      continue;
    }
    if (obj && typeof obj === 'object') events.push(obj);
  }

  return {
    ok: lines.length > 0,
    header,
    events,
    frames: decoded.frames,
    failedFrames: decoded.failedFrames,
    error: lines.length ? undefined : 'empty log',
  };
}

function pickMainFile(dir) {
  try {
    const names = fs.readdirSync(dir).filter((n) => n.startsWith('session.') && n.includes('.jsonl'));
    if (!names.length) return null;
    // 优先非 .zstd 之外没有歧义的主文件；排序保证确定性。
    names.sort();
    return require_path_join(dir, names[0]);
  } catch {
    return null;
  }
}

function require_path_join(dir, name) {
  // 避免多引一次 path 造成命名污染，这里就地拼（Windows/ POSIX 都成立）。
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}
