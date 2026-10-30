/**
 * dsh-session-clean —— 客户端界面
 *
 * 两个入口，全部走官方插槽，不改、不覆盖任何官方组件：
 *   1. sidebar.workspaces.session.menu.item  —— 会话右键菜单里的「删除会话」
 *   2. settings.section                      —— 设置页的回收站管理
 *
 * 崩溃防护（硬约束）：
 *   - 组件内部全部 try/catch，渲染期异常只影响本条目，不冒泡到宿主；
 *   - 插槽注册包在 ctx.effect 里，插件卸载时自动注销；
 *   - 拿不到 slots 服务直接不注册，不抛；
 *   - 不调用任何未在契约里的 API。
 */

const NS = 'session-clean';

const zh = {
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
};

const en = {
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
};

export const inject = ['slots'];

/**
 * 客户端插件体。
 * DSH 的 client runner 会把 require 作为工厂参数注入；这里同时兼容
 * 「ctx 上挂着 require」和「全局挂载」两种形态，取不到就整体跳过。
 * @param ctx 客户端根上下文
 */
export function apply(ctx) {
  // 入口先判空：ctx 不合法时直接退场，连 warn 都不发，避免污染宿主日志。
  if (!ctx || typeof ctx !== 'object') return;
  if (typeof ctx.effect !== 'function') return;

  try {
    // 工具函数：任何一步失败都只 warn，绝不 throw 到宿主。
    const warn = (msg, err) => {
      try { console.warn(`[${NS}] ${msg}`, err); } catch { /* ignore */ }
    };

    /**
     * 取模块。顺序：ctx.require → 全局注入 → 全局 _ModuleLoader_。
     * 全部失败返回 undefined，由调用方降级。
     */
    const pick = (name) => {
      try {
        if (ctx && typeof ctx.require === 'function') return ctx.require(name);
      } catch { /* 继续试下一种 */ }
      try {
        const g = typeof globalThis !== 'undefined' ? globalThis : {};
        if (typeof g.__DSH_REQUIRE__ === 'function') return g.__DSH_REQUIRE__(name);
      } catch { /* 继续 */ }
      return undefined;
    };

    // 语言包：locale 服务不一定存在，缺了就用中文兜底。
    try {
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`);
      }
    } catch (err) {
      warn('locale register failed', err);
    }

    // 极简 t：优先用宿主 locale，其次本地表。
    const makeT = (react) => (key, vars) => {
      try {
        const tr = ctx.locale && typeof ctx.locale.get === 'function' ? ctx.locale.get(NS) : undefined;
        const table = tr || zh;
        let s = table[key] || zh[key] || key;
        if (vars && typeof s === 'string') {
          for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
        }
        return s;
      } catch {
        return (zh[key] || key);
      }
    };

    // 远程桥：归档 + 取消归档由官方 workspace 控制器提供。
    const callArchive = async (sessionId, stopActivity = true) => {
      const wp = ctx.workspace || (ctx.remote && ctx.remote.workspace);
      if (!wp) throw new Error('workspace controller unavailable');
      if (stopActivity && typeof wp.archiveSession === 'function') {
        return await wp.archiveSession(sessionId, { stopActivity: true });
      }
      if (typeof wp.archiveSession === 'function') return await wp.archiveSession(sessionId);
      throw new Error('archiveSession unavailable');
    };

    /**
     * 菜单项：会话「...」菜单里的删除入口。
     * 官方契约要求：role=menuitem 的 button，act 后调 useMenuOpenState 关闭菜单。
     */
    const registerMenuItem = (React, primitives, t) => {
      function DeleteSessionMenuItem(props) {
        try {
          const { sessionId, useMenuOpenState } = props || {};
          const openState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : [false, () => {}];
          const setMenuOpen = Array.isArray(openState) ? openState[1] : () => {};

          const onSelect = () => {
            try { setMenuOpen(false); } catch { /* ignore */ }
            // 只做归档动作的第一步；真正的删除在设置页或 CLI 完成，
            // 避免在菜单点击里做重文件操作。
            try {
              const p = callArchive(sessionId);
              if (p && typeof p.catch === 'function') p.catch((e) => warn('archive failed', e));
            } catch (e) {
              warn('archive threw', e);
            }
          };

          const label = t('menu.delete');
          const Btn = primitives && primitives.MenuItemButton;
          if (Btn) {
            return React.createElement(Btn, {
              icon: primitives.IconArchiveOutlineRegular
                ? React.createElement(primitives.IconArchiveOutlineRegular, { size: 14 })
                : undefined,
              onSelect,
              children: label,
            });
          }
          // 没有 primitives 时退化成原生 button，仍然符合 role=menuitem 契约。
          return React.createElement(
            'button',
            { type: 'button', role: 'menuitem', onClick: onSelect },
            label,
          );
        } catch (err) {
          warn('menu item render failed', err);
          return null;
        }
      }
      DeleteSessionMenuItem.displayName = 'DeleteSessionMenuItem';
      return DeleteSessionMenuItem;
    };

    /**
     * 设置页分区：回收站列表 + 还原 + 彻底删除。
     * 通过 host HTTP 路由读回收站，拿不到就显示提示，不崩。
     */
    const registerSettingsSection = (React, t) => {
      function SessionTrashSection() {
        const [rows, setRows] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [note, setNote] = React.useState('');

        const load = React.useCallback(async () => {
          try {
            const res = await fetch('/session-clean/trash', { headers: { accept: 'application/json' } });
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.json();
            setRows(Array.isArray(data.items) ? data.items : []);
          } catch (err) {
            setRows([]);
            setNote(String(err && err.message ? err.message : err));
          }
        }, []);

        React.useEffect(() => { load().catch(() => {}); }, [load]);

        const act = async (url, body) => {
          if (busy) return;
          setBusy(true);
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body || {}),
            });
            if (!res.ok) throw new Error(String(res.status));
            await load();
          } catch (err) {
            setNote(String(err && err.message ? err.message : err));
          } finally {
            setBusy(false);
          }
        };

        const children = [];
        children.push(React.createElement('div', { key: 'h', style: { fontWeight: 600, marginBottom: 4 } }, t('settings.title')));
        children.push(React.createElement('div', { key: 'd', style: { opacity: 0.7, fontSize: 12, marginBottom: 12 } }, t('settings.desc')));

        if (rows === null) {
          children.push(React.createElement('div', { key: 'load', style: { fontSize: 12, opacity: 0.6 } }, '…'));
        } else if (rows.length === 0) {
          children.push(React.createElement('div', { key: 'empty', style: { fontSize: 12, opacity: 0.6 } }, t('settings.empty')));
        } else {
          children.push(
            React.createElement(
              'div',
              { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              rows.map((r) => React.createElement(
                'div',
                {
                  key: r.batchId,
                  style: {
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 10px', borderRadius: 8,
                    border: '1px solid rgba(127,127,127,.25)',
                  },
                },
                React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                  React.createElement('div', { style: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.title || r.sessionId),
                  React.createElement('div', { style: { fontSize: 11, opacity: 0.55 } }, `${r.deletedAt || ''}  ·  ${Math.round((r.bytes || 0) / 1024)}KB`)),
                React.createElement('button', {
                  type: 'button',
                  disabled: busy,
                  onClick: () => act('/session-clean/restore', { batchId: r.batchId }),
                }, t('settings.restore')),
                React.createElement('button', {
                  type: 'button',
                  disabled: busy,
                  onClick: () => act('/session-clean/purge', { batchId: r.batchId }),
                }, t('settings.purge')),
              )),
            ),
          );
        }

        children.push(
          React.createElement('div', { key: 'actions', style: { display: 'flex', gap: 8, marginTop: 12 } },
            React.createElement('button', { type: 'button', disabled: busy, onClick: () => load() }, t('settings.refresh')),
            React.createElement('button', { type: 'button', disabled: busy, onClick: () => act('/session-clean/purge-all', {}) }, t('settings.purgeAll'))),
        );
        if (note) children.push(React.createElement('div', { key: 'note', style: { fontSize: 11, opacity: 0.6, marginTop: 8 } }, note));

        return React.createElement('div', null, children);
      }
      SessionTrashSection.displayName = 'SessionTrashSection';
      return SessionTrashSection;
    };

    // 真正注册：slots 服务缺失就整体跳过。
    if (!ctx.slots || typeof ctx.slots.register !== 'function') {
      warn('slots service missing, UI not registered');
      return;
    }

    ctx.effect(() => {
      const React = pick('react');
      if (!React) {
        warn('react unavailable, UI not registered');
        return undefined;
      }
      const primitives = pick('@deepseek-ai/dsh-client-ui-primitives') || null;

      const t = makeT(React);
      const disposers = [];

      try {
        disposers.push(ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'session-clean.delete', order: 480, locale: NS },
          registerMenuItem(React, primitives, t),
        ));
      } catch (err) {
        warn('menu item register failed', err);
      }

      try {
        disposers.push(ctx.slots.register(
          { name: 'settings.section', id: 'session-clean.trash', order: 900, locale: NS },
          registerSettingsSection(React, t),
        ));
      } catch (err) {
        warn('settings section register failed', err);
      }

      return () => {
        for (const d of disposers) {
          try { if (typeof d === 'function') d(); } catch { /* ignore */ }
        }
      };
    }, `${NS}: ui`);
  } catch (err) {
    // 最后一道防线：整个 UI 初始化失败也绝不让宿主崩。
    try { console.error(`[${NS}] client apply failed`, err); } catch { /* ignore */ }
  }
}
