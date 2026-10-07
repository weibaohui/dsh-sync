# dsh-sync 源码学习指南

> 面向「能看懂一点 JS、被 2000+ 行单文件劝退」的读者。
> 目标不是让你背代码，而是让你能自己回答三个问题：**它怎么跑起来的 / 数据从哪到哪 / 我要改的功能在哪**。
> 文中行号对应当前工作区 **v0.4.3**；改代码后行号会漂移，用编辑器搜索函数名即可。

---

## 0. 先建立三个印象（先别读代码）

1. **它只干一件事**：把 DSH 的几类数据在**多台机器之间同步 / 备份**。
   数据四类：技能 `skills`、会话 `sessions`、设置 `settings`、插件清单 `plugins`。
   协议三种：`git`（完整同步：分支 → PR → 合并）、`webdav`（纯备份）、`local`（纯备份，存本地目录）。

2. **它是一个插件的两半，跑在两个地方**：

   | | 文件 | 行数 | 跑在哪 | 能干什么 |
   |---|---|---|---|---|
   | 宿主端 | `src/index.js` | 2814 | DSH 的 Node/Electron 进程 | 读文件、跑 git、发起 HTTP 请求、注册 HTTP 路由 |
   | 浏览器端 | `client/index.js` | 1160 | 你的 DSH Web GUI 页面里 | 渲染设置面板、fetch 调宿主 |

   两半之间**只通过 HTTP** 通信：`/dsh-sync/api/*`。
   👉 **读每一行代码时先问：这行是在哪一边跑的？** 这一问能砍掉一半困惑。

3. **复杂度的来源是一个笛卡尔积**：3 协议 × 4 类数据 × 4 策略。
   代码里几乎所有分支都在处理这个组合，而不是在处理什么高科技算法。

---

## 1. 项目是怎么被运行起来的（加载链路 6 步）

| 步骤 | 发生什么 | 看哪里 |
|---|---|---|
| 1 | 安装：`dsh plugin --profile desktop add …` → 插件进 `~/.dsh/profiles/desktop/node_modules/@weibaohui/dsh-sync/`，并写进 profile 的 package.json | `package.json:47-49` 依赖 |
| 2 | 启动：cordis loader 读 profile 的 `cordis.yml` + `cordis.patch.yml`；插件自带的 patch 内容就是一段 `- insert: - id: dsh-sync` | `cordis.patch.yml:10-11` |
| 3 | 加载：loader 按 `main` 字段 require 插件入口 | `package.json:18` |
| 4 | 识别：Node 拿到 `module.exports = { name, inject, Config, apply }` | `src/index.js:1803-1818` |
| 5 | 接线：`inject: ['webServer','settings','connection']` → 等这三个服务就绪 → 调 `apply(ctx, config)`；apply 里注册 HTTP 路由与定时器 | `src/index.js:1820`、路由 `2207+`、定时器 `2192-2204` |
| 6 | 前端：`dsh.client.platform: web` + `exports['./client'] → ./client/bundle.js`；GUI 加载 bundle，`apply(ctx)` 用 slot 把设置页挂进设置面板 | `package.json:19-35`、`client/index.js:1107`、`:1146` |

```
你的浏览器（DSH Web GUI）
  client/bundle.js   ← 由 client/index.js 经 scripts/build-client.mjs 生成（产物，别手改）
        │  fetch('/dsh-sync/api/...')
        ▼
DSH 宿主进程（Node / Electron）
  cordis loader → apply(ctx, config)
    ├─ ctx.webServer.register(...)  → HTTP 路由表
    ├─ ctx.effect(() => setInterval) → 自动同步（autoSync / syncOnStartup）
    └─ 同步引擎：git / webdav / local
        │
        ▼
  $DSH_HOME/dsh-sync/        repo（影子 git 工作树）、settings.json、state.json、snapshots/
  ~/.dsh/skills  ~/.dsh/sessions  ~/.dsh/settings.yaml  ~/.dsh/profiles
```

---

## 2. 第一步只读「入口三件套」（合计不到 100 行）

不要一上来读 2814 行，先把这三个看完，项目就"有边框"了：

1. `package.json`：`main` / `exports`（宿主入口与前端入口）/ `dsh` 字段（patch + client platform）/ `files`（打包带什么）/ `scripts`（check / test / build:client）。
2. `cordis.patch.yml`：11 行，讲清"这个插件要插进宿主组合，而不是插进 agent preset"。
3. `src/index.js:1803-1818` 的 `module.exports`：**这是全项目的目录**——`name / inject / Config / apply` 是契约，`__internals` 是作者故意导出给测试用的内部函数清单（照着它就能找到任何功能）。

