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
    };
  }
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
  if (withReact) ctx.require = (name) => (name === 'react' ? fakeReact : undefined);
  return ctx;
}

const mod = await import('../client.js');

// ---------- 1. 正常路径 ----------
check('注入声明含 slots', () => {
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('slots'));
});

check('正常 ctx 注册 2 个插槽', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 2, `实际 ${ctx.registered.length}`);
});

check('菜单项注册在 session.menu.item 且 id 唯一', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const menu = ctx.registered.find((r) => r.options.name === 'sidebar.workspaces.session.menu.item');
  assert.ok(menu, '未注册菜单项');
  assert.equal(menu.options.id, 'session-clean.delete');
  assert.equal(menu.options.order, 480);
  // 不能撞官方 id：pin/rename/fork/archive/session-id
  const shipped = ['pin', 'rename', 'fork', 'archive', 'session-id'];
  assert.ok(!shipped.includes(menu.options.id), 'id 与官方冲突');
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

check('没有 react：不注册且不抛', () => {
  const ctx = makeCtx({ withReact: false });
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 0);
});

check('没有 locale：仍能注册', () => {
  const ctx = makeCtx({ withLocale: false });
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 2);
});

check('没有 workspace：仍能注册', () => {
  const ctx = makeCtx({ withWorkspace: false });
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 2);
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
check('菜单组件在空 props 下返回元素而非抛', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const menu = ctx.registered.find((r) => r.options.name === 'sidebar.workspaces.session.menu.item');
  const el = menu.comp({});
  assert.ok(el, '返回 null');
  assert.ok(el.type, '不是元素');
});

check('菜单组件 props 全 undefined 也不抛', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const menu = ctx.registered.find((r) => r.options.name === 'sidebar.workspaces.session.menu.item');
  menu.comp({ sessionId: undefined, useMenuOpenState: undefined });
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
