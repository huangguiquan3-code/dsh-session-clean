# dsh-session-clean —— 实现方案 / 工具方法 / 桌面浮窗

> 面向维护者的一页纸架构说明。代码在 `dsh-session-clean/`，客户端界面 `client.js`，宿主半 `lib/`，
> 外部浮窗 `scripts/desk-window.*`。

---

## 0. 一句话

插件由**三个可独立替换的部分**组成：宿主半（Node，跑在 DSH 的 host 子进程里）、客户端半
（浏览器模块，跑在渲染进程里）、外部置顶浮窗（独立 PowerShell 进程）。三者之间只通过
**同源 HTTP 路由 + 两个 JSON 文件**通信，互不 import、互不依赖对方的生命周期。

---

## 1. 运行边界（四段进程）

| # | 进程 | 跑什么 | 能碰什么 | 拿不到什么 |
|---|---|---|---|---|
| 1 | `DeepSeek Harness.exe`（Electron main） | 官方主进程、窗口、托盘 | —— | 官方代码不可改 |
| 2 | `DeepSeek Harness.exe --expose-internals .../dsh-desktop-host`（host 子进程） | cordis 宿主 + **本插件 `lib/`** | 文件系统、`ctx.get('workspaceRegistry')`、`ctx.inject(['webServer'])` | **没有 `require('electron')`**（`ELECTRON_RUN_AS_NODE`） |
| 3 | 渲染进程（窗口里的页面） | **本插件 `client.js`** | DOM、`fetch`、`localStorage`、`ctx.slots`、`ctx.get('sessions'/'workspaces'/'uiSession'/'uiWorkspace')` | 不能创建窗口、不能跨进程 |
| 4 | `wscript.exe → powershell.exe`（**外部**） | **`scripts/desk-window.ps1`**（WinForms） | Win32 API（置顶窗口、前台激活）、HTTP | 不能调用 DSH 内部 JS |

第 2 段的这个结论是**实测**的，不是猜的：

```
GET /session-clean/probe
→ { pid: 9212, processType: null, versions.electron: "44.7.0",
    electronModule: { ok:false, error:"Cannot find module 'electron'" },
    parent pid 37260 = DeepSeek Harness.exe }
```

所以"最小化后仍可用"的浮窗只能由第 4 段的**外部进程**持有——这也是它存在的唯一原因。

---

## 2. 宿主半（`lib/`）

### 2.1 文件职责

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口 `apply(ctx)`：挂 HTTP 路由、归档/取消归档封装、隔离区/桌面协作状态 |
| `store.js` | 扫描会话落点、配对校验（正文 + 投影缓存）、读取 workspace 状态做标签 |
| `trash.js` | 回收站：`rename` 移入/还原/彻底删除，`manifest.json` 记账，失败整体回滚 |
| `export.js` / `transcript.js` / `zip.js` | 导出 Markdown/JSON、事件流转录、无依赖 ZIP 打包 |
| `zstd-log.js` | 多帧 zstd 切帧解压（单帧 API 只会解出 header 一行） |
| `workspace-state.js` | 直接读写 `storages/workspace.json`（归档集合），CLI / 兜底路径用 |
| `stash.js` | 隔离区台账 `session-clean/stash.json`（不碰会话文件） |
| `prompt-diagnostics.js` | 只读诊断：抓系统提示词组装结构 |

### 2.2 一个会话落在两处（删除必须成对处理）

```
$DSH_HOME/
├── sessions/<工作区目录>/<sessionId>/session.v4.jsonl.zstd   正文（多帧 zstd）
└── storages/session_projcache/sessions/<sessionId>.json      投影缓存（标题在这）
```

只删一处会留孤儿（空标题 / 幽灵正文），所以插件只操作"两处都在"的会话，否则报 `incomplete`。

### 2.3 归档不是文件操作（这是"还原后侧边栏不显示"的根因）

```jsonc
// $DSH_HOME/storages/workspace.json
{
  "global": { "archivedSessionIds": ["session-xxxx", ...] },
  "tables": { "workspaces": { "<wsId>": { "sessionIds": ["session-xxxx"] } } }
}
```

