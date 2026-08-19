# Qasey Golden Dataset

这份数据集从 `evals/soruce_case/chat-export/` 的真实 QA 对话中提炼。当前 v1 包含 32 条工作流级金标，覆盖新需求建例、PR → 用例、历史用例重构、增量维护、组合矩阵、业务事实纠错、模糊续接、直接发布、删除安全和 QA 快速排障。

## 为什么不是“用户问题 + 历史回答”

历史对话中存在错误工具调用、范围跑偏、过度拆模块、术语臆造、写入未回查和互相冲突的业务事实。直接把 assistant 回复当 expected output 会把错误固化进评测。因此 v1 的 ground truth 由三部分组成：

1. 用户明确提出或纠正的业务规则；
2. 当前 Qasey 的 intent、写入和完成条件；
3. 可评分的 `mustInclude`、`mustNot` 与 capability-level trajectory。

原始来源仍通过相对文件路径、短 excerpt 和 SHA-256 保持可追溯，但不会被上传到 Datadog 或 Mastra。

## 文件

- `qa-workflows.v1.json`：人工维护的 canonical source。
- `schema.v1.json`：canonical 数据结构。
- `source-inventory.md`：逐文档工作流识别与纳入/排除理由。
- `source-evidence.v1.json`：删除原始 chat export 后仍可使用的最小脱敏 provenance；保存 hash、大小、最终处置和 canonical 用到的短 excerpt，不保存聊天正文。
- `scripts/build-exports.mjs`：校验来源、脱敏约束和写入合同，并生成导出。
- `exports/canonical.jsonl`：包含完整 provenance 的本地 JSONL。
- `exports/mastra-items.json`：Mastra `dataset.addItems({ items })` 可直接使用的 payload。
- `exports/mastra-safe-items.json`：实验专用 payload；真实读取、模拟写入。
- `tool-effects.v1.json`：实验工具副作用分类表。新增工具必须先分类，safe importer 才会继续。
- `exports/datadog-records.json`：Datadog API/SDK 记录结构：`input`、`expected_output`、`metadata`。
- `exports/datadog-records.csv`：Datadog `create_dataset_from_csv` 可导入的三列 CSV。

## 构建与校验

```bash
pnpm evals:build
pnpm evals:check
```

原始来源仍存在、且 canonical 来源有变化时，先刷新一次 snapshot：

```bash
pnpm evals:snapshot-sources
```

正常 `evals:build` 只读取 `source-evidence.v1.json`，不读取原始 `chat-export`，因此原始导出删除后仍可重建 Mastra/Datadog exports。

构建器会检查：

- record id 唯一；
- source excerpt 确实存在于原始文档；
- 可上传 payload 不包含本机用户路径、公司邮箱或原始 Jira/Slack URL；
- MeterSphere upsert 必须要求 fresh read-back；
- 每条 v1 记录都明确禁止 agent 执行 MeterSphere delete。

## Mastra

当前仓库的 `@mastra/core` dataset item 支持 `externalId`、`input`、`groundTruth`、`expectedTrajectory`、`requestContext`、`metadata` 和 `source`。导出文件已经为 `qasey` agent 生成 `qasey-context` 与 `intent-route`：

```ts
const dataset = await mastra.datasets.create({
  name: "qasey-real-qa-workflows-v1",
  targetType: "agent",
  targetIds: ["qasey"],
});

const items = JSON.parse(await readFile("evals/golden/exports/mastra-items.json", "utf8"));
await dataset.addItems({ items });
```

也可以直接幂等导入当前项目配置的 Mastra storage：

```bash
pnpm evals:build
pnpm evals:import:mastra
```

导入脚本使用固定 dataset ID `qasey-real-qa-workflows-v1`，按 `externalId` 创建或更新条目，最后重新读取并核对 32 条记录，因此重复运行不会产生副本。

### 推荐：只 mock 有副作用的实验集

Studio 中优先选择 `qasey-real-qa-workflows-v1-safe`。它保留 Jira、Figma、GitHub、Slack、Lark、QA Context、RAG 和 MeterSphere 查询的真实读取，只 mock MeterSphere 写入、QA experience upsert 与 E2E run 创建/重跑：

```bash
pnpm evals:build
pnpm evals:import:mastra:safe
```

每条 item 都把已分类的副作用工具声明为 Mastra `toolMocks`。同名 mock 耗尽时 Mastra 会以 `TOOL_MOCK_EXHAUSTED` 结束该 item，不会回退到真实调用。未声明工具允许执行，以便只读工具访问实时数据；导入器会用代码中的 MCP allowlist、read connector 和本地工具上界做离线校验，在遇到 `tool-effects.v1.json` 中尚未分类的新工具时拒绝导入，不依赖外部 MCP 当时是否在线。

safe dataset 默认绑定三个无模型成本的代码评分器：可见输出、mustInclude 词法覆盖和禁止行为 gate。另有 `qasey-capability-trajectory` 可在实验中手动加入 trajectory scorers。

这不是“完全无外部影响”模式：真实读取仍会消耗 API 配额、留下访问日志，并受到权限和数据漂移影响。首次运行建议 concurrency 设为 `1`；确认读取凭证和结果正常后再提高。原始 `qasey-real-qa-workflows-v1` 没有写 mock，不应用于直接运行 agent experiment。

这一路径评价的是已路由后的 Qasey agent。若要单测 intent router，应读取同一记录的 `groundTruth.route`，通过 `executeQasey` 或独立 router harness 做比较，不能因为 requestContext 已注入金标 route 就认为 router 通过。

## Datadog

Datadog LLM Observability dataset 的核心字段是 `input`、可选 `expected_output` 和 `metadata`。JSON 导出可逐条送入 dataset record API；CSV 可使用：

```python
dataset = LLMObs.create_dataset_from_csv(
    csv_path="evals/golden/exports/datadog-records.csv",
    dataset_name="qasey-real-qa-workflows-v1",
    input_data_columns=["input"],
    expected_output_columns=["expected_output"],
    metadata_columns=["metadata"],
)
```

CSV 三列都是 JSON 字符串。任务函数应解析 `input`，evaluators 解析 `expected_output`，分别评分 route、语义约束、禁用行为、read-back receipt 与 trajectory capability。

## 推荐评分拆分

不要只用字符串相似度。建议至少分成五项：

| scorer | 评分对象 | 建议 |
|---|---|---|
| `route_exact` | intent / relation / writeTarget / depth | 代码评分，0/1 |
| `required_behavior` | `mustInclude` | LLM judge，逐项覆盖率 |
| `forbidden_behavior` | `mustNot` | gate，出现任一关键违规即 0 |
| `trajectory` | required / forbidden capabilities | trace/tool-call 代码评分 |
| `completion_evidence` | CasePlan、write receipt、fresh read-back | 写入任务 gate；缺一不可 |

初期不要把所有维度汇成一个平均分。删除违规、错误写入目标、未回查却宣告成功应作为 hard gate；回答完整度和表达质量再作为 soft score。

## 维护规则

- 新记录先标 `candidate`，由 QA 确认 `mustInclude` / `mustNot` 后再升为 `golden`。
- 业务事实发生变化时新增“覆盖旧事实”的记录，不静默改掉历史记录；这样可以测试 memory conflict resolution。
- 一条记录只承载一个主要决策。复杂端到端流程可用多个记录共享同一 `workflow` 标签。
- 不把内部 URL、个人路径、邮箱、token 或原始附件正文复制到上传导出。
