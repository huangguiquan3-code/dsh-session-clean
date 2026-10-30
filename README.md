# dsh-session-clean

给 DeepSeek Harness 补上**删除会话**的能力：进回收站、可还原、不改官方任何文件。

> DSH 自带归档（archive）与置顶（pin），但没有删除。归档只是把会话从列表摘掉并禁止再跑模型，
> 磁盘上的正文和缓存原封不动。本项目补的是「真的删掉，但删得回得来」。

## 为什么需要它

| 能力 | DSH 官方 | 本插件 |
|---|---|---|
| 归档 | ✅ `archiveSession` | 复用 |
| 取消归档 | ✅ `unarchiveSession` | 复用 |
| 置顶 | ✅ `pinSession` | 复用 |
| 物理删除 | ❌ 无 | ✅ 本插件补上 |
| 还原 | ❌ | ✅ 回收站 |

## 一个会话落在两处

```
$DSH_HOME/
├── sessions/<工作区目录>/<sessionId>/session.v4.jsonl.zstd   正文
└── storages/session_projcache/sessions/<sessionId>.json      投影缓存（标题在这里）
```

**两处必须一起处理**，否则删了正文列表还剩空标题、删了缓存正文变孤儿。

插件只删除「两处都能找到」的会话；缺一处就报 `incomplete` 并跳过，不猜。

## 安全设计

| 风险 | 做法 |
|---|---|
| 把客户端搞崩 | **不改官方任何文件**，尤其不碰官方 `client.js`；所有入口 `try/catch`，失败只记日志不 throw |
| 误删正在使用的会话 | 进程内有 `workspaceRegistry` 时先调官方 `archiveSession`，它的 `session-active` 会拦下带任务的会话 |
| 删了救不回 | 全程 `rename` 到回收站，只有 `purge` 才真删 |
| 还原时覆盖新数据 | 目标已存在且**内容不同**→ 报冲突，保留在批次里不覆盖；内容相同→视为已还原（幂等） |
| 只还原了一半 | 逐项独立处理，失败的不影响成功的；重写 manifest 只留剩余项，可再次 `restore` |
| 删到一半中断 | 任一步失败整体回滚本次移动，不留半残批次 |

## 用法

```sh
cd dsh-session-clean

# 只读：看有哪些会话、是否配对齐全
node bin/session-clean.js list
node bin/session-clean.js list --incomplete

# 删除（进回收站，可还原）
node bin/session-clean.js delete session-xxxx

# 回收站
node bin/session-clean.js trash
node bin/session-clean.js restore <batchId>     # 还原一个批次
node bin/session-clean.js restore --all         # 全部还原
node bin/session-clean.js purge   <batchId>     # 彻底删除（不可恢复）
node bin/session-clean.js purge   --all         # 清空回收站
```

`--home <path>` 指定其他 `DSH_HOME`，默认 `$DSH_HOME` 或 `~/.dsh`。

> **delete 前请退出 DSH 客户端**。会话正文有写入锁（`LEASE`），客户端运行时 `rename` 会 `EBUSY`。插件会报错并回滚，不会损坏数据，但删不掉。

## 回收站结构

```
$DSH_HOME/trash-sessions/
└── 20261030-131900-123-session-a5231cae/
    ├── manifest.json        # 原始路径、标题、时间、字节数
    ├── 01-session-session-a5231cae.../
    └── 02-cache-session-a5231cae.json
```

`manifest.json` 记着 `originalPath`，还原就是按它反向 `rename`，不猜不重建。

整个 `trash-sessions/` 目录可以直接删——那就是「放弃全部回收站内容」。

## 测试

```sh
node test/roundtrip.mjs          # 36 项，只碰临时目录
node test/roundtrip.mjs --keep   # 保留沙箱
```

覆盖：扫描配对 / 标题读取 / 删除 / 回收站记账 / 还原 / 字节级一致 / 冲突保护 / 部分还原后再次还原 / 回滚 / 幂等 / 容错。

## 边界

- 不提供 UI 按钮（会牵扯官方客户端代码），当前是 CLI。
- 进程内插件入口 `lib/index.js` 已就绪，等宿主 API 边界确认后可接命令与 HTTP 路由。
- 不删除工作区注册本身，只删会话存档。
