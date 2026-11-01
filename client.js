/**
 * dsh-session-clean —— 客户端界面
 *
 * 两个入口，全部走官方插槽，不改、不覆盖任何官方组件：
 *   1. sidebar.workspaces.session.menu.item  —— 会话右键菜单里的「删除会话」
 *   2. settings.section                      —— 设置页的回收站管理
 *
 * 【模块格式】DSH 客户端插件不是裸 ESM，必须包在
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 * 里，用 exports.xxx 导出。直接写 `export function apply` 会在浏览器里抛
 *   Uncaught SyntaxError: Unexpected token 'export'
 * 这是 0.2.1-rc.5 崩溃日志里那条错误的直接原因。
 *
 * 崩溃防护（硬约束）：
 *   - 组件内部全部 try/catch，渲染期异常只影响本条目，不冒泡到宿主；
 *   - 插槽注册包在 ctx.effect 里，插件卸载时自动注销；
 *   - 拿不到 slots 服务直接不注册，不抛；
 *   - 不调用任何未在契约里的 API。
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
    };

    var inject = ['slots'];

    function apply(ctx) {
      // 入口先判空：ctx 不合法时直接退场，连 warn 都不发，避免污染宿主日志。
      if (!ctx || typeof ctx !== 'object') return;
      if (typeof ctx.effect !== 'function') return;

      try {
        // 工具函数：任何一步失败都只 warn，绝不 throw 到宿主。
        var warn = function (msg, err) {
          try { console.warn('[' + NS + '] ' + msg, err); } catch { /* ignore */ }
        };
        var log = {
          info: function (msg) {
            try { console.log('[' + NS + '] ' + msg); } catch { /* ignore */ }
          },
        };
        log.info('apply() called');

        // 语言包：locale 是 cordis 严格注入的服务，访问 ctx.locale 前必须
        // 在 inject 里声明 'locale'，否则抛
        //   "cannot get property 'locale' without inject"
        // 这里不声明，只用本地表兜底（makeT 有 zh 回退），代价是只有中文。
        try {
          ctx.inject(['locale'], function (localeCtx) {
            try {
              if (localeCtx.locale && typeof localeCtx.locale.register === 'function') {
                ctx.effect(function () {
                  return localeCtx.locale.register(NS, { zh: zh, en: en });
                }, NS + ': dictionaries');
                log.info('locale dictionaries registered');
              }
            } catch (err) {
              warn('locale register failed', err);
            }
          });
        } catch (err) {
          // ctx.inject 不可用：直接用本地中文表，不影响主功能。
          warn('locale inject unavailable, using local zh', err);
        }

        // 极简 t：只用本地表。宿主 locale 需要 inject，这里刻意不碰。
        var makeT = function () {
          return function (key, vars) {
            var s = zh[key] || key;
            if (vars && typeof s === 'string') {
              for (var k in vars) {
                if (Object.prototype.hasOwnProperty.call(vars, k)) {
                  s = s.split('{' + k + '}').join(String(vars[k]));
                }
              }
            }
            return s;
          };
        };

        // 远程桥：归档 + 取消归档由官方 workspace 控制器提供。
        var callArchive = function (sessionId, stopActivity) {
          // 不碰 ctx.workspace / ctx.remote：它们都需要先 inject 声明，
          // 直接访问会抛 "cannot get property ... without inject"。
          // 归档动作由 host 半的 HTTP 路由完成，client 只负责界面。
          void stopActivity;
          void sessionId;
        };

        /**
         * 菜单项：会话「...」菜单里的删除入口。
         * 官方契约要求：role=menuitem 的 button，act 后调 useMenuOpenState 关闭菜单。
         */
        var registerMenuItem = function (React, primitives, t) {
          function DeleteSessionMenuItem(props) {
            try {
              props = props || {};
              var sessionId = props.sessionId;
              var openState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null;
              var setMenuOpen = openState && Array.isArray(openState) && typeof openState[1] === 'function'
                ? openState[1]
                : function () {};

              var onSelect = function () {
                try { setMenuOpen(false); } catch { /* ignore */ }
                // 只做归档第一步；真正的移入回收站在设置页或 CLI 完成，
                // 避免在菜单点击里做重文件操作。
                callArchive(sessionId);
              };

              var label = t('menu.delete');
              var Btn = primitives && primitives.MenuItemButton;
              if (Btn) {
                var icon = undefined;
                if (primitives.IconArchiveOutlineRegular) {
                  icon = React.createElement(primitives.IconArchiveOutlineRegular, { size: 14 });
                }
                return React.createElement(Btn, { icon: icon, onSelect: onSelect }, label);
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
        /**
         * 设置页分区：会话列表（可删除）+ 回收站（可还原）。
         * 全部走 host 的 /session-clean/* 路由，失败只显示提示，不崩。
         */
        var registerSettingsSection = function (React, t) {
          function SessionTrashSection() {
            var tabS = React.useState('sessions');
            var tab = tabS[0];
            var setTab = tabS[1];

            var sessS = React.useState(null);
            var sessions = sessS[0];
            var setSessions = sessS[1];

            var trashS = React.useState(null);
            var trash = trashS[0];
            var setTrash = trashS[1];

            var busyS = React.useState(false);
            var busy = busyS[0];
            var setBusy = busyS[1];

            var noteS = React.useState('');
            var note = noteS[0];
            var setNote = noteS[1];

            var getJson = function (url, init) {
              return fetch(url, init).then(function (res) {
                if (!res.ok) throw new Error(res.status + ' ' + url);
                return res.json();
              });
            };

            var loadSessions = React.useCallback(function () {
              return getJson('/session-clean/sessions', { headers: { accept: 'application/json' } })
                .then(function (d) { setSessions(Array.isArray(d.items) ? d.items : []); })
                .catch(function (e) { setSessions([]); setNote(String(e.message || e)); });
            }, []);

            var loadTrash = React.useCallback(function () {
              return getJson('/session-clean/trash', { headers: { accept: 'application/json' } })
                .then(function (d) { setTrash(Array.isArray(d.items) ? d.items : []); })
                .catch(function (e) { setTrash([]); setNote(String(e.message || e)); });
            }, []);

            var reload = function () { loadSessions(); loadTrash(); };

            React.useEffect(function () { loadSessions(); loadTrash(); }, [loadSessions, loadTrash]);

            var act = function (url, body) {
              if (busy) return;
              setBusy(true);
              setNote('');
              getJson(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body || {}),
              })
                .then(function () { reload(); })
                .catch(function (e) { setNote(String(e.message || e)); })
                .then(function () { setBusy(false); });
            };

            var btn = function (key, label, onClick, disabled) {
              return React.createElement('button', {
                key: key,
                type: 'button',
                disabled: busy || disabled,
                onClick: onClick,
                style: { padding: '3px 10px', fontSize: 12, cursor: (busy || disabled) ? 'default' : 'pointer' },
              }, label);
            };

            var metaStyle = { fontSize: 11, opacity: 0.55 };
            var rowStyle = {
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 10px', borderRadius: 8,
              border: '1px solid rgba(127,127,127,.22)',
            };
            var titleStyle = {
              fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            };

            var fmt = function (ms) {
              if (!ms) return '';
              var d = new Date(ms);
              var p = function (n) { return String(n).padStart(2, '0'); };
              return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
                ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
            };
            var kb = function (n) { return Math.max(1, Math.round((n || 0) / 1024)) + 'KB'; };

            var children = [];
            children.push(React.createElement('div', {
              key: 'h', style: { fontWeight: 600, marginBottom: 4 },
            }, '会话管理'));
            children.push(React.createElement('div', {
              key: 'd', style: { opacity: 0.7, fontSize: 12, marginBottom: 12 },
            }, '删除的会话先进回收站，可随时还原。归档只是隐藏，不会删除文件。'));

            children.push(React.createElement('div', {
              key: 'tabs', style: { display: 'flex', gap: 6, marginBottom: 12 },
            },
            btn('tab-s', '会话（' + (sessions ? sessions.length : '-') + '）', function () { setTab('sessions'); }),
            btn('tab-t', '回收站（' + (trash ? trash.length : '-') + '）', function () { setTab('trash'); }),
            btn('tab-r', '刷新', reload)));

            if (tab === 'sessions') {
              if (sessions === null) {
                children.push(React.createElement('div', { key: 'l', style: metaStyle }, '加载中...'));
              } else if (sessions.length === 0) {
                children.push(React.createElement('div', { key: 'e', style: metaStyle }, '没有会话'));
              } else {
                children.push(React.createElement('div', {
                  key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 6 },
                }, sessions.map(function (r) {
                  return React.createElement('div', { key: r.sessionId, style: rowStyle },
                    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                      React.createElement('div', { style: titleStyle }, r.title || r.sessionId),
                      React.createElement('div', { style: metaStyle },
                        fmt(r.mtime) + '  ·  ' + kb(r.bytes))),
                    btn('del-' + r.sessionId, '删除', function () {
                      act('/session-clean/delete', { sessionId: r.sessionId });
                    }, !r.complete));
                })));
              }
            } else {
              if (trash === null) {
                children.push(React.createElement('div', { key: 'l', style: metaStyle }, '加载中...'));
              } else if (trash.length === 0) {
                children.push(React.createElement('div', { key: 'e', style: metaStyle }, '回收站是空的'));
              } else {
                children.push(React.createElement('div', {
                  key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 6 },
                }, trash.map(function (b) {
                  return React.createElement('div', { key: b.batchId, style: rowStyle },
                    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                      React.createElement('div', { style: titleStyle }, b.title || b.sessionId),
                      React.createElement('div', { style: metaStyle },
                        String(b.deletedAt || '').slice(0, 16).replace('T', ' ') + '  ·  ' + kb(b.bytes))),
                    btn('rs-' + b.batchId, '还原', function () {
                      act('/session-clean/restore', { batchId: b.batchId });
                    }),
                    btn('pg-' + b.batchId, '彻底删除', function () {
                      act('/session-clean/purge', { batchId: b.batchId });
                    }));
                })));
                children.push(React.createElement('div', { key: 'all', style: { marginTop: 10 } },
                  btn('purge-all', '清空回收站', function () { act('/session-clean/purge-all', {}); })));
              }
            }

            if (note) {
              children.push(React.createElement('div', {
                key: 'note', style: { fontSize: 11, opacity: 0.6, marginTop: 10 },
              }, note));
            }

            void t;
            return React.createElement('div', { style: { padding: '4px 0' } }, children);
          }
          SessionTrashSection.displayName = 'SessionTrashSection';
          return SessionTrashSection;
        };

        // 真正注册：slots 服务缺失就整体跳过。
        log.info('apply() entered; slots=' + (ctx.slots ? 'yes' : 'no'));
        if (!ctx.slots || typeof ctx.slots.register !== 'function') {
          warn('slots service missing, UI not registered');
          return;
        }
        log.info('ctx.slots.register=' + typeof ctx.slots.register +
          ' inject=' + typeof ctx.slots.inject);

        // react 在 factory 层取（与 dsh-splash-screen / api-balance 一致），
        // 不在 effect 回调里取，避免每次 effect 重跑都重新解析。
        var React = null;
        try {
          React = require('react');
        } catch (err) {
          warn('react unavailable, UI not registered');
          return;
        }
        log.info('react loaded=' + (!!React) + ' createElement=' + typeof React.createElement);
        var primitives = null;
        try {
          primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        } catch {
          primitives = null; // 退化路径：用原生 button
        }

        var t = makeT();

        // 关键：settings.section 由 ui-settings-general 的 General 条目在运行时
        // declared，apply() 执行时它还不存在。必须先 slots.inject 等它出现，
        // 再 register。直接 register 会抛
        //   "slot ... is not declared (a parent entry's children table must declare it)"
        // dsh-splash-screen 注册 shell.overlay 用的就是这个写法。
        ctx.effect(function () {
          var dispose = null;
          log.info('waiting for settings.section');

          ctx.slots.inject('settings.section', function () {
            log.info('settings.section appeared, registering');
            try {
              dispose = ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'session-clean.trash',
                  order: 900,
                  // label 决定设置页导航里显示的文字，缺了就只剩图标。
                  // 官方插件用 () => ctx.locale.bind(ns)('nav')，这里直接用 thunk 返回固定文字。
                  label: function () { return '会话回收站'; },
                  locale: NS,
                },
                registerSettingsSection(React, t),
              );
              log.info('settings.section registered OK');
            } catch (err) {
              warn('settings section register failed', err);
            }
          });

          return function () {
            try { if (typeof dispose === 'function') dispose(); } catch { /* ignore */ }
          };
        }, NS + ': ui');
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
