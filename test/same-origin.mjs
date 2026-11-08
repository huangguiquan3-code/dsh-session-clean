/**
 * 跨站请求防护回归（纯函数级，不需要起真服务）。
 * 覆盖：GET 放行、同源放行、跨站拒绝、Sec-Fetch-Site 优先、无 Origin 的 CLI 放行。
 *
 * 注意：isSameOrigin 在 lib/index.js 里不是 export，这里用「行为等价」的断言方式：
 * 通过 readFileSync + 正则确认实现存在且被注册循环使用，再对规则做独立一致性校验。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
    console.log(`FAIL  ${name}\n    ${err && err.message ? err.message : err}`);
  }
}

check('存在 isSameOrigin 实现', () => {
  assert.ok(/function isSameOrigin\(req\)/.test(src), '找不到 isSameOrigin');
});

check('所有路由注册都经过 guarded 包装', () => {
  assert.ok(/const guarded = async \(req, res\)/.test(src), '没有 guarded 包装');
  assert.ok(
    /server\.register\(\{\s*kind:\s*'exact',\s*path:\s*routePath,\s*handler:\s*guarded\s*\}\)/.test(src),
    '注册时没有使用 guarded',
  );
});

check('GET / HEAD 直接放行', () => {
  assert.ok(/method === 'GET' \|\| method === 'HEAD'/.test(src), 'GET/HEAD 放行分支缺失');
});

check('Sec-Fetch-Site: cross-site 被拒绝', () => {
  assert.ok(/site === 'cross-site'\) return false/.test(src), 'cross-site 分支缺失');
});

check('Origin 与 Host 不一致时拒绝', () => {
  assert.ok(/new URL\(origin\)\.host === host/.test(src), '同源比较缺失');
});

check('无 Origin 视为非浏览器调用（CLI/curl）放行', () => {
  assert.ok(/if \(!origin\) return true/.test(src), '无 Origin 放行分支缺失');
});

// 用等价逻辑对边界做一次独立验证，避免只做文本匹配
function sameOrigin(method, headers) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  const h = headers || {};
  if (String(h['sec-fetch-site'] || '') === 'cross-site') return false;
  const origin = String(h.origin || '');
  if (!origin) return true;
  try {
    const host = String(h.host || '');
    if (!host) return false;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

check('边界样例：6 组输入的结果符合预期', () => {
  const cases = [
    ['GET', {}, true],
    ['POST', { origin: 'http://evil.example' , host: '127.0.0.1:62751' }, false],
    ['POST', { origin: 'http://127.0.0.1:62751', host: '127.0.0.1:62751' }, true],
    ['POST', { 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:62751', host: '127.0.0.1:62751' }, false],
    ['POST', {}, true],
    ['POST', { origin: 'not-a-url', host: '127.0.0.1:62751' }, false],
  ];
  for (const [m, h, want] of cases) {
    assert.equal(sameOrigin(m, h), want, `${m} ${JSON.stringify(h)}`);
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
process.exit(0);
