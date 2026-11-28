# 开发与评审

`main` 是主干。每个 feature 从最新的 `main` 开独立分支，例如 `feature/cloud-question-cards`，完成后以 PR 合回 `main`。需求继续在对应分支演进，评审证据绑定 PR 的实际提交。

## 用 spec 驱动迭代

1. 在 `specs/<feature>/` 写目标、用户流程、范围和依赖。对于两端协议和持久化行为，写清输入、状态和失败结果。
2. 给每项验收写前置条件、操作、预期结果和取证方式。能在本地复现的行为，先用测试或脱敏样例固定。依赖平台的项目写出真实联调条件。
3. 按对应 spec 实现，在 PR 标明 spec、固定提交、验证命令和结果。用模拟服务通过的情况标为模拟验证。实际服务器、账号和客户端的结果另记。
4. 由具名评审者核对代码、spec 和验证证据，解决评审发现，再合回主干。

新功能可沿用 [云端问题卡的 spec](specs/cloud-question-cards/spec.md) 和 [验收矩阵](specs/cloud-question-cards/verification.md) 的结构。当前由开发负责人维护 spec 和实现，代码由独立评审者核验。

## 初始化代码图谱与 Git 钩子

开发机安装 [CodeGraph](https://github.com/colbymchenry/codegraph)，并确保 Git 推送执行环境的 PATH 能找到 `codegraph`。以下流程已按 1.6.1 验证。进入源码 checkout 执行：

```sh
codegraph --version
codegraph init --yes .
codegraph status .
git config --show-origin --get core.hooksPath
git rev-parse --git-path hooks/pre-push
```

先检查第二条 Git 命令列出的生效钩子路径，包含 Git 默认目录。未配置 `core.hooksPath` 且没有现有推送钩子时，运行 `git config --local core.hooksPath .githooks`。已有其他推送钩子时，在其流程中调用项目的 `.githooks/pre-push`，保留原检查。如果 Git 已经使用 `.githooks`，可以直接推送。仓库级配置影响同一 clone 的各个 worktree。每个开发 checkout 要初始化自己的索引。

推送前，钩子对当前工作树执行 `codegraph sync --quiet`。命令失败时 Git 停止推送。安装、初始化或同步恢复后，重试原推送。要让图谱对应待评审提交，从干净工作树推当前 HEAD。已生成的 `.codegraph/` 保留在本机。

按符号查看定义和调用关系：

```sh
codegraph node makeRaft
codegraph callers makeRaft
```

代码阅读时，图谱适合定位入口和影响范围。涉及参数、配置或分支边界时，回读当前源码和测试。更换 checkout 后，在对应目录重新核对索引。服务部署只需自身运行依赖。

## 日常检查

```sh
npm ci
npm test
npm pack --dry-run
```

本地文字桥接的模拟测试保留在 `test/`。新增真实收发验收时，使用已约定的测试用户、服务器和会话。 [文档索引](docs/README.md)
