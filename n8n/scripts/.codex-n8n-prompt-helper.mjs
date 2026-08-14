import { execFileSync } from 'node:child_process';

const workflowId = 'Vw8YbsOWTmqlNR3o';
const cli = '/Users/jiabowang/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@n8n/cli/bin/n8n-cli.mjs';

const workflow = JSON.parse(execFileSync(cli, ['workflow', 'get', workflowId, '--json'], { encoding: 'utf8' }));
const currentPrompt = workflow.nodes.find((node) => node.name === 'AI Agent').parameters.options.systemMessage;

const protocol = `## 子 Agent 调度协议（强制：默认不调用）

- 默认由主 Agent 使用 Code-Mode 直接完成取证、分析、整合和交付。**不要因为任务包含多个来源、耗时、可并行或属于“完整 QA 任务”就调用 SubAgent-Luna-Max**；这些都不是充分条件。
- 仅当以下条件全部满足时，才允许调用 SubAgent-Luna-Max：
  1. 场景确实复杂，存在需要深度探索的关键未知点、跨来源矛盾，或大范围代码/历史证据；主 Agent 直接处理难以得到可靠结论。
  2. 主 Agent 已先完整读取 qa_context_get，并完成最小必要探索，能够明确指出仍缺少什么证据、为什么影响结论。
  3. 可委派为一个边界清晰、可验收的只读调查目标，且返回结果会实质改变风险判断或用例设计。
  4. 剩余执行时间充足，调用不会显著增加超时风险。
- 以下场景明确禁止调用：查询或解释；续办、重试、重建或局部修改；单来源任务；链接、路径、仓库、PR、Jira Key 或目标 ID 已知的直接读取；主 Agent 可在 1–2 个 Code-Mode 批次内完成的多来源查询；仅为了并行、满足流程形式或减轻主 Agent 工作量。
- 决策顺序必须是：主 Agent 先直接调查 → 若仍存在会影响结论的关键缺口，再逐项检查上述条件 → 全部满足才调用。拿不准是否必须使用时，一律不调用。
- 每次执行默认最多调用 1 次 SubAgent-Luna-Max，不并行启动多个。只有第一次调用明确暴露了另一个独立且关键的深层缺口，并且剩余时间充足时，才允许追加 1 次；不得重复调查同一来源或同一问题。
- 遇到工具响应慢、剩余时间不足、已接近迭代或执行超时时，停止扩大调查范围。主 Agent 基于已有证据做最佳努力，并把真正影响结论的缺口列为待澄清。
- 确需调用时，每次只分配一个明确目标，并在 prompt 中写清来源范围、关键问题、期望输出和约束。要求返回经过分页、过滤、去重后的精炼证据，保留可追踪的链接、ID 或文件路径，区分事实与推断，并列出缺失来源、工具错误和未解问题；禁止返回无关的整份原始响应。
- 子 Agent 只做只读取证、交叉核对和上下文提炼。MeterSphere 创建或写入、Slack 用户可见发送、审批及其他有副作用操作由主 Agent 执行；最终风险判断、用例收敛和交付责任也保留在主 Agent。`;

export const updatedPrompt = currentPrompt.replace(
  /## 子 Agent 调度协议（强制）\n\n[\s\S]*?\n\n## 完整流程/,
  `${protocol}\n\n## 完整流程`,
);

if (updatedPrompt === currentPrompt) throw new Error('Sub-agent protocol block was not replaced');

export const updatedDescription = '仅用于极少数主 Agent 无法直接完成、且必须进行深度探索的复杂只读调查。不要把本工具当作默认取证方式，也不要仅因为任务耗时、涉及多个来源、可以并行或属于完整 QA 流程而调用。仅当主 Agent 已完成 qa_context_get 和最小必要探索，仍存在会影响风险判断或用例设计的关键未知点、跨来源矛盾或大范围证据缺口，并且有一个边界清晰、可验收的调查目标且剩余时间充足时才使用。查询或解释、续办/重试/重建/局部修改、单来源任务、目标链接或 ID 已知的直接读取，以及主 Agent 能在 1–2 个 Code-Mode 批次内完成的多来源查询，均不得调用。拿不准是否必须使用时不要调用。默认每次执行最多调用一次，不得并行或重复调查。调用参数必须写明来源范围、关键问题、期望输出和只读约束。工具会通过 Code-Mode 处理分页、过滤、去重和交叉核对，返回带链接、ID 或文件路径的精炼证据，并区分事实、推断、缺口和工具错误。仅执行只读操作：不得写入 MeterSphere、发送消息、发起审批或执行其他副作用，也不替代主 Agent 的最终判断和交付。';
