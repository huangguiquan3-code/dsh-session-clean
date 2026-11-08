#!/usr/bin/env node
/**
 * prompt-diag —— 只读诊断系统提示词组装。
 *
 * 用法（必须在宿主进程内运行才有 systemPrompt 服务）：
 *   node bin/prompt-diag.js
 *
 * 由于 systemPrompt 是宿主运行时服务，独立 CLI 无法直接拿到。
 * 本文件提供两种用法：
 *   1. 通过宿主插件调用（推荐）：lib/prompt-diagnostics.js 导出 runDiagnostics
 *   2. 若已导出组装快照 JSON，可直接分析该文件
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeAssembly, analyzeSections, renderReport } from '../lib/prompt-diagnostics.js';

const args = process.argv.slice(2);
const fromFile = args[0];

if (!fromFile) {
  console.log(`prompt-diag —— 系统提示词组装诊断

用法：
  node bin/prompt-diag.js <assembly-snapshot.json>

说明：
  systemPrompt 是宿主的运行时服务，独立进程拿不到。
  需要在宿主插件里调用 runDiagnostics() 拿到 assembly，
  把结果存成 JSON 后用本工具分析。

  在插件里这样取：
    import { runDiagnostics } from './lib/prompt-diagnostics.js'
    const r = await runDiagnostics(ctx)
    // r.report / r.analysis / r.markdown
`);
  process.exit(0);
}

if (!fs.existsSync(fromFile)) {
  console.error(`文件不存在: ${fromFile}`);
  process.exit(1);
}

try {
  // 去掉可能的 UTF-8 BOM（Windows PowerShell 写文件常见）
  const text = fs.readFileSync(fromFile, 'utf8').replace(/^\uFEFF/, '');
  const raw = JSON.parse(text);
  const report = normalizeAssembly(raw);
  const analysis = analyzeSections(report);
  const md = renderReport(report, analysis);

  console.log(md);

  const outPath = path.join(path.dirname(fromFile), 'prompt-diagnostics-report.md');
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`\n报告已保存: ${outPath}`);
} catch (err) {
  console.error('分析失败:', err && err.message ? err.message : err);
  process.exit(1);
}
