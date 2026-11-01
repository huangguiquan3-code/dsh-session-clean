// 用 V8 的 Script 编译（浏览器非模块脚本走同一条路径）
// 如果还有顶层 export，会抛 SyntaxError: Unexpected token 'export'
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let ok = true;
try {
  new vm.Script(src, { filename: 'client.js' });
  console.log('PASS  非模块脚本编译通过（无顶层 export）');
} catch (err) {
  ok = false;
  console.log('FAIL  编译失败:', err.message);
}

// 再模拟执行一次，确认 factory 能跑
const calls = [];
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(options) {
        calls.push(options.id);
        const exp = options.factory((name) => {
          if (name === 'react') {
            return {
              createElement: () => ({ type: 'div' }),
              useState: (v) => [v, () => {}],
              useEffect: () => {},
              useCallback: (f) => f,
            };
          }
          return undefined;
        });
        globalThis.__captured = exp;
      },
    },
  },
  console,
};
try {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  console.log(`PASS  模块加载器被调用: ${calls.join(',')}`);
} catch (err) {
  ok = false;
  console.log('FAIL  执行失败:', err.message);
}

// 验证导出形态
const exp = globalThis.__captured;
if (exp && typeof exp.apply === 'function' && Array.isArray(exp.inject)) {
  console.log(`PASS  导出正确: apply=${typeof exp.apply} inject=${JSON.stringify(exp.inject)}`);
} else {
  ok = false;
  console.log('FAIL  导出不正确:', exp && Object.keys(exp));
}

process.exit(ok ? 0 : 1);
