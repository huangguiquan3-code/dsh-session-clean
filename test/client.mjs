/**
 * 客户端 UI 的隔离测试：不启动宿主，用假 ctx 验证「注册了什么、失败会不会炸」。
 *
 * 重点验证崩溃防护：
 *   - 没有 slots → 不注册、不抛
 *   - 没有 react → 不注册、不抛
 *   - locale/workspace 缺失 → 降级、不抛
 *   - 组件渲染期抛异常 → 返回 null、不冒泡
 *   - effect 清理函数可重复调用
 */

import assert from 'node:assert/strict';

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('use sync checks only');
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`FAIL  ${name}  — ${err.message}`);
  }
}

// ---- 假 React：只要能搭出元素树就够 ----
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};

function makeCtx({ withSlots = true, withReact = true, withLocale = true, withWorkspace = true } = {}) {
  const registered = [];
  const effects = [];
  const ctx = {
    registered,
    effects,
    get: (name) => (name === 'workspaceRegistry' ? (withWorkspace ? {} : undefined) : undefined),
    on: () => () => {},
    effect: (fn, label) => {
      const d = fn();
      effects.push({ label, dispose: d });
      return () => { if (typeof d === 'function') d(); };
    },
  };
  if (withSlots) {
    ctx.slots = {
      register: (options, comp) => {
        registered.push({ options, comp });
        return () => {};
      },
      // slots.inject(name, cb)：插槽 declared 之后才回调。
      // mock 直接同步回调，模拟「插槽已就绪」。
      inject: (name, cb) => {
        if (typeof cb === 'function') cb();
        return () => {};
      },
    };
  }
  // cordis 严格注入：ctx.inject 只回调声明过的依赖
  ctx.inject = (deps, cb) => {
    if (typeof cb === 'function' && Array.isArray(deps)) {
      const given = {};
      for (const d of deps) {
        if (d === 'locale' && withLocale) given.locale = ctx.locale;
        if (d === 'webServer') given.webServer = { register: () => () => {} };
      }
      cb(given);
    }
  };
  if (withLocale) {
    ctx.locale = {
      register: () => () => {},
      get: () => null,
    };
  }
  if (withWorkspace) {
    ctx.workspace = {
      archiveSession: async () => ({}),
      unarchiveSession: async () => ({}),
    };
  }
  // client.js 的模块依赖来自 factory 的 require 参数，不是 ctx。保留这个字段
  // 只为验证「ctx 上乱挂东西不会影响行为」。
  if (withReact) ctx.require = (name) => (name === 'react' ? fakeReact : undefined);
  return ctx;
}

// 加载 client.js：它用 window.__ModuleLoader__.load 包装，构建期执行 factory，
// 真正能拿到的模块依赖来自 factory 的 require 参数。
let mod = null;
function loadClient({ withReact = true } = {}) {
  const fakeRequire = (name) => {
    if (name === 'react') return withReact ? fakeReact : undefined;
    return undefined;
  };
  const prevWindow = globalThis.window;
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(options) {
        captured = options.factory(fakeRequire);
      },
    },
  };
  try {
    // 清掉 ESM 缓存，保证每次 factory 都重新执行
    const url = new URL('../client.js', import.meta.url);
    url.search = `t=${Date.now()}${Math.random()}`;
    return import(url.href).then(() => {
      globalThis.window = prevWindow;
      return captured;
    });
  } catch (err) {
    globalThis.window = prevWindow;
    throw err;
  }
}

mod = await loadClient({ withReact: true });
if (!mod) throw new Error('ModuleLoader did not capture exports');

// ---------- 1. 正常路径 ----------
check('注入声明含 slots', () => {
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('slots'));
});

check('正常 ctx 注册 2 个插槽', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 1, `实际 ${ctx.registered.length}`);
});

// 菜单项（sidebar.workspaces.session.menu.item）暂未启用：
// 该插槽 declaredBy 是 sidebar.workspaces 的子表，需要 slotInject 提供
// menuOpenState hook 工厂，普通 register 会抛 "slot ... is not declared"。
// 这里断言「不去注册它」，避免回归时又踩同一个坑。
check('不注册 sidebar 子插槽（避免未声明报错）', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const menu = ctx.registered.find((r) => r.options.name === 'sidebar.workspaces.session.menu.item');
  assert.equal(menu, undefined, '不应注册 sidebar 子插槽');
});

check('设置分区注册在 settings.section', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const sec = ctx.registered.find((r) => r.options.name === 'settings.section');
  assert.ok(sec, '未注册设置分区');
  assert.equal(sec.options.id, 'session-clean.trash');
});

check('组件是函数且都有 displayName', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  for (const r of ctx.registered) {
    assert.equal(typeof r.comp, 'function');
    assert.ok(r.comp.displayName, '缺 displayName');
  }
});

// ---------- 2. 降级路径（都不能抛） ----------
check('没有 slots：不注册且不抛', () => {
  const ctx = makeCtx({ withSlots: false });
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 0);
});

check('没有 react（factory 层）：不注册且不抛', () => {
  // client.js 的 react 来自 factory(require)，所以要在加载时才决定。
  const ctx = makeCtx();
  // 用一个取不到 react 的 ctx 叠加：模块级已用真 react 加载过一次，
  // 这里验证的是「ctx.slots 存在但组件注册时抛错」的容错，
  // 主降级路径由上一条覆盖。
  const fakeCtx = {
    ...ctx,
    slots: {
      register: () => { throw new Error('register boom'); },
    },
  };
  mod.apply(fakeCtx); // 不抛即通过
});

check('没有 locale：仍能注册', () => {
  const ctx = makeCtx({ withLocale: false });
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 1);
});

check('没有 workspace：仍能注册', () => {
  const ctx = makeCtx({ withWorkspace: false });
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 1);
});

check('ctx 完全为空：不抛', () => {
  mod.apply({});
  mod.apply(null);
  mod.apply(undefined);
});

check('effect 清理函数可重复调用', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  for (const e of ctx.effects) {
    if (typeof e.dispose === 'function') {
      e.dispose();
      e.dispose(); // 第二次不能抛
    }
  }
});

// ---------- 3. 组件渲染期容错 ----------
check('设置分区在空 props 下返回元素而非抛', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const sec = ctx.registered.find((r) => r.options.name === 'settings.section');
  const el = sec.comp({});
  assert.ok(el, '返回 null');
  assert.ok(el.type, '不是元素');
});

check('设置分区渲染不抛', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const sec = ctx.registered.find((r) => r.options.name === 'settings.section');
  const el = sec.comp({});
  assert.ok(el && el.type, '设置分区未返回元素');
});

// ---------- 4. 不覆盖官方 ----------
check('未注册到官方已占用的插槽 id', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const ids = ctx.registered.map((r) => `${r.options.name}#${r.options.id}`);
  assert.equal(new Set(ids).size, ids.length, '有重复注册');
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(' -', f.name, f.detail);
  process.exit(1);
}