侧边栏渲染时先用 `archivedSessionIds` 过滤、再按 `sessionIds` 排序。所以：

- **删除** = 归档（隐藏）+ 文件移进回收站；
- **还原** = 文件搬回 + **从 `archivedSessionIds` 摘掉** + 客户端 `sessions.refresh()` 重建列表基线。

三件事少一件，行就不会出现。

### 2.4 HTTP 路由（同源，`webServer.register({kind:'exact'})`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/session-clean/sessions` | 列表（`q`/`limit`/`includeArchived`，带 `archived`/`stashed`） |
| POST | `/session-clean/delete` / `delete-many` | 删一个 / 批量 |
| POST | `/session-clean/export` / `export-zip` | 落盘 / 直接下 ZIP |
| GET | `/session-clean/trash` | 回收站批次 |
| POST | `/session-clean/restore` | 还原 + 取消归档（返回 `unarchived`/`needRefresh`） |
| POST | `/session-clean/purge` / `purge-all` | 彻底删除 |
| GET/POST | `/session-clean/stash` | 隔离区台账 / 抽进隔离区 |
| POST | `/session-clean/unstash` | 放回（取消归档 + 清台账） |
| POST | `/session-clean/archive` / `unarchive` | 只归档 / 只取消归档（不记台账） |
| GET | `/session-clean/archived-hidden` | 只读：被归档但文件还在的会话 |
| POST | `/session-clean/repair-archived` | 历史遗留修复（`{ids?}`，不传=全部） |
| GET/POST | `/session-clean/desk-state` | 桌面清单镜像（客户端写，外部窗读） |
| GET | `/session-clean/desk-pending` | 取走外部窗的动作队列 |
| POST | `/session-clean/desk-open` / `desk-remove` | 外部窗 → 队列（打开 / 收回） |
| POST | `/session-clean/client-hello` | 页面报到（带 build 号） |
| GET | `/session-clean/probe` | 环境探针（进程 / Electron / webServer / clientHello） |
| POST | `/session-clean/prompt-diag` | 只读诊断 |

### 2.5 依赖的宿主服务

- `ctx.get('workspaceRegistry')` → `archiveSession(id,{stopActivity})` / `unarchiveSession(id)`
  （进程内优先走它：写穿磁盘 + 广播增量；拿不到才退化到直接改 `workspace.json`，CLI 模式用）；
- `ctx.inject(['webServer'], …)` → `register({kind:'exact',path,handler})`，全部包在 `ctx.effect` 里随插件卸载注销。

---

## 3. 客户端半（`client.js`）

### 3.1 模块格式（必须）

```js
window.__ModuleLoader__.load({
  id: 'dsh-session-clean',
  factory: (require) => { /* 只能用 require('react') / require('@deepseek-ai/dsh-client-ui-primitives') */ },
});
```

裸 ESM（顶层 `export`）会在浏览器里直接抛 `Unexpected token 'export'`。

### 3.2 占用的槽位

| 槽位 | id / key | 内容 |
|---|---|---|
| `sidebar.footer.action` | `session-clean.toggle` | 侧边栏底部「会话」按钮（跳板入口） |
| `shell.overlay` | `session-clean.panel` | 会话跳板浮层 |
| `shell.overlay` | `session-clean.desk` | 常驻「桌面」浮条 |
| `settings.section` | `session-clean.trash` | 设置页：通知开关 / 修复 / 回收站 |
| `sidebar.workspaces.session.menu.item` | `.desk` / `.stash` / `.trash` | 行「…」菜单：放桌面、隔离、移入回收站 |
| `sidebar.workspaces.session.row.action` | `session-clean.stash-row` | 行悬停图标 |
| `main`（keyed） | `session-clean.stash` | 隔离区整屏 |
| `sidebar.panellist` | `session-clean.stash` | 隔离区面板图标 |

