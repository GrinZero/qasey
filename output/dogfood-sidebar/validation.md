# 侧栏 PR 真实端到端验收

**结论：完整流程已通过。** 实际运行 `0adf128d-1a45-4081-80d8-c53ee5d901d9` 为 `succeeded`；三条用例均 `passed + approved`，会话显示3条已自动化。

- [功能 PR #13](https://github.com/GrinZero/qasey/pull/13)：基于 main，提交 `4aa8092a2a4e5133f64facb326b17ea9afe0b827`，未合并。
- [E2E PR #14](https://github.com/GrinZero/qasey/pull/14)：由真实 E2E Agent 创建并修改，基于功能分支；最终提交 `e78bbcd783e4d64425b7c7d5237424bb07b03654`，已自动转为 Ready，未合并。
- [实际会话](http://localhost:4111/admin/apps/qasey?conversation=901129d7-ace9-47b7-83ae-fbab815769dd)
- [最终页面截图](completed-conversation.png)
- [QASEY-7 最终已审录像](qasey-7-reviewed.webm)
- [录像关键帧](qasey-7-filmstrip.png)

## 实际经过

1. 由子 Agent 创建 main 基线上的侧栏折叠功能 PR，部署对应提交。
2. 通过实际 Qasey 对话读取PR、生成三条文字用例计划 `550f993b-ce9f-4c0f-a1d4-8f7b9b738cfb`。
3. 在 Review UI 逐条审阅并批准 QASEY-7/8/9 v2。
4. 点击会话里的“生成 E2E”，实际主 Agent 工具启动运行，交接 E2E Agent。
5. E2E Agent 实际编写、独立运行 Playwright，创建PR14。执行期间直接 @ 查询得到真实回复，最终可见74次工具调用。
6. 人工审阅发现Q7只检查单个导航项且缺少徽标布局；在审核页发回Agent。Agent补齐全部导航语义、文字隐藏恢复及真实非零徽标几何断言，并全新验证。
7. 修复中文证据响应头导致500、修复多轮证据混入同一ResultAttempt后，再通过审核页发起复验。最终Q7仅绑定verifier-2证据。
8. 实际播放视频、打开嵌入式Trace Viewer并展开步骤断言；Q7验证10个导航控件、13处导航文案、3处次要说明、2个真实徽标。Q8核对双向刷新持久化；Q9核对780/781断点、抽屉开关及238px展开宽度。
9. 逐条提交批准；系统完成最终独立验证，运行成功并自动将PR14转为Ready。

## 最终结果

| 用例 | 审核结果尝试 | 执行 | 人工审核 | 有效证据 |
| --- | --- | --- | --- | --- |
| QASEY-7 v2 | 3 | passed | approved | 1视频 + 1Trace |
| QASEY-8 v2 | 1 | passed | approved | 1视频 + 1Trace |
| QASEY-9 v2 | 1 | passed | approved | 1视频 + 1Trace |

Q8/9在后续修复中未改动，保留匹配其版本的原有效结果。所有旧失败及退回记录保留，没有改写数据库验收状态。

## 根因修复

- 启动、重跑、amend结果正确关联当前会话，并验证所有权。
- coding流式传输与终态事件排空，避免中断或遗漏反馈。
- Git worktree部署SHA解析。
- Mastra entityId/entityName工具身份及历史工具反馈回填。
- 结构化识别认证setup失败，避免把环境问题当作测试错误反复修复。
- 认证setup关闭录制；普通浏览器用例保留证据。
- Content-Disposition支持中文文件名，解决trace/video HTTP500。
- 新ResultAttempt仅绑定最新verifier的证据与代码哈希，历史记录保留。

## 环境与边界

用户明确授权后，将现有专用测试账号的数据库密码与忽略的.env同步，并通过服务端校验及真实登录。没有创建新账号。

当前开发容器挂载 `/tmp/qasey-dogfood-preview`，Compose override在 `/tmp/qasey-goal-preview.override.yml`。功能基线是PR13提交，修复代码叠加在预览目录。根目录保留任务开始前的未提交改动；本轮运行链路修复尚未提交，未整体提交用户工作树。生成录像和验收记录位于本输出目录，不属于PR源码。

## 最终仓库检查

`pnpm check` 通过：741 tests passed、8 skipped，API及worker构建通过。`pnpm check:open-source` 通过（455文件），`git diff --check` 通过。一次构建临时目录ENOENT后完整重跑成功，没有略过构建门。