---

## 3. 三个概念看懂 cordis（本项目的地基）

| 概念 | 通俗说法 | 本项目里的样子 |
|---|---|---|
| `ctx` | **服务容器**，插件通过它拿宿主能力 | `ctx.webServer`（注册路由）、`ctx.settings`（配置文档读写）、`ctx.connection`（请求信任栅栏 + 认证 URL）、`ctx.logger`（日志）、`ctx.on()`（订阅事件） |
| `ctx.inject([...], cb)` | "等服务就绪再叫我" | `src/index.js:2102` 等 connection；`client/index.js:1109-1121` 等 sessions 服务 |
| `ctx.effect(fn, name)` | "注册一个随插件卸载一起清理的东西" | 路由注册 `2207`、设置面板 slot `client/index.js:1144` |

**另外必须懂的一件事：`Config` 与 schemastery**。
宿主只把"声明了 `Config` 且字段是 volatile 的插件"列进设置面板；读配置走 `ctx.settings.describe()` 的投影，写配置走 `ctx.settings.update()`。
👉 如果 `Config` 是 `undefined`，宿主根本不认识这个插件的设置，写回会抛 `No configurable plugin entry "dsh-sync"` —— **这正是本次"保存后重启回默认"bug 的根因**。见文末案例复盘。

---

## 4. 三条数据流（把 2814 行拆成三条线）

### 4.1 线 A：HTTP API（前端 ↔ 宿主的唯一通道）

宿主侧统一注册在 `src/index.js:2207` 的 prefix 路由里；每个分支的样子都是：

```js
if (req.method === 'GET' && apiPath.endsWith('/dsh-sync/api/status')) { ... await stateLoaded ... sendJson(res, 200, {...}) }
```

| 方法 & 路径 | 宿主行号 | 干什么 | 前端调用点 |
|---|---|---|---|
| GET `/status` | 2225 | 总状态：设置（脱敏）+ 仓库/协议/快照/冲突状态 | `client/index.js:748 refresh()` |
| POST `/sync` | 2267 | 手动触发一次同步 | `:778 doSync()` |
| GET `/diag` | 2277 | 诊断：schema 来源、descriptor 可见性、持久化错误 | 手动访问 |
| PUT `/settings` | 2303 | 保存设置（白名单 patch → 双写文件+宿主） | `:802 putSettings()` / `:808 doSave()` |
| POST `/protocol/test` | 2376 | 测试 webdav 连通性 | `:839 doTest()` |
| POST/GET `/conflict/run` | 2424 / 2484 | 冲突处理（AI 或手动） | `:791 doAlign()` 等 |
| POST/GET `/align/run` | 2495 / 2523 | 对齐（含远程对齐） | AgentRunDialog `:434` |
| POST `/prune-branches` | 2534 | 清理远端分支 | — |
| POST `/snapshot/run` · GET `/snapshot/list` · POST `/snapshot/restore` | 2572 / 2615 / 2633 | 快照生成 / 列表 / 恢复 | `:851 doSnapshot()` / `:863 doRestore()` |
| GET `/remote/browse` · GET `/remote/tree` · POST `/remote/pull` · POST/GET `/remote/align` · GET `/remote/preview` | 2702 / 2715 / 2729 / 2757 / 2779 / 2788 | 远端备份浏览器 | `:503 BrowseRemoteDialog` |

前端调用全部走 `client/index.js:393 getJson()`（就是 `fetch` 的薄封装），失败会抛错给 toast。

### 4.2 线 B：git 同步（主干）

关键设计：**不把 `~/.dsh` 变成 git 仓库**，而是在 `$DSH_HOME/dsh-sync/repo` 维护一个"影子工作树"。

```
live 目录  --mirrorLiveToShadow-->  影子仓库(work tree)  --commit-->  分支 --> push --> 远端仓库
     ▲                                                                                        │
     └──────────────── resolveLivePath / 策略落地 ◄──── runPull / reconcileRemote ◄───────────┘
```

