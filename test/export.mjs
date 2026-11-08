/**
 * 导出链路测试：多帧 zstd 解析 → Markdown/JSON 渲染 → 落盘 → ZIP。
 *
 * 全部在临时目录里跑，不碰真实 $DSH_HOME，也不碰任何会话文件。
 * 重点覆盖一个曾经导致「扫出来是空」的坑：会话日志是多帧拼接的，
 * 只解第一帧就只剩 header。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { scanSessions } from '../lib/store.js';
import { readSessionEvents, scanZstdFrames } from '../lib/zstd-log.js';
import { buildMarkdown, buildJson } from '../lib/transcript.js';
import { exportToDisk, exportZip, renderExport } from '../lib/export.js';
import { createZip } from '../lib/zip.js';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`FAIL  ${name}  — ${err.message}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sc-export-'));
process.on('exit', () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------- 造夹具
function frame(text) {
  // 不带校验和：scanZstdFrames 支持带/不带，两种都要能切。
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

const SID = 'session-test-0001';
const projDir = path.join(root, 'sessions', '--C-Users-test-project--', SID);
fs.mkdirSync(projDir, { recursive: true });

const header = {
  type: 'session',
  version: 4,
  id: SID,
  createdAt: Date.parse('2026-11-05T11:59:46Z'),
  cwd: 'C:\\Users\\test\\project',
  isSeeded: false,
  delegationDepth: 0,
};

const batch1 = [
  line({ type: 'turn/start', seq: 4, data: { turn: 1 } }),
  line({
    type: 'user/message',
    seq: 5,
    data: {
      content: [{ type: 'text', text: '只回复两个字：你好' }],
      source: { kind: 'user' },
      role: 'user',
      id: 'u1',
    },
  }),
  line({
    type: 'user/message',
    seq: 6,
    data: {
      content: [{ type: 'text', text: 'Current working directory: ...' }],
      source: { kind: 'runtime-context' },
      role: 'user',
      id: 'u2',
    },
  }),
].join('');

const batch2 = [
  line({
    type: 'assistant/message',
    seq: 7,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '这句不该出现在默认转录里' },
          { type: 'text', text: '你好' },
        ],
      },
      stream: [{ type: 'chunk', chunk: { type: 'text-chunks' } }],
    },
  }),
  line({
    type: 'tool/call',
    seq: 8,
    data: {
      turn: 1,
      step: 1,
      callId: 'call_1',
      name: 'pwsh',
      arguments: JSON.stringify({ description: '看端口', command: 'Test-NetConnection -Port 22' }),
    },
  }),
  line({
    type: 'tool/result',
    seq: 9,
    data: {
      turn: 1,
      step: 1,
      toolCallId: 'call_1',
      message: { role: 'tool', content: [{ type: 'text', text: 'TcpTestSucceeded : True' }] },
    },
  }),
  line({ type: 'turn/end', seq: 10, data: { turn: 1, reason: { kind: 'completed' } } }),
  line({ type: 'session/title', seq: 11, data: { title: '测试会话', messageSeqs: [5] } }),
].join('');

const sessionFile = path.join(projDir, 'session.v4.jsonl.zstd');
fs.writeFileSync(sessionFile, Buffer.concat([frame(line(header)), frame(batch1), frame(batch2)]));

const cacheDir = path.join(root, 'storages', 'session_projcache', 'sessions');
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(
  path.join(cacheDir, `${SID}.json`),
  JSON.stringify({
    version: 7,
    record: {
      identity: { createdAt: header.createdAt, cwd: header.cwd, isSeeded: false },
      rows: { title: { ver: 1, seq: 11, val: '缓存里的旧标题' } },
    },
  }),
);

// 一个只有缓存、没有正文的孤儿：应当出现在 incomplete 里，且不会被导出
const ORPHAN = 'session-test-orphan';
fs.writeFileSync(path.join(cacheDir, `${ORPHAN}.json`), JSON.stringify({ version: 7, record: { identity: {}, rows: {} } }));

fs.mkdirSync(path.join(root, 'storages'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'storages', 'workspace.json'),
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { archivedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-1': { path: header.cwd, title: '测试工作区', sessionIds: [SID] },
      },
    },
  }),
);

// ---------------------------------------------------------------- 断言
const scan = scanSessions(root);

check('扫描到 1 个可删会话（孤儿在 incomplete）', () => {
  assert.equal(scan.complete.length, 1, `complete=${scan.complete.length}`);
  assert.equal(scan.incomplete.length, 1);
  assert.equal(scan.complete[0].sessionId, SID);
});

check('会话带上工作区与归档标记', () => {
  const rec = scan.complete[0];
  assert.equal(rec.workspaceTitle, '测试工作区');
  assert.equal(rec.archived, false);
});

check('多帧 zstd 能切出 3 帧', () => {
  const { frames } = scanZstdFrames(fs.readFileSync(sessionFile));
  assert.equal(frames.length, 3, `frames=${frames.length}`);
});

check('多帧解码拿到全部事件（不是只剩 header）', () => {
  const parsed = readSessionEvents(scan.complete[0]);
  assert.equal(parsed.header.cwd, header.cwd);
  assert.ok(parsed.events.length >= 8, `events=${parsed.events.length}`);
  assert.equal(parsed.failedFrames, 0);
});

check('Markdown：含用户/助手/工具三段，且不含 runtime-context 与思考', () => {
  const rec = scan.complete[0];
  const parsed = readSessionEvents(rec);
  const md = buildMarkdown(rec, parsed);
  assert.ok(md.includes('只回复两个字：你好'), '缺用户文本');
  assert.ok(md.includes('你好'), '缺助手文本');
  assert.ok(md.includes('🔧'), '缺工具调用');
  assert.ok(md.includes('Test-NetConnection'), '工具参数没渲染');
  assert.ok(md.includes('TcpTestSucceeded'), '缺工具结果');
  assert.ok(!md.includes('Current working directory'), 'runtime-context 应被过滤');
  assert.ok(!md.includes('这句不该出现在默认转录里'), 'reasoning 默认不导出');
});

check('Markdown：标题取事件里的最新标题，工作目录进表头', () => {
  const rec = scan.complete[0];
  const md = buildMarkdown(rec, readSessionEvents(rec));
  assert.ok(md.startsWith('# 测试会话'), md.split('\n')[0]);
  assert.ok(md.includes('C:\\Users\\test\\project'));
});

check('JSON：events 数量与解析一致', () => {
  const rec = scan.complete[0];
  const parsed = readSessionEvents(rec);
  const obj = JSON.parse(buildJson(rec, parsed));
  assert.equal(obj.sessionId, SID);
  assert.equal(obj.events.length, parsed.events.length);
});

check('exportToDisk：写出 md + index.md 到指定目录', () => {
  const out = path.join(root, 'out');
  // 模拟 CLI：本机可信调用，允许写到 exports 之外
  const r = exportToDisk(root, scan.complete, { format: 'md', dir: out, allowOutside: true });
  assert.ok(r.ok, r.error);
  const files = fs.readdirSync(out);
  assert.ok(files.includes('index.md'), `files=${files.join(',')}`);
  const md = files.find((f) => f.endsWith('.md') && f !== 'index.md');
  assert.ok(md, '没有正文文件');
  const body = fs.readFileSync(path.join(out, md), 'utf8');
  assert.ok(body.length > 200, `md 只有 ${body.length} 字节`);
  const index = fs.readFileSync(path.join(out, 'index.md'), 'utf8');
  assert.ok(index.includes(md), '索引里没有链接');
});

check('renderExport：缓存孤儿被计入 skipped 且不产出文件', () => {
  const r = renderExport([scan.incomplete[0]], { format: 'md' });
  assert.equal(r.rows.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.files.length, 1); // 只有 index.md
});

check('exportToDisk：HTTP 场景不得写到 exports 之外', () => {
  const out = path.join(root, 'outside-http');
  const r = exportToDisk(root, scan.complete, { format: 'md', dir: out });
  assert.equal(r.ok, false, '应拒绝 exports 之外的目录');
  assert.match(String(r.error), /inside the exports folder/);
  assert.ok(!fs.existsSync(out), '不应创建目录');
});

check('exportZip：返回 PK 头 + 中央目录项数正确', () => {
  const r = exportZip(scan.complete, { format: 'both' });
  assert.ok(r.ok, r.error);
  const buf = r.buffer;
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, '缺 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  assert.equal(count, r.stats.files, `entries=${count} stats=${r.stats.files}`);
  assert.ok(r.filename.endsWith('.zip'));
});

check('createZip：空集合也产出合法空包', () => {
  const buf = createZip([]);
  assert.equal(buf.length, 22);
  assert.equal(buf.readUInt16LE(10), 0);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(' -', f.name, f.detail);
  process.exit(1);
}
