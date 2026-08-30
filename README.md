# dsh-plugin-dsh-sync

一个小型 git 同步系统，让多个 dsh 副本通过一个**私有 GitCode 仓库**同步 skills / sessions / settings / plugins。每个实例只能以**分支 → PR → 合并**的形式提交变更，冲突因此显化为一个待合并的 PR，而不是静默覆盖。

## 设计要点

- **影子工作树**：`$DSH_HOME/dsh-sync/repo` 镜像选定的 live 根目录。不在 `~/.dsh` 直接开 git（里面混着凭证、profiles 的 node_modules）。push = fetch `origin/main` → shadow reset 到基线 → 覆盖 live 快照 → 建分支 → commit → push → 建 PR。
- **三向算法**：live 目录是本机真相源，shadow+remote main 是合并账本。push 把本机增量做成 PR；pull 只把"本地没动过"的远端变更写回 live（本地动过的留给下个 push）。冲突由 PR 兜底。
- **PR 即冲突闸口**：GitCode v5 REST（`POST /pulls`、`GET /pulls/:n`、`PUT /pulls/:n/merge`）。可合并则 squash 合并；冲突则留 PR 开着。
- **冲突 = AI action button**：冲突时不机器硬合，也不纯人工挂起，而是 UI 冒出「AI 解决冲突」按钮，点击后启动一个 in-process agent（复用 skills-management share 的 `agents.create + followup` 通道），读 token、分析两边、改影子仓库、合并 PR。确定性的事（fetch/branch/commit/push）走 git CLI；只有需要语义判断的冲突才召唤 AI。
- **私仓强制**：`settings.yaml` 整文件同步、**不脱敏**（含各 provider token）。前提是仓库必须 private——保存配置时调 `GET /repos/{owner}/{repo}` 校验 `private===true`，公共仓库直接拒绝。不代建仓库，用户自行到 gitcode.com 建私有仓库。
- **token 只写不回读**：复用 skills-market 的 schemastery settings 模式，namespace `dsh-sync`，HTTP 只回 `hasToken`。

## 四类同步开关

| 开关 | 默认 | 同步内容 |
|---|---|---|
| `syncSkills` | 开 | `~/.dsh/skills` + `~/.agents/skills`（软链解引用）+ `~/.agents/.skill-lock.json` |
| `syncSessions` | **关** | `~/.dsh/sessions/**/*.session.jsonl.zstd`（写一次即不变，零冲突；默认关因体积大） |
| `syncSettings` | 开 | `~/.dsh/settings.yaml` 整文件 |
| `syncPlugins` | 开 | `~/.dsh/profiles/*/` 下 `package.json`/`cordis.patch.yml`/`pnpm-lock.yaml`/`pnpm-workspace.yaml`（排除 node_modules、.dsh-market、cordis.yml 产物） |

## 配置步骤

1. 在 gitcode.com 建一个**私有**空仓库（如 `my-dsh-sync`）。
2. 生成一个有该仓库读写权限的 access token。
3. dsh 侧栏点「同步」→ ⚙ 同步设置：填仓库地址、token、勾选要同步的类别。
4. 保存（私仓校验通过后）→ 立即同步。首次会全量上传。

## 已知局限

- **plugins 跨机复现依赖 npm 包**：`cordis.patch.yml` 里 insert 的本地绝对路径插件（如 `dsh-plugin-hermes-prompt`）在另一台机器路径不存在，只能靠 `pnpm install` 拉 npm 包形式的插件。pull 下 profile 声明后需手动 `pnpm install` + 重启。
- **settings 生效需重启**：运行中的 dsh 不一定热读 settings.yaml，pull 下来的 provider/UI 偏好要重启 dsh 才生效。token 类同生态共享无影响。
- **多 profile 并发**：tui + web 同机双进程跑同一 `$DSH_HOME`，靠 `~/.dsh/dsh-sync/.lock`（O_EXCL + 死 pid 回收）串行化。
- **`mergeable` 字段**：GitCode 文档动态渲染未显式列出，骨架按 Gitee/GitCode v5 兼容字段处理；联调时若该字段缺失，降级为"尝试合并、409 视为冲突"。

## 文件结构

```
dsh-sync/
├── package.json              # main: src/index.js, exports["./client"]: client/bundle.js
├── cordis.patch.yml          # host-plane insert (id: dsh-sync)
├── src/index.js              # 宿主：schemastery + settings + 私仓校验 + git 引擎 + 三向算法 + 冲突 action job + HTTP API + 调度
├── client/index.js           # UI：状态面板 + token + 四开关 + 同步触发 + 冲突 action button
├── client/bundle.js          # 由 scripts/build-client.mjs 生成
├── scripts/build-client.mjs
└── test/sync.test.mjs        # 本地 bare 仓库 + mock fetch 跑完整 push 流程
```

## 开发

```sh
npm run check          # node --check src + client
npm test               # node --test test/*.test.mjs（8 项，含端到端 push）
npm run build:client   # 重新生成 client/bundle.js
```

## 复用的 skills-management 基础设施

schemastery 加载、settings register + hasToken 保密、`gitExec`/`authedUrl`、单飞去重、`ctx.effect` + `setInterval` 调度、slots + fullscreen overlay + 页内 dialog、in-process agent 事件泵——全部沿用 skills-management 已验收的实现。