| 函数 | 行号 | 职责 |
|---|---|---|
| `defaultRoots()` | 532 | 数据源清单：`~/.dsh/skills`、`~/.agents/skills`、`~/agents/skills`、`~/.dsh/sessions`、`~/.dsh/settings.yaml`、`~/.dsh/profiles` |
| `syncSpec(eff, roots, instanceId)` | 547 | **领域模型**：把"哪个本地目录 → 仓库里哪个路径 → 用什么策略"编成一张表 |
| `ensureShadowRepo()` | 667 | 幂等准备影子仓库 |
| `mirrorLiveToShadow()` | 623 | 按 spec 把 live 内容复制进影子目录 |
| `runPush()` | 689 | commit + push 到分支 |
| `runPull()` | 807 | fetch + 算差异 + 按策略落地到 live |
| `reconcileRemote()` | 916 | 远端被合并后的回收对齐 |
| `strategyForPath()` / `resolveLivePath()` | 590 / 647 | 由影子相对路径反查策略 / live 路径 |
| 冲突与 PR | `prepareConflictTree` 1512、`finalizeConflictBranch` 1530 | 冲突树 → 分支 → PR → 轮询合并 |
| 远端浏览 | `browseRemote` 1304、`browseRemoteTree` 1333、`planRemotePull` 1370、`applyRemotePullPlan` 1399 | 看远端有什么、挑选拉什么 |
| 认证 | `askpassPath` 428、`writeAskpass` 431、`gitAuthEnv` 441 | token 用 GIT_ASKPASS 传，**不落 argv、不进日志** |
| 平台兼容 | `msysPathConvEnv` 366 | Windows 下绕开 MSYS2 路径转换 |

### 4.3 线 C：备份协议（webdav / local）

比 git 简单得多，因为**只是单向写出去**，不读回覆盖：

`resolveBackupProtocols()` (1111) → `backupLayoutSpec()` (1124，强制全部 backup 策略) → `stageBackupTree()` (1137，铸 staging) → `uploadBackupToOne()` (1148) → `runBackupUpload()` (1166)。
落点统一是 `backup/<实例ID>/…`，跟 git 的 backup 策略布局一致，所以**可以互相搬运**。

底层工具在两个小文件里，**这两个文件最值得先读**，因为它们是纯函数、200 行以内：

| 文件 | 内容 |
|---|---|
| `src/backup.js` (109 行) | `walkFiles` / `sha1File` / `hashTree` / `planTreeSync`（内容 hash 决定要不要传）/ `copyDir` / `localMirrorSwap` |
| `src/webdav.js` (207 行) | 极简 WebDAV 客户端：`joinUrl` / `basicAuth` / `parseMultistatus`(解析 XML) / `createWebdavClient`（PROPFIND、MKCOL、PUT、GET…） |

### 4.4 领域模型：`syncSpec` 一张表讲清全部

```js
const groups = [
  { name: 'skills',   strategy: <skillsStrategy>,   sources: [ {from: ~/.dsh/skills, to: 'skills/dsh'}, … ] },
  { name: 'sessions', strategy: <sessionsStrategy>, sources: [ … ] },
  { name: 'settings', strategy: <settingsStrategy>, sources: [ … settings.yaml, file: true ] },
  { name: 'plugins',  strategy: <pluginsStrategy>,  sources: [ … 只带 package.json / patch / 锁文件 ] },
]
```

四种策略的语义（`src/index.js:180-182` 的注释就是权威定义）：

| 策略 | 含义 |
|---|---|
| `backup` | 各机在云上**独立**备份，写 `backup/<实例ID>/`，**本地永不被覆盖** |
| `union` | 并集同步：新增都收，逐文件三方比较，双方都改 → 交 AI |
| `remote` | 覆盖：**远端为准**，本地是只读镜像 |
| `local` | 覆盖：**本地为准**，远端只是回显 |

> 理解这个表 = 理解了项目 70% 的复杂度。所有 runPush/runPull/reconcile 的分支，本质都在实现这四行的排列组合。

### 4.5 设置层：四层合并（也是本次 bug 的所在）

宿主端 apply 里有一段"配置从哪来"的合并（`baseSettings` 1861 / `syncSettings` 1907）：

```js
syncSettings() = {
  ...baseSettings(),          // ① 内置默认 + cordis config.sync（cordis.patch.yml 里的值）
  ...docSync,                 // ② 宿主设置文档 ctx.settings.describe() 的投影
  ...pickFileSettingsLayer(), // ③ 插件自持文件 $DSH_HOME/dsh-sync/settings.json
  ...settingsOverrides,       // ④ 本次运行内存里刚改过的
}
```

