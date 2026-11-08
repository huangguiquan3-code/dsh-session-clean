/**
 * 真 React 下的「渲染函数体」冒烟测试。
 *
 * 宿主没有 react-dom（自研 renderer），所以这里不渲染 DOM，而是借用 React 自己的
 * 内部 dispatcher，把每个注册组件的函数体真跑一遍并递归展开子树 —— 能真实捕获
 * hooks 顺序错误、undefined 组件、渲染期抛错。这些正是「点开面板整块白掉」的原因。
 *
 * 空 props + 有 props 两种都跑。
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
// React 从哪来：优先 DSH_REACT_DIR，其次 ./node_modules，再其次 DSH 安装目录自带的 react。
// 找不到就整体 SKIP（不算失败），保证干净环境也能跑。
function resolveReactDir() {
  const candidates = [
    process.env.DSH_REACT_DIR,
    path.join(process.cwd(), 'node_modules'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked', 'node_modules') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'node_modules') : '',
  ].filter(Boolean);
  for (const dir of candidates) {
    try { require.resolve(path.join(dir, 'react')); return dir; } catch { /* 继续找 */ }
  }
  return '';
}

const REACT_DIR = resolveReactDir();
if (!REACT_DIR) {
  console.log('SKIP  找不到 react（设置 DSH_REACT_DIR 指向含 react 的 node_modules 后可跑）');
  process.exit(0);
}
const React = require(path.join(REACT_DIR, 'react'));

const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
assert.ok(internals && internals.ReactCurrentDispatcher, '拿不到 React 内部 dispatcher');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n    ') : String(err) });
    console.log(`FAIL  ${name}\n    ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n    ') : err}`);
  }
}

function makeStore(initial) {
  const listeners = new Set();
  let value = initial;
  return {
    getSnapshot: () => value,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = typeof next === 'function' ? next(value) : next; for (const fn of [...listeners]) fn(); },
  };
}

function makeServices() {
  const sessions = {
    list: makeStore({
      ids: ['s1'],
      byId: { s1: { id: 's1', displayTitle: '测试会话', running: false, retainedBy: { mainView: 1 } } },
      phase: 'ready',
    }),
    refresh: () => Promise.resolve(),
    search: () => Promise.resolve({ ok: true, value: { hits: [] } }),
    open: () => {},
  };
  const workspaces = { list: makeStore({ workspaces: [], archivedSessionIds: [], pinnedSessionIds: [] }) };
  return { sessions, workspaces };
}

// ---- 宿主环境垫片 ----
const fetchCalls = [];
globalThis.fetch = (url) => {
  fetchCalls.push(String(url));
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }), headers: { get: () => '' } });
};
const fakeDoc = {
  body: null,
  head: null,
  hidden: false,
  hasFocus: () => true,
  createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, style: {}, addEventListener() {} }),
};
const fakeWin = { localStorage: { getItem: () => null, setItem: () => {} }, focus() {} };
const disposable = [];
globalThis.document = fakeDoc;
globalThis.window = fakeWin;

const registered = [];
const services = makeServices();
const ctx = {
  get: (name) => {
    if (name === 'sessions') return services.sessions;
    if (name === 'workspaces') return services.workspaces;
    if (name === 'uiSession') return { current: makeStore({ key: 's1' }) };
    if (name === 'uiWorkspace') return { openSession: () => true, startSession: () => true };
    if (name === 'remote') return { $on: () => () => {} };
    return undefined;
  },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposable.push(d); return () => {}; },
  slots: {
    register: (options, comp) => { registered.push({ options, comp }); return () => {}; },
    inject: (name, cb) => { if (typeof cb === 'function') cb(); return () => {}; },
  },
  inject: (deps, cb) => {
    if (typeof cb !== 'function' || !Array.isArray(deps)) return;
    const given = {};
    for (const d of deps) {
      if (d === 'locale') given.locale = { register: () => () => {}, get: () => null };
      if (d === 'sessions') given.sessions = services.sessions;
      if (d === 'workspaces') given.workspaces = services.workspaces;
    }
    cb(given);
  },
  locale: { register: () => () => {}, get: () => null },
};

// ---- 载入 client.js（真 React） ----
let mod = null;
globalThis.window = {
  localStorage: fakeWin.localStorage,
  __ModuleLoader__: { load(options) { mod = options.factory((name) => (name === 'react' ? React : undefined)); } },
};
const url = new URL('../client.js', import.meta.url);
url.search = `t=${Date.now()}${Math.random()}`;
await import(url.href);
globalThis.window = fakeWin;
if (!mod) throw new Error('ModuleLoader did not capture exports');

