/**
 * 批量导出：把选中的会话抽成独立的 Markdown / JSON 文件，可选直接落盘或打成一个 ZIP。
 *
 * 用途很直接：会话多了以后，想找的那一场往往隔了几十条。
 * 与其在侧边栏里翻，不如把需要的几场单独提出来，放到一个目录里慢慢看。
 *
 * 边界：
 *   - 只读，不动任何会话文件；
 *   - 单个会话读不出来就跳过并记进 `skipped`，不影响其他会话；
 *   - 文件名去重、去非法字符，中文标题保留。
 */

import fs from 'node:fs';
import path from 'node:path';

import { readSessionEvents } from './zstd-log.js';
import { buildMarkdown, buildJson, summarize, fmtTime, humanBytes } from './transcript.js';
import { createZip } from './zip.js';

export const EXPORTS_DIRNAME = 'exports';

export function exportsRoot(dshHome) {
  return path.join(dshHome, EXPORTS_DIRNAME);
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 文件名安全化：去掉路径分隔符与 Windows 保留字符，保留中日韩文字。 */
export function slugify(text, fallback = 'session', max = 48) {
  const raw = String(text == null ? '' : text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const trimmed = raw.slice(0, max).trim();
  return trimmed || fallback;
}

function idTail(sessionId) {
  const s = String(sessionId || '');
  return s.replace(/^session-/, '').slice(0, 8) || 'unknown';
}

function nameFor(rec, format, used) {
  const created = new Date(Number(rec.createdAt) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const day = `${created.getFullYear()}${p(created.getMonth() + 1)}${p(created.getDate())}-${p(created.getHours())}${p(created.getMinutes())}`;
  const base = `${day}-${slugify(rec.title, idTail(rec.sessionId))}-${idTail(rec.sessionId)}`;
  let name = `${base}.${format}`;
  let n = 2;
  while (used.has(name)) {
    name = `${base}-${n}.${format}`;
    n += 1;
  }
  used.add(name);
  return name;
}

/**
 * 把一批会话渲染成内存里的文件集合（不落盘）。
 *
 * @param {Array<object>} records 扫描记录
 * @param {object} [opts] { format: 'md'|'json'|'both', reasoning?, system? }
 * @returns {{ files: Array<{name:string,data:Buffer}>, index: string, stats: object, skipped: Array }}
 */
export function renderExport(records, opts = {}) {
  const format = opts.format === 'json' || opts.format === 'both' ? opts.format : 'md';
  const used = new Set();
  const files = [];
  const rows = [];
  const skipped = [];
  let bytes = 0;

  for (const rec of records || []) {
    const parsed = readSessionEvents(rec);
    if (!parsed.ok && !parsed.events.length) {
      skipped.push({ sessionId: rec.sessionId, title: rec.title || '', reason: parsed.error || 'unreadable' });
      continue;
    }

    const summary = summarize(rec, parsed);
    const emitted = [];

    if (format === 'md' || format === 'both') {
      const md = buildMarkdown(rec, parsed, opts);
      const name = nameFor(rec, 'md', used);
      files.push({ name, data: Buffer.from(md, 'utf8') });
      emitted.push(name);
    }
    if (format === 'json' || format === 'both') {
      const json = buildJson(rec, parsed);
      const name = nameFor(rec, 'json', used);
      files.push({ name, data: Buffer.from(json, 'utf8') });
      emitted.push(name);
    }

    bytes += (rec.bytes || 0) + (rec.cacheBytes || 0);
    rows.push({
      sessionId: rec.sessionId,
      title: summary.title,
      createdAt: rec.createdAt || 0,
      turns: summary.turnCount,
      bytes: rec.bytes || 0,
      firstUser: summary.firstUser,
      files: emitted,
    });
  }

  const index = buildIndex(rows, { format, compiledAt: new Date() });
  files.push({ name: 'index.md', data: Buffer.from(index, 'utf8') });

  return {
    files,
    index,
    skipped,
    stats: {
      sessions: rows.length,
      files: files.length,
      bytes,
      format,
      skipped: skipped.length,
    },
    rows,
  };
}

function buildIndex(rows, opts) {
  const lines = [];
  lines.push(`# 会话导出索引\n`);
  lines.push(`导出时间：${fmtTime(Date.now())}  ·  会话 ${rows.length} 场  ·  格式 ${opts.format}\n`);
  if (!rows.length) {
    lines.push('_（本次没有导出任何会话）_\n');
    return lines.join('\n');
  }
  lines.push('| 标题 | 时间 | 轮次 | 大小 | 文件 |');
  lines.push('|---|---|---|---|---|');
  for (const r of rows) {
    const title = String(r.title || r.sessionId).replace(/\|/g, '\\|').slice(0, 60);
    const links = r.files.map((f) => `[${f}](${encodeURI(f)})`).join(' ');
    lines.push(`| ${title} | ${fmtTime(r.createdAt)} | ${r.turns || '-'} | ${humanBytes(r.bytes)} | ${links} |`);
  }
  lines.push('');
  const samples = rows.filter((r) => r.firstUser).slice(0, 30);
  if (samples.length) {
    lines.push('## 开场白速览\n');
    for (const r of samples) lines.push(`- **${r.title}** — ${r.firstUser}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 导出到磁盘：`<DSH_HOME>/exports/<时间戳>/`。
 *
 * @param {string} dshHome
 * @param {Array<object>} records
 * @param {object} [opts] { format?, dir? }
 * @returns {{ ok: boolean, dir?: string, files?: string[], stats?: object, skipped?: Array, error?: string }}
 */
export function exportToDisk(dshHome, records, opts = {}) {
  if (!Array.isArray(records) || records.length === 0) return { ok: false, error: 'no sessions selected' };

  const rendered = renderExport(records, opts);
  if (!rendered.rows.length) {
    return { ok: false, error: 'nothing readable', skipped: rendered.skipped };
  }

  // dir 来自本地 HTTP 请求体时可能被指定成任意绝对路径（例如启动目录），
  // 默认只允许写进 $DSH_HOME/exports；CLI 明确传 allowOutside 才放开。
  let dir;
  if (opts.dir) {
    const wanted = path.resolve(String(opts.dir));
    if (opts.allowOutside === true) {
      dir = wanted;
    } else {
      const root = path.resolve(exportsRoot(dshHome));
      const inside = wanted === root || wanted.startsWith(root + path.sep);
      if (!inside) return { ok: false, error: 'dir must be inside the exports folder' };
      dir = wanted;
    }
  } else {
    dir = path.join(exportsRoot(dshHome), stamp());
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const written = [];
    for (const file of rendered.files) {
      const target = path.join(dir, file.name);
      fs.writeFileSync(target, file.data);
      written.push(target);
    }
    return { ok: true, dir, files: written, stats: rendered.stats, skipped: rendered.skipped };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), dir, skipped: rendered.skipped };
  }
}

/**
 * 导出为一个 ZIP 的 Buffer（供浏览器直接下载）。
 * @param {Array<object>} records
 * @param {object} [opts]
 * @returns {{ ok: boolean, buffer?: Buffer, filename?: string, stats?: object, skipped?: Array, error?: string }}
 */
export function exportZip(records, opts = {}) {
  if (!Array.isArray(records) || records.length === 0) return { ok: false, error: 'no sessions selected' };
  const rendered = renderExport(records, opts);
  if (!rendered.rows.length) return { ok: false, error: 'nothing readable', skipped: rendered.skipped };
  try {
    const buffer = createZip(rendered.files);
    return {
      ok: true,
      buffer,
      filename: `dsh-sessions-${stamp()}.zip`,
      stats: rendered.stats,
      skipped: rendered.skipped,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}