注册一律 `ctx.slots.inject(name, () => ctx.slots.register(...))`：子槽位是父条目在运行时 declared 的，
直接 `register` 会抛 `slot ... is not declared`。

### 3.3 用到的客户端服务（全部软取，取不到就降级）

| 服务 | 用途 |
|---|---|
| `slots` | 注册/注入（必需） |
| `sessions` | `list` 快照（标题 / running）、`refresh()` 重建基线 |
| `workspaces` | `list.archivedSessionIds` → 判断「隔离 / 放回」文案 |
| `uiSession` | `current` → 当前主视图会话 id |
| `uiWorkspace` | `openSession(id)` |
| `layout` | `selectPanel(null)` 从隔离区切回对话 |
| `remote` | `$on('api-session/status', (id, running) => …)` 完成通知主源 |

### 3.4 三块 UI

**会话跳板**（`shell.overlay`）
- 一次拉 2000 条，本地即时筛（标题 / 目录 / id）；
- 点行 → `openSessionSmart()`；归档的先 `unstash` 再打开；
- `↑↓` 移动高亮、`Enter` 打开、`Esc` 关；`Alt+K` 全局开合；
- 勾选 → 批量删除 / 导出 / **放到桌面**。

**隔离区**（`main` + `sidebar.panellist`）
- 「隔离当前对话」= 归档 + 记台账；「打开」= 取消归档 + 切回对话 + 打开；「放回」= 取消归档。

**桌面**（应用内 `shell.overlay` 浮条）
- `localStorage: session-clean.desk` 存 `[{sessionId,title}]`，最多 12；
- 拖动（`pointerdown/move/up`）位置存 `session-clean.desk.pos`，双击复位；
- `↑/↓` 切置顶 / 置底（`z-index` 2147482000 / 1，存 `session-clean.desk.z`）；
- 状态点（running）/ 当前会话高亮 / 悬停 `×` 收回。

### 3.5 完成通知

双源同一判定（`running: true → false`）：

1. `remote.$on('api-session/status')` —— 最可靠（`ui-session` 自己也用它）；
2. `sessions.list` 快照兜底（重连 / 首帧）。

前台只弹面板内 toast，窗口失焦才发 `new Notification()`；点通知/ toast → 打开该会话。
开关 `localStorage: session-clean.notify`。

---

## 4. 协作通道（应用内 ↔ 宿主 ↔ 外部窗）

```
[渲染进程]  ──POST /desk-state {items}──▶  [宿主 mirror]  ◀──GET /desk-state (2s)──  [外部浮窗]
[渲染进程]  ◀──GET /desk-pending (1.2s)──  [宿主 队列]   ◀──POST /desk-open ──────  [外部浮窗]
                                                          ◀──POST /desk-remove ────  [外部浮窗]
[宿主]      ──写 $DSH_HOME/session-clean/desk.json {port}──▶  [外部浮窗 启动时读端口]
```

- 队列取走即清空（`splice`），一次点击只消费一次；
- 页面被最小化时定时器会被节流，所以外部窗点击时**先把 DSH 唤到前台**，页面恢复可见后下一次轮询立刻执行。

---

## 5. 桌面浮窗（`scripts/`）

### 5.1 为什么是外部进程

见 §1 的 probe 结果：宿主是 `ELECTRON_RUN_AS_NODE` 子进程，`require('electron')` 不可用。
外部进程是唯一能"最小化后仍然置顶可见 + 能激活 DSH 窗口"的位置。

### 5.2 技术栈

| 组件 | 作用 |
|---|---|
| `desk-window.vbs` | **无控制台**启动器（`WScript.Shell.Run ..., 0, False`），供自启与手动启动 |
| `desk-window.ps1` | PowerShell 5.1 + WinForms 实现的窗口本体 |
| `Win32` P/Invoke | `ShowWindow(SW_RESTORE)` + `SetForegroundWindow` 唤起 DSH |
| `System.Threading.Mutex` | 单实例（`Local\DshSessionCleanDeskWindow`） |
| `Region` + `GraphicsPath` | 圆角窗体 / 圆角行 |
| `Application.ThreadException` | 全局异常兜底：只写日志，不弹 JIT |

