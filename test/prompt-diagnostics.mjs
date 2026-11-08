import assert from 'node:assert/strict';
import { normalizeAssembly, analyzeSections, renderReport, runDiagnostics } from '../lib/prompt-diagnostics.js';

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
    console.log(`FAIL  ${name}  — ${e.message}`);
  }
};

// 1) 正常装配
check('规整 sections 数组', () => {
  const r = normalizeAssembly({
    sections: [
      { name: 'dsh-purge', text: '注入正文' },
      { name: 'workspace', text: 'x'.repeat(200) },
    ],
  });
  assert.equal(r.sections.length, 2);
  assert.equal(r.sections[0].name, 'dsh-purge');
  assert.equal(r.sections[0].length, 4);
  assert.ok(r.sections[1].head.includes('[+'));
});

// 2) 重复段检测
check('检出重复段', () => {
  const r = normalizeAssembly({
    sections: [
      { name: 'persona', text: 'a' },
      { name: 'persona', text: 'b' },
    ],
  });
  const a = analyzeSections(r);
  assert.ok(a.findings.some((f) => f.code === 'DUPLICATE_SECTION'));
});

// 3) 空段检测
check('检出空段', () => {
  const r = normalizeAssembly({ sections: [{ name: 'blank', text: '' }] });
  const a = analyzeSections(r);
  assert.ok(a.findings.some((f) => f.code === 'EMPTY_SECTION'));
});

// 4) 超大段检测
check('检出超大段', () => {
  const r = normalizeAssembly({ sections: [{ name: 'huge', text: 'x'.repeat(120000) }] });
  const a = analyzeSections(r);
  assert.ok(a.findings.some((f) => f.code === 'OVERSIZED_SECTION'));
});

// 5) 总字符统计
check('统计总字符', () => {
  const r = normalizeAssembly({ sections: [{ name: 'a', text: '12345' }, { name: 'b', text: '678' }] });
  const a = analyzeSections(r);
  assert.equal(a.totalChars, 8);
});

// 6) 输入不合法不抛
check('assembly 为 null 不抛', () => {
  const r = normalizeAssembly(null);
  assert.equal(r.sections.length, 0);
  analyzeSections(r);
});

// 7) Markdown 报告
check('生成 Markdown', () => {
  const r = normalizeAssembly({ sections: [{ name: 'x', text: 'hello' }] });
  const a = analyzeSections(r);
  const md = renderReport(r, a);
  assert.ok(md.includes('# 系统提示词组装诊断'));
  assert.ok(md.includes('| 0 | x | 5 |'));
});

// 8) 无服务时返回错误而不是抛
await (async () => {
  const r = await runDiagnostics({ get: () => undefined });
  check('无 systemPrompt 返回错误', () => {
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('unavailable'));
  });
})();

// 9) ctx 为空不抛
await (async () => {
  const r = await runDiagnostics(null);
  check('ctx 为 null 不抛', () => assert.equal(r.ok, false));
})();

// 10) 假服务能跑通
await (async () => {
  const fake = {
    get: (n) => (n === 'systemPrompt'
      ? { assemble: async () => ({ sections: [{ name: 'inject', text: 'hello world' }] }) }
      : undefined),
  };
  const r = await runDiagnostics(fake);
  check('假服务跑通', () => {
    assert.equal(r.ok, true);
    assert.equal(r.report.sections.length, 1);
    assert.ok(r.markdown.includes('inject'));
  });
})();

// 11) assemble 抛错被捕获
await (async () => {
  const bad = { get: () => ({ assemble: async () => { throw new Error('boom'); } }) };
  const r = await runDiagnostics(bad);
  check('assemble 抛错被捕获', () => {
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('boom'));
  });
})();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