读：`readDescriptor()` 1874 → `refreshLive()` 1893；写：PUT 处理器 2303 → `ctx.settings.update()` + 写 ③ 的文件；
宿主文档变化事件：`ctx.on('settings/document-updated', …)` 1958。
👉 **记住这个优先级顺序**（默认 < config < 文档 < 文件 < 内存），它是这次持久化修复的核心设计。

---

## 5. 六站阅读路线（每站 30–60 分钟，带问题和实验）

> 建议顺序执行；每站结束都应该能"用自己的话回答"该站的问题。

### M0（30 分钟）先玩，不读代码
- 打开 DSH 设置面板，把每个页签、每个开关都点一遍；改一次设置、保存、重启、再看值。
- 看日志：`%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.log`，搜 `[dsh-sync]`。
- **目的**：先知道 UI 上有什么，读代码时才有对应物。不做这一步，读代码会像读天书。

### M1（30 分钟）加载链路
- 读：`package.json` 全文、`cordis.patch.yml`、`src/index.js:1803-1818`、`apply` 开头 `1820-1860`。
- 回答：这个插件是怎么被 DSH 发现的？它的两半分别怎么被加载？
- 实验：把 `scripts/build-client.mjs` 读一遍（45 行），然后跑 `npm run build:client`，看 `client/bundle.js` 头部生成的 banner。

### M2（40 分钟）一个请求打穿
- 读：`client/index.js:393 getJson` → `:748 refresh()` → 宿主 `status` 处理器 `2225-2266`。
- 回答：`/status` 返回的每个字段分别来自哪个函数？`safeSettings`（脱敏）为什么要存在？
- 实验：浏览器 DevTools → Network，刷新设置面板，看这条请求的原始 JSON。

### M3（60 分钟）设置读写 ⭐ 最重要
- 读：`syncSettingsSchema` 213 → `DEFAULT_SYNC_SETTINGS` 167-201 → apply 的 `baseSettings/syncSettings/readDescriptor/refreshLive` 1861-1957 → PUT 处理器 2303-2375 → 前端 `doSave` `client/index.js:808`。
- 回答：一次"点保存"到底改了哪几处状态？哪一层是持久化的？重启后值从哪读回来？
- 实验：`node -e "const I=require('./src/index.js').__internals; console.log(I.syncSettingsSchema(I.Schema).toJSON())"`（没装 schemastery 时会走自铸 Config，见 `getSchemaInfo()`）。

### M4（60 分钟）git 同步主干
- 读：`defaultRoots` 532 → `syncSpec` 547 → `mirrorLiveToShadow` 623 → `runPush` 689 → `runPull` 807 → `reconcileRemote` 916。
- 回答：为什么不直接对 `~/.dsh` 做 git？"影子仓库"解决了什么问题？四种策略分别在哪几行分支？

### M5（40 分钟）备份协议
- 读：`resolveBackupProtocols` 1111 → `backupLayoutSpec` 1124 → `stageBackupTree` 1137 → `uploadBackupToOne` 1148；再读 `src/backup.js` 全文、`src/webdav.js` 全文。
- 回答：为什么两个协议能共用一份 staging？`hashTree` 有什么用（避免重复上传）？
- 实验：只开 `local` 协议（本地目录备份），跑一次备份，去目录里看 `backup/<实例ID>/` 结构。

### M6（可选，最难）冲突与 AI
- 读：`prepareConflictTree` 1512 → `finalizeConflictBranch` 1530 → `mintCookie` 1655 → `apiproxy` 1697 → `runAgentViaApiproxy` 1711 → 前端 `AgentRunDialog` `:434`。
- 回答：冲突为什么走"分支 + PR"而不是本地 merge？AI 是怎么被叫起来的（apiproxy）？提示词在哪（`CONFLICT_PROMPT_ZH`）？

---

## 6. 怎么不被 2814 行淹没（实用技巧）

### 6.1 骨架 vs 肉
- **骨架（约 300 行，必须读）**：`module.exports`、`apply` 里的路由分派、`syncSpec`、`syncSettings` 合并、`runPush/runPull` 主流程。
- **肉（可按需跳读）**：几十个模块级工具函数（`gitExec`/`copyTree`/`atomicWriteFile`/`parseLsTree`…），当成"标准库"，用到再查。
- **最好跳过**：错误消息拼接、脱敏过滤、Windows 路径转换、i18n 字典（`ZH`/`EN` 占了 client 的 300+ 行）。
- ⚠️ **`apply` 有 400+ 行**：不要整体读，按"一个 route 一段"读，每段之间互不依赖。

