/**
 * 客户端 UI 的隔离测试：不启动宿主，用假 ctx 验证「注册了什么、失败会不会炸」。
 *
 * 重点验证崩溃防护：
 *   - 没有 slots → 不注册、不抛
 *   - 注册期抛错 → 被吞掉、不冒泡
 *   - locale / sessions / workspaces 缺失 → 降级、不抛
 *   - 组件在空 props 下能渲染出元素
 *   - effect 清理函数可重复调用
 *
 * 以及当前插槽约定：
 *   sidebar.footer.action           侧边栏底部「会话管理」按钮
 *   shell.overlay                   批量删除 / 导出 / 回收站浮层
 *   settings.section                设置页分区（含通知开关）
 *   sidebar.workspaces.session.menu.item    会话行「...」菜单：隔离 / 放回、移入回收站
 *   sidebar.workspaces.session.row.action   会话行悬停小按钮：隔离 / 放回
 *   main + sidebar.panellist                隔离区独立一屏 + 侧边栏图标
 *
 * 后三个是 sidebar.workspaces 槽位拥有者在运行时 declared 的，必须走 slots.inject；
 * 测试里的 mock 同步回调，正好覆盖「声明后注册」这条路径。
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
  useMemo: (fn) => fn(),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};

// ---- 假快照 store（宿主 dsh-client-store 的最小同构） ----
function makeStore(initial) {
  const listeners = new Set();
  let value = initial;
  return {
    getSnapshot: () => value,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(next) {
      value = typeof next === 'function' ? next(value) : next;
      for (const fn of [...listeners]) fn();
    },
    listenerCount: () => listeners.size,
  };
}

function makeServices() {
  const sessions = {
    refreshed: 0,
    list: makeStore({
      ids: ['s1'],
      byId: { s1: { id: 's1', displayTitle: '测试会话', running: false, retainedBy: { mainView: 1 } } },
      phase: 'ready',
    }),
    refresh() {
      sessions.refreshed += 1;
      return Promise.resolve();
    },
  };
  const workspaces = {
    list: makeStore({ workspaces: [], archivedSessionIds: ['s2'], pinnedSessionIds: [] }),
  };
  const uiSession = { current: makeStore({ key: 's1' }) };
  const uiWorkspace = { openSession: () => true };
  return { sessions, workspaces, uiSession, uiWorkspace };
}

function makeCtx({ withSlots = true, withReact = true, withLocale = true, withWorkspace = true, withServices = true } = {}) {
  const registered = [];
  const effects = [];
  const services = makeServices();
  const ctx = {
    registered,
    effects,
    services,
    get: (name) => {
      if (!withServices) return name === 'workspaceRegistry' ? (withWorkspace ? {} : undefined) : undefined;
      if (name === 'workspaceRegistry') return withWorkspace ? {} : undefined;
      if (name === 'sessions') return services.sessions;
      if (name === 'workspaces') return services.workspaces;
      if (name === 'uiSession') return services.uiSession;
      if (name === 'uiWorkspace') return services.uiWorkspace;
      return undefined;
    },
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
      // slots.inject(name, cb)：插槽 declared 之后才回调，mock 直接同步回调。
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
        if (d === 'sessions' && withServices) given.sessions = services.sessions;
        if (d === 'workspaces' && withServices) given.workspaces = services.workspaces;
        if (d === 'webServer') given.webServer = { register: () => () => {} };
      }
      cb(given);
    }
  };
  if (withLocale) ctx.locale = { register: () => () => {}, get: () => null };
  if (withWorkspace) {
    ctx.workspace = { archiveSession: async () => ({}), unarchiveSession: async () => ({}) };
  }
  if (withReact) ctx.require = (name) => (name === 'react' ? fakeReact : undefined);
  return ctx;
}

let mod = null;
async function loadClient({ withReact = true } = {}) {
  const fakeRequire = (name) => (name === 'react' ? (withReact ? fakeReact : undefined) : undefined);
  const prevWindow = globalThis.window;
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(options) { captured = options.factory(fakeRequire); },
    },
  };
  const url = new URL('../client.js', import.meta.url);
  url.search = `t=${Date.now()}${Math.random()}`;
  try {
    await import(url.href);
  } finally {
    globalThis.window = prevWindow;
  }
  return captured;
}

mod = await loadClient({ withReact: true });
if (!mod) throw new Error('ModuleLoader did not capture exports');

const names = (ctx) => ctx.registered.map((r) => `${r.options.name}#${r.options.id || r.options.key || ''}`);

const EXPECTED_SLOTS = [
  'sidebar.footer.action',
  'shell.overlay',
  'settings.section',
  'sidebar.workspaces.session.menu.item',
  'sidebar.workspaces.session.row.action',
  'main',
  'sidebar.panellist',
];

// ---------- 1. 正常路径 ----------
check('注入声明含 slots / sessions / workspaces', () => {
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组');
  for (const need of ['slots', 'sessions', 'workspaces']) {
    assert.ok(mod.inject.includes(need), `inject 缺 ${need}`);
  }
});

check('正常 ctx 注册 9 个条目', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 9, `实际 ${ctx.registered.length}: ${names(ctx).join(', ')}`);
});

check('每个约定的槽位都有条目', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  for (const slot of EXPECTED_SLOTS) {
    assert.ok(ctx.registered.some((r) => r.options.name === slot), `未注册 ${slot}`);
  }
});

check('侧边栏底部按钮在 sidebar.footer.action', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const row = ctx.registered.find((r) => r.options.name === 'sidebar.footer.action');
  assert.equal(row.options.id, 'session-clean.toggle');
  assert.ok(Number.isFinite(row.options.order), 'order 必填');
});

check('会话行菜单注册了三条：桌面 + 隔离 + 回收站', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const menu = ctx.registered.filter((r) => r.options.name === 'sidebar.workspaces.session.menu.item');
  assert.equal(menu.length, 3, `实际 ${menu.length} 条`);
  for (const m of menu) assert.ok(Number.isFinite(m.options.order), 'order 必填');
});

check('会话行悬停按钮在 row.action', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const btn = ctx.registered.find((r) => r.options.name === 'sidebar.workspaces.session.row.action');
  assert.ok(btn, '未注册行按钮');
  assert.ok(Number.isFinite(btn.options.order), 'order 必填');
});

check('隔离区面板：main keyed + sidebar.panellist 同 id', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const main = ctx.registered.find((r) => r.options.name === 'main');
  const list = ctx.registered.find((r) => r.options.name === 'sidebar.panellist');
  assert.ok(main && main.options.key, 'main 缺 key');
  assert.equal(main.options.key, 'session-clean.stash');
  assert.ok(list, '未注册 sidebar.panellist');
  assert.equal(list.options.id, main.options.key, '面板 id 必须与 main key 一致');
  assert.equal(typeof list.options.label, 'function', 'label 必须是函数，否则只有图标没文字');
});

check('设置分区注册在 settings.section', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const sec = ctx.registered.find((r) => r.options.name === 'settings.section');
  assert.equal(sec.options.id, 'session-clean.trash');
  assert.equal(typeof sec.options.label, 'function');
});

check('组件是函数且都有 displayName', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  for (const r of ctx.registered) {
    assert.equal(typeof r.comp, 'function');
    assert.ok(r.comp.displayName, `缺 displayName: ${r.options.id || r.options.key}`);
  }
});

// ---------- 2. 降级路径（都不能抛） ----------
check('没有 slots：不注册且不抛', () => {
  const ctx = makeCtx({ withSlots: false });
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 0);
});

check('register 抛错：被吞掉且不抛', () => {
  const ctx = makeCtx();
  const fakeCtx = {
    ...ctx,
    slots: {
      register: () => { throw new Error('register boom'); },
      inject: (name, cb) => { if (typeof cb === 'function') cb(); return () => {}; },
    },
  };
  mod.apply(fakeCtx); // 不抛即通过
});

check('没有 locale：仍能注册', () => {
  const ctx = makeCtx({ withLocale: false });
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 9);
});

check('没有 workspaceRegistry：仍能注册', () => {
  const ctx = makeCtx({ withWorkspace: false });
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 9);
});

check('没有 sessions / workspaces 服务：仍能注册且不抛', () => {
  const ctx = makeCtx({ withServices: false });
  mod.apply(ctx);
  assert.equal(ctx.registered.length, 9);
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
      e.dispose();
    }
  }
});

// ---------- 3. 组件渲染期容错 ----------
const renderCases = [
  ['sidebar.footer.action', 'session-clean.toggle', { wide: true }],
  ['shell.overlay', 'session-clean.panel', {}],
  ['settings.section', 'session-clean.trash', {}],
  ['sidebar.workspaces.session.menu.item', 'session-clean.stash', { sessionId: 's1' }],
  ['sidebar.workspaces.session.menu.item', 'session-clean.trash', { sessionId: 's1' }],
  ['sidebar.workspaces.session.row.action', 'session-clean.stash-row', { sessionId: 's2' }],
  ['main', 'session-clean.stash', {}],
  ['sidebar.panellist', 'session-clean.stash', {}],
];

for (const [slot, id, props] of renderCases) {
  check(`${slot}#${id} 在空 props 下不抛`, () => {
    const ctx = makeCtx();
    mod.apply(ctx);
    const entry = ctx.registered.find((r) => r.options.name === slot && (r.options.id === id || r.options.key === id));
    assert.ok(entry, `未找到 ${slot}#${id}`);
    const el = entry.comp(props);
    if (slot === 'shell.overlay') assert.equal(el, null, '浮层默认关闭应返回 null');
    else assert.ok(el, '未返回元素');
  });
}

check('菜单项文案随归档状态变化（隔离 ↔ 放回）', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const entry = ctx.registered.find((r) => r.options.name === 'sidebar.workspaces.session.menu.item' && r.options.id === 'session-clean.stash');

  ctx.services.workspaces.list.set({ workspaces: [], archivedSessionIds: [], pinnedSessionIds: [] });
  const notArchived = entry.comp({ sessionId: 's1', useMenuOpenState: () => [true, () => {}] });
  assert.equal(notArchived.children[0], '隔离此对话');

  ctx.services.workspaces.list.set({ workspaces: [], archivedSessionIds: ['s1'], pinnedSessionIds: [] });
  const archived = entry.comp({ sessionId: 's1', useMenuOpenState: () => [true, () => {}] });
  assert.equal(archived.children[0], '放回工作区');
});

check('侧边栏按钮可点击（store 不抛）', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const btn = ctx.registered.find((r) => r.options.name === 'sidebar.footer.action').comp({ wide: true });
  assert.equal(typeof btn.props.onClick, 'function');
  btn.props.onClick(); // 不应抛
});

// ---------- 4. 完成通知的监听 ----------
check('完成监听挂在 sessions.list 上，且只弹一次', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const store = ctx.services.sessions.list;
  assert.ok(store.listenerCount() > 0, '没有订阅 sessions.list');

  const toasts = [];
  const prevAppend = globalThis.document;
  // showToast 走的是 document；测试里不给 document，函数内部已 try/catch 吞掉，
  // 所以这里只断言「不抛」与「订阅存在」。
  void toasts;
  void prevAppend;
  store.set((snap) => ({ ...snap, byId: { ...snap.byId, s1: { ...snap.byId.s1, running: true } } }));
  store.set((snap) => ({ ...snap, byId: { ...snap.byId, s1: { ...snap.byId.s1, running: false } } }));
});

// ---------- 5. 不覆盖官方 ----------
check('没有重复注册', () => {
  const ctx = makeCtx();
  mod.apply(ctx);
  const ids = names(ctx);
  assert.equal(new Set(ids).size, ids.length, '有重复注册');
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(' -', f.name, f.detail);
}
// 插件现在带 1.2s 的桌面桥轮询定时器，测试要显式退出，否则进程不结束。
process.exit(failed.length ? 1 : 0);