### 5.3 结构

```
Form（FormBorderStyle=None, TopMost, ShowInTaskbar=false, Region 圆角 12）
├── head(26px, #26272b)  「桌面 · N」 + [＋ 唤起 DSH] + [－ 折叠]
└── FlowLayoutPanel
    └── row ×N（24px）：● 状态点 + 标题 + 悬停出现的 ×
```

视觉与**应用内浮条同款**：238 宽、`#1e1f22` 底、`#45464a` 1px 边、12px 圆角、
`#4c8dff` 运行点、悬停 `#2c2d31`、当前项 `#234a74` 近似高亮。
主题可切（右键 `深色 / 浅色`），位置与主题存 `$DSH_HOME/session-clean/desk-window.json`。

### 5.4 行为

| 操作 | 结果 |
|---|---|
| 点行 | `POST /desk-open {id}` → 宿主入队；`ShowWindow` + `SetForegroundWindow` 唤起 DSH；页面 1.2s 内执行打开 |
| 点 `×` | `POST /desk-remove {id}` → 页面 `removeDesk(id)` 并回写镜像 |
| 拖头部 | 移动，松手写位置 |
| 双击头部 / `－` | 折叠成 86×28 小条 |
| `＋` | 唤起 DSH（进去按 Alt+K 就是跳板） |
| 右键 | 刷新 / 深色 / 浅色 / 退出 |

`DSH 未运行` 时只显示提示，不报错；端口变化自动跟上（每次 `Get-Port` 都重读 `desk.json`）。

### 5.5 崩溃防护（三层）

1. **每个事件回调内部 `try/catch`**；
2. **不依赖闭包与函数局部变量**：回调只用 `$sender` 反查父级行，调色板从 `$form.Tag` 取
   （`Get-RowPalette`），行状态存 `Tag = @{id;active}`；
3. **`SetUnhandledExceptionMode('CatchException')` + `add_ThreadException`**：
   任何漏网的 UI 线程异常写进 `session-clean/desk-window-error.log`，不再弹 .NET JIT 对话框。

> 踩过的三个坑（都已修复，README 也留了记录）：
> ① 事件块引用 `Add-Row` 的 `$row/$dot/$del` → 函数返回后为 `$null` → `找不到属性 BackColor`；
> ② 用 `.GetNewClosure()` 抓 `$script:P` → 闭包内取不到 → `无法将空值转换为 Color`；
> ③ 脚本存成无 BOM 的 UTF-8 → Windows PowerShell 5.1 读中文乱码，中文字符串会破坏解析。

### 5.6 自启与验收

```powershell
# 两条 HKCU\...\Run：应用本体 + 浮窗（wscript 无黑框）
DeepSeek Harness      = "…\DeepSeek Harness.exe"
DeepSeek Harness Desk = "C:\Windows\System32\wscript.exe" "…\scripts\desk-window.vbs"

# 开关脚本（只动 HKCU Run）
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 on|off|status

# 样式验收：渲染一张静态图就退出（不改动正在跑的实例）
powershell -ExecutionPolicy Bypass -File scripts\desk-window.ps1 -Snapshot out.png
```

---

## 6. 工具与方法清单

### 6.1 宿主 / 插件接入

| 工具 | 用途 |
|---|---|
| `plugin_manager`（MCP）`set_plugin` 关→开 | **热重载**插件条目：host 重新 import `lib/`，client 重新快照 `client.js` |
| `ctx.inject` / `ctx.get` / `ctx.effect` | cordis 严格注入、服务获取、随卸载清理 |
| `ctx.slots.inject` / `register` / `provideRoot` | 客户端插槽（含 root-scope list / keyed `main`） |
| `webServer.register({kind:'exact'})` | 同源 HTTP 路由 |

### 6.2 客户端调试