### 6.2 用搜索代替顺读
```bash
# 找所有 HTTP 端点
rg -n "req\.method ===" src/index.js
# 找所有导出给测试的内部函数
rg -n "__internals" -A 15 src/index.js
# 找某个设置字段在哪被用
rg -n "intervalMinutes" src/index.js client/index.js
```

### 6.3 用命名约定猜用途（这个项目很守规矩）

| 前缀 | 含义 |
|---|---|
| `run*` | 有副作用的动作：`runPush`、`runPull`、`runSync`、`runBackupUpload` |
| `resolve*` | 纯计算：`resolveBackupProtocols`、`resolveLivePath` |
| `parse*` | 字符串/字节 → 对象：`parseRepoUrl`、`parseLsTree`、`parseMultistatus` |
| `ensure*` | 幂等准备：`ensureShadowRepo` |
| `plan*` | 只算不做的计划：`planTreeSync`、`planRemotePull` |
| `apply*` | 执行上面 plan 的结果：`applyRemotePullPlan` |
| `is* / can*` | 布尔判断：`gitProtocolOn`、`pullSafety` |

### 6.4 读测试就是读用法文档
```bash
node --test test/sync.test.mjs              # 核心 spec/路径/工具函数
node --test test/settings-persist.test.mjs  # 设置持久化（这次修复新增）
node --test test/backup-protocols.test.mjs  # 多协议备份 + 跨重启
```
`test/` 下 8 个文件就是 8 篇"这个模块怎么用、边界在哪"的说明书；测试里 `const I = require('../src/index.js').__internals` 就是这个项目能单测的原因。

### 6.5 用 `node -e` 单独跑纯函数（不启动 DSH）
```bash
node -e "const I=require('./src/index.js').__internals; console.log(I.defaultRoots())"
node -e "const I=require('./src/index.js').__internals; console.log(I.expandTilde('~/a/b'))"
```
这是本项目**最爽的学习方式**：纯函数不需要宿主、不需要 UI，`console.log` 就是答案。

### 6.6 养成"三问"习惯
读任何一段代码都问：
1. **这行在哪端跑？**（宿主 / 浏览器）
2. **数据从哪来、到哪去？**（live 目录 / 影子仓库 / 远端 / 设置文件）
3. **失败了会怎样？**（抛出 / 记日志 / **被 try/catch 静默吞掉**）
   —— 第 3 问最要命：本次 bug 就是"写回失败被 catch 成一条 warn，接口仍返回 200 成功"。

---

## 7. 本地调试手册（改一行看到效果的最短路径）

| 想改什么 | 怎么做 |
|---|---|
| 宿主端 `src/*` | 开发期把 profile 里的安装副本换成 junction 指向本仓库（`New-Item -ItemType Junction`），改完**重启** DSH 生效 |
| 浏览器端 `client/index.js` | 改完必须 `npm run build:client`（生成 `client/bundle.js`）再刷新页面；**直接改 bundle.js 会在下次构建被覆盖** |
| 只想验证纯函数/逻辑 | `node -e` + `__internals`，或 `node --test test/xxx.test.mjs` |
| 端到端（真实宿主 settings） | `.repro/harness4.mjs real`（boot 约 21s，结果写 `.repro/out4-real.json`） |
| 看运行日志 | `%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.log`，搜 `[dsh-sync]` |
| 看设置链路健康度 | `GET /dsh-sync/api/diag`（schema 来源、descriptor 是否可见、写回错误） |
| 语法检查 | `npm run check`（两个入口文件的 `node --check`） |

⚠️ 受限沙箱（如某些 AI/CI 环境）里 `spawn` 会被拒，测试里跑 git/node 子进程的用例会 EPERM 假失败——在普通终端跑才准。

---

## 8. 十个练习（从 10 分钟到半天，难度递增）

