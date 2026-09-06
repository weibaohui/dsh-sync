# @weibaohui/dsh-sync

[![DSH plugin](https://img.shields.io/badge/dsh-plugin-green)](https://github.com/topics/dsh-plugin)
[![npm version](https://img.shields.io/npm/v/@weibaohui/dsh-sync)](https://www.npmjs.com/package/@weibaohui/dsh-sync)

**多机同步插件**：让多台机器上的 dsh 通过一个私有 GitCode 仓库保持一致——技能、会话、设置、插件清单都能同步。

![多机同步：仓库配置、同步开关与冲突处理](docs/demo.gif)

## 核心功能

- **四类内容可同步**（各有独立开关）：
  - 技能（skills，默认开）
  - 会话记录（默认关，体积大）
  - 设置（settings.yaml，默认开）
  - 插件清单（各 profile 的依赖与配置，默认开）
- **分支 → PR → 合并**：每台机器的变更以 PR 形式提交，冲突显化为一个待合并的 PR，绝不静默覆盖
- **同步前自动回填**：每次推送前先把远端新增、本机没动过的内容拉回本机，本机快照不会误删别的机器推上来的新技能/新配置
- **AI 智能对齐**：点「AI 智能对齐」，先自动回填远端新增，再由 AI 对两边都改过的文件做语义合并（动手前自动备份本机文件），合并后自动推送；仍冲突的 PR 顺手解决
- **AI 一键解决冲突**：出现冲突时设置页冒出「AI 解决冲突」按钮，点击后自动分析两边改动并合并，确定性的 git 操作不用你动手
- **安全**：强制私有仓库（公共仓库直接拒绝保存）；访问 token 只写不回读
- **拉取安全**：pull 只回写本地没动过的远端变更，本地改过的内容不会被覆盖

## 安装

```bash
dsh plugin --profile web add @weibaohui/dsh-sync -w
```

装完重启 `dsh web` 即生效。

## 使用

1. 到 [gitcode.com](https://gitcode.com) 创建一个**私有**仓库（插件不会代建）
2. 打开 Web UI → **设置页 → dsh-sync**，填入仓库地址与 access token，保存
3. 按需开关四类同步内容
4. 之后每次修改，通过同步操作把本机变更推成 PR；多机之间即可保持一致
5. 日常可点「AI 智能对齐」让 AI 先回填远端新增、语义合并双方改动；出现冲突时设置页会出现「AI 解决冲突」按钮，点一下即可

## 联系我 :飞书群

![link](https://foruda.gitee.com/images/1774880015525784725/4fd67005_77493.png "link")