| 工具 | 用途 |
|---|---|
| `/session-clean/client-hello` + `/probe` | 确认页面跑的是**哪一版** client.js（build 号） |
| `Alt+K` / 面板 | 交互自检 |
| `localStorage` 键 | `desk` / `desk.pos` / `desk.z` / `notify`，出问题可直接清 |

### 6.3 测试（`test/`，全部 `node` 直跑，无依赖）

| 文件 | 覆盖 |
|---|---|
| `roundtrip.mjs`（36） | 扫描 / 删除 / 回收站 / 还原 / 回滚 / 幂等 |
| `client.mjs`（28） | 假 ctx 下的槽位注册、降级、错不冒泡 |
| `client-parse.mjs` | 浏览器非模块编译（禁止顶层 `export`） |
| `export.mjs`（11） | 多帧 zstd / Markdown / JSON / 落盘 / ZIP |
| `stash.mjs`（10） | 归档集合 / 台账 / 隔离 / **还原必须取消归档** / registry 优先 |
| `http.mjs`（7） | 假 `webServer` 接住路由，端到端打 stash/unstash/restore/repair |
| `render.mjs`（14） | 借 **React 内部 dispatcher** 真跑每个组件函数体 + 递归展开子树（抓"一开面板就白屏"） |

`render.mjs` 的做法值得记一笔：宿主没有 `react-dom`，所以不渲染 DOM，而是
`ReactCurrentDispatcher.current = { useState, useEffect, useCallback, useSyncExternalStore, … }`
之后直接调用组件函数，再递归 walk 返回的元素树——能抓到 hooks 顺序错、`undefined` 组件、
渲染期 `ReferenceError`（`err`/`total` 未解构那次就是它抓到的）。

### 6.4 视觉验收（没有 CDP 也能看）

```powershell
chrome --headless=new --disable-gpu --force-device-scale-factor=2 `
       --window-size=900,240 --screenshot=out.png file:///…/preview.html
```

把组件的 HTML/CSS 原样抽成独立页面，用 headless Chrome 截图核对——搜索框、勾选盒、
桌面窗的 `-Snapshot` 都是这么验的。

### 6.5 Win32 / 进程侧

| API | 用途 |
|---|---|
| `EnumWindows` + `GetWindowThreadProcessId` + `GetWindowRect` | 按 pid / 标题找窗口、取几何（确认浮窗真的显示了） |
| `SetCursorPos` | 把鼠标移到窗口上，触发 `MouseEnter` 复现/验证 hover 崩溃 |
| `Get-CimInstance Win32_Process` + `CommandLine` | 确认插件 host pid、父进程、自启进程 |
| `HKCU\...\Run` | 开机自启 |

---

## 7. 当前状态

- 宿主半已热重载（`/session-clean/*` 全 200）；
- 客户端最新标记：`client-2026-11-07-white-outline-2`；
- `/session-clean/probe` 的 `clientHello` 目前为 `null` → **页面里仍是旧模块**，
  所以白边搜索框与旋转动效尚未出现在屏幕上；需要硬刷新（Ctrl+Shift+R）或重开窗口，
  刷新后 probe 会显示上述 build 号；
- 已移除 `prefers-reduced-motion` 的"停转"（Windows 关闭动画效果时会让动效看起来完全没做），
  改为只降速；动画提速到 4–7s，hover/聚焦 1.5–2.6s。

## 8. 目录

```
dsh-session-clean/
├── client.js                 客户端半（槽位 UI + 三个 store + 通知 + 桌面桥）
├── lib/                      宿主半（路由 / 存储 / 回收站 / 导出 / 归档状态 / 台账）
├── bin/                      CLI（list/delete/export/trash/restore/purge/stash/unstash）
├── scripts/
│   ├── desk-window.ps1       外部置顶浮窗（WinForms）
│   ├── desk-window.vbs       无控制台启动器
│   └── autostart.ps1         开机自启开关
├── test/                     7 个 node 测试 + React 渲染冒烟
├── docs/                     预览图（面板 / 勾选盒 / 搜索框 / 浮窗）
└── README.md                 使用说明 + 踩坑记录
```
