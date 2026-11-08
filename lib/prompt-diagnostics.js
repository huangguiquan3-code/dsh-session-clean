/**
 * prompt-diagnostics —— 只读诊断：抓取实际发给模型的系统提示词结构。
 *
 * 目的（对应 GPT 的建议）：
 *   1. 系统内容是否被截断
 *   2. personaPrefix 与插件内容最终放在哪里
 *   3. 是否发生重复、矛盾或错误角色归属
 *
 * 硬约束：
 *   - 只读：不修改任何提示词、不写宿主的运行状态
 *   - 不落盘敏感内容：只记录结构（段名、长度、前后各 N 字符）
 *   - 任何失败都不影响宿主
 */

const DEFAULT_PREVIEW = 160;

function safeSlice(s, n = DEFAULT_PREVIEW) {
  const str = String(s == null ? '' : s);
  if (str.length <= n) return str;
  return `${str.slice(0, n)}…[+${str.length - n}]`;
}

/** 把 assembly 对象规整成可分析的条目列表。 */
export function normalizeAssembly(assembly) {
  const out = { sections: [], raw: null };

  if (!assembly || typeof assembly !== 'object') return out;

  // assembly 可能是 { sections: [...] } 或直接数组
  const list = Array.isArray(assembly.sections)
    ? assembly.sections
    : Array.isArray(assembly)
      ? assembly
      : null;

  if (list) {
    list.forEach((sec, i) => {
      if (!sec) return;
      const name = sec.name || sec.id || sec.key || `#${i}`;
      const text = typeof sec.text === 'string'
        ? sec.text
        : typeof sec.content === 'string'
          ? sec.content
          : JSON.stringify(sec.value ?? sec).slice(0, 4000);
      out.sections.push({
        index: i,
        name,
        length: text.length,
        head: safeSlice(text),
      });
    });
  } else {
    out.raw = safeSlice(JSON.stringify(assembly), 800);
  }

  return out;
}

/** 找可疑特征。 */
export function analyzeSections(report) {
  const findings = [];
  const secs = report.sections || [];
  const total = secs.reduce((n, s) => n + s.length, 0);

  // 1) 同名段重复
  const seen = new Map();
  for (const s of secs) {
    const k = String(s.name);
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(s.index);
  }
  for (const [name, idxs] of seen) {
    if (idxs.length > 1 && name !== 'undefined') {
      findings.push({
        level: 'warn',
        code: 'DUPLICATE_SECTION',
        message: `段 "${name}" 出现 ${idxs.length} 次（index ${idxs.join(',')}）`,
      });
    }
  }

  // 2) persona / 身份类段的位置
  const personaIdx = secs
    .filter((s) => /persona|identity|harness/i.test(String(s.name)))
    .map((s) => ({ i: s.index, n: s.name, len: s.length }));
  if (personaIdx.length) {
    findings.push({
      level: 'info',
      code: 'PERSONA_SECTIONS',
      message: personaIdx.map((p) => `#${p.i} ${p.n}(${p.len})`).join(' | '),
    });
  }

  // 3) 空段（可能是组装失败）
  const empty = secs.filter((s) => s.length === 0);
  if (empty.length) {
    findings.push({
      level: 'warn',
      code: 'EMPTY_SECTION',
      message: `${empty.length} 个空段：${empty.map((s) => s.name).join(', ')}`,
    });
  }

  // 4) 异常大的段（可能把整个文件塞进去了）
  const huge = secs.filter((s) => s.length > 100000);
  if (huge.length) {
    findings.push({
      level: 'warn',
      code: 'OVERSIZED_SECTION',
      message: huge.map((s) => `${s.name}: ${s.length} 字符`).join(', '),
    });
  }

  // 5) 单段占比过高（注入挤压对话空间）
  const ranked = [...secs].sort((a, b) => b.length - a.length);
  const top = ranked[0];
  if (top && total > 0 && top.length / total > 0.5 && total > 20000) {
    findings.push({
      level: 'warn',
      code: 'DOMINANT_SECTION',
      message: `"${top.name}" 占全部的 ${Math.round((top.length / total) * 100)}%（${top.length}/${total} 字符）`,
    });
  }

  findings.push({
    level: 'info',
    code: 'TOTAL',
    message: `${secs.length} 个段，合计 ${total} 字符`,
  });

  // 明细：每段长度按降序
  const breakdown = ranked.map((s) => ({
    index: s.index,
    name: String(s.name),
    length: s.length,
    percent: total > 0 ? Math.round((s.length / total) * 1000) / 10 : 0,
  }));

  return { findings, totalChars: total, sectionCount: secs.length, breakdown };
}

/**
 * 生成 Markdown 报告（不含敏感原文，只有结构 + 预览）。
 */
export function renderReport(report, analysis) {
  const lines = [];
  lines.push('# 系统提示词组装诊断');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push(`段数：${analysis.sectionCount}　总字符：${analysis.totalChars}`);
  lines.push('');
  lines.push('## 发现');
  lines.push('');
  for (const f of analysis.findings) {
    const icon = f.level === 'warn' ? '⚠️' : '·';
    lines.push(`- ${icon} **${f.code}** ${f.message}`);
  }
  lines.push('');
  lines.push('## 段落明细（按顺序）');
  lines.push('');
  lines.push('| # | 名称 | 长度 | 开头预览 |');
  lines.push('|---|---|---|---|');
  for (const s of report.sections) {
    const head = s.head.replace(/\n/g, ' ').replace(/\|/g, '\\|');
    lines.push(`| ${s.index} | ${s.name} | ${s.length} | ${head} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 在宿主里执行一次组装并生成报告。
 * 需要 ctx 上有 systemPrompt 服务。
 * @returns {Promise<{ok:boolean, report?:object, analysis?:object, markdown?:string, error?:string}>}
 */
export async function runDiagnostics(ctx) {
  try {
    if (!ctx) return { ok: false, error: 'no ctx' };

    // 严格注入：不能裸取
    const sp = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
    if (!sp || typeof sp.assemble !== 'function') {
      return { ok: false, error: 'systemPrompt service unavailable' };
    }

    const assembly = await sp.assemble({});
    const report = normalizeAssembly(assembly);
    const analysis = analyzeSections(report);
    const markdown = renderReport(report, analysis);
    return { ok: true, report, analysis, markdown };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

export const name = 'prompt-diagnostics';
