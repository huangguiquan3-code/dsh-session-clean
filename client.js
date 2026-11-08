/**
 * dsh-session-clean —— 客户端界面
 *
 * 三个入口，全部走官方插槽，不改、不覆盖任何官方组件：
 *   1. sidebar.footer.action  —— 侧边栏底部「会话管理」按钮（批量删除 / 批量导出）
 *   2. shell.overlay          —— 该按钮打开的面板（浮层）
 *   3. settings.section       —— 设置页的回收站管理
 *
 * 每次注册都用 ctx.slots.inject(槽位名, () => ctx.slots.register(...))：
 * 子槽位是运行时 declared 的，apply() 执行时它还不存在；直接 register 会抛
 *   "slot ... is not declared (a parent entry's children table must declare it)"
 *
 * 【模块格式】DSH 客户端插件不是裸 ESM，必须包在
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 * 里，用 exports.xxx 导出。直接写 `export function apply` 会抛
 *   Uncaught SyntaxError: Unexpected token 'export'
 *
 * 崩溃防护（硬约束）：
 *   - 组件内部全部 try/catch，渲染期异常只影响本条目，不冒泡到宿主；
 *   - 插槽注册包在 ctx.effect 里，插件卸载时自动注销；
 *   - 拿不到 slots / react 直接不注册，不抛；
 *   - 不裸访问 ctx.locale / ctx.workspace / ctx.remote（cordis 严格注入）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-clean',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    try {
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    } catch { /* 老引擎忽略 */ }

    var NS = 'session-clean';

    // 每次改客户端代码都改这一行：宿主 /session-clean/probe 会回显页面报到的 build，
    // 用它一眼判断「页面里跑的到底是不是最新代码」。
    var BUILD = 'client-2026-11-07-theme-motion-v3';

    // 在 factory 执行时判定一次：模块能在浏览器里被加载，就说明这是浏览器侧。
    // 之后 apply() 里不再重复判断 window —— 测试与 SSR 都不需要为它分支。
    var inBrowser = typeof window !== 'undefined';

    var zh = {
      'menu.delete': '删除会话…',
      'menu.deleteHint': '移入回收站，可还原',
      'dialog.title': '删除这个会话？',
      'dialog.body': '会话将被移入回收站，不会立即消失，可以从设置里还原。',
      'dialog.confirm': '移入回收站',
      'dialog.cancel': '取消',
      'toast.moved': '已移入回收站',
      'toast.failed': '删除失败：',
      'settings.title': '会话回收站',
      'settings.desc': '删除的会话暂存在这里，可随时还原。',
      'settings.empty': '回收站是空的',
      'settings.restore': '还原',
      'settings.purge': '彻底删除',
      'settings.purgeAll': '清空回收站',
      'settings.refresh': '刷新',
      'settings.noHost': '需要在桌面端或 Web 端运行',
      'panel.title': '会话管理',
      'panel.open': '会话：快速切换 / 批量删除 / 导出（Alt+K）',
      'panel.close': '关闭',
      'panel.tab.sessions': '会话',
      'panel.tab.trash': '回收站',
      'panel.search': '输入标题 / 目录 / 会话 ID，↑↓ 选择，Enter 打开',
      'panel.selectAll': '全选',
      'panel.clear': '取消选择',
      'panel.selected': '已选 {n} 个',
      'panel.delete': '删除选中',
      'panel.deleteArm': '确认删除 {n} 个？',
      'panel.exportDisk': '导出到磁盘',
      'panel.exportZip': '下载 ZIP',
      'panel.format': '格式',
      'panel.loading': '加载中…',
      'panel.empty': '没有会话',
      'panel.none': '未选择任何会话',
      'panel.deleted': '已删除 {n} 个，进回收站',
      'panel.deletedPartial': '删除 {ok} 个，失败 {bad} 个',
      'panel.exported': '已导出到 {dir}',
      'panel.exportFailed': '导出失败：',
      'panel.more': '仅显示前 {n} 条，用搜索缩小范围',
      'panel.total': '共 {n} 个会话',
      'panel.matched': '匹配 {n} / 共 {total}',
      'panel.noMatch': '没有匹配的会话',
      'panel.openChat': '打开',
      'panel.hint': '点一行就打开这个对话；↑↓ 选择、Enter 打开、Esc 关闭',
      'panel.skipped': '跳过 {n} 个读不出的会话',
      'row.archived': '已归档',
      'row.incomplete': '配对不全',
      'row.orphan': '未分组',
      'row.stashed': '隔离中',

      // ---- 会话行 / 右键菜单 ----
      'menu.stash': '隔离此对话',
      'menu.unstash': '放回工作区',
      'menu.trash': '移入回收站…',
      'row.stash': '隔离此对话',
      'row.unstash': '放回工作区',

      // ---- 隔离区面板 ----
      'stash.title': '会话隔离区',
      'stash.panel': '隔离区',
      'stash.desc': '把正在用的对话抽到这里：侧边栏立刻清空，结束后一键放回原位置。',
      'stash.current': '隔离当前对话',
      'stash.empty': '隔离区是空的',
      'stash.restore': '放回',
      'stash.open': '打开',
      'stash.refresh': '刷新',
      'stash.loading': '加载中…',
      'stash.noSession': '当前没有打开的会话',
      'stash.moved': '已隔离：{title}',
      'stash.returned': '已放回：{title}',
      'stash.failed': '操作失败：',
      'stash.active': '这个对话还有任务在跑。要先停止再隔离吗？',
      'stash.stopAndStash': '停止并隔离',
      'stash.cancel': '取消',
      'stash.archivedOnly': '官方归档',
      'stash.onDisk': '文件完整',
      'stash.missing': '文件缺失',
      'stash.total': '共 {n} 个',

      // ---- 桌面（钉住的会话） ----
      'desk.title': '桌面',
      'desk.empty': '把常用对话钉到桌面上',
      'desk.add': '放到桌面',
      'desk.remove': '从桌面收回',
      'desk.collapse': '收起桌面',
      'desk.expand': '展开桌面',
      'desk.toolbox': '打开会话跳板',
      'desk.full': '桌面最多放 12 个，先收回一个',
      'desk.batch': '放到桌面（{n}）',
      'desk.batchDone': '已放到桌面 {n} 个',
      'desk.drag': '拖动移动位置；双击回到默认位置',
      'desk.z.front': '当前：置顶（盖在内容上）— 点击改为置底',
      'desk.z.back': '当前：置底（在内容下面）— 点击改为置顶',
      'desk.z.frontShort': '↑',
      'desk.z.backShort': '↓',

      // ---- 任务完成通知 ----
      'notify.title': '任务完成通知',
      'notify.desc': '回合结束时弹一条通知；窗口在后台时走系统通知，点击直接打开那个对话。',
      'notify.on': '已开启',
      'notify.off': '已关闭',
      'notify.enable': '开启通知',
      'notify.disable': '关闭通知',
      'notify.perm': '申请系统通知权限',
      'notify.granted': '系统通知权限已就绪',
      'notify.denied': '浏览器拒绝了系统通知权限，面板内提示仍然可用',
      'notify.unsupported': '这个环境不支持系统通知，面板内提示仍然可用',
      'notify.test': '发一条测试通知',
      'notify.doneTitle': '任务完成',
      'notify.doneBody': '「{title}」这一轮已经跑完。',
      'notify.doneBodyPlain': '有一个对话已经跑完。',
      'notify.click': '点击打开',

      // ---- 历史遗留修复 ----
      'repair.title': '修复：看不见的会话',
      'repair.desc': '文件还在、却被归档集合挡住的行（旧版本还原只搬文件、没摘归档留下的）。检查后可以一键放回列表。',
      'repair.check': '检查',
      'repair.all': '全部放回（{n}）',
      'repair.one': '放回',
      'repair.empty': '没有发现这样的会话',
      'repair.done': '已放回 {n} 个',
      'repair.failed': '放回失败：',
    };

    var en = {
      'menu.delete': 'Delete session…',
      'menu.deleteHint': 'Move to trash, can be restored',
      'dialog.title': 'Delete this session?',
      'dialog.body': 'The session moves to the trash. You can restore it later from Settings.',
      'dialog.confirm': 'Move to trash',
      'dialog.cancel': 'Cancel',
      'toast.moved': 'Moved to trash',
      'toast.failed': 'Delete failed: ',
      'settings.title': 'Session trash',
      'settings.desc': 'Deleted sessions wait here and can be restored.',
      'settings.empty': 'Trash is empty',
      'settings.restore': 'Restore',
      'settings.purge': 'Delete permanently',
      'settings.purgeAll': 'Empty trash',
      'settings.refresh': 'Refresh',
      'settings.noHost': 'Requires the desktop or web host',
      'panel.title': 'Sessions',
      'panel.open': 'Sessions: bulk delete / export',
      'panel.close': 'Close',
      'panel.tab.sessions': 'Sessions',
      'panel.tab.trash': 'Trash',
      'panel.search': 'Search title, ID or folder',
      'panel.selectAll': 'Select all',
      'panel.clear': 'Clear',
      'panel.selected': '{n} selected',
      'panel.delete': 'Delete selected',
      'panel.deleteArm': 'Confirm deleting {n}?',
      'panel.exportDisk': 'Export to disk',
      'panel.exportZip': 'Download ZIP',
      'panel.format': 'Format',
      'panel.loading': 'Loading…',
      'panel.empty': 'No sessions',
      'panel.none': 'Nothing selected',
      'panel.deleted': 'Deleted {n} (moved to trash)',
      'panel.deletedPartial': '{ok} deleted, {bad} failed',
      'panel.exported': 'Exported to {dir}',
      'panel.exportFailed': 'Export failed: ',
      'panel.more': 'Showing first {n}; narrow the search',
      'panel.total': '{n} sessions',
      'panel.matched': '{n} of {total}',
      'panel.noMatch': 'No matching chat',
      'panel.openChat': 'Open',
      'panel.hint': 'Click a row to open it; ↑↓ to move, Enter to open, Esc to close',
      'panel.skipped': '{n} unreadable sessions skipped',
      'row.archived': 'archived',
      'row.incomplete': 'incomplete',
      'row.orphan': 'ungrouped',
      'row.stashed': 'stashed',

      'menu.stash': 'Isolate this chat',
      'menu.unstash': 'Put it back',
      'menu.trash': 'Move to trash…',
      'row.stash': 'Isolate this chat',
      'row.unstash': 'Put it back',

      'stash.title': 'Isolated chats',
      'stash.panel': 'Isolated',
      'stash.desc': 'Move the chat you are using here: the sidebar clears, and one click puts it back.',
      'stash.current': 'Isolate the open chat',
      'stash.empty': 'Nothing isolated',
      'stash.restore': 'Put back',
      'stash.open': 'Open',
      'stash.refresh': 'Refresh',
      'stash.loading': 'Loading…',
      'stash.noSession': 'No chat is open',
      'stash.moved': 'Isolated: {title}',
      'stash.returned': 'Put back: {title}',
      'stash.failed': 'Failed: ',
      'stash.active': 'This chat still has work running. Stop it and isolate?',
      'stash.stopAndStash': 'Stop and isolate',
      'stash.cancel': 'Cancel',
      'stash.archivedOnly': 'archived',
      'stash.onDisk': 'files ok',
      'stash.missing': 'files missing',
      'stash.total': '{n} total',

      'desk.title': 'Desk',
      'desk.empty': 'Pin a chat to the desk',
      'desk.add': 'Pin to desk',
      'desk.remove': 'Remove from desk',
      'desk.collapse': 'Collapse desk',
      'desk.expand': 'Expand desk',
      'desk.toolbox': 'Open the chat switcher',
      'desk.full': 'The desk holds 12; remove one first',
      'desk.batch': 'Pin to desk ({n})',
      'desk.batchDone': 'Pinned {n} to the desk',
      'desk.drag': 'Drag to move; double-click to reset',
      'desk.z.front': 'On top of content — click to send behind',
      'desk.z.back': 'Behind content — click to bring on top',
      'desk.z.frontShort': '↑',
      'desk.z.backShort': '↓',

      'notify.title': 'Turn notifications',
      'notify.desc': 'Notify when a turn finishes; with the window in the background it uses a system notification that opens the chat.',
      'notify.on': 'On',
      'notify.off': 'Off',
      'notify.enable': 'Enable notifications',
      'notify.disable': 'Disable notifications',
      'notify.perm': 'Allow system notifications',
      'notify.granted': 'System notifications are ready',
      'notify.denied': 'The browser denied system notifications; in-app toasts still work',
      'notify.unsupported': 'System notifications are unavailable here; in-app toasts still work',
      'notify.test': 'Send a test notification',
      'notify.doneTitle': 'Turn completed',
      'notify.doneBody': '"{title}" just finished a turn.',
      'notify.doneBodyPlain': 'A chat just finished a turn.',
      'notify.click': 'Click to open',

      'repair.title': 'Fix hidden chats',
      'repair.desc': 'Chats whose files still exist but are blocked by the archive set (left behind by an older restore). Check, then put them back in one click.',
      'repair.check': 'Check',
      'repair.all': 'Put all back ({n})',
      'repair.one': 'Put back',
      'repair.empty': 'Nothing to fix',
      'repair.done': 'Put back {n}',
      'repair.failed': 'Failed: ',
    };

    // 只声明真正必需的：没有 slots 就没有界面；sessions / workspaces 用来读会话与归档状态
    // （完成通知、行菜单的「隔离 / 放回」文案）。其余（uiSession / uiWorkspace / layout）
    // 都是软依赖，靠 service() 机会式获取，拿不到就降级。
    var inject = ['slots', 'sessions', 'workspaces'];

    // ---------------------------------------------------------------- 主题
    // 三套预设 × 明暗，全部走同一批 CSS 变量；同一份结果也会推给宿主/外部浮窗，
    // 避免浏览器端和原生端各自硬编码两套风格。
    var THEME_KEY = 'session-clean.theme';

    var THEMES = {
      fog: {
        label: '雾蓝灰紫',
        dark: {
          bg: '#171B24', surface: '#202633', surface2: '#1B212B', hover: '#293244', active: '#2C3A52',
          border: 'rgba(154,168,196,.18)', 'border-strong': 'rgba(154,168,196,.34)',
          text: '#E7EBF3', dim: '#AAB5C8', acc: '#9BAEE8', acc2: '#B5A6D8',
          glow: 'rgba(155,174,232,.32)', focus: 'rgba(169,192,255,.5)',
          ok: '#7FC8A9', warn: '#E3B778', err: '#E08C8C',
          shadow: '0 22px 54px rgba(6,9,15,.5)',
        },
        light: {
          bg: '#F4F6FB', surface: '#FFFFFF', surface2: '#EEF1F8', hover: '#E9EDF7', active: '#E2E9FA',
          border: 'rgba(60,74,100,.14)', 'border-strong': 'rgba(60,74,100,.28)',
          text: '#1D2431', dim: '#5B6678', acc: '#5D74B8', acc2: '#7C6BA8',
          glow: 'rgba(93,116,184,.22)', focus: 'rgba(93,116,184,.45)',
          ok: '#2E8B62', warn: '#A9761F', err: '#B3453F',
          shadow: '0 18px 44px rgba(28,38,58,.14)',
        },
      },
      mint: {
        label: '青灰薄荷',
        dark: {
          bg: '#16201F', surface: '#1D2A28', surface2: '#192421', hover: '#263633', active: '#27423C',
          border: 'rgba(150,190,180,.18)', 'border-strong': 'rgba(150,190,180,.34)',
          text: '#E6F0ED', dim: '#A7BAB4', acc: '#8CC9B8', acc2: '#A9C3D6',
          glow: 'rgba(140,201,184,.30)', focus: 'rgba(140,201,184,.5)',
          ok: '#7FC8A9', warn: '#E0B87A', err: '#DD8E8E',
          shadow: '0 22px 54px rgba(5,12,10,.5)',
        },
        light: {
          bg: '#F2F8F6', surface: '#FFFFFF', surface2: '#EAF3F0', hover: '#E2EFEA', active: '#D8EDE6',
          border: 'rgba(40,80,70,.14)', 'border-strong': 'rgba(40,80,70,.28)',
          text: '#17251F', dim: '#50685F', acc: '#3E8C77', acc2: '#5B7E96',
          glow: 'rgba(62,140,119,.20)', focus: 'rgba(62,140,119,.42)',
          ok: '#2E8B62', warn: '#9C7318', err: '#AE4A45',
          shadow: '0 18px 44px rgba(24,48,42,.14)',
        },
      },
      rose: {
        label: '暖灰玫瑰',
        dark: {
          bg: '#1E181C', surface: '#291F24', surface2: '#231A1F', hover: '#35272E', active: '#3E2A33',
          border: 'rgba(200,170,185,.18)', 'border-strong': 'rgba(200,170,185,.34)',
          text: '#F2E9ED', dim: '#C2AFB8', acc: '#D9A6B8', acc2: '#C3A9D0',
          glow: 'rgba(217,166,184,.30)', focus: 'rgba(217,166,184,.5)',
          ok: '#86C7A6', warn: '#E0B27C', err: '#DE8A92',
          shadow: '0 22px 54px rgba(14,8,12,.5)',
        },
        light: {
          bg: '#FAF4F6', surface: '#FFFFFF', surface2: '#F4ECEF', hover: '#F0E5EA', active: '#EDDFE7',
          border: 'rgba(90,60,72,.14)', 'border-strong': 'rgba(90,60,72,.28)',
          text: '#2B2126', dim: '#6D5A63', acc: '#A85F79', acc2: '#8467A0',
          glow: 'rgba(168,95,121,.20)', focus: 'rgba(168,95,121,.42)',
          ok: '#3E8C6A', warn: '#A2711F', err: '#B04A52',
          shadow: '0 18px 44px rgba(58,38,46,.14)',
        },
      },
    };

    var themeListeners = new Set();

    function readThemePrefs() {
      var d = { preset: 'fog', mode: 'dark', motion: 'soft', density: 'comfortable', windowTitle: 'DSH 当前对话' };
      try {
        var raw = window.localStorage.getItem(THEME_KEY);
        var v = raw ? JSON.parse(raw) : null;
        if (v && typeof v === 'object') {
          if (THEMES[v.preset]) d.preset = v.preset;
          if (v.mode === 'light' || v.mode === 'dark') d.mode = v.mode;
          if (['auto', 'full', 'soft', 'off'].indexOf(v.motion) >= 0) d.motion = v.motion;
          if (v.density === 'compact' || v.density === 'comfortable') d.density = v.density;
          if (typeof v.windowTitle === 'string' && v.windowTitle.trim()) d.windowTitle = v.windowTitle.trim().slice(0, 24);
        }
      } catch { /* 隐私模式 / 首次 */ }
      return d;
    }

    var themePrefs = readThemePrefs();

    function systemReduced() {
      try {
        return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch {
        return false;
      }
    }

    function effectiveMotion() {
      if (themePrefs.motion === 'auto') return systemReduced() ? 'off' : 'soft';
      return themePrefs.motion;
    }

    function themePalette() {
      var t = THEMES[themePrefs.preset] || THEMES.fog;
      return t[themePrefs.mode] || t.dark;
    }

    function applyThemePrefs(broadcast) {
      var pal = themePalette();
      try {
        var root = document.documentElement;
        for (var k in pal) {
          if (Object.prototype.hasOwnProperty.call(pal, k)) root.style.setProperty('--sc-' + k, pal[k]);
        }
        root.setAttribute('data-sc-motion', effectiveMotion());
        root.setAttribute('data-sc-density', themePrefs.density);
        root.setAttribute('data-sc-mode', themePrefs.mode);
      } catch { /* 无 DOM */ }
      themeListeners.forEach(function (fn) { try { fn(); } catch { /* ignore */ } });
      if (broadcast === false) return;
      try {
        fetch('/session-clean/theme', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            theme: {
              preset: themePrefs.preset,
              mode: themePrefs.mode,
              motion: themePrefs.motion,
              density: themePrefs.density,
              label: (THEMES[themePrefs.preset] || {}).label || '',
              windowTitle: themePrefs.windowTitle || 'DSH 当前对话',
              palette: pal,
              updatedAt: Date.now(),
            },
          }),
        }).catch(function () { /* 忽略 */ });
      } catch { /* 忽略 */ }
    }

    function setThemePrefs(patch) {
      themePrefs = Object.assign({}, themePrefs, patch || {});
      try { window.localStorage.setItem(THEME_KEY, JSON.stringify(themePrefs)); } catch { /* ignore */ }
      applyThemePrefs(true);
    }

    var CSS = [
      /* ===== 主题 token（JS 会按预设/明暗覆盖这些值） ===== */
      ':root{--sc-bg:#171B24;--sc-surface:#202633;--sc-surface2:#1B212B;--sc-hover:#293244;--sc-active:#2C3A52;',
      '--sc-border:rgba(154,168,196,.18);--sc-border-strong:rgba(154,168,196,.34);',
      '--sc-text:#E7EBF3;--sc-dim:#AAB5C8;--sc-acc:#9BAEE8;--sc-acc2:#B5A6D8;',
      '--sc-glow:rgba(155,174,232,.32);--sc-focus:rgba(169,192,255,.5);',
      '--sc-ok:#7FC8A9;--sc-warn:#E3B778;--sc-err:#E08C8C;',
      '--sc-shadow:0 22px 54px rgba(6,9,15,.5);',
      '--sc-r-lg:14px;--sc-r-md:10px;--sc-r-sm:8px;--sc-r-xs:6px;',
      '--sc-dur:190ms;--sc-dur-fast:120ms;--sc-ease:cubic-bezier(.22,.61,.36,1);}',

      /* ===== 浮层与卡片 ===== */
      '.sc-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(7,10,16,.58);backdrop-filter:blur(3px);animation:sc-fade var(--sc-dur) var(--sc-ease);}',
      '.sc-card{width:min(920px,94vw);max-height:84vh;display:flex;flex-direction:column;border-radius:var(--sc-r-lg);overflow:hidden;background:var(--sc-surface);color:var(--sc-text);border:1px solid var(--sc-border);box-shadow:var(--sc-shadow);animation:sc-pop 200ms var(--sc-ease);}',
      '.sc-card-wide{width:min(1080px,96vw);height:min(82vh,780px);}',
      '.sc-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--sc-border);}',
      '.sc-head h3{margin:0;font-size:15px;font-weight:600;letter-spacing:.2px;flex:1;}',
      '.sc-tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--sc-border);}',
      '.sc-list{flex:1;overflow:auto;padding:8px 12px 12px;}',
      '.sc-list::-webkit-scrollbar{width:8px;height:8px;}',
      '.sc-list::-webkit-scrollbar-thumb{background:var(--sc-border-strong);border-radius:8px;}',
      '.sc-list::-webkit-scrollbar-track{background:transparent;}',
      '.sc-foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--sc-border);}',
      '.sc-spacer{flex:1;}',
      '.sc-note{font-size:11.5px;color:var(--sc-dim);padding:0 16px 10px;word-break:break-all;}',
      '.sc-tabs{display:flex;gap:6px;}',
      '.sc-empty{font-size:12px;color:var(--sc-dim);padding:16px 4px;}',
      '.sc-kbd{font-size:11px;color:var(--sc-dim);opacity:.8;white-space:nowrap;}',
      '.sc-name{display:inline-flex;align-items:center;gap:6px;flex:none;}',
      '.sc-name span{font-size:11px;color:var(--sc-dim);white-space:nowrap;}',
      '.sc-name input{width:140px;padding:4px 8px;border-radius:var(--sc-r-sm);border:1px solid var(--sc-border);background:var(--sc-surface2);color:var(--sc-text);font-size:12px;outline:none;transition:border-color var(--sc-dur) var(--sc-ease);}',
      '.sc-name input:focus{border-color:var(--sc-focus);}',

      /* ===== 按钮 ===== */
      '.sc-btn{padding:6px 11px;border-radius:var(--sc-r-sm);font-size:12.5px;cursor:pointer;border:1px solid var(--sc-border);background:var(--sc-surface2);color:var(--sc-text);white-space:nowrap;transition:background var(--sc-dur) var(--sc-ease),border-color var(--sc-dur) var(--sc-ease),transform var(--sc-dur-fast) var(--sc-ease),color var(--sc-dur) var(--sc-ease);}',
      '.sc-btn:hover:not(:disabled){background:var(--sc-hover);border-color:var(--sc-border-strong);}',
      '.sc-btn:active:not(:disabled){transform:scale(.98);}',
      '.sc-btn:disabled{opacity:.45;cursor:default;}',
      '.sc-btn.primary{background:color-mix(in srgb,var(--sc-acc) 20%,transparent);border-color:color-mix(in srgb,var(--sc-acc) 55%,transparent);}',
      '.sc-btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--sc-acc) 30%,transparent);}',
      '.sc-btn.danger{background:color-mix(in srgb,var(--sc-err) 18%,transparent);border-color:color-mix(in srgb,var(--sc-err) 52%,transparent);}',
      '.sc-btn-sm{padding:3px 9px;font-size:11.5px;}',
      '.sc-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--sc-r-xs);background:transparent;color:var(--sc-dim);cursor:pointer;transition:background var(--sc-dur) var(--sc-ease),color var(--sc-dur) var(--sc-ease);}',
      '.sc-icon-btn:hover:not(:disabled){background:var(--sc-hover);color:var(--sc-text);}',
      '.sc-icon-btn:disabled{opacity:.35;cursor:default;}',

      /* ===== 会话行 ===== */
      '.sc-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--sc-r-md);border:1px solid transparent;margin-bottom:6px;cursor:pointer;transition:background var(--sc-dur) var(--sc-ease),border-color var(--sc-dur) var(--sc-ease),box-shadow var(--sc-dur) var(--sc-ease);}',
      '.sc-row:hover{background:var(--sc-hover);border-color:var(--sc-border);}',
      '.sc-row.active{background:var(--sc-active);border-color:var(--sc-border-strong);box-shadow:inset 2px 0 0 var(--sc-acc);}',
      '.sc-row-main{flex:1;min-width:0;}',
      '.sc-row-title{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--sc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sc-meta{font-size:11px;color:var(--sc-dim);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sc-tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--sc-border-strong);color:var(--sc-dim);}',
      '.sc-row-actions{display:flex;gap:6px;flex:none;opacity:.5;transition:opacity var(--sc-dur) var(--sc-ease);}',
      '.sc-row:hover .sc-row-actions,.sc-row.active .sc-row-actions{opacity:1;}',
      '.sc-status-dot{width:7px;height:7px;border-radius:50%;background:var(--sc-border-strong);flex:none;transition:background var(--sc-dur) var(--sc-ease);}',
      '.sc-status-dot.running{background:var(--sc-acc);animation:sc-breathe 2600ms var(--sc-ease) infinite;}',
      '.sc-status-text{font-size:10.5px;color:var(--sc-dim);}',
      '.sc-status-text.running{color:var(--sc-acc);}',

      /* ===== 搜索框：多层流光（角度由 JS 平滑驱动，无跳变） ===== */
      '.sc-search{position:relative;flex:1 1 100%;min-width:280px;height:52px;display:flex;align-items:center;isolation:isolate;--sc-a1:0deg;--sc-a2:0deg;--sc-a3:0deg;--sc-a4:0deg;}',
      '.sc-search-glow,.sc-search-white,.sc-search-border,.sc-search-dark{position:absolute;inset:0;border-radius:13px;overflow:hidden;pointer-events:none;}',
      '.sc-search-dark{inset:-1px;}',
      '.sc-search-white{inset:1px;border-radius:12px;}',
      '.sc-search-border{inset:2px;border-radius:11px;}',
      '.sc-search-glow{inset:-10px;filter:blur(16px);opacity:.16;transition:opacity var(--sc-dur) var(--sc-ease);}',
      '.sc-search:hover .sc-search-glow{opacity:.24;}',
      '.sc-search:focus-within .sc-search-glow{opacity:.34;}',
      '.sc-search-glow::before,.sc-search-white::before,.sc-search-border::before,.sc-search-dark::before{content:"";position:absolute;left:50%;top:50%;width:1500px;height:1500px;background-repeat:no-repeat;background-position:0 0;will-change:transform;}',
      '.sc-search-dark::before{background-image:conic-gradient(from 0deg,transparent 6%,var(--sc-border-strong) 22%,transparent 40%,transparent 58%,var(--sc-border-strong) 76%,transparent 94%);filter:blur(2px);transform:translate(-50%,-50%) rotate(var(--sc-a1));}',
      '.sc-search-white::before{background-image:conic-gradient(from 0deg,transparent 4%,var(--sc-acc) 16%,transparent 30%,transparent 54%,var(--sc-acc2) 66%,transparent 80%);filter:blur(.6px);opacity:.9;transform:translate(-50%,-50%) rotate(var(--sc-a3));}',
      '.sc-search-border::before{background-image:conic-gradient(from 0deg,transparent 2%,var(--sc-acc) 14%,transparent 28%,transparent 52%,var(--sc-acc2) 64%,transparent 78%);transform:translate(-50%,-50%) rotate(var(--sc-a4));}',
      '.sc-search-glow::before{background-image:conic-gradient(from 0deg,transparent 0%,var(--sc-glow) 18%,transparent 36%,transparent 50%,var(--sc-glow) 68%,transparent 86%);transform:translate(-50%,-50%) rotate(var(--sc-a2));}',
      '.sc-search-main{position:relative;z-index:2;display:flex;align-items:center;width:100%;height:100%;border-radius:11px;background:var(--sc-surface2);padding:0 14px 0 44px;box-shadow:inset 0 0 0 1px var(--sc-border);transition:box-shadow var(--sc-dur) var(--sc-ease);}',
      '.sc-search:focus-within .sc-search-main{box-shadow:inset 0 0 0 1px var(--sc-focus);}',
      '.sc-search-main input{flex:1;min-width:0;height:100%;background:transparent;border:0;outline:0;color:var(--sc-text);font-size:13.5px;caret-color:var(--sc-acc);}',
      '.sc-search-main input::placeholder{color:var(--sc-dim);opacity:.75;}',
      '.sc-search-main input::-webkit-search-cancel-button{filter:grayscale(1) opacity(.6);cursor:pointer;}',
      '.sc-search-ico-left{position:absolute;left:16px;top:50%;transform:translateY(-50%);display:flex;color:var(--sc-dim);z-index:4;pointer-events:none;transition:color var(--sc-dur) var(--sc-ease);}',
      '.sc-search:focus-within .sc-search-ico-left{color:var(--sc-acc);}',

      /* ===== 复选（描边 + 勾，两段绘制；可访问隐藏原生框） ===== */
      '.sc-check{position:relative;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;flex:none;cursor:pointer;border-radius:var(--sc-r-sm);}',
      '.sc-check input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;}',
      '.sc-check-svg{width:18px;height:18px;overflow:visible;pointer-events:none;}',
      '.sc-check-base{fill:none;stroke:var(--sc-border-strong);stroke-width:10;transition:stroke 180ms var(--sc-ease),stroke-width 180ms var(--sc-ease);}',
      '.sc-check:hover .sc-check-base{stroke:var(--sc-acc);}',
      '.sc-check input:focus-visible ~ .sc-check-svg .sc-check-base{stroke:var(--sc-focus);stroke-width:14;}',
      '.sc-check input:checked ~ .sc-check-svg .sc-check-base,.sc-check input:indeterminate ~ .sc-check-svg .sc-check-base{stroke:color-mix(in srgb,var(--sc-acc) 50%,transparent);}',
      '.sc-check-box{fill:none;stroke:var(--sc-acc);stroke-width:12;stroke-linecap:round;stroke-dasharray:620;stroke-dashoffset:620;transition:stroke-dashoffset 220ms var(--sc-ease);}',
      '.sc-check input:checked ~ .sc-check-svg .sc-check-box,.sc-check input:indeterminate ~ .sc-check-svg .sc-check-box{stroke-dashoffset:0;}',
      '.sc-check-tick{fill:none;stroke:var(--sc-acc);stroke-width:20;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:150;stroke-dashoffset:150;transition:stroke-dashoffset 200ms var(--sc-ease) 160ms;}',
      '.sc-check input:checked ~ .sc-check-svg .sc-check-tick{stroke-dashoffset:0;}',
      '.sc-check input:indeterminate ~ .sc-check-svg .sc-check-tick{stroke-dashoffset:150;}',
      '.sc-check-dash{fill:none;stroke:var(--sc-acc);stroke-width:20;stroke-linecap:round;stroke-dasharray:96;stroke-dashoffset:96;transition:stroke-dashoffset 180ms var(--sc-ease) 120ms;}',
      '.sc-check input:indeterminate ~ .sc-check-svg .sc-check-dash{stroke-dashoffset:0;}',
      '.sc-check input:not(:checked):not(:indeterminate) ~ .sc-check-svg .sc-check-tick,.sc-check input:not(:checked):not(:indeterminate) ~ .sc-check-svg .sc-check-dash{transition-delay:0s;}',
      '.sc-check input:not(:checked):not(:indeterminate) ~ .sc-check-svg .sc-check-box{transition-delay:80ms;}',
      '.sc-check input:disabled{cursor:default;}',
      '.sc-check input:disabled ~ .sc-check-svg{opacity:.45;}',

      /* ===== 应用内桌面浮条 ===== */
      '.sc-dock{position:fixed;left:12px;bottom:96px;z-index:2147482000;pointer-events:auto;display:flex;flex-direction:column;gap:4px;width:248px;max-height:min(60vh,520px);padding:8px;border-radius:var(--sc-r-lg);background:var(--sc-surface);border:1px solid var(--sc-border);box-shadow:var(--sc-shadow);font-size:12.5px;color:var(--sc-text);}',
      '.sc-dock-head{display:flex;align-items:center;gap:4px;padding:2px 4px 6px;cursor:move;user-select:none;border-bottom:1px solid var(--sc-border);margin-bottom:4px;}',
      '.sc-dock-head b{flex:1;font-size:12px;font-weight:600;color:var(--sc-text);}',
      '.sc-dock-body{display:flex;flex-direction:column;gap:2px;overflow:auto;min-height:0;}',
      '.sc-dock-body::-webkit-scrollbar{width:6px;}',
      '.sc-dock-body::-webkit-scrollbar-thumb{background:var(--sc-border-strong);border-radius:6px;}',
      '.sc-desk-item{display:flex;align-items:center;gap:2px;border-radius:var(--sc-r-sm);transition:background var(--sc-dur) var(--sc-ease);}',
      '.sc-desk-item:hover{background:var(--sc-hover);}',
      '.sc-desk-item.active{background:var(--sc-active);box-shadow:inset 2px 0 0 var(--sc-acc);}',
      '.sc-desk-open{flex:1;min-width:0;display:flex;align-items:center;gap:6px;padding:5px 7px;border:0;border-radius:var(--sc-r-sm);background:transparent;color:inherit;font-size:12.5px;text-align:left;cursor:pointer;}',
      '.sc-desk-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--sc-text);}',
      '.sc-desk-dot{width:6px;height:6px;border-radius:50%;background:var(--sc-border-strong);flex:none;}',
      '.sc-desk-item.running .sc-desk-dot{background:var(--sc-acc);animation:sc-breathe 2600ms var(--sc-ease) infinite;}',
      '.sc-desk-x{border:0;background:transparent;color:var(--sc-dim);cursor:pointer;font-size:14px;line-height:1;padding:2px 6px;border-radius:var(--sc-r-xs);opacity:.55;transition:opacity var(--sc-dur),background var(--sc-dur),color var(--sc-dur);}',
      '.sc-desk-x:hover{opacity:1;color:var(--sc-err);background:color-mix(in srgb,var(--sc-err) 16%,transparent);}',
      '.sc-dock.mini{width:auto;padding:5px;}',
      '.sc-dock-mini-btn{display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:var(--sc-r-sm);border:1px solid var(--sc-border);background:var(--sc-surface2);color:var(--sc-text);font-size:12px;cursor:pointer;transition:background var(--sc-dur),border-color var(--sc-dur);}',
      '.sc-dock-mini-btn:hover{background:var(--sc-hover);border-color:var(--sc-border-strong);}',

      /* ===== 隔离区整屏 ===== */
      '.sc-panel{height:100%;min-height:0;overflow:auto;box-sizing:border-box;padding:calc(var(--dsh-frame-top-clearance, 16px)) 22px 28px;color:var(--sc-text);}',
      '.sc-panel-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:6px;}',
      '.sc-panel-head h2{margin:0;font-size:16px;font-weight:600;flex:none;}',
      '.sc-panel-desc{font-size:12px;color:var(--sc-dim);margin:0 0 14px;line-height:1.6;max-width:720px;}',
      '.sc-panel-list{display:flex;flex-direction:column;gap:8px;max-width:820px;}',
      '.sc-stash-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--sc-r-md);border:1px solid var(--sc-border);transition:background var(--sc-dur),border-color var(--sc-dur);}',
      '.sc-stash-row:hover{background:var(--sc-hover);border-color:var(--sc-border-strong);}',
      '.sc-stash-main{flex:1;min-width:0;}',
      '.sc-stash-title{font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sc-hint{font-size:12px;color:var(--sc-dim);margin-top:8px;}',

      /* ===== Toast ===== */
      '.sc-toast-wrap{position:fixed;right:16px;bottom:16px;z-index:2147483001;display:flex;flex-direction:column;gap:8px;max-width:min(360px,90vw);pointer-events:none;}',
      '.sc-toast{pointer-events:auto;cursor:pointer;border-radius:var(--sc-r-md);padding:10px 13px;font-size:13px;line-height:1.5;color:var(--sc-text);background:var(--sc-surface);border:1px solid var(--sc-border);box-shadow:var(--sc-shadow);animation:sc-toast-in 200ms var(--sc-ease);}',
      '.sc-toast b{font-weight:600;}',
      '.sc-toast small{display:block;font-size:11.5px;color:var(--sc-dim);margin-top:3px;}',

      /* ===== 设置块 / 外观 ===== */
      '.sc-settings-block{border:1px solid var(--sc-border);border-radius:var(--sc-r-md);padding:12px 14px;margin-bottom:14px;background:var(--sc-surface2);}',
      '.sc-settings-block h4{margin:0 0 6px;font-size:13px;font-weight:600;}',
      '.sc-swatches{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
      '.sc-swatch{width:22px;height:22px;border-radius:50%;border:1px solid var(--sc-border-strong);cursor:pointer;padding:0;transition:transform var(--sc-dur-fast) var(--sc-ease),box-shadow var(--sc-dur) var(--sc-ease);}',
      '.sc-swatch:hover{transform:scale(1.08);}',
      '.sc-swatch[aria-pressed="true"]{box-shadow:0 0 0 2px var(--sc-surface2),0 0 0 3px var(--sc-acc);}',

      /* ===== 动效 / 密度开关 ===== */
      '@keyframes sc-fade{from{opacity:0;}to{opacity:1;}}',
      '@keyframes sc-pop{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
      '@keyframes sc-toast-in{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}',
      '@keyframes sc-breathe{0%,100%{opacity:.55;}50%{opacity:1;}}',
      'html[data-sc-motion="off"] .sc-card *,html[data-sc-motion="off"] .sc-dock *,html[data-sc-motion="off"] .sc-panel *,html[data-sc-motion="off"] .sc-toast{animation:none!important;transition:none!important;}',
      'html[data-sc-motion="full"] .sc-row:hover{transform:translateY(-1px);}',
      'html[data-sc-density="compact"] .sc-row{padding:4px 8px;margin-bottom:4px;}',
      'html[data-sc-density="compact"] .sc-meta{display:none;}',
      '.sc-row.kbd{box-shadow:inset 0 0 0 1px var(--sc-focus);}',
      '.sc-row.active .sc-row-title{color:var(--sc-text);}',
    ].join('\n');

    function apply(ctx) {
      // 入口先判空：ctx 不合法时直接退场，连 warn 都不发，避免污染宿主日志。
      if (!ctx || typeof ctx !== 'object') return;
      if (typeof ctx.effect !== 'function') return;
      // 非浏览器侧（模块被当作普通 ESM 加载）直接退场。
      // document 不在这里硬判：样式注入已经 try/catch，无 DOM 环境也能跑。
      if (!inBrowser) return;

      try {
        var warn = function (msg, err) {
          try { console.warn('[' + NS + '] ' + msg, err); } catch { /* ignore */ }
        };
        var info = function (msg) {
          try { console.log('[' + NS + '] ' + msg); } catch { /* ignore */ }
        };

        // 语言包：locale 是严格注入的服务，必须先 inject 再访问。
        try {
          ctx.inject(['locale'], function (localeCtx) {
            try {
              if (localeCtx.locale && typeof localeCtx.locale.register === 'function') {
                ctx.effect(function () {
                  return localeCtx.locale.register(NS, { zh: zh, en: en });
                }, NS + ': dictionaries');
              }
            } catch (err) {
              warn('locale register failed', err);
            }
          });
        } catch (err) {
          warn('locale inject unavailable, using local zh', err);
        }

        var t = function (key, vars) {
          var s = zh[key] || key;
          if (vars && typeof s === 'string') {
            for (var k in vars) {
              if (Object.prototype.hasOwnProperty.call(vars, k)) s = s.split('{' + k + '}').join(String(vars[k]));
            }
          }
          return s;
        };

        if (!ctx.slots || typeof ctx.slots.register !== 'function' || typeof ctx.slots.inject !== 'function') {
          warn('slots service missing, UI not registered');
          return;
        }

        var React = null;
        try {
          React = require('react');
        } catch (err) {
          warn('react unavailable, UI not registered');
          return;
        }
        if (!React || typeof React.createElement !== 'function') {
          warn('react shape unexpected, UI not registered');
          return;
        }

        var h = React.createElement;

        /** 订阅主题（放在 apply 内，因为 React 是这里才拿到的）。 */
        function useThemePrefs() {
          var useSync = React.useSyncExternalStore;
          var sub = function (fn) { themeListeners.add(fn); return function () { themeListeners.delete(fn); }; };
          var get = function () { return themePrefs; };
          if (typeof useSync === 'function') return useSync(sub, get, get);
          return get();
        }

        // 宿主基础组件（菜单项 / 图标 / Tooltip）。Module Loader 里这是隐式 external，
        // 拿不到就退化成原生 button + 内联 SVG，功能不受影响。
        var primitives = null;
        try {
          primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        } catch {
          primitives = null;
        }

        // 样式：一次性注入，卸载时移除（无 DOM 环境跳过）。
        try {
          if (typeof document !== 'undefined' && document.head) {
            ctx.effect(function () {
            var tag = document.createElement('style');
            tag.setAttribute('data-dsh-session-clean', '1');
            tag.textContent = CSS;
            document.head.appendChild(tag);
            return function () {
              try { tag.remove(); } catch { /* ignore */ }
            };
          }, NS + ': styles');
          }
        } catch (err) {
          warn('style injection failed', err);
        }

        // 尽早把主题 token 写进 :root，并同步一份给宿主 / 外部浮窗
        try {
          applyThemePrefs(true);
          info('theme applied: ' + themePrefs.preset + '/' + themePrefs.mode + '/' + themePrefs.motion);
        } catch (err) {
          warn('theme apply failed', err);
        }

        // ------------------------------------------------------------ 共享状态
        // 侧边栏按钮与浮层面板是两个独立注册的条目，靠一个模块级 store 通信。
        var panelState = { open: false };
        var listeners = new Set();
        var emit = function () {
          listeners.forEach(function (fn) {
            try { fn(); } catch { /* ignore */ }
          });
        };
        var setOpen = function (open) {
          panelState.open = Boolean(open);
          emit();
        };
        var subscribe = function (fn) {
          listeners.add(fn);
          return function () { listeners.delete(fn); };
        };
        var getOpen = function () { return panelState.open; };

        function usePanelOpen() {
          var useSync = React.useSyncExternalStore;
          if (typeof useSync === 'function') return useSync(subscribe, getOpen, getOpen);
          var s = React.useState(panelState.open);
          var set = s[1];
          React.useEffect(function () {
            return subscribe(function () { set(getOpen()); });
          }, []);
          return s[0];
        }

        // ------------------------------------------------------------ 桌面（钉住的会话）
        /**
         * 「桌面」= 从会话列表里挑几个常用对话放到常驻浮条上，一点就切，用完收回。
         *
         * 和官方的 pin / 归档都不同：pin 只影响列表排序（还在工具箱里翻），
         * 归档是把行藏起来。桌面是一份额外的快捷入口清单，只存在浏览器本地，
         * 不动会话、不动归档集合、不动工作区。
         */
        var DESK_KEY = 'session-clean.desk';
        var deskListeners = new Set();

        function readDesk() {
          try {
            var raw = window.localStorage.getItem(DESK_KEY);
            var arr = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(arr)) return [];
            return arr
              .filter(function (x) { return x && x.sessionId; })
              .map(function (x) { return { sessionId: String(x.sessionId), title: String(x.title || '') }; })
              .slice(0, 12);
          } catch {
            return [];
          }
        }

        var deskMirrorAt = Date.now();
        var deskLastCurrent = '';
        var deskLastCurrent = '';
        var lastThemeStamp = 0;
        var deskItems = readDesk();

        function writeDesk(items) {
          deskItems = items;
          try { window.localStorage.setItem(DESK_KEY, JSON.stringify(items)); } catch { /* 隐私模式忽略 */ }
          deskListeners.forEach(function (fn) { try { fn(); } catch { /* 忽略 */ } });
          syncDeskToHost();
        }

        /**
         * 把桌面清单同步给宿主，供「最小化后也能用」的外部置顶小窗轮询。
         * 节流 400ms，失败静默（DSH 跑在纯浏览器里时这些路由也在，不怕）。
         */
        var deskSyncTimer = null;

        /** 给宿主的桌面快照：带上运行态/当前态，浮窗才能显示状态点和当前会话。 */
        function deskPayload() {
          var snap = sessionsSnapshotStable();
          var byId = (snap && snap.byId) || {};
          var cur = '';
          try { cur = String(currentSessionId() || ''); } catch { cur = ''; }
          return deskItems.map(function (it) {
            var row = byId[it.sessionId] || null;
            return {
              sessionId: it.sessionId,
              title: (row && (row.displayTitle || row.title)) || it.title || '',
              running: Boolean(row && row.running === true),
              current: Boolean(cur) && cur === it.sessionId,
            };
          });
        }

        /** 立刻推一次（绕过节流）：页面重载 / 宿主重启 / 长时间空闲之后靠它把镜像补回去。 */
        function pushDeskNow() {
          try {
            fetch('/session-clean/desk-state', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ items: deskPayload() }),
            }).catch(function () { /* 忽略 */ });
          } catch { /* 忽略 */ }
        }

        function syncDeskToHost(force) {
          try {
            if (force) { pushDeskNow(); return; }
            if (deskSyncTimer) return;
            deskSyncTimer = setTimeout(function () {
              deskSyncTimer = null;
              try {
                fetch('/session-clean/desk-state', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ items: deskPayload() }),
                }).catch(function () { /* 忽略 */ });
              } catch { /* 忽略 */ }
            }, 400);
          } catch { /* 忽略 */ }
        }

        function deskTitleOf(sessionId) {
          var id = String(sessionId);
          for (var i = 0; i < deskItems.length; i++) {
            if (deskItems[i].sessionId === id) return deskItems[i].title || '';
          }
          var snap = sessionsSnapshotStable();
          var row = snap && snap.byId ? snap.byId[id] : null;
          return (row && (row.displayTitle || row.title)) || '';
        }

        /**
         * 外部小窗的动作队列：点条目 = open，点 × = remove。
         * 1.2s 轮询一次；页面被最小化时浏览器会节流定时器，所以小窗点击时
         * 会先把 DSH 窗口带到前台（页面恢复可见），下一次轮询就执行。
         */
        var deskPollTimer = null;
        var deskPollBusy = false;

        function startDeskBridge() {
          var poll = function () {
            if (deskPollBusy) return;
            deskPollBusy = true;
            var done = function () { deskPollBusy = false; };
            try {
              fetch('/session-clean/desk-pending', { headers: { accept: 'application/json' } })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                  var actions = (d && d.actions) || [];
                  for (var i = 0; i < actions.length; i++) {
                    var a = actions[i] || {};
                    if (!a.sessionId) continue;
                    if (a.action === 'open') openSessionSmart(a.sessionId, deskTitleOf(a.sessionId));
                    else if (a.action === 'remove') removeDesk(a.sessionId);
                  }
                  // 顺带把主题/名称同步回来（浮窗那边也可能改过）
                  try {
                    if (d && d.theme && d.theme.updatedAt && d.theme.updatedAt > lastThemeStamp) {
                      lastThemeStamp = d.theme.updatedAt;
                      if (d.theme.preset && d.theme.mode) {
                        themePrefs = Object.assign({}, themePrefs, {
                          preset: d.theme.preset,
                          mode: d.theme.mode,
                          density: d.theme.density || themePrefs.density,
                          windowTitle: d.theme.windowTitle || themePrefs.windowTitle,
                        });
                        applyThemePrefs(false);
                      }
                    }
                  } catch { /* 忽略 */ }
                  // 当前会话变了（切会话 / 从小窗点开）→ 立刻把镜像推上去，浮窗高亮才不会停在原位
                  try {
                    var curNow = '';
                    try { curNow = String(currentSessionId() || ''); } catch { curNow = ''; }
                    if (curNow !== deskLastCurrent) {
                      deskLastCurrent = curNow;
                      if (deskItems.length) pushDeskNow();
                    }
                  } catch { /* 忽略 */ }
                  // 每 30s 把桌面镜像重推一次：页面长时间挂起、宿主重启后也能自助恢复
                  try {
                    if (Date.now() - deskMirrorAt > 30000) {
                      deskMirrorAt = Date.now();
                      if (deskItems.length) syncDeskToHost(true);
                    }
                  } catch { /* 忽略 */ }
                })
                .catch(function () { /* 忽略 */ })
                .then(done, done);
            } catch {
              done();
            }
          };
          try {
            deskPollTimer = setInterval(poll, 100);   // 宿主那边是长轮询，这里只是「拿到响应就立刻再发」
          } catch { /* 忽略 */ }
          try {
            ctx.effect(function () {
              return function () {
                try { if (deskPollTimer) clearInterval(deskPollTimer); } catch { /* 忽略 */ }
              };
            }, NS + ': desk bridge');
          } catch { /* 忽略 */ }
          // 页面重新可见时立刻补一次（最小化恢复最常见）
          try {
            if (typeof document.addEventListener === 'function') {
              ctx.effect(function () {
                var onVis = function () { if (!document.hidden) poll(); };
                document.addEventListener('visibilitychange', onVis);
                return function () {
                  try { document.removeEventListener('visibilitychange', onVis); } catch { /* 忽略 */ }
                };
              }, NS + ': desk visibility');
            }
          } catch { /* 忽略 */ }
          syncDeskToHost();
          poll();
        }

        function subscribeDesk(fn) {
          deskListeners.add(fn);
          return function () { deskListeners.delete(fn); };
        }

        function getDesk() { return deskItems; }

        function isOnDesk(sessionId) {
          var id = String(sessionId);
          return deskItems.some(function (x) { return x.sessionId === id; });
        }

        function addDesk(sessionId, title) {
          var id = String(sessionId);
          if (isOnDesk(id)) return;
          writeDesk(deskItems.concat([{ sessionId: id, title: String(title || '') }]));
        }

        function removeDesk(sessionId) {
          var id = String(sessionId);
          writeDesk(deskItems.filter(function (x) { return x.sessionId !== id; }));
        }

        function toggleDesk(sessionId, title) {
          if (isOnDesk(sessionId)) removeDesk(sessionId);
          else addDesk(sessionId, title);
        }

        /** 批量放到桌面：一次写盘，去重，最多 12 个。 */
        function addDeskMany(pairs) {
          var list = Array.isArray(pairs) ? pairs : [];
          var next = deskItems.slice();
          var added = 0;
          for (var i = 0; i < list.length; i++) {
            var p = list[i] || {};
            var id = String(p.sessionId || '');
            if (!id) continue;
            var exists = false;
            for (var j = 0; j < next.length; j++) {
              if (next[j].sessionId === id) { exists = true; break; }
            }
            if (exists) continue;
            if (next.length >= 12) break;
            next.push({ sessionId: id, title: String(p.title || '') });
            added += 1;
          }
          if (added) writeDesk(next);
          return added;
        }

        var DESK_POS_KEY = 'session-clean.desk.pos';
        var DESK_Z_KEY = 'session-clean.desk.z';

        function readDeskPos() {
          try {
            var raw = window.localStorage.getItem(DESK_POS_KEY);
            var p = raw ? JSON.parse(raw) : null;
            if (p && typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y };
          } catch { /* 忽略 */ }
          return null;
        }

        function writeDeskPos(pos) {
          try {
            if (pos) window.localStorage.setItem(DESK_POS_KEY, JSON.stringify(pos));
            else window.localStorage.removeItem(DESK_POS_KEY);
          } catch { /* 忽略 */ }
        }

        function readDeskZ() {
          try {
            return window.localStorage.getItem(DESK_Z_KEY) === 'back' ? 'back' : 'front';
          } catch {
            return 'front';
          }
        }

        function writeDeskZ(value) {
          try { window.localStorage.setItem(DESK_Z_KEY, value === 'back' ? 'back' : 'front'); } catch { /* 忽略 */ }
        }

        function useDesk() {
          var useSync = React.useSyncExternalStore;
          if (typeof useSync === 'function') return useSync(subscribeDesk, getDesk, getDesk);
          return getDesk();
        }

        /** sessions.list 的稳定订阅（useSyncExternalStore 要求 subscribe 稳定）。 */
        var sessionsSubscribeRef = null;

        function sessionsSubscribeStable(cb) {
          if (!sessionsSubscribeRef) {
            var s = sessionsService();
            if (!s || !s.list || typeof s.list.subscribe !== 'function') return function () {};
            sessionsSubscribeRef = function (fn) { return s.list.subscribe(fn); };
          }
          return sessionsSubscribeRef(cb);
        }

        function sessionsSnapshotStable() {
          try {
            var s = sessionsService();
            return s.list.getSnapshot();
          } catch {
            return { byId: {}, ids: [], phase: 'pending' };
          }
        }

        function useSessionsSnapshot() {
          var useSync = React.useSyncExternalStore;
          if (typeof useSync === 'function') {
            return useSync(sessionsSubscribeStable, sessionsSnapshotStable, sessionsSnapshotStable);
          }
          return sessionsSnapshotStable();
        }

        /** 打开一个会话；已归档的先放回再打开（否则宿主拒绝打开归档会话）。 */
        function openSessionSmart(sessionId, title) {
          var id = String(sessionId || '');
          if (!id) return;
          if (!isArchivedNow(id)) {
            openSessionById(id);
            return;
          }
          showToast(t('stash.returned', { title: title || id }), '正在放回并打开…', null, 2400);
          unstashSession(id)
            .then(function () { setTimeout(function () { openSessionById(id); }, 120); })
            .catch(function (e) {
              showToast(t('stash.failed') + String(e && e.message ? e.message : e), '', null, 5000);
            });
        }

        function requestJson(url, init) {
          return fetch(url, init).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (body) {
              if (!res.ok) {
                var msg = body && (body.error || body.detail);
                throw new Error((msg || res.status + ' ' + url));
              }
              return body;
            });
          });
        }

        function fmtTime(ms) {
          if (!ms) return '';
          var d = new Date(ms);
          var p = function (n) { return String(n).padStart(2, '0'); };
          return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
        }

        function human(bytes) {
          var n = Number(bytes) || 0;
          if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB';
          if (n >= 1024) return (n / 1024).toFixed(0) + 'KB';
          return n + 'B';
        }

        function baseName(p) {
          var s = String(p || '');
          var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
          return i >= 0 ? s.slice(i + 1) : s;
        }

        // ------------------------------------------------------------ 宿主服务（软依赖）
        /**
         * 取客户端服务。cordis 严格注入，未声明/未就绪一律 undefined，绝不抛。
         * 只用到 sessions / workspaces / uiSession / uiWorkspace / layout。
         */
        function service(name) {
          try {
            if (typeof ctx.get === 'function') return ctx.get(name);
          } catch { /* 未声明或未就绪 */ }
          return undefined;
        }

        var sessionsService = function () { return service('sessions'); };
        var workspacesService = function () { return service('workspaces'); };
        var uiSessionService = function () { return service('uiSession'); };

        /** 侧边栏的归档集合：宿主已把它投影进 workspaces.list 快照。 */
        function archivedList() {
          try {
            var w = workspacesService();
            var snap = w && w.list && w.list.getSnapshot();
            return (snap && Array.isArray(snap.archivedSessionIds)) ? snap.archivedSessionIds : [];
          } catch {
            return [];
          }
        }

        function isArchivedNow(sessionId) {
          return archivedList().indexOf(String(sessionId)) >= 0;
        }

        /**
         * 让客户端重建会话列表基线。
         *
         * 还原 / 取消归档后必须调：宿主的 session/list 会重新扫持久化目录，
         * 客户端拿到新基线才有数据画这一行 —— 这是「文件还原了但侧边栏没有」
         * 的客户端侧那一半（另一半是归档集合没摘掉）。
         */
        function refreshSessions() {
          try {
            var s = sessionsService();
            if (s && typeof s.refresh === 'function') {
              var p = s.refresh();
              if (p && typeof p.catch === 'function') p.catch(function () { /* 基线失败不冒泡 */ });
              return true;
            }
          } catch { /* 忽略 */ }
          return false;
        }

        /** 当前主视图里的会话 id（没有就空串）。 */
        function currentSessionId() {
          // 1) ui-session 的 main binding：value.key 就是当前会话 id
          try {
            var ui = uiSessionService();
            var cur = ui && ui.current && typeof ui.current.getSnapshot === 'function'
              ? ui.current.getSnapshot()
              : null;
            var key = cur && (cur.key || cur.sessionId || (cur.session && cur.session.sessionId));
            if (key) return String(key);
          } catch { /* 继续 */ }
          // 2) 退化成「谁被 mainView 持有」
          try {
            var s = sessionsService();
            var snap = s && s.list ? s.list.getSnapshot() : null;
            var byId = (snap && snap.byId) || {};
            for (var id in byId) {
              if (!Object.prototype.hasOwnProperty.call(byId, id)) continue;
              var rb = byId[id] && byId[id].retainedBy;
              if (rb && rb.mainView > 0) return id;
            }
          } catch { /* 继续 */ }
          return '';
        }

        function sessionTitleOf(sessionId) {
          try {
            var s = sessionsService();
            var snap = s && s.list ? s.list.getSnapshot() : null;
            var row = snap && snap.byId ? snap.byId[sessionId] : null;
            if (row) return String(row.displayTitle || row.title || '');
          } catch { /* 忽略 */ }
          return '';
        }

        function openSessionById(sessionId) {
          try {
            var ui = service('uiWorkspace');
            if (ui && typeof ui.openSession === 'function') {
              ui.openSession(sessionId);
              return true;
            }
          } catch { /* 忽略 */ }
          return false;
        }

        /** 从全局面板（比如隔离区）切回对话视图。 */
        function showConversation() {
          try {
            var L = service('layout');
            if (L && typeof L.selectPanel === 'function') {
              L.selectPanel(null);
              return true;
            }
          } catch { /* 忽略 */ }
          return false;
        }

        // ------------------------------------------------------------ 隔离区动作
        function stashSession(sessionId, title, stopActivity) {
          return requestJson('/session-clean/stash', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: sessionId,
              title: title || '',
              stopActivity: Boolean(stopActivity),
            }),
          });
        }

        function unstashSession(sessionId) {
          return requestJson('/session-clean/unstash', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId }),
          }).then(function (d) {
            refreshSessions();
            return d;
          });
        }

        /**
         * 隔离一个会话：正常走一次；宿主回 session-active 时，
         * 用一条可点击的提示问「先停止再隔离」，点一下就带 stopActivity 重试。
         * 不弹 window.confirm —— 宿主里那种阻塞对话框体验很差。
         */
        function requestStash(sessionId, title, onDone) {
          var name = String(title || '');
          var done = function (d) {
            try { if (typeof onDone === 'function') onDone(d); } catch { /* 忽略 */ }
            showToast(t('stash.moved', { title: name || sessionId }), '', null, 3600);
          };
          var fail = function (err) {
            var msg = String(err && err.message ? err.message : err);
            if (/session-active/.test(msg)) {
              showToast(t('stash.active'), t('stash.stopAndStash'), function () {
                stashSession(sessionId, name, true).then(done).catch(function (e2) {
                  showToast(t('stash.failed') + String(e2 && e2.message ? e2.message : e2), '', null, 5000);
                });
              }, 12000);
              return;
            }
            showToast(t('stash.failed') + msg, '', null, 5000);
          };
          stashSession(sessionId, name, false).then(done).catch(fail);
        }

        // ------------------------------------------------------------ 完成通知
        var NOTIFY_KEY = 'session-clean.notify';
        var notifyListeners = new Set();

        function notifyPref() {
          try {
            var v = window.localStorage.getItem(NOTIFY_KEY);
            return v === null ? true : v === '1';
          } catch {
            return true;
          }
        }

        function setNotifyPref(on) {
          try { window.localStorage.setItem(NOTIFY_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
          notifyListeners.forEach(function (fn) {
            try { fn(); } catch { /* 忽略 */ }
          });
        }

        function subscribeNotify(fn) {
          notifyListeners.add(fn);
          return function () { notifyListeners.delete(fn); };
        }

        function useNotifyPref() {
          var useSync = React.useSyncExternalStore;
          if (typeof useSync === 'function') return useSync(subscribeNotify, notifyPref, notifyPref);
          return notifyPref();
        }

        // toast 用纯 DOM：宿主组件树在插件卸载/热重载时不会连带把它带走
        var toastHost = null;

        function ensureToastHost() {
          if (typeof document === 'undefined' || !document.body) return null;
          if (toastHost && document.body.contains(toastHost)) return toastHost;
          toastHost = document.createElement('div');
          toastHost.className = 'sc-toast-wrap';
          toastHost.setAttribute('data-dsh-session-clean', 'toast');
          document.body.appendChild(toastHost);
          return toastHost;
        }

        function showToast(title, body, onClick, ms) {
          try {
            var host = ensureToastHost();
            if (!host) return;
            while (host.childElementCount >= 4) host.removeChild(host.firstElementChild);
            var el = document.createElement('div');
            el.className = 'sc-toast';
            el.setAttribute('role', 'status');
            var strong = document.createElement('strong');
            strong.textContent = String(title || '');
            el.appendChild(strong);
            if (body) {
              var small = document.createElement('small');
              small.textContent = String(body);
              el.appendChild(small);
            }
            if (typeof onClick === 'function') {
              el.addEventListener('click', function () {
                try { onClick(); } catch { /* 忽略 */ }
                try { el.remove(); } catch { /* 忽略 */ }
              });
            }
            host.appendChild(el);
            var ttl = Number(ms) > 0 ? Number(ms) : 6000;
            setTimeout(function () {
              try { el.remove(); } catch { /* 忽略 */ }
            }, ttl);
          } catch { /* toast 失败不影响主流程 */ }
        }

        function notificationPermission() {
          try {
            if (typeof Notification !== 'function') return 'unsupported';
            return Notification.permission || 'default';
          } catch {
            return 'unsupported';
          }
        }

        function requestNotifyPermission() {
          try {
            if (typeof Notification !== 'function') return Promise.resolve('unsupported');
            if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
            return Promise.resolve(Notification.requestPermission()).catch(function () { return 'denied'; });
          } catch {
            return Promise.resolve('unsupported');
          }
        }

        /** 窗口在后台才弹系统通知（前台只留面板内 toast，避免双份）。 */
        function systemNotify(title, body, onClick) {
          try {
            if (typeof Notification !== 'function' || Notification.permission !== 'granted') return false;
            var focused = true;
            try { focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true; } catch { focused = true; }
            var hidden = false;
            try { hidden = Boolean(document.hidden); } catch { hidden = false; }
            if (focused && !hidden) return false;
            var n = new Notification(title, { body: body, tag: 'dsh-session-clean' });
            n.onclick = function () {
              try { n.close(); } catch { /* 忽略 */ }
              try { if (typeof onClick === 'function') onClick(); } catch { /* 忽略 */ }
              try { window.focus(); } catch { /* 忽略 */ }
            };
            return true;
          } catch {
            return false;
          }
        }

        function announceTurnDone(sessionId, title) {
          if (!notifyPref()) return;
          var head = t('notify.doneTitle');
          var short = String(title || '').trim();
          var line = short ? head + ' · ' + short : head;
          var body = short ? t('notify.doneBody', { title: short }) : t('notify.doneBodyPlain');
          var open = function () { openSessionById(sessionId); };
          systemNotify(line, body, open);
          showToast(line, body, open, 6000);
        }

        /**
         * 回合完成监听。
         *
         * 两个源，同一个「true → false」判定：
         *   1. 宿主的 `api-session/status` 增量事件（最可靠，ui-session 自己也用它）；
         *   2. `sessions.list` 快照兜底（重连、首帧、事件丢失）。
         * 两份源都走 observe()，同一次完成只会弹一次。
         */
        function installTurnWatcher() {
          var s = sessionsService();
          var prev = new Map();

          var rowOf = function (id) {
            try {
              var snap = s && s.list ? s.list.getSnapshot() : null;
              var byId = (snap && snap.byId) || {};
              return byId[String(id)] || null;
            } catch {
              return null;
            }
          };

          var announce = function (id) {
            if (!notifyPref()) return;
            var row = rowOf(id);
            if (row && (row.origin === 'subagent' || row.blank === true)) return;
            var title = (row && (row.displayTitle || row.title)) || sessionTitleOf(id) || '';
            announceTurnDone(String(id), title);
          };

          var observe = function (id, running) {
            var key = String(id);
            var was = prev.get(key);
            var now = running === true;
            prev.set(key, now);
            if (was === true && !now) announce(key);
          };

          // 基线：把当前已在跑的会话记成 true，避免页面刚开就补弹一轮。
          var prime = function () {
            try {
              var snap = s && s.list ? s.list.getSnapshot() : null;
              var byId = (snap && snap.byId) || {};
              for (var id in byId) {
                if (!Object.prototype.hasOwnProperty.call(byId, id)) continue;
                prev.set(id, Boolean(byId[id] && byId[id].running === true));
              }
            } catch { /* 忽略 */ }
          };
          prime();

          // 源 1：宿主的 running 事件
          try {
            var remote = service('remote');
            if (remote && typeof remote.$on === 'function') {
              var off = remote.$on('api-session/status', function (sessionId, running) {
                try { observe(sessionId, running); } catch { /* 忽略 */ }
              });
              ctx.effect(function () {
                return function () { try { if (typeof off === 'function') off(); } catch { /* 忽略 */ } };
              }, NS + ': session status stream');
            } else {
              warn('remote.$on unavailable; falling back to list snapshots');
            }
          } catch (err) {
            warn('status stream subscribe failed', err);
          }

          // 源 2：列表快照
          if (s && s.list && typeof s.list.subscribe === 'function') {
            var onChange = function () {
              var snap = null;
              try { snap = s.list.getSnapshot(); } catch { return; }
              var byId = (snap && snap.byId) || {};
              for (var id in byId) {
                if (!Object.prototype.hasOwnProperty.call(byId, id)) continue;
                var row = byId[id];
                if (!row) continue;
                if (!prev.has(id)) { prev.set(id, row.running === true); continue; }
                observe(id, row.running);
              }
            };
            var dispose = s.list.subscribe(onChange);
            try {
              ctx.effect(function () {
                return function () { try { dispose(); } catch { /* 忽略 */ } };
              }, NS + ': turn watcher');
            } catch { /* 没有 effect 也不崩 */ }
          } else {
            warn('sessions.list missing; only the status stream is watched');
          }
          info('turn watcher ready (status stream + list snapshot)');
        }

        // ------------------------------------------------------------ 会话列表
        /**
         * @param {{ compact?: boolean, onNote?: Function, onChanged?: Function }} props
         */
        /**
         * 搜索框流光：用 requestAnimationFrame 平滑推进四个角度，切换速度时做插值，
         * 所以 hover / focus 之间不会出现角度跳变或重启（CSS 改 duration 会跳）。
         */
        function useSearchSpin(elRef, mode) {
          var stateRef = typeof React.useRef === 'function'
            ? React.useRef({ angle: 0, speed: 32 })
            : { current: { angle: 0, speed: 32 } };
          var rafRef = typeof React.useRef === 'function' ? React.useRef(0) : { current: 0 };

          React.useEffect(function () {
            var el = elRef.current;
            if (!el) return undefined;
            var motion = 'soft';
            try { motion = document.documentElement.getAttribute('data-sc-motion') || 'soft'; } catch { /* ignore */ }
            if (motion === 'off') {
              el.style.setProperty('--sc-a1', '24deg');
              el.style.setProperty('--sc-a2', '132deg');
              el.style.setProperty('--sc-a3', '248deg');
              el.style.setProperty('--sc-a4', '316deg');
              return undefined;
            }
            var target = mode === 'focus' ? 108 : mode === 'hover' ? 60 : 32; // deg/s
            var last = 0;
            var step = function (now) {
              if (!last) last = now;
              var dt = Math.min(0.05, (now - last) / 1000);
              last = now;
              var st = stateRef.current;
              st.speed += (target - st.speed) * Math.min(1, dt * 5);
              st.angle = (st.angle + st.speed * dt) % 360;
              var a = st.angle;
              el.style.setProperty('--sc-a1', a.toFixed(1) + 'deg');
              el.style.setProperty('--sc-a2', ((a * 1.37 + 40) % 360).toFixed(1) + 'deg');
              el.style.setProperty('--sc-a3', ((a * 0.83 + 120) % 360).toFixed(1) + 'deg');
              el.style.setProperty('--sc-a4', ((a * 1.62 + 200) % 360).toFixed(1) + 'deg');
              rafRef.current = requestAnimationFrame(step);
            };
            rafRef.current = requestAnimationFrame(step);
            return function () {
              try { if (rafRef.current) cancelAnimationFrame(rafRef.current); } catch { /* ignore */ }
            };
          }, [mode]);
        }

        function SessionsPane(props) {
          props = props || {};
          var listS = React.useState(null);
          var items = listS[0];
          var setItems = listS[1];

          var totalS = React.useState(0);
          var total = totalS[0];
          var setTotal = totalS[1];

          var errS = React.useState('');
          var err = errS[0];
          var setErr = errS[1];

          // 键盘选中的行（↑↓ 移动，Enter 打开）。这就是「快速选取 + 快速切换」的主路径。
          var cursorS = React.useState(0);
          var cursor = cursorS[0];
          var setCursor = cursorS[1];

          var searchRef = typeof React.useRef === 'function' ? React.useRef(null) : { current: null };
          var spinRef = typeof React.useRef === 'function' ? React.useRef(null) : { current: null };
          var spinS = React.useState('idle');
          var spinMode = spinS[0];
          var setSpinMode = spinS[1];
          useSearchSpin(spinRef, spinMode);

          // 实时快照：拿 running 状态（宿主列表摘要里有）
          var liveSnap = useSessionsSnapshot();
          var liveById = (liveSnap && liveSnap.byId) || {};
          var liveCurrent = '';
          try { liveCurrent = String(currentSessionId() || ''); } catch { liveCurrent = ''; }

          var qS = React.useState('');
          var q = qS[0];
          var setQ = qS[1];

          var selS = React.useState(function () { return {}; });
          var sel = selS[0];
          var setSel = selS[1];

          var busyS = React.useState(false);
          var busy = busyS[0];
          var setBusy = busyS[1];

          var armedS = React.useState(false);
          var armed = armedS[0];
          var setArmed = armedS[1];

          var fmtS = React.useState('md');
          var format = fmtS[0];
          var setFormat = fmtS[1];

          var noteS = React.useState('');
          var note = noteS[0];
          var setNote = noteS[1];

          var LIMIT = 2000;

          // 一次拉全，本地即时筛 —— 敲一个字就出结果，不往返服务端。
          var load = React.useCallback(function () {
            setErr('');
            return requestJson('/session-clean/sessions?limit=' + LIMIT, {
              headers: { accept: 'application/json' },
            })
              .then(function (d) {
                setItems(Array.isArray(d.items) ? d.items : []);
                setTotal(Number(d.total) || 0);
                setCursor(0);
              })
              .catch(function (e) {
                setItems([]);
                setErr(String(e && e.message ? e.message : e));
              });
          }, []);

          React.useEffect(function () { load(); }, [load]);

          var selectedIds = Object.keys(sel).filter(function (k) { return sel[k]; });

          // ---- 本地筛选：标题 / 会话 ID / 目录 ----
          var needle = String(q || '').trim().toLowerCase();
          var shown = (items || []).filter(function (r) {
            if (!needle) return true;
            return [r.title, r.sessionId, r.workspace, r.workspaceTitle]
              .some(function (v) { return String(v || '').toLowerCase().indexOf(needle) >= 0; });
          });
          var activeIndex = Math.max(0, Math.min(cursor, shown.length - 1));

          /**
           * 打开一行：
           *   已归档的先取消归档再打开（否则宿主会拒绝打开归档会话），
           *   然后 openSession + 关面板。这就是「换个对话」的全部动作。
           */
          var openRow = function (r) {
            if (!r || !r.sessionId) return;
            var go = function () {
              openSessionById(r.sessionId);
              try { if (typeof props.onClose === 'function') props.onClose(); } catch { /* ignore */ }
            };
            if (!r.archived) { go(); return; }
            setNote('正在放回并打开…');
            unstashSession(r.sessionId)
              .then(function () {
                setNote('');
                // 归档集合刚变，给客户端一帧重建列表再打开
                setTimeout(go, 120);
              })
              .catch(function (e) {
                setNote(t('stash.failed') + String(e && e.message ? e.message : e));
              });
          };

          // ---- 键盘：↑↓ 选择，Enter 打开，Esc 关闭 ----
          var onKeyDown = function (e) {
            var key = e && e.key;
            if (key === 'ArrowDown') {
              e.preventDefault();
              setCursor(Math.min(activeIndex + 1, Math.max(0, shown.length - 1)));
              return;
            }
            if (key === 'ArrowUp') {
              e.preventDefault();
              setCursor(Math.max(activeIndex - 1, 0));
              return;
            }
            if (key === 'Enter') {
              var target = shown[activeIndex];
              if (target) { e.preventDefault(); openRow(target); }
              return;
            }
            if (key === 'Escape') {
              e.preventDefault();
              try { if (typeof props.onClose === 'function') props.onClose(); } catch { /* ignore */ }
            }
          };

          var toggle = function (id) {
            setArmed(false);
            setSel(function (prev) {
              var next = Object.assign({}, prev);
              next[id] = !next[id];
              return next;
            });
          };

          var selectAll = function () {
            setArmed(false);
            var next = {};
            (items || []).forEach(function (r) { if (r.complete) next[r.sessionId] = true; });
            setSel(next);
          };

          var clearSel = function () {
            setArmed(false);
            setSel({});
          };

          var doDelete = function () {
            if (!selectedIds.length || busy) return;
            if (!armed) { setArmed(true); return; }
            setBusy(true);
            setNote('');
            requestJson('/session-clean/delete-many', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ids: selectedIds }),
            })
              .then(function (d) {
                var ok = Number(d.deleted) || 0;
                var bad = (d.failed || []).length;
                setNote(bad ? t('panel.deletedPartial', { ok: ok, bad: bad }) : t('panel.deleted', { n: ok }));
                setSel({});
                setArmed(false);
                load();
                if (typeof props.onChanged === 'function') {
                  try { props.onChanged(d); } catch { /* ignore */ }
                }
              })
              .catch(function (e) { setNote(t('toast.failed') + String(e.message || e)); })
              .then(function () { setBusy(false); });
          };

          var doExport = function (mode) {
            if (!selectedIds.length || busy) return;
            setBusy(true);
            setNote('');
            var body = JSON.stringify({ ids: selectedIds, format: format });
            if (mode === 'zip') {
              fetch('/session-clean/export-zip', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: body,
              })
                .then(function (res) {
                  if (!res.ok) {
                    return res.json().catch(function () { return {}; }).then(function (d) {
                      throw new Error((d && d.error) || res.status + ' export-zip');
                    });
                  }
                  var name = 'dsh-sessions.zip';
                  var cd = res.headers.get('content-disposition') || '';
                  var m = /filename="?([^";]+)"?/.exec(cd);
                  if (m && m[1]) name = m[1];
                  return res.blob().then(function (blob) {
                    var url = URL.createObjectURL(blob);
                    var a = document.createElement('a');
                    a.href = url;
                    a.download = name;
                    document.body.appendChild(a);
                    a.click();
                    try { a.remove(); } catch { /* ignore */ }
                    setTimeout(function () { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 4000);
                    setNote(t('panel.exported', { dir: name }));
                  });
                })
                .catch(function (e) { setNote(t('panel.exportFailed') + String(e.message || e)); })
                .then(function () { setBusy(false); });
              return;
            }

            requestJson('/session-clean/export', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: body,
            })
              .then(function (d) { setNote(t('panel.exported', { dir: d.dir || '?' })); })
              .catch(function (e) { setNote(t('panel.exportFailed') + String(e.message || e)); })
              .then(function () { setBusy(false); });
          };

          var rows = shown.map(function (r, index) {
            var checked = Boolean(sel[r.sessionId]);
            var liveRow = liveById[r.sessionId] || null;
            var running = Boolean(liveRow && liveRow.running === true);
            var isCurrent = Boolean(liveCurrent) && liveCurrent === String(r.sessionId);
            var tags = [];
            if (r.archived) tags.push('row.archived');
            if (r.stashed) tags.push('row.stashed');
            if (!r.complete) tags.push('row.incomplete');
            if (!r.workspaceTitle) tags.push('row.orphan');
            var group = r.workspaceTitle || baseName(r.workspace) || '';
            var meta = fmtTime(r.mtime) + ' · ' + human(r.bytes) + (group ? ' · ' + group : '');
            var cls = 'sc-row' + (isCurrent ? ' active' : '') + (index === activeIndex ? ' kbd' : '');
            return h('div', {
              className: cls,
              key: r.sessionId,
              role: 'button',
              tabIndex: -1,
              title: '点击打开这个对话',
              onClick: function () { setCursor(index); openRow(r); },
              onMouseEnter: function () { setCursor(index); },
            },
            h('label', {
              className: 'sc-check',
              title: r.title || r.sessionId,
              onClick: function (e) { try { e.stopPropagation(); } catch { /* ignore */ } },
            },
            h('input', {
              type: 'checkbox',
              checked: checked,
              disabled: busy,
              onChange: function () { toggle(r.sessionId); },
              'aria-label': r.title || r.sessionId,
            }),
            h('svg', {
              className: 'sc-check-svg',
              viewBox: '0 0 200 200',
              'aria-hidden': 'true',
              focusable: 'false',
            },
            h('rect', { className: 'sc-check-base', x: 14, y: 14, width: 172, height: 172, rx: 52 }),
            h('rect', { className: 'sc-check-box', x: 14, y: 14, width: 172, height: 172, rx: 52 }),
            h('path', { className: 'sc-check-tick', d: 'M52 111.018L76.9867 136L149 64' }),
            h('path', { className: 'sc-check-dash', d: 'M58 104h84' }))),
            h('span', {
              className: 'sc-status-dot' + (running ? ' running' : ''),
              title: running ? '运行中' : '空闲',
              'aria-hidden': 'true',
            }),
            h('div', { className: 'sc-row-main' },
              h('div', { className: 'sc-row-title', title: r.title || r.sessionId },
                r.title || r.sessionId,
                tags.map(function (key, i) { return h('span', { className: 'sc-tag', key: key + i }, t(key)); })),
              h('div', { className: 'sc-meta' },
                meta,
                h('span', { className: 'sc-status-text' + (running ? ' running' : '') },
                  ' · ' + (running ? '运行中' : '空闲')))),
            h('div', { className: 'sc-row-actions' },
              h('button', {
                className: 'sc-btn sc-btn-sm',
                type: 'button',
                title: isOnDesk(r.sessionId) ? t('desk.remove') : t('desk.add'),
                onClick: function (e) {
                  try { e.stopPropagation(); } catch { /* 忽略 */ }
                  if (!isOnDesk(r.sessionId) && deskItems.length >= 12) { setNote(t('desk.full')); return; }
                  toggleDesk(r.sessionId, r.title);
                },
              }, isOnDesk(r.sessionId) ? '★' : '☆'),
              h('button', {
                className: 'sc-btn primary sc-btn-sm',
                type: 'button',
                onClick: function (e) { try { e.stopPropagation(); } catch { /* ignore */ } openRow(r); },
              }, t('panel.openChat')),
              h('button', {
                className: 'sc-btn sc-btn-sm',
                type: 'button',
                title: r.archived ? t('row.unstash') : t('row.stash'),
                onClick: function (e) {
                  try { e.stopPropagation(); } catch { /* ignore */ }
                  if (r.archived) {
                    unstashSession(r.sessionId).then(function () { load(); }).catch(function (err2) {
                      setNote(t('stash.failed') + String(err2 && err2.message ? err2.message : err2));
                    });
                    return;
                  }
                  requestStash(r.sessionId, r.title, function () { load(); });
                },
              }, r.archived ? t('row.unstash') : t('row.stash'))));
          });

          return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
            h('div', { className: 'sc-tools' },
              h('div', {
                  className: 'sc-search',
                  ref: spinRef,
                  onMouseEnter: function () { setSpinMode('hover'); },
                  onMouseLeave: function () { setSpinMode('idle'); },
                },
                h('div', { className: 'sc-search-glow' }),
                h('div', { className: 'sc-search-dark' }),
                h('div', { className: 'sc-search-white' }),
                h('div', { className: 'sc-search-border' }),
                h('div', { className: 'sc-search-main' },
                  h('span', { className: 'sc-search-ico-left' }, searchGlyph()),
                  h('input', {
                    ref: searchRef,
                    type: 'search',
                    autoFocus: true,
                    onFocus: function () { setSpinMode('focus'); },
                    onBlur: function () { setSpinMode('idle'); },
                    placeholder: t('panel.search'),
                    value: q,
                    onKeyDown: onKeyDown,
                    onChange: function (e) {
                      setQ(e.target.value);
                      setCursor(0);
                    },
                  }),
                  )),
              h('span', { className: 'sc-kbd' }, '↑↓ 选择 · Enter 打开 · Esc 关闭'),
              h('button', { className: 'sc-btn', type: 'button', onClick: selectAll, disabled: busy }, t('panel.selectAll')),
              h('button', { className: 'sc-btn', type: 'button', onClick: clearSel, disabled: busy || !selectedIds.length }, t('panel.clear')),
              h('button', { className: 'sc-btn', type: 'button', onClick: function () { load(); }, disabled: busy }, t('settings.refresh'))),

            h('div', { className: 'sc-list', onKeyDown: onKeyDown },
              items === null ? h('div', { className: 'sc-empty' }, t('panel.loading'))
                : rows.length ? rows
                  : h('div', { className: 'sc-empty' }, needle ? t('panel.noMatch') : t('panel.empty')),
              err ? h('div', { className: 'sc-empty' }, err) : null,
              items && items.length >= LIMIT ? h('div', { className: 'sc-empty' }, t('panel.more', { n: LIMIT })) : null),

            h('div', { className: 'sc-foot' },
              h('span', { style: { fontSize: 12, opacity: 0.72 } }, t('panel.selected', { n: selectedIds.length })),
              h('span', { style: { fontSize: 11, opacity: 0.5 } },
                needle ? t('panel.matched', { n: rows.length, total: total }) : t('panel.total', { n: total })),
              h('span', { className: 'sc-spacer' }),
              h('button', {
                className: 'sc-btn',
                type: 'button',
                title: t('desk.add'),
                disabled: busy || !selectedIds.length,
                onClick: function () {
                  var pairs = (items || [])
                    .filter(function (r) { return sel[r.sessionId]; })
                    .map(function (r) { return { sessionId: r.sessionId, title: r.title }; });
                  var added = addDeskMany(pairs);
                  setNote(t('desk.batchDone', { n: added }));
                  setSel({});
                },
              }, t('desk.batch', { n: selectedIds.length })),
              h('label', { style: { fontSize: 11.5, opacity: 0.72, display: 'flex', alignItems: 'center', gap: 4 } },
                t('panel.format'),
                h('select', {
                  className: 'sc-btn',
                  value: format,
                  onChange: function (e) { setFormat(e.target.value); },
                  disabled: busy,
                },
                h('option', { value: 'md' }, 'Markdown'),
                h('option', { value: 'json' }, 'JSON'),
                h('option', { value: 'both' }, 'MD + JSON'))),
              h('button', {
                className: 'sc-btn',
                type: 'button',
                onClick: function () { doExport('disk'); },
                disabled: busy || !selectedIds.length,
              }, t('panel.exportDisk')),
              h('button', {
                className: 'sc-btn',
                type: 'button',
                onClick: function () { doExport('zip'); },
                disabled: busy || !selectedIds.length,
              }, t('panel.exportZip')),
              h('button', {
                className: armed ? 'sc-btn danger' : 'sc-btn',
                type: 'button',
                onClick: doDelete,
                disabled: busy || !selectedIds.length,
              }, armed ? t('panel.deleteArm', { n: selectedIds.length }) : t('panel.delete'))),

            note ? h('div', { className: 'sc-note' }, note) : null);
        }

        // ------------------------------------------------------------ 回收站
        function TrashPane() {
          var s = React.useState(null);
          var items = s[0];
          var setItems = s[1];
          var busyS = React.useState(false);
          var busy = busyS[0];
          var setBusy = busyS[1];
          var noteS = React.useState('');
          var note = noteS[0];
          var setNote = noteS[1];

          var load = React.useCallback(function () {
            return requestJson('/session-clean/trash', { headers: { accept: 'application/json' } })
              .then(function (d) { setItems(Array.isArray(d.items) ? d.items : []); })
              .catch(function (e) { setItems([]); setNote(String(e.message || e)); });
          }, []);

          React.useEffect(function () { load(); }, [load]);

          var act = function (url, body) {
            if (busy) return;
            setBusy(true);
            setNote('');
            requestJson(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body || {}),
            })
              .then(function () {
                // 还原会改归档集合，客户端的会话基线必须重建，否则侧边栏还是没有这一行。
                if (/restore|unstash/.test(url)) refreshSessions();
                load();
              })
              .catch(function (e) { setNote(String(e.message || e)); })
              .then(function () { setBusy(false); });
          };

          var rows = (items || []).map(function (b) {
            return h('div', { className: 'sc-row', key: b.batchId },
              h('div', { className: 'sc-row-main' },
                h('div', { className: 'sc-row-title' }, b.title || b.sessionId || b.batchId),
                h('div', { className: 'sc-meta' }, String(b.deletedAt || '').slice(0, 16).replace('T', ' ') + ' · ' + human(b.bytes))),
              h('button', { className: 'sc-btn', type: 'button', disabled: busy, onClick: function () { act('/session-clean/restore', { batchId: b.batchId }); } }, t('settings.restore')),
              h('button', { className: 'sc-btn', type: 'button', disabled: busy, onClick: function () { act('/session-clean/purge', { batchId: b.batchId }); } }, t('settings.purge')));
          });

          return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
            h('div', { className: 'sc-tools' },
              h('span', { style: { fontSize: 12, opacity: 0.7, flex: 1 } }, t('settings.desc')),
              h('button', { className: 'sc-btn', type: 'button', onClick: function () { load(); }, disabled: busy }, t('settings.refresh')),
              h('button', {
                className: 'sc-btn',
                type: 'button',
                disabled: busy || !(items && items.length),
                onClick: function () { act('/session-clean/purge-all', {}); },
              }, t('settings.purgeAll'))),
            h('div', { className: 'sc-list' },
              items === null ? h('div', { className: 'sc-empty' }, t('panel.loading'))
                : rows.length ? rows : h('div', { className: 'sc-empty' }, t('settings.empty'))),
            note ? h('div', { className: 'sc-note' }, note) : null);
        }

        // ------------------------------------------------------------ 浮层面板
        function SessionPanel() {
          var open = usePanelOpen();
          var tabS = React.useState('sessions');
          var tab = tabS[0];
          var setTab = tabS[1];


          // 浮窗名称：面板顶部可直接改，和设置页共用同一份偏好
          var prefs = useThemePrefs();
          // 打开时把焦点丢进搜索框：立刻能敲字筛选，↑↓/Enter 直接切会话。
          if (typeof React.useEffect === 'function') {
            React.useEffect(function () {
              if (!open) return undefined;
              var timer = setTimeout(function () {
                try {
                  var el = document.querySelector('.sc-backdrop .sc-input');
                  if (el && typeof el.focus === 'function') el.focus();
                } catch { /* 忽略 */ }
              }, 40);
              return function () { try { clearTimeout(timer); } catch { /* 忽略 */ } };
            }, [open]);
          }

          if (!open) return null;

          return h('div', {
            className: 'sc-backdrop',
            onClick: function (e) { if (e.target === e.currentTarget) setOpen(false); },
            onKeyDown: function (e) { if (e && e.key === 'Escape') setOpen(false); },
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('panel.title'),
          },
          h('div', { className: 'sc-card sc-card-wide' },
            h('div', { className: 'sc-head' },
              h('h3', null, t('panel.title')),
              h('label', { className: 'sc-name', title: '浮窗标题（会同步到桌面浮窗）' },
                h('span', null, '浮窗'),
                h('input', {
                  type: 'text',
                  value: prefs.windowTitle || '',
                  maxLength: 24,
                  placeholder: 'DSH 当前对话',
                  'aria-label': '浮窗名称',
                  onChange: function (e) { setThemePrefs({ windowTitle: String(e.target.value || '').slice(0, 24) }); },
                })),
              h('span', { className: 'sc-kbd' }, t('panel.hint')),
              h('div', { className: 'sc-tabs' },
                h('button', { className: tab === 'sessions' ? 'sc-btn primary' : 'sc-btn', type: 'button', onClick: function () { setTab('sessions'); } }, t('panel.tab.sessions')),
                h('button', { className: tab === 'trash' ? 'sc-btn primary' : 'sc-btn', type: 'button', onClick: function () { setTab('trash'); } }, t('panel.tab.trash'))),
              h('button', { className: 'sc-btn', type: 'button', onClick: function () { setOpen(false); } }, t('panel.close'))),
            tab === 'sessions'
              ? h(SessionsPane, { onClose: function () { setOpen(false); } })
              : h(TrashPane)));
        }

        /** 侧边栏底部按钮：打开「会话」跳板。 */
        function SidebarButton(props) {
          var open = usePanelOpen();
          var wide = props && props.wide;
          return h('button', {
            className: 'sc-btn' + (open ? ' primary' : ''),
            type: 'button',
            title: t('panel.open'),
            'aria-label': t('panel.title'),
            onClick: function () { setOpen(!open); },
          }, wide ? t('panel.tab.sessions') : '🗂');
        }

        // ------------------------------------------------------------ 会话行入口
        /** 图标：优先用宿主 primitives，退化到内联 SVG。 */
        function archiveIcon(archived, size) {
          var n = Number(size) > 0 ? Number(size) : 14;
          try {
            if (primitives) {
              var Comp = archived ? primitives.IconUnarchiveOutlineRegular : primitives.IconArchiveOutlineRegular;
              if (typeof Comp === 'function') return h(Comp, { size: n });
            }
          } catch { /* 忽略 */ }
          return h('svg', {
            width: n, height: n, viewBox: '0 0 16 16',
            'aria-hidden': 'true', focusable: 'false',
          }, h('path', {
            d: archived ? 'M8 12V4m0 0L5 7m3-3l3 3M3 13h10' : 'M2 3h12v3H2zM3.5 6h9v7h-9zM6 8.5h4',
            fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3',
            'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          }));
        }

        /** 会话行「...」菜单：隔离 / 放回。 */
        function StashMenuItem(props) {
          try {
            props = props || {};
            var sessionId = props.sessionId;
            var openState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null;
            var setMenuOpen = openState && typeof openState[1] === 'function' ? openState[1] : function () {};
            var archived = isArchivedNow(sessionId);
            var label = archived ? t('menu.unstash') : t('menu.stash');
            var onSelect = function () {
              try { setMenuOpen(false); } catch { /* 忽略 */ }
              if (archived) {
                unstashSession(sessionId)
                  .then(function () {
                    showToast(t('stash.returned', { title: props.displayTitle || sessionId }), '', null, 3600);
                  })
                  .catch(function (e) {
                    showToast(t('stash.failed') + String(e && e.message ? e.message : e), '', null, 5000);
                  });
                return;
              }
              requestStash(sessionId, props.displayTitle);
            };

            var Btn = primitives && primitives.MenuItemButton;
            if (typeof Btn === 'function') {
              return h(Btn, { icon: archiveIcon(archived, 14), onSelect: onSelect }, label);
            }
            return h('button', { type: 'button', role: 'menuitem', onClick: onSelect }, label);
          } catch (err) {
            warn('stash menu item render failed', err);
            return null;
          }
        }

        /** 会话行「...」菜单：移入回收站。 */
        function TrashMenuItem(props) {
          try {
            props = props || {};
            var sessionId = props.sessionId;
            var openState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null;
            var setMenuOpen = openState && typeof openState[1] === 'function' ? openState[1] : function () {};
            var onSelect = function () {
              try { setMenuOpen(false); } catch { /* 忽略 */ }
              requestJson('/session-clean/delete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: sessionId }),
              })
                .then(function () {
                  refreshSessions();
                  showToast(t('toast.moved'), '', null, 3600);
                })
                .catch(function (e) {
                  var msg = String(e && e.message ? e.message : e);
                  if (/session-active/.test(msg)) {
                    showToast('这个对话还有任务在跑，先停止再删。', '', null, 5000);
                    return;
                  }
                  showToast(t('toast.failed') + msg, '', null, 5000);
                });
            };
            var Btn = primitives && primitives.MenuItemButton;
            if (typeof Btn === 'function') {
              var icon = null;
              try {
                if (primitives && typeof primitives.IconTrashOutlineRegular === 'function') {
                  icon = h(primitives.IconTrashOutlineRegular, { size: 14 });
                }
              } catch { /* 忽略 */ }
              return h(Btn, { icon: icon, onSelect: onSelect }, t('menu.trash'));
            }
            return h('button', { type: 'button', role: 'menuitem', onClick: onSelect }, t('menu.trash'));
          } catch (err) {
            warn('trash menu item render failed', err);
            return null;
          }
        }

        /** 会话行悬停小按钮：隔离 / 放回。 */
        function StashRowButton(props) {
          try {
            props = props || {};
            var sessionId = props.sessionId;
            var archived = isArchivedNow(sessionId);
            var label = archived ? t('row.unstash') : t('row.stash');
            var onClick = function (event) {
              try { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); } catch { /* 忽略 */ }
              if (archived) {
                unstashSession(sessionId)
                  .then(function () {
                    showToast(t('stash.returned', { title: props.displayTitle || sessionId }), '', null, 3600);
                  })
                  .catch(function (e) {
                    showToast(t('stash.failed') + String(e && e.message ? e.message : e), '', null, 5000);
                  });
                return;
              }
              requestStash(sessionId, props.displayTitle);
            };

            var btn = h('button', {
              type: 'button',
              className: 'sc-icon-btn',
              title: label,
              'aria-label': label,
              onClick: onClick,
            }, archiveIcon(archived, 14));

            var Tip = primitives && primitives.Tooltip;
            if (typeof Tip === 'function') {
              return h(Tip, { label: label, side: 'bottom', align: 'end', delayMs: 400, portal: true }, btn);
            }
            return btn;
          } catch (err) {
            warn('stash row button render failed', err);
            return null;
          }
        }

        // ------------------------------------------------------------ 隔离区面板
        /**
         * 隔离区：独立的一屏（layout 的 main keyed 槽位），配一个侧边栏面板图标。
         *
         * 「隔离当前对话」自己解析当前会话 id，不需要用户先在列表里找 —— 这是
         * 「把正在用的对话抽走」的自动那一步；结束之后按「放回」就回到原位置。
         */
        function StashPanel() {
          var listS = React.useState(null);
          var items = listS[0];
          var setItems = listS[1];

          var busyS = React.useState(false);
          var busy = busyS[0];
          var setBusy = busyS[1];

          var noteS = React.useState('');
          var note = noteS[0];
          var setNote = noteS[1];

          var load = React.useCallback(function () {
            return requestJson('/session-clean/stash', { headers: { accept: 'application/json' } })
              .then(function (d) { setItems(Array.isArray(d.items) ? d.items : []); })
              .catch(function (e) {
                setItems([]);
                setNote(t('stash.failed') + String(e && e.message ? e.message : e));
              });
          }, []);

          React.useEffect(function () { load(); }, [load]);

          var doCurrent = function () {
            if (busy) return;
            var id = currentSessionId();
            if (!id) { setNote(t('stash.noSession')); return; }
            setBusy(true);
            setNote('');
            requestStash(id, sessionTitleOf(id), function () { load(); });
            setTimeout(function () { setBusy(false); load(); }, 600);
          };

          var doReturn = function (sessionId, title) {
            if (busy) return;
            setBusy(true);
            setNote('');
            unstashSession(sessionId)
              .then(function () {
                setNote(t('stash.returned', { title: title || sessionId }));
                return load();
              })
              .catch(function (e) { setNote(t('stash.failed') + String(e && e.message ? e.message : e)); })
              .then(function () { setBusy(false); });
          };

          /** 放回 + 直接打开：一键把隔离区里的对话拉回主视图继续聊。 */
          var doOpen = function (sessionId, title) {
            if (busy) return;
            setBusy(true);
            setNote('');
            unstashSession(sessionId)
              .then(function () {
                showConversation();
                setTimeout(function () { openSessionById(sessionId); }, 120);
                setNote(t('stash.returned', { title: title || sessionId }));
                return load();
              })
              .catch(function (e) { setNote(t('stash.failed') + String(e && e.message ? e.message : e)); })
              .then(function () { setBusy(false); });
          };

          var rows = (items || []).map(function (it) {
            var tags = [];
            if (!it.archived) tags.push('stash.archivedOnly');
            tags.push(it.onDisk ? 'stash.onDisk' : 'stash.missing');
            var meta = [
              it.workspaceTitle || baseName(it.workspace) || '',
              fmtTime(Date.parse(it.stashedAt) || 0),
            ].filter(Boolean).join(' · ');
            return h('div', { className: 'sc-stash-row', key: it.sessionId },
              h('div', { className: 'sc-stash-main' },
                h('div', { className: 'sc-stash-title', title: it.title || it.sessionId },
                  it.title || it.sessionId,
                  tags.map(function (k, i) { return h('span', { className: 'sc-tag', key: k + i }, t(k)); })),
                h('div', { className: 'sc-meta' }, meta)),
              h('button', {
                className: 'sc-btn primary',
                type: 'button',
                disabled: busy,
                onClick: function () { doOpen(it.sessionId, it.title); },
              }, t('stash.open')),
              h('button', {
                className: 'sc-btn',
                type: 'button',
                disabled: busy,
                onClick: function () { doReturn(it.sessionId, it.title); },
              }, t('stash.restore')));
          });

          return h('div', { className: 'sc-panel' },
            h('div', { className: 'sc-panel-head' },
              h('h2', null, t('stash.title')),
              h('span', { className: 'sc-spacer', style: { flex: 1 } }),
              h('button', {
                className: 'sc-btn primary',
                type: 'button',
                disabled: busy,
                onClick: doCurrent,
              }, t('stash.current')),
              h('button', {
                className: 'sc-btn',
                type: 'button',
                disabled: busy,
                onClick: function () { setNote(''); load(); },
              }, t('stash.refresh')),
              h('span', { style: { fontSize: 11, opacity: 0.55 } }, t('stash.total', { n: (items || []).length }))),
            h('p', { className: 'sc-panel-desc' }, t('stash.desc')),
            h('div', { className: 'sc-panel-list' },
              items === null ? h('div', { className: 'sc-empty' }, t('stash.loading'))
                : rows.length ? rows : h('div', { className: 'sc-empty' }, t('stash.empty'))),
            note ? h('div', { className: 'sc-hint' }, note) : null);
        }

        // ------------------------------------------------------------ 桌面浮条
        /**
         * 常驻左下角的「桌面」：只放你挑出来的那几个对话。
         *
         * 点一下切过去，× 收回；空的时候退化成一个小入口，不占地方。
         * 会话本身不动：不归档、不移动、不改顺序 —— 只是多一份常驻的快捷入口。
         */
        function DeskDock() {
          var items = useDesk();
          var snap = useSessionsSnapshot();
          var collapsedS = React.useState(false);
          var collapsed = collapsedS[0];
          var setCollapsed = collapsedS[1];

          var posS = React.useState(readDeskPos);
          var pos = posS[0];
          var setPos = posS[1];

          var zS = React.useState(readDeskZ);
          var z = zS[0];
          var setZ = zS[1];

          // 拖动过程中要读最新位置（setState 是异步的），用 ref 兜住。
          var posRef = typeof React.useRef === 'function' ? React.useRef(pos) : { current: pos };
          posRef.current = pos;

          var byId = (snap && snap.byId) || {};
          var currentId = '';
          try { currentId = String(currentSessionId() || ''); } catch { currentId = ''; }

          var openPanel = function () { setOpen(true); };

          // 拖动：按住头部移动；双击回默认位置。位置存 localStorage。
          var dragRef = typeof React.useRef === 'function' ? React.useRef(null) : { current: null };

          var onHeadDown = function (e) {
            if (!e || e.button === 2) return;
            try { e.preventDefault(); } catch { /* 忽略 */ }
            var startX = Number(e.clientX) || 0;
            var startY = Number(e.clientY) || 0;
            var rect = null;
            try { rect = e.currentTarget.getBoundingClientRect(); } catch { rect = null; }
            var baseX = pos ? pos.x : (rect ? rect.left : 12);
            var baseY = pos ? pos.y : (rect ? rect.top : 120);
            dragRef.current = { moved: false };

            var onMove = function (ev) {
              var x = baseX + ((Number(ev.clientX) || 0) - startX);
              var y = baseY + ((Number(ev.clientY) || 0) - startY);
              var maxX = Math.max(8, (window.innerWidth || 1200) - 80);
              var maxY = Math.max(8, (window.innerHeight || 800) - 48);
              if (dragRef.current) dragRef.current.moved = true;
              setPos({ x: Math.max(8, Math.min(maxX, x)), y: Math.max(8, Math.min(maxY, y)) });
            };
            var onUp = function () {
              try {
                document.removeEventListener('pointermove', onMove, true);
                document.removeEventListener('pointerup', onUp, true);
              } catch { /* 忽略 */ }
              if (dragRef.current && dragRef.current.moved) writeDeskPos(posRef.current);
              dragRef.current = null;
            };
            try {
              document.addEventListener('pointermove', onMove, true);
              document.addEventListener('pointerup', onUp, true);
            } catch { /* 忽略 */ }
          };

          var onHeadDoubleClick = function () {
            setPos(null);
            writeDeskPos(null);
          };

          var toggleZ = function () {
            var next = z === 'back' ? 'front' : 'back';
            setZ(next);
            writeDeskZ(next);
          };

          // 位置 / 层级统一走 inline style（CSS 里的 left/bottom 只是默认值）。
          var dockStyle = {
            left: pos ? pos.x + 'px' : undefined,
            top: pos ? pos.y + 'px' : undefined,
            bottom: pos ? 'auto' : undefined,
            zIndex: z === 'back' ? 1 : 2147482000,
          };

          if (!items.length) {
            return h('div', { className: 'sc-dock mini', style: dockStyle },
              h('button', {
                className: 'sc-dock-mini-btn',
                type: 'button',
                title: t('desk.empty') + ' · ' + t('desk.drag'),
                onClick: openPanel,
              }, h('span', null, '📌'), h('span', null, t('desk.title'))));
          }

          if (collapsed) {
            return h('div', { className: 'sc-dock mini', style: dockStyle },
              h('button', {
                className: 'sc-dock-mini-btn',
                type: 'button',
                title: t('desk.expand'),
                onClick: function () { setCollapsed(false); },
              }, h('span', null, '📌'), h('span', null, String(items.length))));
          }

          var rows = items.map(function (it) {
            var row = byId[it.sessionId] || null;
            var title = (row && (row.displayTitle || row.title)) || it.title || it.sessionId.slice(0, 14);
            var running = Boolean(row && row.running === true);
            var active = Boolean(currentId) && currentId === it.sessionId;
            var cls = 'sc-desk-item' + (active ? ' active' : '') + (running ? ' running' : '');
            return h('div', { className: cls, key: it.sessionId },
              h('button', {
                className: 'sc-desk-open',
                type: 'button',
                title: title,
                onClick: function () { openSessionSmart(it.sessionId, title); },
              },
              h('span', { className: 'sc-desk-dot' }),
              h('span', { className: 'sc-desk-title' }, title)),
              h('button', {
                className: 'sc-desk-x',
                type: 'button',
                title: t('desk.remove'),
                'aria-label': t('desk.remove'),
                onClick: function (e) {
                  try { e.stopPropagation(); } catch { /* 忽略 */ }
                  removeDesk(it.sessionId);
                },
              }, '×'));
          });

          var stopDrag = function (e) { try { e.stopPropagation(); } catch { /* 忽略 */ } };

          return h('div', { className: 'sc-dock', style: dockStyle },
            h('div', {
              className: 'sc-dock-head',
              onPointerDown: onHeadDown,
              onDoubleClick: onHeadDoubleClick,
              title: t('desk.drag'),
            },
            h('b', null, t('desk.title') + ' · ' + items.length),
            h('button', {
              className: 'sc-btn sc-btn-sm',
              type: 'button',
              title: z === 'back' ? t('desk.z.back') : t('desk.z.front'),
              onPointerDown: stopDrag,
              onClick: toggleZ,
            }, z === 'back' ? t('desk.z.backShort') : t('desk.z.frontShort')),
            h('button', {
              className: 'sc-btn sc-btn-sm',
              type: 'button',
              title: t('desk.toolbox'),
              onPointerDown: stopDrag,
              onClick: openPanel,
            }, '＋'),
            h('button', {
              className: 'sc-btn sc-btn-sm',
              type: 'button',
              title: t('desk.collapse'),
              onPointerDown: stopDrag,
              onClick: function () { setCollapsed(true); },
            }, '–')),
            h('div', { className: 'sc-dock-body' }, rows));
        }

        /** 搜索框右侧：放大镜。 */
        function searchGlyph() {
          return h('svg', {
            width: 16, height: 16, viewBox: '0 0 24 24',
            fill: 'none', 'aria-hidden': 'true', focusable: 'false',
          },
          h('circle', {
            cx: 11, cy: 11, r: 8, stroke: 'currentColor', strokeWidth: 2,
            strokeLinecap: 'round', strokeLinejoin: 'round',
          }),
          h('line', {
            x1: 22, y1: 22, x2: 16.65, y2: 16.65, stroke: 'currentColor', strokeWidth: 2,
            strokeLinecap: 'round', strokeLinejoin: 'round',
          }));
        }

        /** 图标：桌面 / 图钉。 */
        function deskIcon(pinned, size) {
          var n = Number(size) > 0 ? Number(size) : 14;
          try {
            if (primitives) {
              var Comp = pinned ? primitives.IconCloseOutlineRegular : primitives.IconPinOutlineRegular;
              if (typeof Comp === 'function') return h(Comp, { size: n });
            }
          } catch { /* 忽略 */ }
          return h('svg', {
            width: n, height: n, viewBox: '0 0 16 16',
            'aria-hidden': 'true', focusable: 'false',
          }, h('path', {
            d: pinned ? 'M4 4l8 8M12 4l-8 8' : 'M6.5 2h3l-.6 3.4 2.6 2.6H4.5l2.6-2.6zM8 8v6',
            fill: 'none', stroke: 'currentColor', 'stroke-width': '1.35',
            'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          }));
        }

        /** 会话行「...」菜单：放到桌面 / 从桌面收回。 */
        function DeskMenuItem(props) {
          try {
            props = props || {};
            var sessionId = props.sessionId;
            var openState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null;
            var setMenuOpen = openState && typeof openState[1] === 'function' ? openState[1] : function () {};
            var pinned = isOnDesk(sessionId);
            var label = pinned ? t('desk.remove') : t('desk.add');

            var onSelect = function () {
              try { setMenuOpen(false); } catch { /* 忽略 */ }
              if (!pinned && deskItems.length >= 12) {
                showToast(t('desk.full'), '', null, 4000);
                return;
              }
              toggleDesk(sessionId, props.displayTitle);
            };

            var Btn = primitives && primitives.MenuItemButton;
            if (typeof Btn === 'function') {
              return h(Btn, { icon: deskIcon(pinned, 14), onSelect: onSelect }, label);
            }
            return h('button', { type: 'button', role: 'menuitem', onClick: onSelect }, label);
          } catch (err) {
            warn('desk menu item render failed', err);
            return null;
          }
        }

        /**
         * 侧边栏面板列表里的图标。
         * 宿主把它塞进 `span.panelGlyph`，并传 `{ size, active }`：这里只画图标，
         * 点击/选中/文案都由侧边栏自己的行按钮负责。
         */
        function StashPanelIcon(props) {
          try {
            props = props || {};
            var n = Number(props.size) > 0 ? Number(props.size) : 16;
            return h('svg', {
              width: n, height: n, viewBox: '0 0 16 16',
              'aria-hidden': 'true', focusable: 'false',
              style: { opacity: props.active ? 1 : 0.82 },
            }, h('path', {
              d: 'M2.5 3.5h11v3h-11zM3.5 6.5h9v6h-9zM6.5 8.5h3',
              fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3',
              'stroke-linejoin': 'round', 'stroke-linecap': 'round',
            }));
          } catch {
            return null;
          }
        }

        /**
         * 设置页：历史遗留修复。
         *
         * 「文件还在但被归档挡住」的会话，是旧版本还原留下的坑；
         * 这里只做「检查 → 用户点确认 → 放回」，不自动处理任何一行。
         */
        function RepairBlock() {
          var listS = React.useState(null);
          var items = listS[0];
          var setItems = listS[1];
          var busyS = React.useState(false);
          var busy = busyS[0];
          var setBusy = busyS[1];
          var noteS = React.useState('');
          var note = noteS[0];
          var setNote = noteS[1];

          var check = function () {
            if (busy) return;
            setBusy(true);
            setNote('');
            requestJson('/session-clean/archived-hidden', { headers: { accept: 'application/json' } })
              .then(function (d) { setItems(Array.isArray(d.items) ? d.items : []); })
              .catch(function (e) { setItems(null); setNote(t('repair.failed') + String(e && e.message ? e.message : e)); })
              .then(function () { setBusy(false); });
          };

          var repair = function (ids) {
            if (busy) return;
            setBusy(true);
            setNote('');
            requestJson('/session-clean/repair-archived', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(ids ? { ids: ids } : {}),
            })
              .then(function (d) {
                setNote(t('repair.done', { n: (d.unarchived || []).length }));
                refreshSessions();
                return check();
              })
              .catch(function (e) { setNote(t('repair.failed') + String(e && e.message ? e.message : e)); })
              .then(function () { setBusy(false); });
          };

          var rows = (items || []).map(function (it) {
            var meta = [it.workspaceTitle || baseName(it.workspace) || '', it.inTrash ? '回收站里也有' : '']
              .filter(Boolean).join(' · ');
            return h('div', { className: 'sc-stash-row', key: it.sessionId },
              h('div', { className: 'sc-stash-main' },
                h('div', { className: 'sc-stash-title', title: it.title || it.sessionId }, it.title || it.sessionId),
                h('div', { className: 'sc-meta' }, meta)),
              h('button', {
                className: 'sc-btn',
                type: 'button',
                disabled: busy || it.inTrash,
                title: it.inTrash ? '这一条在回收站里，先还原再放回' : '',
                onClick: function () { repair([it.sessionId]); },
              }, t('repair.one')));
          });

          return h('div', { className: 'sc-settings-block' },
            h('h4', null, t('repair.title')),
            h('div', { style: { fontSize: 11.5, opacity: 0.66, marginBottom: 9, lineHeight: 1.6 } }, t('repair.desc')),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
              h('button', { className: 'sc-btn', type: 'button', onClick: check, disabled: busy }, t('repair.check')),
              items && items.length
                ? h('button', {
                  className: 'sc-btn primary',
                  type: 'button',
                  disabled: busy,
                  onClick: function () { repair(null); },
                }, t('repair.all', { n: items.length }))
                : null),
            items === null ? null
              : (items.length ? h('div', { className: 'sc-panel-list', style: { marginTop: 10 } }, rows)
                : h('div', { className: 'sc-hint' }, t('repair.empty'))),
            note ? h('div', { className: 'sc-hint' }, note) : null);
        }

        /** 外观设置：配色预设 / 明暗 / 密度 / 动效强度。所有选择持久化并同步给浮窗。 */
        function AppearanceBlock() {
          var prefs = useThemePrefs();
          var presets = ['fog', 'mint', 'rose'];
          var motions = [
            ['full', '完整'],
            ['soft', '轻柔'],
            ['off', '关闭'],
            ['auto', '跟随系统'],
          ];
          var labelStyle = { fontSize: 11.5, color: 'var(--sc-dim)', minWidth: 34 };
          var rowStyle = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 };

          return h('div', { className: 'sc-settings-block' },
            h('h4', null, '外观'),
            h('div', { style: rowStyle },
              h('span', { style: labelStyle }, '配色'),
              h('div', { className: 'sc-swatches' }, presets.map(function (key) {
                var pal = (THEMES[key] || {}).dark || {};
                return h('button', {
                  key: key,
                  type: 'button',
                  className: 'sc-swatch',
                  title: (THEMES[key] || {}).label || key,
                  'aria-label': (THEMES[key] || {}).label || key,
                  'aria-pressed': prefs.preset === key ? 'true' : 'false',
                  style: { background: 'linear-gradient(135deg,' + (pal.acc || '#9BAEE8') + ',' + (pal.acc2 || '#B5A6D8') + ')' },
                  onClick: function () { setThemePrefs({ preset: key }); },
                });
              }))),
            h('div', { style: rowStyle },
              h('span', { style: labelStyle }, '明暗'),
              h('button', {
                className: 'sc-btn sc-btn-sm' + (prefs.mode === 'dark' ? ' primary' : ''),
                type: 'button',
                onClick: function () { setThemePrefs({ mode: 'dark' }); },
              }, '深色'),
              h('button', {
                className: 'sc-btn sc-btn-sm' + (prefs.mode === 'light' ? ' primary' : ''),
                type: 'button',
                onClick: function () { setThemePrefs({ mode: 'light' }); },
              }, '浅色')),
            h('div', { style: rowStyle },
              h('span', { style: labelStyle }, '密度'),
              h('button', {
                className: 'sc-btn sc-btn-sm' + (prefs.density === 'comfortable' ? ' primary' : ''),
                type: 'button',
                onClick: function () { setThemePrefs({ density: 'comfortable' }); },
              }, '舒适'),
              h('button', {
                className: 'sc-btn sc-btn-sm' + (prefs.density === 'compact' ? ' primary' : ''),
                type: 'button',
                onClick: function () { setThemePrefs({ density: 'compact' }); },
              }, '紧凑')),
            h('div', { style: rowStyle },
              h('span', { style: labelStyle }, '动效'),
              motions.map(function (pair) {
                return h('button', {
                  key: pair[0],
                  className: 'sc-btn sc-btn-sm' + (prefs.motion === pair[0] ? ' primary' : ''),
                  type: 'button',
                  onClick: function () { setThemePrefs({ motion: pair[0] }); },
                }, pair[1]);
              })),
            h('div', { style: rowStyle },
              h('span', { style: labelStyle }, '名称'),
              h('input', {
                type: 'text',
                value: prefs.windowTitle || '',
                maxLength: 24,
                placeholder: 'DSH 当前对话',
                style: {
                  flex: '1 1 160px',
                  minWidth: 140,
                  padding: '5px 9px',
                  borderRadius: 'var(--sc-r-sm)',
                  border: '1px solid var(--sc-border)',
                  background: 'var(--sc-surface)',
                  color: 'var(--sc-text)',
                  fontSize: 12.5,
                  outline: 'none',
                },
                onChange: function (e) { setThemePrefs({ windowTitle: String(e.target.value || '').slice(0, 24) }); },
              })),
            h('div', { className: 'sc-hint' }, '配色 / 密度 / 动效 / 名称都会同步到桌面浮窗。'));
        }

        /** 桌面浮窗开关：状态 + 显示/隐藏/重启（走宿主 /session-clean/desk-window）。 */
        function DeskWindowBlock() {
          var stS = React.useState(null);
          var st = stS[0];
          var setSt = stS[1];
          var busyS = React.useState('');
          var busy = busyS[0];
          var setBusy = busyS[1];
          var errS = React.useState('');
          var err = errS[0];
          var setErr = errS[1];

          var load = function () {
            fetch('/session-clean/desk-window', { method: 'GET' })
              .then(function (r) { return r.json(); })
              .then(function (d) { setSt(d || null); setErr(''); }, function () { setErr('读取浮窗状态失败'); });
          };

          if (typeof React.useEffect === 'function') {
            React.useEffect(function () {
              load();
              var id = setInterval(load, 3000);
              return function () { clearInterval(id); };
            }, []);
          }

          var act = function (action) {
            setBusy(action);
            fetch('/session-clean/desk-window', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: action }),
            }).then(function (r) { return r.json(); }).then(function (d) {
              setSt(d || null);
              setBusy('');
            }, function () {
              setBusy('');
              setErr('操作失败，可用命令行兜底');
            });
          };

          var running = Boolean(st && st.running);
          var visible = Boolean(st && st.window);
          var stateText = running ? (visible ? '运行中' : '进程在，窗口不可见') : '未运行';

          return h('div', { className: 'sc-settings-block' },
            h('h4', null, '桌面浮窗'),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 } },
              h('span', { className: 'sc-status-dot' + (running ? ' running' : ''), 'aria-hidden': 'true' }),
              h('span', { style: { fontSize: 12.5 } }, stateText),
              st && st.title ? h('span', { style: { fontSize: 11.5, color: 'var(--sc-dim)' } }, '· ' + st.title) : null,
              st && st.pids && st.pids.length ? h('span', { style: { fontSize: 11, color: 'var(--sc-dim)' } }, 'pid ' + st.pids.join(',')) : null),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', {
                className: 'sc-btn sc-btn-sm' + (running ? '' : ' primary'),
                type: 'button',
                disabled: Boolean(busy),
                onClick: function () { act('start'); },
              }, busy === 'start' ? '启动中…' : '显示'),
              h('button', {
                className: 'sc-btn sc-btn-sm',
                type: 'button',
                disabled: Boolean(busy) || !running,
                onClick: function () { act('stop'); },
              }, busy === 'stop' ? '关闭中…' : '隐藏'),
              h('button', {
                className: 'sc-btn sc-btn-sm',
                type: 'button',
                disabled: Boolean(busy),
                onClick: function () { act('restart'); },
              }, busy === 'restart' ? '重启中…' : '重启')),
            err ? h('div', { className: 'sc-hint' }, err) : null,
            h('div', { className: 'sc-hint' }, '命令行兜底：scripts\\desk-ctl.ps1 start|stop|restart|toggle|status'));
        }

        /** 设置页里的通知开关：总开关 + 系统通知权限 + 测试。 */
        function NotifySettings() {
          var on = useNotifyPref();
          var permS = React.useState(notificationPermission());
          var perm = permS[0];
          var setPerm = permS[1];
          var noteS = React.useState('');
          var note = noteS[0];
          var setNote = noteS[1];

          var askPerm = function () {
            requestNotifyPermission().then(function (p) {
              setPerm(p);
              setNote(p === 'granted'
                ? t('notify.granted')
                : (p === 'unsupported' ? t('notify.unsupported') : t('notify.denied')));
            });
          };

          var test = function () {
            var id = currentSessionId();
            var title = sessionTitleOf(id) || t('notify.doneTitle');
            var body = t('notify.doneBody', { title: title });
            var open = function () { openSessionById(id); };
            var sent = systemNotify(t('notify.doneTitle') + ' · ' + title, body, open);
            showToast(t('notify.doneTitle') + ' · ' + title, body, open, 6000);
            setNote(sent ? t('notify.granted') : t('notify.denied'));
          };

          return h('div', { className: 'sc-settings-block' },
            h('h4', null, t('notify.title')),
            h('div', { style: { fontSize: 11.5, opacity: 0.66, marginBottom: 9, lineHeight: 1.6 } }, t('notify.desc')),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
              h('button', {
                className: on ? 'sc-btn primary' : 'sc-btn',
                type: 'button',
                onClick: function () { setNotifyPref(!on); },
              }, on ? t('notify.on') : t('notify.off')),
              h('button', { className: 'sc-btn', type: 'button', onClick: askPerm }, t('notify.perm')),
              h('button', { className: 'sc-btn', type: 'button', onClick: test }, t('notify.test')),
              h('span', { style: { fontSize: 11, opacity: 0.55 } }, 'permission: ' + String(perm))),
            note ? h('div', { className: 'sc-hint' }, note) : null);
        }

        /** 设置页分区：一次只渲染一个 Pane，避免两处同时请求。 */
        function SettingsSection() {
          var tabS = React.useState('sessions');
          var tab = tabS[0];
          var setTab = tabS[1];
          return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
            h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '会话管理'),
            h('div', { style: { opacity: 0.7, fontSize: 12, marginBottom: 10 } },
              '删除的会话先进回收站，可随时还原；导出会把选中的会话抽成独立文件；隔离区用来把正在用的对话单独放一边。'),
            h(AppearanceBlock),
            h(DeskWindowBlock),
            h(NotifySettings),
            h(RepairBlock),
            h('div', { className: 'sc-tabs', style: { marginBottom: 10 } },
              h('button', { className: tab === 'sessions' ? 'sc-btn primary' : 'sc-btn', type: 'button', onClick: function () { setTab('sessions'); } }, t('panel.tab.sessions')),
              h('button', { className: tab === 'trash' ? 'sc-btn primary' : 'sc-btn', type: 'button', onClick: function () { setTab('trash'); } }, t('panel.tab.trash'))),
            tab === 'sessions' ? h(SessionsPane) : h(TrashPane));
        }

        SessionsPane.displayName = 'SessionsPane';
        TrashPane.displayName = 'TrashPane';
        SessionPanel.displayName = 'SessionPanel';
        SidebarButton.displayName = 'SidebarButton';
        SettingsSection.displayName = 'SettingsSection';
        NotifySettings.displayName = 'NotifySettings';
        AppearanceBlock.displayName = 'AppearanceBlock';
        DeskWindowBlock.displayName = 'DeskWindowBlock';
        StashMenuItem.displayName = 'StashMenuItem';
        TrashMenuItem.displayName = 'TrashMenuItem';
        DeskMenuItem.displayName = 'DeskMenuItem';
        DeskDock.displayName = 'DeskDock';
        StashRowButton.displayName = 'StashRowButton';
        StashPanel.displayName = 'StashPanel';
        StashPanelIcon.displayName = 'StashPanelIcon';

        // ------------------------------------------------------------ 注册
        info('apply() entered');

        // 1) 侧边栏底部按钮
        try {
          ctx.slots.inject('sidebar.footer.action', function () {
            try {
              ctx.slots.register({
                name: 'sidebar.footer.action',
                id: NS + '.toggle',
                order: 40,
                label: t('panel.title'),
                locale: NS,
              }, SidebarButton);
              info('sidebar.footer.action registered');
            } catch (err) {
              warn('footer action register failed', err);
            }
          });
        } catch (err) {
          warn('footer action inject failed', err);
        }

        // 2) 浮层面板
        try {
          ctx.slots.inject('shell.overlay', function () {
            try {
              ctx.slots.register({
                name: 'shell.overlay',
                id: NS + '.panel',
                order: 60,
                locale: NS,
              }, SessionPanel);
              info('shell.overlay registered');
            } catch (err) {
              warn('overlay register failed', err);
            }
            // 应用内浮条已停用：桌面清单只由外部常驻浮窗呈现（避免同一份内容出现两次）。
            // desk store / 桥接 / 菜单项都保留，外部浮窗照常工作。
          });
        } catch (err) {
          warn('overlay inject failed', err);
        }

        // 3) 设置页分区（保留原有入口）
        try {
          ctx.slots.inject('settings.section', function () {
            try {
              ctx.slots.register({
                name: 'settings.section',
                id: NS + '.trash',
                order: 900,
                label: function () { return t('panel.title'); },
                locale: NS,
              }, SettingsSection);
              info('settings.section registered');
            } catch (err) {
              warn('settings section register failed', err);
            }
          });
        } catch (err) {
          warn('settings section inject failed', err);
        }

        // 4) 会话行「...」菜单：隔离 / 放回、移入回收站
        //
        // 这个槽位是 sidebar.workspaces 的**子表**（parent entry's children table），
        // 必须用 slots.inject 等它声明出来再 register；直接 register 会抛
        //   "slot ... is not declared"。
        try {
          ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
            try {
              ctx.slots.register({
                name: 'sidebar.workspaces.session.menu.item',
                id: NS + '.desk',
                order: 470,
                locale: NS,
              }, DeskMenuItem);
              info('session menu item (desk) registered');
            } catch (err) {
              warn('desk menu item register failed', err);
            }
            try {
              ctx.slots.register({
                name: 'sidebar.workspaces.session.menu.item',
                id: NS + '.stash',
                order: 500,
                locale: NS,
              }, StashMenuItem);
              info('session menu item (stash) registered');
            } catch (err) {
              warn('stash menu item register failed', err);
            }
            try {
              ctx.slots.register({
                name: 'sidebar.workspaces.session.menu.item',
                id: NS + '.trash',
                order: 510,
                locale: NS,
              }, TrashMenuItem);
              info('session menu item (trash) registered');
            } catch (err) {
              warn('trash menu item register failed', err);
            }
          });
        } catch (err) {
          warn('session menu inject failed', err);
        }

        // 5) 会话行悬停小按钮：隔离 / 放回（一个图标按钮）
        try {
          ctx.slots.inject('sidebar.workspaces.session.row.action', function () {
            try {
              ctx.slots.register({
                name: 'sidebar.workspaces.session.row.action',
                id: NS + '.stash-row',
                order: 300,
                locale: NS,
              }, StashRowButton);
              info('session row action registered');
            } catch (err) {
              warn('row action register failed', err);
            }
          });
        } catch (err) {
          warn('row action inject failed', err);
        }

        // 6) 隔离区：独立一屏（main keyed）+ 侧边栏面板图标（sidebar.panellist）
        try {
          ctx.slots.inject('main', function () {
            try {
              ctx.slots.register({
                name: 'main',
                key: NS + '.stash',
                locale: NS,
              }, StashPanel);
              info('main panel registered');
            } catch (err) {
              warn('main panel register failed', err);
            }
          });
        } catch (err) {
          warn('main panel inject failed', err);
        }
        try {
          ctx.slots.inject('sidebar.panellist', function () {
            try {
              ctx.slots.register({
                name: 'sidebar.panellist',
                id: NS + '.stash',
                order: 20,
                locale: NS,
                label: function () { return t('stash.panel'); },
              }, StashPanelIcon);
              info('sidebar.panellist registered');
            } catch (err) {
              warn('panellist register failed', err);
            }
          });
        } catch (err) {
          warn('panellist inject failed', err);
        }

        // 7) 回合完成通知（只读 sessions.list 快照）
        try {
          ctx.inject(['sessions'], function () {
            try {
              installTurnWatcher();
            } catch (err) {
              warn('turn watcher install failed', err);
            }
          });
        } catch (err) {
          warn('turn watcher inject failed', err);
          try { installTurnWatcher(); } catch { /* 最后再试一次 */ }
        }

        // 8) 全局快捷键：Alt+K 开关会话跳板（宿主的 Mod+K 已经占了会话搜索）
        try {
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            ctx.effect(function () {
              var onKey = function (e) {
                if (!e || !e.altKey || e.ctrlKey || e.metaKey) return;
                if (String(e.key || '').toLowerCase() !== 'k') return;
                try { e.preventDefault(); } catch { /* 忽略 */ }
                setOpen(!getOpen());
              };
              document.addEventListener('keydown', onKey, true);
              return function () {
                try { document.removeEventListener('keydown', onKey, true); } catch { /* 忽略 */ }
              };
            }, NS + ': Alt+K');
            info('Alt+K bound');
          }
        } catch (err) {
          warn('shortcut binding failed', err);
        }

        // 9) 桌面浮条桥：同步清单给宿主 + 轮询外部小窗的动作队列
        try {
          startDeskBridge();
          info('desk bridge started');
        } catch (err) {
          warn('desk bridge start failed', err);
        }

        // 10) 给页面留一个入口（调试 / 以后宿主侧 executeJavaScript 用）
        try {
          if (typeof window !== 'undefined') {
            window.__dshSessionClean = {
              build: BUILD,
              open: function (sessionId) { openSessionSmart(sessionId, deskTitleOf(sessionId)); },
              desk: function () { return deskItems.slice(); },
              addDesk: function (sessionId, title) { addDesk(sessionId, title); },
              removeDesk: function (sessionId) { removeDesk(sessionId); },
              openPanel: function () { setOpen(true); },
            };
          }
        } catch { /* 忽略 */ }

        // 11) 向宿主报到：宿主 /session-clean/probe 里能看到这次页面加载的 build
        try {
          fetch('/session-clean/client-hello', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              build: BUILD,
              at: Date.now(),
              href: String((typeof location !== 'undefined' && location.href) || '').slice(0, 90),
              ua: String((typeof navigator !== 'undefined' && navigator.userAgent) || '').slice(0, 60),
            }),
          }).catch(function () { /* 忽略 */ });
          info('client build reported: ' + BUILD);
        } catch { /* 忽略 */ }
      } catch (err) {
        // 最后一道防线：整个 UI 初始化失败也绝不让宿主崩。
        try { console.error('[' + NS + '] client apply failed', err); } catch { /* ignore */ }
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