mod.apply(ctx);
assert.ok(registered.length >= 8, `只注册了 ${registered.length} 个条目`);

// ---- 迷你 hooks dispatcher ----
function renderFunction(Comp, props) {
  const hooks = [];
  let i = 0;
  const dispatcher = {
    useState(init) { const slot = hooks[i] || (hooks[i] = { v: typeof init === 'function' ? init() : init }); i++; return [slot.v, () => {}]; },
    useReducer(reducer, init) { const slot = hooks[i] || (hooks[i] = { v: init }); i++; return [slot.v, () => {}]; },
    useEffect() { i++; },
    useLayoutEffect() { i++; },
    useInsertionEffect() { i++; },
    useCallback(fn) { i++; return fn; },
    useMemo(fn) { i++; return fn(); },
    useRef(v) { const slot = hooks[i] || (hooks[i] = { v: { current: v } }); i++; return slot.v; },
    useSyncExternalStore(subscribe, getSnapshot) { i++; return getSnapshot(); },
    useContext() { i++; return {}; },
    useDebugValue() {},
    useId() { i++; return 'x1'; },
    useTransition() { i++; return [false, (fn) => fn()]; },
    useDeferredValue(v) { i++; return v; },
    useImperativeHandle() { i++; },
  };
  internals.ReactCurrentDispatcher.current = dispatcher;
  try {
    return Comp(props);
  } finally {
    internals.ReactCurrentDispatcher.current = null;
  }
}

/** 递归展开元素树，把函数组件都跑一遍（最多 500 个节点）。 */
function walk(node, depth, budget) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (depth > 12) throw new Error('组件树递归过深（可能是无限嵌套）');
  if (typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, depth, budget); return; }
  if (typeof node !== 'object') return;
  if (node.$$typeof && String(node.$$typeof).includes('react.element')) {
    if (budget.n-- <= 0) throw new Error('组件树节点过多（>500），疑似渲染循环');
    const type = node.type;
    if (typeof type === 'function') {
      const out = renderFunction(type, node.props || {});
      walk(out, depth + 1, budget);
      return;
    }
    if (typeof type === 'string') { walk(node.props && node.props.children, depth + 1, budget); return; }
    if (type && typeof type === 'object') throw new Error(`元素 type 是对象（${type.displayName || type.name || 'forwardRef/memo?'}），宿主可能不支持`);
    throw new Error(`元素 type 非法：${String(type)}`);
  }
  // 普通对象当作 props 容器忽略
}

const all = registered.map((r) => ({ id: r.options.id || r.options.key || r.options.name, name: r.options.name, comp: r.comp }));

function runCase(label, entry, props) {
  check(label, () => {
    walk(React.createElement(entry.comp, props || {}), 0, { n: 500 });
  });
}

for (const entry of all) {
  runCase(`渲染 ${entry.name}#${entry.id}`, entry, {});
}

// 带真实 props 的关键入口
const menu = all.find((e) => e.name === 'sidebar.workspaces.session.menu.item');
if (menu) runCase(`渲染菜单项（带 props）${menu.id}`, menu, { sessionId: 's1', displayTitle: '会话', useMenuOpenState: () => [true, () => {}] });
const rowAction = all.find((e) => e.name === 'sidebar.workspaces.session.row.action');
if (rowAction) runCase('渲染行按钮（带 props）', rowAction, { sessionId: 's1', displayTitle: '会话' });
const icon = all.find((e) => e.name === 'sidebar.panellist');
if (icon) runCase('渲染面板图标（带 props）', icon, { size: 16, active: false });

// 打开浮层后再渲染一次（这条直接对应「会话管理打不开」）
const footer = all.find((e) => e.name === 'sidebar.footer.action');
const overlay = all.find((e) => e.name === 'shell.overlay');
check('点击底部按钮 → 浮层能渲染', () => {
  const btn = renderFunction(footer.comp, { wide: true });
  assert.ok(btn, '底部按钮返回空');
  // 调 onClick 打开 store（模块级 store 会 emit，但这里没订阅者）
  const onClick = btn.props && btn.props.onClick;
  assert.equal(typeof onClick, 'function', '底部按钮没有 onClick');
  onClick();
  walk(React.createElement(overlay.comp, {}), 0, { n: 800 });
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
