import { e2eTaskUrl } from "./e2e-task-urls";
import type { QaseyE2ETask } from "@qasey/contracts";

export function E2ETaskLink({ task }: { task: QaseyE2ETask }) {
  return <div className="e2e-task-link">
    <div><strong>{task.status === "running" ? "E2E 任务已启动" : task.status === "failed" ? "本次 Agent 处理失败" : "本次 Agent 处理已结束"}</strong>
      <span>{task.context.cases.map(item => `${item.caseId} · v${item.version}`).join("、")}</span>
      <small>详细动作与反馈保留在对应会话中；自动化验收状态以用例为准。</small></div>
    <a className="secondary-button" href={e2eTaskUrl(task)}>查看 Agent 工作</a>
  </div>;
}