1. **加一个只读端点**：`GET /dsh-sync/api/ping` 返回 `{ok:true, at:new Date().toISOString()}`。—— 练路由分派结构。
2. **给 `/status` 加字段**：比如返回当前 git 提交号（`gitCurrentCommit`）。—— 练宿主侧读状态。
3. **在设置面板显示新字段**：client 的 `refresh()` 里取字段并渲染一行只读文本。—— 练前端数据流。
4. **端到端加一个设置项** ⭐：`DEFAULT_SYNC_SETTINGS` → `syncSettingsSchema` → `/status` 输出 → `PUT /settings` 白名单 → 前端表单 + `doSave` patch。做完这一个，设置链路你就通了，也就彻底理解本次 bug。
5. **写一个纯函数单测**：断言 `syncSpec` 在 `syncSkills:false` 时不产出 skills 组。
6. **改策略默认值**：把 `skillsStrategy` 默认从 `union` 改成 `backup`，观察 `/status` 和实际落点变化（`skills/…` → `backup/<实例ID>/skills/…`）。
7. **跑一次端到端 harness**：`.repro/harness4.mjs forced`，对比 `real` 两种 schema 路径的结果。
8. **加一个假备份协议**：在 `resolveBackupProtocols` 里加 `{kind:'null'}`，在 `uploadBackupToOne` 里直接 return。—— 练协议抽象（local 协议就是最好的模板）。
9. **改 AI 提示词**：找 `CONFLICT_PROMPT_ZH`，加一句"优先保留双方新增文件"，看它怎么被 `substituteParams` 填充。
10. **修文档债**：把设置层"文件 vs 宿主文档"的优先级语义（`pickFileSettingsLayer`，见 `src/index.js:155-158`）写进 README 并补一个测试。—— 真实开源项目的贡献长得就是这样。

---

## 9. 术语速查

| 词 | 含义 |
|---|---|
| cordis | DSH 的插件/服务容器框架；插件导出 `{name, inject, Config, apply}` |
| ctx | 服务容器实例，插件拿宿主能力的入口 |
| Config | 插件的 schemastery 配置 schema；宿主据此生成设置页 |
| volatile | schemastery 3.18.4+ 的字段标记；**只有 volatile 字段**才允许被设置面板读写 |
| patch（`cordis.patch.yml`） | 往宿主组合里插入/修改条目的声明；**宿主写回的设置值也存在 profile 的这个文件里** |
| profile | 一套 DSH 配置目录：`~/.dsh/profiles/<name>/`（含 package.json、node_modules、patch） |
| shadow repo | `$DSH_HOME/dsh-sync/repo`，用于 git 操作的影子工作树 |
| live | 真实数据目录（`~/.dsh/skills` 等） |
| instanceId | 本机实例标识，用于 `backup/<实例ID>/` 隔离多机 |
| askpass | git 通过 `GIT_ASKPASS` 脚本取 token，避免 token 进 argv/日志 |
| apiproxy | 插件用自身 cookie 代浏览器调宿主 API 的通道（AI 冲突处理用） |
| staging | 备份前的临时整树目录（`backup-staging/`），webdav 与 local 共用 |
| snapshot | 本地优先的快照（`snapshots/`，`auto-<日期>`），可上云、可恢复 |

---

## 10. 案例复盘：用这套方法定位"保存配置 → 重启回默认"

1. **看现象+日志**（M0 的方法）：日志反复出现
   `dsh-sync: settings update 失败（仅本次运行生效）: No configurable plugin entry "dsh-sync"`
   → 搜错误原文定位到 PUT 处理器 2303 附近的 `ctx.settings.update()` —— 宿主说"没有这个可配置条目"。
2. **追问失败为什么被吞**（"三问"的第 3 问）：那里是 `try/catch → logger.warn` 且**照旧返回 200**，所以 UI 显示"保存成功"。
3. **顺链路往回找**：宿主凭什么认为一个插件"可配置"？→ `Config`。而插件里 `Config` 的构造是
   `try { Config = Schema.object({sync: …}).volatile() } catch { Config = undefined }`（旧版）
   → schemastery 版本/解析出任何问题都会**静默**变成 `undefined`。
4. **定验证方法**：`/api/diag` + 日志 + `cordis.patch.yml` 是否有 `dsh-sync` 行 + `$DSH_HOME/dsh-sync/settings.json` 是否存在。
5. **修复三件套**：让 schema 可用（依赖提升 + 多候选 + `.volatile()` 校验）、`Config` 永不为 undefined（自铸兜底）、**不依赖宿主也能持久化**（自持 `settings.json` + 写回状态回传前端）。
6. **回归测试**：`test/settings-persist.test.mjs` + `backup-protocols.test.mjs` 里两个"跨重启"用例。

👉 这就是读这个项目的正确姿势：**从一条日志/一个现象出发，顺着 data flow 往回找，而不是从第 1 行读到第 2814 行。**
