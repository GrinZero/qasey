---
name: git-repository-workspace
description: 在 agent 需要读取 GitHub、检查 PR、搜索代码、编辑仓库、运行测试、验证修改或执行任何 git/gh 操作时使用。即使用户只给了 PR/仓库链接或只说“看看代码”“继续修改”“验证一下”，也先加载本 skill；它规定稳定 session 文件系统、search-first、gh clone和 worktree隔离约定。
---

# Git Repository Workspace

把当前 session 的文件系统视为长期工作台：同一 session 的后续请求会再次看到这里的仓库、worktree、未提交修改和产物。不要因为开始了新一轮回复就重新 clone。

共享 Git cache只用于复用干净 objects。不要读取、修改或清理其他 session 的 working tree。

## Search first

接到 GitHub、PR 或代码任务后，按以下顺序处理：

1. 先查看 `repos/`，按 `<owner>/<repository>` 寻找 session 中已有的 repository store。
2. 用 remote URL核对仓库身份；不要只相信目录名。
3. 运行 `git --git-dir <store> worktree list --porcelain`，确认已有 worktree、branch和 HEAD。
4. 用 `git --git-dir <store> cat-file -e '<sha>^{commit}'` 检查目标 commit是否已存在。
5. 找到满足目标的干净 worktree就复用；仓库存在但缺少目标 worktree时只新增 worktree。
6. 当前 session 确实没有该仓库时，才 clone。

首次 clone使用标准 `gh repo clone`，并创建不直接编辑的 bare store：

```bash
gh repo clone OWNER/REPO repos/OWNER/REPO/store -- --bare
```

运行时会在服务端复用共享 mirror。不要自己向共享 cache目录 clone，也不要把凭据写进 URL、remote config、脚本或日志。

运行时会自动提供短期、只读的 GitHub App token。不要读取、打印、复制、持久化或回显 `GH_TOKEN`、`GITHUB_TOKEN` 及 Git credential/header 配置；认证失败时只报告命令和状态，不报告环境变量内容。

## Directory convention

```text
repos/<owner>/<repository>/
  store/
  worktrees/
    inspect/<sha>/
    author/<branch-slug>/
    verify/<run-id>/
```

`store/` 是 session-local common Git dir，不是 working tree。代码阅读、grep、编辑和测试都应在 `worktrees/` 下进行。

## Choose the worktree by intent

### Inspect

阅读 PR、追踪调用链或 grep代码时，从精确 head SHA创建 detached worktree：

```bash
git --git-dir repos/OWNER/REPO/store worktree add --detach \
  repos/OWNER/REPO/worktrees/inspect/HEAD_SHA HEAD_SHA
```

- 同一 SHA且 worktree干净时直接复用。
- 先用 `gh pr view`、`gh api`或 `gh search`取得 PR元数据和精确 base/head SHA。
- PR head变化时创建新的 SHA目录，不在旧 inspect worktree中静默 pull/reset。
- 深度代码分析优先使用本地 `rg`、`git diff BASE...HEAD`、`git log`、`git blame`和仓库测试，不使用逐文件 GitHub get工具。

### Author

编辑时使用独立 branch worktree：

```bash
git --git-dir repos/OWNER/REPO/store worktree add \
  -b qasey/SESSION_SHORT/TOPIC \
  repos/OWNER/REPO/worktrees/author/TOPIC BASE_SHA
```

- 同一修改目标跨多轮继续时复用原 author worktree。
- 并行、互不依赖的修改目标使用不同 branch/worktree。
- 开始编辑前记录 base SHA；不要自动 pull、rebase或覆盖已有未提交修改。
- 本地 edit、commit允许；push、建 PR、merge和其他 GitHub写操作必须走平台批准的 broker/workflow。

### Verify

验证修改时始终从记录的 base SHA创建新的 detached worktree：

```bash
git --git-dir repos/OWNER/REPO/store worktree add --detach \
  repos/OWNER/REPO/worktrees/verify/RUN_ID BASE_SHA
```

然后通过 patch、commit或 cherry-pick导入候选改动，再安装依赖和运行验证。不要在 author worktree中宣称完成 clean verification。

## Isolation rules

- worktree之间只通过 patch、commit或 cherry-pick传递改动；不要复制整个目录。
- 不跨 worktree共享 `node_modules`、build输出、测试产物或未跟踪文件。包管理器下载 cache可以由平台共享。
- 不对 common store或共享 cache运行 `gc`、`prune`、改 remote/config或删除 refs。
- 删除 worktree前确认它属于当前 session、没有未保存改动且没有 active验证。
- 清理使用 `git worktree remove <path>`；只有平台生命周期管理器负责跨 session cache GC。
- 遇到已有脏目录、branch占用或目标 SHA不一致时，保留现场并新建 worktree，不用强制 reset解决。

## Evidence

报告代码结论或验证结果时，记录 repository、base/head SHA、实际 worktree、执行命令及退出状态。cache hit只能证明复用了 objects，不能代替 ref刷新、权限检查或测试证据。
